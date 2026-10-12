import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { resolveAnthropicKeyWorkspace } from "@oh-my-pi/pi-ai/registry/api-key-validation";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { FetchImpl } from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "../../utils/src/temp";

const UNSCOPED_KEY = "sk-ant-api03-UNSCOPEDkeyForWorkspaceTest0001";
const SUBSCRIPTION = "sk-ant-oat01-SUBSCRIPTIONtokenForWorkspaceTest";
const WORKSPACE = "wrkspc_01WORKSPACEforTests";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const context: Context = { messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }] };

const SSE_EVENTS: Array<Record<string, unknown>> = [
	{
		type: "message_start",
		message: {
			id: "msg_workspace",
			type: "message",
			role: "assistant",
			model: model.id,
			content: [],
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
];

/** What the live API answers an unscoped key's request that names no workspace. */
const WORKSPACE_REQUIRED = {
	type: "error",
	error: {
		type: "invalid_request_error",
		message:
			"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.",
	},
};

interface FakeAnthropicApi {
	fetch: FetchImpl;
	/** Every request, in order. */
	seen: SeenRequest[];
	/** The Messages requests, in order. */
	messages(): SeenRequest[];
}

/** A typed `Request` for any argument shape `fetch` accepts. */
function toRequest(input: string | URL | Request, init?: RequestInit): Request {
	return input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
}

interface SeenRequest {
	url: string;
	apiKey: string | null;
	authorization: string | null;
	workspace: string | null;
}

/**
 * Stand-in Anthropic API. The unscoped key works only when a request names a
 * workspace the key can use; the subscription token always works.
 */
function anthropicApi(
	options: { workspaces?: Array<{ id: string; name: string }>; usable?: string[]; listable?: boolean } = {},
): FakeAnthropicApi {
	const workspaces = options.workspaces ?? [{ id: WORKSPACE, name: "Default Workspace" }];
	const usable = options.usable ?? workspaces.map(workspace => workspace.id);
	const seen: SeenRequest[] = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = toRequest(input, init);
		const headers = request.headers;
		const entry: SeenRequest = {
			url: request.url,
			apiKey: headers.get("x-api-key"),
			authorization: headers.get("authorization"),
			workspace: headers.get("anthropic-workspace-id"),
		};
		seen.push(entry);
		const url = new URL(request.url);
		if (url.pathname === "/v1/organizations/workspaces") {
			if (options.listable === false) return Response.json({ type: "error" }, { status: 403 });
			return Response.json({ data: workspaces.map(workspace => ({ ...workspace, archived_at: null })) });
		}
		if (entry.apiKey !== null) {
			if (entry.apiKey !== UNSCOPED_KEY) return Response.json({ type: "error" }, { status: 401 });
			if (entry.workspace === null) return Response.json(WORKSPACE_REQUIRED, { status: 400 });
			if (!usable.includes(entry.workspace)) return Response.json({ type: "error" }, { status: 403 });
		}
		if (url.pathname === "/v1/models") return Response.json({ data: [] });
		const body = SSE_EVENTS.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	};
	return { fetch, seen, messages: () => seen.filter(entry => entry.url.includes("/v1/messages")) };
}

describe("Anthropic API key workspaces", () => {
	let tempDir = "";
	let storage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-anthropic-workspace-"));
		storage = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")), {
			poolOrders: { anthropic: "api-keys-first" },
		});
		await storage.credentials.reload();
	});

	afterEach(async () => {
		storage.close();
		await removeWithRetries(tempDir);
	});

	async function ask(api: FakeAnthropicApi, headers?: Record<string, string>): Promise<string> {
		let text = "";
		const stream = streamSimple(model, context, {
			apiKey: storage.keys.resolver("anthropic", { sessionId: "session-1", modelId: model.id }),
			fetch: api.fetch,
			headers,
		});
		for await (const event of stream) {
			if (event.type === "text_delta") text += event.delta;
			if (event.type === "error") throw new Error(event.error.errorMessage);
		}
		return text;
	}

	it("sends a pooled key's stored workspace on every request it serves", async () => {
		const api = anthropicApi();
		const settled = await resolveAnthropicKeyWorkspace(
			UNSCOPED_KEY,
			{ pick: async () => undefined, ask: async () => undefined },
			{ baseUrl: model.baseUrl, fetch: api.fetch },
		);
		expect(settled).toEqual({ workspaceId: WORKSPACE });
		await storage.credentials.addApiKey("anthropic", UNSCOPED_KEY, settled);

		// Survives a reload: the workspace is stored with the key, not held in memory.
		const reopened = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		await reopened.credentials.reload();
		expect(reopened.credentials.pooledApiKeys("anthropic").map(row => row.credential.workspaceId)).toEqual([
			WORKSPACE,
		]);
		reopened.close();

		expect(await ask(api)).toBe("hi");
		expect(api.messages()).toEqual([
			expect.objectContaining({ apiKey: UNSCOPED_KEY, workspace: WORKSPACE, authorization: null }),
		]);
	});

	it("sets aside a key rejected for its workspace and serves the turn from a subscription", async () => {
		await storage.credentials.addApiKey("anthropic", UNSCOPED_KEY);
		await storage.credentials.upsert("anthropic", {
			type: "oauth",
			access: SUBSCRIPTION,
			refresh: "refresh-token",
			expires: Date.now() + 3_600_000,
			email: "max@example.com",
		});
		const api = anthropicApi();

		expect(await ask(api)).toBe("hi");

		const [rejected, served] = api.messages();
		expect(rejected).toEqual(expect.objectContaining({ apiKey: UNSCOPED_KEY, workspace: null }));
		expect(served?.authorization).toBe(`Bearer ${SUBSCRIPTION}`);
		// Set aside for hours, not the minute a transient denial gets.
		const keys = storage.limits.pools("anthropic", model.id).find(pool => pool.kind === "api_key");
		expect(keys?.blocked).toBe(1);
		expect(keys?.retryAtMs).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1000);
		// The next turn goes straight to the subscription.
		expect(await ask(api)).toBe("hi");
		expect(
			api
				.messages()
				.slice(2)
				.map(entry => entry.authorization),
		).toEqual([`Bearer ${SUBSCRIPTION}`]);

		// Adding the key again with its workspace is the fix: it serves at once.
		await storage.credentials.addApiKey("anthropic", UNSCOPED_KEY, { workspaceId: WORKSPACE });
		expect(await ask(api)).toBe("hi");
		expect(api.messages().slice(3)).toEqual([
			expect.objectContaining({ apiKey: UNSCOPED_KEY, workspace: WORKSPACE, authorization: null }),
		]);
	});

	it("sends the key's workspace in place of a configured one in any casing", async () => {
		await storage.credentials.addApiKey("anthropic", UNSCOPED_KEY, { workspaceId: WORKSPACE });
		const api = anthropicApi();

		expect(await ask(api, { "Anthropic-Workspace-Id": "wrkspc_01CONFIGURED" })).toBe("hi");

		// Two casings would reach the wire joined as "wrkspc_01CONFIGURED, wrkspc_…".
		expect(api.messages().map(entry => entry.workspace)).toEqual([WORKSPACE]);
	});

	it("re-adding a stored key replaces its workspace", async () => {
		await storage.credentials.addApiKey("anthropic", UNSCOPED_KEY);
		const api = anthropicApi();
		const settled = await resolveAnthropicKeyWorkspace(
			UNSCOPED_KEY,
			{ pick: async () => undefined, ask: async () => undefined },
			{ baseUrl: model.baseUrl, fetch: api.fetch },
		);
		const row = await storage.credentials.addApiKey("anthropic", UNSCOPED_KEY, settled);

		expect(storage.credentials.pooledApiKeys("anthropic")).toEqual([
			expect.objectContaining({ id: row.id, credential: expect.objectContaining({ workspaceId: WORKSPACE }) }),
		]);
		expect(await ask(api)).toBe("hi");
		expect(api.messages().map(entry => entry.workspace)).toEqual([WORKSPACE]);
	});
});

describe("settling an Anthropic key's workspace", () => {
	const neverAsked = { pick: async () => undefined, ask: async () => undefined };

	it("needs no workspace for a key scoped to one", async () => {
		const scopedKeyApi = async (input: string | URL | Request): Promise<Response> => {
			expect(toRequest(input).headers.get("anthropic-workspace-id")).toBeNull();
			return Response.json({ data: [] });
		};
		expect(
			await resolveAnthropicKeyWorkspace("sk-ant-api03-scoped", neverAsked, {
				baseUrl: model.baseUrl,
				fetch: scopedKeyApi,
			}),
		).toEqual({});
	});

	it("uses an explicit workspace as given, even when the key lists only another", async () => {
		const api = anthropicApi({
			workspaces: [{ id: "wrkspc_listed", name: "Default Workspace" }],
			usable: [WORKSPACE],
		});
		expect(
			await resolveAnthropicKeyWorkspace(UNSCOPED_KEY, neverAsked, {
				baseUrl: model.baseUrl,
				workspaceId: WORKSPACE,
				fetch: api.fetch,
			}),
		).toEqual({ workspaceId: WORKSPACE });
		expect(api.seen.map(entry => [new URL(entry.url).pathname, entry.workspace])).toEqual([
			["/v1/models", WORKSPACE],
		]);
		await expect(
			resolveAnthropicKeyWorkspace(UNSCOPED_KEY, neverAsked, {
				baseUrl: model.baseUrl,
				workspaceId: "wrkspc_listed",
				fetch: api.fetch,
			}),
		).rejects.toThrow(/validation failed \(403\)/);
	});

	it("asks the user to pick when the key can name several workspaces", async () => {
		const workspaces = [
			{ id: "wrkspc_first", name: "Default Workspace" },
			{ id: WORKSPACE, name: "Credits" },
		];
		const api = anthropicApi({ workspaces });
		let offered: unknown;
		const settled = await resolveAnthropicKeyWorkspace(
			UNSCOPED_KEY,
			{
				pick: async choices => {
					offered = choices;
					return WORKSPACE;
				},
				ask: async () => undefined,
			},
			{ baseUrl: model.baseUrl, fetch: api.fetch },
		);
		expect(offered).toEqual(workspaces);
		expect(settled).toEqual({ workspaceId: WORKSPACE });
		// Verified against the API with the chosen workspace before it is returned.
		expect(api.seen.at(-1)).toEqual(expect.objectContaining({ workspace: WORKSPACE }));
	});

	it("asks for the ID when the key may not list workspaces, and rejects one it cannot use", async () => {
		const api = anthropicApi({ listable: false });
		expect(
			await resolveAnthropicKeyWorkspace(
				UNSCOPED_KEY,
				{ pick: async () => undefined, ask: async () => ` ${WORKSPACE} ` },
				{ baseUrl: model.baseUrl, fetch: api.fetch },
			),
		).toEqual({ workspaceId: WORKSPACE });
		await expect(
			resolveAnthropicKeyWorkspace(
				UNSCOPED_KEY,
				{ pick: async () => undefined, ask: async () => "wrkspc_unknown" },
				{ baseUrl: model.baseUrl, fetch: api.fetch },
			),
		).rejects.toThrow(/validation failed \(403\)/);
	});

	it("stores nothing when the user cancels, and fails for an invalid key", async () => {
		const api = anthropicApi({ listable: false });
		expect(
			await resolveAnthropicKeyWorkspace(UNSCOPED_KEY, neverAsked, { baseUrl: model.baseUrl, fetch: api.fetch }),
		).toBeUndefined();
		await expect(
			resolveAnthropicKeyWorkspace("sk-ant-api03-revoked", neverAsked, { baseUrl: model.baseUrl, fetch: api.fetch }),
		).rejects.toThrow(/validation failed \(401\)/);
	});
});
