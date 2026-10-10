import { Database } from "bun:sqlite";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

/**
 * Shared factory for building a minimal mock `AssistantMessage`
 * used by AgentSession test suites.
 */
export function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Build isolated auth state without opening a filesystem-backed SQLite database.
 * AgentSession unit tests that only need a runtime API key should not pay for
 * database creation, journaling, and deletion on every case.
 */
export function createInMemoryAuthStorage(): AuthStorage {
	return new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
}

/** Exercise real auth admission and requests without reading local config or persisting catalog data. */
export function createInMemoryModelRegistry(provider: string): ModelRegistry {
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime(provider, "test-key");
	return new ModelRegistry(auth, path.join(import.meta.dir, "fixture-models.yml"), {
		ignoreLocalModelConfig: true,
		cacheDbPath: ":memory:",
		settings: Settings.isolated({}),
	});
}
