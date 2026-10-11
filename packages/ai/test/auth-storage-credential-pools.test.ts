import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isAuthRetryableError, resolveApiKeyOnce, resolveRetryKey } from "@oh-my-pi/pi-ai/auth-retry";
import {
	type AuthCredentialStore,
	AuthStorage,
	type CredentialPoolOrder,
	maskApiKey,
	type OAuthCredential,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider } from "@oh-my-pi/pi-ai/registry/oauth";
import { claudeRankingStrategy } from "@oh-my-pi/pi-ai/usage/claude";
import { cursorRankingStrategy } from "@oh-my-pi/pi-ai/usage/cursor";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "unit-credential-pools";

registerOAuthProvider({
	id: PROVIDER,
	name: "Unit credential pools",
	login: async () => ({ access: "login-access", refresh: "login-refresh", expires: Date.now() + 3_600_000 }),
	refreshToken: async credentials => credentials,
	getApiKey: credentials => credentials.access,
});

// Anthropic's prepaid-credit exhaustion: a 400 that must rotate, not fail as a bad request.
const creditsExhausted = Object.assign(
	new Error(
		'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
	),
	{ status: 400 },
);
const subscriptionExhausted = Object.assign(new Error("429 usage limit reached for your plan. Try again in 158 min."), {
	status: 429,
});
const perMinuteThrottle = Object.assign(new Error("429 rate_limit_error: too many requests per minute"), {
	status: 429,
});

function oauth(email: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${email}`,
		refresh: `refresh-${email}`,
		expires: Date.now() + 3_600_000,
		email,
	};
}

describe("provider credential pools", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	async function open(order?: CredentialPoolOrder): Promise<AuthStorage> {
		storage?.close();
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store, order ? { poolOrders: { [PROVIDER]: order } } : {});
		await storage.credentials.reload();
		return storage;
	}

	/** Serve the session, failing each served credential with the error its pool returns, until nothing is left. */
	async function drain(sessionId: string): Promise<string[]> {
		const served: string[] = [];
		const resolve = storage.keys.resolver(PROVIDER, { sessionId });
		let current = await resolveApiKeyOnce(resolve);
		while (current !== undefined && served.length < 10) {
			served.push(current);
			const error = current.startsWith("access-") ? subscriptionExhausted : creditsExhausted;
			current = await resolveRetryKey(resolve, true, error, undefined, current);
		}
		return served;
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-credential-pools-"));
	});

	afterEach(async () => {
		storage?.close();
		await removeWithRetries(tempDir);
	});

	it("serves subscriptions first, then every pooled key once each, by default", async () => {
		await open();
		await storage.credentials.upsert(PROVIDER, oauth("max@example.com"));
		for (const key of ["key-a", "key-b", "key-c"]) await storage.credentials.addApiKey(PROVIDER, key);

		const served = await drain("session-1");

		expect(served[0]).toBe("access-max@example.com");
		expect(served.slice(1).sort()).toEqual(["key-a", "key-b", "key-c"]);
	});

	it("serves pooled keys before subscriptions under api-keys-first", async () => {
		await open("api-keys-first");
		await storage.credentials.upsert(PROVIDER, oauth("max@example.com"));
		for (const key of ["key-a", "key-b"]) await storage.credentials.addApiKey(PROVIDER, key);

		const served = await drain("session-1");

		expect(served.slice(0, 2).sort()).toEqual(["key-a", "key-b"]);
		expect(served[2]).toBe("access-max@example.com");
		expect(served).toHaveLength(3);
	});

	it("keeps a session on its working key and rotates only after that key fails", async () => {
		await open("api-keys-first");
		for (const key of ["key-a", "key-b", "key-c"]) await storage.credentials.addApiKey(PROVIDER, key);
		const resolve = storage.keys.resolver(PROVIDER, { sessionId: "session-1" });

		const first = await resolveApiKeyOnce(resolve);
		expect(await storage.keys.get(PROVIDER, "session-1")).toBe(first);
		expect(await storage.keys.get(PROVIDER, "session-1")).toBe(first);

		const next = await resolveRetryKey(resolve, true, creditsExhausted, undefined, first);
		expect(next).toBeDefined();
		expect(next).not.toBe(first);
		expect(await storage.keys.get(PROVIDER, "session-1")).toBe(next);
	});

	it("does not rotate a key on a per-minute throttle", async () => {
		await open("api-keys-first");
		for (const key of ["key-a", "key-b"]) await storage.credentials.addApiKey(PROVIDER, key);
		const resolve = storage.keys.resolver(PROVIDER, { sessionId: "session-1" });
		const first = await resolveApiKeyOnce(resolve);

		// A throttle is not an auth failure, so the retry driver never asks the
		// resolver to rotate; its first refresh step stays on the same key.
		expect(isAuthRetryableError(perMinuteThrottle)).toBe(false);
		expect(await resolveRetryKey(resolve, false, perMinuteThrottle, undefined, first)).toBe(first);
		expect(await storage.keys.get(PROVIDER, "session-1")).toBe(first);
		expect(storage.limits.pools(PROVIDER).find(pool => pool.kind === "api_key")?.blocked).toBe(0);
	});

	it("reports every pool exhausted with the earliest retry time once both pools fail", async () => {
		await open();
		await storage.credentials.upsert(PROVIDER, oauth("max@example.com"));
		for (const key of ["key-a", "key-b"]) await storage.credentials.addApiKey(PROVIDER, key);

		await drain("session-1");

		const pools = storage.limits.pools(PROVIDER);
		expect(pools.map(pool => [pool.kind, pool.members, pool.blocked])).toEqual([
			["oauth", 1, 1],
			["api_key", 2, 2],
		]);
		expect(pools.every(pool => pool.retryAtMs !== undefined && pool.retryAtMs > Date.now())).toBe(true);
	});

	it("keeps pooled keys through an OAuth login and keeps subscriptions through key adds", async () => {
		await open();
		await storage.credentials.addApiKey(PROVIDER, "key-a");
		await storage.oauth.login(PROVIDER, { onAuth: () => {}, onPrompt: async () => "" });
		await storage.credentials.addApiKey(PROVIDER, "key-b");
		await storage.credentials.addApiKey(PROVIDER, "key-a");

		await open();
		expect(storage.credentials.pooledApiKeys(PROVIDER).map(row => row.credential.key)).toEqual(["key-a", "key-b"]);
		expect(storage.credentials.list(PROVIDER).filter(row => row.credential.type === "oauth")).toHaveLength(1);
	});

	it("keeps legacy static keys out of the pool and replaces them on OAuth login", async () => {
		await open();
		await storage.credentials.set(PROVIDER, { type: "api_key", key: "migrated-key" });
		await storage.credentials.addApiKey(PROVIDER, "pooled-key");

		expect(storage.credentials.pooledApiKeys(PROVIDER).map(row => row.credential.key)).toEqual(["pooled-key"]);

		await storage.oauth.login(PROVIDER, { onAuth: () => {}, onPrompt: async () => "" });
		await open();
		const keys = storage.credentials
			.list(PROVIDER)
			.flatMap(row => (row.credential.type === "api_key" ? [row.credential.key] : []));
		expect(keys).toEqual(["pooled-key"]);
	});

	it("applies a live pool-order change to the next resolution", async () => {
		await open();
		await storage.credentials.upsert(PROVIDER, oauth("max@example.com"));
		await storage.credentials.addApiKey(PROVIDER, "key-a");
		expect(await storage.keys.get(PROVIDER)).toBe("access-max@example.com");

		storage.setAccountPolicies({
			accountPolicies: [],
			defaultReservePct: 10,
			poolOrders: { [PROVIDER]: "api-keys-first" },
		});

		expect(await storage.keys.get(PROVIDER)).toBe("key-a");
		expect(storage.keys.source(PROVIDER)?.kind).toBe("api_key");
	});

	it("promotes a stored static key to the pool when the same key is added", async () => {
		await open();
		await storage.credentials.set(PROVIDER, { type: "api_key", key: "same-key" });
		expect(storage.credentials.pooledApiKeys(PROVIDER)).toEqual([]);

		await storage.credentials.addApiKey(PROVIDER, "same-key");

		expect(storage.credentials.pooledApiKeys(PROVIDER).map(row => row.credential.key)).toEqual(["same-key"]);
	});

	it("never shows a whole key, however short or oddly shaped", () => {
		for (const key of ["secret-", "alpha-beta-", "short", "sk-ant-api03-tinykey"]) {
			const masked = maskApiKey(key);
			expect(masked.includes(key)).toBe(false);
			expect(masked.length).toBeLessThan(key.length);
		}
		expect(maskApiKey("sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV1234")).toBe("sk-ant-…1234");
	});
});

describe("provider credential pools with Claude usage scopes", () => {
	let tempDir = "";
	let storage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-credential-pools-claude-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store, {
			poolOrders: { anthropic: "api-keys-first" },
			// No usage endpoint: pooled keys have no report, so health reads them as unknown.
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: provider => (provider === "anthropic" ? claudeRankingStrategy : undefined),
			configValueResolver: async value => value,
		});
		await storage.credentials.reload();
	});

	afterEach(async () => {
		storage.close();
		await removeWithRetries(tempDir);
	});

	it("blocks an out-of-credit key for every model, not only the model that failed", async () => {
		for (const key of ["sk-ant-api03-keyAAAAAAAAAAAAAAAA1", "sk-ant-api03-keyBBBBBBBBBBBBBBBB2"]) {
			await storage.credentials.addApiKey("anthropic", key);
		}
		const fable = storage.keys.resolver("anthropic", { sessionId: "s1", modelId: "claude-fable-5" });
		const spent = await resolveApiKeyOnce(fable);
		await resolveRetryKey(fable, true, creditsExhausted, undefined, spent);

		const opusKey = await storage.keys.get("anthropic", "s2", { modelId: "claude-opus-5-5" });
		expect(opusKey).toBeDefined();
		expect(opusKey).not.toBe(spent);
		expect(storage.limits.pools("anthropic", "claude-opus-5-5")).toEqual([
			{ kind: "api_key", members: 2, blocked: 1 },
		]);
	});

	it("does not read the model as depleted while the other pool can serve", async () => {
		await storage.credentials.addApiKey("anthropic", "sk-ant-api03-keyAAAAAAAAAAAAAAAA1");
		await storage.credentials.upsert("anthropic", oauth("max@example.com"));
		storage.setAccountPolicies({ accountPolicies: [], defaultReservePct: 10, poolOrders: {} });
		const resolve = storage.keys.resolver("anthropic", { sessionId: "s1", modelId: "claude-opus-5-5" });
		const subscription = await resolveApiKeyOnce(resolve);
		expect(subscription).toBe("access-max@example.com");
		await resolveRetryKey(resolve, true, subscriptionExhausted, undefined, subscription);

		const health = await storage.health.model("anthropic", { modelId: "claude-opus-5-5", reserveFraction: 0.1 });

		expect(health.state).not.toBe("depleted");
		expect(health.accounts.map(account => account.credentialType).sort()).toEqual(["api_key", "oauth"]);
	});

	it("counts only entitled subscription accounts as a switch after the keys run out", async () => {
		await storage.credentials.addApiKey("anthropic", "sk-ant-api03-keyAAAAAAAAAAAAAAAA1");
		await storage.credentials.upsert("anthropic", { ...oauth("entitled@example.com"), accountId: "acct-entitled" });
		await storage.credentials.upsert("anthropic", { ...oauth("other@example.com"), accountId: "acct-other" });
		const entitledIndex = storage.credentials
			.list("anthropic")
			.findIndex(row => row.credential.type === "oauth" && row.credential.accountId === "acct-entitled");
		await storage.limits.markReached("anthropic", undefined, {
			credentialId: storage.credentials.list("anthropic")[entitledIndex]?.id,
			retryAfterMs: 3_600_000,
			modelId: "claude-opus-5-5",
		});

		const rotation = await storage.limits.rotate("anthropic", "s1", {
			error: creditsExhausted,
			modelId: "claude-opus-5-5",
			accountIds: ["acct-entitled"],
			apiKey: "sk-ant-api03-keyAAAAAAAAAAAAAAAA1",
		});

		expect(rotation.switched).toBe(false);
	});

	it("does not count a static key as a sibling of an exhausted pooled key", async () => {
		await storage.credentials.set("anthropic", { type: "api_key", key: "sk-ant-api03-staticMIGRATEDkey000" });
		await storage.credentials.addApiKey("anthropic", "sk-ant-api03-keyAAAAAAAAAAAAAAAA1");

		const rotation = await storage.limits.rotate("anthropic", "s1", {
			error: creditsExhausted,
			modelId: "claude-opus-5-5",
			apiKey: "sk-ant-api03-keyAAAAAAAAAAAAAAAA1",
		});

		expect(rotation.switched).toBe(false);
	});
});

describe("provider credential pools with model-scoped key quotas", () => {
	let tempDir = "";
	let storage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-credential-pools-cursor-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: provider => (provider === "cursor" ? cursorRankingStrategy : undefined),
			configValueResolver: async value => value,
		});
		await storage.credentials.reload();
		await storage.credentials.addApiKey("cursor", "cursor-key-AAAAAAAAAAAAAAAAAAAA");
	});

	afterEach(async () => {
		storage.close();
		await removeWithRetries(tempDir);
	});

	it("keeps a model quota-pool exhaustion scoped to that pool", async () => {
		await storage.limits.markReached("cursor", undefined, {
			apiKey: "cursor-key-AAAAAAAAAAAAAAAAAAAA",
			modelId: "claude-opus-5-5",
			errorMessage: "429 You have reached your usage limit for other models. Try again in 2 hours.",
		});

		const blockedOn = (modelId: string) => storage.limits.pools("cursor", modelId)[0]?.blocked;
		expect(blockedOn("claude-opus-5-5")).toBe(1);
		expect(blockedOn("composer-2.5")).toBe(0);
	});

	it("blocks the key for every model when its prepaid balance is used up", async () => {
		await storage.limits.markReached("cursor", undefined, {
			apiKey: "cursor-key-AAAAAAAAAAAAAAAAAAAA",
			modelId: "claude-opus-5-5",
			errorMessage: "429 Your prepaid balance is used up: Add funds or enable auto top-up",
		});

		expect(storage.limits.pools("cursor", "composer-2.5")[0]?.blocked).toBe(1);
	});
});

const STRICT_PROVIDER = "unit-credential-pools-strict";

registerOAuthProvider({
	id: STRICT_PROVIDER,
	name: "Unit credential pools strict",
	login: async () => ({ access: "", refresh: "", expires: 0 }),
	refreshToken: async credentials => {
		if (credentials.access === "oauth-a") throw new Error("invalid_grant: refresh token revoked");
		return credentials;
	},
	getApiKey: credentials => credentials.access,
});

describe("provider credential pools across a definitive OAuth refresh failure", () => {
	it("serves a pooled key instead of a blocked subscription when the last usable one dies mid-selection", async () => {
		const sqlite = await SqliteAuthCredentialStore.open(":memory:");
		// A remote-broker-shaped store: no refresh leases, and a request hook that
		// lets the selected token go stale after preflight (an imminent rotation).
		const store: AuthCredentialStore = {
			close: () => sqlite.close(),
			listAuthCredentials: provider => sqlite.listAuthCredentials(provider),
			updateAuthCredential: (id, credential) => sqlite.updateAuthCredential(id, credential),
			deleteAuthCredential: (id, cause) => sqlite.deleteAuthCredential(id, cause),
			tryDisableAuthCredentialIfMatches: (...args) => sqlite.tryDisableAuthCredentialIfMatches(...args),
			replaceAuthCredentials: (provider, credentials) => sqlite.replaceAuthCredentials(provider, credentials),
			upsertAuthCredential: (provider, credential) => sqlite.upsertAuthCredential(provider, credential),
			deleteAuthCredentials: (provider, cause) => sqlite.deleteAuthCredentials(provider, cause),
			getCache: (key, options) => sqlite.getCache(key, options),
			setCache: (key, value, expiresAtSec) => sqlite.setCache(key, value, expiresAtSec),
			cleanExpiredCache: () => sqlite.cleanExpiredCache(),
			getCredentialBlock: (...args) => sqlite.getCredentialBlock(...args),
			upsertCredentialBlock: block => sqlite.upsertCredentialBlock(block),
			deleteCredentialBlock: (...args) => sqlite.deleteCredentialBlock(...args),
			async prepareForRequest(credentialId) {
				const row = sqlite.listAuthCredentials(STRICT_PROVIDER).find(entry => entry.id === credentialId);
				if (row?.credential.type === "oauth" && row.credential.access === "oauth-a") {
					sqlite.updateAuthCredential(credentialId, { ...row.credential, expires: 0 });
				}
				return false;
			},
		};
		const storage = new AuthStorage(store);
		try {
			const live = { refresh: "r", expires: Date.now() + 3_600_000 };
			await storage.credentials.upsert(STRICT_PROVIDER, {
				type: "oauth",
				access: "oauth-a",
				...live,
				email: "a@example.com",
			});
			await storage.credentials.upsert(STRICT_PROVIDER, {
				type: "oauth",
				access: "oauth-b",
				...live,
				email: "b@example.com",
			});
			await storage.credentials.addApiKey(STRICT_PROVIDER, "usable-api-key");
			const blocked = storage.credentials
				.list(STRICT_PROVIDER)
				.find(row => row.credential.type === "oauth" && row.credential.access === "oauth-b");
			await storage.limits.markReached(STRICT_PROVIDER, undefined, {
				credentialId: blocked?.id,
				retryAfterMs: 600_000,
			});

			expect(await storage.keys.get(STRICT_PROVIDER, "session-1")).toBe("usable-api-key");
		} finally {
			storage.close();
		}
	});
});
