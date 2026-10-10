import { describe, expect, it } from "bun:test";
import {
	getOpenAICodexTransportDetails,
	prewarmOpenAICodexResponses,
	setCodexAttestationProvider,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Message, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

describe("routing session release", () => {
	it("does not open a prewarm socket after its owner is released during attestation", async () => {
		let opened = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) return undefined;
				return new Response("upgrade", { status: 400 });
			},
			websocket: {
				open() {
					opened++;
				},
				message() {},
			},
		});
		const model = buildModel({
			id: "gpt-5.5",
			name: "Codex prewarm",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: `http://127.0.0.1:${server.port}`,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8192,
		});
		const entered = Promise.withResolvers<void>();
		const attestation = Promise.withResolvers<string | undefined>();
		setCodexAttestationProvider(() => {
			entered.resolve();
			return attestation.promise;
		});
		const states = new Map<string, ProviderSessionState>();
		const options = {
			apiKey: `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "audit" } })).toBase64()}.bbb`,
			sessionId: "released-prewarm",
			providerSessionState: states,
			preferWebsockets: true,
		};
		try {
			const pending = prewarmOpenAICodexResponses(model, options);
			await entered.promise;
			for (const state of states.values()) state.releaseSession?.(options.sessionId);
			attestation.resolve(undefined);
			await pending;
			expect(opened).toBe(0);
			expect(getOpenAICodexTransportDetails(model, options)).toMatchObject({
				hasSessionState: false,
				websocketConnected: false,
			});
			await prewarmOpenAICodexResponses(model, { ...options, sessionId: "replacement-owner" });
			expect(opened).toBe(1);
		} finally {
			attestation.resolve(undefined);
			setCodexAttestationProvider(undefined);
			for (const state of states.values()) state.close();
			await server.stop(true);
		}
	});
	it("releases both credential variants of a side session while the parent socket continues its chain", async () => {
		const previousIds: Array<string | undefined> = [];
		let opened = 0;
		let closedCount = 0;
		const released = Promise.withResolvers<void>();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) return undefined;
				return new Response("WebSocket required", { status: 400 });
			},
			websocket: {
				open() {
					opened++;
				},
				message(socket, message) {
					const payload = JSON.parse(String(message));
					if (!isRecord(payload)) throw new Error("Expected a provider request");
					previousIds.push(
						typeof payload.previous_response_id === "string" ? payload.previous_response_id : undefined,
					);
					const id = `resp_${previousIds.length}`;
					const item = {
						type: "message",
						id: `msg_${id}`,
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "Answer" }],
					};
					for (const event of [
						{ type: "response.created", response: { id } },
						{ type: "response.output_item.added", item: { ...item, status: "in_progress", content: [] } },
						{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
						{ type: "response.output_text.delta", delta: "Answer" },
						{ type: "response.output_item.done", item },
						{
							type: "response.completed",
							response: {
								id,
								status: "completed",
								usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
							},
						},
					])
						socket.send(JSON.stringify(event));
				},
				close() {
					if (++closedCount === 2) released.resolve();
				},
			},
		});
		const model = buildModel({
			id: "gpt-5.5",
			name: "Codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: `http://127.0.0.1:${server.port}`,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8192,
		});
		const states = new Map<string, ProviderSessionState>();
		const token = (account: string) =>
			`aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toBase64()}.bbb`;
		const options = { apiKey: token("account-a"), providerSessionState: states, preferWebsockets: true };
		const messages: Message[] = [{ role: "user", content: "First question", timestamp: 1 }];
		const context = { systemPrompt: ["system"], messages };
		const parent = { ...options, sessionId: "main" };
		const sideId = `side:${"long-session-id".repeat(8)}`;
		const side = { ...options, sessionId: sideId };
		try {
			const reply = await streamOpenAICodexResponses(model, context, parent).result();
			expect(reply.stopReason).toBe("stop");
			for (const variant of [side, { ...side, apiKey: token("account-b"), responsesLite: true }]) {
				expect((await streamOpenAICodexResponses(model, context, variant).result()).stopReason).toBe("stop");
			}
			expect(opened).toBe(3);
			for (const state of states.values()) state.releaseSession?.(sideId);
			expect(getOpenAICodexTransportDetails(model, side)).toMatchObject({
				hasSessionState: false,
				hasTurnState: false,
				websocketConnected: false,
			});
			await released.promise;
			expect(getOpenAICodexTransportDetails(model, parent).websocketConnected).toBe(true);
			const next = await streamOpenAICodexResponses(
				model,
				{
					...context,
					messages: [...messages, reply, { role: "user", content: "Follow up", timestamp: 2 }],
				},
				parent,
			).result();
			expect(next.stopReason).toBe("stop");
			expect(previousIds.at(-1)).toBe("resp_1");
			expect(opened).toBe(3);
		} finally {
			for (const state of states.values()) state.close();
			await server.stop(true);
		}
	});
});
