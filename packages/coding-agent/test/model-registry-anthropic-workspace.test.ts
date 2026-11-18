import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { type FetchImpl, removeWithRetries } from "@oh-my-pi/pi-utils";

const POOLED_KEY = "sk-ant-api03-POOLEDdiscoveryKey000000";

let tempDir = "";
let authStorage: AuthStorage;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-anthropic-discovery-"));
	authStorage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
	await authStorage.credentials.reload();
});

afterEach(async () => {
	authStorage.close();
	await removeWithRetries(tempDir);
});

it("lists Anthropic models with the workspace of the pooled key that discovers them", async () => {
	await authStorage.credentials.addApiKey("anthropic", POOLED_KEY, { workspaceId: "wrkspc_01DISCOVERYworkspace" });
	const listings: Headers[] = [];
	const fetch: FetchImpl = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url !== "https://api.anthropic.com/v1/models") return new Response("not found", { status: 404 });
		listings.push(new Headers(init?.headers));
		return Response.json({ data: [{ type: "model", id: "claude-opus-5", display_name: "Claude Opus 5" }] });
	};
	const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), {
		fetch,
		ignoreLocalModelConfig: true,
		cacheDbPath: path.join(tempDir, "models.db"),
	});

	await registry.refreshProvider("anthropic", "online");

	expect(listings.map(headers => [headers.get("x-api-key"), headers.get("anthropic-workspace-id")])).toEqual([
		[POOLED_KEY, "wrkspc_01DISCOVERYworkspace"],
	]);
});
