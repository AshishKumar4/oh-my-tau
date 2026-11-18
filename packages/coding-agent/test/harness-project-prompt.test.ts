import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import projectPromptTemplate from "../src/prompts/system/project-prompt.md" with { type: "text" };
// The template as it stood before the claude-code conditions were added.
import projectPromptBefore from "./fixtures/harness/project-prompt.before.md" with { type: "text" };

/** Active tool sets; `wire` is each tool's name on the Claude Code wire (the manifest's renames). */
const TOOL_SETS: ReadonlyArray<{ tools: string[]; wire: Record<string, string> }> = [
	{
		tools: ["read", "grep", "glob", "edit", "bash"],
		wire: { read: "Read", grep: "grep", glob: "glob", edit: "Edit", bash: "Bash" },
	},
	{ tools: ["read", "edit", "bash"], wire: { read: "Read", edit: "Edit", bash: "Bash" } },
	{ tools: ["bash"], wire: { bash: "Bash" } },
];

/** Tool names the project prompt could mention, in omp's spelling and Claude Code's. */
const TOOL_VOCABULARY: Record<string, true> = {
	read: true,
	grep: true,
	glob: true,
	edit: true,
	bash: true,
	Read: true,
	Edit: true,
	Bash: true,
};

function projectData(options: {
	harnessProfile: string | undefined;
	contextFiles: boolean;
	tools: (typeof TOOL_SETS)[number];
	vendorPrompt: boolean;
}): Record<string, unknown> {
	const claudeCodeVendorPrompt = options.vendorPrompt && options.harnessProfile === "claude-code";
	// Tool references render the name each tool presents under the active surface.
	const toolRefs = options.harnessProfile === "claude-code" ? options.tools.wire : undefined;
	return {
		environment: [
			{ label: "OS", value: "linux" },
			{ label: "Arch", value: "x64" },
		],
		model: "anthropic/claude-opus-5",
		contextFiles: options.contextFiles ? [{ path: "/work/AGENTS.md", content: "Run bun check." }] : [],
		agentsMdSearch: { files: options.contextFiles ? ["/work/pkg/AGENTS.md"] : [] },
		includeWorkspaceTree: true,
		workspaceTree: { rendered: "work/\n  src/", truncated: true },
		tools: options.tools.tools,
		toolRefs: toolRefs ?? Object.fromEntries(options.tools.tools.map(name => [name, name])),
		additionalWorkspaceRoots: ["/extra"],
		activeRepoContext: "",
		vendorPrompt: options.vendorPrompt,
		appendPrompt: "",
		claudeCodeVendorPrompt,
	};
}

describe("project prompt under harness profiles", () => {
	it("renders byte-identical to the template before the claude-code conditions unless Claude Code's prompt is served", () => {
		for (const harnessProfile of [undefined, "codex", "pi", "claude-code"]) {
			for (const contextFiles of [true, false]) {
				for (const tools of TOOL_SETS) {
					for (const vendorPrompt of [true, false]) {
						// A claude-code session without a served capture gets omp's native prompt.
						if (harnessProfile === "claude-code" && vendorPrompt) continue;
						const data = projectData({ harnessProfile, contextFiles, tools, vendorPrompt });
						expect(prompt.render(projectPromptTemplate, data), `${harnessProfile} ${tools.tools}`).toBe(
							prompt.render(projectPromptBefore, data),
						);
					}
				}
			}
		}
	});

	it("names only the tools Claude Code's surface serves, by their served names", () => {
		for (const tools of TOOL_SETS) {
			const rendered = prompt.render(
				projectPromptTemplate,
				projectData({ harnessProfile: "claude-code", contextFiles: true, tools, vendorPrompt: true }),
			);
			expect(rendered).toContain(
				"Context files above auto-loaded. NEVER search for `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, or similar agent/context files",
			);
			const served = new Set(tools.tools.map(name => tools.wire[name]));
			const mentioned = [...rendered.matchAll(/`([A-Za-z_]+)`/g)]
				.map(match => match[1]!)
				.filter(name => TOOL_VOCABULARY[name] === true);
			for (const name of mentioned) expect(served.has(name), `${tools.tools}: ${name}`).toBe(true);
		}
	});

	it("points a truncated tree at Read, adding glob only where it is served", () => {
		const render = (tools: (typeof TOOL_SETS)[number]) =>
			prompt.render(
				projectPromptTemplate,
				projectData({ harnessProfile: "claude-code", contextFiles: false, tools, vendorPrompt: true }),
			);
		expect(render(TOOL_SETS[0]!)).toContain("Some entries elided to shorten tree — use `glob`/`Read` to drill in.");
		expect(render(TOOL_SETS[1]!)).toContain("Some entries elided to shorten tree — use `Read` to drill in.");
		expect(render(TOOL_SETS[2]!)).not.toContain("Some entries elided");
	});
});
