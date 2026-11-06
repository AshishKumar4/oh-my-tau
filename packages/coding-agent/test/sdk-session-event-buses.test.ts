/**
 * The session carries the event buses the SDK wires its tools to, so code that
 * starts subagent runs from the session (e.g. `/recover`) announces them on the
 * same buses the UI's running-subagents list and RPC subagent registry watch.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("createAgentSession event buses", () => {
	let dir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-buses-"));
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage, path.join(dir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(dir);
	});

	it("gives the session the buses its tools use", async () => {
		const eventBus = new EventBus();
		const subagentEventBus = new EventBus();
		const result = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry,
			settings: Settings.isolated(),
			eventBus,
			subagentEventBus,
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["read"],
		});

		try {
			expect(result.session.eventBus).toBe(eventBus);
			expect(result.session.subagentEventBus).toBe(subagentEventBus);
			expect(result.eventBus).toBe(eventBus);
		} finally {
			await result.session.dispose();
		}
	});
});
