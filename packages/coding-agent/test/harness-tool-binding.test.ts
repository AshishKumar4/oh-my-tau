import { afterEach, describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

function anthropicModel(id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

function codexModel(id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 100_000,
	});
}

const CLAUDE_CODE_MODEL = anthropicModel("claude-opus-5");
const CODEX_MODEL = codexModel("gpt-6-astra");
const NATIVE_MODEL = anthropicModel("claude-sonnet-4-5");

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}

function createTools(): AgentTool[] {
	return [
		tool("bash"),
		tool("grep"),
		tool("read"),
		tool("task"),
		tool("hub"),
		tool("eval"),
		{
			...tool("edit"),
			get customWireName(): string {
				return "apply_patch";
			},
		},
	];
}

const sessions: AgentSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
});

function createSession(model: Model): AgentSession {
	const tools = createTools();
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: [], tools } }),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: {
			getApiKey: async () => "test-key",
			hasConfiguredAuth: () => true,
			refreshSelectedModelMetadata: async (value: Model) => value,
			clearSuppressedSelector: () => undefined,
		} as never,
		toolRegistry: new Map(tools.map(value => [value.name, value])),
		builtInToolNames: tools.map(value => value.name),
		rebuildSystemPrompt: async names => ({ systemPrompt: [`tools:${names.join(",")}`] }),
	});
	sessions.push(session);
	return session;
}

function presented(session: AgentSession, name: string): { wireName?: string; namespace?: string; persistAs?: string } {
	const found = session.agent.state.tools.find(value => value.name === name);
	if (!found) throw new Error(`${name} is not on the model-visible surface`);
	return { wireName: found.customWireName, namespace: found.namespace?.name, persistAs: found.persistAs };
}

describe("harness tool binding through the session surface", () => {
	test("a claude-code model presents Claude Code's names, and only for tools it declares", () => {
		const session = createSession(CLAUDE_CODE_MODEL);

		expect(presented(session, "bash").wireName).toBe("Bash");
		expect(presented(session, "read").wireName).toBe("Read");
		// Delegation is a facade from the first request: `Agent` stands in for `task`.
		expect(session.agent.state.tools.some(value => value.name === "task")).toBe(false);
		expect(presented(session, "Agent").persistAs).toBe("task");
		expect(presented(session, "grep").wireName).toBeUndefined();
		expect(presented(session, "bash").namespace).toBeUndefined();
	});

	test("a codex model keeps natives out of the reserved collaboration namespace and renames only its own bridge", () => {
		const session = createSession(CODEX_MODEL);

		expect(presented(session, "spawn_agent")).toMatchObject({ namespace: "agents", persistAs: "task" });
		expect(presented(session, "hub").namespace).toBeUndefined();
		expect(presented(session, "read").namespace).toBeUndefined();
		expect(presented(session, "eval").wireName).toBe("exec");
		expect(presented(session, "bash").wireName).toBeUndefined();
		expect(presented(session, "read").wireName).toBeUndefined();
	});

	test("a tool the manifest omits keeps the wire name it claims for itself", async () => {
		const session = createSession(CODEX_MODEL);
		expect(presented(session, "edit").wireName).toBe("apply_patch");

		await session.setModel(CLAUDE_CODE_MODEL);
		expect(presented(session, "edit").wireName).toBe("Edit");
	});

	test("a mid-session model change moves the surface with it, with no rebuild in between", async () => {
		const session = createSession(CLAUDE_CODE_MODEL);
		expect(presented(session, "Agent")).toEqual({ wireName: undefined, namespace: undefined, persistAs: "task" });
		expect(presented(session, "bash").wireName).toBe("Bash");

		await session.setModel(CODEX_MODEL);

		expect(session.agent.state.tools.some(value => value.name === "task")).toBe(false);
		expect(presented(session, "spawn_agent")).toEqual({
			wireName: undefined,
			namespace: "agents",
			persistAs: "task",
		});
		expect(presented(session, "bash").wireName).toBeUndefined();
		expect(presented(session, "eval").wireName).toBe("exec");
	});

	test("a model with no harness profile presents omp's own surface", async () => {
		const session = createSession(CLAUDE_CODE_MODEL);
		expect(presented(session, "bash").wireName).toBe("Bash");

		await session.setModel(NATIVE_MODEL);

		for (const { name } of session.agent.state.tools) {
			const expected = name === "edit" ? "apply_patch" : undefined;
			expect(presented(session, name)).toEqual({ wireName: expected, namespace: undefined });
		}
	});
});
