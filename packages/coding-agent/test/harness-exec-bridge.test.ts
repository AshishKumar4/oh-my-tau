import { afterAll, describe, expect, test } from "bun:test";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Model, Tool, ToolCall } from "@oh-my-pi/pi-ai/types";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { resolveHarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { harnessToolBinding } from "@oh-my-pi/pi-coding-agent/harness/manifest";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { isRecord } from "@oh-my-pi/pi-utils";
import codexExecGrammar from "../src/tools/eval-format/codex-exec.lark" with { type: "text" };

const ASTRA = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-6-astra");
// A bundled Codex model the catalog gives no harness profile.
const NATIVE_CODEX = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-5.6-luna");

const EXEC_SOURCE = '// @exec: {"yield_time_ms": 10}\nprint(6 * 7)';

const EXEC_WIRE_GRAMMAR = [
	"start: pragma_source | plain_source",
	"pragma_source: PRAGMA_LINE NEWLINE SOURCE",
	"plain_source: SOURCE",
	"PRAGMA_LINE: /[ \\t]*\\/\\/ @exec:[^\\r\\n]*/",
	"NEWLINE: /\\r?\\n/",
	"SOURCE: /[\\s\\S]+/",
].join("\n");

function evalToolFor(model: Model, settings = Settings.isolated()): EvalTool {
	return new EvalTool({
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
		getActiveModel: () => model,
		toolRegistry: new Map(),
		getEvalBridgeToolNames: () => ["eval"],
		getCodeModeDirectToolNames: () => ["eval"],
	} as unknown as ToolSession);
}

function execCall(name: string): ToolCall {
	return { type: "toolCall", id: "call_exec", name, arguments: { input: EXEC_SOURCE }, customWireName: name };
}

function presentedTool(tool: EvalTool, model: Model): Tool {
	const profile = resolveHarnessProfile(model);
	const binding = profile === undefined ? undefined : harnessToolBinding(profile, tool.name);
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		strict: tool.strict,
		...(tool.customFormat ? { customFormat: tool.customFormat } : {}),
		...(binding?.wireName ? { customWireName: binding.wireName } : {}),
	};
}

async function codexDeclarations(model: Model<"openai-codex-responses">): Promise<Record<string, unknown>[]> {
	const tool = evalToolFor(model);
	const body = await buildTransformedCodexRequestBody(
		model,
		{
			systemPrompt: ["You are omp."],
			messages: [{ role: "user", content: "run it", timestamp: 1 }],
			tools: [presentedTool(tool, model)],
		},
		{ reasoning: Effort.High },
	);
	const input = Array.isArray(body.input) ? body.input : [];
	const additional = input.find(item => isRecord(item) && item.type === "additional_tools");
	const groups = isRecord(additional) && Array.isArray(additional.tools) ? additional.tools : [];
	const grouped = groups.flatMap(group => (isRecord(group) && Array.isArray(group.tools) ? group.tools : []));
	const flat = Array.isArray(body.tools) ? body.tools : [];
	return [...grouped, ...flat].filter(isRecord);
}

afterAll(async () => {
	await disposeAllVmContexts();
});

describe("codex exec bridge", () => {
	test("reaches the astra wire as the vendor's grammar-backed custom exec tool", async () => {
		const [declaration] = await codexDeclarations(ASTRA);
		expect(declaration).toEqual({
			type: "custom",
			name: "exec",
			description: expect.stringContaining("Accepts raw JavaScript source text, not JSON"),
			format: { type: "grammar", syntax: "lark", definition: EXEC_WIRE_GRAMMAR },
		});
	});

	test("stays omp's strict JSON eval function on a codex model without the profile", async () => {
		const [declaration] = await codexDeclarations(NATIVE_CODEX);
		expect(declaration).toMatchObject({ type: "function", name: "eval", strict: true });
		const properties = isRecord(declaration.parameters) ? declaration.parameters.properties : undefined;
		expect(Object.keys(isRecord(properties) ? properties : {})).toEqual([
			"language",
			"code",
			"title",
			"timeout",
			"reset",
		]);
	});

	test("executes a raw-source exec call as a JavaScript cell through the real tool", async () => {
		const tool = evalToolFor(ASTRA);
		expect(tool.customFormat).toEqual({ syntax: "lark", definition: codexExecGrammar });

		const args = validateToolArguments(tool, execCall("exec"));
		expect(args).toEqual({ input: EXEC_SOURCE });
		if (typeof args.input !== "string") throw new Error("validated exec call lost its raw input");

		const result = await tool.execute("call_exec", { input: args.input });
		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		expect(text).toContain("42");
		expect(result.details?.language).toBe("js");
		expect(result.details?.cells?.[0]?.status).toBe("complete");
	});

	test("keeps the JSON eval function under the profile when the JS runtime is disabled", () => {
		const tool = evalToolFor(ASTRA, Settings.isolated({ "eval.js": false }));
		expect(tool.customFormat).toBeUndefined();
		expect(() => validateToolArguments(tool, execCall("exec"))).toThrow(/Validation failed for tool "exec"/);
	});

	test("rejects the same raw-source payload off the profile", () => {
		const tool = evalToolFor(NATIVE_CODEX);
		expect(tool.customFormat).toBeUndefined();
		expect(() => validateToolArguments(tool, execCall("eval"))).toThrow(/Validation failed for tool "eval"/);
	});
});
