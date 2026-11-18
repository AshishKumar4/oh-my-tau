import { prompt } from "@oh-my-pi/pi-utils";
import { escapeHarnessText } from "../harness/content";
import monitorEventTemplate from "../prompts/system/monitor-event.md" with { type: "text" };
import type { CustomMessage } from "./messages";

export const MONITOR_EVENT_MESSAGE_TYPE = "monitor-event";

/** Lines a monitor reported, delivered to the session that started it; see `MonitorTool`. */
export interface MonitorEvent {
	readonly jobId: string;
	readonly description: string;
	readonly text: string;
}

/** A queued event, stamped with the delivery epoch it belongs to: a `/new` drops the old session's events. */
export interface MonitorEventEntry extends MonitorEvent {
	readonly epoch: number;
}

/** One notice for the events queued since the last delivery, oldest first. */
export function buildMonitorEventMessage(entries: MonitorEventEntry[]): CustomMessage | null {
	if (entries.length === 0) return null;
	// A monitor's output is text its script controls: it must not close the notice or forge a harness block.
	const text = prompt.render(monitorEventTemplate, {
		events: entries.map(entry => ({
			jobId: escapeHarnessText(entry.jobId),
			description: escapeHarnessText(entry.description),
			text: escapeHarnessText(entry.text),
		})),
	});
	return {
		role: "custom",
		customType: MONITOR_EVENT_MESSAGE_TYPE,
		content: text,
		display: true,
		attribution: "agent",
		details: { jobIds: [...new Set(entries.map(entry => entry.jobId))] },
		timestamp: Date.now(),
	};
}
