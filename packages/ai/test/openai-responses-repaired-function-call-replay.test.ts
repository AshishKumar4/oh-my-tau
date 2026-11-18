import { expect, it } from "bun:test";
import { buildParams, streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import {
	convertCodexResponsesMessages,
	streamOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { ResponseStreamEvent } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import { processResponsesStream } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Context, Model, ModelSpec, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
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

const model: Model<"openai-responses"> = buildModel({
	id: "anthropic/claude-sonnet-5.5",
	name: "Claude Sonnet 5.5",
	api: "openai-responses",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
} as ModelSpec<"openai-responses">);

function emptyAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

async function* events(list: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const event of list) yield event as ResponseStreamEvent;
}

function functionCallEvents(outputIndex: number, callId: string, name: string, args: string): unknown[] {
	const item = { type: "function_call", id: `fc_${callId}`, call_id: callId, name };
	return [
		{ type: "response.output_item.added", output_index: outputIndex, item: { ...item, arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: outputIndex, item_id: item.id, delta: args },
		{ type: "response.function_call_arguments.done", output_index: outputIndex, item_id: item.id, arguments: args },
		{ type: "response.output_item.done", output_index: outputIndex, item: { ...item, arguments: args } },
	];
}

it("replays a lenient-repaired function call with the arguments that were executed", async () => {
	// Invalid JSON as streamed by OpenRouter/Claude for a strict nullable arg (#14155).
	const brokenArgs = '{"command": "pwd; ls -a", "name": , "ready": null}';
	const output = emptyAssistant();
	const nativeItems: Array<Record<string, unknown>> = [];
	await processResponsesStream(
		events([
			...functionCallEvents(0, "call_read", "read", JSON.stringify({ path: "." })),
			...functionCallEvents(1, "call_bash", "bash", brokenArgs),
		]),
		output,
		{ push: () => {}, end: () => {} } as never,
		model,
		{ onOutputItemDone: item => nativeItems.push(item as unknown as Record<string, unknown>) },
	);
	output.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeItems);

	const bash = output.content.find(block => block.type === "toolCall" && block.name === "bash");
	if (bash?.type !== "toolCall") throw new Error("expected bash tool call");
	const results: ToolResultMessage[] = output.content.flatMap(block =>
		block.type === "toolCall"
			? [
					{
						role: "toolResult",
						toolCallId: block.id,
						toolName: block.name,
						content: [{ type: "text", text: `${block.name} output` }],
						isError: false,
						timestamp: 2,
					},
				]
			: [],
	);

	const input = buildParams(model, { messages: [output, ...results] }, { reasoning: "high" }, undefined).params
		.input as unknown as Array<Record<string, unknown>>;

	const bashCall = input.find(item => item.type === "function_call" && item.call_id === "call_bash");
	expect(bashCall).toBeDefined();
	expect(JSON.parse(String(bashCall?.arguments))).toEqual(bash.arguments);
	expect(input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_bash" }));
	expect(input.at(-1)).toMatchObject({ type: "function_call_output" });
	expect(JSON.stringify(input)).not.toContain("Orphan");
});

it("replays an unrepairable function call with its parse diagnostic so the tool result stays paired", async () => {
	// Invalid JSON the lenient parser cannot repair; the tool answered with a validation error (#15568).
	const brokenArgs = '{"tasks": [{"task": "x" "y"}]] }}';
	const output = emptyAssistant();
	const nativeItems: Array<Record<string, unknown>> = [];
	await processResponsesStream(
		events([
			...functionCallEvents(0, "call_bash", "bash", JSON.stringify({ command: "pwd" })),
			...functionCallEvents(1, "call_task", "task", brokenArgs),
		]),
		output,
		{ push: () => {}, end: () => {} } as never,
		model,
		{ onOutputItemDone: item => nativeItems.push(item as unknown as Record<string, unknown>) },
	);
	output.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, nativeItems);
	const results: ToolResultMessage[] = output.content.flatMap(block =>
		block.type === "toolCall"
			? [
					{
						role: "toolResult",
						toolCallId: block.id,
						toolName: block.name,
						content: [{ type: "text", text: `${block.name} output` }],
						isError: block.name === "task",
						timestamp: 2,
					},
				]
			: [],
	);

	const input = buildParams(model, { messages: [output, ...results] }, { reasoning: "high" }, undefined).params
		.input as unknown as Array<Record<string, unknown>>;

	const taskCall = input.find(item => item.type === "function_call" && item.call_id === "call_task");
	expect(JSON.parse(String(taskCall?.arguments))).toEqual({ __parseError: expect.any(String), __rawJson: brokenArgs });
	expect(input.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call_task" });
	expect(JSON.stringify(input)).not.toContain("Orphan");
});

it("does not crash on a relaxed scalar function-call argument", async () => {
	const output = emptyAssistant();
	const nativeItems: Array<Record<string, unknown>> = [];
	await processResponsesStream(
		events(functionCallEvents(0, "call_scalar", "bash", "'hello'")),
		output,
		{ push: () => {}, end: () => {} } as never,
		model,
		{ onOutputItemDone: item => nativeItems.push(item as unknown as Record<string, unknown>) },
	);

	const toolCall = output.content.find(block => block.type === "toolCall");
	if (toolCall?.type !== "toolCall") throw new Error("expected a finalized toolCall block");
	expect(JSON.stringify(toolCall.arguments)).toBe('"hello"');
	const nativeCall = nativeItems.find(item => item.type === "function_call");
	expect(JSON.parse(String(nativeCall?.arguments))).toBe("hello");
});
