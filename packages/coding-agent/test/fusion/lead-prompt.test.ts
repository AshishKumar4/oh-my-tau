import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildSystemPrompt, type SystemPromptToolMetadata } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { TempDir } from "@oh-my-pi/pi-utils";

const EMPTY_TREE = { rootPath: "", rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] };

function meta(label: string, wireName?: string): SystemPromptToolMetadata {
	return { label, description: `${label} tool.`, parameters: { type: "object", properties: {} }, wireName };
}

describe("fusion lead prompt section", () => {
	let tempDir: TempDir;
	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-fusion-prompt-");
	});
	afterAll(() => {
		tempDir.removeSync();
	});

	async function build(options: {
		toolNames: string[];
		harnessProfile?: "claude-code" | "codex";
		customPrompt?: string;
		browserEnabled?: boolean;
	}): Promise<string> {
		const tools = new Map<string, SystemPromptToolMetadata>(options.toolNames.map(name => [name, meta(name)]));
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir.path(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames: options.toolNames,
			tools,
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir.path() },
			personality: "none",
			browserEnabled: options.browserEnabled ?? false,
			...(options.customPrompt !== undefined && { resolvedCustomPrompt: options.customPrompt }),
			...(options.harnessProfile !== undefined && { harnessProfile: options.harnessProfile }),
		});
		return systemPrompt.join("\n\n");
	}

	it("renders only when the sidekick tool is mounted, resolving the wait tool and identity natively", async () => {
		const text = await build({ toolNames: ["read", "hub", "sidekick"] });
		expect(text).toContain("You have a `sidekick` tool: a persistent subagent");
		expect(text).toContain("wait for it with `hub` (`block: true`)");
		expect(text).toContain("The user interacts with one assistant: you.");
		expect(text).toContain("The sidekick is available for delegating mechanical work");

		const off = await build({ toolNames: ["read", "hub"] });
		expect(off).not.toContain("You have a `sidekick` tool");
		expect(off).not.toContain("delegating mechanical work");
	});

	it("renders in the custom (harness) template with the profile's wait facade and identity", async () => {
		const text = await build({
			toolNames: ["read", "hub", "sidekick"],
			harnessProfile: "claude-code",
			customPrompt: "VENDOR PROMPT",
			browserEnabled: true,
		});
		expect(text).toContain("VENDOR PROMPT");
		expect(text).toContain("wait for it with `TaskOutput` (`block: true`)");
		expect(text).toContain("The user interacts with one Claude Code: you.");

		const codex = await build({ toolNames: ["hub", "sidekick"], harnessProfile: "codex", customPrompt: "VENDOR" });
		expect(codex).toContain("wait for it with `wait` (`block: true`)");
		expect(codex).toContain("The user interacts with one Codex: you.");

		const customOff = await build({ toolNames: ["read", "hub"], customPrompt: "VENDOR PROMPT" });
		expect(customOff).not.toContain("You have a `sidekick` tool");
	});
});
