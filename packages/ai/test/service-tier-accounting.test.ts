import { describe, expect, it } from "bun:test";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, ProviderSessionState, ServiceTier } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toBase64()}.fixture`;
const context: Context = { systemPrompt: ["system"], messages: [{ role: "user", content: "Request", timestamp: 1 }] };

function events(echo: ServiceTier | undefined, malformed?: number | string) {
	const item = {
		type: "message",
		id: "msg_fixture",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "Answer" }],
	};
	const events = [
		{ type: "response.created", response: { id: "resp_fixture" } },
		{ type: "response.output_item.added", item: { ...item, status: "in_progress", content: [] } },
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Answer" },
		{ type: "response.output_item.done", item },
		{
			type: "response.completed",
			response: malformed ?? {
				id: "resp_fixture",
				status: "completed",
				service_tier: echo,
				usage: {
					input_tokens: 100,
					output_tokens: 20,
					total_tokens: 120,
					input_tokens_details: { cached_tokens: 20 },
				},
			},
		},
	];
	return events;
}

function response(echo: ServiceTier | undefined, malformed?: number | string): Response {
	return new Response(
		events(echo, malformed)
			.map(event => `data: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{
			headers: { "content-type": "text/event-stream" },
		},
	);
}

describe("serving-tier accounting on real provider request flows", () => {
	it("accounts for hook-adjusted WebSocket tiers despite the backend's default echo", async () => {
		const sent: Array<string | undefined> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) return undefined;
				return new Response("upgrade", { status: 400 });
			},
			websocket: {
				message(socket, raw) {
					const payload = JSON.parse(String(raw));
					if (!isRecord(payload)) throw new Error("Expected WebSocket payload");
					sent.push(typeof payload.service_tier === "string" ? payload.service_tier : undefined);
					for (const event of events("default")) socket.send(JSON.stringify(event));
				},
			},
		});
		const model = buildModel({
			id: "gpt-6-astra",
			name: "Astra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: `http://127.0.0.1:${server.port}`,
			reasoning: true,
			input: ["text"],
			serviceTiers: ["priority", "ultrafast"],
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 8192,
		});
		const states = new Map<string, ProviderSessionState>();
		try {
			for (const rewrite of ["ultrafast", "omit"]) {
				const result = await streamOpenAICodexResponses(model, context, {
					apiKey: token,
					sessionId: `tier-${rewrite}`,
					providerSessionState: states,
					preferWebsockets: true,
					serviceTier: "priority",
					onPayload: payload => {
						if (!isRecord(payload)) throw new Error("Expected payload");
						if (rewrite === "omit") delete payload.service_tier;
						else payload.service_tier = rewrite;
					},
				}).result();
				expect(result.stopReason, result.errorMessage).toBe("stop");
				expect(result.serviceTier).toBe(rewrite === "omit" ? "default" : "ultrafast");
				expect(result.usage.premiumRequests).toBe(rewrite === "omit" ? 0 : 1);
				expect(result.usage.cost.total).toBeCloseTo(
					((80 * 10 + 20 * 50 + 20) / 1_000_000) * (rewrite === "omit" ? 1 : 8),
					10,
				);
			}
			expect(sent).toEqual(["ultrafast", undefined]);
		} finally {
			for (const state of states.values()) state.close();
			await server.stop(true);
		}
	});
	it.each([7, "default"])("retains completed output when terminal metadata is a primitive: %s", async malformed => {
		const model = buildModel({
			id: "gpt-6-astra",
			name: "Astra",
			provider: "openai",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 8192,
		});
		const result = await streamOpenAIResponses(model, context, {
			apiKey: "fixture",
			serviceTier: "priority",
			fetch: async () => response(undefined, malformed),
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toMatchObject([{ type: "text", text: "Answer" }]);
		expect(result.serviceTier).toBe("priority");
		expect(result.errorMessage).toBeUndefined();
	});
	const cases: Array<{
		requested: ServiceTier;
		echo?: ServiceTier;
		rewrite?: ServiceTier | "omit";
		advertised?: string[];
		served: ServiceTier;
		multiplier: number;
	}> = [
		{ requested: "default", echo: "default", served: "default", multiplier: 1 },
		{ requested: "priority", echo: "default", served: "priority", multiplier: 2.5 },
		{ requested: "priority", echo: "auto", served: "priority", multiplier: 2.5 },
		{ requested: "priority", served: "priority", multiplier: 2.5 },
		{ requested: "priority", echo: "flex", served: "flex", multiplier: 0.5 },
		{ requested: "ultrafast", echo: "ultrafast", served: "ultrafast", multiplier: 8 },
		{ requested: "priority", echo: "default", rewrite: "omit", served: "default", multiplier: 1 },
		{ requested: "priority", echo: "default", rewrite: "ultrafast", served: "ultrafast", multiplier: 8 },
		{ requested: "priority", echo: "default", advertised: ["ultrafast"], served: "default", multiplier: 1 },
	];
	for (const id of ["gpt-6-astra", "gpt-6.1-sol"]) {
		it(`records the sent/served Codex tier and scales every cost component for ${id}`, async () => {
			const bundled = getBundledModel<"openai-codex-responses">("openai-codex", id);
			if (!bundled || bundled.api !== "openai-codex-responses") throw new Error("Expected bundled Codex model");
			for (const entry of cases) {
				const model = buildModel<"openai-codex-responses">({
					...bundled,
					api: "openai-codex-responses",
					preferWebsockets: false,
					serviceTiers: entry.advertised ?? ["priority", "ultrafast"],
				});
				let sentTier: string | undefined;
				const fetch: FetchImpl = async (_url, options) => {
					const body = options?.body;
					const raw =
						typeof body === "string"
							? body
							: body instanceof Uint8Array
								? new TextDecoder().decode(Bun.zstdDecompressSync(body))
								: "";
					const payload = JSON.parse(raw);
					if (!isRecord(payload)) throw new Error("Expected request payload");
					sentTier = typeof payload.service_tier === "string" ? payload.service_tier : undefined;
					return response(entry.echo);
				};
				const result = await streamOpenAICodexResponses(
					model,
					{ ...context, messages: [{ role: "user", content: "Request", timestamp: 1 }] },
					{
						apiKey: token,
						fetch,
						preferWebsockets: false,
						serviceTier: entry.requested,
						onPayload: payload => {
							if (!isRecord(payload)) throw new Error("Expected mutable request payload");
							if (entry.rewrite === "omit") delete payload.service_tier;
							else if (entry.rewrite) payload.service_tier = entry.rewrite;
						},
					},
				).result();
				expect(result.stopReason).toBe("stop");
				expect(result.serviceTier).toBe(entry.served);
				expect(result.usage.premiumRequests).toBe(
					entry.served === "priority" || entry.served === "ultrafast" ? 1 : 0,
				);
				expect(result.usage.cost.input).toBeCloseTo(((80 * model.cost.input) / 1_000_000) * entry.multiplier, 10);
				expect(result.usage.cost.output).toBeCloseTo(((20 * model.cost.output) / 1_000_000) * entry.multiplier, 10);
				expect(result.usage.cost.cacheRead).toBeCloseTo(
					((20 * model.cost.cacheRead) / 1_000_000) * entry.multiplier,
					10,
				);
				if (entry.rewrite === "omit" || entry.advertised) expect(sentTier).toBeUndefined();
				if (entry.rewrite === "ultrafast") expect(sentTier).toBe("ultrafast");
			}
		});
	}

	it("treats an OpenAI default echo as authoritative and prices API Ultrafast at six times standard", async () => {
		const model = buildModel({
			id: "gpt-6-astra",
			name: "Astra",
			provider: "openai",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 8192,
		});
		for (const echo of ["default", "ultrafast"]) {
			const tier = echo === "default" ? "default" : "ultrafast";
			const result = await streamOpenAIResponses(
				model,
				{ ...context, messages: [{ role: "user", content: "Request", timestamp: 1 }] },
				{ apiKey: "fixture", serviceTier: "ultrafast", fetch: async () => response(tier) },
			).result();
			expect(result.stopReason).toBe("stop");
			expect(result.serviceTier).toBe(tier);
			expect(result.usage.premiumRequests).toBe(tier === "ultrafast" ? 1 : 0);
			expect(result.usage.cost.total).toBeCloseTo(
				((80 * 10 + 20 * 50 + 20) / 1_000_000) * (tier === "ultrafast" ? 6 : 1),
				10,
			);
		}
	});
});
