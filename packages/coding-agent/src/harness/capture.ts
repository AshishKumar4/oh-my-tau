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

export const HARNESS_CAPTURE_SCHEMA = 1;

const HARNESS_ENTRYPOINTS: Readonly<Record<HarnessProfile, readonly string[]>> = {
	"claude-code": [claudeCodeEntrypoint],
	codex: ["codex_exec"],
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
	return {
		ok: true,
		text: blocks.join("\n\n"),
		clientVersion: capture.clientVersion,
		capturedAt: Number.isNaN(capturedAt) ? 0 : capturedAt,
		tools,
		...(capture.model === undefined ? {} : { model: capture.model }),
	};
}

const resolvedPrompts = new Map<string, Promise<HarnessPrompt | null>>();
const servedPrompts = new Map<string, HarnessPrompt>();

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

export function loadHarnessPrompt(profile: HarnessProfile, modelId?: string): Promise<HarnessPrompt | null> {
	const key = promptCacheKey(profile, modelId);
	const cached = resolvedPrompts.get(key);
	if (cached) return cached;
	const pending = readHarnessPrompt(profile, normalizeModelKey(modelId)).then(prompt => {
		if (prompt !== null) servedPrompts.set(key, prompt);
		return prompt;
	});
	resolvedPrompts.set(key, pending);
	return pending;
}

export function servedHarnessPrompt(model: Model | undefined): HarnessPrompt | undefined {
	if (model === undefined || servedPrompts.size === 0) return undefined;
	const profile = resolveHarnessProfile(model);
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
