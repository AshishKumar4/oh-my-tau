import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type StreamFn, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Context, FetchImpl, Message, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import * as codex from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

function response(id: string): Response {
	const events = [
		{ type: "response.created", response: { id } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: `msg_${id}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Answer" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: `msg_${id}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Answer" }],
			},
		},
		{
			type: "response.completed",
			response: { id, status: "completed", usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } },
		},
	];
	return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

interface ResponsesState extends ProviderSessionState {
	chains: Map<string, unknown>;
}

/** Fields of an OpenAI Responses request body that the effort-replay test inspects. */
const responsesRequest = type({
	input: type({
		"type?": "string",
		"role?": "string",
		"content?": "unknown",
		"reasoning?": { effort: "string" },
	}).array(),
	"reasoning?": { "effort?": "string" },
});
type ResponsesRequest = typeof responsesRequest.infer;

const userContent = type({ text: "string" }).array();

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

describe("one-shot side request state", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	function createSession(sideStreamFn: StreamFn, sessionModel: Model<"openai-responses"> = model): AgentSession {
		const session = new AgentSession({
			agent: new Agent({
				promptCacheKey: "main-cache",
				initialState: {
					model: sessionModel,
					systemPrompt: ["system prompt"],
					messages: [{ role: "user", content: "Main question", timestamp: 1 }],
					tools: [],
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {
				resolver: () => async () => "test-key",
				authStorage: { usage: { ingestHeaders() {} }, oauth: { identity() {} } },
				hasLazyRuntimeMetadata: () => false,
			} as never,
			sideStreamFn,
		});
		sessions.push(session);
		return session;
	}

	it("releases completed one-shot histories while preserving main and reusable side response chains", async () => {
		const requests: Record<string, unknown>[] = [];
		const fetch: FetchImpl = async (_url, init) => {
			requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return response(`resp_${requests.length}`);
		};
		const session = createSession((_model, context, options) =>
			streamOpenAIResponses(model, context, { ...options, apiKey: "test-key", statefulResponses: true, fetch }),
		);
		const mainContext: Context = { systemPrompt: ["main system"], messages: session.messages as Message[] };
		const mainOptions = {
			apiKey: "test-key",
			sessionId: session.sessionId,
			providerSessionState: session.providerSessionState,
			statefulResponses: true,
			fetch,
		};
		const mainReply = await streamOpenAIResponses(model, mainContext, mainOptions).result();
		const sideReply = await session.runEphemeralTurn({ promptText: "Side question", conversationKey: "topic" });
		const state = session.providerSessionState.get("openai-responses:openai") as ResponsesState;
		expect(state.chains.size).toBe(2);
		expect((await session.runEphemeralTurn({ promptText: "One-shot question" })).replyText).toBe("Answer");
		expect(state.chains.size).toBe(2);
		await session.runEphemeralTurn({
			promptText: "Side follow-up",
			conversationKey: "topic",
			history: [
				{ role: "user", content: "Side question", attribution: "agent", timestamp: 2 },
				sideReply.assistantMessage,
			],
		});
		await streamOpenAIResponses(
			model,
			{
				...mainContext,
				messages: [...mainContext.messages, mainReply, { role: "user", content: "Main follow-up", timestamp: 3 }],
			},
			mainOptions,
		).result();
		expect(requests[2].previous_response_id).toBeUndefined();
		expect(requests[2].prompt_cache_key).toBe("main-cache");
		expect(requests[3].previous_response_id).toBe("resp_2");
		expect(requests[4].previous_response_id).toBe("resp_1");
	});

	it("keeps an overlapping one-shot request alive when another finishes", async () => {
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let requests = 0;
		const session = createSession((_model, context, options) =>
			streamOpenAIResponses(model, context, {
				...options,
				apiKey: "test-key",
				statefulResponses: true,
				fetch: async () => {
					const id = ++requests;
					if (id === 1) {
						entered.resolve();
						await finish.promise;
					}
					return response(`resp_${id}`);
				},
			}),
		);
		const pending = session.runEphemeralTurn({ promptText: "Pending question" });
		try {
			await entered.promise;
			expect((await session.runEphemeralTurn({ promptText: "Fast question" })).replyText).toBe("Answer");
			const state = session.providerSessionState.get("openai-responses:openai") as ResponsesState;
			expect(state.chains.size).toBe(1);
			finish.resolve();
			expect((await pending).replyText).toBe("Answer");
			expect(state.chains.size).toBe(0);
		} finally {
			finish.resolve();
			await pending.catch(() => {});
		}
	});

	it("preserves learned strict-tool fallback across completed one-shot requests", async () => {
		const strictFlags: Array<boolean | undefined> = [];
		const session = createSession((_model, context, options) =>
			streamOpenAIResponses(model, context, {
				...options,
				apiKey: "test-key",
				statefulResponses: true,
				fetch: async (_url, init) => {
					const body = JSON.parse(String(init?.body)) as { tools: Array<{ strict?: boolean }> };
					strictFlags.push(body.tools[0]?.strict);
					if (strictFlags.length === 1) {
						return new Response(
							JSON.stringify({
								error: {
									type: "invalid_request_error",
									message:
										"The compiled grammar is too large. Simplify your tool schemas or reduce the number of strict tools.",
								},
							}),
							{ status: 400, headers: { "content-type": "application/json" } },
						);
					}
					return response(`resp_${strictFlags.length}`);
				},
			}),
		);
		session.agent.setTools([
			{
				name: "lookup",
				label: "Lookup",
				description: "Look up a value",
				parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
				execute: async () => ({ content: [], details: {} }),
			},
		]);
		for (const promptText of ["First question", "Second question"]) {
			expect((await session.runEphemeralTurn({ promptText })).replyText).toBe("Answer");
		}
		expect(strictFlags).toEqual([true, undefined, undefined]);
		const state = session.providerSessionState.get("openai-responses:openai") as ResponsesState;
		expect(state.chains.size).toBe(0);
	});

	it.each(["transport error", "abort", "delivery error"])("releases one-shot history after %s", async failure => {
		const entered = Promise.withResolvers<void>();
		const abort = new AbortController();
		const session = createSession((_model, context, options) =>
			streamOpenAIResponses(model, context, {
				...options,
				apiKey: "test-key",
				statefulResponses: true,
				fetch: async () => {
					if (failure === "transport error") {
						return new Response(JSON.stringify({ error: { message: "Invalid side request" } }), { status: 400 });
					}
					if (failure === "abort") {
						options?.signal?.throwIfAborted();
						const pending = Promise.withResolvers<Response>();
						options?.signal?.addEventListener("abort", () => pending.reject(options.signal?.reason), {
							once: true,
						});
						entered.resolve();
						return pending.promise;
					}
					return response("resp_delivery");
				},
			}),
		);
		const turn = session.runEphemeralTurn({
			promptText: "One-shot question",
			signal: abort.signal,
			onTextDelta: () => {
				if (failure === "delivery error") throw new Error("Delivery failed");
			},
		});
		if (failure === "abort") {
			await entered.promise;
			abort.abort();
		}
		await expect(turn).rejects.toThrow(
			failure === "transport error" ? "Invalid side request" : failure === "abort" ? /abort/i : "Delivery failed",
		);
		const state = session.providerSessionState.get("openai-responses:openai") as ResponsesState;
		expect(state.chains.size).toBe(0);
	});

	it("replays the main conversation's effort updates on side requests and minimizes effort as one more update", async () => {
		const astra = getBundledModel("openai", "gpt-6-astra") as Model<"openai-responses">;
		const bodies: ResponsesRequest[] = [];
		const fetch: FetchImpl = async (_url, init) => {
			bodies.push(responsesRequest.assert(JSON.parse(String(init?.body))));
			return response(`resp_${bodies.length}`);
		};
		const session = createSession(
			(_model, context, options) =>
				streamOpenAIResponses(astra, context, { ...options, apiKey: "test-key", statefulResponses: false, fetch }),
			astra,
		);
		const main = (messages: Message[], reasoning: "high" | "medium") =>
			streamOpenAIResponses(
				astra,
				{ systemPrompt: ["system prompt"], messages },
				{
					apiKey: "test-key",
					sessionId: session.sessionId,
					providerSessionState: session.providerSessionState,
					statefulResponses: false,
					reasoning,
					fetch,
				},
			).result();
		const first: Message = { role: "user", content: "Main question", timestamp: 1 };
		const firstReply = await main([first], "high");
		const second: Message = { role: "user", content: "Follow-up", timestamp: 2 };
		const secondReply = await main([first, firstReply, second], "medium");
		const history = [first, firstReply, second, secondReply];
		session.agent.replaceMessages(history);
		session.setThinkingLevel(ThinkingLevel.Medium);

		await session.runEphemeralTurn({ promptText: "Side question" });
		await session.runEphemeralTurn({ promptText: "Predict.", minimizeEffort: true });
		await main([...history, { role: "user", content: "Third", timestamp: 3 }], "medium");

		// Updates and user turns, in wire order; assistant output is irrelevant here.
		const shape = (body: ResponsesRequest | undefined) =>
			(body?.input ?? []).flatMap(item => {
				if (item.type === "configuration_update") return [`update:${item.reasoning?.effort}`];
				if (item.role !== "user") return [];
				const [part] = userContent.assert(item.content);
				return [`user:${part?.text}`];
			});
		const [, mainFollowUp, side, minimized, mainNext] = bodies;
		const prefix = shape(mainFollowUp);
		expect(prefix).toContain("update:medium");
		// Side requests keep the main request-level effort and its update, so they reuse its cached prefix.
		for (const body of [side, minimized, mainNext]) {
			expect(body?.reasoning?.effort).toBe("high");
			expect(shape(body).slice(0, prefix.length)).toEqual(prefix);
		}
		// Each side request appends its no-tools reminder, then the prompt.
		expect(shape(side).slice(prefix.length)).toEqual([expect.any(String), "user:Side question"]);
		expect(shape(minimized).slice(prefix.length)).toEqual([expect.any(String), "update:low", "user:Predict."]);
		// The minimized side request's update never reaches the main conversation.
		expect(shape(mainNext).slice(prefix.length)).toEqual(["user:Third"]);
	});

	it("cleans up a rejected stream factory without masking its error when another provider cleanup throws", async () => {
		const retained = new Set<string>();
		const session = createSession(async (_model, _context, options) => {
			const sessionId = options?.sessionId;
			if (!sessionId) throw new Error("Missing side session id");
			retained.add(sessionId);
			throw new Error("Factory failed");
		});
		session.providerSessionState.set("throwing", {
			close() {},
			releaseSession() {
				throw new Error("Cleanup failed");
			},
		});
		session.providerSessionState.set("retaining", {
			close() {},
			releaseSession: sessionId => retained.delete(sessionId),
		});
		await expect(session.runEphemeralTurn({ promptText: "Question" })).rejects.toThrow("Factory failed");
		expect(retained.size).toBe(0);
	});
});
