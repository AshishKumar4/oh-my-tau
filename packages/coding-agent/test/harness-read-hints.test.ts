import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { formatTruncationMetaNotice, type TruncationMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const CLAUDE_CODE = getBundledModel("anthropic", "claude-opus-5") as Model;
const NATIVE = getBundledModel("anthropic", "claude-haiku-4-5") as Model;

/** Pin summaries to the outermost elisions so the small fixture below always summarizes. */
const SUMMARY_OVERRIDES: Record<string, unknown> = {
	"read.summarize.minTotalLines": 0,
	"read.summarize.unfoldUntil": 0,
	"read.summarize.unfoldLimit": 0,
};

const TWO_FUNCTIONS =
	"export function alpha(value: string): string {\n\tconst clean = value.trim();\n\tconst label = clean || 'alpha';\n\treturn label.toUpperCase();\n}\n\nexport function beta(): number {\n\tconst one = 1;\n\tconst two = 2;\n\treturn one + two;\n}\n";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2Z0AAAAASUVORK5CYII=";

function toolSession(cwd: string, model: Model, overrides: Record<string, unknown> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "session"),
		getActiveModel: () => model,
		settings: Settings.isolated(overrides),
	} as unknown as ToolSession;
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

describe("Read result hints under the claude-code harness", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-read-hints-"));
	});

	afterEach(async () => {
		await removeWithRetries(dir);
	});

	it("names offset in the continuation and past-the-end hints; omp's selectors stay native", async () => {
		const target = path.join(dir, "lines.txt");
		await Bun.write(target, Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"));
		const vendor = wrapToolWithMetaNotice(new ReadTool(toolSession(dir, CLAUDE_CODE)));

		expect(textOf(await vendor.execute("c1", { file_path: target, limit: 5 }))).toEndWith(
			"[Showing lines 1-5 of 20. Use offset=6 to continue]",
		);
		expect(textOf(await vendor.execute("c2", { file_path: target, offset: 50 }))).toBe(
			"Line 50 is beyond end of file (20 lines total). Use offset=1 to read from the start, or offset=20 to read the last line.",
		);

		const native = wrapToolWithMetaNotice(new ReadTool(toolSession(dir, NATIVE)));
		expect(textOf(await native.execute("n1", { path: `${target}:50` }))).toBe(
			"Line 50 is beyond end of file (20 lines total). Use :1 to read from the start, or :20 to read the last line.",
		);
		expect(textOf(await native.execute("n2", { path: `${target}:1+5` }))).toEndWith(
			"[Showing lines 1-8 of 20. Use :9 to continue]",
		);
	});

	it("continues a byte-capped window by offset in the notice omp appends", async () => {
		const target = path.join(dir, "wide.txt");
		await Bun.write(target, Array.from({ length: 400 }, (_, i) => `${i + 1} ${"x".repeat(1000)}`).join("\n"));

		const vendor = textOf(
			await wrapToolWithMetaNotice(new ReadTool(toolSession(dir, CLAUDE_CODE))).execute("c1", { file_path: target }),
		);
		expect(vendor).toMatch(/Use offset=\d+ to continue/);
		expect(vendor).not.toMatch(/Use :\d+ to continue/);

		const native = textOf(
			await wrapToolWithMetaNotice(new ReadTool(toolSession(dir, NATIVE))).execute("n1", { path: target }),
		);
		expect(native).toMatch(/Use :\d+ to continue/);
		expect(native).not.toContain("offset=");
	});

	it("keeps the summary in cat -n shape and phrases its footer as one offset/limit range", async () => {
		const target = path.join(dir, "footer.ts");
		await Bun.write(target, TWO_FUNCTIONS);

		const vendor = textOf(
			await new ReadTool(toolSession(dir, CLAUDE_CODE, SUMMARY_OVERRIDES)).execute("c1", { file_path: target }),
		);
		expect(vendor).toBe(
			"   1-5\texport function alpha(value: string): string { … }\n     6\t\n  7-11\texport function beta(): number { … }\n\n[…6ln elided; re-read needed ranges, e.g. offset=1 limit=5]",
		);

		const native = textOf(
			await new ReadTool(toolSession(dir, NATIVE, SUMMARY_OVERRIDES)).execute("n1", { path: target }),
		);
		expect(native).toContain("footer.ts:1-5,7-11");
	});

	it("offers no raw mode for a binary file, which Claude Code's Read cannot request", async () => {
		const target = path.join(dir, "blob.bin");
		await Bun.write(target, new Uint8Array([0x61, 0x62, 0x63, 0x00, 0xff, 0xfe, 0x64, 0x65]));

		const vendor = textOf(await new ReadTool(toolSession(dir, CLAUDE_CODE)).execute("c1", { file_path: target }));
		expect(vendor).toContain("Cannot read binary file");
		expect(vendor).not.toContain(":raw");

		const native = textOf(await new ReadTool(toolSession(dir, NATIVE)).execute("n1", { path: target }));
		expect(native).toContain("Use ':raw' to read bytes verbatim.");
	});

	it("pages a directory listing by offset", async () => {
		for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]) await Bun.write(path.join(dir, name), name);

		const vendor = textOf(
			await new ReadTool(toolSession(dir, CLAUDE_CODE)).execute("c1", { file_path: dir, limit: 2 }),
		);
		expect(vendor).toMatch(/more lines in listing\. Use offset=3 to continue\]$/);
	});

	it("names the parameters, not the bridged selector, when a read repeats", async () => {
		const target = path.join(dir, "same.txt");
		await Bun.write(target, "unchanged\n");
		const vendor = new ReadTool(toolSession(dir, CLAUDE_CODE));

		let text = "";
		for (let call = 0; call < 3; call++) text = textOf(await vendor.execute(`c${call}`, { file_path: target }));
		expect(text).toContain("use a narrower `offset`/`limit` range, or proceed with the edit.]");
		expect(text).not.toContain("path:A-B");
	});

	it("asks a vision model through file_path when the model cannot see the image", async () => {
		const target = path.join(dir, "shot.png");
		await Bun.write(target, Buffer.from(PNG_1X1, "base64"));
		const textOnly = { ...NATIVE, input: ["text"] } as Model;
		const vendor = new ReadTool(toolSession(dir, textOnly, { "harness.mode": "claude-code" }));

		const text = textOf(await vendor.execute("c1", { file_path: target }));
		expect(text).toContain("Image metadata:");
		expect(text).toContain("To analyze the image, call Read with `file_path` set to `shot.png?q=<question>`");
	});
});

describe("truncation notice continuation", () => {
	const truncation: TruncationMeta = {
		direction: "head",
		truncatedBy: "lines",
		totalLines: 100,
		totalBytes: 1000,
		outputLines: 10,
		outputBytes: 100,
		shownRange: { start: 1, end: 10 },
		nextOffset: 11,
	};

	it("names the paging parameter a tool's schema serves, else omp's selector", () => {
		expect(formatTruncationMetaNotice({ ...truncation, nextOffsetParam: "offset" })).toBe(
			"Showing lines 1-10 of 100. Use offset=11 to continue",
		);
		expect(formatTruncationMetaNotice(truncation)).toBe("Showing lines 1-10 of 100. Use :11 to continue");
	});
});
