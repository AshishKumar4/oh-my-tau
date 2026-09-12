import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentMessage, AgentTool, StreamFn } from "@oh-my-pi/pi-agent-core/types";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import {
	buildTransformedCodexRequestBody,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, Message, Model, Tool, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { type HarnessProfile, resolveHarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { harnessToolBinding } from "@oh-my-pi/pi-coding-agent/harness/manifest";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { isRecord } from "@oh-my-pi/pi-utils";
import { withOfficialAnthropicEndpoint } from "./helpers/anthropic-endpoint";
import { mockFetch } from "./helpers/fetch-mock";

withOfficialAnthropicEndpoint();

const STATE_MACHINE_TOOLS = ["todo", "yield", "ask", "checkpoint", "rewind", "new_context"] as const;

function evalToolFor(model: Model): Tool {
	const tool = new EvalTool({
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated(),
		getActiveModel: () => model,
	} as unknown as ToolSession);
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.customFormat ? { customFormat: tool.customFormat } : {}),
	};
}

function baseTools(model: Model): Tool[] {
	return [
		{
			name: "bash",
			description: "Run a shell command",
			parameters: type({ command: type("string").describe("cmd") }),
		},
		{ name: "read", description: "Read a file", parameters: type({ path: type("string").describe("path") }) },
		{ name: "grep", description: "Search files", parameters: type({ pattern: type("string").describe("regex") }) },
		evalToolFor(model),
		{ name: "task", description: "Delegate", parameters: type({ prompt: type("string").describe("task") }) },
		{ name: "hub", description: "Coordinate", parameters: type({ op: type("string").describe("op") }) },
		...STATE_MACHINE_TOOLS.map(name => ({
			name,
			description: `omp ${name} tool`,
			parameters: type({ payload: type("string").describe("payload") }),
		})),
	];
}

function projectTools(target: SwitchTarget): Tool[] {
	const model = getBundledModel(target.provider, target.id);
	return baseTools(model).map(tool => {
		const binding = target.profile ? harnessToolBinding(target.profile, tool.name) : undefined;
		if (!binding) return { ...tool };
		return { ...tool, ...(binding.wireName ? { customWireName: binding.wireName } : {}) };
	});
}

type Family = "anthropic-messages" | "codex-responses" | "openai-responses" | "openai-completions";

interface SwitchTarget {
	family: Family;
	provider: "anthropic" | "openai-codex" | "opencode-zen" | "cloudflare-ai-gateway";
	id: string;
	profile?: HarnessProfile;
}

type TargetLabel = "fable" | "opus" | "astra" | "sol" | "muse" | "glm";

const TARGETS: Record<TargetLabel, SwitchTarget> = {
	fable: { family: "anthropic-messages", provider: "anthropic", id: "claude-fable-5-1", profile: "claude-code" },
	opus: { family: "anthropic-messages", provider: "anthropic", id: "claude-opus-5", profile: "claude-code" },
	astra: { family: "codex-responses", provider: "openai-codex", id: "gpt-6-astra", profile: "codex" },
	sol: { family: "codex-responses", provider: "openai-codex", id: "gpt-5.6-sol", profile: "codex" },
	muse: { family: "openai-responses", provider: "opencode-zen", id: "muse-spark-1.3-contributor-free" },
	glm: { family: "openai-completions", provider: "cloudflare-ai-gateway", id: "workers-ai/@cf/zai-org/glm-5.3-flash" },
};

const USER: Message = { role: "user", content: "list the repo", timestamp: 1 };

function priorTurn(toolName: string, wireName?: string): Message[] {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call_prior",
				name: toolName,
				arguments: { command: "ls" },
				...(wireName ? { customWireName: wireName } : {}),
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "prior-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_prior",
		toolName,
		content: [{ type: "text", text: "README.md" }],
		isError: false,
		timestamp: 3,
	};
	return [USER, assistant, result, { role: "user", content: "now read it", timestamp: 4 }];
}

const ANTHROPIC_TEXT_SSE: readonly Record<string, unknown>[] = [
	{
		type: "message_start",
		message: {
			id: "msg_switch",
			usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	},
	{ type: "message_stop" },
];

const RESPONSES_TEXT_SSE: readonly Record<string, unknown>[] = [
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.output_text.delta", delta: "ok" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "ok" }],
		},
	},
	{ type: "response.completed", response: { status: "completed" } },
];

const COMPLETIONS_TEXT_SSE: readonly Record<string, unknown>[] = [
	{ id: "c1", choices: [{ index: 0, delta: { content: "ok" } }] },
	{ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];

function sseResponse(body: string): Response {
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function anthropicSse(): Response {
	return sseResponse(
		ANTHROPIC_TEXT_SSE.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
	);
}

function dataSse(events: readonly Record<string, unknown>[], done = false): Response {
	const body = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return sseResponse(done ? `${body}data: [DONE]\n\n` : body);
}

function replayedToolCallNames(history: unknown): string[] {
	const names: string[] = [];
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const entry of node) visit(entry);
			return;
		}
		if (!isRecord(node)) return;
		const kind = node.type;
		if (kind === "tool_use" || kind === "function_call" || kind === "custom_tool_call") {
			if (typeof node.name === "string") names.push(node.name);
		}
		if (typeof node.id === "string" && isRecord(node.function) && typeof node.function.name === "string") {
			names.push(node.function.name);
		}
		for (const value of Object.values(node)) visit(value);
	};
	visit(history);
	return names;
}

function namesOf(list: unknown, pick: (entry: Record<string, unknown>) => unknown): string[] {
	if (!Array.isArray(list)) return [];
	return list.flatMap(entry => {
		if (!isRecord(entry)) return [];
		const name = pick(entry);
		return typeof name === "string" ? [name] : [];
	});
}

interface BuiltRequest {
	declared: string[];
	replayed: string[];
}

async function drain(stream: AsyncIterable<unknown> & { result(): Promise<unknown> }): Promise<void> {
	try {
		for await (const _ of stream) {
		}
		await stream.result();
	} catch {}
}

async function capturePayload(
	run: (onPayload: (payload: unknown) => void) => AsyncIterable<unknown> & { result(): Promise<unknown> },
	id: string,
): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	await drain(
		run(captured => {
			if (isRecord(captured)) payload = captured;
		}),
	);
	if (!payload) throw new Error(`no request payload captured for ${id}`);
	return payload;
}

async function buildRequest(target: SwitchTarget, messages: Message[]): Promise<BuiltRequest> {
	const context: Context = {
		systemPrompt: ["You are omp, a coding agent."],
		messages,
		tools: projectTools(target),
	};
	if (target.family === "anthropic-messages") {
		const payload = await capturePayload(
			onPayload =>
				streamAnthropic(getBundledModel<"anthropic-messages">("anthropic", target.id), context, {
					apiKey: "sk-ant-oat-test",
					isOAuth: true,
					fetch: mockFetch(() => anthropicSse()),
					onPayload,
				}),
			target.id,
		);
		return {
			declared: namesOf(payload.tools, tool => tool.name),
			replayed: replayedToolCallNames(payload.messages),
		};
	}
	if (target.family === "codex-responses") {
		const body = await buildTransformedCodexRequestBody(
			getBundledModel<"openai-codex-responses">("openai-codex", target.id),
			context,
			{ reasoning: Effort.High },
		);
		const groups = Array.isArray(body.input)
			? body.input.filter(item => isRecord(item) && item.type === "additional_tools")
			: [];
		const declared = groups.flatMap(item =>
			(isRecord(item) && Array.isArray(item.tools) ? item.tools : []).flatMap(group =>
				namesOf(isRecord(group) && Array.isArray(group.tools) ? group.tools : [group], tool => tool.name),
			),
		);
		return {
			declared: declared.length > 0 ? declared : namesOf(body.tools, tool => tool.name),
			replayed: replayedToolCallNames(body.input),
		};
	}
	if (target.family === "openai-responses") {
		const payload = await capturePayload(
			onPayload =>
				streamOpenAIResponses(getBundledModel<"openai-responses">("opencode-zen", target.id), context, {
					apiKey: "sk-test",
					fetch: mockFetch(() => dataSse(RESPONSES_TEXT_SSE)),
					onPayload,
				}),
			target.id,
		);
		return {
			declared: namesOf(payload.tools, tool => tool.name),
			replayed: replayedToolCallNames(payload.input),
		};
	}
	const payload = await capturePayload(
		onPayload =>
			streamOpenAICompletions(getBundledModel<"openai-completions">("cloudflare-ai-gateway", target.id), context, {
				apiKey: "sk-test",
				fetch: mockFetch(() => dataSse(COMPLETIONS_TEXT_SSE, true)),
				onPayload,
			}),
		target.id,
	);
	return {
		declared: namesOf(payload.tools, tool => (isRecord(tool.function) ? tool.function.name : undefined)),
		replayed: replayedToolCallNames(payload.messages),
	};
}

function wireName(target: SwitchTarget, toolName: string): string {
	const binding = target.profile ? harnessToolBinding(target.profile, toolName) : undefined;
	if (binding?.wireName) return binding.wireName;
	return target.family === "anthropic-messages" && target.profile === undefined ? `_${toolName}` : toolName;
}

const TRANSITIONS: ReadonlyArray<{ from: TargetLabel; to: TargetLabel; carried: string; replayed: string }> = [
	{ from: "fable", to: "astra", carried: "bash", replayed: "bash" },
	{ from: "astra", to: "fable", carried: "eval", replayed: "eval" },
	{ from: "opus", to: "sol", carried: "task", replayed: "task" },
	{ from: "fable", to: "muse", carried: "read", replayed: "read" },
	{ from: "astra", to: "glm", carried: "eval", replayed: "eval" },
	{ from: "astra", to: "fable", carried: "ask", replayed: "AskUserQuestion" },
];

describe("harness surface across a model switch", () => {
	it("resolves the harness profile of every model in the live fallback config", () => {
		for (const target of Object.values(TARGETS)) {
			expect(resolveHarnessProfile(getBundledModel(target.provider, target.id))).toBe(target.profile);
		}
	});

	for (const transition of TRANSITIONS) {
		const from = TARGETS[transition.from];
		const to = TARGETS[transition.to];
		const carried = transition.carried;
		it(`${transition.from} -> ${transition.to} carrying ${carried}: rebuilds the surface and keeps the old turn readable`, async () => {
			const before = await buildRequest(from, [USER]);
			expect(before.declared).toContain(wireName(from, carried));

			const history = priorTurn(carried, from.family === "codex-responses" ? wireName(from, carried) : undefined);
			const after = await buildRequest(to, history);

			expect(after.declared).toContain(wireName(to, carried));
			if (wireName(from, carried) !== wireName(to, carried)) {
				expect(after.declared).not.toContain(wireName(from, carried));
			}
			expect(after.replayed).toEqual([transition.replayed]);

			const missing = STATE_MACHINE_TOOLS.filter(name => !after.declared.includes(wireName(to, name)));
			expect(missing).toEqual([]);
		});
	}
});

const ASK_ARGS = { questions: [{ id: "q1", question: "Proceed?", header: "Plan", options: [{ label: "yes" }] }] };

const ANTHROPIC_ASK_SSE: readonly Record<string, unknown>[] = [
	{
		type: "message_start",
		message: {
			id: "msg_ask",
			usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	},
	{
		type: "content_block_start",
		index: 0,
		content_block: { type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: {} },
	},
	{
		type: "content_block_delta",
		index: 0,
		delta: { type: "input_json_delta", partial_json: JSON.stringify(ASK_ARGS) },
	},
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: "tool_use" },
		usage: { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	},
	{ type: "message_stop" },
];

const CODEX_ASK_ITEM = {
	type: "function_call",
	id: "fc_ask",
	call_id: "call_ask",
	name: "request_user_input",
	arguments: JSON.stringify(ASK_ARGS),
};
const CODEX_ASK_SSE: readonly Record<string, unknown>[] = [
	{ type: "response.output_item.added", item: CODEX_ASK_ITEM },
	{ type: "response.output_item.done", item: CODEX_ASK_ITEM },
	{ type: "response.completed", response: { status: "completed" } },
];

function codexTestToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

async function askTurn(
	target: SwitchTarget,
): Promise<{ executed: Record<string, unknown>[]; messages: AgentMessage[] }> {
	const model = getBundledModel(target.provider, target.id);
	const executed: Record<string, unknown>[] = [];
	const binding = harnessToolBinding(target.profile!, "ask");
	const ask: AgentTool = {
		name: "ask",
		label: "Ask",
		description: "omp ask tool",
		parameters: type({ questions: "unknown[]" }),
		customWireName: binding?.wireName,
		async execute(_toolCallId, params) {
			executed.push(params as Record<string, unknown>);
			return { content: [{ type: "text", text: "answered" }] };
		},
	};
	let calls = 0;
	const streamFn: StreamFn =
		target.family === "anthropic-messages"
			? (streamModel, context) =>
					streamAnthropic(streamModel as Model<"anthropic-messages">, context, {
						apiKey: "sk-ant-oat-test",
						isOAuth: true,
						fetch: mockFetch(() =>
							sseResponse(
								(calls++ === 0 ? ANTHROPIC_ASK_SSE : ANTHROPIC_TEXT_SSE)
									.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
									.join(""),
							),
						),
					})
			: (streamModel, context) =>
					streamOpenAICodexResponses(streamModel as Model<"openai-codex-responses">, context, {
						apiKey: codexTestToken(),
						fetch: mockFetch(() => dataSse(calls++ === 0 ? CODEX_ASK_SSE : RESPONSES_TEXT_SSE)),
					});
	const context: AgentContext = { systemPrompt: ["You are omp."], messages: [], tools: [ask] };
	const messages = await agentLoop(
		[USER],
		context,
		{ model, convertToLlm: history => history.filter(m => m.role !== "custom") as Message[] },
		undefined,
		streamFn,
	).result();
	return { executed, messages };
}

describe("state-machine names survive a harness rename", () => {
	for (const label of ["fable", "astra"] as const) {
		it(`${label}: persists a renamed ask call and its result under the internal name`, async () => {
			const { executed, messages } = await askTurn(TARGETS[label]);
			expect(executed).toEqual([ASK_ARGS]);
			const assistant = messages.find(
				(m): m is AssistantMessage => m.role === "assistant" && m.content.some(c => c.type === "toolCall"),
			);
			const call = assistant?.content.find(c => c.type === "toolCall");
			expect(call?.type === "toolCall" ? call.name : undefined).toBe("ask");
			const result = messages.find((m): m is ToolResultMessage => m.role === "toolResult");
			expect(result?.toolName).toBe("ask");
			expect(result?.content).toEqual([{ type: "text", text: "answered" }]);
		});
	}
});
