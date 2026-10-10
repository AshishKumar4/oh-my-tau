import { afterEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as oauth from "@oh-my-pi/pi-ai/registry/oauth";

const provider = "unit-transient-refresh";
const sourceId = "transient-refresh-fixture";

afterEach(() => {
	vi.restoreAllMocks();
	oauth.unregisterOAuthProviders(sourceId);
});

describe("request and availability OAuth resolution", () => {
	it("keeps the configured account and explicit pin through failed probes and retryable refresh recovery", async () => {
		let failing = true;
		oauth.registerOAuthProvider({
			id: provider,
			name: "Fixture",
			sourceId,
			async login() {
				throw new Error("Login must not run");
			},
			async refreshToken(credential) {
				if (failing) throw new Error("fetch failed: ECONNRESET");
				return { ...credential, access: "fresh-access", refresh: "fresh-refresh", expires: Date.now() + 3_600_000 };
			},
		});
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const storage = new AuthStorage(store);
		try {
			await storage.credentials.set(provider, {
				type: "oauth",
				access: "expired",
				refresh: "stored",
				expires: Date.now() - 60_000,
				accountId: "same-account",
			});
			const account = storage.oauth.accounts(provider)[0];
			if (!account) throw new Error("Expected fixture account");
			expect(storage.sessions.pin(provider, "session", account.credentialId)).toBe(true);
			try {
				await storage.keys.getWithCredential(provider, "session");
				throw new Error("Expected a retryable refresh failure");
			} catch (error) {
				expect(error).toBeInstanceOf(AIError.OAuthRefreshUnavailableError);
				expect(AIError.retriable(AIError.classify(error))).toBe(true);
			}
			expect(await storage.keys.get(provider, "session")).toBeUndefined();
			expect(storage.oauth.accounts(provider, "session").find(row => row.active)?.credentialId).toBe(
				account.credentialId,
			);
			expect(store.listAuthCredentials(provider)[0]?.id).toBe(account.credentialId);
			failing = false;
			expect(await storage.keys.getWithCredential(provider, "session")).toMatchObject({
				apiKey: "fresh-access",
				credentialId: account.credentialId,
			});
			expect(storage.oauth.identity(provider, "session")?.accountId).toBe("same-account");
		} finally {
			storage.close();
		}
	});

	it("retains explicit stored-key fallback but does not hide fatal storage errors", async () => {
		oauth.registerOAuthProvider({
			id: provider,
			name: "Fixture",
			sourceId,
			async login() {
				throw new Error("Login must not run");
			},
			async refreshToken() {
				throw new Error("HTTP 503 service unavailable");
			},
		});
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const storage = new AuthStorage(store);
		try {
			await storage.credentials.set(provider, [
				{ type: "oauth", access: "expired", refresh: "stored", expires: Date.now() - 60_000 },
				{ type: "api_key", key: "explicit-key" },
			]);
			expect((await storage.keys.getWithCredential(provider, "session"))?.apiKey).toBe("explicit-key");
			const failure = new Error("credential store unavailable");
			vi.spyOn(store, "listAuthCredentials").mockImplementation(() => {
				throw failure;
			});
			await expect(storage.keys.getWithCredential(provider, "session")).rejects.toBe(failure);
		} finally {
			storage.close();
		}
	});
});
