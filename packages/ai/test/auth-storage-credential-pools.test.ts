import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isAuthRetryableError, resolveApiKeyOnce, resolveRetryKey } from "@oh-my-pi/pi-ai/auth-retry";
import {
	AuthStorage,
	type CredentialPoolOrder,
	type OAuthCredential,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider } from "@oh-my-pi/pi-ai/registry/oauth";
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
});
