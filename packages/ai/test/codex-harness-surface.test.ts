import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import {
	buildTransformedCodexRequestBody,
	type OpenAICodexResponsesOptions,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type {
	AssistantMessage,
	CodexRequestSnapshot,
	Context,
	FetchImpl,
	ProviderSessionState,
	Tool,
} from "@oh-my-pi/pi-ai/types";
import { jsonSchemaToTypeScript } from "@oh-my-pi/pi-ai/utils/schema/typescript";
import { createCodexModel } from "./helpers";
import { loadEvalToolCodexExecFormat } from "./helpers/harness-golden";

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

const EXEC_FORMAT = await loadEvalToolCodexExecFormat();
const EXEC_WIRE_GRAMMAR = [
	"start: pragma_source | plain_source",
	"pragma_source: PRAGMA_LINE NEWLINE SOURCE",
	"plain_source: SOURCE",
	"PRAGMA_LINE: /[ \\t]*\\/\\/ @exec:[^\\r\\n]*/",
	"NEWLINE: /\\r?\\n/",
	"SOURCE: /[\\s\\S]+/",
].join("\n");
const COLLABORATION_BLURB = "Tools for spawning and managing sub-agents.";

function createHarnessTools(): Tool[] {
	return [
		{
			name: "eval",
			customWireName: "exec",
			description: "Run JavaScript code to orchestrate/compose tool calls",
			parameters: type({ input: "string" }),
			customFormat: EXEC_FORMAT,
		},
		{
			name: "wait",
			description: "Waits on a yielded `exec` cell and returns new output or completion.",
			parameters: type({ cell_id: "string" }),
		},
		{
			name: "spawn_agent",
			description: "Spawn a subagent.",
			parameters: type({ prompt: "string" }),
			namespace: { name: "collaboration", description: COLLABORATION_BLURB },
		},
		{
			name: "list_agents",
			description: "List the running subagents.",
			parameters: type({}),
			namespace: { name: "collaboration" },
		},
	];
}

const EXEC_DECLARATION = {
	type: "custom",
	name: "exec",
	description: "Run JavaScript code to orchestrate/compose tool calls",
	format: { type: "grammar", syntax: "lark", definition: EXEC_WIRE_GRAMMAR },
};
const WAIT_DECLARATION = {
	type: "function",
	name: "wait",
	description: "Waits on a yielded `exec` cell and returns new output or completion.",
	parameters: {
		type: "object",
		properties: { cell_id: { type: "string" } },
		required: ["cell_id"],
		additionalProperties: false,
	},
};
const SPAWN_DECLARATION = {
	type: "function",
	name: "spawn_agent",
	description: "Spawn a subagent.",
	parameters: {
		type: "object",
		properties: { prompt: { type: "string" } },
		required: ["prompt"],
		additionalProperties: false,
	},
};
const LIST_DECLARATION = {
	type: "function",
	name: "list_agents",
	description: "List the running subagents.",
	parameters: { type: "object", properties: {}, additionalProperties: false },
};

/** Codex-profile requests carry the vendor's explicit `strict: false` on every function declaration. */
const strictFalse = <T extends Record<string, unknown>>(decl: T): T => ({ ...decl, strict: false });

function createTestContext(tools: Tool[] = createHarnessTools()): Context {
	return {
		systemPrompt: ["You are Codex, an agent based on GPT-6.", "## Memory\n\nSecond developer block."],
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
		tools,
	};
}

const COMPLETED_EVENTS: Array<Record<string, unknown>> = [
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "Hello" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Hello" }],
		},
	},
	{
		type: "response.completed",
		response: {
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		},
	},
];

const NAMESPACES_INFO = {
	functions: { name: "functions", functions: { eval: { name: "eval", direct: true } } },
};

function dataSse(events: Array<Record<string, unknown>>): Response {
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function decodeCodexRequestBody(body: RequestInit["body"]): string {
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(Bun.zstdDecompressSync(body));
	throw new Error("expected a string or binary Codex request body");
}

interface CapturedRequest {
	body: Record<string, unknown>;
	turnMetadata: Record<string, unknown>;
}

async function captureRequest(
	modelId: string,
	options: Partial<OpenAICodexResponsesOptions> = {},
	tools?: Tool[],
): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	const fetchMock = (async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.endsWith("/responses")) {
			const body = JSON.parse(decodeCodexRequestBody(init?.body)) as Record<string, unknown>;
			const clientMetadata = body.client_metadata as Record<string, unknown> | undefined;
			const encoded = clientMetadata?.["x-codex-turn-metadata"];
			captured = {
				body,
				turnMetadata: typeof encoded === "string" ? (JSON.parse(encoded) as Record<string, unknown>) : {},
			};
		}
		return dataSse(COMPLETED_EVENTS);
	}) as unknown as FetchImpl;

	await streamOpenAICodexResponses(createCodexModel(modelId), createTestContext(tools), {
		apiKey: createCodexTestToken(),
		fetch: fetchMock,
		toolNamespacesInfo: NAMESPACES_INFO,
		...options,
	}).result();

	if (!captured) throw new Error("no /responses request was captured");
	return captured;
}

function runToolCall(call: Record<string, unknown>): Promise<AssistantMessage> {
	const item = { type: "function_call", id: "fc_1", call_id: "call_1", ...call };
	const events: Array<Record<string, unknown>> = [
		{ type: "response.output_item.added", item },
		{ type: "response.output_item.done", item },
		{ type: "response.completed", response: { status: "completed" } },
	];
	return streamOpenAICodexResponses(createCodexModel("gpt-6-astra"), createTestContext(), {
		apiKey: createCodexTestToken(),
		fetch: (async () => dataSse(events)) as unknown as FetchImpl,
	}).result();
}

function runCustomToolCall(call: Record<string, unknown>): Promise<AssistantMessage> {
	const item = { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", ...call };
	const events: Array<Record<string, unknown>> = [
		{ type: "response.output_item.added", item },
		{ type: "response.output_item.done", item: { ...item, status: "completed" } },
		{ type: "response.completed", response: { status: "completed" } },
	];
	return streamOpenAICodexResponses(createCodexModel("gpt-6-astra"), createTestContext(), {
		apiKey: createCodexTestToken(),
		fetch: (async () => dataSse(events)) as unknown as FetchImpl,
	}).result();
}

interface CapturedForkRequest {
	body: Record<string, unknown>;
	headers: Headers;
	turnMetadata: Record<string, unknown>;
	clientMetadata: Record<string, unknown>;
	snapshots: CodexRequestSnapshot[];
}

/**
 * One SSE round trip that also records request headers, the canonical
 * client_metadata envelope, and every emitted request snapshot.
 */
async function captureForkRequest(
	modelId: string,
	options: Partial<OpenAICodexResponsesOptions> = {},
	context: Context = createTestContext(),
	events: Array<Record<string, unknown>> = COMPLETED_EVENTS,
): Promise<CapturedForkRequest> {
	let captured: { body: Record<string, unknown>; headers: Headers } | undefined;
	const snapshots: CodexRequestSnapshot[] = [];
	const fetchMock = (async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.endsWith("/responses")) {
			captured = {
				body: JSON.parse(decodeCodexRequestBody(init?.body)) as Record<string, unknown>,
				headers: new Headers(init?.headers),
			};
		}
		return dataSse(events);
	}) as unknown as FetchImpl;

	await streamOpenAICodexResponses(createCodexModel(modelId), context, {
		apiKey: createCodexTestToken(),
		fetch: fetchMock,
		onCodexRequestSnapshot: snapshot => snapshots.push(snapshot),
		...options,
	}).result();

	if (!captured) throw new Error("no /responses request was captured");
	const clientMetadata = (captured.body.client_metadata ?? {}) as Record<string, unknown>;
	const encoded = clientMetadata["x-codex-turn-metadata"];
	return {
		body: captured.body,
		headers: captured.headers,
		clientMetadata,
		turnMetadata: typeof encoded === "string" ? (JSON.parse(encoded) as Record<string, unknown>) : {},
		snapshots,
	};
}

/** A completed parent request as the snapshot observer would record it. */
function createForkSource(overrides: Partial<CodexRequestSnapshot> = {}): CodexRequestSnapshot {
	return {
		provider: "openai-codex",
		model: "gpt-6-astra",
		baseUrl: "https://api.openai.com/v1",
		accountId: "acc_test",
		sessionId: "root-session",
		threadId: "root-thread-1",
		promptCacheKey: "root-cache-key",
		input: [
			{ type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions" }] },
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: "You are Codex, an agent based on GPT-6." }],
			},
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Say hello" }] },
		],
		...overrides,
	};
}

function createForkContext(messages: Context["messages"]): Context {
	return {
		systemPrompt: ["You are Codex, an agent based on GPT-6.", "## Memory\n\nSecond developer block."],
		messages,
		tools: createHarnessTools(),
	};
}

describe("codex fork lineage", () => {
	it("emits the full sent input and effective identity through onCodexRequestSnapshot", async () => {
		const { body, snapshots } = await captureForkRequest("gpt-6-astra", { sessionId: "child-session" });

		expect(snapshots).toHaveLength(1);
		const snapshot = snapshots[0];
		expect(snapshot.provider).toBe("openai-codex");
		expect(snapshot.model).toBe("gpt-6-astra");
		expect(snapshot.baseUrl).toBe("https://api.openai.com/v1");
		expect(snapshot.accountId).toBe("acc_test");
		expect(snapshot.sessionId).toBe("child-session");
		expect(snapshot.threadId).toBeDefined();
		expect(snapshot.promptCacheKey).toBe(body.prompt_cache_key as string | undefined);
		// The snapshot carries the full wire input — tool surface, developer
		// blocks, and user message — not just the converted messages.
		expect(snapshot.input).toEqual(inputItems(body));
		expect(snapshot.input[0]?.type).toBe("additional_tools");
	});

	it("replays the source input byte-for-byte ahead of the child's own surface", async () => {
		const source = createForkSource();
		const context = createForkContext([
			{ role: "user", content: "Say hello", timestamp: 1 },
			{ role: "user", content: "Summarize it for the parent", timestamp: 2 },
		]);
		const { body, headers, turnMetadata, clientMetadata, snapshots } = await captureForkRequest(
			"gpt-6-astra",
			{ sessionId: "child-session", codexFork: { source, messageCount: 1 } },
			context,
		);

		const input = inputItems(body);
		// Byte-for-byte: the source's serialized items open the request.
		expect(JSON.stringify(input.slice(0, source.input.length))).toBe(JSON.stringify(source.input));
		// Then the child's own tool surface, developer blocks, and only the new
		// tail message — the inherited user message is not re-encoded.
		const tail = input.slice(source.input.length);
		expect(tail[0]?.type).toBe("additional_tools");
		const userItems = tail.filter(item => item.role === "user");
		expect(userItems).toHaveLength(1);
		expect(userItems[0]?.content).toEqual([{ type: "input_text", text: "Summarize it for the parent" }]);

		// Root lineage everywhere the backend groups sessions; child thread stays distinct.
		expect(headers.get("session_id")).toBe("root-session");
		expect(headers.get("session-id")).toBe("root-session");
		expect(headers.get("x-codex-parent-thread-id")).toBe("root-thread-1");
		expect(clientMetadata.session_id).toBe("root-session");
		expect(clientMetadata["x-codex-parent-thread-id"]).toBe("root-thread-1");
		expect(turnMetadata.session_id).toBe("root-session");
		expect(turnMetadata.parent_thread_id).toBe("root-thread-1");
		expect(turnMetadata.forked_from_thread_id).toBe("root-thread-1");
		expect(turnMetadata.thread_id).not.toBe("root-thread-1");

		// Transport identity stays child-local; the source's cache key is inherited.
		expect(headers.get("conversation_id")).toBe("child-session");
		expect(body.prompt_cache_key).toBe("root-cache-key");
		expect(body.previous_response_id).toBeUndefined();

		// The child's own snapshot records the root projection plus the full
		// inherited+new input, ready to seed a grandchild fork.
		expect(snapshots[0]?.sessionId).toBe("root-session");
		expect(snapshots[0]?.threadId).toBe(turnMetadata.thread_id as string);
		expect(snapshots[0]?.input).toEqual(input);
	});

	it("keeps shared root lineage without prefix replay on a different model", async () => {
		const source = createForkSource();
		const context = createForkContext([
			{ role: "user", content: "Say hello", timestamp: 1 },
			{ role: "user", content: "Summarize it for the parent", timestamp: 2 },
		]);
		const { body, turnMetadata, snapshots } = await captureForkRequest(
			"gpt-5.1-codex",
			{ sessionId: "child-session", codexFork: { source, messageCount: 1 } },
			context,
		);

		const input = inputItems(body);
		expect(JSON.stringify(input.slice(0, source.input.length))).not.toBe(JSON.stringify(source.input));
		// Every context message is converted portably; unprofiled turns keep
		// top-level tools and never see the source items.
		expect(body.tools).toBeDefined();
		expect(input.filter(item => item.role === "user")).toHaveLength(2);
		expect(input.some(item => item.type === "additional_tools")).toBe(false);
		expect(turnMetadata.session_id).toBe("root-session");
		expect(turnMetadata.forked_from_thread_id).toBe("root-thread-1");
		expect(body.prompt_cache_key).toBe("root-cache-key");
		expect(snapshots).toHaveLength(0);
	});

	it("ignores the source under a different account and under undefined accounts", async () => {
		const source = createForkSource();
		const context = createForkContext([{ role: "user", content: "Say hello", timestamp: 1 }]);

		const otherAccount = await captureForkRequest(
			"gpt-6-astra",
			{
				apiKey: createCodexTestToken("acc_other"),
				sessionId: "child-session",
				codexFork: { source, messageCount: 0 },
			},
			context,
		);
		expect(otherAccount.turnMetadata.session_id).toBe("child-session");
		expect(otherAccount.turnMetadata.parent_thread_id).toBeUndefined();
		expect(otherAccount.headers.get("session_id")).toBe("child-session");
		expect(otherAccount.body.prompt_cache_key).toBe("child-session");
		expect(JSON.stringify(inputItems(otherAccount.body).slice(0, source.input.length))).not.toBe(
			JSON.stringify(source.input),
		);

		// undefined === undefined is not proof of a shared auth scope.
		const anonymous = await captureForkRequest(
			"gpt-6-astra",
			{
				apiKey: "plain-token",
				sessionId: "child-session",
				codexFork: { source: createForkSource({ accountId: undefined }), messageCount: 0 },
			},
			context,
		);
		expect(anonymous.turnMetadata.session_id).toBe("child-session");
		expect(anonymous.turnMetadata.parent_thread_id).toBeUndefined();
	});

	it("gives sibling forks independent identity with no previous_response_id sharing", async () => {
		const source = createForkSource();
		const providerSessionState = new Map<string, ProviderSessionState>();
		const context = () => createForkContext([{ role: "user", content: "Say hello", timestamp: 1 }]);

		const first = await captureForkRequest(
			"gpt-6-astra",
			{ sessionId: "child-a", providerSessionState, codexFork: { source, messageCount: 0 } },
			context(),
		);
		const second = await captureForkRequest(
			"gpt-6-astra",
			{ sessionId: "child-b", providerSessionState, codexFork: { source, messageCount: 0 } },
			context(),
		);

		// Both project the shared root session but own distinct threads and ids.
		expect(first.turnMetadata.session_id).toBe("root-session");
		expect(second.turnMetadata.session_id).toBe("root-session");
		expect(first.turnMetadata.thread_id).not.toBe(second.turnMetadata.thread_id);
		expect(first.turnMetadata.turn_id).not.toBe(second.turnMetadata.turn_id);
		expect(first.snapshots[0]?.threadId).not.toBe(second.snapshots[0]?.threadId);
		expect(first.body.previous_response_id).toBeUndefined();
		expect(second.body.previous_response_id).toBeUndefined();
		expect(first.body.prompt_cache_key).toBe("root-cache-key");
		expect(second.body.prompt_cache_key).toBe("root-cache-key");
		// With messageCount 0 every context message is still converted after the prefix.
		const firstTail = inputItems(first.body).slice(source.input.length);
		expect(firstTail.filter(item => item.role === "user")).toHaveLength(1);
	});

	it("lets explicit cache options win over the source's cache key", async () => {
		const source = createForkSource();
		const context = createForkContext([{ role: "user", content: "Say hello", timestamp: 1 }]);

		const explicit = await captureForkRequest(
			"gpt-6-astra",
			{ sessionId: "child-session", promptCacheKey: "explicit-key", codexFork: { source, messageCount: 1 } },
			context,
		);
		expect(explicit.body.prompt_cache_key).toBe("explicit-key");

		const disabled = await captureForkRequest(
			"gpt-6-astra",
			{ sessionId: "child-session", cacheRetention: "none", codexFork: { source, messageCount: 1 } },
			context,
		);
		expect(disabled.body.prompt_cache_key).toBeUndefined();
		// Lineage metadata still applies even when caching is off.
		expect(disabled.turnMetadata.session_id).toBe("root-session");
	});

	it("withholds the snapshot for compaction and failed turns", async () => {
		const source = createForkSource();
		const context = createForkContext([{ role: "user", content: "Say hello", timestamp: 1 }]);

		const compacted = await captureForkRequest(
			"gpt-6-astra",
			{
				sessionId: "child-session",
				codexFork: { source, messageCount: 1 },
				codexCompaction: {
					operationId: "op-1",
					trigger: "manual",
					reason: "user_requested",
					implementation: "responses",
					phase: "standalone_turn",
					strategy: "memento",
				},
			},
			context,
		);
		expect(compacted.snapshots).toHaveLength(0);
		// Compaction also disqualifies prefix replay even though ids line up.
		expect(JSON.stringify(inputItems(compacted.body).slice(0, source.input.length))).not.toBe(
			JSON.stringify(source.input),
		);

		// A terminal event reporting a backend error is not a lineage source.
		const failed = await captureForkRequest(
			"gpt-6-astra",
			{ sessionId: "child-session", codexFork: { source, messageCount: 1 } },
			context,
			[
				{
					type: "response.incomplete",
					response: {
						status: "incomplete",
						error: { code: "server_error", message: "upstream exploded" },
						incomplete_details: { reason: "content_filter" },
					},
				},
			],
		);
		expect(failed.snapshots).toHaveLength(0);
	});
});

function inputItems(body: Record<string, unknown>): Array<Record<string, unknown>> {
	return (body.input ?? []) as Array<Record<string, unknown>>;
}

describe("codex harness wire surface", () => {
	it("declares the tool surface as namespaced additional_tools on a codex-profile model", async () => {
		const { body } = await captureRequest("gpt-6-astra");

		expect(body.instructions).toBeUndefined();
		expect(body.tools).toBeUndefined();
		expect(inputItems(body)[0]).toEqual({
			type: "additional_tools",
			role: "developer",
			tools: [
				{
					type: "namespace",
					name: "functions",
					description: "",
					tools: [EXEC_DECLARATION, strictFalse(WAIT_DECLARATION)],
				},
				{
					type: "namespace",
					name: "collaboration",
					description: COLLABORATION_BLURB,
					tools: [strictFalse(SPAWN_DECLARATION), strictFalse(LIST_DECLARATION)],
				},
			],
		});
	});

	it("rides every system block in as developer messages under the profile", async () => {
		const { body } = await captureRequest("gpt-6-astra");
		const items = inputItems(body);

		expect(items.slice(1, 3)).toEqual([
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: "You are Codex, an agent based on GPT-6." }],
			},
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: "## Memory\n\nSecond developer block." }],
			},
		]);
		expect(items[3]?.role).toBe("user");
	});

	it("omits the omp-only tool_namespaces_info snapshot under the profile", async () => {
		const profiled = await captureRequest("gpt-6-astra");
		const unprofiled = await captureRequest("gpt-5.1-codex");
		expect(Object.keys(profiled.turnMetadata).sort()).toEqual(
			Object.keys(unprofiled.turnMetadata)
				.filter(key => key !== "tool_namespaces_info")
				.sort(),
		);
	});

	it("keeps a forced tool choice inside its namespace under Responses Lite", async () => {
		const { body } = await captureRequest("gpt-6-astra", {
			responsesLite: true,
			toolChoice: { type: "tool", name: "spawn_agent" },
		});

		expect(body.tool_choice).toBe("required");
		expect(inputItems(body)[0]?.tools).toEqual([
			{
				type: "namespace",
				name: "collaboration",
				description: COLLABORATION_BLURB,
				tools: [strictFalse(SPAWN_DECLARATION)],
			},
		]);
	});

	it("isolates a forced tool choice on a profiled request without Responses Lite", async () => {
		const { body } = await captureRequest("gpt-6-astra", { toolChoice: { type: "tool", name: "wait" } });

		expect(body.tools).toBeUndefined();
		expect(body.tool_choice).toBe("required");
		expect(inputItems(body)[0]?.tools).toEqual([
			{ type: "namespace", name: "functions", description: "", tools: [strictFalse(WAIT_DECLARATION)] },
		]);
	});

	it("keeps omp's native surface on a codex model with no harness profile", async () => {
		const { body, turnMetadata } = await captureRequest("gpt-5.1-codex");

		expect(body.instructions).toBe("You are Codex, an agent based on GPT-6.");
		expect(body.tools).toEqual([EXEC_DECLARATION, WAIT_DECLARATION, SPAWN_DECLARATION, LIST_DECLARATION]);
		expect(inputItems(body).some(item => item.type === "additional_tools")).toBe(false);
		expect(turnMetadata.tool_namespaces_info).toEqual(NAMESPACES_INFO);
	});

	it("declares a customWireName-only tool under omp's own name off the profile", async () => {
		const renamed: Tool[] = [
			{
				name: "ask",
				customWireName: "request_user_input",
				description: "Ask the user a question.",
				parameters: type({ question: "string" }),
			},
		];
		const declaration = {
			type: "function",
			description: "Ask the user a question.",
			parameters: {
				type: "object",
				properties: { question: { type: "string" } },
				required: ["question"],
				additionalProperties: false,
			},
		};

		const unprofiled = await captureRequest("gpt-5.1-codex", {}, renamed);
		const profiled = await captureRequest("gpt-6-astra", {}, renamed);

		expect(unprofiled.body.tools).toEqual([{ ...declaration, name: "ask" }]);
		expect(inputItems(profiled.body)[0]).toEqual({
			type: "additional_tools",
			role: "developer",
			tools: [
				{
					type: "namespace",
					name: "functions",
					description: "",
					tools: [{ ...strictFalse(declaration), name: "request_user_input" }],
				},
			],
		});
	});

	it("resolves a namespace-qualified tool call back to the declared tool", async () => {
		const result = await runToolCall({
			namespace: "collaboration",
			name: "collaboration__spawn_agent",
			arguments: '{"prompt":"go"}',
		});

		const toolCall = result.content.find(block => block.type === "toolCall");
		expect(toolCall?.name).toBe("spawn_agent");
		expect(toolCall?.arguments).toEqual({ prompt: "go" });
	});

	it("pins the vendor envelope on codex-profile requests: auto tool choice, serial calls, strict false, all_turns", async () => {
		const profiled = await captureRequest("gpt-6-astra", { reasoning: "medium" });
		expect(profiled.body.tool_choice).toBe("auto");
		expect(profiled.body.parallel_tool_calls).toBe(false);
		const reasoning = profiled.body.reasoning as Record<string, unknown> | undefined;
		expect(reasoning?.context).toBe("all_turns");
		// Deliberate delta: omp keeps the summary so thinking stays visible.
		expect(reasoning?.summary).toBe("auto");
		expect(reasoning?.effort).toBe("medium");

		const unprofiled = await captureRequest("gpt-5.1-codex", { reasoning: "medium" });
		expect(unprofiled.body.tool_choice).toBeUndefined();
		expect(unprofiled.body.parallel_tool_calls).toBeUndefined();
		const unprofiledReasoning = unprofiled.body.reasoning as Record<string, unknown> | undefined;
		expect(unprofiledReasoning?.context).toBeUndefined();
	});

	it("leaves an unannotated double-underscore tool name intact", async () => {
		const result = await runToolCall({ name: "mcp__server__read", arguments: "{}" });

		expect(result.content.find(block => block.type === "toolCall")?.name).toBe("mcp__server__read");
	});

	it("replays a namespaced call under the namespace it was declared in", async () => {
		const answered = await runToolCall({
			namespace: "collaboration",
			name: "collaboration__spawn_agent",
			arguments: '{"prompt":"go"}',
		});
		const toolCall = answered.content.find(block => block.type === "toolCall");
		expect(toolCall?.namespace).toBe("collaboration");

		const body = await buildTransformedCodexRequestBody(
			createCodexModel("gpt-5.6-sol"),
			{
				...createTestContext(),
				messages: [
					{ role: "user", content: "spawn a subagent", timestamp: 1 },
					answered,
					{
						role: "toolResult",
						toolCallId: toolCall?.id ?? "",
						toolName: "spawn_agent",
						content: [{ type: "text", text: "spawned" }],
						isError: false,
						timestamp: 2,
					},
				],
			},
			undefined,
		);
		expect(inputItems(body).find(item => item.type === "function_call")).toMatchObject({
			name: "spawn_agent",
			namespace: "collaboration",
		});
	});

	it("decodes the harness wire name back to omp's internal tool name", async () => {
		const result = await runCustomToolCall({ name: "exec", input: "await tool.read({})" });

		const toolCall = result.content.find(block => block.type === "toolCall");
		expect(toolCall?.name).toBe("eval");
		expect(toolCall?.customWireName).toBe("exec");
	});
});

describe("codex TypeScript declaration style", () => {
	const EXEC_COMMAND_ARGS = {
		type: "object",
		properties: {
			cmd: { type: "string", description: "Shell command to execute." },
			prefix_rule: {
				type: "array",
				items: { type: "string" },
				description:
					'Reusable approval prefix for `cmd`, only with `sandbox_permissions: "require_escalated"`; for example ["git", "pull"].',
			},
			sandbox_permissions: {
				type: "string",
				enum: ["use_default", "require_escalated"],
				description:
					"Per-command sandbox override. Defaults to `use_default`; use `require_escalated` for unsandboxed execution.",
			},
			yield_time_ms: {
				type: "number",
				description: "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.",
			},
		},
		required: ["cmd"],
		additionalProperties: false,
	};

	const EXEC_COMMAND_RESULT = {
		type: "object",
		properties: {
			exit_code: {
				type: "integer",
				description: "Process exit code when the command finished during this call.",
			},
			output: { type: "string", description: "Command output text, possibly truncated." },
			wall_time_seconds: {
				type: "number",
				description: "Elapsed wall time spent waiting for output in seconds.",
			},
		},
		required: ["output", "wall_time_seconds"],
		additionalProperties: false,
	};

	it("renders a declaration with // doc comments and a typed result", () => {
		expect(
			jsonSchemaToTypeScript(EXEC_COMMAND_ARGS, {
				style: "codex",
				declarationName: "exec_command",
				resultSchema: EXEC_COMMAND_RESULT,
			}),
		).toBe(
			`exec_command(args: {
  // Shell command to execute.
  cmd: string;
  // Reusable approval prefix for \`cmd\`, only with \`sandbox_permissions: "require_escalated"\`; for example ["git", "pull"].
  prefix_rule?: Array<string>;
  // Per-command sandbox override. Defaults to \`use_default\`; use \`require_escalated\` for unsandboxed execution.
  sandbox_permissions?: "use_default" | "require_escalated";
  // Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.
  yield_time_ms?: number;
}): Promise<{
  // Process exit code when the command finished during this call.
  exit_code?: number;
  // Command output text, possibly truncated.
  output: string;
  // Elapsed wall time spent waiting for output in seconds.
  wall_time_seconds: number;
}>;`,
		);
	});

	it("renders an argument-less declaration as the capture spells it", () => {
		expect(
			jsonSchemaToTypeScript(
				{ type: "object", properties: {}, additionalProperties: false },
				{ style: "codex", declarationName: "get_goal" },
			),
		).toBe("get_goal(args: {}): Promise<unknown>;");
	});

	it("leaves the default and harmony styles untouched", () => {
		const schema = { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } };
		expect(jsonSchemaToTypeScript(schema)).toBe("{\n  tags?: string[];\n}");
		expect(jsonSchemaToTypeScript(schema, { style: "harmony" })).toBe("{\ntags?: string[],\n}");
	});
});
