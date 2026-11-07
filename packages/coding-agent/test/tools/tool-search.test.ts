import { describe, expect, it } from "bun:test";
import { type DeferredTool, ToolSearchTool } from "@oh-my-pi/pi-coding-agent/tools/tool-search";

// ToolSearch's query forms as Claude Code serves them: a search loads the
// tools it matches as references, with "Tool loaded." whatever their number,
// and a search that matches nothing loads none.

const DEFERRED: DeferredTool[] = [
	{ name: "cron_create", wireName: "CronCreate", description: "Schedule a prompt to run on a cron schedule." },
	{ name: "cron_delete", wireName: "CronDelete", description: "Cancel a scheduled cron job." },
	{ name: "cron_list", wireName: "CronList", description: "List scheduled cron jobs." },
	{ name: "monitor", wireName: "Monitor", description: "Watch a process and report on a schedule." },
	{ name: "web_search", wireName: "WebSearch", description: "Search the web." },
	{ name: "notebook_edit", wireName: "NotebookEdit", description: "Edit a Jupyter notebook cell." },
];

async function search(query: string, maxResults?: number) {
	const tool = new ToolSearchTool(() => DEFERRED);
	const result = await tool.execute("call", {
		query,
		...(maxResults === undefined ? {} : { max_results: maxResults }),
	});
	const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("");
	const metadata = result.providerMetadata;
	return { text, loaded: metadata?.type === "toolSearch" ? metadata.toolNames : [] };
}

describe("ToolSearch", () => {
	it("loads the tools a select names, in order, by wire or omp name", async () => {
		expect(await search("select:CronList,web_search")).toEqual({
			text: "Tool loaded.",
			loaded: ["cron_list", "web_search"],
		});
	});

	it("ranks a keyword search by name and description, up to max_results", async () => {
		const { text, loaded } = await search("cron schedule", 3);
		expect(text).toBe("Tool loaded.");
		expect(loaded).toEqual(["cron_create", "cron_delete", "cron_list"]);
		expect((await search("schedule")).loaded).toEqual(["cron_create", "cron_delete", "cron_list", "monitor"]);
	});

	it("requires a +term in the name", async () => {
		expect((await search("+notebook edit")).loaded).toEqual(["notebook_edit"]);
		expect((await search("+cron list")).loaded).toEqual(["cron_list", "cron_create", "cron_delete"]);
	});

	it("loads nothing for a query that matches no deferred tool", async () => {
		expect(await search("kubernetes")).toEqual({ text: "No matching deferred tools found.", loaded: [] });
		expect(await search("select:Nope")).toEqual({ text: "No matching deferred tools found.", loaded: [] });
	});
});
