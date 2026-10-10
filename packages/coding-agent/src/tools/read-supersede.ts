import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

/** Only complete file views may replace earlier detailed ranges. */
export function isCompleteReadResult(message: ToolResultMessage): boolean {
	const details = message.details;
	if (!isRecord(details) || details.summary !== undefined) return false;
	const truncation = details.truncation;
	if (truncation !== undefined && (!isRecord(truncation) || truncation.truncated !== false)) return false;
	const meta = details.meta;
	if (meta !== undefined) {
		if (!isRecord(meta) || meta.truncation !== undefined) return false;
		if (meta.limits !== undefined && (!isRecord(meta.limits) || meta.limits.columnTruncated !== undefined))
			return false;
	}
	return typeof details.totalLines === "number" || message.content.some(block => block.type === "image");
}
