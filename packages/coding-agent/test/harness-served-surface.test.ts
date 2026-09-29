import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Model, type TSchema, toolWireSchema } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import {
	CLAUDE_CODE_SURFACE_EDITS,
	projectHarnessCapture,
	type VendorTool,
} from "@oh-my-pi/pi-coding-agent/harness/capture";
import { harnessFacadeSpecs } from "@oh-my-pi/pi-coding-agent/harness/facades";
import { harnessWireRenames } from "@oh-my-pi/pi-coding-agent/harness/manifest";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { TOOL_TIMEOUTS } from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { WebSearchTool } from "@oh-my-pi/pi-coding-agent/web/search";

const FIXTURE_DIR = path.join(import.meta.dir, "fixtures", "harness", "claude-code");

/**
 * Surface edits whose anchor a recording does not carry, by fixture: that
 * client build never made the claim. Every other edit must find its anchor,
 * so a recording that rewords a claim fails here instead of serving it, and a
 * new recording has to be listed before it counts as covered.
 */
const ABSENT_ANCHORS: Readonly<Record<string, readonly string[]>> = {
	"2.1.269.517-cli-claude-opus-5.json": ["prompt.pasted-content"],
	"2.1.269.517-cli-claude-fable-5-1.json": ["prompt.pasted-content", "prompt.agent-restraint"],
	"2.1.284.b93-cli-claude-opus-5-5.json": ["prompt.agent-restraint"],
	"2.1.284.b93-cli-claude-fable-5-1.json": ["prompt.agent-restraint"],
};

/** Declarations served from the capture under omp's bridged tools; the facades serve omp-owned text. */
const CAPTURE_SERVED_TOOLS = ["Read", "Bash", "Edit", "Write", "AskUserQuestion", "WebSearch"] as const;

/** Tool names other Claude Code builds declare: legacy-model task tools, custom agents, older clients. */
const OTHER_VENDOR_TOOLS = [
	"TodoWrite",
	"TaskCreate",
	"TaskGet",
	"TaskList",
	"TaskUpdate",
	"Grep",
	"Glob",
	"MultiEdit",
	"NotebookRead",
	"BashOutput",
	"KillShell",
];

const FORBIDDEN_PHRASES = ["not available", "not supported in this build", "[redacted-session-path]"];

const SERVED_TOOL_NAMES = new Set([
	...Object.values(harnessWireRenames("claude-code")),
	...harnessFacadeSpecs("claude-code").map(spec => spec.wireName),
]);

interface RecordedCapture {
	readonly tools: readonly string[];
	readonly declarations: readonly { readonly name: string; readonly description: string }[];
}

interface Fixture {
	readonly name: string;
	readonly raw: RecordedCapture;
	readonly text: string;
	readonly tools: Readonly<Record<string, VendorTool>>;
	readonly unmatchedEdits: readonly string[];
}

async function loadFixture(name: string): Promise<Fixture> {
	const raw = (await Bun.file(path.join(FIXTURE_DIR, name)).json()) as RecordedCapture;
	const projection = projectHarnessCapture("claude-code", raw);
	if (!projection.ok) throw new Error(`${name} rejected: ${projection.reason}`);
	return { name, raw, text: projection.text, tools: projection.tools, unmatchedEdits: projection.unmatchedEdits };
}

const FIXTURE_NAMES = fs.readdirSync(FIXTURE_DIR).filter(name => name.endsWith(".json")).sort();
const FIXTURES = await Promise.all(FIXTURE_NAMES.map(loadFixture));

/** Everything a capture puts on the wire under omp: the instructions and the bridged declarations. */
function servedTexts(fixture: Fixture): Array<{ where: string; text: string }> {
	return [
		{ where: "prompt", text: fixture.text },
		...CAPTURE_SERVED_TOOLS.map(name => {
			const tool = fixture.tools[name];
			if (tool === undefined) throw new Error(`${fixture.name} declares no ${name}`);
			return { where: name, text: `${tool.description}\n${JSON.stringify(tool.inputSchema ?? {})}` };
		}),
	];
}

function unservedToolNames(): string[] {
	const recorded = new Set([...FIXTURES.flatMap(fixture => fixture.raw.tools), ...OTHER_VENDOR_TOOLS]);
	return [...recorded].filter(name => !SERVED_TOOL_NAMES.has(name)).sort();
}

function namedTools(text: string, names: readonly string[]): string[] {
	return names.filter(name => new RegExp(`\\b${name}\\b`).test(text));
}

function schemaProperties(tool: VendorTool): string[] {
	const properties = tool.inputSchema?.properties;
	return properties !== null && typeof properties === "object" ? Object.keys(properties) : [];
}

describe("served Claude Code surface guard", () => {
	it("covers every recorded capture, each with the anchors it lacks listed", () => {
		expect(FIXTURE_NAMES).toEqual(Object.keys(ABSENT_ANCHORS).sort());
	});

	it("finds every edit's anchor in each recording that makes the claim", () => {
		for (const fixture of FIXTURES) {
			expect([...fixture.unmatchedEdits].sort(), fixture.name).toEqual([...ABSENT_ANCHORS[fixture.name]!].sort());
		}
	});

	it("keeps no edit that no recording anchors", () => {
		for (const edit of CLAUDE_CODE_SURFACE_EDITS) {
			const anchoredSomewhere = FIXTURES.some(fixture => !ABSENT_ANCHORS[fixture.name]!.includes(edit.id));
			expect(anchoredSomewhere, edit.id).toBe(true);
		}
	});

	it("names no tool omp does not serve under Claude Code's names", () => {
		const unserved = unservedToolNames();
		// The 2.1.284 surface alone lists these; the guard must cover all of them.
		for (const name of ["Monitor", "NotebookEdit", "EnterPlanMode", "ExitPlanMode", "CronCreate", "Workflow"]) {
			expect(unserved).toContain(name);
		}
		for (const fixture of FIXTURES) {
			for (const { where, text } of servedTexts(fixture)) {
				expect(namedTools(text, unserved), `${fixture.name} ${where}`).toEqual([]);
			}
		}
	});

	it("serves no unavailability note and no recording-session path", () => {
		for (const fixture of FIXTURES) {
			for (const { where, text } of servedTexts(fixture)) {
				for (const phrase of FORBIDDEN_PHRASES) {
					expect(text.includes(phrase), `${fixture.name} ${where}: ${phrase}`).toBe(false);
				}
			}
		}
	});

	it("drops the vendor claims from the instructions and keeps what omp backs", () => {
		for (const fixture of FIXTURES) {
			const text = fixture.text;
			for (const removed of [
				"# Memory",
				"MEMORY.md",
				"/<skill-name>",
				"<pasted_content>",
				"claude.ai/code",
				"/fast",
				"Do not use the Agent tool",
			]) {
				expect(text.includes(removed), `${fixture.name}: ${removed}`).toBe(false);
			}
			expect(text, fixture.name).toContain("suggest they type `! <command>` in the prompt");
			expect(text, fixture.name).toContain("# Harness");
			expect(text, fixture.name).toContain("Model IDs");
		}
	});

	it("describes omp's Read: structural summaries, offset/limit paging, no pages parameter", () => {
		for (const fixture of FIXTURES) {
			const read = fixture.tools.Read!;
			expect(schemaProperties(read), fixture.name).toEqual(["file_path", "offset", "limit"]);
			expect(read.description).toContain("returns a structural summary");
			expect(read.description).toContain("Reads PDFs as extracted text, paged with `offset`/`limit`.");
			expect(read.description).toContain("as their cells' source, without outputs.");
			expect(read.description).toContain("Reading a directory returns a listing of its entries.");
			expect(read.description).toContain("an internal URL such as `artifact://<id>`");
			expect(read.description).not.toContain("2000 lines");
			expect(read.description).not.toContain("`pages`");
		}
	});

	it("states omp's Bash timeouts and drops the sandbox, Monitor and attribution claims", () => {
		const defaultMs = TOOL_TIMEOUTS.bash.default * 1000;
		const maxMs = TOOL_TIMEOUTS.bash.max * 1000;
		for (const fixture of FIXTURES) {
			const bash = fixture.tools.Bash!;
			expect(bash.description).toContain(`- \`timeout\` is in milliseconds: default ${defaultMs}, max ${maxMs}.`);
			expect(bash.description).not.toContain("default 120000");
			expect(bash.description).not.toContain("max 600000");
			expect(bash.description).not.toContain("sleep` is blocked");
			expect(bash.description).not.toContain("attribution");
			expect(schemaProperties(bash), fixture.name).toEqual([
				"command",
				"timeout",
				"description",
				"run_in_background",
			]);
			const timeout = (bash.inputSchema?.properties as Record<string, { description?: string }>).timeout;
			expect(timeout?.description).toBe(`Optional timeout in milliseconds (max ${maxMs})`);
		}
	});

	it("drops the read-before-write gates Edit and Write do not enforce", () => {
		for (const fixture of FIXTURES) {
			expect(fixture.tools.Edit!.description).not.toContain("You must Read the file");
			expect(fixture.tools.Write!.description).not.toContain("will fail");
			expect(fixture.tools.Write!.description).toContain("For partial changes, use Edit instead.");
		}
	});

	it("drops AskUserQuestion's plan-mode note, side-by-side layout and host-filled fields", () => {
		for (const fixture of FIXTURES) {
			const ask = fixture.tools.AskUserQuestion!;
			expect(ask.description).not.toContain("Plan mode note");
			expect(ask.description).not.toContain("side-by-side");
			expect(ask.description).toContain("Preview content is rendered as markdown");
			expect(schemaProperties(ask), fixture.name).toEqual(["questions"]);
		}
	});

	it("serves WebSearch without a recorded calendar month", () => {
		const months =
			/\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/;
		for (const fixture of FIXTURES) {
			const search = fixture.tools.WebSearch!;
			expect(search.description).not.toMatch(months);
			expect(search.description).toContain("- The current month is (provided in the conversation below)");
		}
	});

	it("leaves every declaration outside the edited tools as recorded", () => {
		for (const fixture of FIXTURES) {
			for (const declaration of fixture.raw.declarations) {
				if ((CAPTURE_SERVED_TOOLS as readonly string[]).includes(declaration.name)) continue;
				expect(fixture.tools[declaration.name]?.description, `${fixture.name} ${declaration.name}`).toBe(
					declaration.description,
				);
			}
		}
	});

	it("projects a recording to the same bytes every time without touching the parsed capture", async () => {
		for (const name of FIXTURE_NAMES) {
			const raw: unknown = await Bun.file(path.join(FIXTURE_DIR, name)).json();
			const before = JSON.stringify(raw);
			const first = projectHarnessCapture("claude-code", raw);
			const second = projectHarnessCapture("claude-code", raw);
			expect(JSON.stringify(second), name).toBe(JSON.stringify(first));
			expect(JSON.stringify(raw), name).toBe(before);
		}
	});
});

const CLAUDE_CODE_MODEL = getBundledModel("anthropic", "claude-opus-5") as Model;
const NATIVE_MODEL = getBundledModel("anthropic", "claude-haiku-4-5") as Model;

function toolSession(model: Model): ToolSession {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated(),
		getActiveModel: () => model,
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

interface DescribedTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: TSchema;
}

function fallbackTools(model: Model): DescribedTool[] {
	const session = toolSession(model);
	return [
		new ReadTool(session),
		new BashTool(session),
		new EditTool(session),
		new WriteTool(session),
		new AskTool(session),
		new WebSearchTool(session),
	];
}

describe("claude-code fallbacks when a capture carries no declaration", () => {
	it("describe only the fields Claude Code's schemas serve", () => {
		const unserved = unservedToolNames();
		for (const tool of fallbackTools(CLAUDE_CODE_MODEL)) {
			const schema = JSON.stringify(
				toolWireSchema({ name: tool.name, description: "", parameters: tool.parameters }),
			);
			for (const text of [tool.description, schema]) {
				for (const phrase of FORBIDDEN_PHRASES) {
					expect(text.includes(phrase), `${tool.name}: ${phrase}`).toBe(false);
				}
				expect(namedTools(text, unserved), tool.name).toEqual([]);
			}
			// omp's native fields and selector syntax have no place in the vendor shape.
			expect(tool.description, tool.name).not.toMatch(/`(?:cwd|pty|async|path|recency|multi|recommended)`|:raw\b/);
		}
	});

	it("state omp's Bash timeouts in milliseconds", () => {
		const bash = new BashTool(toolSession(CLAUDE_CODE_MODEL));
		expect(bash.description).toContain(
			`\`timeout\` is in milliseconds: default ${TOOL_TIMEOUTS.bash.default * 1000}, max ${TOOL_TIMEOUTS.bash.max * 1000}.`,
		);
	});

	it("leave omp's native descriptions alone off the profile", () => {
		const [read, bash, edit, write, ask, search] = fallbackTools(NATIVE_MODEL);
		expect(read!.description).toContain("Path suffixes");
		expect(bash!.description).toContain("`cwd`, not `cd`");
		expect(edit!.description).not.toContain("Strip the Read line prefix");
		expect(write!.description).toContain("`edit`");
		expect(ask!.description).toContain("`recommended`");
		expect(search!.description).toContain("site:");
	});
});
