import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";

// A subagent opts into Fusion through its agent definition (`sidekick: true`), which its
// transcript does not keep. A cold revival must still serve it the sidekick tool.

const LEAD_ID = "Lead";
const MOCK_API_SOURCE = "test/sidekick-revive";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidekick-revive-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

it("cold-revives an opted-in Fusion lead with its sidekick tool on the wire", async () => {
	const cwd = path.join(root, "home", "work");
	await fs.mkdir(path.join(cwd, ".omp", "agents"), { recursive: true });
	await Bun.write(
		path.join(cwd, ".omp", "agents", "lead.md"),
		"---\nname: lead\ndescription: A lead with its own sidekick\nsidekick: true\n---\nLead the work.\n",
	);

	// The lead's transcript as a previous process left it: its contract names the
	// definition, and the sidekick tool it was spawned with.
	const main = SessionManager.create(cwd, path.join(root, "sessions"));
	const mainFile = main.getSessionFile();
	if (!mainFile) throw new Error("Expected a persisted session file");
	main.appendMessage({ role: "user", content: "lead the change", timestamp: Date.now() });
	main.appendMessage(createAssistantMessage("delegated"));
	const leadFile = path.join(mainFile.slice(0, -6), `${LEAD_ID}.jsonl`);
	const lead = await SessionManager.open(leadFile, undefined, undefined, {
		initialCwd: cwd,
		parentSession: mainFile,
		suppressBreadcrumb: true,
	});
	lead.appendSessionInit({
		systemPrompt: ["test"],
		task: "lead the change",
		tools: ["read", "sidekick"],
		agent: "lead",
		resolvedModel: "mock/mock-model",
	});
	lead.appendMessage({ role: "user", content: "lead the change", timestamp: Date.now() });
	lead.appendMessage({ ...createAssistantMessage("planning"), api: "mock", provider: "mock", model: "mock-model" });
	await lead.close();
	AgentRegistry.global().register({
		id: LEAD_ID,
		displayName: LEAD_ID,
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: null,
		sessionFile: leadFile,
		status: "parked",
	});

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const requestedTools: string[][] = [];
	const mock = createMockModel({
		handler: context => {
			requestedTools.push((context.tools ?? []).map(tool => tool.name));
			return { content: ["on it"] };
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const settings = Settings.isolated({
		"fusion.enabled": true,
		"fusion.sidekickModel": "mock/mock-model",
		"task.agentIdleTtlMs": 0,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	const { session: parent } = await createAgentSession({
		cwd,
		authStorage,
		modelRegistry,
		model: mock,
		settings,
		agentRegistry: AgentRegistry.global(),
		agentId: MAIN_AGENT_ID,
		sessionManager: main,
		disableExtensionDiscovery: true,
		preloadedExtensionPaths: [],
		preloadedCustomToolPaths: [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		cacheWarming: false,
		toolNames: ["read"],
		restrictToolNames: true,
	});

	try {
		const ref = AgentRegistry.global().get(LEAD_ID);
		if (!ref) throw new Error("Expected the parked lead");
		const factory = createPersistedSubagentReviverFactory({
			session: parent,
			authStorage,
			modelRegistry,
			settings,
			enableLsp: false,
		});
		const reviver = await factory(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		const revived = localSession(await reviver(ref));
		await revived.prompt("Continue.");
		await revived.waitForIdle();

		expect(requestedTools.at(-1)).toContain("sidekick");
	} finally {
		await parent.dispose();
		authStorage.close();
	}
}, 20_000);
