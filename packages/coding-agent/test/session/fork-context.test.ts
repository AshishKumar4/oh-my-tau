/**
 * Fork request lineage: journal-derived origins respect reset boundaries and
 * compaction/branch rewrites, read from the ACTIVE branch only — so a forked
 * child replays a provider-native prefix only while the journal certifies it.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, CodexRequestSnapshot, UserMessage } from "@oh-my-pi/pi-ai";
import {
	createForkJournalStateReader,
	fingerprintForkMessage,
	FORK_REQUEST_CONTEXT_TYPE,
	forkAnchorIsCurrent,
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

function seedOrigin(manager: SessionManager, sessionId = "sess-parent"): void {
	recordForkRequestSnapshot(manager, {
		request: request({ sessionId }),
		messageFingerprints: fingerprintHistory(manager),
	});
}

describe("fork request journal state", () => {
	it("round-trips a recorded origin marker on the active branch", () => {
		const manager = managerWith([user("one"), assistantText("two")]);
		recordForkRequestSnapshot(manager, {
			request: request(),
			messageFingerprints: fingerprintHistory(manager),
			credentialId: 7,
		});

		const state = readForkJournalState(manager);
		expect(state.snapshot?.request.sessionId).toBe("sess-parent");
		expect(state.snapshot?.credentialId).toBe(7);
		expect(state.replayable).toBe(true);
		expect(state.hasBoundary).toBe(false);
	});

	it("a reset boundary newer than the marker kills the origin", () => {
		const manager = managerWith([user("one")]);
		seedOrigin(manager);
		manager.appendResetBoundary();
		const state = readForkJournalState(manager);
		expect(state.snapshot).toBeUndefined();
		expect(state.hasBoundary).toBe(true);
	});

	it("a marker newer than the boundary survives and still reports the boundary", () => {
		const manager = managerWith([user("one")]);
		manager.appendResetBoundary();
		seedOrigin(manager, "alive");
		const state = readForkJournalState(manager);
		expect(state.snapshot?.request.sessionId).toBe("alive");
		expect(state.hasBoundary).toBe(true);
	});

	it("the newest marker wins regardless of entry timestamps", () => {
		const manager = managerWith([user("one")]);
		seedOrigin(manager, "older");
		seedOrigin(manager, "newest");
		expect(readForkJournalState(manager).snapshot?.request.sessionId).toBe("newest");
	});

	it("a compaction newer than the marker keeps lineage but withholds replay", () => {
		const manager = managerWith([user("one"), assistantText("two")]);
		seedOrigin(manager);
		const firstEntry = manager.getEntries().at(0);
		manager.appendCompaction("summary", undefined, firstEntry?.id ?? "root", 100);
		const state = readForkJournalState(manager);
		expect(state.snapshot).toBeDefined();
		expect(state.replayable).toBe(false);
	});

	it("a branch rewrite newer than the marker keeps lineage but withholds replay", async () => {
		const manager = managerWith([user("one")]);
		seedOrigin(manager);
		const extraId = manager.appendMessage(user("to be discarded"));
		await manager.discardEntryDurably(extraId);
		const state = readForkJournalState(manager);
		expect(state.snapshot).toBeDefined();
		expect(state.replayable).toBe(false);
	});

	it("a malformed newest marker warns, still occupies the origin slot, and never falls back", () => {
		const manager = managerWith([user("one")]);
		seedOrigin(manager, "older-valid");
		manager.appendCustomEntry(FORK_REQUEST_CONTEXT_TYPE, { request: { provider: 42 } });
		const state = readForkJournalState(manager);
		expect(state.snapshot).toBeUndefined();
		// Marker presence is reported independently of parse success: the SDK
		// seed decision reads hasMarker, so a stale caller-supplied forkRequest
		// can never resurrect an origin over a malformed entry.
		expect(state.hasMarker).toBe(true);
		expect(state.hasBoundary).toBe(false);
	});

	it("a marker on an abandoned branch is not an origin", () => {
		const manager = managerWith([user("one")]);
		seedOrigin(manager, "abandoned");
		// Rewind the leaf before the marker: it now lives on a dead branch.
		const leafBefore = manager.getEntries().at(0)?.id ?? null;
		manager.branchWithSummary(leafBefore, "switched away");
		manager.appendMessage(user("new path"));
		expect(readForkJournalState(manager).snapshot).toBeUndefined();
	});

	it("the cached reader re-scans only when the leaf or session changes", () => {
		const manager = managerWith([user("one")]);
		const read = createForkJournalStateReader(manager);
		expect(read().snapshot).toBeUndefined();
		// Same leaf: cached, still no origin.
		expect(read().snapshot).toBeUndefined();
		seedOrigin(manager);
		// Leaf moved: re-scan sees the marker.
		expect(read().snapshot?.request.sessionId).toBe("sess-parent");
	});
});

describe("forkAnchorIsCurrent", () => {
	it("keeps an anchor reachable across messages, compactions, and discard summaries", async () => {
		const manager = managerWith([user("one")]);
		const anchor = manager.getLeafId();
		manager.appendMessage(assistantText("two"));
		expect(forkAnchorIsCurrent(manager, anchor)).toBe(true);
		// Compaction and discard-entry branch summaries are not killers: the
		// produced request is still what the provider last saw.
		const firstEntry = manager.getEntries().at(0);
		manager.appendCompaction("summary", undefined, firstEntry?.id ?? "root", 100);
		expect(forkAnchorIsCurrent(manager, anchor)).toBe(true);
		const extraId = manager.appendMessage(user("to be discarded"));
		await manager.discardEntryDurably(extraId);
		expect(forkAnchorIsCurrent(manager, anchor)).toBe(true);
	});

	it("retires the anchor once a reset boundary lands", () => {
		const manager = managerWith([user("one")]);
		const anchor = manager.getLeafId();
		manager.appendResetBoundary();
		expect(forkAnchorIsCurrent(manager, anchor)).toBe(false);
	});

	it("a null anchor survives ordinary entries but not a boundary", () => {
		const manager = SessionManager.inMemory();
		expect(forkAnchorIsCurrent(manager, null)).toBe(true);
		manager.appendMessage(user("one"));
		expect(forkAnchorIsCurrent(manager, null)).toBe(true);
		manager.appendResetBoundary();
		expect(forkAnchorIsCurrent(manager, null)).toBe(false);
	});

	it("an anchor stranded off the active branch is dead", () => {
		const manager = managerWith([user("one"), assistantText("two")]);
		const anchor = manager.getLeafId();
		manager.branchWithSummary(manager.getEntries().at(0)?.id ?? null, "switched away");
		expect(forkAnchorIsCurrent(manager, anchor)).toBe(false);
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
			messageFingerprints: [
				...messages.slice(0, 1).map(fingerprintForkMessage),
				fingerprintForkMessage(assistantText("changed")),
			],
		};
		expect(forkPrefixMessageCount(inherited, messages)).toBeUndefined();
	});

	it("returns undefined when the inherited prefix outlives the context", () => {
		const messages = [user("one")];
		const inherited = {
			request: request(),
			messageFingerprints: [...messages.map(fingerprintForkMessage), fingerprintForkMessage(user("gone"))],
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
