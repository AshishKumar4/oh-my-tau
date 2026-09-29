import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentEvent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import {
	buildCodexNamespaceTools,
	buildTransformedCodexRequestBody,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { AssistantMessage, Context, FetchImpl, Message, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { HarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { VendorTool } from "@oh-my-pi/pi-coding-agent/harness/capture";
import { harnessFacade, presentTool } from "@oh-my-pi/pi-coding-agent/harness/facade";
import { harnessFacadeSpecs } from "@oh-my-pi/pi-coding-agent/harness/facades";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import * as completionBridge from "@oh-my-pi/pi-coding-agent/eval/completion-bridge";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { type AgentDefinition, TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";

const CLAUDE_CODE_MODEL = getBundledModel<"anthropic-messages">("anthropic", "claude-opus-5");
const NATIVE_ANTHROPIC_MODEL = getBundledModel<"anthropic-messages">("anthropic", "claude-sonnet-4-5");
const NATIVE_RESPONSES_MODEL = getBundledModel<"openai-responses">("opencode-zen", "muse-spark-1.3-contributor-free");
const NATIVE_COMPLETIONS_MODEL = getBundledModel<"openai-completions">(
	"cloudflare-ai-gateway",
	"workers-ai/@cf/zai-org/glm-5.3-flash",
);
const CODEX_MODEL = buildModel({
	id: "gpt-6-astra",
	name: "gpt-6-astra",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272_000,
	maxTokens: 100_000,
	toolMode: "code_mode_only",
});
const SENDER = "FacadeSender";
const PEER = "FacadePeer";
const PARKED = "FacadeParked";

const managers: AsyncJobManager[] = [];
const sessions: AgentSession[] = [];

function toolSession(options: { agentId?: string; manager?: AsyncJobManager } = {}): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		// No supervised services: proc:// resolves jobs and agents without the launch broker.
		settings: Settings.isolated({ "launch.enabled": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getAgentId: () => options.agentId ?? SENDER,
		asyncJobManager: options.manager,
		agentRegistry: AgentRegistry.global(),
	} as unknown as ToolSession;
}

function facadeFor(
	profile: HarnessProfile,
	wireName: string,
	target: AgentTool,
	settings: Settings = Settings.isolated(),
	session?: ToolSession,
): AgentTool {
	const spec = harnessFacadeSpecs(profile).find(entry => entry.wireName === wireName);
	if (!spec) throw new Error(`no ${profile} facade named ${wireName}`);
	return harnessFacade(target, spec, { settings, session });
}

function specFor(profile: HarnessProfile, wireName: string) {
	const spec = harnessFacadeSpecs(profile).find(entry => entry.wireName === wireName);
	if (!spec) throw new Error(`no ${profile} facade named ${wireName}`);
	return spec;
}

function stubTool(name: string, extra: Partial<AgentTool> = {}): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
		...extra,
	};
}

async function codexSession(): Promise<{ session: AgentSession; registry: Map<string, AgentTool> }> {
	const tools = [
		stubTool("eval", { supportsCodeModeTransport: () => true } as Partial<AgentTool>),
		stubTool("task"),
		stubTool("write"),
		stubTool("wait"),
		stubTool("read"),
	];
	const registry = new Map(tools.map(value => [value.name, value]));
	const session = new AgentSession({
		agent: new Agent({ initialState: { model: CODEX_MODEL, systemPrompt: [], tools } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "providers.openai-codex.codeMode": "auto" }),
		modelRegistry: {
			getApiKey: async () => "test-key",
			hasConfiguredAuth: () => true,
			refreshSelectedModelMetadata: async (value: Model) => value,
			clearSuppressedSelector: () => undefined,
		} as never,
		toolRegistry: registry,
		builtInToolNames: tools.map(value => value.name),
		rebuildSystemPrompt: async names => ({ systemPrompt: [`tools:${names.join(",")}`] }),
	});
	sessions.push(session);
	await session.setActiveToolsByName(tools.map(value => value.name));
	return { session, registry };
}

async function runFacadeCall(
	model: Model,
	tools: AgentTool[],
	call: { name: string; arguments: Record<string, unknown> },
): Promise<{ agent: Agent; events: AgentEvent[]; assistant: AssistantMessage; result: ToolResultMessage }> {
	const mock = createMockModel({
		responses: [{ content: [{ type: "toolCall", id: "toolu_facade", ...call }] }, { content: ["done"] }],
	});
	const agent = new Agent({
		initialState: { model, systemPrompt: [], tools, messages: [] },
		streamFn: mock.stream,
	});
	const events: AgentEvent[] = [];
	agent.subscribe(event => {
		events.push(event);
	});
	await agent.prompt("go");
	const assistant = agent.state.messages.find(
		(message): message is AssistantMessage =>
			message.role === "assistant" && message.content.some(block => block.type === "toolCall"),
	);
	const result = agent.state.messages.find((message): message is ToolResultMessage => message.role === "toolResult");
	if (!assistant || !result) throw new Error("facade call did not round trip");
	return { agent, events, assistant, result };
}

function anthropicTextTurnFetch(): FetchImpl {
	const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	const events: Record<string, unknown>[] = [
		{ type: "message_start", message: { id: "msg_facade", usage } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function replayedAnthropicToolCalls(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuth: boolean,
): Promise<Array<{ name: string; input: unknown }>> {
	let payload: Record<string, unknown> | undefined;
	const stream = streamAnthropic(model, context, {
		apiKey: isOAuth ? "sk-ant-oat-test" : "sk-ant-api-test",
		isOAuth,
		fetch: anthropicTextTurnFetch(),
		onPayload: captured => {
			if (isRecord(captured)) payload = captured;
		},
	});
	for await (const _ of stream) {
	}
	await stream.result();
	const messages = Array.isArray(payload?.messages) ? payload.messages : [];
	return messages.flatMap(message =>
		(Array.isArray(message.content) ? message.content : []).flatMap((block: Record<string, unknown>) =>
			block.type === "tool_use" && typeof block.name === "string" ? [{ name: block.name, input: block.input }] : [],
		),
	);
}

async function replayedAnthropicToolNames(context: Context): Promise<string[]> {
	return (await replayedAnthropicToolCalls(CLAUDE_CODE_MODEL, context, true)).map(call => call.name);
}

function dataSse(events: readonly Record<string, unknown>[], done: boolean): FetchImpl {
	const body = `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n${done ? "data: [DONE]\n\n" : ""}`;
	return async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const RESPONSES_TEXT_SSE: readonly Record<string, unknown>[] = [
	{ type: "response.output_text.delta", delta: "ok" },
	{ type: "response.completed", response: { status: "completed" } },
];

const COMPLETIONS_TEXT_SSE: readonly Record<string, unknown>[] = [
	{ id: "c1", choices: [{ index: 0, delta: { content: "ok" } }] },
	{ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];

async function replayedResponsesToolCalls(
	context: Context,
): Promise<Array<{ name: string; arguments: unknown; namespace: unknown }>> {
	let payload: Record<string, unknown> | undefined;
	const stream = streamOpenAIResponses(NATIVE_RESPONSES_MODEL, context, {
		apiKey: "sk-test",
		fetch: dataSse(RESPONSES_TEXT_SSE, false),
		onPayload: captured => {
			if (isRecord(captured)) payload = captured;
		},
	});
	for await (const _ of stream) {
	}
	await stream.result();
	const input = Array.isArray(payload?.input) ? payload.input : [];
	return input.flatMap((item: Record<string, unknown>) =>
		item.type === "function_call" && typeof item.name === "string"
			? [{ name: item.name, arguments: item.arguments, namespace: item.namespace }]
			: [],
	);
}

async function replayedCompletionsToolCalls(context: Context): Promise<Array<{ name: string; arguments: unknown }>> {
	let payload: Record<string, unknown> | undefined;
	const stream = streamOpenAICompletions(NATIVE_COMPLETIONS_MODEL, context, {
		apiKey: "sk-test",
		fetch: dataSse(COMPLETIONS_TEXT_SSE, true),
		onPayload: captured => {
			if (isRecord(captured)) payload = captured;
		},
	});
	for await (const _ of stream) {
	}
	await stream.result();
	const messages = Array.isArray(payload?.messages) ? payload.messages : [];
	return messages.flatMap((message: Record<string, unknown>) =>
		(Array.isArray(message.tool_calls) ? message.tool_calls : []).flatMap((call: Record<string, unknown>) =>
			isRecord(call.function) && typeof call.function.name === "string"
				? [{ name: call.function.name, arguments: call.function.arguments }]
				: [],
		),
	);
}

/** Persist through a real session file and read it back, as a resumed session would. */
async function reopenedFromDisk(messages: Message[]): Promise<Message[]> {
	using tempDir = TempDir.createSync("@omp-harness-facades-");
	const sessionDir = path.join(tempDir.path(), "sessions");
	const manager = SessionManager.create(tempDir.path(), sessionDir);
	for (const message of messages) manager.appendMessage(message);
	await manager.close();
	const file = manager.getSessionFile();
	if (!file) throw new Error("session was not persisted");
	const reopened = await SessionManager.open(file, sessionDir, undefined, { suppressBreadcrumb: true });
	try {
		return reopened.buildSessionContext().messages.filter((message): message is Message => message.role !== "custom");
	} finally {
		await reopened.close();
	}
}

afterEach(async () => {
	AgentRegistry.global().unregister(PEER);
	AgentRegistry.global().unregister(SENDER);
	AgentRegistry.global().unregister(PARKED);
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 200 });
	for (const session of sessions.splice(0)) await session.dispose();
	vi.restoreAllMocks();
});

describe("vendor descriptions under a profile", () => {
	it("presents the served capture's words for bound tools and facades, read at request time", () => {
		const served: { tool?: VendorTool } = {};
		const read = stubTool("read", { examples: [{ caption: "omp example" }] });
		const presented = presentTool(read, { wireName: "Read" }, () => served.tool);
		const spec = specFor("codex", "send_message");
		const facade = harnessFacade(stubTool("write"), spec, { settings: Settings.isolated() }, () => served.tool);

		// Tools are presented before the capture loads: omp's own surface until then.
		expect(presented.description).toBe("read");
		expect(presented.parameters).toBe(read.parameters);
		expect(presented.examples).toEqual([{ caption: "omp example" }]);
		expect(facade.description).toBe(spec.description);
		expect(facade.parameters).toBe(spec.parameters);

		const inputSchema = { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] };
		served.tool = { description: "Reads a file from the local filesystem.", inputSchema };
		expect(presented.description).toBe(served.tool.description);
		expect(presented.parameters).toBe(inputSchema);
		expect(presented.customWireName).toBe("Read");
		expect(facade.description).toBe(served.tool.description);
		expect(facade.parameters).toBe(inputSchema);
		// The agent loop spreads own keys into the request copy; omp's examples
		// would otherwise render into the vendor text.
		expect({ ...presented }.examples).toBeUndefined();
	});

	it("keeps omp's own words for the claude-code agent facades even once the capture declares them", () => {
		// The vendor text for these tools describes teams, peer sessions, and
		// cloud features omp lacks, so the facades serve their own surface.
		const served: VendorTool = { description: "vendor text: teammates and cloud sessions", inputSchema: {} };
		for (const wireName of ["Agent", "SendMessage", "ListAgents", "TaskOutput", "TaskStop", "WebFetch", "Skill"]) {
			const spec = specFor("claude-code", wireName);
			const facade = harnessFacade(stubTool(spec.target), spec, { settings: Settings.isolated() }, () => served);
			expect(facade.description).not.toBe(served.description);
			expect(facade.parameters).not.toBe(served.inputSchema);
			expect(facade.description).not.toMatch(/not available in this build|leave unset/i);
		}
	});
});

describe("claude-code SendMessage facade", () => {
	it("delivers through write agent://, persists as write, and replays to Anthropic as SendMessage", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: PEER, displayName: PEER, kind: "sub", session: null, status: "running" });
		const inbox = IrcBus.global().wait(PEER, { from: SENDER }, 0);
		const write = new WriteTool(toolSession()) as unknown as AgentTool;
		const facade = facadeFor("claude-code", "SendMessage", write);

		const { agent, events, assistant, result } = await runFacadeCall(CLAUDE_CODE_MODEL, [write, facade], {
			name: "SendMessage",
			arguments: { to: PEER, message: "ping from the facade", summary: "ping" },
		});

		expect((await inbox)?.body).toBe("ping from the facade");
		expect(result.toolName).toBe("write");
		expect(result.isError).toBeFalsy();
		expect(result.content).toContainEqual({ type: "text", text: `Delivered to ${PEER}.` });
		expect(assistant.content.find(block => block.type === "toolCall")).toMatchObject({
			name: "write",
			wireName: "SendMessage",
			arguments: { to: PEER, message: "ping from the facade", summary: "ping" },
		});
		const end = events.find(event => event.type === "tool_execution_end");
		expect(end?.type === "tool_execution_end" ? end.toolName : undefined).toBe("write");

		const replayed = await replayedAnthropicToolNames({
			messages: agent.state.messages as Message[],
			tools: [write, facade],
		});
		expect(replayed).toEqual(["SendMessage"]);
	});

	it("emits tool_execution_start under the omp name with omp-shaped args", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: PEER, displayName: PEER, kind: "sub", session: null, status: "running" });
		const write = new WriteTool(toolSession()) as unknown as AgentTool;
		const facade = facadeFor("claude-code", "SendMessage", write);

		const { assistant, events } = await runFacadeCall(CLAUDE_CODE_MODEL, [write, facade], {
			name: "SendMessage",
			arguments: { to: PEER, message: "ping", summary: "ping" },
		});

		const start = events.find(event => event.type === "tool_execution_start");
		expect(start?.type === "tool_execution_start" ? [start.toolName, start.args] : undefined).toEqual([
			"write",
			{ path: `agent://${PEER}`, content: "ping" },
		]);
		expect(assistant.content.find(block => block.type === "toolCall")).toMatchObject({
			name: "write",
			wireName: "SendMessage",
			arguments: { to: PEER, message: "ping", summary: "ping" },
		});
	});

	it("addresses agents by name and the main conversation as main", () => {
		const facade = facadeFor("claude-code", "SendMessage", stubTool("write"));
		expect(facade.toNativeArgs?.({ to: PEER, message: "hi" })).toEqual({ path: `agent://${PEER}`, content: "hi" });
		// Claude Code's `main` (any case) is omp's main agent.
		for (const to of ["main", "Main", " MAIN "]) {
			expect(facade.toNativeArgs?.({ to, message: "hi" })).toEqual({
				path: `agent://${MAIN_AGENT_ID}`,
				content: "hi",
			});
		}
		expect(facade.toNativeArgs?.({ to: "all", message: "hi" })).toEqual({ path: "agent://all", content: "hi" });
	});

	it("mounts only where peer messaging is enabled", () => {
		const spec = specFor("claude-code", "SendMessage");
		const settings = Settings.isolated({ "task.maxRecursionDepth": 0 });
		expect(spec.mounts?.({ settings })).toBe(false);
		expect(spec.mounts?.({ settings, session: { taskDepth: 1 } as unknown as ToolSession })).toBe(true);
		expect(spec.mounts?.({ settings: Settings.isolated() })).toBe(true);
	});

	it("replays the omp identity with native arguments once the profile is gone", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: PEER, displayName: PEER, kind: "sub", session: null, status: "running" });
		const inbox = IrcBus.global().wait(PEER, { from: SENDER }, 0);
		const write = new WriteTool(toolSession()) as unknown as AgentTool;
		const facade = facadeFor("claude-code", "SendMessage", write);
		const vendorArgs = { to: PEER, message: "ping", summary: "ping" };
		const nativeArgs = { path: `agent://${PEER}`, content: "ping" };

		const { agent } = await runFacadeCall(CLAUDE_CODE_MODEL, [write, facade], {
			name: "SendMessage",
			arguments: vendorArgs,
		});
		await inbox;
		const messages = await reopenedFromDisk(agent.state.messages as Message[]);
		const assistant = messages.find((message): message is AssistantMessage => message.role === "assistant");
		expect(assistant?.content[0]).toMatchObject({
			name: "write",
			wireName: "SendMessage",
			arguments: vendorArgs,
			nativeArguments: nativeArgs,
		});

		expect(await replayedAnthropicToolCalls(CLAUDE_CODE_MODEL, { messages, tools: [write, facade] }, true)).toEqual([
			{ name: "SendMessage", input: vendorArgs },
		]);
		expect(await replayedAnthropicToolCalls(NATIVE_ANTHROPIC_MODEL, { messages, tools: [write] }, false)).toEqual([
			{ name: "write", input: nativeArgs },
		]);
		expect(await replayedResponsesToolCalls({ messages, tools: [write] })).toEqual([
			{ name: "write", arguments: JSON.stringify(nativeArgs), namespace: undefined },
		]);
		expect(await replayedCompletionsToolCalls({ messages, tools: [write] })).toEqual([
			{ name: "write", arguments: JSON.stringify(nativeArgs) },
		]);
	});

	it("replays a session persisted before native arguments exactly as before", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: PEER, displayName: PEER, kind: "sub", session: null, status: "running" });
		const inbox = IrcBus.global().wait(PEER, { from: SENDER }, 0);
		const write = new WriteTool(toolSession()) as unknown as AgentTool;
		const facade = facadeFor("claude-code", "SendMessage", write);
		const vendorArgs = { to: PEER, message: "ping", summary: "ping" };

		const { agent } = await runFacadeCall(CLAUDE_CODE_MODEL, [write, facade], {
			name: "SendMessage",
			arguments: vendorArgs,
		});
		await inbox;
		const olderBuild = (agent.state.messages as Message[]).map(message =>
			message.role === "assistant"
				? {
						...message,
						content: message.content.map(block => {
							if (block.type !== "toolCall") return block;
							const { nativeArguments: _, ...persisted } = block;
							return persisted;
						}),
					}
				: message,
		);
		const messages = await reopenedFromDisk(olderBuild);
		const assistant = messages.find((message): message is AssistantMessage => message.role === "assistant");
		expect(assistant?.content[0]).toMatchObject({ name: "write", wireName: "SendMessage", arguments: vendorArgs });
		expect(assistant?.content[0]).not.toHaveProperty("nativeArguments");

		expect(await replayedAnthropicToolCalls(CLAUDE_CODE_MODEL, { messages, tools: [write, facade] }, true)).toEqual([
			{ name: "SendMessage", input: vendorArgs },
		]);
		expect(await replayedAnthropicToolCalls(NATIVE_ANTHROPIC_MODEL, { messages, tools: [write] }, false)).toEqual([
			{ name: "write", input: vendorArgs },
		]);
		expect(await replayedResponsesToolCalls({ messages, tools: [write] })).toEqual([
			{ name: "SendMessage", arguments: JSON.stringify(vendorArgs), namespace: undefined },
		]);
	});
});

describe("claude-code ListAgents facade", () => {
	it("lists only live agents through read history://?live", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: PEER, displayName: PEER, kind: "sub", session: null, status: "running" });
		registry.register({ id: PARKED, displayName: PARKED, kind: "sub", session: null, status: "parked" });
		const session = {
			...toolSession(),
			settings: Settings.isolated({ "launch.enabled": false, "harness.mode": "claude-code" }),
			getActiveModel: () => CLAUDE_CODE_MODEL,
		} as unknown as ToolSession;
		const read = new ReadTool(session) as unknown as AgentTool;
		const facade = facadeFor("claude-code", "ListAgents", read);

		const listed = await runFacadeCall(CLAUDE_CODE_MODEL, [read, facade], { name: "ListAgents", arguments: {} });
		expect(listed.result.toolName).toBe("read");
		expect(listed.result.isError).toBeFalsy();
		expect(listed.assistant.content[0]).toMatchObject({
			name: "read",
			wireName: "ListAgents",
			nativeArguments: { path: "history://?live" },
		});
		const text = listed.result.content[0]?.type === "text" ? listed.result.content[0].text : "";
		expect(text).toContain(`| ${PEER} | running | sub |`);
		// Parked agents and on-disk transcripts stay out of the live roster.
		expect(text).not.toContain(PARKED);
		expect(text).not.toContain("on disk");
		expect(text).toContain("Read a transcript with `Read history://<id>`.");

		// The bare index keeps every agent and the native read wording.
		const everything = await runFacadeCall(NATIVE_ANTHROPIC_MODEL, [read], {
			name: "read",
			arguments: { path: "history://" },
		});
		const index = everything.result.content[0]?.type === "text" ? everything.result.content[0].text : "";
		expect(index).toContain(`| ${PARKED} | parked | sub |`);
	});
});

describe("claude-code TaskOutput facade", () => {
	it("mounts only for a capture that declares TaskOutput", () => {
		const spec = specFor("claude-code", "TaskOutput");
		const settings = Settings.isolated();
		// Claude Code 2.1.284 dropped TaskOutput: its agents wait by ending the turn.
		expect(spec.mounts?.({ settings, vendorTool: () => undefined })).toBe(false);
		expect(spec.mounts?.({ settings })).toBe(false);
		const declared: VendorTool = { description: "Retrieves output", inputSchema: {} };
		expect(spec.mounts?.({ settings, vendorTool: name => (name === "TaskOutput" ? declared : undefined) })).toBe(
			true,
		);
		expect(spec.replacesTarget).toBe(true);
	});

	it("waits through the wait tool for the next settled job", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		managers.push(manager);
		const wait = new WaitTool(toolSession({ manager })) as unknown as AgentTool;
		const facade = facadeFor("claude-code", "TaskOutput", wait);
		const gate = Promise.withResolvers<string>();
		const jobId = manager.register("bash", "facade job", () => gate.promise, { ownerId: SENDER });

		gate.resolve("finished");
		await manager.getJob(jobId)?.promise;
		const waited = await runFacadeCall(CLAUDE_CODE_MODEL, [wait, facade], {
			name: "TaskOutput",
			arguments: { task_id: jobId, block: true, timeout: 5000 },
		});
		expect(waited.result.toolName).toBe("wait");
		expect(waited.result.details).toMatchObject({
			op: "wait",
			jobs: [expect.objectContaining({ id: jobId, status: "completed" })],
		});
		expect(waited.result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("finished") });
		expect(waited.assistant.content[0]).toMatchObject({ name: "wait", wireName: "TaskOutput", nativeArguments: {} });
	});
});

describe("claude-code TaskStop facade", () => {
	it("cancels the job through write proc://<id>/kill, accepting the deprecated shell_id alias", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		managers.push(manager);
		const write = new WriteTool(toolSession({ manager })) as unknown as AgentTool;
		const facade = facadeFor("claude-code", "TaskStop", write);
		const jobId = manager.register(
			"bash",
			"facade job",
			({ signal }) =>
				new Promise<string>(resolve => {
					signal.addEventListener("abort", () => resolve(""), { once: true });
				}),
			{ ownerId: SENDER },
		);

		const stopped = await runFacadeCall(CLAUDE_CODE_MODEL, [write, facade], {
			name: "TaskStop",
			arguments: { shell_id: jobId },
		});
		expect(stopped.result.toolName).toBe("write");
		expect(stopped.result.isError).toBeFalsy();
		expect(stopped.assistant.content[0]).toMatchObject({
			name: "write",
			wireName: "TaskStop",
			nativeArguments: { path: `proc://${jobId}/kill` },
		});
		await manager.getJob(jobId)?.promise;
		expect(manager.getJob(jobId)?.status).toBe("cancelled");

		const missing = await runFacadeCall(CLAUDE_CODE_MODEL, [write, facade], { name: "TaskStop", arguments: {} });
		expect(missing.result.isError).toBe(true);
		expect(missing.result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("task_id") });
	});
});

describe("codex interrupt_agent facade", () => {
	it("cancels the job through write proc://<id>/kill under the vendor name", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		managers.push(manager);
		const write = new WriteTool(toolSession({ manager })) as unknown as AgentTool;
		const facade = facadeFor("codex", "interrupt_agent", write);
		const jobId = manager.register(
			"bash",
			"facade job",
			({ signal }) =>
				new Promise<string>(resolve => {
					signal.addEventListener("abort", () => resolve(""), { once: true });
				}),
			{ ownerId: SENDER },
		);

		const stopped = await runFacadeCall(CODEX_MODEL, [write, facade], {
			name: "interrupt_agent",
			arguments: { target: jobId },
		});
		expect(stopped.result.toolName).toBe("write");
		expect(stopped.result.isError).toBeFalsy();
		await manager.getJob(jobId)?.promise;
		expect(manager.getJob(jobId)?.status).toBe("cancelled");
	});
});

describe("claude-code Agent facade", () => {
	it("spawns through task, persists as task, and feeds the task usage accounting", async () => {
		const usage = {
			input: 7,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const spawned: unknown[] = [];
		const task: AgentTool = {
			name: "task",
			label: "Task",
			description: "task",
			parameters: type({ task: "string", "agent?": "string", "isolated?": "boolean" }),
			approval: "exec",
			async execute(_id, params) {
				spawned.push(params);
				return { content: [{ type: "text", text: "report" }], details: { usage } };
			},
		};
		const facade = facadeFor("claude-code", "Agent", task);

		const run = await runFacadeCall(CLAUDE_CODE_MODEL, [facade], {
			name: "Agent",
			arguments: { description: "Scan repo", prompt: "list every TODO", subagent_type: "scout" },
		});
		expect(spawned).toEqual([{ task: "list every TODO", agent: "scout" }]);
		expect(run.result.toolName).toBe("task");
		expect(run.assistant.content[0]).toMatchObject({ name: "task", wireName: "Agent" });
		expect((facade.intent as (args: unknown) => string | undefined)({ description: "Scan repo" })).toBe("Scan repo");
		expect(facade.approval).toBeFunction();
		expect((facade.approval as (args: unknown) => unknown)({ description: "x", prompt: "y" })).toEqual({
			tier: "exec",
			policyKey: "task",
		});

		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(run.result);
		expect(sessionManager.getUsageStatistics().input).toBe(7);

		spawned.length = 0;
		const forked = await runFacadeCall(CLAUDE_CODE_MODEL, [facade], {
			name: "Agent",
			arguments: { description: "Fork", prompt: "continue", subagent_type: "fork" },
		});
		// "fork" inherits the conversation through the default agent — it is not
		// itself an agent type, so it never reaches the spawn as `agent`.
		expect(forked.result.isError).not.toBe(true);
		expect(spawned).toEqual([{ task: "continue", fork: "all" }]);
	});

	it("maps the batch form onto task's shared context and items", () => {
		const facade = facadeFor("claude-code", "Agent", stubTool("task"));
		expect(
			facade.toNativeArgs?.({
				description: "Audit the repo",
				prompt: "# Goal\nshared brief",
				tasks: [
					{ description: "Scan docs", prompt: "Scan the docs.", subagent_type: "scout" },
					{ description: "Scan code", prompt: "Scan the code." },
				],
			}),
		).toEqual({
			context: "# Goal\nshared brief",
			tasks: [{ task: "Scan the docs.", agent: "scout" }, { task: "Scan the code." }],
		});
		// Forking is a single-spawn feature: a fork item is refused, never dropped.
		expect(() =>
			facade.toNativeArgs?.({
				description: "x",
				prompt: "brief",
				tasks: [{ description: "y", prompt: "z", subagent_type: "fork" }],
			}),
		).toThrow(/fork/);
	});

	it("serves isolation only while task isolation is enabled and never a model override", () => {
		const schemaOf = (settings: Settings) =>
			JSON.stringify(
				(
					facadeFor("claude-code", "Agent", stubTool("task"), settings).parameters as { toJsonSchema(): unknown }
				).toJsonSchema(),
			);
		const plain = schemaOf(Settings.isolated({ "task.isolation.enabled": false, "task.batch": false }));
		expect(plain).not.toContain('"isolation"');
		expect(plain).not.toContain('"tasks"');
		expect(plain).not.toContain('"model"');
		const full = schemaOf(Settings.isolated({ "task.isolation.enabled": true, "task.batch": true }));
		expect(full).toContain('"isolation"');
		expect(full).toContain('"worktree"');
		expect(full).not.toContain('"remote"');
		expect(full).toContain('"tasks"');
		expect(full).not.toContain('"model"');

		const off = facadeFor("claude-code", "Agent", stubTool("task"), Settings.isolated());
		expect(() => off.toNativeArgs?.({ description: "x", prompt: "y", isolation: "worktree" })).toThrow(/isolation/);
		const on = facadeFor(
			"claude-code",
			"Agent",
			stubTool("task"),
			Settings.isolated({ "task.isolation.enabled": true }),
		);
		expect(on.toNativeArgs?.({ description: "x", prompt: "y", isolation: "worktree" })).toEqual({
			task: "y",
			isolated: true,
		});
	});

	it("describes the task tool's live agent roster in Claude Code's words", async () => {
		const agents: AgentDefinition[] = [
			{ name: "task", description: "General-purpose worker", systemPrompt: "task", source: "bundled" },
			{ name: "scout", description: "Fast read-only research", systemPrompt: "scout", source: "bundled" },
		];
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents, projectAgentsDir: null });
		const settings = Settings.isolated({ "task.isolation.enabled": true });
		const task = await TaskTool.create({
			cwd: "/tmp/omp-claude-code-agent-description",
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession);
		const facade = facadeFor("claude-code", "Agent", task as unknown as AgentTool, settings);

		expect(facade.description).toStartWith("Launch a new agent to handle complex, multi-step tasks.");
		expect(facade.description).toContain("Available agent types:");
		expect(facade.description).toContain("- `task`: General-purpose worker");
		expect(facade.description).toContain("- `scout`");
		expect(facade.description).toContain('`isolation: "worktree"`');
		expect(facade.description).toContain("make one call with `tasks`");
		// Stable across requests: the roster is a cached snapshot, not a rescan.
		expect(facade.description).toBe(facade.description);
		for (const omp of ["write agent://", "read proc://", "`wait`", "`yield`", "<irc>"]) {
			expect(facade.description).not.toContain(omp);
		}
		// Batch speculation re-keys the task tool's stream planning onto `prompt`.
		expect(facade.speculation?.stream).toBeDefined();
	});
});

describe("codex collaboration facades on the wire", () => {
	it("declares them direct in the collaboration group and keeps them out of the exec isolate", async () => {
		const { session, registry } = await codexSession();
		const tools = session.agent.state.tools;
		const surface = buildCodexNamespaceTools(tools, CODEX_MODEL as Model<"openai-codex-responses">);
		const collaboration = surface.find(entry => entry.type === "namespace" && entry.name === "agents");
		expect(collaboration?.type === "namespace" ? collaboration.description : undefined).toBe(
			"Tools for spawning and managing sub-agents.",
		);
		expect(
			collaboration?.type === "namespace" ? collaboration.tools.map(entry => "name" in entry && entry.name) : [],
		).toEqual(["spawn_agent", "send_message", "followup_task", "list_agents", "interrupt_agent", "wait_agent"]);
		expect(tools.map(tool => tool.name)).not.toContain("task");
		// The vendor `wait` shares omp's tool name and stands in for it: one declaration, never two.
		expect(tools.filter(tool => tool.name === "wait")).toHaveLength(1);
		expect(tools.find(tool => tool.name === "wait")?.persistAs).toBe("wait");

		const evalTool = new EvalTool({
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			settings: Settings.isolated(),
			getActiveModel: () => CODEX_MODEL,
			toolRegistry: registry,
			getEvalBridgeToolNames: () => session.getEvalBridgeToolNames(),
			getCodeModeDirectToolNames: () => session.getCodeModeDirectToolNames(),
		} as unknown as ToolSession);
		// Only the facades are direct (they mount after the Code Mode partition);
		// omp's own `task`, `write` and `wait` stay reachable inside exec under their names.
		expect(session.getCodeModeDirectToolNames()).toEqual(["eval"]);
		expect(evalTool.description).toContain("### `read`");
		expect(evalTool.description).toContain("### `write`");
		expect(evalTool.description).toContain("### `wait`");
		expect(evalTool.description).not.toContain("spawn_agent");
		expect(evalTool.description).not.toContain("## collaboration");
	});
});

describe("codex spawn_agent facade", () => {
	it("spawns through task under the vendor name and maps reasoning_effort onto task effort", async () => {
		const spawned: unknown[] = [];
		const task: AgentTool = {
			...stubTool("task"),
			parameters: type({ "name?": "string", task: "string", "effort?": "string" }),
			approval: "exec",
			async execute(_id, params) {
				spawned.push(params);
				return { content: [{ type: "text", text: "report" }] };
			},
		};
		const plain = facadeFor("codex", "spawn_agent", task);
		expect(plain.namespace?.name).toBe("agents");

		const run = await runFacadeCall(CODEX_MODEL, [plain], {
			name: "spawn_agent",
			arguments: { task_name: "scan_repo", message: "list every TODO", fork_turns: "none" },
		});
		expect(spawned).toEqual([{ name: "scan_repo", task: "list every TODO" }]);
		expect(run.result.toolName).toBe("task");
		expect(run.assistant.content[0]).toMatchObject({ name: "task", wireName: "spawn_agent" });
		expect((plain.intent as (args: unknown) => string | undefined)({ task_name: "scan_repo" })).toBe("scan_repo");

		// The vendor default: an absent fork_turns forks the whole conversation.
		spawned.length = 0;
		await runFacadeCall(CODEX_MODEL, [plain], {
			name: "spawn_agent",
			arguments: { task_name: "inherit_all", message: "continue" },
		});
		expect(spawned).toEqual([{ name: "inherit_all", task: "continue", fork: "all" }]);

		// A positive integer string forks only that many trailing turns.
		spawned.length = 0;
		await runFacadeCall(CODEX_MODEL, [plain], {
			name: "spawn_agent",
			arguments: { task_name: "tail_two", message: "continue", fork_turns: "2" },
		});
		expect(spawned).toEqual([{ name: "tail_two", task: "continue", fork: 2 }]);

		// Vendor parsing is case-insensitive and trims: "NONE" inherits
		// nothing, "All" and " 3 " map onto the same task params.
		spawned.length = 0;
		await runFacadeCall(CODEX_MODEL, [plain], {
			name: "spawn_agent",
			arguments: { task_name: "no_ctx", message: "fresh", fork_turns: "NONE" },
		});
		expect(spawned).toEqual([{ name: "no_ctx", task: "fresh" }]);

		spawned.length = 0;
		await runFacadeCall(CODEX_MODEL, [plain], {
			name: "spawn_agent",
			arguments: { task_name: "all_caps", message: "everything", fork_turns: "All" },
		});
		expect(spawned).toEqual([{ name: "all_caps", task: "everything", fork: "all" }]);

		spawned.length = 0;
		await runFacadeCall(CODEX_MODEL, [plain], {
			name: "spawn_agent",
			arguments: { task_name: "tail_three", message: "continue", fork_turns: " 3 " },
		});
		expect(spawned).toEqual([{ name: "tail_three", task: "continue", fork: 3 }]);

		const effortOff = await runFacadeCall(CODEX_MODEL, [plain], {
			name: "spawn_agent",
			arguments: { task_name: "a", message: "b", reasoning_effort: "xhigh" },
		});
		expect(effortOff.result.isError).toBe(true);
		expect(effortOff.result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("spawn_agent.reasoning_effort"),
		});

		const withEffort = facadeFor("codex", "spawn_agent", task, Settings.isolated({ "task.enableEffort": true }));
		spawned.length = 0;
		await runFacadeCall(CODEX_MODEL, [withEffort], {
			name: "spawn_agent",
			arguments: { task_name: "a", message: "b", reasoning_effort: "xhigh" },
		});
		expect(spawned).toEqual([{ name: "a", task: "b", fork: "all", effort: "hi" }]);

		// A model override is accepted and ignored: the agent definition owns the model.
		spawned.length = 0;
		await runFacadeCall(CODEX_MODEL, [withEffort], {
			name: "spawn_agent",
			arguments: { task_name: "a", message: "b", model: "gpt-5.5" },
		});
		expect(spawned).toEqual([{ name: "a", task: "b", fork: "all" }]);

		// fork_turns accepts the vendor's vocabulary only; anything else carries
		// the vendor's own error text back to the model.
		for (const args of [
			{ task_name: "a", message: "b", fork_turns: "zero" },
			{ task_name: "a", message: "b", fork_turns: "0" },
			{ task_name: "a", message: "b", fork_turns: "1e3" },
			{ task_name: "a", message: "b", fork_turns: "-1" },
			{ task_name: "a", message: "b", reasoning_effort: "extreme" },
		] as const) {
			const rejected = await runFacadeCall(CODEX_MODEL, [withEffort], {
				name: "spawn_agent",
				arguments: { ...args },
			});
			expect(rejected.result.isError).toBe(true);
		}

		const zero = await runFacadeCall(CODEX_MODEL, [withEffort], {
			name: "spawn_agent",
			arguments: { task_name: "a", message: "b", fork_turns: "0" },
		});
		expect(zero.result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("fork_turns must be `none`, `all`, or a positive integer string"),
		});
	});
});

describe("codex send_message facade", () => {
	it("delivers through write agent:// and persists as write", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: PEER, displayName: PEER, kind: "sub", session: null, status: "running" });
		const inbox = IrcBus.global().wait(PEER, { from: SENDER }, 0);
		const write = new WriteTool(toolSession()) as unknown as AgentTool;
		const facade = facadeFor("codex", "send_message", write);
		expect(facade.namespace?.name).toBe("agents");

		const { assistant, result } = await runFacadeCall(CODEX_MODEL, [write, facade], {
			name: "send_message",
			arguments: { target: PEER, message: "ping from codex" },
		});

		expect((await inbox)?.body).toBe("ping from codex");
		expect(result.toolName).toBe("write");
		expect(result.isError).toBeFalsy();
		expect(result.content).toContainEqual({ type: "text", text: `Delivered to ${PEER}.` });
		expect(assistant.content[0]).toMatchObject({ name: "write", wireName: "send_message" });
	});

	it("replays under its own name on codex and as write with native arguments elsewhere", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: PEER, displayName: PEER, kind: "sub", session: null, status: "running" });
		const inbox = IrcBus.global().wait(PEER, { from: SENDER }, 0);
		const write = new WriteTool(toolSession()) as unknown as AgentTool;
		const facade = facadeFor("codex", "send_message", write);
		const vendorArgs = { target: PEER, message: "ping from codex" };
		const nativeArgs = { path: `agent://${PEER}`, content: "ping from codex" };

		const { agent } = await runFacadeCall(CODEX_MODEL, [write, facade], {
			name: "send_message",
			arguments: vendorArgs,
		});
		await inbox;
		const messages = (agent.state.messages as Message[]).map((message): Message =>
			message.role === "assistant"
				? {
						...message,
						content: message.content.map(block =>
							block.type === "toolCall" ? { ...block, namespace: "agents" } : block,
						),
					}
				: message,
		);
		const assistant = messages.find((message): message is AssistantMessage => message.role === "assistant");
		expect(assistant?.content[0]).toMatchObject({
			name: "write",
			wireName: "send_message",
			nativeArguments: nativeArgs,
		});

		const body = await buildTransformedCodexRequestBody(
			CODEX_MODEL,
			{ messages, tools: [write, facade] },
			{
				reasoning: Effort.High,
			},
		);
		const codexCalls = (Array.isArray(body.input) ? body.input : []).flatMap(item =>
			isRecord(item) && item.type === "function_call"
				? [{ name: item.name, arguments: item.arguments, namespace: item.namespace }]
				: [],
		);
		expect(codexCalls).toEqual([
			{ name: "send_message", arguments: JSON.stringify(vendorArgs), namespace: "agents" },
		]);
		expect(await replayedAnthropicToolCalls(NATIVE_ANTHROPIC_MODEL, { messages, tools: [write] }, false)).toEqual([
			{ name: "write", input: nativeArgs },
		]);
		expect(await replayedResponsesToolCalls({ messages, tools: [write] })).toEqual([
			{ name: "write", arguments: JSON.stringify(nativeArgs), namespace: undefined },
		]);
	});
});

describe("codex followup_task facade", () => {
	it("hands the task to an idle agent through write agent:// and wakes it", async () => {
		const delivered: unknown[] = [];
		AgentRegistry.global().register({
			id: PEER,
			displayName: PEER,
			kind: "sub",
			status: "idle",
			session: {
				deliverIrcMessage: async (message: { body: string }) => {
					delivered.push(message.body);
					return "woken";
				},
			} as unknown as AgentSession,
		});
		const write = new WriteTool(toolSession()) as unknown as AgentTool;
		const facade = facadeFor("codex", "followup_task", write);

		const { assistant, result } = await runFacadeCall(CODEX_MODEL, [write, facade], {
			name: "followup_task",
			arguments: { target: PEER, message: "now also check the tests" },
		});

		expect(delivered).toEqual(["now also check the tests"]);
		expect(result.toolName).toBe("write");
		expect(result.content).toContainEqual({ type: "text", text: `Delivered to ${PEER}.` });
		expect(result.details).toMatchObject({ message: { receipts: [expect.objectContaining({ outcome: "woken" })] } });
		expect(assistant.content[0]).toMatchObject({ name: "write", wireName: "followup_task" });
	});
});

describe("codex list_agents facade", () => {
	it("lists the agent index through read history:// and rejects path_prefix by name", async () => {
		AgentRegistry.global().register({ id: PEER, displayName: PEER, kind: "sub", session: null, status: "running" });
		const read = new ReadTool(toolSession()) as unknown as AgentTool;
		const facade = facadeFor("codex", "list_agents", read);

		const listed = await runFacadeCall(CODEX_MODEL, [read, facade], { name: "list_agents", arguments: {} });
		expect(listed.result.toolName).toBe("read");
		expect(listed.result.isError).toBeFalsy();
		expect(listed.result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining(`| ${PEER} | running | sub |`),
		});
		expect(listed.assistant.content[0]).toMatchObject({ name: "read", wireName: "list_agents" });

		const filtered = await runFacadeCall(CODEX_MODEL, [read, facade], {
			name: "list_agents",
			arguments: { path_prefix: "/root/task1" },
		});
		expect(filtered.result.isError).toBe(true);
		expect(filtered.result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("list_agents.path_prefix"),
		});
	});
});

describe("codex wait_agent facade", () => {
	it("returns a queued peer message, else the first background job to settle", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: SENDER,
			displayName: SENDER,
			kind: "main",
			status: "running",
			session: {
				deliverIrcMessage: async () => {
					throw new Error("mid-turn");
				},
			} as unknown as AgentSession,
		});
		registry.register({ id: PEER, displayName: PEER, kind: "sub", session: null, status: "running" });
		await IrcBus.global().send({ from: PEER, to: SENDER, body: "peer finished" });
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		managers.push(manager);
		const wait = new WaitTool(toolSession({ manager })) as unknown as AgentTool;
		const facade = facadeFor("codex", "wait_agent", wait);

		const messaged = await runFacadeCall(CODEX_MODEL, [wait, facade], { name: "wait_agent", arguments: {} });
		expect(messaged.result.toolName).toBe("wait");
		expect(messaged.result.details).toMatchObject({
			op: "wait",
			waited: expect.objectContaining({ body: "peer finished" }),
		});
		expect(messaged.assistant.content[0]).toMatchObject({ name: "wait", wireName: "wait_agent" });

		const gate = Promise.withResolvers<string>();
		const jobId = manager.register("bash", "facade job", () => gate.promise, { ownerId: SENDER });
		gate.resolve("settled output");
		await manager.getJob(jobId)?.promise;
		const settled = await runFacadeCall(CODEX_MODEL, [wait, facade], {
			name: "wait_agent",
			arguments: { timeout_ms: 1 },
		});
		expect(settled.result.details).toMatchObject({
			op: "wait",
			jobs: [expect.objectContaining({ id: jobId, status: "completed" })],
		});
		expect(settled.result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("settled output"),
		});
	});
});

describe("codex wait facade", () => {
	it("resumes a backgrounded exec cell through wait and names interrupt_agent for terminate", async () => {
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		managers.push(manager);
		const gate = Promise.withResolvers<void>();
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
			_code: string,
			options: { onChunk?: (chunk: string) => void },
		) => {
			options.onChunk?.("start\n");
			await gate.promise;
			return {
				output: "start\ndone\n",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				totalLines: 2,
				totalBytes: 11,
				outputLines: 2,
				outputBytes: 11,
				displayOutputs: [],
			};
		}) as never);
		const session = {
			...toolSession({ manager }),
			settings: Settings.isolated({
				"eval.autoBackground.enabled": true,
				"eval.autoBackground.thresholdMs": 0,
				"launch.enabled": false,
			}),
			getActiveModel: () => CODEX_MODEL,
		} as unknown as ToolSession;
		const exec = new EvalTool(session);
		const started = await exec.execute("exec-1", { language: "js", code: "await work()" });
		const cellId = started.details?.async?.jobId;
		if (!cellId) throw new Error("exec did not background the cell");
		expect(started.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(`cell ID ${cellId}`) });

		const wait = new WaitTool(session) as unknown as AgentTool;
		const facade = facadeFor("codex", "wait", wait);
		expect(facade.namespace).toBeUndefined();
		gate.resolve();
		await manager.getJob(cellId)?.promise;
		// The facade replaces omp's same-named `wait` on the codex surface, so it is the only `wait` declared.
		const waited = await runFacadeCall(CODEX_MODEL, [facade], {
			name: "wait",
			arguments: { cell_id: cellId, yield_time_ms: 5000, max_tokens: 10000 },
		});
		expect(waited.result.toolName).toBe("wait");
		expect(waited.result.details).toMatchObject({
			op: "wait",
			jobs: [expect.objectContaining({ id: cellId, status: "completed" })],
		});
		expect(waited.result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("done") });
		expect(waited.assistant.content[0]).toMatchObject({ name: "wait" });

		const jobId = manager.register(
			"eval",
			"second cell",
			({ signal }) =>
				new Promise<string>(resolve => {
					signal.addEventListener("abort", () => resolve(""), { once: true });
				}),
			{ ownerId: SENDER },
		);
		const terminated = await runFacadeCall(CODEX_MODEL, [facade], {
			name: "wait",
			arguments: { cell_id: jobId, terminate: true },
		});
		expect(terminated.result.isError).toBe(true);
		expect(terminated.result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining(
				`wait.terminate is not supported: stop the cell with interrupt_agent (target "${jobId}")`,
			),
		});
		expect(manager.getJob(jobId)?.status).toBe("running");
	});
});

describe("claude-code WebFetch facade", () => {
	async function withPage<T>(run: (url: string) => Promise<T>): Promise<T> {
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				new Response("<html><body><h1>Facade page</h1><p>hello from the server</p></body></html>", {
					headers: { "content-type": "text/html" },
				}),
		});
		try {
			return await run(`http://127.0.0.1:${server.port}/page`);
		} finally {
			server.stop(true);
		}
	}

	function webSession(): ToolSession {
		return {
			...toolSession(),
			settings: Settings.isolated(),
			getActiveModel: () => CLAUDE_CODE_MODEL,
		} as unknown as ToolSession;
	}

	it("fetches through read and answers the prompt with the smol model", async () => {
		const complete = vi
			.spyOn(completionBridge, "completeOnTier")
			.mockResolvedValue("The page greets you from the server.");
		await withPage(async url => {
			const session = webSession();
			const read = new ReadTool(session) as unknown as AgentTool;
			const facade = facadeFor("claude-code", "WebFetch", read, Settings.isolated(), session);
			const { assistant, result } = await runFacadeCall(CLAUDE_CODE_MODEL, [read, facade], {
				name: "WebFetch",
				arguments: { url, prompt: "what does it say?" },
			});
			expect(result.toolName).toBe("read");
			expect(result.isError).toBeFalsy();
			expect(result.content).toEqual([{ type: "text", text: "The page greets you from the server." }]);
			expect(assistant.content[0]).toMatchObject({ name: "read", wireName: "WebFetch" });
			expect(complete).toHaveBeenCalledTimes(1);
			const [question, tier] = complete.mock.calls[0] ?? [];
			expect(tier).toBe("smol");
			expect(question).toContain("hello from the server");
			expect(question).toContain("what does it say?");
		});
	});

	it("is served only while URL fetching is enabled", () => {
		const spec = specFor("claude-code", "WebFetch");
		expect(spec.mounts?.({ settings: Settings.isolated() })).toBe(true);
		expect(spec.mounts?.({ settings: Settings.isolated({ "fetch.enabled": false }) })).toBe(false);
	});

	it("returns the page itself when no smol model resolves", async () => {
		vi.spyOn(completionBridge, "completeOnTier").mockResolvedValue(undefined);
		await withPage(async url => {
			const session = webSession();
			const read = new ReadTool(session) as unknown as AgentTool;
			const facade = facadeFor("claude-code", "WebFetch", read, Settings.isolated(), session);
			const { result } = await runFacadeCall(CLAUDE_CODE_MODEL, [read, facade], {
				name: "WebFetch",
				arguments: { url, prompt: "what does it say?" },
			});
			expect(result.isError).toBeFalsy();
			expect(result.details).toMatchObject({ kind: "url" });
			expect(result.content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("hello from the server"),
			});
		});
	});
});

describe("claude-code Skill facade", () => {
	it("loads skill://<name> through read and hands the skill its args", async () => {
		using tempDir = TempDir.createSync("@omp-skill-facade-");
		const skillFile = (name: string, body: string) => {
			const baseDir = path.join(tempDir.path(), name);
			const filePath = path.join(baseDir, "SKILL.md");
			fs.mkdirSync(baseDir, { recursive: true });
			fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
			return { name, description: `${name} skill`, filePath, baseDir, source: "test" };
		};
		const session = {
			...toolSession(),
			settings: Settings.isolated(),
			skills: [skillFile("deploy", "Deploy to $ARGUMENTS now."), skillFile("review", "Review the change.")],
			getActiveModel: () => CLAUDE_CODE_MODEL,
		};
		const read = new ReadTool(session as unknown as ToolSession) as unknown as AgentTool;
		const facade = facadeFor("claude-code", "Skill", read);

		const missing = await runFacadeCall(CLAUDE_CODE_MODEL, [read, facade], {
			name: "Skill",
			arguments: { skill: "no-such-skill" },
		});
		expect(missing.result.toolName).toBe("read");
		expect(missing.result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Unknown skill: no-such-skill"),
		});
		expect(missing.assistant.content[0]).toMatchObject({ name: "read", wireName: "Skill" });

		const textOf = (result: ToolResultMessage) =>
			result.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
		// `$ARGUMENTS` in the instructions takes the args in place...
		const substituted = await runFacadeCall(CLAUDE_CODE_MODEL, [read, facade], {
			name: "Skill",
			arguments: { skill: "deploy", args: "production" },
		});
		expect(substituted.result.isError).toBeFalsy();
		expect(textOf(substituted.result)).toContain("Deploy to production now.");
		expect(textOf(substituted.result)).not.toContain("$ARGUMENTS");
		// ...otherwise they follow the instructions.
		const appended = await runFacadeCall(CLAUDE_CODE_MODEL, [read, facade], {
			name: "Skill",
			arguments: { skill: "review", args: "--strict" },
		});
		expect(textOf(appended.result)).toContain("Review the change.");
		expect(textOf(appended.result)).toEndWith("ARGUMENTS: --strict");
		// No args: the skill loads exactly as a plain read.
		const plain = await runFacadeCall(CLAUDE_CODE_MODEL, [read, facade], {
			name: "Skill",
			arguments: { skill: "review" },
		});
		expect(textOf(plain.result)).not.toContain("ARGUMENTS");
	});

	it("reads a namespaced collision alias and its bare winner by their listed names", async () => {
		// A differing same-name skill keeps its variant under `<namespace>/<name>`
		// (a plugin's name for plugin skills); `skill` carries that listed name verbatim.
		const collisionDir = path.join(import.meta.dir, "fixtures", "skills-collision");
		const skill = (name: string, root: string) => ({
			name,
			description: `${name} skill`,
			filePath: path.join(collisionDir, root, "calendar", "SKILL.md"),
			baseDir: path.join(collisionDir, root, "calendar"),
			source: "custom:user",
		});
		const session = {
			...toolSession(),
			settings: Settings.isolated(),
			skills: [skill("calendar", "first"), skill("second-plugin/calendar", "second")],
			getActiveModel: () => CLAUDE_CODE_MODEL,
		};
		const read = new ReadTool(session as unknown as ToolSession) as unknown as AgentTool;
		const facade = facadeFor("claude-code", "Skill", read);

		const namespaced = await runFacadeCall(CLAUDE_CODE_MODEL, [read, facade], {
			name: "Skill",
			arguments: { skill: "second-plugin/calendar" },
		});
		expect(namespaced.result.isError).toBe(false);
		expect(namespaced.result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Calendar (Second)"),
		});
		expect(namespaced.assistant.content[0]).toMatchObject({ name: "read", wireName: "Skill" });

		const bare = await runFacadeCall(CLAUDE_CODE_MODEL, [read, facade], {
			name: "Skill",
			arguments: { skill: "calendar" },
		});
		expect(bare.result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Calendar (First)") });
	});
});

describe("facade predicates stay total on unsupported vendor fields", () => {
	function policyTarget(): AgentTool {
		return stubTool("write", {
			approval: (params: unknown) =>
				typeof params === "object" && params !== null && "path" in params ? "read" : "exec",
			formatApprovalDetails: () => "write details",
			concurrency: () => "shared",
			interruptible: () => true,
		});
	}

	it("maps an unconvertible payload to the safest decision instead of throwing", () => {
		const facade = facadeFor("claude-code", "TaskStop", policyTarget());
		const hostile = {};
		const approval = facade.approval;
		expect(typeof approval === "function" ? approval(hostile) : approval).toEqual({
			tier: "exec",
			policyKey: "write",
		});
		expect(resolveApproval(facade, hostile, "write", {})).toMatchObject({ policy: "prompt" });
		expect(facade.formatApprovalDetails?.(hostile)).toBeUndefined();
		const concurrency = facade.concurrency;
		expect(typeof concurrency === "function" ? concurrency(hostile) : concurrency).toBe("exclusive");
		const interruptible = facade.interruptible;
		expect(typeof interruptible === "function" ? interruptible(hostile) : interruptible).toBe(false);
	});

	it("keeps the target tool's real policy for convertible payloads", () => {
		const facade = facadeFor("claude-code", "TaskStop", policyTarget());
		const convertible = { task_id: "bg_1" };
		const approval = facade.approval;
		expect(typeof approval === "function" ? approval(convertible) : approval).toEqual({
			tier: "read",
			policyKey: "write",
		});
		expect(facade.formatApprovalDetails?.(convertible)).toBe("write details");
		const concurrency = facade.concurrency;
		expect(typeof concurrency === "function" ? concurrency(convertible) : concurrency).toBe("shared");
		const interruptible = facade.interruptible;
		expect(typeof interruptible === "function" ? interruptible(convertible) : interruptible).toBe(true);
	});
});
