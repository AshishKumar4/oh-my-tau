import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { resolveFileDisplayMode } from "@oh-my-pi/pi-coding-agent/utils/file-display-mode";

const PROFILED_MODEL = getBundledModel("anthropic", "claude-opus-5") as Model;
const UNPROFILED_MODEL = getBundledModel("anthropic", "claude-haiku-4-5") as Model;

function makeSession(cwd: string, model?: Model): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "session"),
		getActiveModel: () => model,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text" && typeof c.text === "string")
		.map(c => c.text as string)
		.join("\n");
}

describe("read numbering under the claude-code harness profile", () => {
	it("returns cat -n numbered lines for a profiled model reading file_path", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-read-num-"));
		try {
			const target = path.join(dir, "lines.txt");
			await Bun.write(target, "line 1\nline 2\nline 3");
			const tool = new ReadTool(makeSession(dir, PROFILED_MODEL));
			const result = await tool.execute("call-1", { file_path: target });
			expect(textOf(result)).toBe("     1\tline 1\n     2\tline 2\n     3\tline 3");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps cat -n numbering on the offset/limit window", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-read-num-"));
		try {
			const target = path.join(dir, "lines.txt");
			await Bun.write(target, "line 1\nline 2\nline 3");
			const tool = new ReadTool(makeSession(dir, PROFILED_MODEL));
			const result = await tool.execute("call-2", { file_path: target, offset: 2, limit: 1 });
			expect(textOf(result)).toBe("     2\tline 2");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("never emits cat -n numbering for an unprofiled model", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-read-num-"));
		try {
			const target = path.join(dir, "lines.txt");
			await Bun.write(target, "line 1\nline 2\nline 3");
			const tool = new ReadTool(makeSession(dir, UNPROFILED_MODEL));
			const result = await tool.execute("call-3", { path: target });
			const text = textOf(result);
			expect(text).toContain("line 1");
			expect(text).not.toMatch(/^\s{5}\d\t/m);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("resolves cat numbering with forced line numbers for a profiled model", () => {
		const settings = Settings.isolated();
		const profiled = resolveFileDisplayMode({ settings, getActiveModel: () => PROFILED_MODEL });
		expect(profiled).toEqual({ numbering: "cat", lineNumbers: true, hashLines: false });
		const unprofiled = resolveFileDisplayMode({ settings, getActiveModel: () => UNPROFILED_MODEL });
		expect(unprofiled.numbering).toBe("pipe");
	});
});
