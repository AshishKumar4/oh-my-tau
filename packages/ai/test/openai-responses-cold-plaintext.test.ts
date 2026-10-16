import { expect, it } from "bun:test";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Context, ProviderSessionState } from "@oh-my-pi/pi-ai/types";

it.each(["plaintext", "summary-only", "server-id", "encrypted", "mixed-summary"])(
	"reopens Responses history according to its actual replay binding: %s",
	async kind => {
		const built = buildModel({
			id: "fixture",
			name: "Fixture",
			api: "openai-responses",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8192,
		});
		// A reopened session replays native history warm unless the host binds
		// items to a connection (a catalog axis, not a spec override); this
		// scenario covers the cold rebuild.
		const model = { ...built, compat: { ...built.compat, connectionBoundNativeHistory: true } };
		const reasoning = {
			type: "reasoning",
			summary: kind === "summary-only" ? [{ type: "summary_text", text: "Only a summary" }] : [],
			...(kind === "summary-only"
				? {}
				: { content: [{ type: "reasoning_text", text: "Literal private reasoning" }] }),
			...(kind === "server-id" ? { id: "rs_bound" } : {}),
			...(kind === "encrypted" ? { encrypted_content: "provider-bound" } : {}),
		};
		const answer = {
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Answer" }],
		};
		const events = [
			{ type: "response.output_item.added", output_index: 0, item: reasoning },
			{ type: "response.output_item.done", output_index: 0, item: reasoning },
			...(kind === "mixed-summary"
				? [
						{
							type: "response.output_item.added",
							output_index: 1,
							item: { type: "reasoning", summary: [{ type: "summary_text", text: "Summary only sibling" }] },
						},
						{
							type: "response.output_item.done",
							output_index: 1,
							item: { type: "reasoning", summary: [{ type: "summary_text", text: "Summary only sibling" }] },
						},
					]
				: []),
			{ type: "response.output_item.added", output_index: 2, item: answer },
			{ type: "response.output_item.done", output_index: 2, item: answer },
			{
				type: "response.completed",
				response: {
					id: "resp_fixture",
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			},
		];
		const context: Context = {
			systemPrompt: ["System"],
			messages: [{ role: "user", content: "Question", timestamp: 1 }],
		};
		const states = new Map<string, ProviderSessionState>();
		const assistant = await streamOpenAIResponses(model, context, {
			apiKey: "fixture",
			providerSessionState: states,
			fetch: async () =>
				new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				}),
		}).result();
		expect(assistant.stopReason).toBe("stop");
		const persisted: typeof assistant = JSON.parse(JSON.stringify(assistant));
		let input: object[] = [];
		const reopened = new Map<string, ProviderSessionState>();
		const second = await streamOpenAIResponses(
			model,
			{
				...context,
				messages: [...context.messages, persisted, { role: "user", content: "Follow up", timestamp: 2 }],
			},
			{
				apiKey: "fixture",
				providerSessionState: reopened,
				fetch: async (_url, options) => {
					const body = JSON.parse(String(options?.body));
					if (!isRecord(body) || !Array.isArray(body.input)) throw new Error("Expected cold request input");
					input = body.input.filter(isRecord);
					return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
						headers: { "content-type": "text/event-stream" },
					});
				},
			},
		).result();
		expect(second.stopReason).toBe("stop");
		const nativeReasoning = input.filter(isRecord).filter(item => item.type === "reasoning");
		if (kind === "plaintext" || kind === "server-id") {
			expect(nativeReasoning).toEqual([
				{
					type: "reasoning",
					summary: [],
					content: [{ type: "reasoning_text", text: "Literal private reasoning" }],
				},
			]);
			expect(JSON.stringify(input)).not.toContain("rs_bound");
			expect(JSON.stringify(input)).toContain("Answer");
			expect(JSON.stringify(input)).toContain("Follow up");
		} else {
			expect(
				nativeReasoning.some(
					item =>
						Array.isArray(item.content) &&
						item.content.some(
							part =>
								isRecord(part) && part.type === "reasoning_text" && part.text === "Literal private reasoning",
						),
				),
			).toBe(false);
			expect(JSON.stringify(input)).not.toContain("provider-bound");
		}
		for (const state of states.values()) state.close();
		for (const state of reopened.values()) state.close();
	},
);
