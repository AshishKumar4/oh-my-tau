import { describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore, type ApiKeyCredential } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";

function report(used: number): UsageReport {
	return {
		provider: "zai",
		fetchedAt: Date.now(),
		limits: [
			{
				id: "zai:requests:5h",
				label: "Quota",
				scope: { provider: "zai", windowId: "5h", shared: true },
				window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: Date.now() + 3_600_000 },
				amount: {
					unit: "requests",
					used,
					limit: 100,
					remaining: 100 - used,
					usedFraction: used / 100,
					remainingFraction: 1 - used / 100,
				},
				status: used === 100 ? "exhausted" : "ok",
			},
		],
	};
}

describe("durable API-key selection through asynchronous boundaries", () => {
	it("keeps an extant all-blocked fallback when an unranked preferred row retires during synchronization", async () => {
		const provider = "unit-api-fallback";
		const store = await SqliteAuthCredentialStore.open(":memory:");
		const storage = new AuthStorage(store, {
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: () => undefined,
			configValueResolver: async key => key,
		});
		try {
			await storage.credentials.set(provider, [
				{ type: "api_key", key: "A", source: "login" },
				{ type: "api_key", key: "B", source: "login" },
			]);
			const original = await storage.keys.getWithCredential(provider, "fallback");
			if (original?.credentialId === undefined) throw new Error("Expected original credential");
			const retiredId = original.credentialId;
			const rows = store.listAuthCredentials(provider);
			const survivor = rows.find(row => row.id !== original.credentialId);
			if (!survivor || survivor.credential.type !== "api_key") throw new Error("Expected a surviving API key");
			for (const row of rows)
				store.upsertCredentialBlock({
					credentialId: row.id,
					providerKey: `${provider}:api_key`,
					blockScope: "",
					blockedUntilMs: Date.now() + 60_000,
				});
			const list = store.listAuthCredentials.bind(store);
			let retired = false;
			const hook = vi.spyOn(store, "listAuthCredentials").mockImplementation(name => {
				if (!retired && name === provider) {
					retired = true;
					store.updateAuthCredential(retiredId, {
						type: "oauth",
						access: "converted",
						refresh: "converted",
						expires: Date.now() + 3_600_000,
					});
				}
				return list(name);
			});
			try {
				expect(await storage.keys.getWithCredential(provider, "fallback")).toMatchObject({
					apiKey: survivor.credential.key,
					credentialId: survivor.id,
				});
				expect(retired).toBe(true);
			} finally {
				hook.mockRestore();
			}
		} finally {
			storage.close();
		}
	});
	it.each(["exhausted-target", "lower-row", "changed-key", "all-blocked"])(
		"keeps usage and attribution bound to their original row during %s",
		async variant => {
			const store = await SqliteAuthCredentialStore.open(":memory:");
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const provider: UsageProvider = {
				id: "zai",
				supports: params => params.credential.type === "api_key",
				async fetchUsage(params) {
					const key = params.credential.apiKey;
					if (key === "A") {
						started.resolve();
						await release.promise;
					}
					return report(
						variant === "all-blocked"
							? 100
							: key === "A"
								? variant === "lower-row"
									? 10
									: 100
								: key === "L"
									? 60
									: 30,
					);
				},
			};
			const storage = new AuthStorage(store, {
				usageProviderResolver: name => (name === "zai" ? provider : undefined),
				configValueResolver: async value => value,
			});
			try {
				const keys = variant === "lower-row" ? ["L", "A", "B"] : ["A", "B"];
				await storage.credentials.set(
					"zai",
					keys.map<ApiKeyCredential>(key => ({ type: "api_key", key, source: "login" })),
				);
				const rows = store.listAuthCredentials("zai");
				const find = (key: string) => {
					const row = rows.find(row => row.credential.type === "api_key" && row.credential.key === key);
					if (!row) throw new Error(`Missing ${key}`);
					return row.id;
				};
				const resolving = storage.keys.getWithCredential("zai", "selection");
				await started.promise;
				if (variant === "changed-key")
					store.updateAuthCredential(find("A"), { type: "api_key", key: "replacement-A", source: "login" });
				else await store.deleteAuthCredential(find(variant === "lower-row" ? "L" : "A"), "fixture removal");
				await storage.credentials.reload();
				release.resolve();
				const selected = await resolving;
				const expected = variant === "lower-row" ? "A" : "B";
				expect(selected).toMatchObject({ apiKey: expected, credentialId: find(expected) });
				if (!store.getCredentialBlock) throw new Error("Expected block inspection support");
				if (variant !== "all-blocked") {
					expect(store.getCredentialBlock(find("B"), "zai:api_key", "credits")).toBeUndefined();
					expect(store.getCredentialBlock(find("B"), "zai:api_key", "")).toBeUndefined();
				}
				if (variant === "changed-key") {
					expect(store.getCredentialBlock(find("A"), "zai:api_key", "credits")).toBeUndefined();
					expect(store.getCredentialBlock(find("A"), "zai:api_key", "")).toBeUndefined();
				}
				await storage.limits.markReached("zai", "selection", { retryAfterMs: 60_000, providerTimed: true });
				expect(
					store.getCredentialBlock(find(expected), "zai:api_key", "credits") ??
						store.getCredentialBlock(find(expected), "zai:api_key", ""),
				).toBeGreaterThan(Date.now());
			} finally {
				release.resolve();
				storage.close();
			}
		},
	);

	for (const source of ["login", "stored"]) {
		it.each(["remove", "convert", "change-source", "change-key"])(
			`does not attribute a retired ${source} row after formatting: %s`,
			async change => {
				const store = await SqliteAuthCredentialStore.open(":memory:");
				const started = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				let selectedReference: string | undefined;
				const provider = "unit-api-format";
				const storage = new AuthStorage(store, {
					usageProviderResolver: () => undefined,
					rankingStrategyResolver: () => undefined,
					configValueResolver: async key => {
						if (selectedReference === undefined) {
							selectedReference = key;
							started.resolve();
							await release.promise;
						}
						return `resolved-${key}`;
					},
				});
				try {
					const first: ApiKeyCredential = { type: "api_key", key: "first" };
					const second: ApiKeyCredential = { type: "api_key", key: "second" };
					if (source === "login") {
						first.source = "login";
						second.source = "login";
					}
					await storage.credentials.set(provider, [first, second]);
					const rows = store.listAuthCredentials(provider);
					const resolving = storage.keys.getWithCredential(provider, "formatting");
					await Promise.race([
						started.promise,
						resolving.then(() => {
							throw new Error("Expected the key formatter to be reached");
						}),
					]);
					const retired = selectedReference;
					if (retired === undefined) throw new Error("Expected a selected reference");
					const target = rows.find(row => row.credential.type === "api_key" && row.credential.key === retired);
					if (!target || target.credential.type !== "api_key") throw new Error("Expected the selected row");
					if (change === "remove") await store.deleteAuthCredential(target.id, "fixture removal");
					else if (change === "convert")
						store.updateAuthCredential(target.id, {
							type: "oauth",
							access: "other",
							refresh: "other",
							expires: Date.now() + 3_600_000,
						});
					else if (change === "change-key")
						store.updateAuthCredential(target.id, { ...target.credential, key: "new-key" });
					else
						store.updateAuthCredential(target.id, {
							type: "api_key",
							key: "new-source",
							...(source === "stored" ? { source: "login" } : {}),
						});
					await storage.credentials.reload();
					release.resolve();
					const result = await resolving;
					expect(result?.apiKey).not.toBe(`resolved-${retired}`);
					if (result) {
						const actual = store
							.listAuthCredentials(provider)
							.find(
								row => row.credential.type === "api_key" && `resolved-${row.credential.key}` === result.apiKey,
							);
						expect(actual).toBeDefined();
						expect(result.credentialId).toBe(actual?.id);
					}
				} finally {
					release.resolve();
					storage.close();
				}
			},
		);
	}
});
