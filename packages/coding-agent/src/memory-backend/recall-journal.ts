/**
 * Session journal for the once-per-session recall block.
 *
 * Auto-recall injects its block as the last system block, which is exactly
 * where the provider anchors the head of its prompt cache. The injection is
 * meant to happen once per session, but `hasRecalledForFirstTurn` lives in
 * process memory, so a resumed session used to query memory again and append a
 * different block (new wall-clock timestamp, newly retained facts). Every such
 * change invalidated the anchored prefix, and the whole conversation was
 * re-billed as cache writes on the next turn.
 *
 * Journaling the first block and replaying it byte for byte keeps the head
 * stable across resumes. Measured on three resumed turns against
 * claude-opus-5: the turn-boundary read stopped collapsing from 32,841 to
 * 17,986 and the per-turn write fell from 15,848 to 836 tokens.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "../session/session-entries";

/** Journal entry carrying the recall block a session already injected. */
export const RECALL_JOURNAL_ENTRY_TYPE = "memory_recall";

/** Reads and appends the recall journal for one session. */
export interface RecallJournalHost {
	getBranch(): SessionEntry[];
	appendCustomEntry(customType: string, data?: unknown): string;
}

/**
 * The block this session already injected, or undefined when it has not
 * recalled yet. Scoped to the backend that wrote it so switching backends
 * mid-session does not replay the other one's text, and to the segment after
 * the newest reset boundary: `/clear` clears the recall-once flag, so the next
 * turn must query again rather than replay the pre-clear block.
 */
export function readJournaledRecall(host: RecallJournalHost, backend: string): string | undefined {
	let block: string | undefined;
	for (const entry of host.getBranch()) {
		if (entry.type === "reset_boundary") {
			block = undefined;
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== RECALL_JOURNAL_ENTRY_TYPE) continue;
		if (!isRecord(entry.data)) continue;
		const { backend: entryBackend, block: journaled } = entry.data;
		if (entryBackend !== backend) continue;
		if (typeof journaled === "string" && journaled.length > 0) block = journaled;
	}
	return block;
}

/** Records the block so later turns of this session reproduce it exactly. */
export function journalRecall(host: RecallJournalHost, backend: string, block: string): void {
	host.appendCustomEntry(RECALL_JOURNAL_ENTRY_TYPE, { backend, block });
}
