/**
 * `omp --restore` end to end for a subagent, through `/recover`'s implementation:
 * a transcript a crash cut off mid tool call is revived from disk, the cut-off call
 * gets an interruption result instead of running again, the agent answers the
 * resume message, and the parent receives the answer as the subagent's job.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	createSessionOpenData,
	INTERRUPTED_TOOL_RESULT_TEXT,
	SESSION_OPEN_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const AGENT_ID = "Restored";
const MOCK_API_SOURCE = "test/restore-revive";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;
let manager: AsyncJobManager;

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
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-restore-revive-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	manager = new AsyncJobManager({ maxRunningJobs: 4 });
	AsyncJobManager.setInstance(manager);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	AsyncJobManager.setInstance(undefined);
	await manager.dispose({ timeoutMs: 1_000 });
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

it("revives a subagent a crash cut off mid tool call, does not run the call again, and delivers its answer to the parent", async () => {
	const cwd = path.join(root, "home", "work");
	await fs.mkdir(cwd, { recursive: true });
	const notes = path.join(cwd, "notes.txt");
	await Bun.write(notes, "the answer is 42\n");

	// The main session and its subagent's transcript, as the process left them when it died
	// inside the subagent's `read` call: no tool result, no exit record.
	const main = SessionManager.create(cwd, path.join(root, "sessions"));
	const mainFile = main.getSessionFile();
	if (!mainFile) throw new Error("Expected a persisted session file");
	main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
	main.appendMessage({
		...createAssistantMessage(""),
		content: [{ type: "toolCall", id: "spawn", name: "task", arguments: { tasks: [] } }],
		stopReason: "toolUse",
	});
	main.appendMessage({
		role: "toolResult",
		toolCallId: "spawn",
		toolName: "task",
		content: [{ type: "text", text: "spawned" }],
		isError: false,
		details: {
			async: { state: "running", jobId: AGENT_ID, type: "task" },
			progress: [{ id: AGENT_ID, status: "running", description: "report notes.txt" }],
		},
		timestamp: Date.now(),
	});
	main.appendMessage(createAssistantMessage("waiting on the subagent"));
	const childFile = path.join(mainFile.slice(0, -6), `${AGENT_ID}.jsonl`);
	const child = await SessionManager.open(childFile, undefined, undefined, {
		initialCwd: cwd,
		parentSession: mainFile,
		suppressBreadcrumb: true,
	});
	child.appendSessionInit({
		systemPrompt: ["test"],
		task: "report what notes.txt says",
		tools: ["read"],
		agent: "task",
		resolvedModel: "mock/mock-model",
	});
	child.appendMessage({ role: "user", content: "report what notes.txt says", timestamp: Date.now() });
	child.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: notes } }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	await child.close();
	AgentRegistry.global().register({
		id: AGENT_ID,
		displayName: AGENT_ID,
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: null,
		sessionFile: childFile,
		status: "parked",
	});
	// This process opened the session after the crash.
	main.appendCustomEntry(SESSION_OPEN_CUSTOM_TYPE, createSessionOpenData());

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const readResults: string[] = [];
	const mock = createMockModel({
		handler: context => {
			for (const message of context.messages) {
				if (message.role === "toolResult" && message.toolName === "read")
					readResults.push(JSON.stringify(message.content));
			}
			const last = context.messages.at(-1);
			if (last?.role !== "user") return { content: ["label"] };
			return { content: ["restored: the read was interrupted"] };
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	const bus = new EventBus();
	const session = {
		sessionManager: main,
		asyncJobManager: manager,
		settings,
		eventBus: bus,
		subagentEventBus: bus,
		agent: { replaceMessages: () => {} },
		buildDisplaySessionContext: () => main.buildSessionContext(),
		getAgentId: () => MAIN_AGENT_ID,
		sendCustomMessage: async () => true,
		effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
		preparedExtensions: undefined,
	} as unknown as AgentSession;
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		createPersistedSubagentReviverFactory({ session, authStorage, modelRegistry, settings, enableLsp: false }),
		() => 0,
	);
	const delivered = Promise.withResolvers<string>();
	manager.registerDeliverySink(MAIN_AGENT_ID, (_jobId, text) => {
		delivered.resolve(text);
	});

	try {
		const outcome = await restoreSession(session);
		expect(outcome.subagents).toEqual([AGENT_ID]);

		expect(await delivered.promise).toContain("restored: the read was interrupted");
		// The cut-off read was answered by its interruption result, never re-run.
		expect(readResults.length).toBeGreaterThan(0);
		expect(readResults.every(result => result.includes(INTERRUPTED_TOOL_RESULT_TEXT))).toBe(true);
		expect(readResults.some(result => result.includes("the answer is 42"))).toBe(false);
	} finally {
		authStorage.close();
		await main.close();
	}
}, 20_000);
