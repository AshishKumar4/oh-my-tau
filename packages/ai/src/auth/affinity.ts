import { logger } from "@oh-my-pi/pi-utils";
import { getEnvApiKey } from "../stream";
import type { AuthCredential, OAuthCredential, SessionsApi } from "./types";
import type { AuthCredentialStore } from "./store";
import type { CredentialBlocks } from "./blocks";
import type { CredentialPool } from "./pool";
import type { KeyOverrides } from "./cascade";

/** Prefix for persisted session-to-credential affinity. */
export const SESSION_STICKY_CACHE_PREFIX = "session:sticky:";
/** Persisted sticky rows live this long past their last use. */
const SESSION_STICKY_TTL_SEC = 30 * 24 * 60 * 60;
/**
 * Same-credential re-records rewrite the persisted row at most this often. The
 * in-memory sticky stays exact; only the copy other processes resume from lags.
 */
const SESSION_STICKY_PERSIST_INTERVAL_MS = 60_000;

/** What this process last wrote (or read) for one persisted sticky row. */
type PersistedSticky = {
	type: AuthCredential["type"];
	credentialId: number;
	explicit: boolean;
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

/** Session → credential affinity (pins), persisted in the store cache. */
export class SessionAffinity implements SessionsApi {
	/** Each session's pins per provider (used for rate-limit switching). */
	#sessionPins: Map<string, Map<string, SessionPins>> = new Map();
	/** Persisted sticky rows keyed by cache key, so unchanged re-records skip the write. */
	#persistedSticky: Map<string, PersistedSticky> = new Map();
	#store: AuthCredentialStore;
	#pool: CredentialPool;
	#overrides: KeyOverrides;
	#blocks: CredentialBlocks;

	constructor(store: AuthCredentialStore, pool: CredentialPool, overrides: KeyOverrides, blocks: CredentialBlocks) {
		this.#store = store;
		this.#pool = pool;
		this.#overrides = overrides;
		this.#blocks = blocks;
	}

	/** Drop only this session's in-memory pins after OAuth selection falls through. */
	forget(provider: string, sessionId: string): void {
		this.#sessionPins.get(provider)?.delete(sessionId);
	}

	/**
	 * Records which credential was used for a session (for rate-limit switching).
	 * `lastUsedAtMs` backdates the sticky (session-file pin restores on resume);
	 * it defaults to now for live selections. Automatic re-recording of the same
	 * durable row preserves an explicit user pin. A held account is never
	 * pinned: returns whether the pin was recorded.
	 *
	 * The in-memory sticky is always exact. The persisted row is rewritten only
	 * when the credential, its type, or explicitness changes, or when the stored
	 * last-use drifts by {@link SESSION_STICKY_PERSIST_INTERVAL_MS} — per-request
	 * rewrites were pure database churn.
	 */
	record(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
		index: number,
		lastUsedAtMs?: number,
		explicit = false,
	): boolean {
		if (!sessionId || this.#blocks.isHeld(provider, index)) return false;
		const nowMs = lastUsedAtMs ?? Date.now();
		const credentialId = this.#pool.entries(provider)[index]?.id;
		const sessionMap = this.#sessionPins.get(provider) ?? new Map<string, SessionPins>();
		const pins = sessionMap.get(sessionId);
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
		sessionMap.set(sessionId, { current: type, byPool: { ...pins?.byPool, [type]: sessionCredential } });
		this.#sessionPins.set(provider, sessionMap);
		if (credentialId !== undefined) this.#persist(provider, sessionId, sessionCredential, credentialId);
		return true;
	}

	/** Writes the pin other processes resume from: the session's current one. */
	#persist(provider: string, sessionId: string, sessionCredential: SessionCredential, credentialId: number): void {
		const { type } = sessionCredential;
		const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
		const lastUsedAtMs = sessionCredential.lastUsedAtMs ?? Date.now();
		const explicit = sessionCredential.explicit === true;
		const expiresAtSec = Math.floor(lastUsedAtMs / 1000) + SESSION_STICKY_TTL_SEC;
		const persisted = this.#persistedSticky.get(cacheKey);
		if (
			persisted &&
			persisted.type === type &&
			persisted.credentialId === credentialId &&
			persisted.explicit === explicit &&
			Math.abs(lastUsedAtMs - persisted.lastUsedAtMs) < SESSION_STICKY_PERSIST_INTERVAL_MS
		) {
			return;
		}
		try {
			this.#store.setCache(cacheKey, JSON.stringify(sessionCredential), expiresAtSec);
			this.#persistedSticky.set(cacheKey, { type, credentialId, explicit, lastUsedAtMs });
		} catch (err) {
			this.#persistedSticky.delete(cacheKey);
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
		if (pins.current !== type) return;
		const remaining = Object.values(pins.byPool).find(pin => pin !== undefined);
		if (remaining) {
			pins.current = remaining.type;
			if (remaining.credentialId !== undefined) {
				this.#persist(provider, sessionId, remaining, remaining.credentialId);
			}
			return;
		}
		sessionMap.delete(sessionId);
		if (sessionMap.size === 0) this.#sessionPins.delete(provider);
	}

	/**
	 * Retrieves the credential a session used last, or with `pool` its pin in that
	 * pool: the account a selection from that pool keeps while it stays usable.
	 */
	get(provider: string, sessionId: string | undefined, pool?: AuthCredential["type"]): SessionCredential | undefined {
		if (!sessionId) return undefined;
		let sessionMap = this.#sessionPins.get(provider);
		const pins = sessionMap?.get(sessionId);
		if (pins) {
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
				return pool === undefined ? this.get(provider, sessionId) : undefined;
			}
			live.index = actualIndex;
			return live;
		}
		try {
			const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
			const raw = this.#store.getCache(cacheKey);
			if (raw) {
				const val = JSON.parse(raw) as SessionCredential;

				if (val.credentialId !== undefined) {
					const stored = this.#pool.entries(provider);
					const actualIndex = stored.findIndex(entry => entry.id === val.credentialId);
					if (actualIndex === -1 || stored[actualIndex]?.credential.type !== val.type) {
						this.#persistedSticky.delete(cacheKey);
						this.#store.setCache(cacheKey, "", 0);
						return undefined;
					}
					val.index = actualIndex;
				} else {
					// Fallback: drop unsafe index-only cache rows to prevent wrong-account routing
					this.#persistedSticky.delete(cacheKey);
					this.#store.setCache(cacheKey, "", 0);
					return undefined;
				}

				if (!sessionMap) {
					sessionMap = new Map();
					this.#sessionPins.set(provider, sessionMap);
				}
				const sessionVal: SessionCredential = {
					type: val.type,
					index: val.index,
					credentialId: val.credentialId,
					lastUsedAtMs: val.lastUsedAtMs,
					...(val.explicit === true ? { explicit: true } : {}),
				};
				if (typeof val.lastUsedAtMs === "number") {
					this.#persistedSticky.set(cacheKey, {
						type: val.type,
						credentialId: val.credentialId,
						explicit: val.explicit === true,
						lastUsedAtMs: val.lastUsedAtMs,
					});
				}
				sessionMap.set(sessionId, { current: sessionVal.type, byPool: { [sessionVal.type]: sessionVal } });
				return pool === undefined || pool === sessionVal.type ? sessionVal : undefined;
			}
		} catch (err) {
			logger.debug("Failed to read session sticky credential from persistent store cache", { err });
		}
		return undefined;
	}

	/**
	 * Clears the credential a session used last for a provider. Its pin in the
	 * provider's other pool, if any, becomes current.
	 */
	clear(provider: string, sessionId: string | undefined): void {
		if (!sessionId) return;
		const pins = this.#sessionPins.get(provider)?.get(sessionId);
		if (pins) this.#drop(provider, sessionId, pins.current);
		// A promoted pin with a durable row id was persisted by the drop.
		const remaining = this.#sessionPins.get(provider)?.get(sessionId);
		if (remaining?.byPool[remaining.current]?.credentialId !== undefined) return;
		this.#clearPersisted(provider, sessionId);
	}

	#clearPersisted(provider: string, sessionId: string): void {
		const cacheKey = `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
		this.#persistedSticky.delete(cacheKey);
		try {
			this.#store.setCache(cacheKey, "", 0);
		} catch (err) {
			logger.debug("Failed to clear session sticky credential from persistent store cache", { err });
		}
	}

	activeOAuth(provider: string, sessionId?: string): OAuthCredential | undefined {
		const allCredentials = this.#pool.credentials(provider);
		if (!allCredentials.some(credential => credential.type === "oauth")) return undefined;

		// Runtime / config overrides bypass OAuth account_uuid attribution — the
		// caller is authenticating with an explicit key, not the broker's OAuth.
		if (this.#overrides.has(provider)) return undefined;

		// Prefer the session-sticky credential when available.
		const sessionPref = this.get(provider, sessionId);
		// If the session has been routed to a stored API key, do not inject OAuth account_uuid.
		if (sessionPref !== undefined && sessionPref.type !== "oauth") return undefined;

		// When no session-sticky credential is recorded yet (first call before any getApiKey,
		// or all stored credentials are unavailable), the request falls through to the env-key
		// path in getApiKey(), which is not OAuth-authenticated, so account_uuid injection
		// would misattribute traffic. Only apply this guard when sessionPref is absent; a
		// recorded OAuth sticky (sessionPref.type === "oauth") must NOT be blocked even if an
		// env key also happens to exist.
		if (!sessionPref && getEnvApiKey(provider)) return undefined;
		// Resolve the sticky index against the full credential list — the index is
		// recorded against the unfiltered provider array (by record /
		// CredentialSelector.tryOAuth), not the OAuth-only subset, so dereferencing it into the
		// filtered array would be off-by-N when any non-OAuth credential precedes the
		// OAuth ones (e.g. [api_key, oauth_A, oauth_B] stored order).
		// A held account is never the active one, even when a pin (live, or
		// restored from a session file) names it: the next request resolves
		// around it and re-records the pin.
		const stickyCredential =
			sessionPref?.type === "oauth" && !this.#blocks.isHeld(provider, sessionPref.index)
				? allCredentials[sessionPref.index]
				: undefined;
		if (stickyCredential?.type === "oauth") return stickyCredential;
		return allCredentials.find(
			(credential, index): credential is OAuthCredential =>
				credential.type === "oauth" && !this.#blocks.isHeld(provider, index),
		);
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
	 * account, a stale resume re-ranks. A held account is never pinned.
	 */
	pin(provider: string, sessionId: string, credentialId: number, options?: { restoredAtMs?: number }): boolean {
		if (!sessionId || this.#overrides.has(provider)) {
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
	 * source session. `include` selects providers by whether the source affinity
	 * is an explicit user pin.
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
			const other = this.get(provider, sourceSessionId, current.type === "oauth" ? "api_key" : "oauth");
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
