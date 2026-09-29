import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import projectPromptTemplate from "../src/prompts/system/project-prompt.md" with { type: "text" };
// The template as it stood before the claude-code condition was added.
import projectPromptBefore from "./fixtures/harness/project-prompt.before.md" with { type: "text" };

const TOOL_SETS: ReadonlyArray<{ tools: string[]; toolRefs: Record<string, string> }> = [
	{
		tools: ["read", "grep", "glob", "edit", "bash"],
		toolRefs: { read: "read", grep: "grep", glob: "glob", edit: "edit", bash: "bash" },
	},
	{ tools: ["read", "edit", "bash"], toolRefs: { read: "read", edit: "edit", bash: "bash" } },
	{ tools: ["bash"], toolRefs: { bash: "bash" } },
];

function projectData(options: {
	harnessProfile: string | undefined;
	contextFiles: boolean;
	tools: (typeof TOOL_SETS)[number];
	vendorPrompt: boolean;
}): Record<string, unknown> {
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
		toolRefs: options.tools.toolRefs,
		additionalWorkspaceRoots: ["/extra"],
		activeRepoContext: "",
		vendorPrompt: options.vendorPrompt,
		appendPrompt: "",
		...(options.harnessProfile === undefined ? {} : { harnessProfile: options.harnessProfile }),
	};
}

describe("project prompt under harness profiles", () => {
	it("renders byte-identical to the template before the claude-code condition off that profile", () => {
		for (const harnessProfile of [undefined, "codex", "pi"]) {
			for (const contextFiles of [true, false]) {
				for (const tools of TOOL_SETS) {
					for (const vendorPrompt of [true, false]) {
						const data = projectData({ harnessProfile, contextFiles, tools, vendorPrompt });
						expect(prompt.render(projectPromptTemplate, data), `${harnessProfile} ${tools.tools}`).toBe(
							prompt.render(projectPromptBefore, data),
						);
					}
				}
			}
		}
	});

	it("tells Claude Code not to search for context files without naming tools it may not serve", () => {
		for (const tools of TOOL_SETS) {
			const rendered = prompt.render(
				projectPromptTemplate,
				projectData({ harnessProfile: "claude-code", contextFiles: true, tools, vendorPrompt: true }),
			);
			expect(rendered).toContain(
				"Context files above auto-loaded. NEVER search for `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, or similar agent/context files",
			);
			expect(rendered).not.toContain("`grep`/`glob`");
		}
	});
});
