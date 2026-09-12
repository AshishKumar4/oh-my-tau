/**
 * Conversation forking for subagents: resolve the parent's resolved LLM
 * history into the message list a forked child inherits. Mirrors Codex's
 * `spawn_agent` `fork_turns` and Claude Code's `Agent` `subagent_type: "fork"`.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from "../tools";

/** Fork extent: `"all"` inherits the whole resolved history; `{ lastTurns: N }` keeps the last N user-message-delimited turns. */
export type ForkMode = "all" | { lastTurns: number };

/**
 * The messages a forked child starts with: the parent's resolved LLM context
 * (post-compaction, post-pruning — what the parent would send next), cut at
 * the spawn call so the child never sees its own birth. Only
 * user/assistant/toolResult messages carry over; thinking blocks and
 * toolResults orphaned by a dropped call do not.
 */
export function forkMessages(
	session: ToolSession,
	mode: ForkMode,
	spawnToolCallId: string | undefined,
): AgentMessage[] {
	let messages: AgentMessage[] = (session.sessionManager?.buildSessionContext?.().messages ?? []).filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);

	// Cut the turn that spawned the fork: the assistant message carrying this
	// spawn call and its toolResult (defensive — the in-flight call has none
	// yet, but a late-arriving one must not replay either).
	if (spawnToolCallId !== undefined) {
		messages = messages.filter(
			message =>
				!(
					(message.role === "assistant" &&
						message.content.some(block => block.type === "toolCall" && block.id === spawnToolCallId)) ||
					(message.role === "toolResult" && message.toolCallId === spawnToolCallId)
				),
		);
	}

	if (typeof mode === "object") {
		// A "turn" is one user message plus everything the assistant did up to
		// the next user message; walk back N user-message boundaries.
		let cutIndex = 0;
		let seen = 0;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]!.role !== "user") continue;
			seen += 1;
			if (seen === mode.lastTurns) {
				cutIndex = i;
				break;
			}
		}
		messages = messages.slice(cutIndex);
	}

	// Provider replay state cannot cross into another session: strip thinking
	// and other provider-owned blocks plus the providerPayload that would
	// resurrect them. Assistant messages left empty are dropped entirely.
	const kept: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") {
			kept.push(message);
			continue;
		}
		const content = message.content.filter(
			block => block.type === "text" || block.type === "image" || block.type === "toolCall",
		);
		if (content.length === 0) continue;
		kept.push({ ...message, content, providerPayload: undefined });
	}

	// A toolResult whose call was dropped (spawn omission, a content filter, or
	// a lastTurns cut that landed mid-turn) has nothing to pair with.
	const keptToolCallIds = new Set<string>();
	for (const message of kept) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") keptToolCallIds.add(block.id);
		}
	}
	return kept.filter(message => message.role !== "toolResult" || keptToolCallIds.has(message.toolCallId));
}
