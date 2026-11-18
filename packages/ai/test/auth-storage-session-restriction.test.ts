import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, resolveCredentialIdentityKey, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";

const PROVIDER = "unit-oauth-restrict";

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("AuthStorage session account restrictions", () => {
	let tempDir = "";
	let stores: SqliteAuthCredentialStore[] = [];
	let storage: AuthStorage;
	/** Access tokens the OAuth exchange was asked to serve, in order. */
	let exchanged: string[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-session-restrict-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		stores = [store];
		storage = new AuthStorage(store);
		exchanged = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (credential) exchanged.push(credential.access);
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const store of stores) store.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("serves only allowed accounts, over inherited and explicit pins", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected stored accounts");
		expect(storage.sessions.pin(PROVIDER, "parent", accountB.credentialId)).toBe(true);
		expect(storage.sessions.inherit("parent", "child")).toBe(1);

		storage.sessions.restrict(PROVIDER, "child", ["account:acc-c"]);

		expect(storage.oauth.identity(PROVIDER, "child")?.accountId).toBe("acc-c");
		expect(await storage.keys.get(PROVIDER, "child")).toBe("access-c");
		expect(storage.sessions.pin(PROVIDER, "child", accountA.credentialId)).toBe(false);
		expect(await storage.keys.get(PROVIDER, "child")).toBe("access-c");
		// Excluded accounts are never ranked, refreshed, or exchanged for the child.
		expect(exchanged).toEqual(["access-c", "access-c"]);
		// The parent keeps its own pin; restrictions are per session.
		expect(await storage.keys.get(PROVIDER, "parent")).toBe("access-b");
	});

	test("skips a runtime key and stored API keys, and fails closed past a config key", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), { type: "api_key", key: "stored-key" }]);
		storage.keys.setRuntime(PROVIDER, "runtime-key");

		storage.sessions.restrict(PROVIDER, "allowed", ["account:acc-a"]);
		const missing = storage.sessions.restrict(PROVIDER, "missing", ["account:acc-z"]);
		storage.sessions.restrict(PROVIDER, "empty", []);

		expect(await storage.keys.get(PROVIDER, "allowed")).toBe("access-a");
		// Metadata, usage attribution, and OAuth-access callers (web search) follow
		// the account the request uses, not the runtime key.
		expect(storage.oauth.identity(PROVIDER, "allowed")?.accountId).toBe("acc-a");
		expect((await storage.oauth.access(PROVIDER, "allowed"))?.accessToken).toBe("access-a");
		for (const sessionId of ["missing", "empty"]) {
			await expect(storage.keys.get(PROVIDER, sessionId)).rejects.toThrow(
				`No API key for provider: ${PROVIDER} (session ${sessionId} is restricted to its OAuth account pool`,
			);
		}
		expect(await storage.keys.get(PROVIDER, "unrestricted")).toBe("runtime-key");

		// The owner lifts a restriction when its session ends.
		storage.sessions.unrestrict(PROVIDER, "missing", missing);
		expect(await storage.keys.get(PROVIDER, "missing")).toBe("runtime-key");

		// A config key marks the provider's endpoint (often a proxy) as taking that
		// key: the pooled session fails rather than sending it an OAuth token.
		storage.keys.setConfig(PROVIDER, "config-key");
		await expect(storage.keys.get(PROVIDER, "allowed")).rejects.toThrow("pooled OAuth tokens are never sent past it");
		expect(await storage.oauth.access(PROVIDER, "allowed")).toBeUndefined();
		expect(storage.oauth.identity(PROVIDER, "allowed")).toBeUndefined();
		expect(await storage.keys.get(PROVIDER, "unrestricted")).toBe("runtime-key");
	});

	test("refuses a restored automatic pin outside the pool, as a fork's credential pin restores one", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected stored accounts");
		storage.sessions.restrict(PROVIDER, "child", ["account:acc-b"]);

		expect(storage.sessions.pin(PROVIDER, "child", accountA.credentialId, { restoredAtMs: Date.now() })).toBe(false);
		expect(storage.sessions.pin(PROVIDER, "child", accountB.credentialId, { restoredAtMs: Date.now() })).toBe(true);
		expect(await storage.keys.get(PROVIDER, "child")).toBe("access-b");
	});

	test("lifts a restriction only with the lease that installed it", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		storage.keys.setRuntime(PROVIDER, "runtime-key");
		const stale = storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);
		// A revived owner restricts the same session id again.
		const current = storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);

		storage.sessions.unrestrict(PROVIDER, "session", stale);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("access-b");

		storage.sessions.unrestrict(PROVIDER, "session", current);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("runtime-key");
	});

	test("rotates only among allowed accounts", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		storage.sessions.restrict(PROVIDER, "session", ["account:acc-a", "account:acc-b"]);

		const allowedKeys = ["access-a", "access-b"];
		const first = await storage.keys.get(PROVIDER, "session");
		expect(allowedKeys).toContain(first ?? "");
		expect((await storage.limits.markReached(PROVIDER, "session", { retryAfterMs: 60_000 })).switched).toBe(true);
		const second = await storage.keys.get(PROVIDER, "session");
		expect(allowedKeys).toContain(second ?? "");
		expect(second).not.toBe(first);

		// Account c is free, but outside the pool: no sibling is left to switch to,
		// and the last-resort pass retries a blocked allowed account instead.
		expect((await storage.limits.markReached(PROVIDER, "session", { retryAfterMs: 60_000 })).switched).toBe(false);
		expect(allowedKeys).toContain((await storage.keys.get(PROVIDER, "session")) ?? "");
	});

	test("judges model entitlements over the session's allowed accounts when rotating", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		storage.sessions.restrict(PROVIDER, "session", ["account:acc-a", "account:acc-b"]);
		// The model names only C, which the session may not use, so neither allowed account is entitled.
		const accountIds = ["acc-c"];

		const first = await storage.keys.get(PROVIDER, "session", { accountIds });
		expect(["access-a", "access-b"]).toContain(first ?? "");
		expect(
			(await storage.limits.markReached(PROVIDER, "session", { retryAfterMs: 60_000, accountIds })).switched,
		).toBe(true);
		const second = await storage.keys.get(PROVIDER, "session", { accountIds });
		expect(["access-a", "access-b"]).toContain(second ?? "");
		expect(second).not.toBe(first);
	});

	test("permits only allowed accounts for a restricted session", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected stored accounts");
		const lease = storage.sessions.restrict(PROVIDER, "session", ["account:acc-a"]);

		expect(storage.sessions.permits(PROVIDER, "session", accountA.credentialId)).toBe(true);
		expect(storage.sessions.permits(PROVIDER, "session", accountB.credentialId)).toBe(false);
		expect(storage.sessions.permits(PROVIDER, "unrestricted", accountB.credentialId)).toBe(true);

		storage.sessions.unrestrict(PROVIDER, "session", lease);
		expect(storage.sessions.permits(PROVIDER, "session", accountB.credentialId)).toBe(true);
	});

	test("keeps restrictions across a credential store replacement", async () => {
		storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);
		const replacement = await SqliteAuthCredentialStore.open(path.join(tempDir, "replacement.db"));
		stores.push(replacement);
		await storage.replaceStore(replacement);
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [accountA] = storage.oauth.accounts(PROVIDER);
		if (!accountA) throw new Error("expected stored accounts");

		expect(storage.sessions.pin(PROVIDER, "session", accountA.credentialId)).toBe(false);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("access-b");
	});
});

describe("AuthStorage session restrictions over the stored pools", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-session-restrict-pools-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store, { poolOrders: { [PROVIDER]: "api-keys-first" } });
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.credentials.set(PROVIDER, [
			oauthCredential("a"),
			oauthCredential("b"),
			{ type: "api_key", key: "pooled-key", source: "login" },
		]);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("serves a restricted session only its OAuth accounts, even when pooled keys serve first", async () => {
		storage.sessions.restrict(PROVIDER, "pooled", ["account:acc-b"]);

		expect(await storage.keys.get(PROVIDER, "free")).toBe("pooled-key");
		expect(await storage.keys.get(PROVIDER, "pooled")).toBe("access-b");
		const summary = (sessionId?: string) =>
			storage.limits.pools(PROVIDER, undefined, sessionId).map(pool => [pool.kind, pool.members]);
		expect(summary()).toEqual([
			["api_key", 1],
			["oauth", 2],
		]);
		expect(summary("pooled")).toEqual([["oauth", 1]]);
	});

	test("copies into a restricted child only the pins its pool allows", async () => {
		const accountB = storage.oauth.accounts(PROVIDER).find(account => account.accountId === "acc-b");
		if (!accountB) throw new Error("expected account b");
		// The parent pins B in the subscription pool, then serves from the key pool.
		expect(storage.sessions.pin(PROVIDER, "parent", accountB.credentialId)).toBe(true);
		expect(await storage.keys.get(PROVIDER, "parent")).toBe("pooled-key");

		storage.sessions.restrict(PROVIDER, "pooled-child", ["account:acc-b"]);
		expect(storage.sessions.inherit("parent", "pooled-child")).toBe(1);
		expect(storage.sessions.inherit("parent", "free-child")).toBe(1);

		// An unrestricted child continues on the parent's key.
		expect(await storage.keys.get(PROVIDER, "free-child")).toBe("pooled-key");
		// A restricted child gets only the subscription pin, and resumes on B.
		expect(storage.oauth.accounts(PROVIDER, "pooled-child").find(account => account.active)?.accountId).toBe("acc-b");
		expect(await storage.keys.get(PROVIDER, "pooled-child")).toBe("access-b");
	});

	test("keeps an allowed pin usable when the restriction hides the session's current one", async () => {
		const accountB = storage.oauth.accounts(PROVIDER).find(account => account.accountId === "acc-b");
		if (!accountB) throw new Error("expected account b");
		// B pinned, then a pooled key served: the key is the current pin when the restriction lands.
		expect(storage.sessions.pin(PROVIDER, "session", accountB.credentialId)).toBe(true);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("pooled-key");
		storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);

		const active = (sessionId: string) =>
			storage.oauth.accounts(PROVIDER, sessionId).find(account => account.active)?.accountId;
		expect(active("session")).toBe("acc-b");
		expect(storage.sessions.inherit("session", "child")).toBe(1);
		expect(active("child")).toBe("acc-b");
		expect(storage.sessions.release(PROVIDER, "session")).toBe(true);
		expect(active("session")).toBeUndefined();
	});

	test("bounds in-memory pins per provider; an evicted session resumes its persisted pin", async () => {
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected stored accounts");
		expect(storage.sessions.pin(PROVIDER, "oldest", accountB.credentialId)).toBe(true);
		for (let index = 0; index < 256; index++) {
			expect(storage.sessions.pin(PROVIDER, `session-${index}`, accountA.credentialId)).toBe(true);
		}
		const getCache = vi.spyOn(store, "getCache");

		expect(storage.oauth.accounts(PROVIDER, "session-255").find(account => account.active)?.accountId).toBe("acc-a");
		expect(getCache).not.toHaveBeenCalledWith(`session:sticky:${PROVIDER}:session-255`);
		expect(storage.oauth.accounts(PROVIDER, "oldest").find(account => account.active)?.accountId).toBe("acc-b");
		expect(getCache).toHaveBeenCalledWith(`session:sticky:${PROVIDER}:oldest`);
	});

	test("an evicted session resumes the pins of both pools after a detour through pooled keys", async () => {
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected stored accounts");
		// An explicit subscription pin, then a pooled key serves: the key is current, B waits in the OAuth pool.
		expect(storage.sessions.pin(PROVIDER, "detour", accountB.credentialId)).toBe(true);
		expect(await storage.keys.get(PROVIDER, "detour")).toBe("pooled-key");
		for (let index = 0; index < 256; index++) {
			expect(storage.sessions.pin(PROVIDER, `session-${index}`, accountA.credentialId)).toBe(true);
		}

		// The key goes away: the resumed session falls back to its subscription pin, still explicit.
		const key = storage.credentials.list(PROVIDER).find(row => row.credential.type === "api_key");
		if (!key) throw new Error("expected the pooled key");
		expect(await storage.credentials.removeById(PROVIDER, key.id)).toBe(true);
		expect(storage.oauth.accounts(PROVIDER, "detour").find(account => account.active)?.accountId).toBe("acc-b");
		expect(storage.sessions.inherit("detour", "explicit-only", (_provider, explicit) => explicit)).toBe(1);
	});

	test("an evicted session keeps both pools' pins when a pin or a credential failure comes first", async () => {
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected stored accounts");
		// Each session pins B explicitly, then a pooled key serves: the key is current, B waits.
		for (const sessionId of ["failed-key", "switched"]) {
			expect(storage.sessions.pin(PROVIDER, sessionId, accountB.credentialId)).toBe(true);
			expect(await storage.keys.get(PROVIDER, sessionId)).toBe("pooled-key");
		}
		for (let index = 0; index < 256; index++) {
			expect(storage.sessions.pin(PROVIDER, `session-${index}`, accountA.credentialId)).toBe(true);
		}
		const active = (sessionId: string) =>
			storage.oauth.accounts(PROVIDER, sessionId).find(account => account.active)?.accountId;

		// The key fails first: clearing it promotes the subscription pin instead of dropping both.
		expect(await storage.limits.invalidateMatching(PROVIDER, "pooled-key", { sessionId: "failed-key" })).toBe(true);
		expect(active("failed-key")).toBe("acc-b");

		// A user pin comes first: it replaces the subscription pin and keeps the automatic key pin.
		expect(storage.sessions.pin(PROVIDER, "switched", accountA.credentialId)).toBe(true);
		expect(active("switched")).toBe("acc-a");
		expect(storage.sessions.inherit("switched", "automatic-only", (_provider, explicit) => !explicit)).toBe(1);
	});
});

describe("AuthStorage usage health for a restricted session", () => {
	test("judges a restricted session's own accounts even when a runtime key serves the provider", async () => {
		const usageFetch: typeof fetch = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				const url = new URL(input instanceof Request ? input.url : input.toString());
				if (url.pathname !== "/backend-api/wham/usage") return new Response(null, { status: 404 });
				return Response.json({
					plan_type: "plus",
					rate_limit: {
						allowed: true,
						limit_reached: false,
						primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_after_seconds: 18_000 },
						secondary_window: { used_percent: 95, limit_window_seconds: 604_800, reset_after_seconds: 604_800 },
					},
				});
			},
			{ preconnect: fetch.preconnect },
		);
		const storage = await AuthStorage.create(":memory:", { usageFetch });
		try {
			await storage.credentials.set("openai-codex", {
				type: "oauth",
				access: "access-pool",
				refresh: "refresh-pool",
				expires: Date.now() + 60 * 60_000,
				accountId: "acct-pool",
				email: "pool@example.com",
			});
			storage.keys.setRuntime("openai-codex", "runtime-key");
			const [row] = storage.credentials.list("openai-codex");
			const identityKey = row && resolveCredentialIdentityKey("openai-codex", row.credential);
			if (!identityKey) throw new Error("expected the pooled account's identity key");
			storage.sessions.restrict("openai-codex", "pooled", [identityKey]);
			const options = { reserveFraction: 0.3 };

			// The runtime key bypasses the managed pools for an unrestricted session.
			expect((await storage.health.model("openai-codex", options)).state).toBe("unknown");
			// A restricted session never uses it, so its own account's reserve decides.
			expect(await storage.health.model("openai-codex", { ...options, sessionId: "pooled" })).toMatchObject({
				state: "reserve",
				accounts: [{ state: "reserve" }],
			});
		} finally {
			storage.close();
		}
	});

	test("probes no pooled account past a config key, which fails the session closed", async () => {
		const fetchedUrls: string[] = [];
		const usageFetch: typeof fetch = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				fetchedUrls.push(input instanceof Request ? input.url : input.toString());
				return new Response(null, { status: 404 });
			},
			{ preconnect: fetch.preconnect },
		);
		const storage = await AuthStorage.create(":memory:", { usageFetch });
		try {
			await storage.credentials.set("anthropic", {
				type: "oauth",
				access: "sk-ant-oat01-pooled",
				refresh: "refresh-pooled",
				expires: Date.now() + 60 * 60_000,
				accountId: "acct-pooled",
				email: "pooled@example.com",
			});
			// A models.yml proxy for the provider: its key is the only one requests send there.
			storage.keys.setConfig("anthropic", "proxy-config-key");
			const [row] = storage.credentials.list("anthropic");
			const identityKey = row && resolveCredentialIdentityKey("anthropic", row.credential);
			if (!identityKey) throw new Error("expected the pooled account's identity key");
			storage.sessions.restrict("anthropic", "pooled", [identityKey]);

			expect(
				await storage.health.model("anthropic", {
					sessionId: "pooled",
					baseUrl: "https://claude-proxy.example.test",
					reserveFraction: 0.3,
				}),
			).toEqual({ state: "unknown", accounts: [] });
			expect(fetchedUrls).toEqual([]);
		} finally {
			storage.close();
		}
	});
});
