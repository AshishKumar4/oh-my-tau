import { prompt } from "@oh-my-pi/pi-utils";
import type { DaemonCompletionNotification } from "../launch/protocol";
import launchCompletionTemplate from "../prompts/session/launch-completion.md" with { type: "text" };
import type { CustomMessage } from "./messages";

import { LAUNCH_COMPLETION_MESSAGE_TYPE } from "@oh-my-pi/pi-tui/chat/messages";
export { LAUNCH_COMPLETION_MESSAGE_TYPE } from "@oh-my-pi/pi-tui/chat/messages";

/** One broker completion awaiting injection into its owning session. */
export type LaunchCompletionEntry = DaemonCompletionNotification;

/** Agent id the advisor's tool session launches supervised processes under. */
export const ADVISOR_LAUNCH_OWNER = "advisor";

/**
 * Whether a broker completion belongs to the primary session or its advisor.
 *
 * `sessionOwner` must be the owner the primary launched under, which is the
 * tool session's `getAgentId() ?? getSessionId()` (see `launch/services.ts`):
 * the agent id (`Main`, a task name) when one is set. Comparing against the
 * session UUID instead rejects every completion the primary owns; the broker
 * never receives an ack, redelivers, and each redelivery aborts `wait` again.
 */
export function isLaunchCompletionOwner(owner: string, sessionOwner: string): boolean {
	return owner === sessionOwner || owner === ADVISOR_LAUNCH_OWNER;
}

/** Build one model-visible notification per terminal supervised process exit. */
export function buildLaunchCompletionBatchMessage(entries: LaunchCompletionEntry[]): CustomMessage {
	return {
		role: "custom",
		customType: LAUNCH_COMPLETION_MESSAGE_TYPE,
		content: entries
			.map(({ daemon }) =>
				prompt.render(launchCompletionTemplate, {
					name: daemon.name,
					state: daemon.state,
					exitCode: daemon.exitCode,
					hasExitCode: daemon.exitCode !== undefined,
				}),
			)
			.join("\n"),
		display: true,
		attribution: "agent",
		details: { daemons: entries.map(entry => entry.daemon) },
		timestamp: Date.now(),
	};
}
