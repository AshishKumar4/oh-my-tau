/**
 * Conversation forking for subagents: resolve the parent's resolved LLM
 * history into the message list a forked child inherits. Mirrors Codex's
 * `spawn_agent` `fork_turns` and Claude Code's `Agent` `subagent_type: "fork"`.
 */
import type { Message } from "@oh-my-pi/pi-ai";
import type { ForkRequestSnapshot } from "../session/fork-context";
import {
	convertToLlm,
	isUserTurnInitiator,
	sanitizeRehydratedOpenAIResponsesAssistantMessage,
} from "../session/messages";
import { ToolError } from "../tools/tool-errors";
import type { ToolSession } from "../tools";

/** Fork extent: `"all"` inherits the whole resolved history; `{ lastTurns: N }` keeps the last N user-message-delimited turns. */
export type ForkMode = "all" | { lastTurns: number };
/** The resolved history a forked child starts with, captured at spawn-call time. */
export interface ForkSnapshot {
	messages: Message[];
	/**
	 * The parent's provider-native request snapshot, attached only for a
	 * whole-history (`"all"`) fork: a partial slice can never be a byte-exact
	 * wire prefix, so N-turn forks deliberately do not claim prefix reuse.
	 */
	request?: ForkRequestSnapshot;
}

/**
 * The messages a forked child starts with: the parent's resolved LLM context
 * converted by the same path the agent loop uses (`convertToLlm`, so
 * compaction/branch summaries, file mentions, skill prompts and steering keep
 * their provider-facing shape). The history is cut before the assistant
 * message carrying this spawn call, so the child never sees its own birth;
 * a surviving toolResult for that call is dropped as orphaned below.
 *
 * Provider replay state (encrypted reasoning, native response items,
 * `providerPayload`) is self-contained for OpenAI-family providers and must
 * survive so the child can reuse it; only the canonical Copilot-bound
 * sanitizer runs on assistant messages. The snapshot is a deep clone — the
 * child may prune or rewrite its copy without mutating the parent's journal.
 */
export function forkMessages(session: ToolSession, mode: ForkMode, spawnToolCallId: string | undefined): Message[] {
	const manager = session.sessionManager;
	if (!manager?.buildSessionContext) {
		throw new ToolError("Conversation forking requires a session journal.");
	}
	const history = manager.buildSessionContext().messages;

	const spawnIndex =
		spawnToolCallId === undefined
			? -1
			: history.findIndex(
					message =>
						message.role === "assistant" &&
						message.content.some(block => block.type === "toolCall" && block.id === spawnToolCallId),
				);
	const prefix = spawnIndex < 0 ? history : history.slice(0, spawnIndex);

	// A "turn" starts at a user message (or a custom message that initiates a
	// user-attributed turn, e.g. a directly invoked /skill prompt); walk back N
	// such boundaries.
	let start = 0;
	if (typeof mode === "object") {
		let turns = 0;
		for (let i = prefix.length - 1; i >= 0; i--) {
			const message = prefix[i];
			if (!message || !(message.role === "user" || (message.role === "custom" && isUserTurnInitiator(message))))
				continue;
			turns += 1;
			if (turns === mode.lastTurns) {
				start = i;
				break;
			}
		}
	}

	const messages = structuredClone(convertToLlm(prefix.slice(start)));
	const kept = messages.map(message =>
		message.role === "assistant" ? sanitizeRehydratedOpenAIResponsesAssistantMessage(message) : message,
	);

	// A toolResult whose call was dropped (spawn omission, or a lastTurns cut
	// that landed mid-turn) has nothing to pair with.
	const keptToolCallIds = new Set<string>();
	for (const message of kept) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") keptToolCallIds.add(block.id);
		}
	}
	return kept.filter(message => message.role !== "toolResult" || keptToolCallIds.has(message.toolCallId));
}
