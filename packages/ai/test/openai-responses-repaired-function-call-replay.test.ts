import { expect, it } from "bun:test";
import { streamOpenAIResponses, buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import {
	streamOpenAICodexResponses,
	convertCodexResponsesMessages,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Context, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toBase64()}.fixture`;

function response(raw: string): Response {
	const item = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "fixture", arguments: raw };
	const events = [
		{ type: "response.created", response: { id: "resp_fixture" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: raw },
		{ type: "response.function_call_arguments.done", output_index: 0, item_id: item.id, arguments: raw },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: "resp_fixture",
				status: "completed",
				usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
			},
		},
	];
	return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

for (const api of ["openai-responses", "openai-codex-responses"]) {
	it(`keeps repaired calls paired with their result on the next ${api} request`, async () => {
		const generic = buildModel({
			id: "fixture",
			name: "Fixture",
			provider: "openrouter",
			api: "openai-responses",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8192,
		});
		const codex = buildModel<"openai-codex-responses">({
			name: "Codex fixture",
			reasoning: false,
			input: ["text"],
			cost: generic.cost,
			contextWindow: generic.contextWindow,
			maxTokens: generic.maxTokens,
			id: "gpt-5.6-sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			preferWebsockets: false,
		});
		const initial: Context = {
			systemPrompt: ["system"],
			messages: [{ role: "user", content: "Run fixture", timestamp: 1 }],
		};
		for (const raw of [
			'{"command":"pwd", "name": , "ready":null}',
			"'hello'",
			'{ "command": "pwd", "name": null }',
		]) {
			const fetch = async () => response(raw);
			const assistant = await (
				api === "openai-responses"
					? streamOpenAIResponses(generic, initial, { apiKey: "fixture", fetch })
					: streamOpenAICodexResponses(codex, initial, { apiKey: token, fetch, preferWebsockets: false })
			).result();
			expect(assistant.stopReason).toBe("toolUse");
			const call = assistant.content.find(block => block.type === "toolCall");
			if (!call || call.type !== "toolCall") throw new Error("Expected parsed tool call");
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: "fixture completed" }],
				isError: false,
				timestamp: 2,
			};
			const next = { ...initial, messages: [...initial.messages, assistant, result] };
			const input =
				api === "openai-responses"
					? buildParams(generic, next, undefined, undefined).params.input
					: convertCodexResponsesMessages(codex, next);
			if (!Array.isArray(input)) throw new Error("Expected replay input items");
			const replay = input.find(item => item.type === "function_call");
			if (!replay || replay.type !== "function_call") throw new Error("Expected retained function call");
			expect(JSON.parse(replay.arguments)).toEqual(call.arguments);
			expect(input).toContainEqual(
				expect.objectContaining({
					type: "function_call_output",
					call_id: replay.call_id,
					output: "fixture completed",
				}),
			);
			if (raw.startsWith('{ "')) expect(replay.arguments).toBe(raw);
			expect(JSON.stringify(input)).not.toContain("Orphan");
		}
	});
}
