import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Claude Code's tool search on the wire: a deferred tool is declared with
// `defer_loading`, a tool search's result carries `tool_reference` blocks
// (named as the wire names them) with its text after the result, and the
// request advertises the tool-search beta.

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const parameters = {
	type: "object",
	properties: { query: { type: "string" } },
	required: ["query"],
} as Tool["parameters"];

function context(deferLoading: boolean): Context {
	return {
		systemPrompt: ["You are a test agent."],
		tools: [
			{ name: "tool_search", description: "Load deferred tools.", parameters, customWireName: "ToolSearch" },
			{ name: "web_search", description: "Search the web.", parameters, customWireName: "WebSearch", deferLoading },
		],
		messages: [
			{ role: "user", content: "Search the web for omp.", timestamp: 1 },
			{
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-5-5",
				stopReason: "toolUse",
				timestamp: 2,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				content: [
					{ type: "toolCall", id: "toolu_1", name: "tool_search", arguments: { query: "select:WebSearch" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "tool_search",
				content: [{ type: "text", text: "Tool loaded." }],
				providerMetadata: { type: "toolSearch", toolNames: ["web_search"] },
				isError: false,
				timestamp: 3,
			},
		],
	};
}

async function capture(deferLoading: boolean, target: Model<"anthropic-messages"> = model) {
	let body: Record<string, unknown> | undefined;
	let betas = "";
	const fetchMock: FetchImpl = async (_input, init) => {
		body = JSON.parse(requestBodyText(init) ?? "{}");
		betas = new Headers(init?.headers).get("anthropic-beta") ?? "";
		return Response.json(
			{ type: "error", error: { type: "invalid_request_error", message: "captured" } },
			{ status: 400 },
		);
	};
	await streamSimple(target, context(deferLoading), {
		apiKey: "sk-ant-oat-test",
		fetch: fetchMock,
		harnessProfile: "claude-code",
	}).result();
	if (!body) throw new Error("no request was sent");
	return { body, betas };
}

type Records = Array<Record<string, unknown>>;
const records = (value: unknown): Records => (Array.isArray(value) ? value : []);

describe("Anthropic tool search wire", () => {
	it("declares a deferred tool, references what a search loaded, and advertises tool search", async () => {
		const { body, betas } = await capture(true);
		const declared = records(body.tools).map(tool => ({ name: tool.name, defer_loading: tool.defer_loading }));
		expect(declared).toEqual([
			{ name: "ToolSearch", defer_loading: undefined },
			{ name: "WebSearch", defer_loading: true },
		]);
		const resultTurn = records(records(body.messages).at(-1)?.content);
		expect(resultTurn).toEqual([
			{
				type: "tool_result",
				tool_use_id: "toolu_1",
				content: [{ type: "tool_reference", tool_name: "WebSearch" }],
				is_error: false,
			},
			expect.objectContaining({ type: "text", text: "Tool loaded." }),
		]);
		expect(betas.split(",")).toContain("advanced-tool-use-2025-11-20");
	});

	it("keeps an endpoint's tool-result envelope on a replayed search result", async () => {
		// Z.AI's Anthropic endpoint needs `id` on every tool result (issue #814).
		const zai = buildModel({
			...model,
			id: "glm-5",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/anthropic",
			compat: { ...model.compat, requiresToolResultId: true },
		});
		const { body } = await capture(false, zai);
		expect(records(records(body.messages).at(-1)?.content)[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "toolu_1",
			id: "toolu_1",
			content: [{ type: "text", text: "Loaded WebSearch." }],
		});
	});

	it("names a loaded tool in text when the request no longer defers it, and drops the beta", async () => {
		const { body, betas } = await capture(false);
		expect(records(body.tools).every(tool => tool.defer_loading === undefined)).toBe(true);
		expect(records(records(body.messages).at(-1)?.content)).toEqual([
			expect.objectContaining({
				type: "tool_result",
				tool_use_id: "toolu_1",
				content: [{ type: "text", text: "Loaded WebSearch." }],
			}),
		]);
		expect(betas.split(",")).not.toContain("advanced-tool-use-2025-11-20");
	});
});
