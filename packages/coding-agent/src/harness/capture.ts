import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { Model, TJsonSchema } from "@oh-my-pi/pi-ai";
import {
	claudeCodeBillingHeaderPrefix,
	claudeCodeEntrypoint,
	claudeCodeSystemInstruction,
} from "@oh-my-pi/pi-ai/providers/claude-code-fingerprint";
import { type HarnessProfile, resolveHarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { getHarnessCacheDir, isEnoent, isRecord, logger } from "@oh-my-pi/pi-utils";
// pi system prompt adapted for OMP from the MIT-licensed pi coding agent
// (https://github.com/earendil-works/pi), Copyright (c) 2025 Mario Zechner.
// See THIRD-PARTY-NOTICES.txt.
import bundledPiPrompt from "../prompts/harness/pi.md" with { type: "text" };
import { TOOL_TIMEOUTS } from "../tools/tool-timeouts";

export const HARNESS_CAPTURE_SCHEMA = 1;

// `pi` is never recorded — its prompt ships bundled, not captured — but the
// table keys every profile so a stray hand-placed capture is still rejected.
const HARNESS_ENTRYPOINTS: Readonly<Record<HarnessProfile, readonly string[]>> = {
	"claude-code": [claudeCodeEntrypoint],
	codex: ["codex_exec"],
	pi: [],
};

interface WireOwnedLeading {
	readonly linePrefixes: readonly string[];
	readonly lines: readonly string[];
	readonly identityBlock: boolean;
}

const WIRE_OWNED_LEADING: Readonly<Record<HarnessProfile, WireOwnedLeading>> = {
	"claude-code": {
		linePrefixes: [claudeCodeBillingHeaderPrefix],
		lines: [claudeCodeSystemInstruction],
		identityBlock: true,
	},
	codex: { linePrefixes: [], lines: [], identityBlock: false },
	pi: { linePrefixes: [], lines: [], identityBlock: false },
};

export const AMBIENT_CONTAINMENT_MIN_CHARS = 64;

const captureSchema = type({
	schema: "number",
	profile: "string",
	clientVersion: "string",
	entrypoint: "string",
	"capturedAt?": "string",
	"model?": "string",
	instructions: "string[]",
	tools: "string[]",
	// Full declarations as the vendor client sent them: the description is what
	// a bridged tool presents under the profile, so the model reads the vendor's
	// own words for `Read`/`Bash`/`Agent` rather than omp's. Optional so
	// captures recorded before declarations were kept still serve their prompt.
	"declarations?": [{ name: "string", description: "string", "input_schema?": "unknown" }, "[]"],
	"ambient?": "string[]",
	"fallback?": "unknown",
});

export type HarnessCapture = typeof captureSchema.infer;

/** One tool as the vendor client declared it. */
export interface VendorTool {
	readonly description: string;
	readonly inputSchema?: TJsonSchema;
}

export interface HarnessPrompt {
	readonly text: string;
	readonly clientVersion: string;
	readonly path: string;
	/** Vendor declarations by wire name; empty for captures that recorded names only. */
	readonly tools: Readonly<Record<string, VendorTool>>;
}

type CaptureProjection =
	| {
			readonly ok: true;
			readonly text: string;
			readonly clientVersion: string;
			readonly capturedAt: number;
			readonly model?: string;
			readonly tools: Readonly<Record<string, VendorTool>>;
			/** Ids of the profile's surface edits whose anchor this recording does not carry. */
			readonly unmatchedEdits: readonly string[];
	  }
	| { readonly ok: false; readonly reason: string };

function stripWireOwnedLines(block: string, wireOwned: WireOwnedLeading): string {
	let text = block;
	for (;;) {
		const trimmed = text.trimStart();
		const breakAt = trimmed.indexOf("\n");
		const line = (breakAt === -1 ? trimmed : trimmed.slice(0, breakAt)).trimEnd();
		const owned = wireOwned.lines.includes(line) || wireOwned.linePrefixes.some(prefix => line.startsWith(prefix));
		if (!owned) return text;
		if (breakAt === -1) return "";
		text = trimmed.slice(breakAt + 1);
	}
}

const SESSION_PATH_TOKEN =
	/(?<![A-Za-z0-9_:.])(?:\/(?:home|Users|root|data|tmp|var|private)(?:\/\S*)?|[A-Za-z]:[\\/]\S*|\\\\[^\s"'`]+)/g;

const REDACTED_SESSION_PATH = "[redacted-session-path]";

const TRAILING_FENCE = /[`'"')\]}.,;:!?]+$/;

function redactSessionPaths(block: string): string {
	return block.replace(SESSION_PATH_TOKEN, token => {
		const exposed = token.replace(TRAILING_FENCE, "");
		if (exposed.length === 0) return token;
		return `${REDACTED_SESSION_PATH}${token.slice(exposed.length)}`;
	});
}

function isAmbient(block: string, ambient: readonly string[]): boolean {
	for (const entry of ambient) {
		const needle = entry.trim();
		if (needle.length === 0) continue;
		if (block === needle) return true;
		if (needle.length >= AMBIENT_CONTAINMENT_MIN_CHARS && block.includes(needle)) return true;
	}
	return false;
}

/**
 * `encrypted: true` on a vendor property asks the backend to encrypt the
 * model's output for that field; omp's tools read the value themselves, so no
 * served schema carries the marker.
 */
function stripEncrypted(schema: Record<string, unknown>): Record<string, unknown> {
	const properties = schema.properties;
	if (!isRecord(properties)) return schema;
	const cleaned: Record<string, unknown> = {};
	for (const [key, property] of Object.entries(properties)) {
		if (isRecord(property) && property.encrypted === true) {
			const { encrypted: _encrypted, ...rest } = property;
			cleaned[key] = rest;
		} else cleaned[key] = property;
	}
	return { ...schema, properties: cleaned };
}

/**
 * One verbatim edit to the surface a capture serves. A recording is the vendor
 * client's text about the vendor client's features, and omp serves it as its
 * own: a sentence about something omp lacks is removed — never replaced with a
 * "not available" note — and one that misstates omp's behaviour is rewritten
 * to state it. Anchors are recorded text, so the capture guard fails as soon
 * as a recording stops carrying one, instead of a new capture quietly bringing
 * the claim back.
 */
export type SurfaceEdit = {
	/** Stable name the capture guard reports. */
	readonly id: string;
	/** `"prompt"` for the instructions; otherwise the wire name of a declaration. */
	readonly target: string;
} & (
	| {
			/** Recorded text, replaced by `replace` or removed. */
			readonly find: string;
			readonly replace?: string;
	  }
	| {
			/** Recorded start of a line; the whole line is replaced by `replace` or removed. */
			readonly line: string;
			readonly replace?: string;
	  }
	| {
			/** A top-level `# Heading` line, dropped together with its section. */
			readonly section: string;
	  }
	| {
			/** An input-schema property: its description rewritten, or the property dropped. */
			readonly property: string;
			readonly description?: string;
	  }
);

const BASH_TIMEOUT_DEFAULT_MS = TOOL_TIMEOUTS.bash.default * 1000;
const BASH_TIMEOUT_MAX_MS = TOOL_TIMEOUTS.bash.max * 1000;

/**
 * Claude Code's served surface measured against omp: the vendor instructions
 * (`prompt`) and the declarations of the tools omp bridges under Claude Code's
 * names.
 */
export const CLAUDE_CODE_SURFACE_EDITS: readonly SurfaceEdit[] = [
	// omp never wraps pastes in id-tagged `<pasted_content>` blocks.
	{ id: "prompt.pasted-content", target: "prompt", line: " - Text inside <pasted_content> tags " },
	// There is no user-invocable skills section; omp's slash form is the client-side `/skill:<name>`.
	{ id: "prompt.skill-slash-command", target: "prompt", line: " - When the user types `/<skill-name>`" },
	// Claude Code's file memory: a directory on the recording machine (the only
	// session path a recording carries) and a MEMORY.md index omp never loads.
	{ id: "prompt.memory", target: "prompt", section: "# Memory" },
	// Claims about the vendor client's other apps and its `/fast` toggle.
	{ id: "prompt.product-surfaces", target: "prompt", line: " - Claude Code is available as " },
	{ id: "prompt.fast-mode", target: "prompt", line: " - Fast mode for Claude Code " },
	// Contradicts orchestrating subagents; omp has no workflows or deep-research.
	{ id: "prompt.agent-restraint", target: "prompt", line: "Do not use the Agent tool, workflows, or deep-research " },
	// Claude Code's token-budget counter, a recorded literal omp does not keep up to date.
	{ id: "prompt.token-budget", target: "prompt", line: "<total_tokens>" },
	// `file_path` is handed to omp's read, which also opens the internal URLs
	// that tool results (`artifact://`) and the prompt footer (`rule://`) name.
	{
		id: "read.internal-urls",
		target: "Read",
		find: "- `file_path` must be an absolute path.",
		replace:
			"- `file_path` must be an absolute path, or an internal URL such as `artifact://<id>` or `rule://<name>` when a tool result or this prompt names one.",
	},
	// A bare read of code returns omp's structural summary (the token win is
	// kept); other reads stop at `read.defaultLimit` lines with a footer.
	{
		id: "read.default-window",
		target: "Read",
		line: "- Reads up to ",
		replace:
			"- Without `offset`/`limit`, a longer code file returns a structural summary: signatures stay, bodies are elided, and a footer gives the `offset`/`limit` that reads an elided range. Any other file returns its first lines, with a footer giving the `offset` to continue from when more remain.",
	},
	// PDFs convert to text; there is no page parameter.
	{
		id: "read.pdf-pages",
		target: "Read",
		find: 'Reads PDFs via the `pages` parameter (e.g. "1-5", max 20 pages/request; required for PDFs over 10 pages).',
		replace: "Reads PDFs as extracted text, paged with `offset`/`limit`.",
	},
	{ id: "read.pages", target: "Read", property: "pages" },
	// Notebooks render as cell sources only.
	{
		id: "read.notebook-outputs",
		target: "Read",
		find: "Reads Jupyter notebooks (.ipynb) as cells with outputs.",
		replace: "Reads Jupyter notebooks (.ipynb) as their cells' source, without outputs.",
	},
	{
		id: "read.special-paths",
		target: "Read",
		line: "- Reading a directory, ",
		replace:
			"- Reading a directory returns a listing of its entries. A missing file returns an error unless exactly one workspace file's path ends with the given path; that file is read instead, with a notice naming it. An empty file returns a notice rather than content.",
	},
	{
		id: "bash.timeout",
		target: "Bash",
		line: "- `timeout` is in milliseconds",
		replace: `- \`timeout\` is in milliseconds: default ${BASH_TIMEOUT_DEFAULT_MS}, max ${BASH_TIMEOUT_MAX_MS}.`,
	},
	{
		id: "bash.timeout-schema",
		target: "Bash",
		property: "timeout",
		description: `Optional timeout in milliseconds (max ${BASH_TIMEOUT_MAX_MS})`,
	},
	// omp does not intercept `sleep`, and Monitor is not served.
	{
		id: "bash.monitor",
		target: "Bash",
		find: " Foreground `sleep` is blocked; use Monitor with an until-loop to wait on a condition.",
	},
	// Nothing in omp injects an attribution reminder.
	{
		id: "bash.attribution",
		target: "Bash",
		line: "- End git commit messages and PR bodies with the attribution lines ",
	},
	// There is no sandbox to lift; approval is decided by the host.
	{ id: "bash.sandbox", target: "Bash", property: "dangerouslyDisableSandbox" },
	// Replace mode has no read-before-write gate.
	{ id: "edit.read-first", target: "Edit", line: "- You must Read the file in this conversation before editing" },
	{ id: "write.read-first", target: "Write", find: " Overwriting an existing file you haven't Read will fail." },
	// Neither EnterPlanMode nor ExitPlanMode is served.
	{ id: "ask.plan-mode", target: "AskUserQuestion", line: "Plan mode note: " },
	// omp renders a preview under its option, not in a side-by-side pane.
	{
		id: "ask.preview-layout",
		target: "AskUserQuestion",
		find: " When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right.",
	},
	// Host-filled fields no omp host fills.
	{ id: "ask.answers", target: "AskUserQuestion", property: "answers" },
	{ id: "ask.annotations", target: "AskUserQuestion", property: "annotations" },
	{ id: "ask.metadata", target: "AskUserQuestion", property: "metadata" },
	// Older clients recorded the month as a literal, stale a month later; the
	// date rides omp's first-turn reminder, as newer clients word it.
	{
		id: "websearch.current-month",
		target: "WebSearch",
		line: "- The current month is ",
		replace:
			"- The current month is (provided in the conversation below) — use this when searching for recent information.",
	},
];

const SURFACE_EDITS: Partial<Readonly<Record<HarnessProfile, readonly SurfaceEdit[]>>> = {
	"claude-code": CLAUDE_CODE_SURFACE_EDITS,
};

/**
 * Rewrites `text` line by line. A `null` rewrite drops the line, and a dropped
 * paragraph leaves one blank line between its neighbours and none at either end.
 */
function rewriteLines(text: string, rewrite: (line: string) => string | null): string {
	const lines = text.split("\n");
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const next = rewrite(lines[i]!);
		if (next !== null) {
			kept.push(next);
			continue;
		}
		const following = lines[i + 1];
		if (kept.length === 0) {
			if (following === "") i++;
		} else if (kept[kept.length - 1] === "" && (following === undefined || following === "")) {
			kept.pop();
		}
	}
	return kept.join("\n");
}

/** `text` without its top-level `heading` section, or `undefined` when it has none. */
function dropSection(text: string, heading: string): string | undefined {
	const lines = text.split("\n");
	let fenced = false;
	let start = -1;
	let end = lines.length;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.startsWith("```")) {
			fenced = !fenced;
		} else if (!fenced && line.startsWith("# ")) {
			if (start !== -1) {
				end = i;
				break;
			}
			if (line.trimEnd() === heading) start = i;
		}
	}
	if (start === -1) return undefined;
	// A closing section takes the blank lines before it along.
	let from = start;
	if (end === lines.length) while (from > 0 && lines[from - 1] === "") from--;
	return [...lines.slice(0, from), ...lines.slice(end)].join("\n");
}

/** `text` with a text edit applied, or `undefined` when `text` lacks its anchor. */
function editText(text: string, edit: SurfaceEdit): string | undefined {
	if ("find" in edit) return text.includes(edit.find) ? text.split(edit.find).join(edit.replace ?? "") : undefined;
	if ("line" in edit) {
		if (!text.split("\n").some(line => line.startsWith(edit.line))) return undefined;
		return rewriteLines(text, line => (line.startsWith(edit.line) ? (edit.replace ?? null) : line));
	}
	if ("section" in edit) return dropSection(text, edit.section);
	return undefined;
}

function editSchema(
	schema: TJsonSchema | undefined,
	edit: { readonly property: string; readonly description?: string },
): TJsonSchema | undefined {
	const properties = schema?.properties;
	if (schema === undefined || !isRecord(properties) || !(edit.property in properties)) return undefined;
	if (edit.description !== undefined) {
		const property = properties[edit.property];
		return {
			...schema,
			properties: {
				...properties,
				[edit.property]: { ...(isRecord(property) ? property : {}), description: edit.description },
			},
		};
	}
	const { [edit.property]: _dropped, ...kept } = properties;
	const required = Array.isArray(schema.required)
		? { required: schema.required.filter(name => name !== edit.property) }
		: {};
	return { ...schema, properties: kept, ...required };
}

function editTool(tool: VendorTool, edit: SurfaceEdit): VendorTool | undefined {
	if ("property" in edit) {
		const inputSchema = editSchema(tool.inputSchema, edit);
		return inputSchema === undefined ? undefined : { ...tool, inputSchema };
	}
	const description = editText(tool.description, edit);
	return description === undefined ? undefined : { ...tool, description };
}

const LEADING_MARKER = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?/;
const SENTENCE_BREAK = /(?<=[.!?])\s+/;

/**
 * Drops every sentence that still carries a redacted recording-session path:
 * the path belonged to the recording machine, so whatever the sentence says
 * about it is not true of this session.
 */
function dropRedactedSentences(text: string): string {
	if (!text.includes(REDACTED_SESSION_PATH)) return text;
	return rewriteLines(text, line => {
		if (!line.includes(REDACTED_SESSION_PATH)) return line;
		const marker = LEADING_MARKER.exec(line)?.[0] ?? "";
		const kept = line
			.slice(marker.length)
			.split(SENTENCE_BREAK)
			.filter(sentence => !sentence.includes(REDACTED_SESSION_PATH));
		return kept.length === 0 ? null : `${marker}${kept.join(" ")}`;
	});
}

interface ServedSurface {
	readonly text: string;
	readonly tools: Readonly<Record<string, VendorTool>>;
	readonly unmatched: readonly string[];
}

/**
 * The surface `profile` serves from a capture: its edits applied once, when the
 * capture loads. The result is a pure function of the recording, so every
 * request and every process serves the same bytes.
 */
function editServedSurface(
	profile: HarnessProfile,
	text: string,
	tools: Readonly<Record<string, VendorTool>>,
): ServedSurface {
	const edits = SURFACE_EDITS[profile];
	if (edits === undefined) return { text, tools, unmatched: [] };
	let prompt = text;
	const served: Record<string, VendorTool> = { ...tools };
	const unmatched: string[] = [];
	for (const edit of edits) {
		if (edit.target === "prompt") {
			const next = editText(prompt, edit);
			if (next === undefined) unmatched.push(edit.id);
			else prompt = next;
			continue;
		}
		const tool = served[edit.target];
		const next = tool === undefined ? undefined : editTool(tool, edit);
		if (next === undefined) unmatched.push(edit.id);
		else served[edit.target] = next;
	}
	return { text: dropRedactedSentences(prompt), tools: served, unmatched };
}

export function projectHarnessCapture(profile: HarnessProfile, raw: unknown): CaptureProjection {
	const capture = captureSchema(raw);
	if (capture instanceof type.errors) return { ok: false, reason: capture.summary };
	if (capture.schema !== HARNESS_CAPTURE_SCHEMA) return { ok: false, reason: "schema-mismatch" };
	if (capture.profile !== profile) return { ok: false, reason: "profile-mismatch" };
	if (!HARNESS_ENTRYPOINTS[profile].includes(capture.entrypoint)) return { ok: false, reason: "entrypoint-mismatch" };
	if (capture.fallback !== undefined && capture.fallback !== null) return { ok: false, reason: "fallback-marker" };
	if (capture.clientVersion.trim().length === 0) return { ok: false, reason: "client-version-empty" };
	if (capture.tools.every(tool => tool.trim().length === 0)) return { ok: false, reason: "tools-empty" };
	const wireOwned = WIRE_OWNED_LEADING[profile];
	const ambient = capture.ambient ?? [];
	const blocks: string[] = [];
	let leading = true;
	let afterBillingHeader = false;
	for (const instruction of capture.instructions) {
		const text = leading ? stripWireOwnedLines(instruction, wireOwned) : instruction;
		const compared = text.trim();
		if (compared.length === 0) {
			afterBillingHeader =
				leading && wireOwned.linePrefixes.some(prefix => instruction.trimStart().startsWith(prefix));
			continue;
		}
		if (afterBillingHeader && wireOwned.identityBlock && !compared.includes("\n")) {
			afterBillingHeader = false;
			continue;
		}
		afterBillingHeader = false;
		if (isAmbient(compared, ambient)) continue;
		leading = false;
		const scrubbed = redactSessionPaths(text);
		blocks.push(scrubbed);
	}
	if (blocks.length === 0) return { ok: false, reason: "instructions-empty" };
	const capturedAt = capture.capturedAt === undefined ? Number.NaN : Date.parse(capture.capturedAt);
	const tools: Record<string, VendorTool> = {};
	for (const { name, description, input_schema } of capture.declarations ?? []) {
		if (description.trim().length === 0) continue;
		tools[name] = { description, ...(isRecord(input_schema) ? { inputSchema: stripEncrypted(input_schema) } : {}) };
	}
	const surface = editServedSurface(profile, blocks.join("\n\n"), tools);
	if (surface.text.trim().length === 0) return { ok: false, reason: "instructions-empty" };
	return {
		ok: true,
		text: surface.text,
		clientVersion: capture.clientVersion,
		capturedAt: Number.isNaN(capturedAt) ? 0 : capturedAt,
		tools: surface.tools,
		unmatchedEdits: surface.unmatched,
		...(capture.model === undefined ? {} : { model: capture.model }),
	};
}

const resolvedPrompts = new Map<string, Promise<HarnessPrompt | null>>();
const servedPrompts = new Map<string, HarnessPrompt>();

/**
 * pi's prompt ships in the binary rather than in a recorded capture: pi is a
 * local open-source harness whose system prompt is a small static skeleton,
 * so there is nothing to fingerprint and record. The bundled file carries a
 * `{{cwd}}` placeholder (the one per-environment scalar pi injects) rendered
 * at build time; serving shares the capture pipeline's cache and served maps
 * so downstream consumers (`servedHarnessPrompt`, vendor tool declarations)
 * are unchanged.
 */
const BUNDLED_PROMPTS: Partial<Readonly<Record<HarnessProfile, string>>> = {
	pi: bundledPiPrompt.trim(),
};

/**
 * Callers hand over anything from a bare catalog id to a `provider/id`
 * selector, and a capture records whatever the vendor client sent. Compare the
 * trailing segment so the two always meet, instead of missing silently and
 * falling back to another model's text.
 */
function normalizeModelKey(model: string | undefined): string | undefined {
	if (model === undefined) return undefined;
	const slash = model.lastIndexOf("/");
	return slash === -1 ? model : model.slice(slash + 1);
}

function promptCacheKey(profile: HarnessProfile, modelId: string | undefined): string {
	return `${profile}\u0000${normalizeModelKey(modelId) ?? ""}`;
}

/**
 * The prompt `profile` serves as block 0. Recorded profiles read the newest
 * valid capture (exact-model first, then profile-wide); a bundled profile
 * skips the capture directory entirely — its text ships with the binary.
 */
export function loadHarnessPrompt(profile: HarnessProfile, modelId?: string): Promise<HarnessPrompt | null> {
	const key = promptCacheKey(profile, modelId);
	const cached = resolvedPrompts.get(key);
	if (cached) return cached;
	const bundled = BUNDLED_PROMPTS[profile];
	const pending =
		bundled === undefined
			? readHarnessPrompt(profile, normalizeModelKey(modelId))
			: Promise.resolve<HarnessPrompt | null>({
					text: bundled,
					clientVersion: "bundled",
					path: `bundled:${profile}`,
					tools: {},
				});
	const tracked = pending.then(prompt => {
		if (prompt !== null) servedPrompts.set(key, prompt);
		return prompt;
	});
	resolvedPrompts.set(key, tracked);
	return tracked;
}

/**
 * The loaded capture serving `model`. An omitted (`undefined`) `override`
 * resolves the model's catalog profile; `null` means no profile. Session
 * callers pass `effectiveHarnessProfile(...) ?? null`: `harness.mode: native`
 * yields `undefined` there, which must not fall back to the catalog.
 */
export function servedHarnessPrompt(
	model: Model | undefined,
	override?: HarnessProfile | null,
): HarnessPrompt | undefined {
	if (model === undefined || servedPrompts.size === 0) return undefined;
	const profile = override === undefined ? resolveHarnessProfile(model) : (override ?? undefined);
	if (profile === undefined) return undefined;
	return servedPrompts.get(promptCacheKey(profile, model.id)) ?? servedPrompts.get(promptCacheKey(profile, undefined));
}

export function resetHarnessPromptCache(): void {
	resolvedPrompts.clear();
	servedPrompts.clear();
}

// Non-greedy to the clause break, not to the first period: display names carry
// dotted versions ("Claude Fable 5.1"), and truncating to "Claude Fable 5"
// would never match the catalog name, dropping the paragraph even for a capture
// recorded on the serving model.
const MODEL_IDENTITY_SENTENCE = /This iteration of Claude is (Claude [^,]+?)(?:,|\.(?:\s|$))/;

/**
 * The vendor prompt opens with a paragraph naming the model the recording ran
 * on ("This iteration of Claude is Claude Fable 5.1, the newest model…"), so
 * replaying one model's capture to another asserts the wrong identity — which
 * is what an Opus session reading a Fable recording saw.
 *
 * A capture recorded on the serving model is already correct. Otherwise the
 * paragraph is dropped rather than rewritten: its remaining sentences are
 * claims about that specific model ("part of the Mythos-class model tier that
 * sits above Claude Opus"), so substituting the name would leave the model
 * reading falsehoods about itself. Only that paragraph goes; the rest of the
 * vendor text, including the model-id reference table elsewhere in the prompt,
 * stays byte-identical. Record a capture per model to keep the paragraph.
 */
function alignModelIdentity(text: string, servingModelId: string | undefined): string {
	const recorded = MODEL_IDENTITY_SENTENCE.exec(text)?.[1];
	if (recorded === undefined) return text;
	const servingName = servingModelId === undefined ? undefined : getBundledModel("anthropic", servingModelId)?.name;
	if (servingName !== undefined && recorded === servingName) return text;
	const paragraphs = text.split("\n\n");
	const kept = paragraphs.filter(paragraph => !MODEL_IDENTITY_SENTENCE.test(paragraph));
	return kept.length === paragraphs.length ? text : kept.join("\n\n");
}

async function readHarnessPrompt(profile: HarnessProfile, modelId?: string): Promise<HarnessPrompt | null> {
	const dir = path.join(getHarnessCacheDir(), profile);
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (error) {
		logger.debug("No harness capture directory; using omp's native prompt", {
			profile,
			dir,
			...(isEnoent(error) ? {} : { error: String(error) }),
		});
		return null;
	}
	const files = names.filter(name => name.endsWith(".json")).sort();
	let best: HarnessPrompt | undefined;
	let bestCapturedAt = 0;
	let bestExact = false;
	for (const name of files) {
		const file = path.join(dir, name);
		let raw: unknown;
		try {
			raw = await Bun.file(file).json();
		} catch (error) {
			logger.debug("Harness capture unreadable; ignoring it", { profile, file, error: String(error) });
			continue;
		}
		const projection = projectHarnessCapture(profile, raw);
		if (!projection.ok) {
			logger.debug("Harness capture rejected; ignoring it", { profile, file, reason: projection.reason });
			continue;
		}
		if (projection.unmatchedEdits.length > 0) {
			logger.debug("Harness capture lacks the anchors of some served-surface edits", {
				profile,
				file,
				unmatched: projection.unmatchedEdits,
			});
		}
		// A capture recorded on the serving model beats every other candidate,
		// however recent: it is the only one whose vendor text already names the
		// right model. Among equally-matching candidates the newest wins.
		const exact = modelId !== undefined && normalizeModelKey(projection.model) === modelId;
		if (
			best !== undefined &&
			((bestExact && !exact) || (bestExact === exact && projection.capturedAt <= bestCapturedAt))
		) {
			continue;
		}
		const text = alignModelIdentity(projection.text, modelId);
		best = { text, clientVersion: projection.clientVersion, path: file, tools: projection.tools };
		bestCapturedAt = projection.capturedAt;
		bestExact = exact;
	}
	if (best === undefined) {
		logger.debug("No valid harness capture; using omp's native prompt", { profile, dir, candidates: files.length });
		return null;
	}
	logger.debug("Serving the harness prompt from a cached capture", {
		profile,
		file: best.path,
		clientVersion: best.clientVersion,
		chars: best.text.length,
	});
	return best;
}
