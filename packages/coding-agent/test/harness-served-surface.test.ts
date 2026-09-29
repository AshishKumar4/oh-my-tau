import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Model, type TSchema, toolWireSchema } from "@oh-my-pi/pi-ai";
import { claudeCodeSystemInstruction } from "@oh-my-pi/pi-ai/providers/claude-code-fingerprint";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import {
	CLAUDE_CODE_SURFACE_EDITS,
	HARNESS_CAPTURE_SCHEMA,
	projectHarnessCapture,
	type SurfaceEdit,
	type VendorTool,
} from "@oh-my-pi/pi-coding-agent/harness/capture";
import { harnessFacade } from "@oh-my-pi/pi-coding-agent/harness/facade";
import { harnessFacadeSpecs } from "@oh-my-pi/pi-coding-agent/harness/facades";
import { harnessWireRenames } from "@oh-my-pi/pi-coding-agent/harness/manifest";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { TOOL_TIMEOUTS } from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { WebSearchTool } from "@oh-my-pi/pi-coding-agent/web/search";
import { isRecord } from "@oh-my-pi/pi-utils";

/** Declarations served from the capture under omp's bridged tools; the facades serve omp-owned text. */
const CAPTURE_SERVED_TOOLS = ["Read", "Bash", "Edit", "Write", "AskUserQuestion", "WebSearch"] as const;

/**
 * Every tool name Claude Code declares: the 2.1.284 main surface, what 2.1.269
 * declared besides, the legacy-model task tools, and other builds' names.
 */
const CLAUDE_CODE_TOOL_NAMES = [
	"Agent",
	"Artifact",
	"ArtifactComments",
	"ArtifactData",
	"AskUserQuestion",
	"Bash",
	"CronCreate",
	"CronDelete",
	"CronList",
	"DesignSync",
	"Edit",
	"EndConversation",
	"EnterPlanMode",
	"EnterWorktree",
	"ExitPlanMode",
	"ExitWorktree",
	"ListAgents",
	"Monitor",
	"NotebookEdit",
	"PushNotification",
	"Read",
	"RemoteTrigger",
	"ReportFindings",
	"ScheduleWakeup",
	"SendFeedback",
	"SendMessage",
	"Skill",
	"TaskStop",
	"WebFetch",
	"WebSearch",
	"Workflow",
	"Write",
	"TaskOutput",
	"WaitForMcpServers",
	"TaskCreate",
	"TaskGet",
	"TaskList",
	"TaskUpdate",
	"TodoWrite",
	"Grep",
	"Glob",
	"MultiEdit",
	"NotebookRead",
	"BashOutput",
	"KillShell",
];

const FORBIDDEN_PHRASES = ["not available", "not supported in this build", "[redacted-session-path]", "<total_tokens>"];

/**
 * Claude Code names omp serves for a recording declaring `declared`: the
 * manifest's renames and the facades. TaskOutput mounts only for a recording
 * that declares it.
 */
function unservedToolNames(declared: readonly string[]): string[] {
	const served = new Set([
		...Object.values(harnessWireRenames("claude-code")),
		...harnessFacadeSpecs("claude-code")
			.map(spec => spec.wireName)
			.filter(name => name !== "TaskOutput" || declared.includes("TaskOutput")),
	]);
	return [...new Set([...CLAUDE_CODE_TOOL_NAMES, ...declared])].filter(name => !served.has(name)).sort();
}

function namedTools(text: string, names: readonly string[]): string[] {
	return names.filter(name => new RegExp(`\\b${name}\\b`).test(text));
}

function forbiddenPhrases(text: string): string[] {
	return FORBIDDEN_PHRASES.filter(phrase => text.includes(phrase));
}

function schemaProperties(schema: TSchema | undefined): Record<string, { description?: string }> {
	const properties = isRecord(schema) ? schema.properties : undefined;
	return isRecord(properties) ? (properties as Record<string, { description?: string }>) : {};
}

function schemaRequired(schema: TSchema | undefined): unknown[] {
	return isRecord(schema) && Array.isArray(schema.required) ? schema.required : [];
}

/** A tool's served text: its description and wire schema. */
function servedToolText(tool: { readonly name: string; readonly description: string; readonly parameters: TSchema }) {
	return `${tool.description}\n${JSON.stringify(toolWireSchema({ name: tool.name, description: "", parameters: tool.parameters }))}`;
}

interface ServedCapture {
	readonly text: string;
	readonly tools: Readonly<Record<string, VendorTool>>;
	readonly unmatchedEdits: readonly string[];
}

function project(raw: unknown, label: string): ServedCapture {
	const projection = projectHarnessCapture("claude-code", raw);
	if (!projection.ok) throw new Error(`${label} rejected: ${projection.reason}`);
	return projection;
}

/** Everything a capture puts on the wire under omp: the instructions and the bridged declarations. */
function servedTexts(capture: ServedCapture, label: string): Array<{ where: string; text: string }> {
	return [
		{ where: `${label} prompt`, text: capture.text },
		...CAPTURE_SERVED_TOOLS.map(name => {
			const tool = capture.tools[name];
			if (tool === undefined) throw new Error(`${label} declares no ${name}`);
			return { where: `${label} ${name}`, text: `${tool.description}\n${JSON.stringify(tool.inputSchema ?? {})}` };
		}),
	];
}

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}

type PresentFacades = (vendor: (wireName: string) => VendorTool | undefined) => AgentTool[];

/**
 * Presents the seven claude-code facades as a session does, each handed
 * `vendor` as the capture's declaration of its wire name. The Agent facade
 * renders the task tool's live roster over omp's bundled agents.
 */
async function facadePresenter(): Promise<PresentFacades> {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: loadBundledAgents(),
		projectAgentsDir: null,
	});
	const settings = Settings.isolated();
	const session = {
		cwd: path.join(os.tmpdir(), "omp-served-surface-agents"),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
	const task = (await TaskTool.create(session)) as unknown as AgentTool;
	return vendor =>
		harnessFacadeSpecs("claude-code").map(spec =>
			harnessFacade(spec.target === "task" ? task : stubTool(spec.target), spec, { settings, session }, () =>
				vendor(spec.wireName),
			),
		);
}

const SYNTHETIC_BILLING_BLOCK = "x-anthropic-billing-header: cc_version=2.1.284.syn; cc_entrypoint=cli;";

/** The recorded claim an edit anchors on, with a marker the test finds again after projection. */
function syntheticClaim(edit: SurfaceEdit): string | undefined {
	if ("find" in edit) return `[${edit.id}]${edit.find}[/${edit.id}]`;
	if ("line" in edit) return `${edit.line}(${edit.id} claim)`;
	// The recording machine's memory path rides along, as in a real capture.
	if ("section" in edit)
		return `${edit.section}\n\n(${edit.id} claim) Memory lives at /home/recorder/.claude/memory/.`;
	return undefined;
}

/**
 * A capture that carries every edit's anchor, around text no edit touches:
 * synthetic, so no recorded vendor text beyond the anchors lives in the repo.
 */
function syntheticCapture(): Record<string, unknown> {
	const claimsFor = (target: string) =>
		CLAUDE_CODE_SURFACE_EDITS.filter(edit => edit.target === target).flatMap(edit => syntheticClaim(edit) ?? []);
	const prompt = [
		"You are a synthetic agent.",
		"",
		"# Kept before",
		"Kept prompt line.",
		...claimsFor("prompt").filter(claim => !claim.startsWith("# ")),
		"",
		...claimsFor("prompt").filter(claim => claim.startsWith("# ")),
		"",
		"# Kept after",
		"Kept closing line.",
	].join("\n");
	const declarations = CAPTURE_SERVED_TOOLS.map(name => {
		const properties: Record<string, unknown> = { kept: { type: "string", description: "Kept." } };
		for (const edit of CLAUDE_CODE_SURFACE_EDITS) {
			if (edit.target === name && "property" in edit) {
				properties[edit.property] = { type: "string", description: `(${edit.id} claim)` };
			}
		}
		return {
			name,
			description: [`Kept ${name} line.`, ...claimsFor(name)].join("\n"),
			input_schema: { type: "object", properties, required: Object.keys(properties) },
		};
	});
	return {
		schema: HARNESS_CAPTURE_SCHEMA,
		profile: "claude-code",
		clientVersion: "2.1.284.syn",
		entrypoint: "cli",
		capturedAt: "2026-09-29T00:00:00.000Z",
		model: "claude-opus-5-5",
		instructions: [SYNTHETIC_BILLING_BLOCK, claudeCodeSystemInstruction, prompt],
		tools: [...CAPTURE_SERVED_TOOLS, "Monitor", "EnterPlanMode"],
		declarations,
	};
}

describe("served Claude Code surface edits", () => {
	const served = project(syntheticCapture(), "synthetic");
	const targetText = (target: string) =>
		target === "prompt" ? served.text : (served.tools[target]?.description ?? "");

	it("finds every edit's anchor in a capture that carries them all", () => {
		expect(served.unmatchedEdits).toEqual([]);
	});

	it("replaces or removes each recorded claim and keeps the text around it", () => {
		for (const edit of CLAUDE_CODE_SURFACE_EDITS) {
			const text = targetText(edit.target);
			if ("find" in edit) {
				expect(text, edit.id).toContain(`[${edit.id}]${edit.replace ?? ""}[/${edit.id}]`);
			} else if ("line" in edit) {
				expect(text, edit.id).not.toContain(`(${edit.id} claim)`);
				if (edit.replace !== undefined) expect(text.split("\n"), edit.id).toContain(edit.replace);
			} else if ("section" in edit) {
				expect(text.split("\n"), edit.id).not.toContain(edit.section);
				expect(text, edit.id).not.toContain(`(${edit.id} claim)`);
			} else {
				const schema = served.tools[edit.target]?.inputSchema;
				if (edit.description === undefined) {
					expect(Object.keys(schemaProperties(schema)), edit.id).not.toContain(edit.property);
					expect(schemaRequired(schema), edit.id).not.toContain(edit.property);
				} else {
					expect(schemaProperties(schema)[edit.property]?.description, edit.id).toBe(edit.description);
					expect(schemaRequired(schema), edit.id).toContain(edit.property);
				}
			}
		}
		expect(served.text).toStartWith("You are a synthetic agent.\n\n# Kept before\nKept prompt line.\n");
		expect(served.text).toEndWith("\n\n# Kept after\nKept closing line.");
		for (const name of CAPTURE_SERVED_TOOLS) {
			expect(served.tools[name]?.description, name).toStartWith(`Kept ${name} line.`);
			expect(schemaProperties(served.tools[name]?.inputSchema).kept?.description, name).toBe("Kept.");
		}
	});

	it("states omp's Bash timeouts", () => {
		const defaultMs = TOOL_TIMEOUTS.bash.default * 1000;
		const maxMs = TOOL_TIMEOUTS.bash.max * 1000;
		expect(served.tools.Bash?.description).toContain(
			`- \`timeout\` is in milliseconds: default ${defaultMs}, max ${maxMs}.`,
		);
		expect(schemaProperties(served.tools.Bash?.inputSchema).timeout?.description).toBe(
			`Optional timeout in milliseconds (max ${maxMs})`,
		);
	});

	it("serves no unavailability note, token budget, recording path or unserved tool name", () => {
		for (const { where, text } of servedTexts(served, "synthetic")) {
			expect(forbiddenPhrases(text), where).toEqual([]);
			expect(namedTools(text, unservedToolNames([])), where).toEqual([]);
		}
	});

	it("projects a capture to the same bytes every time without touching the parsed capture", () => {
		const raw = syntheticCapture();
		const before = JSON.stringify(raw);
		const first = projectHarnessCapture("claude-code", raw);
		expect(JSON.stringify(projectHarnessCapture("claude-code", raw))).toBe(JSON.stringify(first));
		expect(JSON.stringify(raw)).toBe(before);
	});
});

describe("claude-code facades", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("serve omp's own text over a capture's declaration and name only served tools", async () => {
		const vendor: VendorTool = {
			description: "Vendor text: use Monitor or TodoWrite; channel is not available in this build.",
			inputSchema: {
				type: "object",
				properties: { channel: { type: "string", description: "Not available in this build" } },
			},
		};
		const facades = (await facadePresenter())(() => vendor);
		expect(facades.map(facade => facade.name).sort()).toEqual(
			["Agent", "ListAgents", "SendMessage", "Skill", "TaskOutput", "TaskStop", "WebFetch"].sort(),
		);
		for (const facade of facades) {
			expect(facade.description, facade.name).not.toBe(vendor.description);
			expect(facade.parameters, facade.name).not.toBe(vendor.inputSchema);
			const text = servedToolText(facade);
			expect(forbiddenPhrases(text), facade.name).toEqual([]);
			expect(namedTools(text, unservedToolNames([])), facade.name).toEqual([]);
		}
	});
});

/**
 * Surface edits whose anchor a recording does not carry, by client release and
 * model: that build never made the claim. Every other edit must find its
 * anchor, so a recording that rewords a claim fails the local guard instead of
 * serving it, and a new recording has to be listed before it counts as covered.
 */
const ABSENT_ANCHORS: Readonly<Record<string, readonly string[]>> = {
	"2.1.269/claude-opus-5": ["prompt.pasted-content", "prompt.token-budget"],
	"2.1.269/claude-fable-5-1": ["prompt.pasted-content", "prompt.agent-restraint", "prompt.token-budget"],
	"2.1.284/claude-opus-5-5": ["prompt.agent-restraint"],
	"2.1.284/claude-fable-5-1": ["prompt.agent-restraint"],
};

describe("absent-anchor table", () => {
	const ids = CLAUDE_CODE_SURFACE_EDITS.map(edit => edit.id);

	it("names only edits that exist", () => {
		for (const [recording, absent] of Object.entries(ABSENT_ANCHORS)) {
			for (const id of absent) expect(ids, recording).toContain(id);
		}
	});

	it("keeps no edit that no listed recording anchors", () => {
		for (const id of ids) {
			expect(
				Object.values(ABSENT_ANCHORS).some(absent => !absent.includes(id)),
				id,
			).toBe(true);
		}
	});
});

interface Recording extends ServedCapture {
	readonly name: string;
	readonly key: string;
	readonly declared: readonly string[];
}

/**
 * Claude Code captures the recorder wrote (`omp auth-gateway serve --record-harness`),
 * read from `OMP_HARNESS_CAPTURE_DIR`. Recorded vendor text is proprietary and
 * never committed, so the guard over real recordings runs only where they exist.
 */
async function loadRecordings(dir: string | undefined): Promise<Recording[]> {
	if (dir === undefined || dir.length === 0) return [];
	const names = (await fs.readdir(dir)).filter(name => name.endsWith(".json")).sort();
	const recordings: Recording[] = [];
	for (const name of names) {
		const raw: unknown = await Bun.file(path.join(dir, name))
			.json()
			.catch(() => undefined);
		// Raw request bodies and other profiles' captures share the directory.
		if (!isRecord(raw) || raw.profile !== "claude-code" || typeof raw.clientVersion !== "string") continue;
		const projection = projectHarnessCapture("claude-code", raw);
		if (!projection.ok) continue;
		const release = raw.clientVersion.split(".").slice(0, 3).join(".");
		recordings.push({
			...projection,
			name,
			key: `${release}/${typeof raw.model === "string" ? raw.model : "unknown"}`,
			declared: Array.isArray(raw.tools) ? raw.tools.filter(tool => typeof tool === "string") : [],
		});
	}
	return recordings;
}

const RECORDINGS = await loadRecordings(Bun.env.OMP_HARNESS_CAPTURE_DIR);

describe("served surface over real recordings (local only)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.skipIf(RECORDINGS.length === 0)("finds every anchor each recording is listed to carry", () => {
		for (const recording of RECORDINGS) {
			const absent = ABSENT_ANCHORS[recording.key];
			expect(absent, `${recording.name}: list the anchors ${recording.key} lacks`).toBeDefined();
			expect([...recording.unmatchedEdits].sort(), recording.name).toEqual([...(absent ?? [])].sort());
		}
	});

	it.skipIf(RECORDINGS.length === 0)(
		"serves no unavailability note, token budget, recording path or unserved tool name",
		async () => {
			const presentFacades = await facadePresenter();
			for (const recording of RECORDINGS) {
				const unserved = unservedToolNames(recording.declared);
				for (const { where, text } of servedTexts(recording, recording.name)) {
					expect(forbiddenPhrases(text), where).toEqual([]);
					expect(namedTools(text, unserved), where).toEqual([]);
				}
				for (const facade of presentFacades(wireName => recording.tools[wireName])) {
					const where = `${recording.name} ${facade.name}`;
					const recorded = recording.tools[facade.name];
					if (recorded !== undefined) expect(facade.description, where).not.toBe(recorded.description);
					expect(forbiddenPhrases(servedToolText(facade)), where).toEqual([]);
					expect(namedTools(servedToolText(facade), unserved), where).toEqual([]);
				}
			}
		},
	);

	it.skipIf(RECORDINGS.length === 0)("drops the vendor claims from the instructions and keeps what omp backs", () => {
		for (const recording of RECORDINGS) {
			for (const removed of [
				"# Memory",
				"MEMORY.md",
				"/<skill-name>",
				"<pasted_content>",
				"claude.ai/code",
				"/fast",
				"Do not use the Agent tool",
			]) {
				expect(recording.text.includes(removed), `${recording.name}: ${removed}`).toBe(false);
			}
			expect(recording.text, recording.name).toContain("`! <command>`");
			expect(recording.text, recording.name).toContain("# Harness");
			expect(recording.text, recording.name).toContain("Model IDs");
		}
	});

	it.skipIf(RECORDINGS.length === 0)("serves omp's behaviour for the bridged tools", () => {
		const maxMs = TOOL_TIMEOUTS.bash.max * 1000;
		for (const { name, tools } of RECORDINGS) {
			const read = tools.Read!;
			expect(Object.keys(schemaProperties(read.inputSchema)), name).toEqual(["file_path", "offset", "limit"]);
			expect(read.description, name).toContain("returns a structural summary");
			expect(read.description, name).not.toContain("2000 lines");
			const bash = tools.Bash!;
			expect(Object.keys(schemaProperties(bash.inputSchema)), name).toEqual([
				"command",
				"timeout",
				"description",
				"run_in_background",
			]);
			expect(bash.description, name).toContain(`max ${maxMs}.`);
			expect(bash.description, name).not.toContain("sleep` is blocked");
			expect(bash.description, name).not.toContain("attribution");
			expect(tools.Edit!.description, name).not.toContain("You must Read the file");
			expect(tools.Write!.description, name).not.toContain("will fail");
			expect(tools.AskUserQuestion!.description, name).not.toContain("Plan mode note");
			expect(tools.AskUserQuestion!.description, name).not.toContain("side-by-side");
			expect(Object.keys(schemaProperties(tools.AskUserQuestion!.inputSchema)), name).toEqual(["questions"]);
			expect(tools.WebSearch!.description, name).not.toMatch(
				/\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/,
			);
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
		const unserved = unservedToolNames([]);
		for (const tool of fallbackTools(CLAUDE_CODE_MODEL)) {
			const text = servedToolText(tool);
			expect(forbiddenPhrases(text), tool.name).toEqual([]);
			expect(namedTools(text, unserved), tool.name).toEqual([]);
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
