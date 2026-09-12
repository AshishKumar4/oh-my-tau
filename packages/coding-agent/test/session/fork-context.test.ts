/**
 * Fork request lineage: journal-derived snapshots respect reset boundaries,
 * compaction/branch rewrites, and message-order fingerprints — so a forked
 * child only replays a provider-native prefix while the journal still
 * certifies it.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, CodexRequestSnapshot, UserMessage } from "@oh-my-pi/pi-ai";
import {
	createForkJournalStateReader,
	fingerprintForkMessage,
	FORK_REQUEST_CONTEXT_TYPE,
	forkPrefixMessageCount,
	readForkJournalState,
	recordForkRequestSnapshot,
	resolveForkCredentialId,
} from "@oh-my-pi/pi-coding-agent/session/fork-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

type JournalMessage = Parameters<SessionManager["appendMessage"]>[0];

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
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

function request(overrides: Partial<CodexRequestSnapshot> = {}): CodexRequestSnapshot {
	return {
		provider: "openai-codex-responses",
		model: "gpt-5",
		baseUrl: "https://api.openai.com/v1",
		accountId: "acct-parent",
		sessionId: "sess-parent",
		threadId: "thread-parent",
		promptCacheKey: "cache-parent",
		input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "seed" }] }],
		...overrides,
	};
}

/** Fingerprints for the message entries already in this journal. */
function fingerprintHistory(manager: SessionManager): string[] {
	return manager
		.getEntries()
		.filter(entry => entry.type === "message")
		.map(entry => fingerprintForkMessage(entry.message));
}

function managerWith(messages: JournalMessage[]): SessionManager {
	const manager = SessionManager.inMemory();
	for (const message of messages) manager.appendMessage(message);
	return manager;
}

describe("fork request journal state", () => {
	it("round-trips a recorded snapshot and reports its fingerprint prefix", () => {
		const manager = managerWith([user("one"), assistantText("two")]);
		recordForkRequestSnapshot(manager, {
			request: request(),
			messageFingerprints: fingerprintHistory(manager),
			credentialId: 7,
		});

		const state = readForkJournalState(manager);
		expect(state.snapshot?.request.sessionId).toBe("sess-parent");
		expect(state.snapshot?.credentialId).toBe(7);
		expect(state.snapshot?.recordedAt).toBeGreaterThan(0);
		expect(state.boundaryMs).toBeUndefined();
		expect(state.lastRewriteMs).toBeUndefined();
	});

	it("a reset boundary retires markers older than it but not newer ones", () => {
		const manager = managerWith([user("one")]);
		recordForkRequestSnapshot(manager, { request: request({ sessionId: "dead" }), messageFingerprints: [] });
		manager.appendResetBoundary();
		expect(readForkJournalState(manager).snapshot).toBeUndefined();

		recordForkRequestSnapshot(manager, { request: request({ sessionId: "alive" }), messageFingerprints: [] });
		const state = readForkJournalState(manager);
		expect(state.snapshot?.request.sessionId).toBe("alive");
		expect(state.boundaryMs).toBeDefined();
	});

	it("reports the newest compaction/branch rewrite after the marker", () => {
		const manager = managerWith([user("one"), assistantText("two")]);
		recordForkRequestSnapshot(manager, { request: request(), messageFingerprints: [] });
		manager.appendCompaction("summary", undefined, manager.getEntries()[0]!.id, 100);
		const state = readForkJournalState(manager);
		expect(state.snapshot).toBeDefined();
		expect(state.lastRewriteMs).toBeDefined();
		// The marker predates the rewrite: raw-prefix replay must be withheld.
		expect(state.snapshot!.recordedAt <= state.lastRewriteMs!).toBe(true);
	});

	it("a branch_summary after the marker is also a rewrite", () => {
		const manager = managerWith([user("one")]);
		recordForkRequestSnapshot(manager, { request: request(), messageFingerprints: [] });
		manager.branchWithSummary(null, "abandoned path");
		expect(readForkJournalState(manager).lastRewriteMs).toBeDefined();
	});

	it("skips a malformed marker and keeps the previous valid one", () => {
		const manager = managerWith([user("one")]);
		recordForkRequestSnapshot(manager, { request: request({ sessionId: "valid" }), messageFingerprints: [] });
		manager.appendCustomEntry(FORK_REQUEST_CONTEXT_TYPE, { request: { provider: 42 } });
		expect(readForkJournalState(manager).snapshot?.request.sessionId).toBe("valid");
	});

	it("the cached reader re-scans only when the journal tail changes", () => {
		const manager = managerWith([user("one")]);
		const read = createForkJournalStateReader(manager);
		expect(read().snapshot).toBeUndefined();
		recordForkRequestSnapshot(manager, { request: request(), messageFingerprints: [] });
		expect(read().snapshot?.request.sessionId).toBe("sess-parent");
	});
});

describe("appendMessage inherited billing", () => {
	it("zeroes billing without mutating the source message", () => {
		const manager = SessionManager.inMemory();
		const paid = assistantText("parent's spend");
		paid.usage.cost = { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 1 };
		manager.appendMessage(paid, { inherited: true });
		const stored = manager.getEntries().find(entry => entry.type === "message")?.message;
		expect(stored?.role).toBe("assistant");
		expect(stored?.role === "assistant" ? stored.usage.cost.total : -1).toBe(0);
		expect(paid.usage.cost.total).toBe(1);
	});
});

describe("fingerprintForkMessage", () => {
	it("is stable across usage/cost changes but changes with content", () => {
		const rich = assistantText("answer");
		const sparse: AssistantMessage = {
			...rich,
			usage: {
				input: 999,
				output: 1,
				cacheRead: 5,
				cacheWrite: 5,
				totalTokens: 1000,
				cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
			},
			timestamp: rich.timestamp + 60_000,
		};
		expect(fingerprintForkMessage(rich)).toBe(fingerprintForkMessage(sparse));
		expect(fingerprintForkMessage(rich)).not.toBe(fingerprintForkMessage(assistantText("different")));
	});
});

describe("forkPrefixMessageCount", () => {
	it("matches a leading prefix and reports its length", () => {
		const messages = [user("one"), assistantText("two"), user("three")];
		const inherited = {
			request: request(),
			messageFingerprints: messages.slice(0, 2).map(fingerprintForkMessage),
		};
		expect(forkPrefixMessageCount(inherited, messages)).toBe(2);
	});

	it("returns undefined when a leading message diverged", () => {
		const messages = [user("one"), assistantText("two")];
		const inherited = {
			request: request(),
			messageFingerprints: [fingerprintForkMessage(messages[0]!), fingerprintForkMessage(assistantText("changed"))],
		};
		expect(forkPrefixMessageCount(inherited, messages)).toBeUndefined();
	});

	it("returns undefined when the inherited prefix outlives the context", () => {
		const messages = [user("one")];
		const inherited = {
			request: request(),
			messageFingerprints: [fingerprintForkMessage(messages[0]!), fingerprintForkMessage(user("gone"))],
		};
		expect(forkPrefixMessageCount(inherited, messages)).toBeUndefined();
	});

	it("an empty fingerprint list certifies an empty prefix", () => {
		const inherited = { request: request(), messageFingerprints: [] };
		expect(forkPrefixMessageCount(inherited, [user("one")])).toBe(0);
	});
});

describe("resolveForkCredentialId", () => {
	it("matches the active account's durable credential row", () => {
		const authStorage = {
			listOAuthAccounts: () => [
				{ credentialId: 1, accountId: "other", active: false },
				{ credentialId: 9, accountId: "acct-parent", active: true },
			],
		};
		expect(resolveForkCredentialId(authStorage, request(), "sess")).toBe(9);
		expect(resolveForkCredentialId(authStorage, request({ accountId: undefined }), "sess")).toBeUndefined();
		expect(resolveForkCredentialId(authStorage, request({ accountId: "missing" }), "sess")).toBeUndefined();
	});
});
