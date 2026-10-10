import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";

import { type AgentToolResult, Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	pruneSupersededToolResults,
	readToolSupersedeKey,
	type SessionEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { isCompleteReadResult } from "@oh-my-pi/pi-coding-agent/tools/read-supersede";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { TempDir } from "@oh-my-pi/pi-utils";

const directory = TempDir.createSync("@pi-read-completeness-");
let reader: ReadTool;

beforeAll(async () => {
	const source = Array.from({ length: 40 }, (_, index) => {
		const body = Array.from({ length: 6 }, (_, line) => `  const value${line} = input + ${index + line};`).join("\n");
		return `export function step${index}(input: number): number {\n${body}\n  return value5;\n}`;
	}).join("\n\n");
	await Bun.write(directory.join("code.ts"), source);
	await Bun.write(directory.join("notes.txt"), Array.from({ length: 20 }, (_, index) => `note ${index}`).join("\n"));
	await Bun.write(directory.join("long.txt"), Array.from({ length: 1000 }, (_, index) => `row ${index}`).join("\n"));
	await Bun.write(directory.join("wide.txt"), ["short", "x".repeat(5000), "short"].join("\n"));
	await Bun.write(
		directory.join("huge.log"),
		Array.from({ length: 200_000 }, (_, index) => `log ${index} ${"z".repeat(20)}`).join("\n"),
	);
	const session: ToolSession = {
		cwd: directory.path(),
		hasUI: false,
		getSessionFile: () => directory.join("session.jsonl"),
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"lsp.enabled": false,
			"read.summarize.enabled": true,
			"read.summarize.minBodyLines": 4,
			"read.summarize.minTotalLines": 100,
			"read.summarize.unfoldUntil": 0,
			"read.summarize.unfoldLimit": 0,
		}),
	};
	reader = new ReadTool(session);
});
afterAll(() => directory.remove());

function entries(id: string, readPath: string, result: AgentToolResult<ReadToolDetails>): SessionEntry[] {
	const timestamp = Date.now();
	return [
		{
			type: "message",
			id: `${id}-call`,
			parentId: null,
			timestamp: new Date(timestamp).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id, name: "read", arguments: { path: readPath } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				stopReason: "toolUse",
				timestamp,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		},
		{
			type: "message",
			id: `${id}-result`,
			parentId: null,
			timestamp: new Date(timestamp).toISOString(),
			message: {
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: result.content,
				details: result.details,
				isError: result.isError === true,
				timestamp,
			},
		},
	];
}

describe("read completeness through real file reads and pruning", () => {
	test.each(["lost.txt", "lost.txt:2-5"])(
		"a failed newer read does not replace prior success from %s",
		async older => {
			await Bun.write(
				directory.join("lost.txt"),
				Array.from({ length: 12 }, (_, index) => `retained ${index}`).join("\n"),
			);
			const prior = await reader.execute("older", { path: older });
			await fs.unlink(directory.join("lost.txt"));
			let failure: AgentToolResult<ReadToolDetails>;
			try {
				await reader.execute("failed", { path: "lost.txt" });
				throw new Error("Expected the missing file read to fail");
			} catch (error) {
				if (!(error instanceof ToolError)) throw error;
				failure = { content: [{ type: "text", text: error.message }], isError: true };
			}
			const history = [...entries("older", older, prior), ...entries("failed", "lost.txt", failure)];
			const original = history[1];
			if (!original || original.type !== "message" || original.message.role !== "toolResult") {
				throw new Error("Expected the successful read entry");
			}
			const savedContent = original.message.content;
			const result = pruneSupersededToolResults(history, new Tokenizer(), {
				supersedeKey: readToolSupersedeKey,
				supersedeComplete: isCompleteReadResult,
				protectedTools: [],
				now: Date.now(),
			});
			expect(result.prunedCount).toBe(0);
			expect(original.message.content).toEqual(savedContent);
		},
	);
	test.each([
		{ name: "code summary", older: "code.ts:10-40", newer: "code.ts", replaces: false, summary: true },
		{ name: "complete bare file", older: "notes.txt:2-5", newer: "notes.txt", replaces: true },
		{ name: "raw file view", older: "notes.txt:raw", newer: "notes.txt", replaces: false },
		{ name: "raw range view", older: "notes.txt:2-5:raw", newer: "notes.txt", replaces: false },
		{ name: "line-limited page", older: "long.txt:900-950", newer: "long.txt", replaces: false },
		{ name: "column-capped page", older: "wide.txt:1-3", newer: "wide.txt", replaces: false },
		{ name: "unscanned large file", older: "huge.log:150000-150010", newer: "huge.log", replaces: false },
	])("$name", async ({ older, newer, replaces, summary }) => {
		const prior = await reader.execute("older", { path: older });
		const next = await reader.execute("newer", { path: newer });
		if (summary) expect(next.details?.summary).toBeDefined();
		const history = [...entries("older", older, prior), ...entries("newer", newer, next)];
		const original = history[1];
		if (!original || original.type !== "message" || original.message.role !== "toolResult") {
			throw new Error("Expected the detailed read entry");
		}
		const savedContent = original.message.content;
		const result = pruneSupersededToolResults(history, new Tokenizer(), {
			supersedeKey: readToolSupersedeKey,
			supersedeComplete: isCompleteReadResult,
			protectedTools: [],
			now: Date.now(),
		});
		expect(result.prunedCount).toBe(replaces ? 1 : 0);
		if (!replaces) expect(original.message.content).toEqual(savedContent);
		result.undo();
		expect(original.message.content).toEqual(savedContent);
	});
});
