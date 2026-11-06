import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AuthGatewayHarnessRequest } from "@oh-my-pi/pi-ai/auth-gateway";
import { claudeCodeBillingHeaderPrefix } from "@oh-my-pi/pi-ai/providers/claude-code-fingerprint";
import type { HarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import { OPENAI_HEADERS } from "@oh-my-pi/pi-catalog/wire/codex";
import { getHarnessCacheDir, isEexist, isRecord, logger, stringProperty } from "@oh-my-pi/pi-utils";
import {
	AMBIENT_CONTAINMENT_MIN_CHARS,
	HARNESS_CAPTURE_SCHEMA,
	type HarnessCapture,
	projectHarnessCapture,
} from "./capture";

const CODEX_FALLBACK_KEYS = ["instructions", "tools"] as const;

const CAPTURE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface CaptureFallback {
	readonly reason: string;
	readonly fields: readonly string[];
}

interface Derivation {
	readonly profile: HarnessProfile;
	readonly clientVersion: string;
	readonly entrypoint: string;
	/** The model the recording ran on; the vendor prompt names it, so replay is per-model. */
	readonly model?: string;
	readonly instructions: string[];
	readonly tools: string[];
	readonly declarations: ToolDeclaration[];
	readonly ambient: string[];
	readonly fallback?: CaptureFallback;
}

type ToolDeclaration = NonNullable<HarnessCapture["declarations"]>[number];

/**
 * Every tool declaration in `declarations`, flattening codex namespace groups
 * (`{ name, tools: [...] }`) to their leaves. Anthropic declares `input_schema`,
 * codex `parameters`; both are kept under one key so the reader has one shape.
 */
function toolDeclarations(declarations: readonly unknown[]): ToolDeclaration[] {
	return declarations.flatMap(declaration => {
		const nested = arrayField(declaration, "tools");
		if (nested !== undefined) return toolDeclarations(nested);
		const name = stringField(declaration, "name");
		if (name === undefined) return [];
		const description = stringField(declaration, "description") ?? "";
		const schema = isRecord(declaration) ? (declaration.input_schema ?? declaration.parameters) : undefined;
		return [{ name, description, ...(schema === undefined ? {} : { input_schema: schema }) }];
	});
}

function stringField(node: unknown, key: string): string | undefined {
	return isRecord(node) ? stringProperty(node, key) : undefined;
}

function arrayField(node: unknown, key: string): unknown[] | undefined {
	if (!isRecord(node)) return undefined;
	const value = node[key];
	return Array.isArray(value) ? value : undefined;
}

function stringFields(nodes: readonly unknown[], key: string): string[] {
	return nodes.flatMap(node => {
		const value = stringField(node, key);
		return value === undefined ? [] : [value];
	});
}

function textParts(node: unknown): string[] {
	const content = arrayField(node, "content");
	if (content !== undefined) return stringFields(content, "text");
	const text = stringField(node, "content");
	return text === undefined ? [] : [text];
}

function billingIdentity(block: string): { clientVersion: string; entrypoint: string } {
	let clientVersion = "";
	let entrypoint = "";
	for (const part of block.slice(claudeCodeBillingHeaderPrefix.length).split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		const key = part.slice(0, separator).trim();
		const value = part.slice(separator + 1).trim();
		if (key === "cc_version") clientVersion = value;
		else if (key === "cc_entrypoint") entrypoint = value;
	}
	return { clientVersion, entrypoint };
}

function deriveClaudeCode(body: unknown): Derivation | undefined {
	const system = arrayField(body, "system");
	if (system === undefined) return undefined;
	const instructions = stringFields(system, "text");
	const header = instructions
		.map(block => block.trimStart())
		.find(block => block.startsWith(claudeCodeBillingHeaderPrefix));
	if (header === undefined) return undefined;
	const identity = billingIdentity(header);
	const ambient = (arrayField(body, "messages") ?? [])
		.filter(message => stringField(message, "role") !== "assistant")
		.flatMap(textParts);
	const model = stringField(body, "model");
	return {
		profile: "claude-code",
		clientVersion: identity.clientVersion,
		entrypoint: identity.entrypoint,
		...(model === undefined ? {} : { model }),
		instructions,
		...toolSurface(arrayField(body, "tools") ?? []),
		ambient,
	};
}

/** The declared tools plus their names, which the reader keys on. */
function toolSurface(declared: readonly unknown[]): Pick<Derivation, "tools" | "declarations"> {
	const declarations = toolDeclarations(declared);
	return { tools: declarations.map(declaration => declaration.name), declarations };
}

function codexIdentity(headers: Headers): { clientVersion: string; entrypoint: string } | undefined {
	const entrypoint = headers.get(OPENAI_HEADERS.ORIGINATOR)?.trim();
	if (entrypoint === undefined || entrypoint.length === 0) return undefined;
	const declared = headers.get(OPENAI_HEADERS.VERSION)?.trim();
	const product = headers.get("user-agent")?.trim().split(" ")[0] ?? "";
	const separator = product.lastIndexOf("/");
	const fromUserAgent = separator > 0 ? product.slice(separator + 1) : "";
	return { clientVersion: declared !== undefined && declared.length > 0 ? declared : fromUserAgent, entrypoint };
}

function codexFallback(body: unknown): CaptureFallback | undefined {
	const fields = CODEX_FALLBACK_KEYS.filter(key => {
		const declarations = arrayField(body, key);
		if (declarations !== undefined) return declarations.length > 0;
		const text = stringField(body, key);
		return text !== undefined && text.trim().length > 0;
	});
	return fields.length === 0 ? undefined : { reason: "codex-fallback-metadata", fields };
}

function deriveCodex(body: unknown, headers: Headers): Derivation | undefined {
	const input = arrayField(body, "input");
	if (input === undefined) return undefined;
	const identity = codexIdentity(headers);
	if (identity === undefined) return undefined;
	const instructions: string[] = [];
	const ambient: string[] = [];
	const declared: unknown[] = [];
	let basePromptSeen = false;
	for (const item of input) {
		if (stringField(item, "type") === "additional_tools") {
			declared.push(...(arrayField(item, "tools") ?? []));
			continue;
		}
		const role = stringField(item, "role");
		if (role === "developer") {
			if (!basePromptSeen) {
				basePromptSeen = true;
				instructions.push(...textParts(item));
			}
		} else if (role === "user") ambient.push(...textParts(item));
	}
	const fallback = codexFallback(body);
	return {
		profile: "codex",
		clientVersion: identity.clientVersion,
		entrypoint: identity.entrypoint,
		instructions,
		...toolSurface(declared),
		ambient,
		...(fallback !== undefined && { fallback }),
	};
}

function derive(request: AuthGatewayHarnessRequest): Derivation | undefined {
	switch (request.format) {
		case "anthropic-messages":
			return deriveClaudeCode(request.body);
		case "openai-responses":
			return deriveCodex(request.body, request.headers);
	}
}

function ambientNeedles(instructions: readonly string[], recorded: readonly string[]): string[] {
	const blocks = instructions.map(block => block.trim()).filter(block => block.length > 0);
	const needles: string[] = [];
	for (const entry of recorded) {
		const needle = entry.trim();
		if (needle.length === 0 || needles.includes(needle)) continue;
		const strips = blocks.some(
			block => block === needle || (needle.length >= AMBIENT_CONTAINMENT_MIN_CHARS && block.includes(needle)),
		);
		if (strips) needles.push(needle);
	}
	return needles;
}

async function writeCapture(profile: HarnessProfile, file: string, capture: HarnessCapture): Promise<boolean> {
	const temp = `${file}.${Bun.randomUUIDv7()}.tmp`;
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(temp, JSON.stringify(capture), { mode: 0o600 });
	try {
		try {
			await fs.link(temp, file);
			return true;
		} catch (error) {
			if (!isEexist(error)) throw error;
		}
		const recorded: unknown = await Bun.file(file)
			.json()
			.catch(() => undefined);
		const existing = projectHarnessCapture(profile, recorded);
		if (!existing.ok) {
			await fs.rename(temp, file);
			return true;
		}
		if (!projectHarnessCapture(profile, capture).ok) return false;
		const recordedAt = Date.parse(capture.capturedAt ?? "");
		if (!Number.isNaN(recordedAt) && recordedAt > existing.capturedAt) {
			await fs.rename(temp, file);
			return true;
		}
		return false;
	} finally {
		await fs.rm(temp, { force: true });
	}
}

export async function recordHarnessRequest(request: AuthGatewayHarnessRequest): Promise<void> {
	const derived = derive(request);
	if (derived === undefined) {
		logger.debug("Harness recorder: no vendor client identity on this request; nothing to record", {
			format: request.format,
		});
		return;
	}
	const { profile, clientVersion, entrypoint } = derived;
	const identity = { profile, clientVersion, entrypoint };
	const ambient = ambientNeedles(derived.instructions, derived.ambient);
	const capture: HarnessCapture = {
		schema: HARNESS_CAPTURE_SCHEMA,
		capturedAt: new Date().toISOString(),
		...derived,
		ambient,
	};
	const projection = projectHarnessCapture(profile, capture);
	if (!projection.ok) {
		logger.warn("Harness recorder: request rejected by the capture contract; nothing written", {
			...identity,
			format: request.format,
			reason: projection.reason,
			...(derived.fallback !== undefined && { fallback: derived.fallback.reason }),
		});
		return;
	}
	if (!CAPTURE_IDENTITY.test(clientVersion) || !CAPTURE_IDENTITY.test(entrypoint)) {
		logger.warn("Harness recorder: client identity is not a safe filename; nothing written", identity);
		return;
	}
	// The model is part of the identity because the vendor prompt names it, so
	// each model gets its own file instead of overwriting another model's text.
	const modelSuffix = derived.model !== undefined && CAPTURE_IDENTITY.test(derived.model) ? `-${derived.model}` : "";
	const file = path.join(getHarnessCacheDir(), profile, `${clientVersion}-${entrypoint}${modelSuffix}.json`);
	let written: boolean;
	try {
		written = await writeCapture(profile, file, capture);
	} catch (error) {
		logger.warn("Harness recorder: capture write failed", { file, error: String(error) });
		return;
	}
	if (!written) {
		logger.info("Harness recorder: this client identity already has a capture at least this new; keeping it", {
			...identity,
			file,
		});
		return;
	}
	logger.info("Harness recorder: captured a vendor harness surface", {
		...identity,
		file,
		instructions: capture.instructions.length,
		tools: capture.tools.length,
		ambient: ambient.length,
	});
}
