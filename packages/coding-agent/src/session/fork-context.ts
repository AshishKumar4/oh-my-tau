/**
 * Durable fork-request state: the provider-native request a forked child may
 * inherit for prompt-cache prefix reuse, plus the wire-level fingerprints that
 * certify the child's inherited prefix still matches it. The journal marker is
 * a `custom` entry (never model-visible), so restarts and nested forks keep
 * their lineage without a live parent runtime.
 *
 * The journal is the authority after initial seeding: a `reset_boundary` newer
 * than the marker retires it, and a `compaction`/`branch_summary` newer than
 * the marker (or newer than a live captured request) keeps lineage but forbids
 * raw-prefix replay — a surviving leading run of messages is not proof the
 * full captured wire prefix still applies.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CodexRequestSnapshot } from "@oh-my-pi/pi-ai";
import { logger, stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { SessionManager } from "./session-manager";

/** Journal custom-type under which a forked child's inherited request is stored. */
export const FORK_REQUEST_CONTEXT_TYPE = "subagent_fork_request";

export interface ForkRequestSnapshot {
	/** The parent's provider-native request identity and serialized input. */
	request: CodexRequestSnapshot;
	/**
	 * Per-message wire fingerprints of the captured context, in order. A child
	 * replays the native prefix only while its leading messages hash the same.
	 */
	messageFingerprints: string[];
	/** Durable OAuth credential row the source request ran under (pin preference only). */
	credentialId?: number;
}

/**
 * A live request snapshot bound to the session that captured (or seeded) it:
 * `recordedAt` orders it against journal rewrite/boundary markers, `ownerId`
 * ties it to one runtime session identity so `/new` or a session switch can
 * never lend a previous session's prefix.
 */
export interface SessionForkRequest extends ForkRequestSnapshot {
	/** ms since epoch: capture time, journal-marker time, or seed time. */
	recordedAt: number;
	/** `${sessionManagerId}~${agentSessionId}` bound lazily at first use. */
	ownerId?: string;
}

const codexRequestSnapshotSchema = type({
	provider: "string",
	model: "string",
	baseUrl: "string",
	"accountId?": "string",
	sessionId: "string",
	threadId: "string",
	"promptCacheKey?": "string",
	input: "unknown[]",
});

const forkRequestSnapshotSchema = type({
	request: codexRequestSnapshotSchema,
	messageFingerprints: "string[]",
	"credentialId?": "number",
});

/**
 * Validate a journal-persisted fork request. `input` items are provider-native
 * wire payloads: the schema certifies the envelope (which is all the journal
 * boundary can know) while the array itself stays opaque to the provider.
 */
function parseForkRequestSnapshot(data: unknown): ForkRequestSnapshot | undefined {
	const parsed = forkRequestSnapshotSchema(data);
	if (parsed instanceof type.errors) return undefined;
	return {
		request: parsed.request as CodexRequestSnapshot,
		messageFingerprints: parsed.messageFingerprints,
		...(parsed.credentialId !== undefined ? { credentialId: parsed.credentialId } : {}),
	};
}

/**
 * Wire-level identity of one context message: every field the provider
 * serializes into `input`, and only those. Usage/cost/details are excluded so
 * resetting inherited billing never invalidates a byte-identical prefix.
 */
export function fingerprintForkMessage(message: AgentMessage): string {
	let projection: Record<string, unknown>;
	switch (message.role) {
		case "assistant":
			projection = {
				role: message.role,
				content: message.content,
				api: message.api,
				provider: message.provider,
				model: message.model,
				...(message.responseId !== undefined ? { responseId: message.responseId } : {}),
			};
			break;
		case "toolResult":
			projection = {
				role: message.role,
				content: message.content,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				isError: message.isError,
				...(message.providerMetadata !== undefined ? { providerMetadata: message.providerMetadata } : {}),
			};
			break;
		default:
			projection = {
				role: message.role,
				...("content" in message && message.content !== undefined ? { content: message.content } : {}),
				...("customType" in message && message.customType !== undefined ? { customType: message.customType } : {}),
			};
			break;
	}
	if ("providerPayload" in message && message.providerPayload !== undefined) {
		projection.providerPayload = message.providerPayload;
	}
	return new Bun.CryptoHasher("sha256").update(stableStringifyJson(projection)).digest("hex");
}

/** Fingerprints of a context as sent (post-transform), in message order. */
export function fingerprintForkMessages(messages: readonly AgentMessage[]): string[] {
	return messages.map(fingerprintForkMessage);
}

/**
 * Count of leading context messages byte-identical to the inherited request's
 * source prefix. `undefined` when the prefix diverged (compaction, pruning,
 * re-order) — the provider still applies lineage but falls back to normal
 * conversion for the whole context.
 */
export function forkPrefixMessageCount(
	inherited: ForkRequestSnapshot,
	messages: readonly AgentMessage[],
): number | undefined {
	if (inherited.messageFingerprints.length > messages.length) return undefined;
	for (let i = 0; i < inherited.messageFingerprints.length; i++) {
		const message = messages[i];
		if (message === undefined || fingerprintForkMessage(message) !== inherited.messageFingerprints[i]) {
			return undefined;
		}
	}
	return inherited.messageFingerprints.length;
}

/** Persist the inherited request once, alongside the seeded journal messages. */
export function recordForkRequestSnapshot(sessionManager: SessionManager, snapshot: ForkRequestSnapshot): void {
	// Only the durable shape crosses the journal boundary; runtime fields
	// (ownerId/recordedAt) on a live SessionForkRequest never persist.
	sessionManager.appendCustomEntry(FORK_REQUEST_CONTEXT_TYPE, {
		request: snapshot.request,
		messageFingerprints: snapshot.messageFingerprints,
		...(snapshot.credentialId !== undefined ? { credentialId: snapshot.credentialId } : {}),
	});
}

/**
 * Journal-derived lineage state, derived only from existing entry markers —
 * never persisted shadow flags.
 */
export interface ForkJournalState {
	/** The newest live fork marker's request; undefined when none survives the boundary. */
	snapshot?: SessionForkRequest;
	/** Timestamp (ms) of the newest `reset_boundary` seen; older lineage is dead. */
	boundaryMs?: number;
	/** Timestamp (ms) of the newest compaction/branch rewrite newer than the boundary. */
	lastRewriteMs?: number;
}

/**
 * Scan the journal newest→oldest: the first `reset_boundary` kills everything
 * older (including fork markers); compaction/branch summaries above it set the
 * rewrite floor; the newest fork marker above it supplies the snapshot (its
 * entry timestamp doubles as `recordedAt`). Malformed markers are skipped.
 */
export function readForkJournalState(sessionManager: Pick<SessionManager, "getEntries">): ForkJournalState {
	const state: ForkJournalState = {};
	const entries = sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry === undefined) continue;
		if (entry.type === "reset_boundary") {
			state.boundaryMs = Date.parse(entry.timestamp);
			break;
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			const at = Date.parse(entry.timestamp);
			if (state.lastRewriteMs === undefined || at > state.lastRewriteMs) state.lastRewriteMs = at;
			continue;
		}
		if (entry.type === "custom" && entry.customType === FORK_REQUEST_CONTEXT_TYPE) {
			const snapshot = parseForkRequestSnapshot(entry.data);
			if (snapshot !== undefined) {
				state.snapshot = { ...snapshot, recordedAt: Date.parse(entry.timestamp) };
			} else {
				logger.warn("Ignoring malformed fork request snapshot in session journal", { entryId: entry.id });
			}
		}
	}
	return state;
}

/**
 * Cached {@link readForkJournalState} for per-turn calls: re-scans only when
 * the journal tail changes (appends and durable discards both shift the
 * length/last-id key).
 */
export function createForkJournalStateReader(
	sessionManager: Pick<SessionManager, "getEntries" | "getSessionId">,
): () => ForkJournalState {
	let cachedKey: string | undefined;
	let cached: ForkJournalState = {};
	return () => {
		const entries = sessionManager.getEntries();
		const last = entries[entries.length - 1];
		// The session id covers a journal swap under the same manager (`/new`):
		// a fresh journal's tail alone could collide with the old key.
		const key = `${sessionManager.getSessionId?.() ?? ""}:${entries.length}:${last?.id ?? ""}`;
		if (key !== cachedKey) {
			cached = readForkJournalState(sessionManager);
			cachedKey = key;
		}
		return cached;
	};
}

/** Resolve the durable credential row behind a snapshot's account, for pinning. */
export function resolveForkCredentialId(
	authStorage: {
		listOAuthAccounts(
			provider: string,
			sessionId?: string,
		): Array<{ credentialId: number; accountId?: string; active: boolean }>;
	},
	snapshot: CodexRequestSnapshot,
	sessionId?: string,
): number | undefined {
	if (snapshot.accountId === undefined) return undefined;
	const account = authStorage
		.listOAuthAccounts(snapshot.provider, sessionId)
		.find(candidate => candidate.active && candidate.accountId === snapshot.accountId);
	return account?.credentialId;
}
