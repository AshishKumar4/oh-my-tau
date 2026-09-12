import { jsonSchemaToTypeScript } from "@oh-my-pi/pi-ai/utils/schema/typescript";
import { arkToWireSchema, isArkSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import { prompt } from "@oh-my-pi/pi-utils";
import { codeModeIdentifier } from "../../harness/code-mode-identifier";
import codexExecTemplate from "../../prompts/tools/eval-codex-exec.md" with { type: "text" };

export interface CodexExecBridgedTool {
	readonly name: string;
	readonly parameters: unknown;
	readonly summary?: string;
}

interface RenderedTool {
	readonly identifier: string;
	readonly alias?: string;
	readonly summary?: string;
	readonly declaration: string;
}

function compareTools(left: CodexExecBridgedTool, right: CodexExecBridgedTool): number {
	if (left.name === right.name) return 0;
	return left.name < right.name ? -1 : 1;
}

function renderTool(tool: CodexExecBridgedTool): RenderedTool {
	const identifier = codeModeIdentifier(tool.name);
	const schema = isArkSchema(tool.parameters) ? arkToWireSchema(tool.parameters) : tool.parameters;
	return {
		identifier,
		...(identifier === tool.name ? {} : { alias: tool.name }),
		...(tool.summary ? { summary: tool.summary } : {}),
		declaration: jsonSchemaToTypeScript(schema, { style: "codex", declarationName: identifier }),
	};
}

export function buildCodexExecDescription(args: {
	tools: readonly CodexExecBridgedTool[];
	preludeDeclarations?: string;
	/**
	 * The vendor capture's nested `### \`name\`` sections (everything from the
	 * first `### ` to the end of the captured exec description), spliced
	 * verbatim between the fixed head and omp's own bridged tools.
	 */
	nestedDeclarations?: string;
}): string {
	return prompt.render(codexExecTemplate, {
		tools: [...args.tools].sort(compareTools).map(renderTool),
		...(args.preludeDeclarations ? { preludeDeclarations: args.preludeDeclarations } : {}),
		...(args.nestedDeclarations ? { nestedDeclarations: args.nestedDeclarations } : {}),
	});
}
