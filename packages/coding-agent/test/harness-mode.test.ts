import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// Fable/Opus are claude-code-profiled; Astra is codex-profiled; Muse is unprofiled.
const FABLE = getBundledModel<"anthropic-messages">("anthropic", "claude-fable-5-1");
const MUSE = getBundledModel<"openai-responses">("opencode-zen", "muse-spark-1.3-contributor-free");

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

describe("harness.mode (persisted, model/Prompt, default auto)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-harness-mode-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		authStorage.setRuntimeApiKey("opencode-zen", "opencode-zen-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	async function makeSession(settings: Settings, model: Model) {
		const tools = [tool("bash"), tool("read"), tool("task"), tool("hub"), tool("eval")];
		const requests: Array<{ model: string; names: string[]; wire: Array<string | undefined> }> = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: m => `${m.provider}-test-key`,
			initialState: { model, systemPrompt: [], tools, messages: [] },
			streamFn: (m, context) => {
				requests.push({
					model: `${m.provider}/${m.id}`,
					names: context.tools?.map(t => t.name) ?? [],
					wire: context.tools?.map(t => t.customWireName) ?? [],
				});
				mock.push({ content: ["ok"] });
				return mock.stream(m, context);
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			toolRegistry: new Map(tools.map(t => [t.name, t])),
			builtInToolNames: tools.map(t => t.name),
			rebuildSystemPrompt: async names => ({ systemPrompt: [`tools:${names.join(",")}`] }),
		});
		await session.setActiveToolsByName(tools.map(t => t.name));
		return { session, requests, tools };
	}

	it("auto (the default) follows the model's catalog profile byte for byte", async () => {
		const settings = Settings.isolated({});
		const { session, requests } = await makeSession(settings, FABLE);
		await session.prompt("hi");
		await session.waitForIdle();
		expect(requests[0]?.wire).toContain("Bash");
		expect(requests[0]?.names).toContain("Agent");
		await session.dispose();
	});

	it("native forces undefined on a profiled model: no renames, no facades", async () => {
		const settings = Settings.isolated({ "harness.mode": "native" });
		const { session, requests } = await makeSession(settings, FABLE);
		await session.prompt("hi");
		await session.waitForIdle();
		const request = requests[0];
		expect(request?.wire.every(name => name === undefined)).toBe(true);
		expect(request?.names).toContain("task");
		expect(request?.names).not.toContain("Agent");
		await session.dispose();
	});

	it("a forced profile applies renames and facades to an unprofiled model", async () => {
		const settings = Settings.isolated({ "harness.mode": "claude-code" });
		const { session, requests } = await makeSession(settings, MUSE);
		await session.prompt("hi");
		await session.waitForIdle();
		const request = requests[0];
		expect(request?.wire).toContain("Bash");
		expect(request?.names).toContain("Agent");
		expect(request?.names).not.toContain("task");
		await session.dispose();
	});

	it("toggling the mode mid-session re-applies the surface without a restart", async () => {
		const settings = Settings.isolated({});
		const { session, requests } = await makeSession(settings, FABLE);
		await session.prompt("hi");
		await session.waitForIdle();
		expect(requests[0]?.wire).toContain("Bash");

		settings.override("harness.mode", "native");
		await session.prompt("again");
		await session.waitForIdle();
		expect(requests[1]?.wire.every(name => name === undefined)).toBe(true);
		expect(requests[1]?.names).toContain("task");

		settings.override("harness.mode", "claude-code");
		await session.prompt("third");
		await session.waitForIdle();
		expect(requests[2]?.wire).toContain("Bash");
		expect(requests[2]?.names).toContain("Agent");

		settings.clearOverride("harness.mode");
		await session.dispose();
	});

	it("persists through the config file path", async () => {
		const configDir = await fs.mkdtemp(path.join(path.dirname(tempDir.path()), "harness-cfg-"));
		const configPath = path.join(configDir, "config.yml");
		await fs.writeFile(configPath, 'harness:\n  mode: "codex"\n');
		const loaded = await Settings.loadIsolated({ configFiles: [configPath], agentDir: configDir });
		expect(loaded.get("harness.mode")).toBe("codex");
		await fs.rm(configDir, { recursive: true, force: true });
	});
});
