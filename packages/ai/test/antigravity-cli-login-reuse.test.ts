import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import type { OAuthCredential } from "../src/auth/types";
import { AGY_OAUTH_CLIENT_ID, parseAgyApiKey } from "../src/providers/antigravity-cli/credentials";
import type { OAuthPrompt } from "../src/registry/oauth/types";

// The paused google-antigravity login, issued to the same Google OAuth client as agy.
const storedGoogleLogin: OAuthCredential = {
	type: "oauth",
	access: "stale-google-access",
	refresh: "google-refresh",
	expires: Date.now() - 60_000,
	email: "owner@example.test",
	projectId: "fixture-project",
};

// The scopes google-antigravity's login requests, as the official client does; `aicode` among them.
const loginPolicy = authPolicyFor("google-antigravity")?.login;
const ANTIGRAVITY_SCOPES = loginPolicy?.kind === "oauth-code" ? loginPolicy.scopes : [];
const AICODE_SCOPE = "https://www.googleapis.com/auth/aicode";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function storageWithGoogleLogin(): Promise<{ store: SqliteAuthCredentialStore; storage: AuthStorage }> {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	await store.upsertAuthCredential("google-antigravity", storedGoogleLogin);
	const storage = new AuthStorage(store);
	await storage.credentials.reload();
	return { store, storage };
}

/** Answers the risk warning with "yes" and the stored-login choice with `choice`. */
function answers(choice: string, seen: OAuthPrompt[]): (prompt: OAuthPrompt) => Promise<string> {
	return async prompt => {
		seen.push(prompt);
		if (prompt.riskAcknowledgement) return "yes";
		if (prompt.storedLoginChoice) return choice;
		throw new Error(`unexpected prompt: ${prompt.message}`);
	};
}

describe("antigravity-cli login reuses a stored Google login", () => {
	it("adopts the google-antigravity grant through one agy-client refresh and leaves its row untouched", async () => {
		const { store, storage } = await storageWithGoogleLogin();
		const prompts: OAuthPrompt[] = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			expect(String(url)).toBe("https://oauth2.googleapis.com/token");
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("client_id")).toBe(AGY_OAUTH_CLIENT_ID);
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("refresh_token")).toBe("google-refresh");
			return Response.json({
				access_token: "agy-access",
				expires_in: 3600,
				scope: ["openid", ...ANTIGRAVITY_SCOPES].join(" "),
			});
		});
		try {
			const identity = await storage.oauth.login("antigravity-cli", {
				onAuth: () => {
					throw new Error("reuse must not start a browser sign-in");
				},
				onPrompt: answers("1", prompts),
				fetch: fetchImpl,
			});

			expect(identity).toMatchObject({ type: "oauth", email: "owner@example.test" });
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			const choice = prompts.find(prompt => prompt.storedLoginChoice);
			expect(choice?.message).toContain("1. owner@example.test (google-antigravity)");

			const [adopted] = store.listAuthCredentials("antigravity-cli");
			expect(adopted?.credential).toMatchObject({
				type: "oauth",
				access: "agy-access",
				refresh: "google-refresh",
				email: "owner@example.test",
			});
			expect(adopted?.credential).not.toHaveProperty("projectId");
			// The adopted credential serves antigravity-cli's own key pool.
			const key = await storage.keys.get("antigravity-cli");
			expect(key && parseAgyApiKey(key)).toMatchObject({ access: "agy-access", email: "owner@example.test" });
			expect(store.listAuthCredentials("google-antigravity").map(row => row.credential)).toEqual([
				storedGoogleLogin,
			]);
		} finally {
			store.close();
		}
	});

	it("refuses a stored login whose grant predates the aicode scope, and stores nothing", async () => {
		expect(ANTIGRAVITY_SCOPES).toContain(AICODE_SCOPE);
		const { store, storage } = await storageWithGoogleLogin();
		// The grant refreshes fine, but Google reports it without `aicode`.
		const fetchImpl = vi.fn(async () =>
			Response.json({
				access_token: "agy-access",
				expires_in: 3600,
				scope: ANTIGRAVITY_SCOPES.filter(scope => scope !== AICODE_SCOPE).join(" "),
			}),
		);
		try {
			await expect(
				storage.oauth.login("antigravity-cli", {
					onAuth: () => {},
					onPrompt: answers("1", []),
					fetch: fetchImpl,
				}),
			).rejects.toThrow(`predates the permissions Antigravity CLI needs (${AICODE_SCOPE})`);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			expect(store.listAuthCredentials("antigravity-cli")).toEqual([]);
			expect(store.listAuthCredentials("google-antigravity").map(row => row.credential)).toEqual([
				storedGoogleLogin,
			]);
		} finally {
			store.close();
		}
	});

	it("refuses an answer that names no stored login, before any token request", async () => {
		const { store, storage } = await storageWithGoogleLogin();
		const fetchImpl = vi.fn(async () => Response.json({}));
		try {
			await expect(
				storage.oauth.login("antigravity-cli", {
					onAuth: () => {},
					onPrompt: answers("2", []),
					fetch: fetchImpl,
				}),
			).rejects.toThrow("Type a number from 1 to 1");
			expect(fetchImpl).not.toHaveBeenCalled();
			expect(store.listAuthCredentials("antigravity-cli")).toEqual([]);
		} finally {
			store.close();
		}
	});

	it.skipIf(process.platform === "win32")(
		"runs agy's own sign-in when the stored login is declined",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-login-reuse-"));
			directories.push(root);
			const executable = path.join(root, "fixture-agy");
			await fs.writeFile(
				executable,
				`#!${process.execPath}
import * as fs from "node:fs/promises";
import * as path from "node:path";
const args = process.argv.slice(2);
const appData = args[args.indexOf("--app-data-dir") + 1];
process.stdout.write("https://accounts.google.com/o/oauth2/v2/auth?client_id=${AGY_OAUTH_CLIENT_ID}&state=fixture\\n");
if ((await Bun.stdin.text()).trim() !== "fixture-code") process.exit(8);
await fs.mkdir(appData, {recursive: true, mode: 0o700});
await fs.writeFile(path.join(appData, "antigravity-oauth-token"), JSON.stringify({
	token: {access_token: "agy-signin-access", refresh_token: "agy-signin-refresh", token_type: "Bearer", expiry: new Date(Date.now() + 3600000).toISOString()},
	auth_method: "consumer", id_token_email: "other@example.test"
}), {mode: 0o600});
`,
				{ mode: 0o700 },
			);
			const authStorageUrl = new URL("../src/auth-storage.ts", import.meta.url).href;
			const runner = `
import { Database } from "bun:sqlite";
import { AuthStorage, SqliteAuthCredentialStore } from ${JSON.stringify(authStorageUrl)};
const store = new SqliteAuthCredentialStore(new Database(":memory:"));
await store.upsertAuthCredential("google-antigravity", ${JSON.stringify(storedGoogleLogin)});
const storage = new AuthStorage(store);
await storage.credentials.reload();
const prompts = [];
let authUrl = "";
await storage.oauth.login("antigravity-cli", {
	onAuth: info => { authUrl = info.url; },
	onPrompt: async prompt => {
		prompts.push(prompt.riskAcknowledgement ? "risk" : prompt.storedLoginChoice ? "choice" : "code");
		return prompt.riskAcknowledgement ? "yes" : prompt.storedLoginChoice ? "" : "fixture-code";
	},
	fetch: async () => { throw new Error("declining must not refresh the stored login"); },
});
console.log(JSON.stringify({
	prompts,
	signedIn: authUrl.startsWith("https://accounts.google.com/"),
	adopted: store.listAuthCredentials("antigravity-cli").map(row => [row.credential.refresh, row.credential.email]),
	source: store.listAuthCredentials("google-antigravity").map(row => row.credential.refresh),
}));
store.close();
`;
			const child = Bun.spawn([process.execPath, "--eval", runner], {
				env: {
					...process.env,
					HOME: root,
					USERPROFILE: root,
					PI_CONFIG_DIR: ".omp-fixture",
					PI_CODING_AGENT_DIR: path.join(root, "agent"),
					PI_AGY_PATH: executable,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			try {
				const text = await new Response(child.stdout).text();
				const stderr = await new Response(child.stderr).text();
				expect({ exitCode: await child.exited, stderr }).toMatchObject({ exitCode: 0 });
				expect(JSON.parse(text)).toEqual({
					prompts: ["risk", "choice", "code"],
					signedIn: true,
					adopted: [["agy-signin-refresh", "other@example.test"]],
					source: ["google-refresh"],
				});
			} finally {
				child.kill("SIGKILL");
			}
		},
		15_000,
	);
});
