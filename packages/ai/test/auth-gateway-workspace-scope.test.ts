/**
 * A pooled Anthropic API key that is not scoped to a workspace must name its
 * own workspace (`anthropic-workspace-id`) on every request the gateway sends
 * with it, retries included: a request rotated to a sibling key carries the
 * sibling's workspace, never the failed key's.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Hi", timestamp: 1 }],
};

const SSE = `${[
	{
		type: "message_start",
		message: {
			id: "msg_workspace_scope",
			type: "message",
			role: "assistant",
			model: "claude-opus-4-7",
			content: [],
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
]
	.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`)
	.join("\n\n")}\n\n`;

const USAGE_LIMIT = {
	type: "error",
	error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit." },
};

describe("auth-gateway Anthropic workspace scope", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	it("sends each pooled key's own workspace, also after rotating to a sibling key", async () => {
		const requests: Array<{ key: string | null; workspace: string | null }> = [];
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (req): Response => {
				const key = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
				requests.push({ key, workspace: req.headers.get("anthropic-workspace-id") });
				if (key === "sk-ant-api03-spent") {
					return new Response(JSON.stringify(USAGE_LIMIT), {
						status: 429,
						headers: { "Content-Type": "application/json", "retry-after": "3600" },
					});
				}
				return new Response(SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } });
			},
		});
		cleanups.push(() => upstream.stop(true));
		const model = buildModel({
			id: "claude-opus-4-7",
			name: "claude-opus-4-7",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: `http://127.0.0.1:${upstream.port}`,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		});
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-workspace-scope-"));
		cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		cleanups.push(() => storage.close());
		await storage.credentials.addApiKey("anthropic", "sk-ant-api03-spent", { workspaceId: "wrkspc_spent" });
		await storage.credentials.addApiKey("anthropic", "sk-ant-api03-fresh", { workspaceId: "wrkspc_fresh" });
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["test-token"],
			storage,
			resolveModel: () => model,
			version: "test",
		});
		cleanups.push(() => gateway.close());

		const response = await fetch(`${gateway.url}/v1/pi/stream`, {
			method: "POST",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: JSON.stringify({ modelId: model.id, context: CONTEXT, options: { sessionId: "scope" }, stream: false }),
		});

		expect(response.status).toBe(200);
		expect(requests).toEqual([
			{ key: "sk-ant-api03-spent", workspace: "wrkspc_spent" },
			{ key: "sk-ant-api03-fresh", workspace: "wrkspc_fresh" },
		]);
	});
});
