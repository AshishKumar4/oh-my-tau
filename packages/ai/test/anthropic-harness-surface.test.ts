import { describe, expect, it } from "bun:test";
import { claudeCodeSystemInstruction } from "@oh-my-pi/pi-ai/providers/claude-code-fingerprint";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	Message,
	Model,
	Tool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { withEnv } from "./helpers";
import {
	anthropicDeclarations,
	anthropicFraming,
	anthropicReplayedToolCalls,
	anthropicReplayedToolNames,
	anthropicTurnFetch,
	captureAnthropicTurn,
	declaredNames,
} from "./helpers/harness-golden";

const harnessModel = getBundledModel<"anthropic-messages">("anthropic", "claude-opus-5");
const plainModel = getBundledModel<"anthropic-messages">("anthropic", "claude-sonnet-4-5");

const commandSchema = {
	type: "object",
	properties: { command: { type: "string" } },
	required: ["command"],
};
const pathSchema = {
	type: "object",
	properties: { path: { type: "string" } },
	required: ["path"],
};

const TOOLS: Tool[] = [
	{ name: "bash", customWireName: "Bash", description: "Run a shell command", parameters: commandSchema },
	{ name: "read", customWireName: "Read", description: "Read a file", parameters: pathSchema },
	{ name: "mcp__gh__list_prs", description: "List pull requests", parameters: pathSchema },
];

const UNALIASED_TOOLS: Tool[] = [
	{ name: "bash", description: "Run a shell command", parameters: commandSchema },
	{ name: "read", description: "Read a file", parameters: pathSchema },
	{ name: "mcp__gh__list_prs", description: "List pull requests", parameters: pathSchema },
];

const USER: UserMessage = { role: "user", content: "list the repo", timestamp: 1 };

function priorToolCall(): Message[] {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "toolu_prior", name: "bash", arguments: { command: "ls" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5",
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
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "toolu_prior",
		toolName: "bash",
		content: [{ type: "text", text: "README.md" }],
		isError: false,
		timestamp: 3,
	};
	return [USER, assistant, toolResult, { role: "user", content: "now read it", timestamp: 4 }];
}

const SEND_MESSAGE: Tool = {
	name: "SendMessage",
	description: "Send a message",
	parameters: { type: "object", properties: { to: { type: "string" } } },
};

const WEB_FETCH: Tool = {
	name: "WebFetch",
	description: "Fetch a URL",
	parameters: { type: "object", properties: { url: { type: "string" } } },
};

function facadeHistory(call: Omit<ToolCall, "type" | "id">): Message[] {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "toolu_facade", ...call }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5",
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
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "toolu_facade",
		toolName: call.name,
		content: [{ type: "text", text: "delivered" }],
		isError: false,
		timestamp: 3,
	};
	return [USER, assistant, toolResult, { role: "user", content: "next", timestamp: 4 }];
}

function runTurn(
	model: Model<"anthropic-messages">,
	wireToolName: string,
	options: { messages?: Message[]; forceTool?: string; tools?: Tool[] } = {},
): Promise<{ payload: Record<string, unknown>; result: AssistantMessage }> {
	const context: Context = { messages: options.messages ?? [USER], tools: options.tools ?? TOOLS };
	return captureAnthropicTurn(model, context, {
		fetch: anthropicTurnFetch(wireToolName),
		...(options.forceTool ? { toolChoice: { type: "tool" as const, name: options.forceTool } } : {}),
	});
}

const OMP_IDENTITY = [claudeCodeSystemInstruction] as const;

async function cachedSystemSlots(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
): Promise<string[]> {
	const context: Context = { systemPrompt: ["You are omp, a coding agent."], messages: [USER], tools: TOOLS };
	let slots: string[] = [];
	await withEnv({ PI_CACHE_RETENTION: undefined }, async () => {
		const { payload } = await captureAnthropicTurn(model, context, {
			fetch: anthropicTurnFetch(),
			...(cacheRetention && { cacheRetention }),
		});
		slots = anthropicFraming(payload, OMP_IDENTITY).cachedSystemSlots;
	});
	return slots;
}

describe("anthropic claude-code harness surface", () => {
	it("declares harness-native tool names verbatim and maps the call back to the internal name", async () => {
		const { payload, result } = await runTurn(harnessModel, "Bash");

		expect(declaredNames(anthropicDeclarations(payload))).toEqual(["Bash", "Read", "mcp__gh__list_prs"]);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content.filter(block => block.type === "toolCall").map(block => block.name)).toEqual(["bash"]);
	});

	it("encodes forced tool choice and replayed tool calls with the harness names", async () => {
		const { payload } = await runTurn(harnessModel, "Bash", { messages: priorToolCall(), forceTool: "bash" });

		expect(payload.tool_choice).toEqual({ type: "tool", name: "Bash" });
		expect(anthropicReplayedToolNames(payload)).toEqual(["Bash"]);
	});

	it("replays the omp identity with native arguments once the facade is gone", async () => {
		const history = facadeHistory({
			name: "write",
			wireName: "SendMessage",
			arguments: { to: "Main", message: "hi", summary: "hi" },
			nativeArguments: { path: "agent://Main", content: "hi" },
		});
		const profiled = await runTurn(harnessModel, "Bash", { messages: history, tools: [...TOOLS, SEND_MESSAGE] });
		expect(anthropicReplayedToolCalls(profiled.payload)).toEqual([
			{ name: "SendMessage", input: { to: "Main", message: "hi", summary: "hi" } },
		]);
		const switched = await runTurn(plainModel, "Bash", { messages: history });
		expect(declaredNames(anthropicDeclarations(switched.payload))).not.toContain("SendMessage");
		expect(anthropicReplayedToolCalls(switched.payload)).toEqual([
			{ name: "_write", input: { path: "agent://Main", content: "hi" } },
		]);
	});

	it("keeps a facade's own name over its target's active alias while the profile is active", async () => {
		const history = facadeHistory({
			name: "read",
			wireName: "WebFetch",
			arguments: { url: "https://example.com", prompt: "summarize" },
			nativeArguments: { path: "https://example.com" },
		});
		const profiled = await runTurn(harnessModel, "Bash", { messages: history, tools: [...TOOLS, WEB_FETCH] });
		expect(anthropicReplayedToolCalls(profiled.payload)).toEqual([
			{ name: "WebFetch", input: { url: "https://example.com", prompt: "summarize" } },
		]);
		const switched = await runTurn(plainModel, "Bash", { messages: history });
		expect(anthropicReplayedToolCalls(switched.payload)).toEqual([
			{ name: "_read", input: { path: "https://example.com" } },
		]);
	});

	it("replays history persisted without native arguments exactly as before", async () => {
		// Builds before native arguments persisted this facade call under the since-removed `hub` tool.
		const history = facadeHistory({
			name: "hub",
			wireName: "SendMessage",
			arguments: { to: "Main", message: "hi" },
		});
		const profiled = await runTurn(harnessModel, "Bash", { messages: history, tools: [...TOOLS, SEND_MESSAGE] });
		expect(anthropicReplayedToolCalls(profiled.payload)).toEqual([
			{ name: "SendMessage", input: { to: "Main", message: "hi" } },
		]);
		const switched = await runTurn(plainModel, "Bash", { messages: history });
		expect(anthropicReplayedToolCalls(switched.payload)).toEqual([
			{ name: "_hub", input: { to: "Main", message: "hi" } },
		]);
	});

	it("keeps the transport prefix when the tool list supplies no harness-native name", async () => {
		const { payload, result } = await runTurn(harnessModel, "_bash", { tools: UNALIASED_TOOLS });

		expect(declaredNames(anthropicDeclarations(payload))).toEqual(["_bash", "_read", "_mcp__gh__list_prs"]);
		expect(result.content.filter(block => block.type === "toolCall").map(block => block.name)).toEqual(["bash"]);
	});

	it("anchors the identity block and the last system block at 1h by default", async () => {
		expect(await cachedSystemSlots(harnessModel)).toEqual(["identity:ephemeral/1h", "prompt-last:ephemeral/1h"]);
	});

	it("lets an explicit short retention win over the profile", async () => {
		expect(await cachedSystemSlots(harnessModel, "short")).toEqual(["identity:ephemeral", "prompt-last:ephemeral"]);
	});
});

describe("anthropic OAuth surface without a harness profile", () => {
	it("still prefixes the same tool set and strips the prefix on the way back", async () => {
		const { payload, result } = await runTurn(plainModel, "_bash");

		expect(declaredNames(anthropicDeclarations(payload))).toEqual(["_bash", "_read", "_mcp__gh__list_prs"]);
		expect(result.content.filter(block => block.type === "toolCall").map(block => block.name)).toEqual(["bash"]);
	});

	it("still prefixes forced tool choice and replayed tool calls", async () => {
		const { payload } = await runTurn(plainModel, "_bash", { messages: priorToolCall(), forceTool: "bash" });

		expect(payload.tool_choice).toEqual({ type: "tool", name: "_bash" });
		expect(anthropicReplayedToolNames(payload)).toEqual(["_bash"]);
	});

	it("still anchors only the identity block", async () => {
		expect(await cachedSystemSlots(plainModel)).toEqual(["identity:ephemeral/1h"]);
		expect(await cachedSystemSlots(plainModel, "short")).toEqual(["identity:ephemeral"]);
	});
});
