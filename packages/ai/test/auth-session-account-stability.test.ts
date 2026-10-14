// A session keeps the account it warmed a prompt cache on until that account
// itself needs protecting: near its own reserve, exhausted now, or gone.
// Moving it for any other reason re-sends the whole prompt uncached.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { resolveApiKeyOnce, resolveRetryKey } from "@oh-my-pi/pi-ai/auth-retry";
import { AuthStorage, type CredentialPoolOrder, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { OAuthCredential } from "@oh-my-pi/pi-ai/auth/types";
import type { Provider } from "@oh-my-pi/pi-ai/types";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { logger } from "@oh-my-pi/pi-utils";

const HOUR_MS = 60 * 60_000;

/** Store double whose usage reports come from the test, per account. */
class ReportingStore extends SqliteAuthCredentialStore {
	reports = new Map<string, UsageReport>();
	async getUsageReport(_provider: Provider, credential: OAuthCredential): Promise<UsageReport | null> {
		return this.reports.get(credential.accountId ?? "") ?? null;
	}
}

const stores: ReportingStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	vi.restoreAllMocks();
});

function account(id: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${id}`,
		refresh: `refresh-${id}`,
		expires: Date.now() + 24 * HOUR_MS,
		accountId: id,
		email: `${id}@example.com`,
	};
}

/** A weekly window `used` full, observed at `fetchedAt`, resetting at `resetsAt`. */
function weekly(id: string, used: number, resetsAt = Date.now() + HOUR_MS, fetchedAt = Date.now()): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt,
		metadata: { accountId: id },
		limits: [
			{
				id: "anthropic:7d",
				label: "Claude 7 Day",
				scope: { provider: "anthropic", shared: true, windowId: "7d" },
				window: { id: "7d", label: "7 Day", durationMs: 7 * 24 * HOUR_MS, resetsAt },
				amount: { unit: "percent", used: used * 100, limit: 100, usedFraction: used, remainingFraction: 1 - used },
				status: used >= 1 ? "exhausted" : "ok",
			},
		],
	};
}

function setup(revokedAccount?: string, poolOrder?: CredentialPoolOrder) {
	const store = new ReportingStore(new Database(":memory:"));
	stores.push(store);
	const storage = new AuthStorage(store, {
		...(poolOrder ? { poolOrders: { anthropic: poolOrder } } : {}),
		defaultReservePct: 5,
		// An account policy enables reserve protection for pinned sessions, as in the user's configuration.
		accountPolicies: [{ provider: "anthropic", account: { accountId: "a" }, priority: 0 }],
		usageProviderResolver: () => undefined,
		refreshOAuthCredential: async (_provider, _id, current) => {
			if (current.accountId === revokedAccount) throw new Error("invalid_grant: grant revoked");
			return current;
		},
	});
	return { store, storage };
}

/** Pins `session` to `id` the way a resumed session restores its account (an automatic pin). */
function pin(storage: AuthStorage, session: string, id: string): number {
	const found = storage.oauth.accounts("anthropic").find(entry => entry.accountId === id);
	if (!found) throw new Error(`no account ${id}`);
	expect(storage.sessions.pin("anthropic", session, found.credentialId, { restoredAtMs: Date.now() })).toBe(true);
	return found.credentialId;
}

async function serving(storage: AuthStorage, session: string): Promise<string | undefined> {
	return (await storage.keys.getWithCredential("anthropic", session))?.apiKey;
}

describe("a warm session's account", () => {
	// A pooled key served first, then rejected: for credit it is set aside; for its
	// workspace, or as invalid, the session's key pin is cleared as well.
	const keyRejections: Array<[string, Error]> = [
		[
			"for credit",
			Object.assign(
				new Error(
					'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
				),
				{ status: 400 },
			),
		],
		[
			"for its workspace",
			Object.assign(
				new Error(
					'400 {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace. Set the anthropic-workspace-id header."}}',
				),
				{ status: 400 },
			),
		],
		[
			"as invalid",
			Object.assign(
				new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'),
				{ status: 401 },
			),
		],
	];

	for (const [reason, rejection] of keyRejections) {
		it(`returns to it when a pooled key served first is rejected ${reason}`, async () => {
			const { store, storage } = setup(undefined, "api-keys-first");
			await storage.credentials.set("anthropic", [account("a"), account("b")]);
			store.reports.set("a", weekly("a", 0.5));
			store.reports.set("b", weekly("b", 0.1));
			pin(storage, "warm", "a");
			expect(await serving(storage, "warm")).toBe("access-a");

			// A key added while the session runs serves first, as the pool order asks.
			await storage.credentials.addApiKey("anthropic", "sk-ant-api03-pooled-key");
			const resolve = storage.keys.resolver("anthropic", { sessionId: "warm" });
			const key = await resolveApiKeyOnce(resolve);
			expect(key).toBe("sk-ant-api03-pooled-key");
			const warnings = vi.spyOn(logger, "warn").mockImplementation(() => {});
			expect(await resolveRetryKey(resolve, true, rejection, undefined, key)).toBe("access-a");
			expect(await serving(storage, "warm")).toBe("access-a");

			// The provider's reason is recorded once, against the key it set aside.
			const keyId = storage.credentials.list("anthropic").find(row => row.credential.type === "api_key")?.id;
			const setAside = warnings.mock.calls.filter(
				([message]) => message === "Credential set aside after a provider error",
			);
			expect(setAside).toHaveLength(1);
			expect(setAside[0]?.[1]).toMatchObject({ provider: "anthropic", credentialId: keyId });
			expect(String(setAside[0]?.[1]?.providerMessage)).toContain(rejection.message.slice(0, 80));
			// The logged end is the block selection honours: the key pool's retry time.
			const keyPool = storage.limits.pools("anthropic").find(pool => pool.kind === "api_key");
			expect(keyPool?.retryAtMs).toBeDefined();
			expect(setAside[0]?.[1]?.blockedUntil).toBe(new Date(keyPool?.retryAtMs ?? 0).toISOString());
		});
	}

	it("is inherited with the parent's key detour, so a forked child returns to it when the key fails", async () => {
		const { store, storage } = setup(undefined, "api-keys-first");
		await storage.credentials.set("anthropic", [account("a"), account("b")]);
		store.reports.set("a", weekly("a", 0.5));
		store.reports.set("b", weekly("b", 0.1));
		pin(storage, "parent", "a");
		expect(await serving(storage, "parent")).toBe("access-a");
		await storage.credentials.addApiKey("anthropic", "sk-ant-api03-pooled-key");
		expect(await serving(storage, "parent")).toBe("sk-ant-api03-pooled-key");

		// The fork starts while the parent is on the key, then the key fails for the child.
		expect(storage.sessions.inherit("parent", "child")).toBe(1);
		const resolve = storage.keys.resolver("anthropic", { sessionId: "child" });
		const key = await resolveApiKeyOnce(resolve);
		expect(key).toBe("sk-ant-api03-pooled-key");
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const creditsExhausted = Object.assign(
			new Error(
				'400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
			),
			{ status: 400 },
		);
		expect(await resolveRetryKey(resolve, true, creditsExhausted, undefined, key)).toBe("access-a");
	});

	it("is what a session last on a removed key resumes and passes on", async () => {
		const { store, storage } = setup(undefined, "api-keys-first");
		// The warm account is stored second, so no first-account fallback can stand in for it.
		await storage.credentials.set("anthropic", [account("b"), account("a")]);
		store.reports.set("a", weekly("a", 0.5));
		store.reports.set("b", weekly("b", 0.1));
		pin(storage, "parent", "a");
		expect(await serving(storage, "parent")).toBe("access-a");
		await storage.credentials.addApiKey("anthropic", "sk-ant-api03-pooled-key");
		expect(await serving(storage, "parent")).toBe("sk-ant-api03-pooled-key");

		// The key is removed while the parent's last request used it.
		const keyId = storage.credentials.list("anthropic").find(row => row.credential.type === "api_key")?.id;
		if (keyId === undefined) throw new Error("Expected the pooled key's row");
		expect(await storage.credentials.removeById("anthropic", keyId)).toBe(true);

		// Its account is the session's again, for attribution, a forked child, and a resume.
		expect(storage.oauth.identity("anthropic", "parent")?.accountId).toBe("a");
		expect(storage.sessions.inherit("parent", "child")).toBe(1);
		expect(await serving(storage, "child")).toBe("access-a");
		const resumed = new AuthStorage(store, { poolOrders: { anthropic: "api-keys-first" }, defaultReservePct: 5 });
		await resumed.credentials.reload();
		expect(await serving(resumed, "parent")).toBe("access-a");
	});

	it("stays despite a roomier sibling, and moves at its own reserve", async () => {
		const { store, storage } = setup();
		await storage.credentials.set("anthropic", [account("a"), account("b")]);
		store.reports.set("a", weekly("a", 0.5));
		store.reports.set("b", weekly("b", 0.1));
		pin(storage, "warm", "a");
		expect(await serving(storage, "warm")).toBe("access-a");

		store.reports.set("a", weekly("a", 0.95));
		expect(await serving(storage, "warm")).toBe("access-b");
	});

	it("stays when its only exhausted window was observed before a reset that has passed", async () => {
		const { store, storage } = setup();
		await storage.credentials.set("anthropic", [account("a"), account("b")]);
		store.reports.set("a", weekly("a", 1, Date.now() - 60_000, Date.now() - 120_000));
		store.reports.set("b", weekly("b", 0.1));
		pin(storage, "warm", "a");

		expect(await serving(storage, "warm")).toBe("access-a");
	});

	it("moves when its window is exhausted now", async () => {
		const { store, storage } = setup();
		await storage.credentials.set("anthropic", [account("a"), account("b")]);
		store.reports.set("a", weekly("a", 1));
		store.reports.set("b", weekly("b", 0.1));
		pin(storage, "warm", "a");

		expect(await serving(storage, "warm")).toBe("access-b");
	});

	it("stays when a different account is removed", async () => {
		const { store, storage } = setup();
		await storage.credentials.set("anthropic", [account("a"), account("b"), account("c")]);
		for (const [id, used] of [
			["a", 0.5],
			["b", 0.5],
			["c", 0.1],
		] as const)
			store.reports.set(id, weekly(id, used));
		pin(storage, "warm", "a");
		const removed = pin(storage, "other", "b");
		expect(await serving(storage, "warm")).toBe("access-a");

		await storage.credentials.removeById("anthropic", removed);
		expect(await serving(storage, "warm")).toBe("access-a");
		// The session on the removed account moves.
		expect(await serving(storage, "other")).not.toBe("access-b");
	});

	it("stays when another session finds a sibling's grant revoked", async () => {
		const { store, storage } = setup("b");
		await storage.credentials.set("anthropic", [account("a"), account("b"), account("c")]);
		for (const [id, used] of [
			["a", 0.5],
			["b", 0.5],
			["c", 0.1],
		] as const)
			store.reports.set(id, weekly(id, used));
		pin(storage, "warm", "a");
		pin(storage, "driver", "b");
		expect(await serving(storage, "warm")).toBe("access-a");
		const row = store
			.listAuthCredentials("anthropic")
			.find(entry => entry.credential.type === "oauth" && entry.credential.accountId === "b");
		if (row?.credential.type !== "oauth") throw new Error("no account b");
		store.updateAuthCredential(row.id, { ...row.credential, expires: Date.now() - 1 });
		await storage.credentials.reload();

		// The driver's refresh disables b for good and moves the driver.
		expect(await serving(storage, "driver")).not.toBe("access-b");
		expect(storage.oauth.accounts("anthropic").some(entry => entry.accountId === "b")).toBe(false);
		expect(await serving(storage, "warm")).toBe("access-a");
	});
});
