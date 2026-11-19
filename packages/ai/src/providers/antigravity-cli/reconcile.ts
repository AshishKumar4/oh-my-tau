/** Maps omp's per-step transcript onto one stateful agy turn. */
import { createHash } from "node:crypto";
import { prompt, stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { ContentBlock } from "@oh-my-pi/pi-utils/acp";
import type {
	AntigravityCliCheckpoint,
	DeveloperMessage,
	ImageContent,
	Message,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "../../types";
import lateToolResultTemplate from "./late-tool-result.md" with { type: "text" };
import transcriptTemplate from "./transcript.md" with { type: "text" };

/** The exact leading transcript represented by the live conversation. */
export interface Ledger {
	count: number;
	digest: string;
	pendingToolCallId?: string;
}

/** New user-side input for agy. */
export type InputMessage = UserMessage | DeveloperMessage;

export type TurnPlan =
	| { kind: "resume"; toolResult?: ToolResultMessage; input: InputMessage[] }
	| {
			kind: "restore";
			conversationId: string;
			digest: string;
			checkpoint: AntigravityCliCheckpoint;
			replay: Message[];
	  }
	| { kind: "fresh"; replay: Message[] };

/** Reuse only an exact visible prefix; otherwise fork a recorded turn end or reseed. */
export function planTurn(messages: readonly Message[], ledger: Ledger | undefined): TurnPlan {
	if (
		ledger &&
		messages.length > ledger.count &&
		transcriptDigest(messages.slice(0, ledger.count)) === ledger.digest
	) {
		// agy keeps its own record of a turn that was cancelled in place.
		const tail = messages.slice(ledger.count).filter(message => !isCancelledReply(message));
		const first = tail[0];
		const toolResult =
			ledger.pendingToolCallId !== undefined &&
			first?.role === "toolResult" &&
			first.toolCallId === ledger.pendingToolCallId
				? first
				: undefined;
		const input = toolResult ? tail.slice(1) : tail;
		if ((ledger.pendingToolCallId === undefined || toolResult) && input.every(isInputMessage)) {
			return { kind: "resume", toolResult, input };
		}
	}
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const payload = message.providerPayload;
		if (payload?.type !== "antigravityCli" || !payload.checkpoint) continue;
		if (transcriptDigest(messages.slice(0, index + 1)) !== payload.digest) continue;
		return {
			kind: "restore",
			conversationId: payload.conversationId,
			digest: payload.digest,
			checkpoint: payload.checkpoint,
			replay: messages.slice(index + 1),
		};
	}
	return { kind: "fresh", replay: [...messages] };
}

/** Fingerprint model-visible ordered content, excluding timestamps, usage and presentation metadata. */
export function transcriptDigest(messages: readonly Message[]): string {
	const hash = createHash("sha256");
	for (const message of messages) {
		hash.update(stableStringifyJson(messageContent(message)));
		hash.update("\n");
	}
	return hash.digest("hex");
}

/**
 * agy keeps the first ~192,000 bytes of a prompt's text and silently drops the rest
 * (measured on 1.5.12). A replay stays under this budget, leaving room for agy's own wrapper.
 */
export const REPLAY_BUDGET_BYTES = 180_000;
/** One replayed message may use at most this much text, so a huge tool result cannot crowd out the rest. */
const REPLAYED_MESSAGE_BYTES = 24_000;

/**
 * Replay earlier turns as labelled text and image blocks, then send trailing input directly.
 * The newest history that fits the budget is kept; `omitted` counts the earliest messages left out.
 * Trailing input is never cut: input over the budget alone is an error, not a silent truncation.
 */
export function replayPrompt(replay: readonly Message[]): { blocks: ContentBlock[]; omitted: number } {
	let split = replay.length;
	while (split > 0 && isInputMessage(replay[split - 1]!)) split--;
	const input = replay.slice(split).flatMap(message => (isInputMessage(message) ? inputBlocks(message) : []));
	const inputBytes = textBytes(input);
	if (inputBytes > REPLAY_BUDGET_BYTES) {
		throw new Error(
			`This message has ${Math.ceil(inputBytes / 1000)} KB of text; Antigravity CLI accepts at most ${REPLAY_BUDGET_BYTES / 1000} KB in one prompt.`,
		);
	}
	if (split === 0) return { blocks: input, omitted: 0 };
	const history = replay.slice(0, split);
	const header = (omitted: number): ContentBlock => ({
		type: "text",
		text: `${prompt.render(transcriptTemplate, { omitted }).trimEnd()}\n`,
	});
	const kept: ContentBlock[][] = [];
	let used = inputBytes + textBytes([header(history.length)]) + 64;
	for (let index = history.length - 1; index >= 0; index--) {
		const blocks = historyBlocks(history[index]!);
		const size = textBytes(blocks);
		if (used + size > REPLAY_BUDGET_BYTES) break;
		kept.unshift(blocks);
		used += size;
	}
	const omitted = history.length - kept.length;
	return {
		blocks: [header(omitted), ...kept.flat(), { type: "text", text: "</conversation-checkpoint>" }, ...input],
		omitted,
	};
}

/** A reply that ended in an abort without calling a tool; agy holds its own record of it. */
function isCancelledReply(message: Message): boolean {
	return (
		message.role === "assistant" &&
		message.stopReason === "aborted" &&
		!message.content.some(block => block.type === "toolCall")
	);
}

function historyBlocks(message: Message): ContentBlock[] {
	const tag = message.role === "toolResult" ? "tool_result" : message.role;
	const attrs =
		message.role === "toolResult"
			? ` id=${JSON.stringify(message.toolCallId)} name=${JSON.stringify(message.toolName)} error=${message.isError}`
			: "";
	const body: ContentBlock[] = [];
	if (typeof message.content === "string") body.push({ type: "text", text: message.content });
	else
		for (const part of message.content) {
			switch (part.type) {
				case "text":
					body.push({ type: "text", text: part.text });
					break;
				case "image":
					body.push({ type: "image", data: part.data, mimeType: part.mimeType });
					break;
				case "thinking":
					body.push({ type: "text", text: `<thinking>${part.thinking}</thinking>` });
					break;
				case "toolCall":
					body.push({
						type: "text",
						text: `<tool_call id=${JSON.stringify(part.id)} name=${JSON.stringify(part.name)}>${stableStringifyJson(part.arguments)}</tool_call>`,
					});
					break;
			}
		}
	return [
		{ type: "text", text: `<${tag}${attrs}>` },
		...capText(body, REPLAYED_MESSAGE_BYTES),
		{ type: "text", text: `</${tag}>` },
	];
}

/** Keep each text block's head within `limit` bytes for the message, marking what was cut. */
function capText(blocks: ContentBlock[], limit: number): ContentBlock[] {
	let remaining = limit;
	return blocks.map(block => {
		if (block.type !== "text") return block;
		const bytes = Buffer.byteLength(block.text);
		if (bytes <= remaining) {
			remaining -= bytes;
			return block;
		}
		const head = Buffer.from(block.text)
			.subarray(0, Math.max(0, remaining))
			.toString("utf8")
			.replace(/\uFFFD$/, "");
		remaining = 0;
		return { type: "text", text: `${head}\n[… ${bytes - Buffer.byteLength(head)} bytes of this message omitted …]` };
	});
}

function textBytes(blocks: readonly ContentBlock[]): number {
	let total = 0;
	for (const block of blocks) if (block.type === "text") total += Buffer.byteLength(block.text);
	return total;
}

/** Supply the actual delayed result only after agy's old prompt has confirmed cancellation. */
export function lateToolResultPrompt(result: ToolResultMessage): ContentBlock[] {
	return [
		{
			type: "text",
			text: prompt.render(lateToolResultTemplate, {
				toolName: result.toolName,
				toolCallId: result.toolCallId,
				isError: result.isError,
			}),
		},
		...contentBlocks(result.content),
		{ type: "text", text: "</tool_result>" },
	];
}

/** ACP input preserves text/image ordering and the complete image bytes. */
export function inputBlocks(message: InputMessage): ContentBlock[] {
	return contentBlocks(message.content);
}

/** Whether a transcript message can be sent directly as ACP user input. */
export function isInputMessage(message: Message): message is InputMessage {
	return message.role === "user" || message.role === "developer";
}

function contentBlocks(content: string | readonly (TextContent | ImageContent)[]): ContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map(part =>
		part.type === "text"
			? { type: "text", text: part.text }
			: { type: "image", data: part.data, mimeType: part.mimeType },
	);
}

function messageContent(message: Message): unknown {
	const content =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.flatMap((part): unknown[] => {
					switch (part.type) {
						case "text":
							return [{ type: part.type, text: part.text }];
						case "image":
							return [{ type: part.type, data: part.data, mimeType: part.mimeType }];
						case "thinking":
							return [{ type: part.type, thinking: part.thinking }];
						case "toolCall":
							return [{ type: part.type, id: part.id, name: part.name, arguments: part.arguments }];
						// Opaque blocks from other providers are not sent to agy.
						default:
							return [];
					}
				});
	return message.role === "toolResult"
		? {
				role: message.role,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				isError: message.isError,
				content,
			}
		: { role: message.role, content };
}
