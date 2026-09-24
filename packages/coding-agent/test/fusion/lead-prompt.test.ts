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
		const text = await build({ toolNames: ["read", "wait", "sidekick"] });
		expect(text).toContain("`sidekick` tool");
		expect(text).toContain("persistent");
		// The readTool slot resolves to the native job-wait tool.
		expect(text).toContain("wait for the report with `wait`");
		expect(text).not.toContain("{{");

		const off = await build({ toolNames: ["read", "wait"] });
		expect(off).not.toContain("`sidekick` tool");
		expect(off).not.toContain("persistent");
	});

	it("renders in the custom (harness) template with the profile's wait facade and identity", async () => {
		const text = await build({
			toolNames: ["read", "wait", "sidekick"],
			harnessProfile: "claude-code",
			customPrompt: "VENDOR PROMPT",
			browserEnabled: true,
		});
		expect(text).toContain("VENDOR PROMPT");
		expect(text).toContain("wait for the report with `TaskOutput`");
		expect(text).toContain("one Claude Code: you");
		// The GPT-lead extra-detail block stays gated to the Codex profile.
		expect(text).not.toContain("Concrete implementation packets");

		const codex = await build({ toolNames: ["wait", "sidekick"], harnessProfile: "codex", customPrompt: "VENDOR" });
		expect(codex).toContain("wait for the report with `wait`");
		expect(codex).toContain("one Codex: you");
		expect(codex).toContain("Concrete implementation packets");

		const customOff = await build({ toolNames: ["read", "wait"], customPrompt: "VENDOR PROMPT" });
		expect(customOff).not.toContain("`sidekick` tool");
	});
});
