import * as fs from "node:fs";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { PromptResponse } from "@oh-my-pi/pi-utils/acp";
import { conversationCallLogPath } from "./conversation-store";

type TurnUsage = NonNullable<PromptResponse["usage"]>;

/**
 * agy reports token usage over ACP only in a finished turn's reply; a cancelled turn's reply
 * carries none (measured on 1.5.12), so a turn cancelled at the tool deadline or by an abort would
 * vanish from the session's totals. agy also writes every model call of a conversation, with its
 * token counts, to a per-conversation log in the account's agy directory. This reads that log
 * forward from where it last stopped: each step reports the calls made since the previous step,
 * including calls of cancelled turns.
 */
export class CallUsageLog {
	readonly #file: string;
	/** Calls created before attaching (the log records whole seconds) belong to history, never this host. */
	readonly #since: number;
	#offset: number;

	/** Starts after the calls already logged, so attaching to a loaded conversation counts nothing twice. */
	constructor(geminiDir: string, conversationId: string, now = Date.now()) {
		this.#file = conversationCallLogPath(geminiDir, conversationId);
		this.#since = Math.floor(now / 1000) * 1000;
		this.#offset = fileSize(this.#file) ?? 0;
	}

	/**
	 * Sum of the calls logged since the last read, or undefined when agy keeps no such log (an older
	 * or newer CLI layout), in which case the caller keeps agy's turn-end usage.
	 */
	take(): TurnUsage | undefined {
		const size = fileSize(this.#file);
		if (size === undefined) return undefined;
		const usage: TurnUsage = {
			inputTokens: 0,
			outputTokens: 0,
			cachedReadTokens: 0,
			cachedWriteTokens: 0,
			totalTokens: 0,
		};
		// A rewritten log restarts at the current end rather than counting its calls again.
		if (size < this.#offset) this.#offset = size;
		if (size === this.#offset) return usage;
		const handle = fs.openSync(this.#file, "r");
		let text: string;
		try {
			const buffer = Buffer.alloc(size - this.#offset);
			const read = fs.readSync(handle, buffer, 0, buffer.length, this.#offset);
			text = buffer.subarray(0, read).toString("utf8");
		} finally {
			fs.closeSync(handle);
		}
		// Only complete lines count; a line agy is still writing is read on the next call.
		const end = text.lastIndexOf("\n");
		if (end < 0) return usage;
		this.#offset += Buffer.byteLength(text.slice(0, end + 1));
		for (const line of text.slice(0, end).split("\n")) {
			const record = parseRecord(line);
			if (!record || record.createdAt < this.#since) continue;
			usage.inputTokens += record.input;
			usage.cachedReadTokens = (usage.cachedReadTokens ?? 0) + record.cached;
			usage.outputTokens += record.output;
		}
		usage.totalTokens = usage.inputTokens + (usage.cachedReadTokens ?? 0) + usage.outputTokens;
		return usage;
	}
}

function fileSize(file: string): number | undefined {
	try {
		return fs.statSync(file).size;
	} catch {
		return undefined;
	}
}

/** A model call's tokens; `input_tokens` excludes cached reads, and `output_tokens` includes thinking. */
function parseRecord(line: string): { createdAt: number; input: number; cached: number; output: number } | undefined {
	let record: unknown;
	try {
		record = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(record) || typeof record.input_tokens !== "number" || typeof record.created_at !== "string") {
		return undefined;
	}
	const createdAt = Date.parse(record.created_at);
	if (Number.isNaN(createdAt)) return undefined;
	return {
		createdAt,
		input: record.input_tokens,
		cached: typeof record.cache_read_tokens === "number" ? record.cache_read_tokens : 0,
		output: typeof record.output_tokens === "number" ? record.output_tokens : 0,
	};
}
