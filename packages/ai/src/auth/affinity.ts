import { logger } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { getEnvApiKey } from "../env-api-key";
import type { AuthCredential, OAuthCredential, SessionRestrictionLease, SessionsApi } from "./types";
import type { AuthCredentialStore } from "./store";
import type { CredentialBlocks } from "./blocks";
import type { CredentialPool } from "./pool";
import type { KeyOverrides } from "./cascade";
import { resolveCredentialIdentityKey } from "./sqlite-credential-store";

/** Prefix for persisted session-to-credential affinity. */
export const SESSION_STICKY_CACHE_PREFIX = "session:sticky:";
/** Persisted sticky rows live this long past their last use. */
const SESSION_STICKY_TTL_SEC = 30 * 24 * 60 * 60;
/**
 * Same-credential re-records rewrite the persisted row at most this often. The
 * in-memory sticky stays exact; only the copy other processes resume from lags.
 */
const SESSION_STICKY_PERSIST_INTERVAL_MS = 60_000;
/**
 * In-memory pin records kept per provider, each with both pools' pins.
 * Long-lived gateways mint a session id per conversation; evicted sessions
 * resume from their persisted sticky row.
 */
const SESSION_AFFINITY_MAX_SESSIONS_PER_PROVIDER = 256;

/** What this process last wrote (or read) for one persisted sticky row: its pins' identities and last use. */
type PersistedSticky = {
	pins: string;
	lastUsedAtMs: number;
};

/** A session's pinned credential (resolved index + durable row id). */
export type SessionCredential = {
	type: AuthCredential["type"];
	index: number;
	credentialId?: number;
	lastUsedAtMs?: number;
	/** Set only by the public user-facing pin API; automatic warm affinity leaves it absent. */
	explicit?: true;
};

/**
 * A session's pin in each stored pool (OAuth subscriptions, pooled API keys) and
 * the pool it used last. Selecting from a pool reads that pool's pin, so a
 * detour through the other pool (pooled keys served first, then failing) does
 * not cost the session the account it warmed a prompt cache on.
 */
type SessionPins = {
	current: AuthCredential["type"];
	byPool: Partial<Record<AuthCredential["type"], SessionCredential>>;
};

/**
 * One persisted sticky row: the session's current pin, with its pin in the
 * other pool alongside, so a record the in-memory bound evicted resumes both.
 */
type PersistedSessionPins = SessionCredential & { other?: SessionCredential };

/** The provider's other stored pool. */
function otherPool(type: AuthCredential["type"]): AuthCredential["type"] {
	return type === "oauth" ? "api_key" : "oauth";
}

/** Identity of the pins one persisted row holds, last-use times aside: equal keys need no rewrite. */
function persistedPinsKey(current: SessionCredential, other: SessionCredential | undefined): string {
	return [current, other].map(pin => pin && `${pin.type}:${pin.credentialId}:${pin.explicit === true}`).join("|");
}

/** One installed restriction: the allowed OAuth identity keys and the lease that lifts it. */
type SessionRestriction = { readonly allowed: ReadonlySet<string>; readonly lease: SessionRestrictionLease };

/**
 * Provider → session id → installed restriction. Owned by `AuthStorage` so
 * restrictions outlive store replacement, which rebuilds every store-bound
 * module (pins included) around the same identities.
 */
export type SessionRestrictions = Map<string, Map<string, SessionRestriction>>;

/** Session → credential affinity (pins), persisted in the store cache. */
export class SessionAffinity implements SessionsApi {
	/** Each session's pins per provider (used for rate-limit switching). */
	#sessionPins: Map<string, LRUCache<string, SessionPins>> = new Map();
	/** Persisted sticky rows per provider, keyed by session id, so unchanged re-records skip the write. */
	#persistedSticky: Map<string, LRUCache<string, PersistedSticky>> = new Map();
	#store: AuthCredentialStore;
	#pool: CredentialPool;
	#overrides: KeyOverrides;
	#blocks: CredentialBlocks;
	#restrictions: SessionRestrictions;

	constructor(
		store: AuthCredentialStore,
		pool: CredentialPool,
		overrides: KeyOverrides,
		blocks: CredentialBlocks,
		restrictions: SessionRestrictions,
	) {
		this.#store = store;
		this.#pool = pool;
		this.#overrides = overrides;
		this.#blocks = blocks;
		this.#restrictions = restrictions;
	}

	restrict(provider: string, sessionId: string, identityKeys: readonly string[]): SessionRestrictionLease {
		if (!provider || !sessionId) throw new Error("sessions.restrict requires a provider and a session id");
		const lease = Symbol("sessions.restrict");
		const sessions = this.#restrictions.get(provider) ?? new Map<string, SessionRestriction>();
		sessions.set(sessionId, { allowed: new Set(identityKeys), lease });
		this.#restrictions.set(provider, sessions);
		return lease;
	}

	unrestrict(provider: string, sessionId: string, lease: SessionRestrictionLease): void {
		const sessions = this.#restrictions.get(provider);
		if (sessions?.get(sessionId)?.lease !== lease) return;
		sessions.delete(sessionId);
		if (sessions.size === 0) this.#restrictions.delete(provider);
	}

	/** True when {@link restrict} limits `sessionId` for `provider`. */
	isRestricted(provider: string, sessionId: string | undefined): boolean {
		return sessionId !== undefined && this.#restrictions.get(provider)?.has(sessionId) === true;
	}

	/**
	 * True when `credential` may serve `sessionId`: always for an unrestricted
	 * session, otherwise only an OAuth credential whose identity key is allowed.
	 * The one eligibility predicate: selection, pool order, rotation, pins,
	 * inheritance, and usage health all apply it before anything else.
	 */
	allows(provider: string, sessionId: string | undefined, credential: AuthCredential): boolean {
		const allowed = sessionId === undefined ? undefined : this.#restrictions.get(provider)?.get(sessionId)?.allowed;
		if (allowed === undefined) return true;
		if (credential.type !== "oauth") return false;
		const identityKey = resolveCredentialIdentityKey(provider, credential);
		return identityKey !== null && allowed.has(identityKey);
	}

	/** Whether the stored row at `index` may serve `sessionId` (see {@link allows}). */
	#permits(provider: string, sessionId: string, index: number): boolean {
		if (!this.isRestricted(provider, sessionId)) return true;
		const credential = this.#pool.credentials(provider)[index];
		return credential !== undefined && this.allows(provider, sessionId, credential);
	}

	permits(provider: string, sessionId: string, credentialId: number): boolean {
		if (!this.isRestricted(provider, sessionId)) return true;
		const entry = this.#pool.entries(provider).find(candidate => candidate.id === credentialId);
		return entry !== undefined && this.allows(provider, sessionId, entry.credential);
	}

	/** Bounded per-provider session map, created on first use. */
	static #sessionsFor<V>(maps: Map<string, LRUCache<string, V>>, provider: string): LRUCache<string, V> {
		let sessions = maps.get(provider);
		if (!sessions) {
			sessions = new LRUCache<string, V>({ max: SESSION_AFFINITY_MAX_SESSIONS_PER_PROVIDER });
			maps.set(provider, sessions);
		}
		return sessions;
	}

	/** Drop only this session's in-memory pins after OAuth selection falls through. */
	forget(provider: string, sessionId: string): void {
		this.#sessionPins.get(provider)?.delete(sessionId);
	}

	/**
	 * Records which credential was used for a session (for rate-limit switching).
	 * `lastUsedAtMs` backdates the sticky (session-file pin restores on resume);
	 * it defaults to now for live selections. Automatic re-recording of the same
	 * durable row preserves an explicit user pin. A held account, and one outside
	 * a restricted session's pool, is never pinned: returns whether the pin was
	 * recorded.
	 *
	 * The in-memory sticky is always exact. The persisted row, which carries both
	 * pools' pins, is rewritten only when a pin's credential, type, or
	 * explicitness changes, or when the stored last-use drifts by
	 * {@link SESSION_STICKY_PERSIST_INTERVAL_MS} — per-request rewrites were pure
	 * database churn.
	 */
	record(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
		index: number,
		lastUsedAtMs?: number,
		explicit = false,
	): boolean {
		if (!sessionId || this.#blocks.isHeld(provider, index) || !this.#permits(provider, sessionId, index)) {
			return false;
		}
		const nowMs = lastUsedAtMs ?? Date.now();
		const credentialId = this.#pool.entries(provider)[index]?.id;
		const pins = this.#pins(provider, sessionId);
		const previous = pins?.byPool[type];
		const sameCredential =
			previous?.type === type &&
			(credentialId !== undefined ? previous.credentialId === credentialId : previous.index === index);
		const isExplicit = explicit || (sameCredential && previous?.explicit === true);
		const sessionCredential: SessionCredential = {
			type,
			index,
			credentialId,
			lastUsedAtMs: nowMs,
			...(isExplicit ? { explicit: true as const } : {}),
		};
		SessionAffinity.#sessionsFor(this.#sessionPins, provider).set(sessionId, {
			current: type,
			byPool: { ...pins?.byPool, [type]: sessionCredential },
		});
		this.#persist(provider, sessionId);
		return true;
	}

	/**
	 * Writes the pins other processes, and this one after an eviction, resume
	 * from: the session's current pin, with its pin in the other pool alongside.
	 * Only pins with a durable row id are written.
	 */
	#persist(provider: string, sessionId: string): void {
		const pins = this.#sessionPins.get(provider)?.get(sessionId);
		const current = pins?.byPool[pins.current];
		if (!pins || current?.credentialId === undefined) return;
		const otherPin = pins.byPool[otherPool(pins.current)];
		const other = otherPin?.credentialId !== undefined ? otherPin : undefined;
		const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
		const lastUsedAtMs = current.lastUsedAtMs ?? Date.now();
		const expiresAtSec = Math.floor(lastUsedAtMs / 1000) + SESSION_STICKY_TTL_SEC;
		const persistedPins = persistedPinsKey(current, other);
		const persistedSessions = SessionAffinity.#sessionsFor(this.#persistedSticky, provider);
		const persisted = persistedSessions.get(sessionId);
		if (
			persisted?.pins === persistedPins &&
			Math.abs(lastUsedAtMs - persisted.lastUsedAtMs) < SESSION_STICKY_PERSIST_INTERVAL_MS
		) {
			return;
		}
		const row: PersistedSessionPins = { ...current, ...(other ? { other } : {}) };
		try {
			this.#store.setCache(cacheKey, JSON.stringify(row), expiresAtSec);
			persistedSessions.set(sessionId, { pins: persistedPins, lastUsedAtMs });
		} catch (err) {
			persistedSessions.delete(sessionId);
			logger.debug("Failed to write session sticky credential to persistent store cache", { err });
		}
	}

	/**
	 * Drops one pool's pin. When it was the current one, the session's pin in the
	 * other pool becomes current (and is what other processes resume from).
	 */
	#drop(provider: string, sessionId: string, type: AuthCredential["type"]): void {
		const sessionMap = this.#sessionPins.get(provider);
		const pins = sessionMap?.get(sessionId);
		if (!sessionMap || !pins) return;
		delete pins.byPool[type];
		const remaining = pins.byPool[otherPool(type)];
		if (pins.current !== type || remaining) {
			if (remaining) pins.current = remaining.type;
			// The persisted row no longer carries the dropped pin.
			this.#persist(provider, sessionId);
			return;
		}
		sessionMap.delete(sessionId);
		if (sessionMap.size === 0) this.#sessionPins.delete(provider);
	}

	/**
	 * Retrieves the credential a session used last, or with `pool` its pin in that
	 * pool: the account a selection from that pool keeps while it stays usable. A
	 * restricted session never sees a pin outside its allowlist — inherited,
	 * restored, or recorded before the restriction — so it re-ranks inside the
	 * allowlist instead. When the restriction hides the current pin, the other
	 * pool's pin, if allowed, is the one the session uses.
	 */
	get(provider: string, sessionId: string | undefined, pool?: AuthCredential["type"]): SessionCredential | undefined {
		if (!sessionId) return undefined;
		const credential = this.#lookup(provider, sessionId, pool);
		if (!credential || this.#permits(provider, sessionId, credential.index)) return credential;
		if (pool !== undefined) return undefined;
		const other = this.#lookup(provider, sessionId, otherPool(credential.type));
		return other && this.#permits(provider, sessionId, other.index) ? other : undefined;
	}

	#lookup(provider: string, sessionId: string, pool?: AuthCredential["type"]): SessionCredential | undefined {
		const pins = this.#pins(provider, sessionId);
		if (!pins) return undefined;
		const type = pool ?? pins.current;
		const live = pins.byPool[type];
		if (!live) return undefined;
		// Another process can add or drop rows mid-session and the pool is an
		// index-ordered snapshot, so re-resolve the pin through its durable row
		// id: a compacted array must not point the session at a different
		// account, and a deleted account must not hand its slot to a sibling.
		if (live.credentialId === undefined) return live;
		const stored = this.#pool.entries(provider);
		const actualIndex = stored.findIndex(entry => entry.id === live.credentialId);
		if (actualIndex === -1 || stored[actualIndex]?.credential.type !== live.type) {
			this.#drop(provider, sessionId, type);
			// Dropping the current pin made the other pool's pin current; read that one.
			return pool === undefined ? this.#lookup(provider, sessionId) : undefined;
		}
		live.index = actualIndex;
		return live;
	}

	/**
	 * The session's pins: the in-memory record, else the one restored from its
	 * persisted row. Every read and every mutation starts here, so a session the
	 * in-memory bound evicted keeps both pools' pins through its next pin,
	 * record, or clear, not only through its next lookup.
	 */
	#pins(provider: string, sessionId: string): SessionPins | undefined {
		const live = this.#sessionPins.get(provider)?.get(sessionId);
		if (live) return live;
		try {
			const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
			const raw = this.#store.getCache(cacheKey);
			if (!raw) return undefined;
			const row = JSON.parse(raw) as PersistedSessionPins;
			const current = this.#resolvePersistedPin(provider, row);
			const other =
				row.other?.type === otherPool(row.type) ? this.#resolvePersistedPin(provider, row.other) : undefined;
			const restored = current ?? other;
			if (!restored) {
				// Its rows are gone, or it is an unsafe index-only row: never route by a stale slot.
				this.#persistedSticky.get(provider)?.delete(sessionId);
				this.#store.setCache(cacheKey, "", 0);
				return undefined;
			}
			const pins: SessionPins = { current: restored.type, byPool: {} };
			for (const pin of [other, current]) if (pin) pins.byPool[pin.type] = pin;
			SessionAffinity.#sessionsFor(this.#sessionPins, provider).set(sessionId, pins);
			if (!current) {
				// The row's current pin is gone: write the promoted one.
				this.#persist(provider, sessionId);
			} else if (typeof row.lastUsedAtMs === "number") {
				SessionAffinity.#sessionsFor(this.#persistedSticky, provider).set(sessionId, {
					pins: persistedPinsKey(current, other),
					lastUsedAtMs: row.lastUsedAtMs,
				});
			}
			return pins;
		} catch (err) {
			logger.debug("Failed to read session sticky credential from persistent store cache", { err });
		}
		return undefined;
	}

	/** A persisted pin re-resolved through its durable row id; undefined once that row is gone or changed type. */
	#resolvePersistedPin(provider: string, pin: SessionCredential | undefined): SessionCredential | undefined {
		if (pin?.credentialId === undefined) return undefined;
		const stored = this.#pool.entries(provider);
		const index = stored.findIndex(entry => entry.id === pin.credentialId);
		if (index === -1 || stored[index]?.credential.type !== pin.type) return undefined;
		return {
			type: pin.type,
			index,
			credentialId: pin.credentialId,
			lastUsedAtMs: pin.lastUsedAtMs,
			...(pin.explicit === true ? { explicit: true } : {}),
		};
	}

	/**
	 * Clears the credential a session used last for a provider. Its pin in the
	 * provider's other pool, if any, becomes current.
	 */
	clear(provider: string, sessionId: string | undefined): void {
		if (!sessionId) return;
		const pins = this.#pins(provider, sessionId);
		if (pins) this.#drop(provider, sessionId, pins.current);
		// A promoted pin with a durable row id was persisted by the drop.
		const remaining = this.#sessionPins.get(provider)?.get(sessionId);
		if (remaining?.byPool[remaining.current]?.credentialId !== undefined) return;
		this.#clearPersisted(provider, sessionId);
	}

	#clearPersisted(provider: string, sessionId: string): void {
		const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
		this.#persistedSticky.get(provider)?.delete(sessionId);
		try {
			this.#store.setCache(cacheKey, "", 0);
		} catch (err) {
			logger.debug("Failed to clear session sticky credential from persistent store cache", { err });
		}
	}

	activeOAuth(provider: string, sessionId?: string): OAuthCredential | undefined {
		const allCredentials = this.#pool.credentials(provider);
		const usable = (credential: AuthCredential, index: number): credential is OAuthCredential =>
			credential.type === "oauth" &&
			!this.#blocks.isHeld(provider, index) &&
			this.allows(provider, sessionId, credential);
		if (
			!allCredentials.some(credential => credential.type === "oauth" && this.allows(provider, sessionId, credential))
		)
			return undefined;

		// Runtime / config overrides bypass OAuth account_uuid attribution — the
		// caller is authenticating with an explicit key, not the broker's OAuth.
		// A restricted session skips a runtime key, and a config key fails it
		// closed (see `KeyCascade.get`).
		const restricted = this.isRestricted(provider, sessionId);
		if (this.#overrides.suppressesOAuth(provider, restricted)) return undefined;

		// Prefer the session-sticky credential when available.
		const sessionPref = this.get(provider, sessionId);
		// If the session has been routed to a stored API key, do not inject OAuth account_uuid.
		if (sessionPref !== undefined && sessionPref.type !== "oauth") return undefined;

		// When no session-sticky credential is recorded yet (first call before any getApiKey,
		// or all stored credentials are unavailable), the request falls through to the env-key
		// path in getApiKey(), which is not OAuth-authenticated, so account_uuid injection
		// would misattribute traffic. Only apply this guard when sessionPref is absent; a
		// recorded OAuth sticky (sessionPref.type === "oauth") must NOT be blocked even if an
		// env key also happens to exist. A restricted session never falls through to it.
		if (!restricted && !sessionPref && getEnvApiKey(provider)) return undefined;
		// Resolve the sticky index against the full credential list — the index is
		// recorded against the unfiltered provider array (by record /
		// CredentialSelector.tryOAuth), not the OAuth-only subset, so dereferencing it into the
		// filtered array would be off-by-N when any non-OAuth credential precedes the
		// OAuth ones (e.g. [api_key, oauth_A, oauth_B] stored order).
		// A held account is never the active one, even when a pin (live, or
		// restored from a session file) names it: the next request resolves
		// around it and re-records the pin.
		if (sessionPref !== undefined) {
			const stickyCredential = allCredentials[sessionPref.index];
			if (stickyCredential !== undefined && usable(stickyCredential, sessionPref.index)) return stickyCredential;
		}
		return allCredentials.find(usable);
	}

	/**
	 * Durable row id of the OAuth account this session is pinned to. Undefined
	 * before the session has resolved or pinned one, and while the pinned
	 * account is on hold: a held account is never a session's active one.
	 */
	activeOAuthId(provider: string, sessionId: string | undefined): number | undefined {
		const pin = this.get(provider, sessionId);
		if (pin?.type !== "oauth" || this.#blocks.isHeld(provider, pin.index)) return undefined;
		return this.#pool.entries(provider)[pin.index]?.id;
	}

	/**
	 * Pin one stored OAuth account as this session's preferred credential.
	 *
	 * The durable credential id keeps the pin stable across credential refreshes,
	 * storage reordering, and process restarts. By default this is an explicit
	 * user pin: ranking and account reserve never evict it; hard unavailability
	 * and auth retry may still route around it.
	 *
	 * `options.restoredAtMs` instead restores an automatic affinity recorded by a
	 * persisted session, backdated to its last use, so it keeps the provider's
	 * warm-window semantics: a resume inside the prompt-cache TTL reuses the
	 * account, a stale resume re-ranks. A held account, and one outside a
	 * restricted session's pool, is never pinned: an explicit pin does not
	 * override an allowlist.
	 */
	pin(provider: string, sessionId: string, credentialId: number, options?: { restoredAtMs?: number }): boolean {
		if (!sessionId || this.#overrides.suppressesOAuth(provider, this.isRestricted(provider, sessionId))) {
			return false;
		}
		const stored = this.#pool.entries(provider);
		const index = stored.findIndex(entry => entry.id === credentialId);
		const target = stored[index];
		if (target?.credential.type !== "oauth") return false;
		const restoredAtMs = options?.restoredAtMs;
		return this.record(provider, sessionId, "oauth", index, restoredAtMs, restoredAtMs === undefined);
	}

	/**
	 * Copy stored credential affinities from one live session to another.
	 *
	 * The target receives its own sticky entries, so request resolution, usage
	 * blocking, credential rotation, metadata, and persisted pins all continue
	 * through the target session id without retaining a live dependency on the
	 * source session. `include` limits the copy to the providers it accepts,
	 * given whether the source's affinity is an explicit user pin. A pin outside
	 * the target's restriction is not copied.
	 */
	inherit(
		sourceSessionId: string,
		targetSessionId: string,
		include?: (provider: string, explicit: boolean) => boolean,
	): number {
		if (!sourceSessionId || !targetSessionId || sourceSessionId === targetSessionId) return 0;
		let inherited = 0;
		for (const provider of this.#pool.providers()) {
			const current = this.get(provider, sourceSessionId);
			if (!current) continue;
			// Every pool's pin, the current one last so it stays current: a child forked
			// during a pooled-key detour still knows the subscription account to return to.
			const other = this.get(provider, sourceSessionId, otherPool(current.type));
			let recorded = false;
			for (const credential of other ? [other, current] : [current]) {
				if (include && !include(provider, credential.explicit === true)) continue;
				recorded =
					this.record(
						provider,
						targetSessionId,
						credential.type,
						credential.index,
						credential.lastUsedAtMs,
						credential.explicit === true,
					) || recorded;
			}
			if (recorded) inherited += 1;
		}
		return inherited;
	}

	/**
	 * Release a session's sticky credentials so its next `KeyCascade.get` call
	 * re-runs native pool ranking. This never blocks or penalizes the released
	 * account; usage-aware routing uses it when another sibling has more
	 * headroom, before considering a model/provider fallback. Unlike a failed
	 * credential's {@link clear}, it drops the pin in every pool: a re-rank that
	 * kept one would hand the session straight back to it.
	 */
	release(provider: string, sessionId: string): boolean {
		if (!this.get(provider, sessionId)) return false;
		this.forget(provider, sessionId);
		this.#clearPersisted(provider, sessionId);
		return true;
	}
}
