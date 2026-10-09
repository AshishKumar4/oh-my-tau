import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resetCapabilityForTests } from "@oh-my-pi/pi-coding-agent/capability";
import { runCleanse } from "@oh-my-pi/pi-coding-agent/cleanse/index";
import CleanseCommand from "@oh-my-pi/pi-coding-agent/commands/cleanse";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspDaemon from "@oh-my-pi/pi-coding-agent/lsp/mux/daemon";
import { cfgLspShared } from "@oh-my-pi/pi-coding-agent/lsp/settings";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as structuredSubagent from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { createCleanseStatusBoard } from "@oh-my-pi/pi-tui/apps/cleanse-board";
import * as dirs from "@oh-my-pi/pi-utils/dirs";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";

const modelSpec: ModelSpec<Api> = {
	id: "shared-lsp-binding",
	name: "Shared LSP binding",
	api: "test-shared-lsp-binding",
	provider: "managed-primary",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 1024,
};
const model = buildModel(modelSpec);

async function failureOf<T>(run: Promise<T>): Promise<Error | undefined> {
	try {
		await run;
		return undefined;
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
}

// The shared-LSP flag is process-global and read on every client cold start;
// subagent and helper sessions must not switch it off for the parent.
describe("shared LSP flag with subagents and helper sessions", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			if (!session.isDisposed) await session.dispose();
		}
		vi.restoreAllMocks();
		await lspClient.shutdownAll();
		lspClient.setSharedLspEnabled(false);
		resetCapabilityForTests();
	});

	const starter = async (tempDir: TempDir) => {
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const start = async (
			settings: Settings,
			extra: Pick<
				CreateAgentSessionOptions,
				"parentTaskPrefix" | "taskDepth" | "agentId" | "bindProcessState" | "enableLsp"
			> = {},
		): Promise<AgentSession> => {
			const { session } = await sdk.createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry,
				settings,
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				...extra,
			});
			sessions.push(session);
			return session;
		};
		return { start, authStorage, close: () => authStorage.close() };
	};

	function cleanseFixture(tempDir: TempDir, authStorage: AuthStorage) {
		authStorage.keys.setRuntime("openai", "test-key");
		const diskSettings = Settings.isolated({ "compaction.enabled": false, "lsp.shared": true });
		vi.spyOn(Settings, "init").mockResolvedValue(diskSettings);
		vi.spyOn(sdk, "discoverAuthStorage").mockResolvedValue(authStorage);
		vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
		vi.spyOn(dirs, "getProjectDir").mockReturnValue(tempDir.path());
		const journal = SessionManager.create(tempDir.path(), tempDir.join("cleanse-sessions"));
		vi.spyOn(SessionManager, "create").mockReturnValue(journal);
		const sharedPath = new Error("shared transport selected");
		const privatePath = new Error("private transport selected");
		vi.spyOn(lspDaemon, "connectSharedLspTransport").mockRejectedValue(sharedPath);
		vi.spyOn(ptree, "spawn").mockImplementation(() => {
			throw privatePath;
		});
		let coldStart = 0;
		const nextClient = () =>
			lspClient.getOrCreateClient(
				{ command: `cleanse-ownership-${coldStart++}`, fileTypes: ["ts"], rootMarkers: [] },
				tempDir.path(),
			);
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const stopped = new Error("mock discovery transport stopped");
		vi.spyOn(structuredSubagent, "runStructuredSubagent").mockImplementation(async () => {
			entered.resolve();
			await finish.promise;
			throw stopped;
		});
		return { sharedPath, privatePath, nextClient, entered, finish, stopped };
	}

	it("an in-process cleanse runtime preserves the parent's live policy during its run and close", async () => {
		using tempDir = TempDir.createSync("@pi-cleanse-lsp-parent-");
		const { start, authStorage, close } = await starter(tempDir);
		const parent = Settings.isolated({ "compaction.enabled": false, "lsp.shared": true });
		await start(parent, { enableLsp: true });
		cfgLspShared.override(parent, false);
		await Promise.resolve();
		const fixture = cleanseFixture(tempDir, authStorage);
		const output = { isTTY: false, write: () => true };
		const run = runCleanse(
			{ request: "Inspect diagnostics", model: "openai/gpt-5-mini" },
			{ board: createCleanseStatusBoard(output, output), print() {}, printError() {} },
			new AbortController().signal,
		);
		const settled = failureOf(run);
		try {
			await Promise.race([fixture.entered.promise, settled]);
			await expect(fixture.nextClient()).rejects.toBe(fixture.privatePath);
			fixture.finish.resolve();
			expect(await settled).toBe(fixture.stopped);
			await expect(fixture.nextClient()).rejects.toBe(fixture.privatePath);
		} finally {
			fixture.finish.resolve();
			await settled;
			for (const session of sessions.splice(0).reverse()) await session.dispose();
			close();
		}
	});

	it("the standalone cleanse command initializes shared transport before its worker-only runtime runs", async () => {
		using tempDir = TempDir.createSync("@pi-cleanse-lsp-cli-");
		const { authStorage, close } = await starter(tempDir);
		const fixture = cleanseFixture(tempDir, authStorage);
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const command = new CleanseCommand(["--all", "--model", "openai/gpt-5-mini", "Inspect diagnostics"], {
			bin: "omp",
			version: "0.0.0-test",
			commands: new Map<string, typeof CleanseCommand>(),
		});
		const settled = failureOf(command.run());
		try {
			await Promise.race([fixture.entered.promise, settled]);
			await expect(fixture.nextClient()).rejects.toBe(fixture.sharedPath);
			fixture.finish.resolve();
			expect(await settled).toBe(fixture.stopped);
			await expect(fixture.nextClient()).rejects.toBe(fixture.sharedPath);
		} finally {
			fixture.finish.resolve();
			await settled;
			close();
		}
	});

	it("a subagent session does not turn shared LSP off for its parent", async () => {
		using tempDir = TempDir.createSync("@pi-shared-lsp-binding-");
		const { start, close } = await starter(tempDir);
		const sharedPath = new Error("shared transport selected");
		const privatePath = new Error("private transport selected");
		vi.spyOn(lspDaemon, "connectSharedLspTransport").mockRejectedValue(sharedPath);
		vi.spyOn(ptree, "spawn").mockImplementation(() => {
			throw privatePath;
		});
		let coldStart = 0;
		const nextClient = () =>
			lspClient.getOrCreateClient(
				{ command: `ownership-test-${coldStart++}`, fileTypes: ["ts"], rootMarkers: [] },
				tempDir.path(),
			);
		try {
			const parent = Settings.isolated({ "compaction.enabled": false, "lsp.shared": true });
			await start(parent, { enableLsp: true });
			await expect(nextClient()).rejects.toBe(sharedPath);

			const childSettings = createSubagentSettings(parent);
			await start(childSettings, {
				parentTaskPrefix: "0-Sub",
				taskDepth: 1,
				agentId: "0-Sub",
				enableLsp: false,
			});
			await expect(nextClient()).rejects.toBe(sharedPath);

			const helperSettings = await parent.cloneForCwd(tempDir.path());
			await start(helperSettings, { bindProcessState: false, enableLsp: true });
			cfgLspShared.override(helperSettings, false);
			cfgLspShared.override(childSettings, false);
			await Promise.resolve();
			await expect(nextClient()).rejects.toBe(sharedPath);

			// `Settings.isolated` values sit in the override layer, so flip that one.
			cfgLspShared.override(parent, false);
			// `listen` coalesces changes per microtask; let the queued one run.
			await Promise.resolve();
			await expect(nextClient()).rejects.toBe(privatePath);
		} finally {
			for (const session of sessions.splice(0).reverse()) await session.dispose();
			close();
		}
	});
});
