import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const REMINDER_TYPE = "fusion-direct-edit-reminder";

const EXPERT: AgentDefinition = {
	name: "expert",
	description: "Expert lane",
	systemPrompt: "Lead.",
	source: "project",
};

function stubTool(name: string): AgentTool {
	const schema = type({});
	const tool: AgentTool<typeof schema, undefined> = {
		name,
		label: name,
		description: `${name} tool`,
		parameters: schema,
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	};
	return tool as AgentTool;
}

function toolCalls(...names: string[]): MockResponse {
	return {
		content: names.map((name, index) => ({ type: "toolCall", id: `${name}-${index}`, name, arguments: {} })),
		stopReason: "toolUse",
	};
}

describe("fusion lead session", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-fusion-lead-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function modelOrThrow(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected bundled model ${id}`);
		return model;
	}

	async function runLead(options: {
		fusion: boolean;
		/** Subagent identity, as the executor passes it: depth 1 under the given agent definition. */
		subagent?: AgentDefinition;
	}): Promise<number> {
		const tools = [stubTool("edit"), stubTool("read"), ...(options.fusion ? [stubTool("sidekick")] : [])];
		// Turn 1 edits twice in one step (one reminder), turn 2 reads (none), turn 3 edits again (second reminder).
		const mock = createMockModel({
			responses: [
				toolCalls("edit", "edit"),
				toolCalls("read"),
				toolCalls("edit"),
				{ content: ["done"] },
				{ content: ["ok"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: modelOrThrow("claude-sonnet-4-5"),
				systemPrompt: ["Test"],
				tools,
				messages: [],
				thinkingLevel: Effort.Medium,
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "fusion.enabled": options.fusion }),
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			...(options.subagent && { agentKind: "sub", taskDepth: 1, agentDefinition: options.subagent }),
		});
		await session.prompt("change things");
		// Reminders are delivered next turn; a second prompt lands them.
		await session.prompt("and then?");
		return session.sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom_message" && entry.customType === REMINDER_TYPE).length;
	}

	it("nudges a fusion lead once per turn after a direct edit: the top-level session and an opted-in subagent, never a plain subagent or outside fusion", async () => {
		expect(await runLead({ fusion: true })).toBe(2);
		expect(await runLead({ fusion: false })).toBe(0);
		expect(await runLead({ fusion: true, subagent: { ...EXPERT, sidekick: true } })).toBe(2);
		expect(await runLead({ fusion: true, subagent: EXPERT })).toBe(0);
	});

	it("/fusion toggles the setting and remounts through the session", async () => {
		const settings = Settings.isolated();
		const applyFusionMode = vi.fn(async () => settings.get("fusion.enabled"));
		const output: string[] = [];
		const runtime = {
			session: {
				settings,
				modelRegistry,
				model: modelOrThrow("claude-sonnet-4-5"),
				getAgentId: () => "Main",
				scopedModels: [],
				applyFusionMode,
			},
			settings,
			output: (text: string) => {
				output.push(text);
			},
		} as unknown as SlashCommandRuntime;

		expect(await executeAcpBuiltinSlashCommand("/fusion", runtime)).toEqual({ consumed: true });
		expect(settings.get("fusion.enabled")).toBe(true);
		expect(applyFusionMode).toHaveBeenCalledTimes(1);
		expect(output.at(-1)).toContain("Fusion mode enabled");

		await executeAcpBuiltinSlashCommand("/fusion anthropic/claude-sonnet-4-6:high", runtime);
		expect(settings.get("fusion.sidekickModel")).toBe("anthropic/claude-sonnet-4-6");
		expect(settings.get("fusion.sidekickThinking")).toBe(Effort.High);
		expect(applyFusionMode).toHaveBeenCalledTimes(2);

		await executeAcpBuiltinSlashCommand("/fusion off", runtime);
		expect(settings.get("fusion.enabled")).toBe(false);
		expect(applyFusionMode).toHaveBeenCalledTimes(3);
		expect(output.at(-1)).toBe("Fusion mode disabled.");

		await executeAcpBuiltinSlashCommand("/fusion status", runtime);
		expect(applyFusionMode).toHaveBeenCalledTimes(3);
		expect(output.at(-1)).toContain("Fusion: disabled");
		expect(output.at(-1)).toContain("sidekick: anthropic/claude-sonnet-4-6 · thinking high");
		expect(output.at(-1)).toContain("sidekick agent: not spawned");
	});

	it("/fusion status lists every live sidekick with its owning lead", async () => {
		const settings = Settings.isolated();
		const runtime = {
			session: { settings, modelRegistry, model: modelOrThrow("claude-sonnet-4-5"), getAgentId: () => "Main" },
			settings,
			output: (text: string) => {
				output.push(text);
			},
		} as unknown as SlashCommandRuntime;
		const output: string[] = [];
		const registry = AgentRegistry.global();
		const refs = [
			{ id: "Sidekick", parentId: "Main", status: "idle" as const },
			{ id: "Expert:Sidekick", parentId: "Expert", status: "running" as const },
			{ id: "Sidekick-old", parentId: "Main", status: "aborted" as const },
		];
		for (const ref of refs) registry.register({ ...ref, displayName: "sidekick", kind: "sub", session: null });
		try {
			await executeAcpBuiltinSlashCommand("/fusion status", runtime);
		} finally {
			for (const ref of refs) registry.unregister(ref.id);
		}
		expect(output.at(-1)).toContain(
			"sidekick agents: Sidekick (top-level, idle, usage unavailable), Expert:Sidekick (Expert, running, usage unavailable)",
		);
		expect(output.at(-1)).not.toContain("Sidekick-old");
	});
});
