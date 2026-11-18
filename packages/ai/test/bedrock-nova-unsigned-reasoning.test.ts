import { describe, expect, test } from "bun:test";
import { renderDemotedThinking } from "@oh-my-pi/pi-ai/dialect";
import { type BedrockOptions, streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { AssistantMessage, Context, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Amazon Nova streams reasoningContent natively (with no signature — Nova never
// sends one), but rejects that same unsigned reasoningContent when it is echoed
// back in a later request:
//
//   Bedrock HTTP 400: "User messages cannot contain reasoning content.
//   Please remove the reasoning content and try again."
//
// This wedges the agent loop on every turn after the first. The bug was that
// convertMessages() assumed any model that *produces* reasoning also *accepts*
// it echoed back — true for Claude (which signs it), unproven and false for
// Nova. Unsigned thinking blocks must now demote to plain text instead of
// being resent as reasoningContent.
const novaModel: Model<"bedrock-converse-stream"> = buildModel({
	id: "us.amazon.nova-pro-v1:0",
	name: "Nova Pro",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 1 },
	contextWindow: 300000,
	maxTokens: 5000,
});

// An opaque application-inference-profile ARN addressing Nova hits the same
// path: it also fails supportsThinkingSignature-style Claude-id detection, so
// it must not be treated as Claude-signature-capable either.
const novaProfileArn = "arn:aws:bedrock:us-east-1:1234567890:application-inference-profile/company-nova-pro";

function contextWithUnsignedThinking(modelId: string): Context {
	return {
		messages: [
			{ role: "user", content: "Plan the change", timestamp: 0 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Inspect the implementation", thinkingSignature: "" },
					{ type: "text", text: "I found the relevant code." },
				],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: modelId,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
			{ role: "user", content: "Continue", timestamp: 2 },
		],
	};
}

async function captureReplayPayload(
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: Partial<BedrockOptions> = {},
): Promise<unknown> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<unknown>();

	void streamBedrock(model, context, {
		bearerToken: "test-token",
		signal: controller.signal,
		maxTokens: 16,
		onPayload: payload => resolve(payload),
		...options,
	});

	return promise;
}

describe("Bedrock Nova unsigned reasoning replay", () => {
	test("demotes an unsigned thinking block to text instead of resending reasoningContent", async () => {
		const payload = await captureReplayPayload(novaModel, contextWithUnsignedThinking(novaModel.id));
		const messages = (payload as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> })
			.messages;

		expect(messages[0].role).toBe("user");
		expect(messages[0].content[0]).toMatchObject({ text: "Plan the change" });
		expect(messages[2].role).toBe("user");
		expect(messages[2].content[0]).toMatchObject({ text: "Continue" });

		const assistantMessage = messages[1];
		expect(assistantMessage.role).toBe("assistant");
		// The captured (unsigned) thinking block must be demoted to plain text...
		expect(assistantMessage.content[0]).toMatchObject({
			text: "<thinking>\nInspect the implementation\n</thinking>",
		});
		expect(assistantMessage.content[1]).toMatchObject({ text: "I found the relevant code." });
		// ...and must never resend reasoningContent without a signature — that's exactly
		// what Nova's HTTP 400 rejects.
		for (const block of assistantMessage.content) {
			expect(block).not.toHaveProperty("reasoningContent");
		}
	});

	test("also demotes unsigned thinking for a Nova-backed application-inference-profile ARN", async () => {
		const profileModel: Model<"bedrock-converse-stream"> = buildModel({
			id: novaProfileArn,
			name: "Nova Pro (inference profile)",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 1 },
			contextWindow: 300000,
			maxTokens: 5000,
		});

		const payload = await captureReplayPayload(profileModel, contextWithUnsignedThinking(novaProfileArn));

		const assistantMessage = (payload as { messages: Array<{ role: string; content: unknown[] }> }).messages[1];
		for (const block of assistantMessage.content) {
			expect(block).not.toHaveProperty("reasoningContent");
		}
	});
});

interface ConverseWireMessage {
	role: string;
	content: Array<Record<string, unknown>>;
}

function payloadMessages(payload: unknown): ConverseWireMessage[] {
	if (!payload || typeof payload !== "object" || !("messages" in payload) || !Array.isArray(payload.messages)) {
		throw new Error("expected a Converse payload with messages");
	}
	return payload.messages;
}

function assistantTurn(
	content: AssistantMessage["content"],
	source: Pick<AssistantMessage, "api" | "provider" | "model">,
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		...source,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

function toolResultTurn(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

/** The Converse block a successful text tool result replays as. */
function toolResultWire(toolUseId: string, text: string): Record<string, unknown> {
	return { toolResult: { toolUseId, content: [{ text }], status: "success" } };
}

// Anthropic's `reasoning_extraction` classifier refuses requests that re-send
// prior reasoning to Claude as text, so Claude on Bedrock drops reasoning it
// cannot replay as signed reasoningContent, and the turn structure still has to
// alternate. Other Bedrock models keep the dialect-wrapped text demotion
// exercised above and one Converse turn per message.
describe("Bedrock Claude prior reasoning replay", () => {
	const claudeModel: Model<"bedrock-converse-stream"> = buildModel({
		id: "us.anthropic.claude-opus-4-8-v1:0",
		name: "Claude Opus 4.8",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
	const llamaModel: Model<"bedrock-converse-stream"> = buildModel({
		id: "us.meta.llama3-3-70b-instruct-v1:0",
		name: "Llama 3.3 70B Instruct",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
	const GPT_REASONING = "gpt-5.6-sol private chain: inspect the parser before patching";

	function foreignReasoningContext(): Context {
		return {
			messages: [
				{ role: "user", content: "Fix the parser", timestamp: 0 },
				assistantTurn(
					[
						{ type: "thinking", thinking: GPT_REASONING, thinkingSignature: '{"type":"reasoning"}' },
						{ type: "text", text: "Reading the parser first." },
						{ type: "toolCall", id: "call_gpt", name: "read", arguments: { path: "parser.ts" } },
					],
					{ api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol" },
					"toolUse",
				),
				toolResultTurn("call_gpt", "parser body"),
				{ role: "user", content: "Continue", timestamp: 3 },
			],
		};
	}

	test("drops cross-model reasoning for Claude but still demotes it for Nova", async () => {
		const claude = payloadMessages(
			await captureReplayPayload(claudeModel, foreignReasoningContext(), { cacheRetention: "none" }),
		);

		expect(JSON.stringify(claude)).not.toContain(GPT_REASONING);
		expect(claude).toEqual([
			{ role: "user", content: [{ text: "Fix the parser" }] },
			{
				role: "assistant",
				content: [
					{ text: "Reading the parser first." },
					{ toolUse: { toolUseId: "call_gpt", name: "read", input: { path: "parser.ts" } } },
				],
			},
			// The user text follows the tool results inside their turn.
			{ role: "user", content: [toolResultWire("call_gpt", "parser body"), { text: "Continue" }] },
		]);

		const nova = payloadMessages(await captureReplayPayload(novaModel, foreignReasoningContext()));

		expect(nova[1]?.content[0]).toEqual({ text: renderDemotedThinking(novaModel.id, GPT_REASONING) });
	});

	test("drops unsigned and reasoning-only turns while keeping signed replay and role alternation", async () => {
		const signedReasoning = "claude own chain: the patch compiles";
		const unsignedReasoning = "claude chain whose signature never arrived";
		const reasoningOnly = "gpt-6-astra private chain: nothing else was said this turn";
		const context: Context = {
			messages: [
				{ role: "user", content: "Fix the parser", timestamp: 0 },
				assistantTurn(
					[
						{ type: "thinking", thinking: signedReasoning, thinkingSignature: "sig_claude" },
						{ type: "thinking", thinking: unsignedReasoning },
						{ type: "text", text: "Patched." },
						{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "parser.ts" } },
					],
					{ api: "bedrock-converse-stream", provider: "amazon-bedrock", model: claudeModel.id },
					"toolUse",
				),
				toolResultTurn("toolu_1", "parser body"),
				assistantTurn(
					[{ type: "thinking", thinking: reasoningOnly, thinkingSignature: '{"type":"reasoning"}' }],
					{ api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-astra" },
					"stop",
				),
				{ role: "user", content: "Continue", timestamp: 3 },
			],
		};

		const messages = payloadMessages(await captureReplayPayload(claudeModel, context, { cacheRetention: "none" }));

		const wire = JSON.stringify(messages);
		expect(wire).not.toContain(unsignedReasoning);
		expect(wire).not.toContain(reasoningOnly);
		// The reasoning-only turn vanishes without leaving two user turns
		// adjacent (Converse rejects any conversation that does not alternate):
		// the user text joins the tool-result turn, after the tool results.
		expect(messages).toEqual([
			{ role: "user", content: [{ text: "Fix the parser" }] },
			{
				role: "assistant",
				content: [
					{ reasoningContent: { reasoningText: { text: signedReasoning, signature: "sig_claude" } } },
					{ text: "Patched." },
					{ toolUse: { toolUseId: "toolu_1", name: "read", input: { path: "parser.ts" } } },
				],
			},
			{ role: "user", content: [toolResultWire("toolu_1", "parser body"), { text: "Continue" }] },
		]);
	});

	test("keeps one turn per message for other models and alternates Claude turns around tool results", async () => {
		const reasoningOnly = "gpt-6-astra private chain: nothing else was said this turn";
		const gpt = { api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.6-sol" } as const;
		const context: Context = {
			messages: [
				{ role: "user", content: "Fix the parser", timestamp: 0 },
				{ role: "developer", content: "Keep edits minimal.", timestamp: 0 },
				assistantTurn(
					[{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "parser.ts" } }],
					gpt,
					"toolUse",
				),
				toolResultTurn("call_1", "parser body"),
				// Steering sent while the tool ran: user text right after the tool results.
				{ role: "user", content: "Also check the lexer.", timestamp: 2 },
				assistantTurn(
					[{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "lexer.ts" } }],
					gpt,
					"toolUse",
				),
				toolResultTurn("call_2", "lexer body"),
				assistantTurn(
					[{ type: "thinking", thinking: reasoningOnly, thinkingSignature: '{"type":"reasoning"}' }],
					{ api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-astra" },
					"stop",
				),
				{ role: "user", content: "Continue", timestamp: 3 },
			],
		};
		const readCall = (toolUseId: string, path: string) => ({ toolUse: { toolUseId, name: "read", input: { path } } });

		// Other models keep one Converse turn per message, exactly as before Claude
		// reasoning was dropped: text never joins a toolResult turn (Llama 3.x and
		// Mistral reject "Conversation blocks and tool result blocks ... in the
		// same turn"), and the reasoning-only turn stays demoted text.
		const llama = payloadMessages(await captureReplayPayload(llamaModel, context, { cacheRetention: "none" }));
		expect(llama).toEqual([
			{ role: "user", content: [{ text: "Fix the parser" }] },
			{ role: "user", content: [{ text: "Keep edits minimal." }] },
			{ role: "assistant", content: [readCall("call_1", "parser.ts")] },
			{ role: "user", content: [toolResultWire("call_1", "parser body")] },
			{ role: "user", content: [{ text: "Also check the lexer." }] },
			{ role: "assistant", content: [readCall("call_2", "lexer.ts")] },
			{ role: "user", content: [toolResultWire("call_2", "lexer body")] },
			{ role: "assistant", content: [{ text: renderDemotedThinking(llamaModel.id, reasoningOnly) }] },
			{ role: "user", content: [{ text: "Continue" }] },
		]);

		// Claude drops the reasoning-only turn and still alternates strictly, with
		// no synthetic assistant turn: adjacent text turns fold, and user text after
		// tool results joins their turn behind the toolResult blocks, which stay first.
		const claude = payloadMessages(await captureReplayPayload(claudeModel, context, { cacheRetention: "none" }));
		expect(claude).toEqual([
			{ role: "user", content: [{ text: "Fix the parser" }, { text: "Keep edits minimal." }] },
			{ role: "assistant", content: [readCall("call_1", "parser.ts")] },
			{ role: "user", content: [toolResultWire("call_1", "parser body"), { text: "Also check the lexer." }] },
			{ role: "assistant", content: [readCall("call_2", "lexer.ts")] },
			{ role: "user", content: [toolResultWire("call_2", "lexer body"), { text: "Continue" }] },
		]);
		expect(JSON.stringify(claude)).not.toContain(reasoningOnly);
	});
});
