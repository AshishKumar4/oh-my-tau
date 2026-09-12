import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import {
	buildTransformedCodexRequestBody,
	type OpenAICodexResponsesOptions,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { AssistantMessage, Context, FetchImpl, Tool } from "@oh-my-pi/pi-ai/types";
import { jsonSchemaToTypeScript } from "@oh-my-pi/pi-ai/utils/schema/typescript";
import { createCodexModel } from "./helpers";
import { loadEvalToolCodexExecFormat } from "./helpers/harness-golden";

function createCodexTestToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
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
