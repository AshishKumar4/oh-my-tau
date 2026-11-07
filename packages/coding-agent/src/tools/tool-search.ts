import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TSchema } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { applyToolProxy } from "../extensibility/tool-proxy";
import type { ToolSearchSurface, VendorTool } from "../harness/capture";
import { presentedWireName } from "../harness/facade";
import { harnessToolBinding } from "../harness/manifest";
import toolSearchDescription from "../prompts/tools/tool-search.md" with { type: "text" };
import type { Tool } from "./index";
import { isMountableUnderXdev, listXdevTools, type XdevState } from "./xdev";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";

const DEFAULT_MAX_RESULTS = 5;
/** Claude Code's result text, whatever the number of tools loaded. */
const LOADED_TEXT = "Tool loaded.";
const NO_MATCH_TEXT = "No matching deferred tools found.";

const toolSearchSchema = type({
	query: type("string").describe('"select:<name>[,<name>...]", keywords, or "+term" to require a term in the name'),
	"max_results?": type("number").describe("most tools a keyword query loads (default 5)"),
});

type ToolSearchParams = typeof toolSearchSchema.infer;

/** A deferred tool as the model knows it: the name it is announced under, and what it does. */
export interface DeferredTool {
	/** omp's name, which a tool search's result references. */
	readonly name: string;
	/** The name the model sees and calls. */
	readonly wireName: string;
	readonly description: string;
}

export interface ToolSearchToolDetails {
	loaded: string[];
}

/**
 * Loads deferred tools for the model. Deferred tools ride the request with
 * `defer_loading`, so the provider shows the model only their names; a search
 * returns the matching tools as references, which the provider expands into
 * their definitions. Mounted only where the served harness defers tools this
 * way; everywhere else the same tools are `xd://` devices.
 */
export class ToolSearchTool implements AgentTool<typeof toolSearchSchema, ToolSearchToolDetails> {
	readonly name = TOOL_SEARCH_TOOL_NAME;
	readonly label = "ToolSearch";
	readonly approval = "read" as const;
	readonly description = prompt.render(toolSearchDescription);
	readonly parameters = toolSearchSchema;
	readonly loadMode = "essential" as const;
	readonly intent = (args: Partial<ToolSearchParams>) =>
		args.query ? `loading tools: ${args.query}` : "loading tools";

	constructor(private readonly deferredTools: () => readonly DeferredTool[]) {}

	async execute(_toolCallId: string, params: ToolSearchParams): Promise<AgentToolResult<ToolSearchToolDetails>> {
		const loaded = searchDeferredTools(this.deferredTools(), params.query, params.max_results ?? DEFAULT_MAX_RESULTS);
		if (loaded.length === 0) {
			return { content: [{ type: "text", text: NO_MATCH_TEXT }], details: { loaded: [] } };
		}
		const names = loaded.map(tool => tool.name);
		return {
			content: [{ type: "text", text: LOADED_TEXT }],
			details: { loaded: loaded.map(tool => tool.wireName) },
			providerMetadata: { type: "toolSearch", toolNames: names },
		};
	}
}

/**
 * The deferred tools `query` names, in Claude Code's query forms: `select:`
 * picks tools by name (all of them, in the order given); keywords rank tools
 * by matches in the name (worth more) and description, and `+term` requires
 * `term` in the name.
 */
export function searchDeferredTools(tools: readonly DeferredTool[], query: string, maxResults: number): DeferredTool[] {
	const trimmed = query.trim();
	const select = /^select:/i.exec(trimmed);
	if (select) {
		const picked: DeferredTool[] = [];
		for (const requested of trimmed.slice(select[0].length).split(",")) {
			const name = requested.trim().toLowerCase();
			const tool = tools.find(tool => tool.wireName.toLowerCase() === name || tool.name.toLowerCase() === name);
			if (tool && !picked.includes(tool)) picked.push(tool);
		}
		return picked;
	}
	const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
	const required = terms.filter(term => term.startsWith("+") && term.length > 1).map(term => term.slice(1));
	const ranking = terms.filter(term => !term.startsWith("+"));
	const scored = tools.flatMap(tool => {
		const name = tool.wireName.toLowerCase();
		if (!required.every(term => name.includes(term))) return [];
		const description = tool.description.toLowerCase();
		let score = required.length;
		for (const term of ranking) {
			if (name === term) score += 10;
			else if (name.includes(term)) score += 3;
			if (description.includes(term)) score += 1;
		}
		return score > 0 ? [{ tool, score }] : [];
	});
	scored.sort((a, b) => b.score - a.score || a.tool.wireName.localeCompare(b.tool.wireName));
	return scored.slice(0, Math.max(1, Math.floor(maxResults))).map(({ tool }) => tool);
}

/** The name `tool` presents under Claude Code's harness. */
function claudeCodeWireName(tool: AgentTool): string {
	return presentedWireName(tool, harnessToolBinding("claude-code", tool.name)) ?? tool.name;
}

/**
 * Whether `tool` defers behind ToolSearch: what `xd://` would mount, plus the
 * tools the client itself defers (Claude Code defers `WebSearch`).
 */
export function defersUnderToolSearch(tool: AgentTool, surface: ToolSearchSurface): boolean {
	if (tool.name === TOOL_SEARCH_TOOL_NAME) return false;
	return isMountableUnderXdev(tool) || surface.deferred.includes(claudeCodeWireName(tool));
}

/** The deferred tools as the model knows them: their wire names and the client's descriptions. */
export function listDeferredTools(
	state: XdevState,
	vendorTool: (wireName: string) => VendorTool | undefined,
): DeferredTool[] {
	return listXdevTools(state).map(tool => {
		const wireName = claudeCodeWireName(tool);
		return { name: tool.name, wireName, description: vendorTool(wireName)?.description ?? tool.description };
	});
}

/** The session's `tool_search`, registered in its canonical tool map on first use. */
export function ensureToolSearchTool(
	registry: Map<string, Tool>,
	state: XdevState,
	vendorTool: (wireName: string) => VendorTool | undefined,
): Tool {
	const registered = registry.get(TOOL_SEARCH_TOOL_NAME);
	if (registered) return registered;
	const tool = new ToolSearchTool(() => listDeferredTools(state, vendorTool));
	registry.set(TOOL_SEARCH_TOOL_NAME, tool);
	return tool;
}

/** The client's announcement of its deferred tools, naming omp's: one name per line, sorted. */
export function renderDeferredToolsAnnouncement(surface: ToolSearchSurface, tools: readonly DeferredTool[]): string {
	return [surface.announcement, ...tools.map(tool => tool.wireName).sort()].join("\n");
}

/**
 * `tool` declared for loading on demand: the provider sends it with
 * `defer_loading`, so the model sees its name only until a search references
 * it. Everything else forwards to the tool.
 */
class DeferredLoadingTool implements AgentTool {
	declare readonly name: string;
	declare readonly label: string;
	declare readonly description: string;
	declare readonly parameters: TSchema;
	declare readonly execute: AgentTool["execute"];
	readonly deferLoading = true;

	constructor(tool: AgentTool) {
		applyToolProxy(tool, this);
	}
}

export function deferLoading(tool: AgentTool): AgentTool {
	return new DeferredLoadingTool(tool);
}
