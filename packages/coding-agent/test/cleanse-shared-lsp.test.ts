import { afterEach, describe, expect, it, vi } from "bun:test";
import { runCleanse } from "@oh-my-pi/pi-coding-agent/cleanse/index";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspDaemon from "@oh-my-pi/pi-coding-agent/lsp/mux/daemon";
import { cfgLspShared } from "@oh-my-pi/pi-coding-agent/lsp/settings";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as structuredSubagent from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { createCleanseStatusBoard } from "@oh-my-pi/pi-tui/apps/cleanse-board";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import * as dirs from "@oh-my-pi/pi-utils/dirs";

// A cleanse run holds the process-wide shared-LSP mode for its subagent workers.
// Like a session's hold, it follows `lsp.shared` while it runs and lets go at the end.

async function failureOf<T>(run: Promise<T>): Promise<Error | undefined> {
	try {
		await run;
		return undefined;
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
}

describe("cleanse shared-LSP hold", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await lspClient.shutdownAll();
	});

	it("follows a live lsp.shared change during the run and releases the mode when the run ends", async () => {
		using tempDir = TempDir.createSync("@pi-cleanse-lsp-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		const settings = Settings.isolated({ "compaction.enabled": false, "lsp.shared": true });
		vi.spyOn(Settings, "init").mockResolvedValue(settings);
		vi.spyOn(sdk, "discoverAuthStorage").mockResolvedValue(authStorage);
		vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
		vi.spyOn(dirs, "getProjectDir").mockReturnValue(tempDir.path());
		vi.spyOn(SessionManager, "create").mockReturnValue(
			SessionManager.create(tempDir.path(), tempDir.join("cleanse-sessions")),
		);
		// A client cold start reveals the transport it chose without starting a server.
		const sharedPath = new Error("shared transport selected");
		const privatePath = new Error("private transport selected");
		vi.spyOn(lspDaemon, "connectSharedLspTransport").mockRejectedValue(sharedPath);
		vi.spyOn(ptree, "spawn").mockImplementation(() => {
			throw privatePath;
		});
		let coldStart = 0;
		const nextClient = () =>
			lspClient.getOrCreateClient(
				{ command: `cleanse-shared-lsp-${coldStart++}`, fileTypes: ["ts"], rootMarkers: [] },
				tempDir.path(),
			);
		// Discovery blocks, so the run stays open while the test changes the setting.
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const stopped = new Error("discovery stopped");
		vi.spyOn(structuredSubagent, "runStructuredSubagent").mockImplementation(async () => {
			entered.resolve();
			await finish.promise;
			throw stopped;
		});
		const output = { isTTY: false, write: () => true };
		const settled = failureOf(
			runCleanse(
				{ request: "Inspect diagnostics", model: "openai/gpt-5-mini" },
				{ board: createCleanseStatusBoard(output, output), print() {}, printError() {} },
				new AbortController().signal,
			),
		);
		try {
			await Promise.race([entered.promise, settled]);
			await expect(nextClient()).rejects.toBe(sharedPath);

			cfgLspShared.override(settings, false);
			await Promise.resolve();
			await expect(nextClient()).rejects.toBe(privatePath);

			finish.resolve();
			expect(await settled).toBe(stopped);
			expect(lspClient.isSharedLspEnabled()).toBe(false);
		} finally {
			finish.resolve();
			await settled;
			authStorage.close();
		}
	});
});
