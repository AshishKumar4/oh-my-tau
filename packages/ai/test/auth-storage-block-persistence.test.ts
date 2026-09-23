import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import type { UsageLimit } from "@oh-my-pi/pi-ai/usage";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "anthropic";
const PROVIDER_KEY = "anthropic:oauth";
const CODEX_PROVIDER = "openai-codex";
const CODEX_PROVIDER_KEY = "openai-codex:oauth";
const FUTURE_BLOCK_MS = 1_899_999_999_000;
const EXPIRED_BLOCK_MS = 1;
const LEGACY_TIMESTAMP = 1_700_000_000;

function oauthCredential(suffix: string): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

function claudeLimit(id: string, usedFraction: number, scope: { shared?: boolean; tier?: string }): UsageLimit {
	// Window ids mirror the real /usage payload shape (see
	// auth-storage-claude-fable-fallback.test.ts): bare '5h'/'7d', so the
	// shared-gate check in healableBlockScopes can match them.
	const windowId = id.split(":").pop() ?? id;
	return {
		id,
		label: id,
		scope: { provider: PROVIDER, windowId, ...scope },
		window: { id: windowId, label: windowId, resetsAt: Date.now() + 60_000 },
		amount: { usedFraction, unit: "percent" },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function ageCredentialBlocks(dbPath: string, updatedAtSec: number): void {
	const db = new Database(dbPath);
	try {
		db.run("UPDATE auth_credential_blocks SET updated_at = ?", [updatedAtSec]);
	} finally {
		db.close();
	}
}

function readAuthSchemaVersion(dbPath: string): number | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.prepare("SELECT version FROM auth_schema_version WHERE id = 1").get() as
			| { version?: number }
			| undefined;
		return typeof row?.version === "number" ? row.version : null;
	} finally {
		db.close();
	}
}

function tableExists(dbPath: string, tableName: string): boolean {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db
			.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(tableName) as { present?: number } | undefined;
		return row?.present === 1;
	} finally {
		db.close();
	}
}

function readCredentialBlockRows(dbPath: string): Array<{
	credential_id: number;
	provider_key: string;
	block_scope: string;
	blocked_until_ms: number;
	updated_at: number;
}> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare(
				"SELECT credential_id, provider_key, block_scope, blocked_until_ms, updated_at FROM auth_credential_blocks ORDER BY credential_id, provider_key, block_scope",
			)
			.all() as Array<{
			credential_id: number;
			provider_key: string;
			block_scope: string;
			blocked_until_ms: number;
			updated_at: number;
		}>;
	} finally {
		db.close();
	}
}

function readLegacyCodexSharedBlock(
	dbPath: string,
	credentialId: number,
	nowMs = Date.now(),
): { blocked_until_ms: number; updated_at: number } | undefined {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db
			.prepare(
				`SELECT blocked_until_ms, updated_at
				FROM auth_credential_blocks
				WHERE credential_id = ?
					AND provider_key = ?
					AND block_scope = 'shared'
					AND blocked_until_ms > ?`,
			)
			.get(credentialId, CODEX_PROVIDER_KEY, nowMs) as
			| { blocked_until_ms: number; updated_at: number }
			| null
			| undefined;
		return row ?? undefined;
	} finally {
		db.close();
	}
}

function prepareV6BlockSchema(db: Database): void {
	db.run(`
		DROP TRIGGER IF EXISTS auth_codex_shared_insert_to_meters;
		DROP TRIGGER IF EXISTS auth_codex_shared_update_to_meters;
		DROP TRIGGER IF EXISTS auth_codex_meter_insert_to_shared;
		DROP TRIGGER IF EXISTS auth_codex_meter_update_to_shared;
		DROP TRIGGER IF EXISTS auth_codex_shared_delete_to_meters;
		DROP TRIGGER IF EXISTS auth_codex_meter_delete_to_shared;
		DROP TABLE IF EXISTS auth_credential_block_mirror_guard;
		UPDATE auth_schema_version SET version = 6 WHERE id = 1;
	`);
}

describe("AuthStorage credential block persistence", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-blocks-"));
		dbPath = path.join(tempDir, "agent.db");
	});

	afterEach(async () => {
		dbPath = "";
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	it("re-includes a tier-blocked account once its live report shows the tier recovered", async () => {
		const setup = await SqliteAuthCredentialStore.open(dbPath);
		setup.saveOAuth(PROVIDER, oauthCredential("spent"));
		setup.saveOAuth(PROVIDER, oauthCredential("recovered"));
		const [spentRow, recoveredRow] = setup.listAuthCredentials(PROVIDER);
		// Both accounts were blocked for the Fable tier days ago, with the weekly
		// reset as the expiry. Ageing `updated_at` past the usage-cache window is
		// what makes them healable: a block written this instant is deliberately
		// held, since `/usage` lags the 429 that wrote it.
		for (const row of [spentRow, recoveredRow]) {
			setup.upsertCredentialBlock({
				credentialId: row!.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
		}
		setup.close();

		const store = await SqliteAuthCredentialStore.open(dbPath);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider =>
				provider === PROVIDER
					? {
							id: PROVIDER,
							fetchUsage: async params => ({
								provider: PROVIDER,
								fetchedAt: Date.now(),
								limits: [
									claudeLimit("anthropic:5h", 0.6, { shared: true }),
									claudeLimit("anthropic:7d", 0.6, { shared: true }),
									// The account this test recovers reports an empty Fable
									// week; the other stays exhausted.
									claudeLimit(
										"anthropic:7d:fable",
										params.credential.accountId === "account-recovered" ? 0 : 1,
										{ tier: "fable" },
									),
								],
								metadata: { accountId: params.credential.accountId },
							}),
						}
					: undefined,
		});
		await storage.credentials.reload();
		try {
			// This first pass warms the usage cache while the blocks are still too
			// fresh to heal, which is the ordinary state of a session: `omp usage`
			// or an earlier turn already fetched every report. Healing therefore
			// has to work off the cached report, not only a fresh fetch.
			expect(await storage.keys.get(PROVIDER, "session-warm", { modelId: "claude-fable-5-1" })).toBe("access-spent");
			ageCredentialBlocks(dbPath, LEGACY_TIMESTAMP);

			const key = await storage.keys.get(PROVIDER, "session-heal", { modelId: "claude-fable-5-1" });

			expect(key).toBe("access-recovered");
			const scopes = readCredentialBlockRows(dbPath)
				.filter(row => row.credential_id === recoveredRow!.id)
				.map(row => row.block_scope);
			expect(scopes).not.toContain("tier:fable");
			const spentScopes = readCredentialBlockRows(dbPath)
				.filter(row => row.credential_id === spentRow!.id)
				.map(row => row.block_scope);
			expect(spentScopes).toContain("tier:fable");
		} finally {
			storage.close();
		}
	});

	it("never selects a held account, even as the last resort or by direct id, until it is released", async () => {
		const setup = await SqliteAuthCredentialStore.open(dbPath);
		setup.saveOAuth(PROVIDER, oauthCredential("held"));
		setup.saveOAuth(PROVIDER, oauthCredential("other"));
		const [heldRow, otherRow] = setup.listAuthCredentials(PROVIDER);
		// Every account is exhausted for the Fable tier, so selection reaches its
		// last-resort pass, which normally tries blocked accounts anyway.
		for (const row of [heldRow, otherRow]) {
			setup.upsertCredentialBlock({
				credentialId: row!.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
		}
		setup.close();

		const store = await SqliteAuthCredentialStore.open(dbPath);
		const storage = new AuthStorage(store);
		await storage.credentials.reload();
		try {
			// The held account is the session's sticky preference, which the
			// last-resort pass would otherwise take first.
			expect(storage.sessions.pin(PROVIDER, "session-sticky", heldRow!.id)).toBe(true);
			storage.holdCredential(PROVIDER, heldRow!.id);
			// Neither the active-account view, the credential-source line, nor a pin restored from a session
			// file names a held account; the account list marks none active, and a child session does not
			// inherit the pin.
			expect(storage.oauth.identity(PROVIDER, "session-sticky")?.email).toBe("other@example.com");
			expect(storage.keys.describe(PROVIDER, "session-sticky")).toContain("other@example.com");
			expect(storage.sessions.pin(PROVIDER, "session-restored", heldRow!.id, { restoredAtMs: Date.now() })).toBe(
				false,
			);
			expect(storage.oauth.accounts(PROVIDER, "session-sticky").some(account => account.active)).toBe(false);
			expect(storage.sessions.inherit("session-sticky", "session-child")).toBe(0);

			expect(await storage.keys.get(PROVIDER, "session-sticky", { modelId: "claude-fable-5-1" })).toBe(
				"access-other",
			);
			const direct = await storage.oauth.accessById(PROVIDER, heldRow!.id);
			expect(direct?.ok).toBe(false);
			const holdRow = readCredentialBlockRows(dbPath).find(
				row => row.credential_id === heldRow!.id && row.block_scope === "hold",
			);
			// The persisted shape existing holds already use, honoured as-is.
			expect(holdRow?.provider_key).toBe(PROVIDER_KEY);
			expect(holdRow?.blocked_until_ms).toBe(Date.UTC(2200, 0, 1));

			storage.releaseCredential(PROVIDER, heldRow!.id);
			expect(readCredentialBlockRows(dbPath).some(row => row.block_scope === "hold")).toBe(false);
			expect((await storage.oauth.accessById(PROVIDER, heldRow!.id))?.ok).toBe(true);
			expect(storage.sessions.pin(PROVIDER, "session-restored", heldRow!.id)).toBe(true);
		} finally {
			storage.close();
		}
	});

	it("keeps a held account out of rotation, the last resort, and model discovery", async () => {
		const setup = await SqliteAuthCredentialStore.open(dbPath);
		setup.saveOAuth(PROVIDER, oauthCredential("held"));
		setup.saveOAuth(PROVIDER, oauthCredential("spent"));
		const [heldRow, spentRow] = setup.listAuthCredentials(PROVIDER);
		setup.close();

		const store = await SqliteAuthCredentialStore.open(dbPath);
		const storage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		await storage.credentials.reload();
		try {
			storage.holdCredential(PROVIDER, heldRow!.id);
			expect((await storage.oauth.access(PROVIDER, "session-rotate"))?.email).toBe("spent@example.com");
			// The held account is healthy, yet no sibling to rotate to: reporting one
			// would send the retry straight back into the exhausted account.
			const outcome = await storage.limits.markReached(PROVIDER, "session-rotate", { retryAfterMs: 60_000 });
			expect(outcome.switched).toBe(false);

			// With the held account the only one left, neither the last resort that
			// tries blocked accounts nor the unranked pick behind model discovery uses it.
			expect(await storage.credentials.removeById(PROVIDER, spentRow!.id)).toBe(true);
			expect(await storage.oauth.access(PROVIDER, "session-sole")).toBeUndefined();
			expect(await storage.keys.peek(PROVIDER)).not.toBe("access-held");
		} finally {
			storage.close();
		}
	});

	it("keeps a hold through block healing, usage reports, and saved-reset redemption", async () => {
		const setup = await SqliteAuthCredentialStore.open(dbPath);
		setup.saveOAuth(PROVIDER, oauthCredential("held"));
		setup.saveOAuth(PROVIDER, oauthCredential("other"));
		const [heldRow] = setup.listAuthCredentials(PROVIDER);
		// A stale Fable block, aged past the usage-cache window so a healthy report may heal it.
		setup.upsertCredentialBlock({
			credentialId: heldRow!.id,
			providerKey: PROVIDER_KEY,
			blockScope: "tier:fable",
			blockedUntilMs: FUTURE_BLOCK_MS,
		});
		setup.close();
		ageCredentialBlocks(dbPath, LEGACY_TIMESTAMP);
		// A hold row exactly as earlier releases persisted it.
		const legacy = await SqliteAuthCredentialStore.open(dbPath);
		legacy.upsertCredentialBlock({
			credentialId: heldRow!.id,
			providerKey: PROVIDER_KEY,
			blockScope: "hold",
			blockedUntilMs: Date.UTC(2200, 0, 1),
		});
		legacy.close();

		const store = await SqliteAuthCredentialStore.open(dbPath);
		const storage = new AuthStorage(store, {
			usageProviderResolver: provider =>
				provider === PROVIDER
					? {
							id: PROVIDER,
							fetchUsage: async params => ({
								provider: PROVIDER,
								fetchedAt: Date.now(),
								limits: [
									claudeLimit("anthropic:5h", 0.1, { shared: true }),
									claudeLimit("anthropic:7d", 0.1, { shared: true }),
									claudeLimit("anthropic:7d:fable", 0, { tier: "fable" }),
								],
								metadata: { accountId: params.credential.accountId },
							}),
						}
					: undefined,
		});
		await storage.credentials.reload();
		try {
			// The first read fetches, the second is served from cache; both reconcile.
			await storage.usage.reports();
			await storage.usage.reports();
			// The healthy report lifted the stale Fable block and left the hold alone.
			expect(
				readCredentialBlockRows(dbPath)
					.filter(row => row.credential_id === heldRow!.id)
					.map(row => row.block_scope),
			).toEqual(["hold"]);
			expect((await storage.oauth.access(PROVIDER, "session-healed", { modelId: "claude-fable-5-1" }))?.email).toBe(
				"other@example.com",
			);
		} finally {
			storage.close();
		}

		const codexDbPath = path.join(tempDir, "codex.db");
		const codexSetup = await SqliteAuthCredentialStore.open(codexDbPath);
		codexSetup.saveOAuth(CODEX_PROVIDER, oauthCredential("reset"));
		const [resetRow] = codexSetup.listAuthCredentials(CODEX_PROVIDER);
		// The usage-limit block the saved reset exists to lift.
		codexSetup.upsertCredentialBlock({
			credentialId: resetRow!.id,
			providerKey: CODEX_PROVIDER_KEY,
			blockScope: "",
			blockedUntilMs: FUTURE_BLOCK_MS,
		});
		codexSetup.close();
		const usageFetch = Object.assign(
			async () => {
				// A hold placed by another process while the redemption is in flight.
				const scheduler = await AuthStorage.create(codexDbPath);
				scheduler.holdCredential(CODEX_PROVIDER, resetRow!.id);
				scheduler.close();
				return Response.json({ code: "reset" });
			},
			{ preconnect: fetch.preconnect },
		);
		const codexStore = await SqliteAuthCredentialStore.open(codexDbPath);
		const codexStorage = new AuthStorage(codexStore, { usageFetch });
		await codexStorage.credentials.reload();
		try {
			const outcome = await codexStorage.resets.redeem({
				target: { provider: CODEX_PROVIDER, credentialId: resetRow!.id, creditId: "credit-reset" },
			});
			expect(outcome.ok).toBe(true);
			// The reset lifted every backoff but not the hold that landed meanwhile.
			expect(
				readCredentialBlockRows(codexDbPath)
					.filter(row => row.credential_id === resetRow!.id)
					.map(row => row.block_scope),
			).toEqual(["hold"]);
			expect((await codexStorage.oauth.accessById(CODEX_PROVIDER, resetRow!.id))?.ok).toBe(false);
		} finally {
			codexStorage.close();
		}
	});

	it("sets an org-wide OAuth denial aside for hours while a content denial only rotates", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.saveOAuth(PROVIDER, oauthCredential("org"));
		store.saveOAuth(PROVIDER, oauthCredential("healthy"));
		const storage = new AuthStorage(store);
		await storage.credentials.reload();
		try {
			const orgDenial = new Error(
				'403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization.","details":{"error_code":"oauth_not_allowed_for_organization"}}}',
			);
			const before = Date.now();
			// The denial arrives on a fable request, whose ranking strategy would
			// otherwise scope the block to `tier:fable` and leave the credential
			// selectable on every other Anthropic tier.
			const denied = await storage.keys.get(PROVIDER, "session-org", { modelId: "claude-fable-5-1" });
			expect(denied).toBeDefined();
			expect(
				await storage.limits.rotate(PROVIDER, "session-org", {
					error: orgDenial,
					modelId: "claude-fable-5-1",
				}),
			).toBe(true);
			const orgId = store.listAuthCredentials(PROVIDER)[0]!.id;
			const orgRows = readCredentialBlockRows(dbPath);
			expect(orgRows).toHaveLength(1);
			const orgBlock = orgRows[0]!;
			expect(orgBlock.credential_id).toBe(orgId);
			// Provider-wide, not tier-scoped: an org prohibition denies every model.
			expect(orgBlock.block_scope).toBe("");
			// Bounded so an administrator lifting the org policy self-heals.
			expect(orgBlock.blocked_until_ms).toBeGreaterThan(before + 60 * 60 * 1000);
			expect(orgBlock.blocked_until_ms).toBeLessThanOrEqual(before + 24 * 60 * 60 * 1000);
		} finally {
			storage.close();
		}

		const contentStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "content.db"));
		contentStore.saveOAuth(CODEX_PROVIDER, oauthCredential("flagged"));
		contentStore.saveOAuth(CODEX_PROVIDER, oauthCredential("sibling"));
		const contentStorage = new AuthStorage(contentStore);
		await contentStorage.credentials.reload();
		try {
			const cyber = new Error(
				"Codex error event: This content was flagged for possible cybersecurity risk. Join Trusted Access for Cyber. (code=cyber_policy)",
			);
			const before = Date.now();
			expect(await contentStorage.keys.get(CODEX_PROVIDER, "session-cyber")).toBeDefined();
			expect(await contentStorage.limits.rotate(CODEX_PROVIDER, "session-cyber", { error: cyber })).toBe(true);
			// A flagged prompt must not sideline a healthy account for hours.
			const contentRows = readCredentialBlockRows(path.join(tempDir, "content.db"));
			expect(contentRows.length).toBeGreaterThan(0);
			for (const row of contentRows) {
				expect(row.blocked_until_ms).toBeLessThanOrEqual(before + 5 * 60 * 1000);
			}
		} finally {
			contentStorage.close();
		}
	});

	it("honors scoped and unscoped blocks written by a previous AuthStorage instance", async () => {
		const firstStore = await SqliteAuthCredentialStore.open(dbPath);
		await firstStore.saveOAuth(PROVIDER, oauthCredential("1"));
		await firstStore.saveOAuth(PROVIDER, oauthCredential("2"));
		await firstStore.saveOAuth(PROVIDER, oauthCredential("3"));
		const rows = firstStore.listAuthCredentials(PROVIDER);
		const firstStorage = new AuthStorage(firstStore);
		await firstStorage.credentials.reload();
		try {
			firstStorage.blocks.upsert({
				credentialId: rows[0]!.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
			firstStorage.blocks.upsert({
				credentialId: rows[1]!.id,
				providerKey: PROVIDER_KEY,
				blockScope: "",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
		} finally {
			firstStorage.close();
		}

		const reopenedStore = await SqliteAuthCredentialStore.open(dbPath);
		const reopenedStorage = new AuthStorage(reopenedStore);
		await reopenedStorage.credentials.reload();
		try {
			const fableKey = await reopenedStorage.keys.get(PROVIDER, "session-3", { modelId: "claude-fable-5" });
			expect(fableKey).toBe("access-3");
		} finally {
			reopenedStorage.close();
		}
	});

	it("keeps the later expiry when a shorter block is upserted for the same key", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		await store.saveOAuth(PROVIDER, oauthCredential("1"));
		const [row] = store.listAuthCredentials(PROVIDER);
		if (!row) throw new Error("expected credential row");
		const storage = new AuthStorage(store);
		await storage.credentials.reload();
		try {
			const longerBlock = FUTURE_BLOCK_MS + 60_000;
			storage.blocks.upsert({
				credentialId: row.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: longerBlock,
			});
			storage.blocks.upsert({
				credentialId: row.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});

			// `updatedAtMs` is the row's DB write time (issue #4980: same-deadline
			// refreshes must be observable), so only its presence is asserted.
			expect(storage.blocks.list([row.id])).toEqual([
				{
					credentialId: row.id,
					providerKey: PROVIDER_KEY,
					blockScope: "tier:fable",
					blockedUntilMs: longerBlock,
					updatedAtMs: expect.any(Number),
				},
			]);
		} finally {
			storage.close();
		}
	});

	it("drops expired rows from reads and clears persisted blocks through the public delete wrapper", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		await store.saveOAuth(PROVIDER, oauthCredential("1"));
		const [row] = store.listAuthCredentials(PROVIDER);
		if (!row) throw new Error("expected credential row");
		const storage = new AuthStorage(store);
		await storage.credentials.reload();
		try {
			storage.blocks.upsert({
				credentialId: row.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
			storage.blocks.upsert({
				credentialId: row.id,
				providerKey: PROVIDER_KEY,
				blockScope: "",
				blockedUntilMs: EXPIRED_BLOCK_MS,
			});

			expect(storage.blocks.list([row.id])).toEqual([
				{
					credentialId: row.id,
					providerKey: PROVIDER_KEY,
					blockScope: "tier:fable",
					blockedUntilMs: FUTURE_BLOCK_MS,
					updatedAtMs: expect.any(Number),
				},
			]);
			const generationBeforeScopedDelete = storage.credentials.generation;
			storage.blocks.delete(row.id, PROVIDER_KEY, "tier:fable");
			expect(storage.blocks.list([row.id])).toEqual([]);
			expect(storage.credentials.generation).toBe(generationBeforeScopedDelete + 1);
			storage.blocks.upsert({
				credentialId: row.id,
				providerKey: PROVIDER_KEY,
				blockScope: "tier:fable",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});

			const generationBeforeDelete = storage.credentials.generation;
			storage.blocks.deleteAll(row.id);
			expect(storage.blocks.list([row.id])).toEqual([]);
			expect(storage.credentials.generation).toBe(generationBeforeDelete + 1);
		} finally {
			storage.close();
		}
	});

	it("keeps a block attached to the same credential row after a sibling is disabled", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		await store.saveOAuth(PROVIDER, oauthCredential("1"));
		await store.saveOAuth(PROVIDER, oauthCredential("2"));
		await store.saveOAuth(PROVIDER, oauthCredential("3"));
		const rows = store.listAuthCredentials(PROVIDER);
		const storage = new AuthStorage(store);
		await storage.credentials.reload();
		try {
			storage.blocks.upsert({
				credentialId: rows[1]!.id,
				providerKey: PROVIDER_KEY,
				blockScope: "",
				blockedUntilMs: FUTURE_BLOCK_MS,
			});
		} finally {
			storage.close();
		}

		const disablingStore = await SqliteAuthCredentialStore.open(dbPath);
		await disablingStore.deleteAuthCredential(rows[0]!.id, "disabled for test");
		disablingStore.close();

		const reopenedStore = await SqliteAuthCredentialStore.open(dbPath);
		const reopenedStorage = new AuthStorage(reopenedStore);
		await reopenedStorage.credentials.reload();
		try {
			const key = await reopenedStorage.keys.get(PROVIDER, "a");
			expect(key).toBe("access-3");
		} finally {
			reopenedStorage.close();
		}
	});

	it("migrates v6 Codex shared blocks to meter rows while retaining a legacy mirror", async () => {
		const setupStore = await SqliteAuthCredentialStore.open(dbPath);
		await setupStore.saveOAuth(CODEX_PROVIDER, oauthCredential("codex"));
		await setupStore.saveOAuth(PROVIDER, oauthCredential("anthropic"));
		const [codexRow] = setupStore.listAuthCredentials(CODEX_PROVIDER);
		const [anthropicRow] = setupStore.listAuthCredentials(PROVIDER);
		setupStore.close();
		if (!codexRow || !anthropicRow) throw new Error("expected credential rows");

		const sharedExpiryMs = FUTURE_BLOCK_MS + 60_000;
		const chatExpiryMs = FUTURE_BLOCK_MS + 120_000;
		const sparkExpiryMs = FUTURE_BLOCK_MS;
		const sharedUpdatedAt = LEGACY_TIMESTAMP;
		const chatUpdatedAt = LEGACY_TIMESTAMP - 100;
		const sparkUpdatedAt = LEGACY_TIMESTAMP + 100;
		const db = new Database(dbPath);
		try {
			prepareV6BlockSchema(db);
			const insert = db.prepare(
				"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)",
			);
			insert.run(codexRow.id, CODEX_PROVIDER_KEY, "shared", sharedExpiryMs, sharedUpdatedAt);
			insert.run(codexRow.id, CODEX_PROVIDER_KEY, "chat", chatExpiryMs, chatUpdatedAt);
			insert.run(codexRow.id, CODEX_PROVIDER_KEY, "spark", sparkExpiryMs, sparkUpdatedAt);
			insert.run(anthropicRow.id, PROVIDER_KEY, "shared", FUTURE_BLOCK_MS, LEGACY_TIMESTAMP);
			insert.finalize();
		} finally {
			db.close();
		}

		const preMigrationRows = [
			{
				credential_id: codexRow.id,
				provider_key: CODEX_PROVIDER_KEY,
				block_scope: "chat",
				blocked_until_ms: chatExpiryMs,
				updated_at: chatUpdatedAt,
			},
			{
				credential_id: codexRow.id,
				provider_key: CODEX_PROVIDER_KEY,
				block_scope: "shared",
				blocked_until_ms: sharedExpiryMs,
				updated_at: sharedUpdatedAt,
			},
			{
				credential_id: codexRow.id,
				provider_key: CODEX_PROVIDER_KEY,
				block_scope: "spark",
				blocked_until_ms: sparkExpiryMs,
				updated_at: sparkUpdatedAt,
			},
			{
				credential_id: anthropicRow.id,
				provider_key: PROVIDER_KEY,
				block_scope: "shared",
				blocked_until_ms: FUTURE_BLOCK_MS,
				updated_at: LEGACY_TIMESTAMP,
			},
		];
		const failureDb = new Database(dbPath);
		try {
			failureDb.run(`
				CREATE TRIGGER fail_auth_schema_v7_version_write
				BEFORE INSERT ON auth_schema_version
				WHEN NEW.version = 7
				BEGIN
					SELECT RAISE(ABORT, 'forced v7 version write failure');
				END;
			`);
		} finally {
			failureDb.close();
		}

		await expect(SqliteAuthCredentialStore.open(dbPath)).rejects.toThrow("forced v7 version write failure");
		expect(readCredentialBlockRows(dbPath)).toEqual(preMigrationRows);
		expect(readAuthSchemaVersion(dbPath)).toBe(6);

		const cleanupDb = new Database(dbPath);
		try {
			cleanupDb.run("DROP TRIGGER fail_auth_schema_v7_version_write");
		} finally {
			cleanupDb.close();
		}

		const expectedRows = [
			{
				credential_id: codexRow.id,
				provider_key: CODEX_PROVIDER_KEY,
				block_scope: "chat",
				blocked_until_ms: chatExpiryMs,
				updated_at: sharedUpdatedAt,
			},
			{
				credential_id: codexRow.id,
				provider_key: CODEX_PROVIDER_KEY,
				block_scope: "shared",
				blocked_until_ms: chatExpiryMs,
				updated_at: sparkUpdatedAt,
			},
			{
				credential_id: codexRow.id,
				provider_key: CODEX_PROVIDER_KEY,
				block_scope: "spark",
				blocked_until_ms: sharedExpiryMs,
				updated_at: sparkUpdatedAt,
			},
			{
				credential_id: anthropicRow.id,
				provider_key: PROVIDER_KEY,
				block_scope: "shared",
				blocked_until_ms: FUTURE_BLOCK_MS,
				updated_at: LEGACY_TIMESTAMP,
			},
		];

		const firstReopen = await SqliteAuthCredentialStore.open(dbPath);
		expect(firstReopen.listCredentialBlocks([codexRow.id])).toEqual([
			{
				credentialId: codexRow.id,
				providerKey: CODEX_PROVIDER_KEY,
				blockScope: "chat",
				blockedUntilMs: chatExpiryMs,
				updatedAtMs: sharedUpdatedAt * 1000,
			},
			{
				credentialId: codexRow.id,
				providerKey: CODEX_PROVIDER_KEY,
				blockScope: "spark",
				blockedUntilMs: sharedExpiryMs,
				updatedAtMs: sparkUpdatedAt * 1000,
			},
		]);
		expect(firstReopen.getCredentialBlock(codexRow.id, CODEX_PROVIDER_KEY, "shared")).toBeUndefined();
		firstReopen.close();
		expect(readCredentialBlockRows(dbPath)).toEqual(expectedRows);
		expect(readLegacyCodexSharedBlock(dbPath, codexRow.id)?.blocked_until_ms).toBe(chatExpiryMs);
		expect(readAuthSchemaVersion(dbPath)).toBe(8);

		const secondReopen = await SqliteAuthCredentialStore.open(dbPath);
		secondReopen.close();
		expect(readCredentialBlockRows(dbPath)).toEqual(expectedRows);
		expect(readAuthSchemaVersion(dbPath)).toBe(8);
	});

	it("mirrors a legacy Codex shared insert into meter rows while hiding shared from current APIs", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		await store.saveOAuth(CODEX_PROVIDER, oauthCredential("late"));
		const [row] = store.listAuthCredentials(CODEX_PROVIDER);
		if (!row) throw new Error("expected credential row");
		const blockedUntilMs = FUTURE_BLOCK_MS + 60_000;
		const db = new Database(dbPath);
		try {
			db.prepare(
				"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)",
			).run(row.id, CODEX_PROVIDER_KEY, "shared", blockedUntilMs, LEGACY_TIMESTAMP);
		} finally {
			db.close();
		}

		expect(readLegacyCodexSharedBlock(dbPath, row.id)).toEqual({
			blocked_until_ms: blockedUntilMs,
			updated_at: LEGACY_TIMESTAMP,
		});
		expect(store.getCredentialBlock(row.id, CODEX_PROVIDER_KEY, "chat")).toBe(blockedUntilMs);
		expect(store.getCredentialBlock(row.id, CODEX_PROVIDER_KEY, "shared")).toBeUndefined();
		expect(store.listCredentialBlocks([row.id]).map(block => block.blockScope)).toEqual(["chat", "spark"]);
		expect(readCredentialBlockRows(dbPath)).toEqual([
			{
				credential_id: row.id,
				provider_key: CODEX_PROVIDER_KEY,
				block_scope: "chat",
				blocked_until_ms: blockedUntilMs,
				updated_at: LEGACY_TIMESTAMP,
			},
			{
				credential_id: row.id,
				provider_key: CODEX_PROVIDER_KEY,
				block_scope: "shared",
				blocked_until_ms: blockedUntilMs,
				updated_at: LEGACY_TIMESTAMP,
			},
			{
				credential_id: row.id,
				provider_key: CODEX_PROVIDER_KEY,
				block_scope: "spark",
				blocked_until_ms: blockedUntilMs,
				updated_at: LEGACY_TIMESTAMP,
			},
		]);
		store.close();
	});

	it("mirrors a late legacy Codex upsert before calculating scoped reconciliation", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		await store.saveOAuth(CODEX_PROVIDER, oauthCredential("late-reconcile"));
		const [row] = store.listAuthCredentials(CODEX_PROVIDER);
		if (!row) throw new Error("expected credential row");
		const insertedAtMs = Date.now();
		const insertedAtSec = Math.floor(insertedAtMs / 1000);
		const blockedUntilMs = FUTURE_BLOCK_MS + 60_000;
		const db = new Database(dbPath);
		try {
			db.prepare(
				"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)",
			).run(row.id, CODEX_PROVIDER_KEY, "shared", blockedUntilMs, insertedAtSec);
		} finally {
			db.close();
		}

		store.deleteCredentialBlock(row.id, CODEX_PROVIDER_KEY, "chat");
		expect(store.listCredentialBlocks([row.id]).map(block => block.blockScope)).toEqual(["spark"]);
		expect(readLegacyCodexSharedBlock(dbPath, row.id)?.blocked_until_ms).toBe(blockedUntilMs);

		const legacyWriter = new Database(dbPath);
		try {
			legacyWriter
				.prepare(
					`INSERT INTO auth_credential_blocks (
						credential_id,
						provider_key,
						block_scope,
						blocked_until_ms,
						updated_at
					)
					VALUES (?, ?, ?, ?, ?)
					ON CONFLICT(credential_id, provider_key, block_scope) DO UPDATE SET
						blocked_until_ms = MAX(blocked_until_ms, excluded.blocked_until_ms),
						updated_at = excluded.updated_at`,
				)
				.run(row.id, CODEX_PROVIDER_KEY, "shared", blockedUntilMs, insertedAtSec + 1);
		} finally {
			legacyWriter.close();
		}

		const reconcileAfterMs = store.getCredentialBlockReconcileAfter(row.id, CODEX_PROVIDER_KEY, "chat");
		expect(reconcileAfterMs).toBeGreaterThan(insertedAtMs);
		expect(reconcileAfterMs).toBeLessThan(blockedUntilMs);
		expect(store.listCredentialBlocks([row.id]).map(block => block.blockScope)).toEqual(["chat", "spark"]);
		expect(readCredentialBlockRows(dbPath).map(block => block.block_scope)).toEqual(["chat", "shared", "spark"]);
		store.close();
	});

	it("keeps steady-state Codex block reads read-only while another connection owns the writer lock", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		await store.saveOAuth(CODEX_PROVIDER, oauthCredential("read-only"));
		const [row] = store.listAuthCredentials(CODEX_PROVIDER);
		if (!row) throw new Error("expected credential row");
		const blockedUntilMs = FUTURE_BLOCK_MS + 60_000;
		store.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: CODEX_PROVIDER_KEY,
			blockScope: "chat",
			blockedUntilMs,
		});
		expect(readLegacyCodexSharedBlock(dbPath, row.id)?.blocked_until_ms).toBe(blockedUntilMs);

		const writer = new Database(dbPath);
		let writerLocked = false;
		try {
			writer.run("BEGIN IMMEDIATE");
			writerLocked = true;

			expect(store.getCredentialBlock(row.id, CODEX_PROVIDER_KEY, "chat")).toBe(blockedUntilMs);
			expect(store.getCredentialBlock(row.id, CODEX_PROVIDER_KEY, "shared")).toBeUndefined();
			const reconcileAfterMs = store.getCredentialBlockReconcileAfter(row.id, CODEX_PROVIDER_KEY, "chat");
			expect(reconcileAfterMs).toBeGreaterThan(Date.now());
			expect(reconcileAfterMs).toBeLessThan(blockedUntilMs);
		} finally {
			if (writerLocked) writer.run("ROLLBACK");
			writer.close();
			store.close();
		}
	});

	it("persists a Codex shared upsert as meter rows plus a hidden compatibility mirror", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		await store.saveOAuth(CODEX_PROVIDER, oauthCredential("upsert"));
		const [row] = store.listAuthCredentials(CODEX_PROVIDER);
		if (!row) throw new Error("expected credential row");
		const blockedUntilMs = FUTURE_BLOCK_MS + 60_000;

		store.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: CODEX_PROVIDER_KEY,
			blockScope: "shared",
			blockedUntilMs,
		});
		store.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: CODEX_PROVIDER_KEY,
			blockScope: "shared",
			blockedUntilMs: FUTURE_BLOCK_MS,
		});

		expect(store.listCredentialBlocks([row.id])).toEqual([
			{
				credentialId: row.id,
				providerKey: CODEX_PROVIDER_KEY,
				blockScope: "chat",
				blockedUntilMs,
				updatedAtMs: expect.any(Number),
			},
			{
				credentialId: row.id,
				providerKey: CODEX_PROVIDER_KEY,
				blockScope: "spark",
				blockedUntilMs,
				updatedAtMs: expect.any(Number),
			},
		]);
		expect(readLegacyCodexSharedBlock(dbPath, row.id)?.blocked_until_ms).toBe(blockedUntilMs);
		expect(readCredentialBlockRows(dbPath).map(block => block.block_scope)).toEqual(["chat", "shared", "spark"]);
		store.close();
	});

	it("recomputes and removes the legacy mirror as meter blocks are deleted", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		await store.saveOAuth(CODEX_PROVIDER, oauthCredential("delete-mirror"));
		const [row] = store.listAuthCredentials(CODEX_PROVIDER);
		if (!row) throw new Error("expected credential row");
		const chatBlockedUntilMs = FUTURE_BLOCK_MS + 120_000;
		const sparkBlockedUntilMs = FUTURE_BLOCK_MS + 60_000;

		store.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: CODEX_PROVIDER_KEY,
			blockScope: "chat",
			blockedUntilMs: chatBlockedUntilMs,
		});
		store.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: CODEX_PROVIDER_KEY,
			blockScope: "spark",
			blockedUntilMs: sparkBlockedUntilMs,
		});

		expect(readLegacyCodexSharedBlock(dbPath, row.id)?.blocked_until_ms).toBe(chatBlockedUntilMs);
		store.deleteCredentialBlock(row.id, CODEX_PROVIDER_KEY, "chat");
		expect(store.listCredentialBlocks([row.id])).toEqual([
			{
				credentialId: row.id,
				providerKey: CODEX_PROVIDER_KEY,
				blockScope: "spark",
				blockedUntilMs: sparkBlockedUntilMs,
				updatedAtMs: expect.any(Number),
			},
		]);
		expect(readLegacyCodexSharedBlock(dbPath, row.id)?.blocked_until_ms).toBe(sparkBlockedUntilMs);

		store.deleteCredentialBlock(row.id, CODEX_PROVIDER_KEY, "spark");
		expect(store.listCredentialBlocks([row.id])).toEqual([]);
		expect(readLegacyCodexSharedBlock(dbPath, row.id)).toBeUndefined();
		expect(readCredentialBlockRows(dbPath)).toEqual([]);
		store.close();
	});

	it("keeps current bulk deletes and legacy shared deletes synchronized", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		await store.saveOAuth(CODEX_PROVIDER, oauthCredential("delete-compatible"));
		const [row] = store.listAuthCredentials(CODEX_PROVIDER);
		if (!row) throw new Error("expected credential row");
		const upsertMeterBlocks = (): void => {
			for (const blockScope of ["chat", "spark"]) {
				store.upsertCredentialBlock({
					credentialId: row.id,
					providerKey: CODEX_PROVIDER_KEY,
					blockScope,
					blockedUntilMs: FUTURE_BLOCK_MS,
				});
			}
		};

		upsertMeterBlocks();
		store.deleteCredentialBlocks(row.id);
		expect(readCredentialBlockRows(dbPath)).toEqual([]);

		upsertMeterBlocks();
		const legacyWriter = new Database(dbPath);
		try {
			legacyWriter
				.prepare(
					"DELETE FROM auth_credential_blocks WHERE credential_id = ? AND provider_key = ? AND block_scope = 'shared'",
				)
				.run(row.id, CODEX_PROVIDER_KEY);
		} finally {
			legacyWriter.close();
		}
		expect(store.listCredentialBlocks([row.id])).toEqual([]);
		expect(readCredentialBlockRows(dbPath)).toEqual([]);
		store.close();
	});

	it("backfills refresh leases for a v5 auth database", async () => {
		const legacyDb = new Database(dbPath);
		legacyDb.run(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 5);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
		`);
		legacyDb.close();

		const migratedStore = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const expiresAtMs = Date.now() + 3_600_000;
			expect(migratedStore.tryAcquireCredentialRefreshLease(1, "test-owner", expiresAtMs)).toBe(true);
			expect(migratedStore.getCredentialRefreshLeaseExpiresAt(1)).toBe(expiresAtMs);
			expect(readAuthSchemaVersion(dbPath)).toBe(8);
		} finally {
			migratedStore.close();
		}
	});

	it("migrates a v4 auth database to current version 7 without dropping credential rows", async () => {
		const legacyDb = new Database(dbPath);
		legacyDb.run(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 4);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
			);
		`);
		legacyDb
			.prepare(
				"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				PROVIDER,
				"oauth",
				JSON.stringify({
					access: "legacy-access",
					refresh: "legacy-refresh",
					expires: Date.now() + 3_600_000,
					accountId: "legacy-account",
					email: "legacy@example.com",
				}),
				null,
				"email:legacy@example.com",
				LEGACY_TIMESTAMP,
				LEGACY_TIMESTAMP,
			);
		legacyDb.close();

		const migratedStore = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const rows = migratedStore.listAuthCredentials(PROVIDER);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.credential).toMatchObject({ type: "oauth", access: "legacy-access" });
			expect(readAuthSchemaVersion(dbPath)).toBe(8);
			expect(tableExists(dbPath, "auth_credential_blocks")).toBe(true);
		} finally {
			migratedStore.close();
		}
	});
});
