import { describe, expect, it } from "bun:test";
import { gunzipSync } from "node:zlib";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	type AssignModelRequest,
	AssignModelRequestSchema,
	AssignModelResponseSchema,
	ChatMessageSource,
	type GetChatMessageRequest,
	GetChatMessageRequestSchema,
	GetChatMessageResponseSchema,
	GetUserJwtResponseSchema,
	ModelAssignmentSchema,
	StopReason,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import type { DevinCompat } from "@oh-my-pi/pi-catalog/types";

const AUTH_PAYLOAD = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "user-jwt" }));

function frameConnectMessage(payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, 0);
	view.setUint32(1, payload.length, false);
	out.set(payload, 5);
	return out;
}

function devinModel(compat: DevinCompat, requestModelId = "adaptive"): Model<"devin-agent"> {
	return buildModel({
		id: "devin-router-test",
		name: "Devin Router Test",
		api: "devin-agent",
		provider: "devin",
		baseUrl: "https://server.codeium.com",
		requestModelId,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		compat,
	});
}

interface ChatResponseFields {
	actualModelUid?: string;
	creditCost?: number;
	committedCreditCost?: number;
	committedAcuCost?: number;
}

interface RecordedTurn {
	/** Request paths in call order, so ordering between AssignModel and chat is observable. */
	paths: string[];
	assignment?: AssignModelRequest;
	chat?: GetChatMessageRequest;
}

function decodeAssignRequest(body: RequestInit["body"]): AssignModelRequest {
	return fromBinary(AssignModelRequestSchema, new Uint8Array(body as ArrayBuffer));
}

function decodeChatRequest(body: RequestInit["body"]): GetChatMessageRequest {
	const framed = new Uint8Array(body as ArrayBuffer);
	const length = new DataView(framed.buffer, framed.byteOffset, framed.byteLength).getUint32(1, false);
	return fromBinary(GetChatMessageRequestSchema, gunzipSync(framed.subarray(5, 5 + length)));
}

/** Fake Devin edge: serves auth, a fixed model assignment, and one chat response frame. */
function fakeDevin(options: { assignment?: { assignmentJwt: string; modelUid: string }; chat?: ChatResponseFields }): {
	fetch: typeof fetch;
	recorded: RecordedTurn;
} {
	const recorded: RecordedTurn = { paths: [] };
	const chatFrame = frameConnectMessage(
		toBinary(
			GetChatMessageResponseSchema,
			create(GetChatMessageResponseSchema, {
				messageId: "msg-1",
				stopReason: StopReason.STOP_PATTERN,
				...options.chat,
			}),
		),
	);
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		recorded.paths.push(new URL(url).pathname);
		if (url.includes("GetUserJwt")) return new Response(AUTH_PAYLOAD);
		if (url.includes("AssignModel")) {
			recorded.assignment = decodeAssignRequest(init?.body);
			const response = create(AssignModelResponseSchema, {
				assignment: options.assignment ? create(ModelAssignmentSchema, options.assignment) : undefined,
			});
			return new Response(toBinary(AssignModelResponseSchema, response));
		}
		recorded.chat = decodeChatRequest(init?.body);
		return new Response(chatFrame);
	}) as typeof fetch;
	return { fetch: fetchImpl, recorded };
}

const context: Context = {
	messages: [
		{ role: "user", content: "older turn", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "devin-agent",
			provider: "devin",
			model: "devin-router-test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		},
		{ role: "user", content: "route me", timestamp: 3 },
	],
};

describe("streamDevin router assignment", () => {
	it("assigns a concrete model before chat and forwards the assignment", async () => {
		const { fetch: fetchImpl, recorded } = fakeDevin({
			assignment: { assignmentJwt: "assign-jwt", modelUid: "claude-sonnet-4-5" },
		});

		const result = await streamDevin(devinModel({ modelRouter: true }), context, {
			apiKey: "token",
			fetch: fetchImpl,
			conversationId: "cascade-42",
		}).result();

		expect(recorded.paths).toEqual([
			"/exa.auth_pb.AuthService/GetUserJwt",
			"/exa.api_server_pb.ApiServerService/AssignModel",
			"/exa.api_server_pb.ApiServerService/GetChatMessage",
		]);
		expect(recorded.assignment?.modelRouterUid).toBe("adaptive");
		expect(recorded.assignment?.cascadeId).toBe("cascade-42");
		expect(recorded.assignment?.chatMessagePrompt).toMatchObject({
			messageId: "",
			source: ChatMessageSource.USER,
			prompt: "route me",
		});
		expect(recorded.assignment?.metadata).toMatchObject({
			ideName: "chisel",
			extensionName: "chisel",
			extensionVersion: "3000.10.21",
			apiKey: "devin-session-token$token",
			userJwt: "",
		});
		// The router uid must never reach GetChatMessage as the chat model.
		expect(recorded.chat?.chatModelUid).toBe("claude-sonnet-4-5");
		expect(recorded.chat?.modelAssignmentJwt).toBe("assign-jwt");
		expect(recorded.chat?.cascadeId).toBe("cascade-42");
		expect(recorded.chat?.metadata).toMatchObject({ ideName: "chisel", userJwt: "" });
		expect(result.upstreamModel).toBe("claude-sonnet-4-5");
		expect(result.stopReason).toBe("stop");
	});

	it("builds the chat request field for field as the Devin CLI does", async () => {
		// Captured from devin 3000.10.21's own GetChatMessage for SWE-2 standalone,
		// the Fusion lead and the Fusion sidekick: one configuration for every
		// model, no tool choice, cache options, execution id or user JWT, and a
		// per-session trajectory reference whose first step is the user's input.
		// `numCompletions` is required: the backend answers `invalid_argument`
		// without it.
		const { fetch: fetchImpl, recorded } = fakeDevin({
			assignment: { assignmentJwt: "assign-jwt", modelUid: "swe-2-high" },
		});
		const firstTurn: Context = { ...context, messages: [{ role: "user", content: "route me", timestamp: 1 }] };

		await streamDevin(devinModel({ modelRouter: true, supportsParallelToolCalls: true }), firstTurn, {
			apiKey: "token",
			fetch: fetchImpl,
			conversationId: "cascade-42",
		}).result();

		const chat = recorded.chat;
		expect(chat?.configuration).toEqual(
			expect.objectContaining({
				numCompletions: 1n,
				maxTokens: 128000n,
				maxNewlines: 400n,
				temperature: 1,
				topK: 40n,
				topP: 0.95,
				firstTemperature: 0,
				fimEotProbThreshold: 0,
				stopPatterns: [],
			}),
		);
		expect(chat?.metadata).toMatchObject({
			ideName: "chisel",
			extensionName: "chisel",
			ideVersion: "3000.10.21",
			extensionVersion: "3000.10.21",
			ideType: "",
			userJwt: "",
		});
		expect(chat?.toolChoice).toBeUndefined();
		expect(chat?.systemPromptCacheOptions).toBeUndefined();
		expect(chat?.executionId).toBe("");
		expect(chat?.disableParallelToolCalls).toBe(false);
		expect(chat?.trajectoryReference).toMatchObject({ trajectoryType: 4, stepType: 14, stepIndex: 0 });
		expect(chat?.trajectoryReference?.trajectoryId).toMatch(/^[0-9a-f-]{36}$/);
		expect(chat?.trajectoryReference?.trajectoryId).not.toBe("cascade-42");

		// A second turn on the same cascade references the same trajectory at step 1.
		const second = fakeDevin({ assignment: { assignmentJwt: "assign-jwt", modelUid: "swe-2-high" } });
		await streamDevin(
			devinModel({ modelRouter: true }),
			{
				...firstTurn,
				messages: [
					...firstTurn.messages,
					{
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						timestamp: 1,
						api: "devin-agent",
						provider: "devin",
						model: "swe-2",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
					},
					{ role: "user", content: [{ type: "text", text: "again" }], timestamp: 2 },
				],
			},
			{ apiKey: "token", fetch: second.fetch, conversationId: "cascade-42" },
		).result();
		expect(second.recorded.chat?.trajectoryReference).toMatchObject({
			trajectoryId: chat?.trajectoryReference?.trajectoryId,
			stepIndex: 1,
			stepType: 0,
		});

		// A caller's explicit sampling still wins over the CLI defaults.
		const explicit = fakeDevin({ assignment: { assignmentJwt: "assign-jwt", modelUid: "swe-2-high" } });
		await streamDevin(devinModel({ modelRouter: true }), context, {
			apiKey: "token",
			fetch: explicit.fetch,
			conversationId: "cascade-43",
			temperature: 0.2,
			maxTokens: 4096,
			stopSequences: ["<stop>"],
		}).result();
		expect(explicit.recorded.chat?.configuration).toMatchObject({
			temperature: 0.2,
			maxTokens: 4096n,
			topK: 40n,
			stopPatterns: ["<stop>"],
		});
	});

	it("prefers the model the response actually ran on", async () => {
		const { fetch: fetchImpl } = fakeDevin({
			assignment: { assignmentJwt: "assign-jwt", modelUid: "claude-sonnet-4-5" },
			chat: { actualModelUid: "gpt-5-codex" },
		});

		const result = await streamDevin(devinModel({ modelRouter: true }), context, {
			apiKey: "token",
			fetch: fetchImpl,
		}).result();

		expect(result.upstreamModel).toBe("gpt-5-codex");
	});

	it("fails the turn when the assignment is incomplete instead of chatting with the router uid", async () => {
		const { fetch: fetchImpl, recorded } = fakeDevin({ assignment: { assignmentJwt: "", modelUid: "" } });

		const result = await streamDevin(devinModel({ modelRouter: true }), context, {
			apiKey: "token",
			fetch: fetchImpl,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(recorded.chat).toBeUndefined();
		expect(recorded.paths).not.toContain("/exa.api_server_pb.ApiServerService/GetChatMessage");
	});

	it("skips assignment for non-router models", async () => {
		const { fetch: fetchImpl, recorded } = fakeDevin({});

		const result = await streamDevin(devinModel({}, "claude-sonnet-4-5"), context, {
			apiKey: "token",
			fetch: fetchImpl,
			sessionId: "session-7",
		}).result();

		expect(recorded.paths).not.toContain("/exa.api_server_pb.ApiServerService/AssignModel");
		expect(recorded.chat?.chatModelUid).toBe("claude-sonnet-4-5");
		expect(recorded.chat?.modelAssignmentJwt).toBeUndefined();
		expect(recorded.chat?.cascadeId).toBe("session-7");
		expect(result.upstreamModel).toBeUndefined();
	});

	it("surfaces credit metering onto usage", async () => {
		const { fetch: fetchImpl } = fakeDevin({
			chat: { creditCost: 3, committedCreditCost: 2, committedAcuCost: 0.25 },
		});

		const result = await streamDevin(devinModel({}), context, { apiKey: "token", fetch: fetchImpl }).result();

		expect(result.usage.credits).toEqual({ cost: 3, committedCost: 2, acuCost: 0.25 });
	});

	it("leaves credits unset when the response reports no billing", async () => {
		const { fetch: fetchImpl } = fakeDevin({});

		const result = await streamDevin(devinModel({}), context, { apiKey: "token", fetch: fetchImpl }).result();

		expect(result.usage.credits).toBeUndefined();
	});

	it("enables parallel tool calls only when compat advertises support", async () => {
		const off = fakeDevin({});
		await streamDevin(devinModel({}), context, { apiKey: "token", fetch: off.fetch }).result();
		expect(off.recorded.chat?.disableParallelToolCalls).toBe(true);

		const on = fakeDevin({});
		await streamDevin(devinModel({ supportsParallelToolCalls: true }), context, {
			apiKey: "token",
			fetch: on.fetch,
		}).result();
		expect(on.recorded.chat?.disableParallelToolCalls).toBe(false);
	});
});
