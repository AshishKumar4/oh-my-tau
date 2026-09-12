import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { claudeCodeSystemInstruction } from "@oh-my-pi/pi-ai/providers/claude-code-fingerprint";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Context, Tool } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { CODEX_CLIENT_VERSION } from "@oh-my-pi/pi-catalog/wire/codex";
import { isRecord } from "@oh-my-pi/pi-utils";
import { withOfficialAnthropicEndpoint } from "./helpers";
import claudeCodeGoldenJson from "./fixtures/harness/claude-code-2.1.267.golden.json" with { type: "json" };
import codexGoldenJson from "./fixtures/harness/codex-0.154.0.golden.json" with { type: "json" };
import {
	anthropicDeclarations,
	anthropicFraming,
	anthropicTurnFetch,
	captureAnthropicTurn,
	codexDeclarations,
	codexFraming,
	declaredNames,
	harnessInventoryShape,
	loadEvalToolCodexExecFormat,
	loadHarnessCaptures,
	loadHarnessPromptCaptures,
	namingConvention,
	projectionDeltaPaths,
} from "./helpers/harness-golden";

interface HarnessGolden {
	harness: string;
	clientVersion: string;
	models: string[];
	vendorFraming: unknown;
	vendorInventory: { boundNaming: string[]; unboundNaming: string[] };
	ompFraming: unknown;
	ompInventory: unknown;
	documentedFramingDeltas: Record<string, string>;
	documentedInventoryDeltas: Record<string, string>;
}

const claudeVendorFraming: {
	systemLayout: string[];
	cachedSystemSlots: string[];
	inventoryCarrier: string;
	envelope: Record<string, string>;
} = claudeCodeGoldenJson.vendorFraming;

const codexGolden: HarnessGolden = codexGoldenJson;
const claudeCodeGolden: HarnessGolden = claudeCodeGoldenJson;

const OMP_IDENTITY = [claudeCodeSystemInstruction] as const;
const CAPTURE_IDENTITIES = [
	claudeCodeSystemInstruction,
	"You are a Claude agent, built on Anthropic's Claude Agent SDK.",
] as const;

withOfficialAnthropicEndpoint();

const SYSTEM_PROMPT = ["# Reporting outcomes\n\nBe brief.", "You are omp, a coding agent."];

function harnessTool(name: string, description: string, args: Record<string, string>, extra: Partial<Tool> = {}): Tool {
	const shape: Record<string, unknown> = {};
	for (const [argument, doc] of Object.entries(args)) {
		const list = argument.endsWith("[]");
		shape[list ? argument.slice(0, -2) : argument] = type(list ? "string[]" : "string").describe(doc);
	}
	return { name, description, parameters: type(shape), ...extra };
}

const CLAUDE_TOOLS: Tool[] = [
	harnessTool("bash", "Run a shell command", { command: "command to execute" }, { customWireName: "Bash" }),
	harnessTool("read", "Read a file", { path: "file path" }, { customWireName: "Read" }),
	harnessTool("write", "Write a file", { path: "file path", content: "file content" }, { customWireName: "Write" }),
	harnessTool("edit", "Edit a file", { input: "hashline patch" }, { customWireName: "Edit" }),
	harnessTool("task", "Delegate work", { context: "shared context" }, { customWireName: "Agent" }),
	harnessTool("ask", "Ask the user", { "questions[]": "questions to ask" }, { customWireName: "AskUserQuestion" }),
	harnessTool("web_search", "Search the web", { query: "search query" }, { customWireName: "WebSearch" }),
	harnessTool("grep", "Search files", { pattern: "regex" }),
	harnessTool("todo", "Track work", { "items[]": "todo items" }),
	harnessTool("mcp__gh__list_prs", "List pull requests", { repo: "repo slug" }),
];

const CLAUDE_BOUND_WIRE_NAMES: ReadonlySet<string> = new Set([
	"Bash",
	"Read",
	"Write",
	"Edit",
	"Agent",
	"AskUserQuestion",
	"WebSearch",
]);

const CODEX_COLLABORATION = { name: "collaboration", description: "Tools for spawning and managing sub-agents." };
const CODEX_TOOLS: Tool[] = [
	harnessTool(
		"eval",
		"Run JavaScript to orchestrate tool calls",
		{ input: "source text" },
		{ customWireName: "exec", customFormat: await loadEvalToolCodexExecFormat() },
	),
	harnessTool("ask", "Ask the user", { "questions[]": "questions to ask" }, { customWireName: "request_user_input" }),
	harnessTool("todo", "Track work", { "items[]": "todo items" }),
	harnessTool("new_context", "Roll the context over", { reason: "why to roll over" }),
	harnessTool("task", "Spawn a subagent", { prompt: "task text" }, { namespace: CODEX_COLLABORATION }),
	harnessTool(
		"hub",
		"Coordinate with peers",
		{ "to?": "recipient agent id" },
		{
			namespace: CODEX_COLLABORATION,
		},
	),
];

const CODEX_BOUND_WIRE_NAMES: ReadonlySet<string> = new Set(["exec", "request_user_input"]);

function harnessContext(tools: Tool[]): Context {
	return {
		systemPrompt: SYSTEM_PROMPT,
		messages: [{ role: "user", content: "list the repo", timestamp: 1 }],
		tools,
	};
}

async function claudeCodeRequest(modelId: string): Promise<Record<string, unknown>> {
	const { payload } = await captureAnthropicTurn(
		getBundledModel<"anthropic-messages">("anthropic", modelId),
		harnessContext(CLAUDE_TOOLS),
		{ fetch: anthropicTurnFetch(), reasoning: Effort.High, thinkingEnabled: true },
	);
	return payload;
}

function codexRequest(modelId: string): Promise<Record<string, unknown>> {
	return buildTransformedCodexRequestBody(
		getBundledModel<"openai-codex-responses">("openai-codex", modelId),
		harnessContext(CODEX_TOOLS),
		{ reasoning: Effort.High, textVerbosity: "low", include: ["reasoning.encrypted_content"] },
	);
}

function withEnvelopeOverrides(framing: unknown, overrides: Record<string, string>): unknown {
	if (Object.keys(overrides).length === 0) return framing;
	if (!isRecord(framing) || !isRecord(framing.envelope)) {
		throw new Error("framing projection has no envelope to override");
	}
	const envelope: Record<string, unknown> = { ...framing.envelope };
	for (const [path, value] of Object.entries(overrides)) {
		if (!path.startsWith("envelope.")) throw new Error(`unsupported override path ${path}`);
		envelope[path.slice("envelope.".length)] = value;
	}
	return { ...framing, envelope };
}

interface HarnessProfileCase {
	golden: HarnessGolden;
	perModel: Record<string, { deltas: Record<string, string> }>;
	request(modelId: string): Promise<Record<string, unknown>>;
	framing(body: Record<string, unknown>): unknown;
	inventory(body: Record<string, unknown>): unknown;
}

const PROFILES: readonly HarnessProfileCase[] = [
	{
		golden: codexGolden,
		perModel: {},
		request: codexRequest,
		framing: body => codexFraming(body),
		inventory: body => harnessInventoryShape(codexDeclarations(body), CODEX_BOUND_WIRE_NAMES),
	},
	{
		golden: claudeCodeGolden,
		perModel: claudeCodeGoldenJson.ompFramingPerModel,
		request: claudeCodeRequest,
		framing: body => anthropicFraming(body, OMP_IDENTITY),
		inventory: body => harnessInventoryShape(anthropicDeclarations(body), CLAUDE_BOUND_WIRE_NAMES),
	},
];

for (const profile of PROFILES) {
	const { golden } = profile;
	describe(`${golden.harness} harness golden`, () => {
		for (const modelId of golden.models) {
			it(`frames ${modelId} exactly as ${golden.harness} ${golden.clientVersion} does`, async () => {
				const expected = withEnvelopeOverrides(golden.ompFraming, profile.perModel[modelId]?.deltas ?? {});
				const framing: unknown = profile.framing(await profile.request(modelId));
				expect(framing).toEqual(expected);
			});

			it(`declares ${modelId} tools in the vendor's rendering style`, async () => {
				const inventory: unknown = profile.inventory(await profile.request(modelId));
				expect(inventory).toEqual(golden.ompInventory);
			});
		}

		it("keeps the documented framing delta set closed", () => {
			expect(projectionDeltaPaths(golden.vendorFraming, golden.ompFraming)).toEqual(
				Object.keys(golden.documentedFramingDeltas).sort(),
			);
		});

		it("keeps the documented inventory delta set closed", () => {
			expect(projectionDeltaPaths(golden.vendorInventory, golden.ompInventory)).toEqual(
				Object.keys(golden.documentedInventoryDeltas).sort(),
			);
		});
	});
}

describe("harness framing the projections deliberately leave count-free", () => {
	it("carries one codex developer message per system block, none merged or dropped", async () => {
		const body = await codexRequest("gpt-6-astra");
		const input = body.input;
		if (!Array.isArray(input)) throw new Error("codex body carries no input array");
		const developerBlocks = input.filter(item => isRecord(item) && item.role === "developer");
		expect(developerBlocks).toHaveLength(SYSTEM_PROMPT.length + 1);
	});

	it("leads with the billing header and the identity block, then every prompt block in order", async () => {
		const body = await claudeCodeRequest("claude-opus-5");
		const system = body.system;
		if (!Array.isArray(system)) throw new Error("anthropic body carries no system array");
		expect(system).toHaveLength(SYSTEM_PROMPT.length + 2);
		const texts = system.map(block => (isRecord(block) ? block.text : undefined));
		expect(texts[1]).toBe(claudeCodeSystemInstruction);
		expect(texts.slice(2)).toEqual(SYSTEM_PROMPT);
	});

	it("drops the transport prefix only under the profile", async () => {
		const profiled = anthropicFraming(await claudeCodeRequest("claude-opus-5"), OMP_IDENTITY);
		const unprofiled = anthropicFraming(await claudeCodeRequest("claude-sonnet-4-5"), OMP_IDENTITY);
		expect(profiled.prefixedToolNames).toEqual([]);
		expect(unprofiled.prefixedToolNames).toEqual([
			"_bash",
			"_read",
			"_write",
			"_edit",
			"_task",
			"_ask",
			"_grep",
			"_todo",
			"_mcp__gh__list_prs",
		]);
	});
});

describe("harness client version pins", () => {
	it("keeps the codex golden and the wire constant on the same release", () => {
		expect(codexGolden.clientVersion).toBe(CODEX_CLIENT_VERSION);
	});
});

const rawCaptures = await loadHarnessCaptures();
const promptCaptures = await loadHarnessPromptCaptures();

describe("vendor captures validate the committed goldens (local only)", () => {
	const capturedNames = (declarations: readonly unknown[]): ReadonlySet<string> =>
		new Set(declaredNames(declarations));

	const codexCaptures = rawCaptures.filter(capture => capture.family === "codex-responses");
	const claudeCaptures = rawCaptures.filter(capture => capture.family === "anthropic-messages");

	it.skipIf(codexCaptures.length === 0)("re-projects every raw Codex capture onto the committed vendor golden", () => {
		for (const capture of codexCaptures) {
			const declarations = codexDeclarations(capture.body);
			const framing: unknown = codexFraming(capture.body);
			const inventory: unknown = harnessInventoryShape(declarations, capturedNames(declarations));
			expect(framing).toEqual(codexGolden.vendorFraming);
			expect(inventory).toEqual(codexGolden.vendorInventory);
		}
	});

	it.skipIf(claudeCaptures.length === 0)(
		"re-projects every raw Claude Code capture onto the committed vendor golden",
		() => {
			for (const capture of claudeCaptures) {
				const declarations = anthropicDeclarations(capture.body);
				const framing = anthropicFraming(capture.body, CAPTURE_IDENTITIES);
				const inventory: unknown = harnessInventoryShape(declarations, capturedNames(declarations));
				expect(framing.systemLayout).toEqual(claudeVendorFraming.systemLayout);
				expect(framing.inventoryCarrier).toBe(claudeVendorFraming.inventoryCarrier);
				expect(framing.prefixedToolNames).toEqual([]);
				expect(framing.cachedSystemSlots.map(slot => slot.split(":")[0])).toEqual(
					claudeVendorFraming.cachedSystemSlots.map(slot => slot.split(":")[0]),
				);
				expect(Object.keys(framing.envelope).filter(key => framing.envelope[key] === "absent")).toEqual([
					"tool_choice",
				]);
				expect(framing.envelope.max_tokens).toBe(claudeVendorFraming.envelope.max_tokens);
				expect(inventory).toEqual(claudeCodeGolden.vendorInventory);
			}
		},
	);

	it.skipIf(promptCaptures.length === 0)("checks the prompt cache against the goldens it was captured from", () => {
		const goldensByProfile: Record<string, HarnessGolden> = {
			"claude-code": claudeCodeGolden,
			codex: codexGolden,
		};
		for (const capture of promptCaptures) {
			const golden = goldensByProfile[capture.profile];
			if (!golden) continue;
			expect(capture.clientVersion).toBe(golden.clientVersion);
			const conventions = new Set(capture.tools.map(name => namingConvention(name)));
			expect(
				[...conventions].filter(convention => !golden.vendorInventory.boundNaming.includes(convention)),
			).toEqual([]);
			expect(
				capture.instructions.filter(block => CAPTURE_IDENTITIES.some(sentence => sentence === block.trim())),
			).toEqual([]);
		}
	});
});
