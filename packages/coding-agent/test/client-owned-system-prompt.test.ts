import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

// Antigravity CLI builds the system prompt from agy's own components, so omp
// contributes only context there and presents every tool directly; a regular
// model gets omp's own prompt with its xd:// devices again. The client-owned
// model here reaches a mocked Messages endpoint, so the session runs end to end.

const OPUS = getBundledModel<"anthropic-messages">("anthropic", "claude-opus-5-5");
const AGY_ENDPOINT = "https://agy-bridge.example.test";
const PROJECT_RULE = "Project rule: prefer tabs.";

interface MessagesRequest {
	url: string;
	system: Array<{ text: string }>;
	tools: Array<{ name: string }>;
	messages: Array<{ role: string; content: unknown }>;
}

function sse(events: Record<string, unknown>[]): Response {
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function reply(turn: number, call?: { name: string; input: Record<string, unknown> }): Response {
	const block = call
		? [
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: `toolu_${turn}`, name: call.name, input: {} },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
				},
			]
		: [
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
			];
	return sse([
		{
			type: "message_start",
			message: {
				id: `msg_${turn}`,
				type: "message",
				role: "assistant",
				content: [],
				model: "agy-test",
				stop_reason: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		...block,
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	]);
}

describe("a model whose client owns the system prompt", () => {
	const previousProxy = Bun.env.PI_PROXY_ANTHROPIC;
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-client-owned-prompt-");
		// A provider proxy moves first-party requests onto `globalThis.fetch`, where the spy answers them.
		Bun.env.PI_PROXY_ANTHROPIC = "http://proxy.example.test:8080";
		__resetProxyCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		tempDir.removeSync();
		if (previousProxy === undefined) delete Bun.env.PI_PROXY_ANTHROPIC;
		else Bun.env.PI_PROXY_ANTHROPIC = previousProxy;
		__resetProxyCache();
	});

	it("gets context only and every tool directly, until the session moves to a regular model", async () => {
		await Bun.write(
			tempDir.join("models.yml"),
			`providers:\n  antigravity-cli:\n    baseUrl: ${AGY_ENDPOINT}\n    api: anthropic-messages\n    apiKey: agy-key\n    models:\n      - id: agy-test\n        name: Agy Test\n        reasoning: false\n        input: [text]\n        contextWindow: 200000\n        maxTokens: 8192\n`,
		);
		await Bun.write(tempDir.join("main.ts"), "export const answer = foo(1);\n");
		const requests: MessagesRequest[] = [];
		// The client-owned model calls a device omp would otherwise defer behind xd://
		// (names wear this endpoint's `_` escape), applies its preview, then finishes.
		const agyScript = [
			{ name: "_ast_edit", input: { ops: [{ pat: "foo($A)", out: "bar($A)" }], paths: ["."] } },
			{ name: "_write", input: { path: "xd://resolve", content: "Rename foo to bar." } },
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = String(input);
				if (
					!url.startsWith("https://api.anthropic.com/v1/messages") &&
					!url.startsWith(`${AGY_ENDPOINT}/v1/messages`)
				) {
					throw new Error(`Unexpected request to ${url}`);
				}
				const body = JSON.parse(requestBodyText(init) ?? "{}") as Omit<MessagesRequest, "url"> & {
					tools?: unknown[];
				};
				// Side requests (titles) declare no tools.
				if (!body.tools || body.tools.length === 0) return reply(0);
				requests.push({ ...body, url });
				const turn = requests.filter(request => request.url === url).length;
				return reply(requests.length, url.startsWith(AGY_ENDPOINT) ? agyScript[turn - 1] : undefined);
			}),
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "sk-ant-test");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const agyModel = modelRegistry.find("antigravity-cli", "agy-test");
		if (!agyModel) throw new Error("antigravity-cli/agy-test is not registered");
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false, "harness.mode": "native" }),
			model: agyModel,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [{ path: tempDir.join("AGENTS.md"), content: PROJECT_RULE }],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		try {
			await session.prompt("rename foo to bar");
			await session.waitForIdle();
			await session.setModel(OPUS);
			await session.prompt("and now?");
			await session.waitForIdle();
		} finally {
			await session.dispose();
			authStorage.close();
		}

		const agy = requests.filter(request => request.url.startsWith(AGY_ENDPOINT));
		const regular = requests.filter(request => !request.url.startsWith(AGY_ENDPOINT));
		expect(agy).toHaveLength(3);
		expect(regular).toHaveLength(1);
		const agySystem = agy[0].system.map(block => block.text).join("\n");
		const regularSystem = regular[0].system.map(block => block.text).join("\n");

		// Both carry the project context; only the regular model gets omp's own
		// prompt, whose device catalog the client-owned request never sees.
		expect(agySystem).toContain(PROJECT_RULE);
		expect(regularSystem).toContain(PROJECT_RULE);
		const ompPrompt = regular[0].system.find(block => block.text.includes("xd://"));
		if (!ompPrompt) throw new Error("the regular request carries no omp prompt with xd:// devices");
		expect(agySystem).not.toContain(ompPrompt.text.split("\n")[0]);
		expect(agySystem).not.toContain("xd://");

		// The deferrable device is a direct tool there, runs as called, and its preview applies.
		for (const request of agy) expect(request.tools.map(tool => tool.name)).toContain("_ast_edit");
		expect(regular[0].tools.map(tool => tool.name)).not.toContain("ast_edit");
		expect(JSON.stringify(agy.map(request => request.messages))).not.toContain('"is_error":true');
		expect(await Bun.file(tempDir.join("main.ts")).text()).toBe("export const answer = bar(1);\n");
	});
});
