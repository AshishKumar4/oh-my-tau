import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { prompt } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import evalCodeModeDescription from "../src/prompts/tools/eval-code-mode.md" with { type: "text" };
import type { ToolSession } from "../src/tools";
import { EvalTool } from "../src/tools/eval";
import { generateCodeModeDeclarations } from "../src/tools/eval-format/code-mode-declarations";
import { buildCodexExecDescription } from "../src/tools/eval-format/codex-exec-description";

const CODEX_MODEL = buildModel({
	id: "gpt-6-astra",
	name: "gpt-6-astra",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api/codex",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 100000,
});

const UNPROFILED_MODEL = buildModel({
	id: "gpt-6-astra",
	name: "gpt-6-astra",
	provider: "openai",
	api: "openai-responses",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 100000,
});

const read = { name: "read", summary: "Read files.", parameters: type({ path: "string" }) };
const write = { name: "write", parameters: type({ path: "string", content: "string" }) };

function evalToolFor(overrides: Record<string, unknown>): EvalTool {
	return new EvalTool({
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated(),
		toolRegistry: new Map<string, typeof read | typeof write>([
			["read", read],
			["write", write],
		]),
		getEvalBridgeToolNames: () => ["eval", "read", "write"],
		getCodeModeDirectToolNames: () => ["eval"],
		...overrides,
	} as unknown as ToolSession);
}

describe("codex-profile exec description", () => {
	test("replaces omp's Code Mode prose with the vendor template and declarations", () => {
		const description = evalToolFor({ getActiveModel: () => CODEX_MODEL }).description;

		expect(description).toStartWith(
			[
				"Run JavaScript code to orchestrate/compose tool calls",
				"- Evaluates the provided JavaScript code in a fresh V8 isolate as an async module.",
			].join("\n"),
		);
		expect(description).toContain(
			"- `yield_control()`: yields the accumulated output to the model immediately while the script keeps running.",
		);
		expect(description).not.toContain("Codex Code Mode is active");
		expect(description).not.toContain("declare const tool: {");

		expect(description).toContain("### `read`\nRead files.\n\nexec tool declaration:");
		expect(description).toContain(
			["```ts", "declare const tools: { read(args: {", "  path: string;", "}): Promise<unknown>; };", "```"].join(
				"\n",
			),
		);
		expect(description).toContain("### `write`\n\nexec tool declaration:");
		expect(description).not.toContain("### `eval`");
	});

	test("keeps omp's own Code Mode rendering off the profile", () => {
		for (const getActiveModel of [() => UNPROFILED_MODEL, () => undefined]) {
			const base = evalToolFor({ getActiveModel, getCodeModeDirectToolNames: () => undefined }).description;
			const description = evalToolFor({ getActiveModel }).description;

			expect(description).toBe(
				prompt.render(evalCodeModeDescription, {
					baseDescription: base,
					declarations: generateCodeModeDeclarations([read, write]),
					preludeDeclarations: "",
				}),
			);
			expect(description).toStartWith(base);
			expect(description).not.toContain("declare const tools: {");
		}
	});
});

describe("codex exec description assembly", () => {
	test("lists bridged tools flat and sorted under their own names", () => {
		const description = buildCodexExecDescription({
			tools: [
				{ name: "task", summary: "Delegate work.", parameters: type({ prompt: "string" }) },
				{ name: "read", parameters: type({ path: "string" }) },
			],
		});

		expect(description.indexOf("### `read`")).toBeLessThan(description.indexOf("### `task`"));
		expect(description).toContain(["### `task`", "Delegate work."].join("\n"));
		expect(description).toContain("declare const tools: { task(args: {");
		expect(description).toContain("### `read`\n\nexec tool declaration:");
		expect(description).not.toContain("## collaboration");
	});

	test("renders the prelude globals it is given and omits the block when there are none", () => {
		const tools = [{ name: "read", parameters: type({ path: "string" }) }] as const;
		const withPrelude = buildCodexExecDescription({
			tools,
			preludeDeclarations: "declare const browser: unknown;",
		});
		const without = buildCodexExecDescription({ tools });

		expect(withPrelude).toContain("Additional globals:\n```ts\ndeclare const browser: unknown;\n```");
		expect(without).not.toContain("Additional globals:");
	});
});
