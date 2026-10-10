import { describe, expect, it } from "bun:test";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import * as codex from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { spyOn } from "bun:test";
import { TempDir, isRecord } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const model = buildModel({
	id: "gpt-5-mini",
	name: "Responses",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
});

function response(id: string): Response {
	const item = {
		type: "message",
		id: `msg_${id}`,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "Answer" }],
	};
	const events = [
		{ type: "response.created", response: { id } },
		{ type: "response.output_item.added", item: { ...item, status: "in_progress", content: [] } },
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Answer" },
		{ type: "response.output_item.done", item },
		{
			type: "response.completed",
			response: { id, status: "completed", usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } },
		},
	];
	return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function chainCount(states: Map<string, ProviderSessionState>): number {
	const state = states.get("openai-responses:openai");
	if (!state || !("chains" in state) || !(state.chains instanceof Map))
		throw new Error("Expected Responses routing state");
	return state.chains.size;
}

describe("one-shot provider-state lifetime", () => {
	it.each(["dispose", "new-session", "new-session-fixed-route", "new-session-inflight"])(
		"does not prewarm after %s while the startup key is pending",
		async transition => {
			using directory = TempDir.createSync("@pi-prewarm-owner-");
			const auth = createInMemoryAuthStorage();
			const registry = new ModelRegistry(auth, directory.join("models.yml"));
			const key = Promise.withResolvers<string>();
			const entered = Promise.withResolvers<void>();
			const manager = SessionManager.inMemory(directory.path());
			const flushing = Promise.withResolvers<void>();
			const flushGate = Promise.withResolvers<void>();
			let switchPending: Promise<boolean> | undefined;
			const flushSpy =
				transition === "new-session-inflight"
					? spyOn(manager, "flush").mockImplementation(() => {
							flushing.resolve();
							return flushGate.promise;
						})
					: undefined;
			const warm = spyOn(codex, "prewarmOpenAICodexResponses").mockResolvedValue();
			const codexModel = buildModel({
				id: "gpt-5.5",
				name: "Codex",
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8192,
				preferWebsockets: true,
			});
			const { session } = await createAgentSession({
				...(transition === "new-session-fixed-route" ? { providerSessionId: "fixed-route" } : {}),
				cwd: directory.path(),
				agentDir: directory.path(),
				sessionManager: manager,
				authStorage: auth,
				modelRegistry: registry,
				model: codexModel,
				settings: Settings.isolated({ "compaction.enabled": false }),
				getApiKey: () => {
					entered.resolve();
					return key.promise;
				},
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				taskDepth: 1,
				agentId: "prewarm-child",
			});
			try {
				await entered.promise;
				if (transition === "dispose") await session.dispose();
				else if (transition === "new-session-inflight") {
					switchPending = session.newSession();
					await flushing.promise;
					expect(session.isSessionTransitioning).toBe(true);
				} else await session.newSession();
				key.resolve("test-key");
				await new Promise<void>(resolve => setImmediate(resolve));
				expect(warm).not.toHaveBeenCalled();
				expect(session.providerSessionState.size).toBe(0);
			} finally {
				key.resolve("test-key");
				flushGate.resolve();
				await switchPending;
				flushSpy?.mockRestore();
				await session.dispose();
				warm.mockRestore();
				auth.close();
			}
		},
	);
	it("releases completed and failed one-shot requests while retaining reusable side conversations", async () => {
		using directory = TempDir.createSync("@pi-side-state-");
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("openai", "test-key");
		const settings = Settings.isolated({ "compaction.enabled": false });
		const registry = new ModelRegistry(auth, directory.join("models.yml"), { settings });
		const ids: Array<string | undefined> = [];
		const fetch: FetchImpl = async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			if (!isRecord(body)) throw new Error("Expected a Responses request");
			ids.push(typeof body.previous_response_id === "string" ? body.previous_response_id : undefined);
			return response(`resp_${ids.length}`);
		};
		const sideStreamFn: StreamFn = (_model, context, options) =>
			streamOpenAIResponses(model, context, {
				...options,
				apiKey: "test-key",
				statefulResponses: true,
				fetch,
			});
		const session = new AgentSession({
			agent: new Agent({
				promptCacheKey: "main-cache",
				initialState: { model, systemPrompt: ["system"], messages: [], tools: [] },
			}),
			sessionManager: SessionManager.inMemory(directory.path()),
			settings,
			modelRegistry: registry,
			sideStreamFn,
		});
		try {
			const topic = await session.runEphemeralTurn({ promptText: "Side question", conversationKey: "topic" });
			expect(topic.replyText).toBe("Answer");
			expect(chainCount(session.providerSessionState)).toBe(1);
			expect((await session.runEphemeralTurn({ promptText: "One-shot" })).replyText).toBe("Answer");
			expect(chainCount(session.providerSessionState)).toBe(1);
			await expect(
				session.runEphemeralTurn({
					promptText: "Delivery failure",
					onTextDelta: () => {
						throw new Error("Consumer stopped");
					},
				}),
			).rejects.toThrow("Consumer stopped");
			expect(chainCount(session.providerSessionState)).toBe(1);
			await session.runEphemeralTurn({
				promptText: "Follow-up",
				conversationKey: "topic",
				history: [
					{ role: "user", content: "Side question", attribution: "agent", timestamp: 1 },
					topic.assistantMessage,
				],
			});
			expect(ids.at(-1)).toBe("resp_1");
			expect(chainCount(session.providerSessionState)).toBe(1);
		} finally {
			await session.dispose();
			auth.close();
		}
	});
});
