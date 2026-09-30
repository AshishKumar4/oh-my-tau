import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { VendorTool } from "@oh-my-pi/pi-coding-agent/harness/capture";
import { harnessSurface } from "@oh-my-pi/pi-coding-agent/harness/facades";
import { buildSystemPrompt, type SystemPromptToolMetadata } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { TempDir } from "@oh-my-pi/pi-utils";

const TASK_OUTPUT: VendorTool = { description: "Retrieves output", inputSchema: {} };

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
		/** Claude Code only: the served capture still declares TaskOutput (pre-2.1.284). */
		taskOutput?: boolean;
	}): Promise<string> {
		// What the session hands the builder under Claude Code: the presented surface's refs.
		const surface =
			options.harnessProfile === "claude-code"
				? harnessSurface("claude-code", options.toolNames, {
						settings: Settings.isolated(),
						vendorTool: name => (options.taskOutput && name === "TaskOutput" ? TASK_OUTPUT : undefined),
					})
				: undefined;
		const toolNames = options.toolNames;
		const tools = new Map<string, SystemPromptToolMetadata>(toolNames.map(name => [name, meta(name)]));
		const { systemPrompt } = await buildSystemPrompt({
			cwd: tempDir.path(),
			contextFiles: [],
			skills: [],
			rules: [],
			toolNames,
			tools,
			...(surface && { harnessToolRefs: surface.toolRefs }),
			workspaceTree: { ...EMPTY_TREE, rootPath: tempDir.path() },
			personality: "none",
			evalPreludes: options.browserEnabled ? [{ name: "browser" }] : [],
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
		// A capture that still declares TaskOutput: it stands in for `wait`.
		const text = await build({
			toolNames: ["read", "wait", "sidekick"],
			harnessProfile: "claude-code",
			customPrompt: "VENDOR PROMPT",
			browserEnabled: true,
			taskOutput: true,
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

	it("names `wait` for a Claude Code lead whose capture declares no TaskOutput", async () => {
		// A 2.1.284 capture declares no TaskOutput, so `wait` is presented as itself.
		const text = await build({
			toolNames: ["read", "wait", "sidekick"],
			harnessProfile: "claude-code",
			customPrompt: "VENDOR PROMPT",
		});
		expect(text).toContain("`sidekick` tool");
		expect(text).toContain("wait for the report with `wait`");
		expect(text).not.toContain("TaskOutput");
		expect(text).not.toContain("end your turn; the report arrives as a notification.");
		expect(text).not.toContain("undefined");
	});

	it("tells a Claude Code lead with no wait tool to end its turn for the report", async () => {
		const text = await build({
			toolNames: ["read", "sidekick"],
			harnessProfile: "claude-code",
			customPrompt: "VENDOR PROMPT",
		});
		expect(text).toContain("`sidekick` tool");
		expect(text).toContain("end your turn; the report arrives as a notification.");
		expect(text).not.toContain("TaskOutput");
		expect(text).not.toContain("wait for the report with");
		expect(text).not.toContain("undefined");
	});
});
