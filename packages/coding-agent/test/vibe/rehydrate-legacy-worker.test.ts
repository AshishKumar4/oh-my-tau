/**
 * Sessions saved before the `sonic` agent was removed recorded their `fast`
 * workers as `sonic`. Resuming such a session must restore those workers, now
 * run by `task`, while a spawn naming any other agent stays unrestored.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { VIBE_LIFECYCLE_CUSTOM_TYPE, VIBE_LIFECYCLE_VERSION } from "@oh-my-pi/pi-coding-agent/vibe/lifecycle";
import { type VibeParentSession, VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";

const WORKER_ID = "FastWorker";

/** A persisted parent whose journal spawned one `fast` worker, recorded under `agent`, that finished a turn. */
async function parentWithFastWorker(
	dir: string,
	agent: string,
): Promise<{ parent: VibeParentSession; close(): Promise<void> }> {
	const manager = SessionManager.create(dir, path.join(dir, "sessions"));
	const parentSessionId = manager.getSessionId();
	const base = { version: VIBE_LIFECYCLE_VERSION, id: WORKER_ID, ownerId: "Main", parentSessionId };
	manager.appendCustomEntry(VIBE_LIFECYCLE_CUSTOM_TYPE, {
		...base,
		action: "spawn",
		cli: "fast",
		agent,
		childSessionFile: `${WORKER_ID}.jsonl`,
		createdAt: Date.now(),
	});
	manager.appendCustomEntry(VIBE_LIFECYCLE_CUSTOM_TYPE, { ...base, action: "turn-started", turn: 1 });
	manager.appendCustomEntry(VIBE_LIFECYCLE_CUSTOM_TYPE, { ...base, action: "turn-settled", turn: 1 });
	await manager.ensureOnDisk();
	await manager.flush();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted parent session");

	const child = SessionManager.create(dir, path.join(dir, "children"));
	child.appendSessionInit({ systemPrompt: ["worker prompt"], task: "work", tools: ["read", "edit"], agent });
	await child.ensureOnDisk();
	await child.flush();
	const childFile = child.getSessionFile();
	if (!childFile) throw new Error("Expected a persisted child session");
	await child.close();
	const artifactsDir = sessionFile.slice(0, -6);
	await fs.mkdir(artifactsDir, { recursive: true });
	await fs.copyFile(childFile, path.join(artifactsDir, `${WORKER_ID}.jsonl`));

	const parent: VibeParentSession = {
		getAgentId: () => "Main",
		getSessionId: () => parentSessionId,
		getSessionFile: () => sessionFile,
		sessionManager: manager,
		settings: Settings.isolated(),
	};
	return { parent, close: () => manager.close() };
}

describe("vibe rehydrate of legacy fast workers", () => {
	const dirs: TempDir[] = [];

	afterEach(() => {
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		for (const dir of dirs.splice(0)) dir.removeSync();
	});

	it("restores a fast worker recorded as the removed `sonic` agent", async () => {
		const dir = TempDir.createSync("@omp-vibe-legacy-sonic-");
		dirs.push(dir);
		const { parent, close } = await parentWithFastWorker(dir.path(), "sonic");

		const restored = await VibeSessionRegistry.global().rehydrate(parent);
		await close();

		expect(restored).toBe(1);
		expect(AgentRegistry.global().get(WORKER_ID)?.status).toBe("parked");
	});

	it("leaves a spawn recorded under an unrelated agent unrestored", async () => {
		const dir = TempDir.createSync("@omp-vibe-legacy-stranger-");
		dirs.push(dir);
		const { parent, close } = await parentWithFastWorker(dir.path(), "reviewer");

		const restored = await VibeSessionRegistry.global().rehydrate(parent);
		await close();

		expect(restored).toBe(0);
		expect(AgentRegistry.global().get(WORKER_ID)).toBeUndefined();
	});
});
