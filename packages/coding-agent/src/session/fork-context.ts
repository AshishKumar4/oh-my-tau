/**
 * Durable fork-request lineage for conversation forks.
 *
 * Two distinct concepts share this file — never substitute one for the other:
 *
 * 1. **Inherited origin** — the provider-native request this child was forked
 *    from, persisted once as a `subagent_fork_request` custom journal entry.
 *    Only the journal certifies it: `readForkJournalState` walks the ACTIVE
 *    branch (never raw getEntries, which leaks other branches) newest→oldest
 *    and stops at the first boundary or marker, so a `reset_boundary` newer
 *    than the origin kills it and a compaction/branch rewrite newer than the
 *    origin withholds raw-prefix replay while lineage survives. Wall-clock
 *    timestamps are never compared — journal order is the ordering.
 *
 * 2. **Latest produced request** — this session's last completed provider
 *    request, what a FUTURE `fork: "all"` child would inherit. It is runtime
 *    state only (never journaled) and owner-bound: the getter validates the
 *    session/agent identity and the dispatch anchor's position on the active
 *    branch before returning it, so `/new`, a session switch, or a late
 *    response from a previous session can never lend a stale prefix.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CodexRequestSnapshot, OpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai";
import { isRecord, logger, stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { SessionManager } from "./session-manager";

/** Journal custom-type under which a forked child's inherited origin is stored. */
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

/** One provider-native wire item: the opaque serialized request elements. */
type WireItem = OpenAIResponsesHistoryPayload["items"][number];

function isWireItem(value: unknown): value is WireItem {
	return isRecord(value);
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
 * Validate a journal-persisted fork request. The schema certifies the
 * envelope; every `input` element must additionally be a record — a scalar
 * wire item can never certify history, so the whole marker is rejected rather
 * than silently narrowed.
 */
function parseForkRequestSnapshot(data: unknown): ForkRequestSnapshot | undefined {
	const parsed = forkRequestSnapshotSchema(data);
	if (parsed instanceof type.errors) return undefined;
	const items = parsed.request.input;
	if (!items.every(isWireItem)) return undefined;
	return {
		request: {
			provider: parsed.request.provider,
			model: parsed.request.model,
			baseUrl: parsed.request.baseUrl,
			accountId: parsed.request.accountId,
			sessionId: parsed.request.sessionId,
			threadId: parsed.request.threadId,
			...(parsed.request.promptCacheKey !== undefined ? { promptCacheKey: parsed.request.promptCacheKey } : {}),
			input: items,
		},
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
	// Only the durable shape crosses the journal boundary; runtime fields on a
	// live snapshot never persist.
	sessionManager.appendCustomEntry(FORK_REQUEST_CONTEXT_TYPE, {
		request: snapshot.request,
		messageFingerprints: snapshot.messageFingerprints,
		...(snapshot.credentialId !== undefined ? { credentialId: snapshot.credentialId } : {}),
	});
}

/**
 * Journal-derived inherited origin, computed per read from existing entry
 * markers — no persisted shadow flags.
 */
export interface ForkJournalState {
	/** The branch's newest live fork marker; undefined when none survives the boundary. */
	snapshot?: ForkRequestSnapshot;
	/**
	 * True when a fork marker entry sits on the active branch regardless of
	 * parse success — a malformed marker still occupies the origin slot, so
	 * callers must never re-seed from a caller-supplied snapshot once any
	 * marker exists.
	 */
	hasMarker: boolean;
	/**
	 * False when a compaction/branch_summary sits newer than the marker on the
	 * active branch: lineage is retained but raw-prefix replay is withheld —
	 * fingerprint equality alone is not proof the full captured prefix applies.
	 */
	replayable: boolean;
	/** True when the active branch's live head is truncated by a reset_boundary. */
	hasBoundary: boolean;
}

/**
 * Walk the ACTIVE branch newest→oldest. The first `reset_boundary` seen kills
 * everything older (including fork markers); compaction/branch summaries seen
 * before the first marker mark it non-replayable; the FIRST fork marker found
 * is the origin (never overwritten by an older one). A malformed newest marker
 * warns, reports hasMarker so no stale caller option resurrects an origin,
 * and yields no snapshot — it never falls back to an older valid marker.
 */
export function readForkJournalState(sessionManager: Pick<SessionManager, "getBranch">): ForkJournalState {
	const state: ForkJournalState = { replayable: true, hasBoundary: false, hasMarker: false };
	const branch = sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry === undefined) continue;
		if (entry.type === "reset_boundary") {
			state.hasBoundary = true;
			break;
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			state.replayable = false;
			continue;
		}
		if (entry.type === "custom" && entry.customType === FORK_REQUEST_CONTEXT_TYPE) {
			state.hasMarker = true;
			const snapshot = parseForkRequestSnapshot(entry.data);
			if (snapshot !== undefined) {
				state.snapshot = snapshot;
			} else {
				logger.warn("Ignoring malformed fork request snapshot in session journal", { entryId: entry.id });
			}
			// First marker wins: newer and older entries below are not origins.
			// Keep walking only for a truncating reset_boundary.
			while (--i >= 0) {
				const rest = branch[i];
				if (rest !== undefined && rest.type === "reset_boundary") {
					state.hasBoundary = true;
					break;
				}
			}
			break;
		}
	}
	return state;
}

/**
 * Cached {@link readForkJournalState} for per-turn calls: re-scans only when
 * the active-leaf or session identity changes.
 */
export function createForkJournalStateReader(
	sessionManager: Pick<SessionManager, "getBranch" | "getLeafId" | "getSessionId">,
): () => ForkJournalState {
	let cachedKey: string | undefined;
	let cached: ForkJournalState = { replayable: true, hasBoundary: false, hasMarker: false };
	return () => {
		const key = `${sessionManager.getSessionId()}\u0000${sessionManager.getLeafId() ?? ""}`;
		if (key !== cachedKey) {
			cached = readForkJournalState(sessionManager);
			cachedKey = key;
		}
		return cached;
	};
}

/**
 * Is a produced-request anchor still reachable without crossing a
 * `reset_boundary`? The anchor is the branch leaf at request dispatch; a
 * reset boundary appended after dispatch retires the produced request as an
 * inheritance source. Compaction and branch summaries are NOT killers here:
 * the produced request is still what the provider last saw, and a later
 * child that can no longer fingerprint-match its input simply inherits the
 * lineage without raw-prefix replay (messageCount omitted).
 */
export function forkAnchorIsCurrent(
	sessionManager: Pick<SessionManager, "getBranch">,
	anchorId: string | null,
): boolean {
	const branch = sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry === undefined) continue;
		if (anchorId !== null && entry.id === anchorId) return true;
		if (entry.type === "reset_boundary") return false;
	}
	// A null anchor means dispatch happened on an empty journal; the request
	// stays a valid origin until any reset_boundary appears on the branch.
	return anchorId === null;
}

/** Resolve the durable credential row behind a snapshot's account, for pinning. */
export function resolveForkCredentialId(
	authStorage: {
		oauth: {
			accounts(
				provider: string,
				sessionId?: string,
			): Array<{ credentialId: number; accountId?: string; active: boolean }>;
		};
	},
	snapshot: CodexRequestSnapshot,
	sessionId?: string,
): number | undefined {
	if (snapshot.accountId === undefined) return undefined;
	const account = authStorage.oauth
		.accounts(snapshot.provider, sessionId)
		.find(candidate => candidate.active && candidate.accountId === snapshot.accountId);
	return account?.credentialId;
}
