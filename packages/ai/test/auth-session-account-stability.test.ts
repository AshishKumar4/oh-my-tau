// A session keeps the account it warmed a prompt cache on until that account
// itself needs protecting: near its own reserve, exhausted now, or gone.
// Moving it for any other reason re-sends the whole prompt uncached.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { OAuthCredential } from "@oh-my-pi/pi-ai/auth/types";
import type { Provider } from "@oh-my-pi/pi-ai/types";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";

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

function setup(revokedAccount?: string) {
	const store = new ReportingStore(new Database(":memory:"));
	stores.push(store);
	const storage = new AuthStorage(store, {
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
