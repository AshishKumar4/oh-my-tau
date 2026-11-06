import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createCustomMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { ImageContent, MessageAttribution, TextContent } from "@oh-my-pi/pi-ai";
import {
	type CustomMessage,
	type CustomMessageContent,
	isCustomMessageContent,
	isUserTurnInitiator,
	normalizeCustomMessagePayload,
} from "./messages";
import { titleTextFromSkillPrompt } from "./skill-title-input";

/** Persisted message fields consumed by transcript rendering. */
export interface SessionMessageEntryLike {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: AgentMessage;
}

/** Persisted custom-message fields consumed by transcript rendering. */
export interface CustomMessageEntryLike {
	type: "custom_message";
	id: string;
	parentId: string | null;
	timestamp: string;
	customType: string;
	content: CustomMessageContent;
	details?: unknown;
	display: boolean;
	attribution?: MessageAttribution;
}

/** Entries that replay as visible or hidden transcript messages. */
export type TranscriptEntryLike = SessionMessageEntryLike | CustomMessageEntryLike;

/** Restore a persisted custom message, rejecting unsendable content. */
export function customMessageEntryMessage(entry: CustomMessageEntryLike): CustomMessage | undefined {
	if (!isCustomMessageContent(entry.content)) return undefined;
	const normalized = normalizeCustomMessagePayload(entry);
	const attribution = entry.attribution === undefined ? undefined : normalized.attribution;
	return createCustomMessage(
		normalized.customType,
		normalized.content,
		normalized.display,
		normalized.details,
		entry.timestamp,
		attribution,
	);
}

/** Restore the message represented by a transcript entry. */
export function transcriptEntryMessage(entry: TranscriptEntryLike): AgentMessage | undefined {
	return entry.type === "message" ? entry.message : customMessageEntryMessage(entry);
}

/** Whether `message` is a user-authored request: a prompt, or a custom message that starts a user turn. */
export function isUserRequestMessage(message: AgentMessage): boolean {
	return message.role === "user" || (message.role === "custom" && isUserTurnInitiator(message));
}

/** Identify user-authored requests among transcript and metadata entries. */
export function isUserRequestEntry(entry: TranscriptEntryLike | { type: string }): boolean {
	if (entry.type === "message" && "message" in entry) return isUserRequestMessage(entry.message);
	if (entry.type === "custom_message" && "content" in entry) {
		const message = customMessageEntryMessage(entry);
		return message !== undefined && isUserRequestMessage(message);
	}
	return false;
}

/** Messages a recent transcript tail holds: what pickers render first and a live chat replays. */
export const RECENT_TRANSCRIPT_LIMIT = 600;

/**
 * Recent transcript tail starting at a user-request boundary, so tool calls
 * and results stay together. ChatTranscriptBuilder drops a tool result whose
 * initiating call was sliced away, so a tail of orphaned results can leave
 * the picker without any target.
 *
 * A whole user turn may exceed `limit`; paginate rendering if one turn grows too large.
 */
export function recentTranscriptEntries(
	entries: TranscriptEntryLike[],
	limit = RECENT_TRANSCRIPT_LIMIT,
): TranscriptEntryLike[] {
	if (entries.length <= limit) return entries;
	for (let index = entries.length - limit; index > 0; index--) {
		if (isUserRequestEntry(entries[index]!)) return entries.slice(index);
	}
	return entries;
}

/** Editable user request text, preserving skill invocation syntax. */
export function userTurnDraft(entry: TranscriptEntryLike): string | undefined {
	const message = transcriptEntryMessage(entry);
	if (!message) return undefined;
	if (message.role === "user") return textContent(message.content);
	if (message.role !== "custom" || !isUserTurnInitiator(message)) return undefined;
	return titleTextFromSkillPrompt(message) ?? textContent(message.content);
}

/** Extract text blocks verbatim, optionally separating block boundaries. */
export function textContent(content: string | ReadonlyArray<{ type: string; text?: string }>, separator = ""): string {
	if (typeof content === "string") return content;
	let text = "";
	let boundary = "";
	for (const block of content) {
		if (block.type !== "text") continue;
		text += boundary + (block.text ?? "");
		boundary = separator;
	}
	return text;
}

/** Well-formed image blocks in order: a `[Image #N]` marker in the text names the Nth. */
export function imageContent(content: string | ReadonlyArray<TextContent | ImageContent>): ImageContent[] {
	if (typeof content === "string") return [];
	return content.filter(
		(block): block is ImageContent =>
			block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string",
	);
}

/** Join text blocks with spaces and collapse whitespace into a single-line label. */
export function userMessageLabel(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	return textContent(content, " ").replace(/\s+/g, " ").trim();
}
