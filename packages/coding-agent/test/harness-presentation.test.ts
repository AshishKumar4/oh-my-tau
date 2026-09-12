import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const FABLE = getBundledModel<"anthropic-messages">("anthropic", "claude-fable-5-1");
const ASTRA = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-6-astra");

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

describe("harness surface as the provider request sees it", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-present-smoke-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		authStorage.setRuntimeApiKey("openai-codex", "openai-codex-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("carries each model's own wire identity across an automatic mid-turn fallback", async () => {
		const tools = [tool("bash"), tool("read"), tool("task"), tool("hub"), tool("eval")];
		const requests: Array<{
			model: string;
			names: string[];
			wire: Array<string | undefined>;
			namespaces: Array<string | undefined>;
		}> = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: FABLE, systemPrompt: [], tools, messages: [] },
			streamFn: (model, context, options) => {
				requests.push({
					model: `${model.provider}/${model.id}`,
					names: context.tools?.map(t => t.name) ?? [],
					wire: context.tools?.map(t => t.customWireName) ?? [],
					namespaces: context.tools?.map(t => t.namespace?.name) ?? [],
				});
				if (model.provider === FABLE.provider && model.id === FABLE.id) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else {
					mock.push({ content: [`ok:${model.provider}/${model.id}`] });
				}
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": { default: [`${ASTRA.provider}/${ASTRA.id}`] },
		});
		settings.setModelRole("default", `${FABLE.provider}/${FABLE.id}`);
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
		await session.prompt("list the repo");
		await session.waitForIdle();
		expect(requests.map(r => r.model)).toEqual([`${FABLE.provider}/${FABLE.id}`, `${ASTRA.provider}/${ASTRA.id}`]);
		const [claudeCode, codex] = requests;
		expect(claudeCode?.wire).toContain("Bash");
		expect(claudeCode?.names).toContain("Agent");
		expect(claudeCode?.names).not.toContain("task");
		expect(codex?.wire).not.toContain("Bash");
		expect(codex?.wire).toContain("exec");
		expect(codex?.names).toContain("spawn_agent");
		expect(codex?.names).not.toContain("task");
		// `collaboration` is reserved server-side for Codex's own functions; natives stay in the default namespace.
		expect(codex?.namespaces[codex.names.indexOf("hub")]).toBeUndefined();
		expect(codex?.namespaces[codex.names.indexOf("spawn_agent")]).toBe("collaboration");
		// The identity lives on the presented copies only; the shared registry tools keep their own.
		for (const t of tools) expect(t.customWireName).toBeUndefined();
		await session.dispose();
	});
});
