import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicApiRequest, AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type { Context, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { logger } from "@oh-my-pi/pi-utils";

const model = buildModel({
	id: "claude-fable-5-1",
	name: "Claude Fable 5.1",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
});
const context: Context = {
	messages: [
		{ role: "user", content: "Inspect the repository.", timestamp: 0 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Inspect the tree first.", thinkingSignature: "sig-bound" },
				{ type: "redactedThinking", data: "redacted-bound" },
				{ type: "text", text: "I inspected it." },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		},
		{ role: "user", content: "Continue.", timestamp: 0 },
	],
};
const transformations = [
	{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
	{ type: "thinking_dropped", path: "messages.1.content.1", reason: "prefix_binding_mismatch" },
];

describe("Anthropic server-reported thinking drops", () => {
	afterEach(() => vi.restoreAllMocks());
	for (const reportedAt of ["message_start", "message_delta"]) {
		it(`preserves subsequent replay and reports fresh drops once from ${reportedAt}`, async () => {
			const state = new Map<string, ProviderSessionState>();
			const payloads: MessageCreateParams[] = [];
			const usage = { input_tokens: 12, output_tokens: 4 };
			const events = [
				{
					type: "message_start",
					message: {
						id: "msg-drop",
						usage: { ...usage, output_tokens: 0 },
						...(reportedAt === "message_start" ? { input_transformations: transformations } : {}),
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage,
					...(reportedAt === "message_delta" ? { input_transformations: transformations } : {}),
				},
				{ type: "message_stop" },
			];
			const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
			vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(params => {
				payloads.push(structuredClone(params));
				return new AnthropicApiRequest(
					async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
				);
			});
			const warnings = vi.spyOn(logger, "warn");
			const run = () =>
				streamAnthropic(model, context, { apiKey: "sk-ant-test", providerSessionState: state }).result();
			const first = await run();
			const second = await run();
			expect(first.stopReason).toBe("stop");
			expect(second.stopReason).toBe("stop");
			expect(second.inputTransformations).toEqual(transformations);
			const initial = payloads[0];
			const replay = payloads[1];
			if (!initial || !replay) throw new Error("Expected both provider requests");
			const assistant = initial.messages.find(message => message.role === "assistant");
			if (!assistant || !Array.isArray(assistant.content)) throw new Error("Expected replayable assistant content");
			expect(assistant.content.map(block => block.type)).toEqual(["thinking", "redacted_thinking", "text"]);
			expect(replay.messages).toEqual(initial.messages);
			expect(warnings).toHaveBeenCalledTimes(2);
			for (const provider of state.values()) provider.close();
			const reopened = await run();
			expect(reopened.stopReason).toBe("stop");
			expect(payloads[2]?.messages).toEqual(initial.messages);
			expect(warnings).toHaveBeenCalledTimes(4);
		});
	}
});
