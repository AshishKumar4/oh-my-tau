import { describe, expect, it } from "bun:test";
import { type HarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, FetchImpl, Model, ModelSpec, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// A harness profile forced onto a provider that does not speak it: the request
// must declare, replay and force tools by the profile's vendor names, and the
// calls the model makes come back under the omp names the session dispatches.

const parameters = {
	type: "object",
	properties: { path: { type: "string" } },
	required: ["path"],
	additionalProperties: false,
} as Tool["parameters"];

function tools(wireNames: Record<string, string>): Tool[] {
	return ["read", "glob", "bash"].map(name => ({
		name,
		description: `The ${name} tool.`,
		parameters,
		...(wireNames[name] ? { customWireName: wireNames[name] } : {}),
	}));
}

/** One earlier `read` call and its result, then the next question. */
function context(wireNames: Record<string, string>): Context {
	return {
		systemPrompt: ["You are a test agent."],
		tools: tools(wireNames),
		messages: [
			{ role: "user", content: "Read a.txt", timestamp: 1 },
			{
				role: "assistant",
				api: "openai-completions",
				provider: "openai",
				model: "gpt-5.1",
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
				content: [{ type: "toolCall", id: "call_0", name: "read", arguments: { path: "a.txt" } }],
			},
			{
				role: "toolResult",
				toolCallId: "call_0",
				toolName: "read",
				content: [{ type: "text", text: "alpha" }],
				isError: false,
				timestamp: 3,
			},
			{ role: "user", content: "Now read b.txt", timestamp: 4 },
		],
	};
}

function model<TApi extends Api>(api: TApi, provider: string, id: string, baseUrl: string): Model<TApi> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	} as ModelSpec<TApi>);
}

function sse(events: readonly unknown[], named = false): Response {
	const body = events
		.map(event => {
			const data = `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`;
			return named && typeof event === "object" && event && "type" in event ? `event: ${event.type}\n${data}` : data;
		})
		.join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface Wire {
	/** Request payload → declared tool names, the replayed call's name, the result's name, and the forced choice. */
	read(payload: Record<string, unknown>): {
		declared: string[];
		replayedCall: string;
		replayedResult?: string;
		forced: string;
	};
	/** A response in which the model calls `name`. */
	respond(name: string): Response;
}

type Records = Array<Record<string, unknown>>;
const records = (value: unknown): Records => (Array.isArray(value) ? value : []);
const field = (value: unknown, key: string): unknown =>
	typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const text = (value: unknown): string => (typeof value === "string" ? value : "");

const completions: Wire = {
	read: payload => {
		const messages = records(payload.messages);
		return {
			declared: records(payload.tools).map(tool => text(field(field(tool, "function"), "name"))),
			replayedCall: text(
				field(field(records(messages.find(m => m.role === "assistant")?.tool_calls)[0], "function"), "name"),
			),
			forced: text(field(field(payload.tool_choice, "function"), "name")),
		};
	},
	respond: name =>
		sse([
			{
				id: "c1",
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{ index: 0, id: "call_1", type: "function", function: { name, arguments: '{"path":"b.txt"}' } },
							],
						},
					},
				],
			},
			{ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			"[DONE]",
		]),
};

const responses: Wire = {
	read: payload => ({
		declared: records(payload.tools).map(tool => text(tool.name)),
		replayedCall: text(records(payload.input).find(item => item.type === "function_call")?.name),
		forced: text(field(payload.tool_choice, "name")),
	}),
	respond: name => {
		const item = { type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: '{"path":"b.txt"}' };
		return sse([
			{ type: "response.output_item.added", output_index: 0, item },
			{ type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed" } },
			{
				type: "response.completed",
				response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3 } },
			},
		]);
	},
};

const google: Wire = {
	read: payload => {
		const parts = records(payload.contents).flatMap(content => records(content.parts));
		const config = field(payload, "config");
		return {
			declared: records(field(records(field(config, "tools"))[0], "functionDeclarations")).map(decl =>
				text(decl.name),
			),
			replayedCall: text(field(parts.find(part => part.functionCall)?.functionCall, "name")),
			replayedResult: text(field(parts.find(part => part.functionResponse)?.functionResponse, "name")),
			forced: text(
				records(field(field(field(config, "toolConfig"), "functionCallingConfig"), "allowedFunctionNames"))[0],
			),
		};
	},
	respond: name =>
		sse([
			{
				candidates: [
					{
						content: { role: "model", parts: [{ functionCall: { name, args: { path: "b.txt" } } }] },
						finishReason: "STOP",
					},
				],
				usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
			},
		]),
};

const anthropic: Wire = {
	read: payload => ({
		declared: records(payload.tools).map(tool => text(tool.name)),
		replayedCall: text(
			records(payload.messages)
				.flatMap(message => records(message.content))
				.find(block => block.type === "tool_use")?.name,
		),
		forced: text(field(payload.tool_choice, "name")),
	}),
	respond: name =>
		sse(
			[
				{
					type: "message_start",
					message: {
						id: "m1",
						type: "message",
						role: "assistant",
						model: "claude",
						content: [],
						stop_reason: null,
						usage: { input_tokens: 5, output_tokens: 0 },
					},
				},
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_1", name, input: {} },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"path":"b.txt"}' },
				},
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
				{ type: "message_stop" },
			],
			true,
		),
};

const CLAUDE_CODE = { read: "Read", glob: "Glob", bash: "Bash" };
const PI = { glob: "find" };

const cases: Array<{
	name: string;
	model: Model<Api>;
	wire: Wire;
	profile: HarnessProfile;
	wireNames: Record<string, string>;
	forced: string;
	called: string;
}> = [
	{
		name: "Chat Completions under forced claude-code",
		model: model("openai-completions", "openai", "gpt-5.1", "https://api.openai.com/v1"),
		wire: completions,
		profile: "claude-code",
		wireNames: CLAUDE_CODE,
		forced: "read",
		called: "read",
	},
	{
		name: "Responses under forced claude-code",
		model: model("openai-responses", "openai", "gpt-5.1", "https://api.openai.com/v1"),
		wire: responses,
		profile: "claude-code",
		wireNames: CLAUDE_CODE,
		forced: "read",
		called: "read",
	},
	{
		name: "Google under forced claude-code",
		model: model(
			"google-generative-ai",
			"google",
			"gemini-3-flash",
			"https://generativelanguage.googleapis.com/v1beta",
		),
		wire: google,
		profile: "claude-code",
		wireNames: CLAUDE_CODE,
		forced: "read",
		called: "read",
	},
	{
		name: "Anthropic under forced pi",
		model: model("anthropic-messages", "anthropic", "claude-sonnet-4-5", "https://api.anthropic.com"),
		wire: anthropic,
		profile: "pi",
		wireNames: PI,
		forced: "glob",
		called: "glob",
	},
];

async function run(c: (typeof cases)[number], harnessProfile: HarnessProfile | null) {
	let payload: Record<string, unknown> | undefined;
	const wireName = harnessProfile === null ? c.called : (c.wireNames[c.called] ?? c.called);
	const fetchMock: FetchImpl = async () => c.wire.respond(wireName);
	const message = await streamSimple(c.model, context(c.wireNames), {
		apiKey: "test-key",
		fetch: fetchMock,
		harnessProfile,
		toolChoice: { type: "function", name: c.forced },
		onPayload: body => {
			payload = body as Record<string, unknown>;
		},
	}).result();
	if (!payload) throw new Error("request payload was not captured");
	return { request: c.wire.read(payload), message };
}

describe("a forced harness profile on a provider that does not speak it", () => {
	it.each(cases)("$name: declares, replays and forces vendor names, and returns omp names", async c => {
		const { request, message } = await run(c, c.profile);
		const wire = (name: string) => c.wireNames[name] ?? name;
		expect(request.declared).toEqual(["read", "glob", "bash"].map(wire));
		expect(request.replayedCall).toBe(wire("read"));
		if (request.replayedResult !== undefined) expect(request.replayedResult).toBe(wire("read"));
		expect(request.forced).toBe(wire(c.forced));
		expect(message.errorMessage).toBeUndefined();
		expect(message.content.find(block => block.type === "toolCall")).toMatchObject({
			name: c.called,
			arguments: { path: "b.txt" },
		});
	});

	it.each(cases)("$name: the native surface keeps omp names", async c => {
		const { request, message } = await run(c, null);
		expect(request.declared).toEqual(["read", "glob", "bash"]);
		expect(request.replayedCall).toBe("read");
		expect(request.forced).toBe(c.forced);
		expect(message.content.find(block => block.type === "toolCall")).toMatchObject({ name: c.called });
	});
});
