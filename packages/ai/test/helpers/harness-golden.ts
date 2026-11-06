import * as path from "node:path";
import { type AnthropicOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, Context, FetchImpl, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { isEnoent, isRecord } from "@oh-my-pi/pi-utils";

function field(node: unknown, key: string): unknown {
	return isRecord(node) ? node[key] : undefined;
}

function stringField(node: unknown, key: string): string | undefined {
	const value = field(node, key);
	return typeof value === "string" ? value : undefined;
}

function arrayField(node: unknown, key: string): unknown[] | undefined {
	const value = field(node, key);
	return Array.isArray(value) ? value : undefined;
}

export type HarnessWireFamily = "anthropic-messages" | "codex-responses";

export interface NamespaceStructure {
	defaultGroup: string;
	defaultGroupDescribed: boolean;
	extraGroupsAllDescribed: boolean;
	allGroupsNonEmpty: boolean;
	duplicateGroups: string[];
	ungroupedPayloadTypes: string[];
}

export interface HarnessFraming {
	family: HarnessWireFamily;
	systemLayout: string[];
	cachedSystemSlots: string[];
	inventoryCarrier: string;
	namespaceStructure: NamespaceStructure | null;
	envelope: Record<string, string>;
	presentForbiddenKeys: string[];
	prefixedToolNames: string[];
}

function collapseAdjacent(kinds: readonly string[]): string[] {
	const collapsed: string[] = [];
	for (const kind of kinds) {
		if (collapsed[collapsed.length - 1] !== kind) collapsed.push(kind);
	}
	return collapsed;
}

function envelopeShape(value: unknown): string {
	if (value === undefined) return "absent";
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		const strings = value.filter(entry => typeof entry === "string");
		return strings.length === value.length ? JSON.stringify(strings) : `array(${value.length})`;
	}
	if (isRecord(value)) return `object{${Object.keys(value).sort().join(",")}}`;
	return typeof value;
}

function envelope(body: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
	const shaped: Record<string, string> = {};
	for (const key of keys) shaped[key] = envelopeShape(body[key]);
	return shaped;
}

const CODEX_ENVELOPE_KEYS = [
	"include",
	"reasoning",
	"text",
	"store",
	"stream",
	"tool_choice",
	"parallel_tool_calls",
] as const;

const ANTHROPIC_ENVELOPE_KEYS = [
	"max_tokens",
	"thinking",
	"context_management",
	"output_config",
	"stream",
	"tool_choice",
] as const;

const CODEX_FORBIDDEN_KEYS = ["instructions", "tools"] as const;

export function declaredNames(declarations: readonly unknown[]): string[] {
	return declarations.flatMap(declaration => {
		const name = stringField(declaration, "name");
		return name === undefined ? [] : [name];
	});
}

function classifyCodexInputItem(item: unknown): string {
	if (!isRecord(item)) return "malformed";
	const type = stringField(item, "type");
	const role = stringField(item, "role") ?? "no-role";
	if (type === "additional_tools") return `additional_tools:${role}`;
	if (type === "message" || type === undefined) {
		const partTypes = (arrayField(item, "content") ?? []).flatMap(part => {
			const partType = stringField(part, "type");
			return partType === undefined ? [] : [partType];
		});
		return `message:${role}:${[...new Set(partTypes)].join("+") || "none"}`;
	}
	return `${type}:${role}`;
}

export function codexFraming(body: Record<string, unknown>): HarnessFraming {
	const systemKinds: string[] = [];
	const wireNames: string[] = [];
	const groupNames: string[] = [];
	const duplicateGroups: string[] = [];
	const ungroupedPayloadTypes: string[] = [];
	let inventoryCarrier = "absent";
	let defaultGroup = "absent";
	let defaultGroupDescribed = false;
	let extraGroupsAllDescribed = true;
	let allGroupsNonEmpty = true;
	let namespaced = false;
	for (const [index, item] of (arrayField(body, "input") ?? []).entries()) {
		const kind = classifyCodexInputItem(item);
		if (kind.startsWith("additional_tools")) {
			inventoryCarrier = `input[${index}].${kind}`;
			for (const group of arrayField(item, "tools") ?? []) {
				const type = stringField(group, "type");
				if (type !== "namespace") {
					ungroupedPayloadTypes.push(type ?? "untyped");
					const ungroupedName = stringField(group, "name");
					if (ungroupedName !== undefined) wireNames.push(ungroupedName);
					continue;
				}
				namespaced = true;
				const name = stringField(group, "name") ?? "unnamed";
				const described = (stringField(group, "description") ?? "").length > 0;
				const members = arrayField(group, "tools") ?? [];
				if (groupNames.includes(name)) duplicateGroups.push(name);
				groupNames.push(name);
				if (members.length === 0) allGroupsNonEmpty = false;
				if (groupNames.length === 1) {
					defaultGroup = name;
					defaultGroupDescribed = described;
				} else if (!described) {
					extraGroupsAllDescribed = false;
				}
				wireNames.push(...declaredNames(members));
			}
			continue;
		}
		if (kind.startsWith("message:developer")) systemKinds.push(kind);
	}
	const topLevelTools = arrayField(body, "tools");
	if (topLevelTools) {
		inventoryCarrier = "tools";
		wireNames.push(...declaredNames(topLevelTools));
	}
	return {
		family: "codex-responses",
		systemLayout: collapseAdjacent(systemKinds),
		cachedSystemSlots: [],
		inventoryCarrier,
		namespaceStructure: namespaced
			? {
					defaultGroup,
					defaultGroupDescribed,
					extraGroupsAllDescribed,
					allGroupsNonEmpty,
					duplicateGroups,
					ungroupedPayloadTypes,
				}
			: null,
		envelope: envelope(body, CODEX_ENVELOPE_KEYS),
		presentForbiddenKeys: CODEX_FORBIDDEN_KEYS.filter(key => body[key] !== undefined),
		prefixedToolNames: wireNames.filter(name => name.startsWith("_")),
	};
}

function classifyAnthropicSystemBlock(block: unknown, identitySentences: readonly string[]): string {
	if (!isRecord(block)) return "malformed";
	const type = stringField(block, "type");
	if (type !== "text") return type ?? "untyped";
	const text = stringField(block, "text") ?? "";
	if (text.startsWith("x-anthropic-billing-header:")) return "billing-header";
	if (identitySentences.includes(text)) return "identity";
	return "prompt";
}

function cacheControlShape(block: unknown): string {
	const control = field(block, "cache_control");
	const type = stringField(control, "type") ?? "untyped";
	const ttl = stringField(control, "ttl");
	return ttl === undefined ? type : `${type}/${ttl}`;
}

export function anthropicFraming(body: Record<string, unknown>, identitySentences: readonly string[]): HarnessFraming {
	const system = arrayField(body, "system") ?? [];
	const kinds = system.map(block => classifyAnthropicSystemBlock(block, identitySentences));
	return {
		family: "anthropic-messages",
		systemLayout: collapseAdjacent(kinds),
		cachedSystemSlots: system.flatMap((block, index) => {
			if (field(block, "cache_control") === undefined) return [];
			const slot = index === system.length - 1 ? `${kinds[index]}-last` : `${kinds[index]}`;
			return [`${slot}:${cacheControlShape(block)}`];
		}),
		inventoryCarrier: body.tools === undefined ? "absent" : "tools",
		namespaceStructure: null,
		envelope: envelope(body, ANTHROPIC_ENVELOPE_KEYS),
		presentForbiddenKeys: [],
		prefixedToolNames: declaredNames(arrayField(body, "tools") ?? []).filter(name => name.startsWith("_")),
	};
}

export function projectionDeltaPaths(vendor: unknown, omp: unknown, prefix = ""): string[] {
	if (isRecord(vendor) && isRecord(omp)) {
		const paths: string[] = [];
		for (const key of [...new Set([...Object.keys(vendor), ...Object.keys(omp)])].sort()) {
			paths.push(...projectionDeltaPaths(vendor[key], omp[key], prefix === "" ? key : `${prefix}.${key}`));
		}
		return paths;
	}
	return JSON.stringify(vendor) === JSON.stringify(omp) ? [] : [prefix];
}

export interface HarnessInventoryShape {
	declarationForms: string[];
	boundNaming: string[];
	unboundNaming: string[];
	schemaForms: string[];
	argumentDocStyle: string;
}

function keySignature(node: unknown): string {
	if (!isRecord(node)) return "malformed";
	const type = stringField(node, "type") ?? "untyped";
	const keys = Object.keys(node)
		.filter(key => key !== "type")
		.sort();
	return `${type}|${keys.join(",")}`;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function namingConvention(name: string): string {
	if (name.startsWith("_")) return "omp-prefixed";
	if (name.includes("__")) return "mcp-qualified";
	if (!IDENTIFIER.test(name)) return "non-identifier";
	if (/^[A-Z]/.test(name)) return "PascalCase";
	if (name.includes("_")) return "snake_case";
	return "lowercase";
}

export function harnessInventoryShape(
	declarations: readonly unknown[],
	boundNames: ReadonlySet<string>,
): HarnessInventoryShape {
	const forms = new Set<string>();
	const bound = new Set<string>();
	const unbound = new Set<string>();
	const schemaForms = new Set<string>();
	let described = false;
	for (const declaration of declarations) {
		forms.add(keySignature(declaration));
		const name = stringField(declaration, "name");
		if (name !== undefined) (boundNames.has(name) ? bound : unbound).add(namingConvention(name));
		for (const key of ["parameters", "input_schema"]) {
			const schema = field(declaration, key);
			if (!isRecord(schema)) continue;
			schemaForms.add(keySignature(schema));
			for (const property of Object.values(field(schema, "properties") ?? {})) {
				const description = stringField(property, "description");
				described = described || (description !== undefined && description.length > 0);
			}
		}
	}
	return {
		declarationForms: [...forms].sort(),
		boundNaming: [...bound].sort(),
		unboundNaming: [...unbound].sort(),
		schemaForms: [...schemaForms].sort(),
		argumentDocStyle: described ? "inline-property-descriptions" : "none",
	};
}

export function codexDeclarations(body: Record<string, unknown>): unknown[] {
	const top = arrayField(body, "tools");
	if (top) return top;
	for (const item of arrayField(body, "input") ?? []) {
		if (stringField(item, "type") !== "additional_tools") continue;
		return (arrayField(item, "tools") ?? []).flatMap(group =>
			stringField(group, "type") === "namespace" ? (arrayField(group, "tools") ?? []) : [group],
		);
	}
	return [];
}

export interface HarnessCapture {
	file: string;
	family: HarnessWireFamily;
	body: Record<string, unknown>;
}

async function scanCaptureDir(env: string | undefined, glob: string): Promise<Array<[string, unknown]>> {
	if (env === undefined || env.length === 0) return [];
	const found: Array<[string, unknown]> = [];
	try {
		for await (const entry of new Bun.Glob(glob).scan({ cwd: env, onlyFiles: true })) {
			const file = path.join(env, entry);
			found.push([file, await Bun.file(file).json()]);
		}
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	return found.sort(([left], [right]) => left.localeCompare(right));
}

const EVAL_TOOL_CODEX_EXEC_GRAMMAR = path.join(
	import.meta.dir,
	"../../../coding-agent/src/tools/eval-format/codex-exec.lark",
);

export async function loadEvalToolCodexExecFormat(): Promise<NonNullable<Tool["customFormat"]>> {
	return { syntax: "lark", definition: await Bun.file(EVAL_TOOL_CODEX_EXEC_GRAMMAR).text() };
}

export async function loadHarnessCaptures(): Promise<HarnessCapture[]> {
	const files = await scanCaptureDir(Bun.env.OMP_HARNESS_CAPTURE_DIR, "*.json");
	return files.flatMap(([file, body]): HarnessCapture[] => {
		if (!isRecord(body)) return [];
		if (Array.isArray(body.input)) return [{ file, family: "codex-responses", body }];
		return Array.isArray(body.messages) ? [{ file, family: "anthropic-messages", body }] : [];
	});
}

export interface HarnessPromptCapture {
	file: string;
	profile: string;
	clientVersion: string;
	entrypoint: string;
	instructions: string[];
	tools: string[];
}

export async function loadHarnessPromptCaptures(): Promise<HarnessPromptCapture[]> {
	const files = await scanCaptureDir(Bun.env.OMP_HARNESS_CACHE_DIR, "*/*.json");
	return files.flatMap(([file, parsed]) => {
		const profile = stringField(parsed, "profile");
		const clientVersion = stringField(parsed, "clientVersion");
		const entrypoint = stringField(parsed, "entrypoint");
		if (profile === undefined || clientVersion === undefined || entrypoint === undefined) return [];
		return [
			{
				file,
				profile,
				clientVersion,
				entrypoint,
				instructions: (arrayField(parsed, "instructions") ?? []).flatMap(block =>
					typeof block === "string" ? [block] : [],
				),
				tools: (arrayField(parsed, "tools") ?? []).flatMap(name => (typeof name === "string" ? [name] : [])),
			},
		];
	});
}

const CANNED_USAGE = { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

export function anthropicTurnFetch(wireToolName?: string): FetchImpl {
	const text = wireToolName === undefined;
	const events: Record<string, unknown>[] = [
		{ type: "message_start", message: { id: "msg_harness", usage: CANNED_USAGE } },
		{
			type: "content_block_start",
			index: 0,
			content_block: text
				? { type: "text", text: "" }
				: { type: "tool_use", id: "toolu_harness", name: wireToolName, input: {} },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: text
				? { type: "text_delta", text: "ok" }
				: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: text ? "end_turn" : "tool_use" },
			usage: { ...CANNED_USAGE, output_tokens: 3 },
		},
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return async () =>
		new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream", "request-id": "req_harness" },
		});
}

export async function captureAnthropicTurn(
	model: Model<"anthropic-messages">,
	context: Context,
	options: AnthropicOptions,
): Promise<{ payload: Record<string, unknown>; result: AssistantMessage }> {
	let payload: Record<string, unknown> | undefined;
	const stream = streamAnthropic(model, context, {
		apiKey: "sk-ant-oat-test",
		isOAuth: true,
		...options,
		onPayload: captured => {
			if (isRecord(captured)) payload = captured;
		},
	});
	for await (const _ of stream) {
	}
	const result = await stream.result();
	if (payload === undefined) throw new Error("no /messages request payload captured");
	return { payload, result };
}

export function anthropicDeclarations(body: Record<string, unknown>): unknown[] {
	return arrayField(body, "tools") ?? [];
}

export function anthropicReplayedToolNames(body: Record<string, unknown>): string[] {
	return (arrayField(body, "messages") ?? []).flatMap(message =>
		(arrayField(message, "content") ?? []).flatMap(block => {
			const name = stringField(block, "name");
			return stringField(block, "type") === "tool_use" && name !== undefined ? [name] : [];
		}),
	);
}

export function anthropicReplayedToolCalls(body: Record<string, unknown>): Array<{ name: string; input: unknown }> {
	return (arrayField(body, "messages") ?? []).flatMap(message =>
		(arrayField(message, "content") ?? []).flatMap(block => {
			const name = stringField(block, "name");
			return stringField(block, "type") === "tool_use" && name !== undefined
				? [{ name, input: field(block, "input") }]
				: [];
		}),
	);
}
