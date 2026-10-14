/**
 * The extension runner hands each context hook call its own copy of a history
 * message it kept, carrying that call's history position. Every copy of one
 * version of the message is made from a single detached source, and LLM
 * conversion keys on that source, so a history message converts once per
 * version whatever position a call places it at.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

const historySources = new WeakMap<AgentMessage, AgentMessage>();

/** Records that the runner's per-call `copy` was made from `source`. */
export function setContextHistorySource(copy: AgentMessage, source: AgentMessage): void {
	historySources.set(copy, source);
}

/** The detached source a runner copy was made from, else `message` itself. */
export function contextHistorySource(message: AgentMessage): AgentMessage {
	return historySources.get(message) ?? message;
}
