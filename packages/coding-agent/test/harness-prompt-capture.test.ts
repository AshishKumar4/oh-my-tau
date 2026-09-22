import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildAnthropicSystemBlocks } from "@oh-my-pi/pi-ai/providers/anthropic";
import { claudeCodeSystemInstruction } from "@oh-my-pi/pi-ai/providers/claude-code-fingerprint";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	HARNESS_CAPTURE_SCHEMA,
	resetHarnessPromptCache,
	servedHarnessPrompt,
} from "@oh-my-pi/pi-coding-agent/harness/capture";
import { buildSystemPrompt as buildSdkSystemPrompt } from "@oh-my-pi/pi-coding-agent/sdk";
import { buildSystemPrompt, type SystemPromptToolMetadata } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { withHarnessCacheDir } from "./helpers/harness";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

const HARNESS_REPORTING_BLOCK = "# Reporting outcomes\n\nAnswer in one paragraph. \n\n\nNever pad the summary.";
const HARNESS_MAIN_BLOCK = "You are a coding CLI.\n\n## Tone\n\nTerse.\n\n\n## Tools\n\nUse `Bash` for shell work.";
const HARNESS_TEXT = `${HARNESS_REPORTING_BLOCK}\n\n${HARNESS_MAIN_BLOCK}`;
const HARNESS_MEMORY_BLOCK = [
	"You are a coding CLI.",
	"",
	"# Working style",
	"",
	"Be terse.",
	"",
	"# Memory",
	"",
	"You have a persistent file-based memory at `/tmp/ccrec-synthetic/memory/`. Write each fact there with the Write tool.",
	"",
	"# Tools",
	"",
	"Use `Bash` for shell work.",
].join("\n");
const HARNESS_MEMORY_REDACTED = [
	"You are a coding CLI.",
	"",
	"# Working style",
	"",
	"Be terse.",
	"",
	"# Memory",
	"",
	"You have a persistent file-based memory at `[redacted-session-path]`. Write each fact there with the Write tool.",
	"",
	"# Tools",
	"",
	"Use `Bash` for shell work.",
].join("\n");
const RECORDED_BILLING_BLOCK = "x-anthropic-billing-header: cc_version=2.1.267.abc; cc_entrypoint=cli; cch=9f2c1;";
const AMBIENT_CLAUDE_MD =
	"# CLAUDE.md instructions\n<INSTRUCTIONS>\nDeploy secrets live in vault://prod. Never run terraform apply.\n</INSTRUCTIONS>";

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

const READ_TOOL = new Map<string, SystemPromptToolMetadata>([
	[
		"read",
		{
			label: "Read",
			description: "Reads files from disk.",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	],
]);

interface CaptureOverrides {
	profile?: string;
	entrypoint?: string;
	instructions?: string[];
	tools?: string[];
	declarations?: Array<{ name: string; description: string }>;
	ambient?: string[];
	fallback?: unknown;
	schema?: number;
}

describe("harness prompt custody", () => {
	const dirs = withHarnessCacheDir("omp-harness-prompt-");
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-harness-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir: "", tempHomeDir, originalHome })));

	function writeCapture(overrides: CaptureOverrides = {}): void {
		const profile = overrides.profile ?? "claude-code";
		const entrypoint = overrides.entrypoint ?? "cli";
		const capture = {
			schema: overrides.schema ?? HARNESS_CAPTURE_SCHEMA,
			profile,
			clientVersion: "2.1.267",
			entrypoint,
			capturedAt: "2026-09-09T10:00:00.000Z",
			instructions: overrides.instructions ?? [
				RECORDED_BILLING_BLOCK,
				claudeCodeSystemInstruction,
				HARNESS_REPORTING_BLOCK,
				HARNESS_MAIN_BLOCK,
			],
			tools: overrides.tools ?? ["Bash", "Read", "Edit"],
			...(overrides.declarations !== undefined && { declarations: overrides.declarations }),
			...(overrides.ambient !== undefined && { ambient: overrides.ambient }),
			...(overrides.fallback !== undefined && { fallback: overrides.fallback }),
		};
		const dir = path.join(dirs.cache, profile);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `2.1.267-${entrypoint}.json`), JSON.stringify(capture));
	}

	function build(harnessProfile?: "claude-code" | "codex") {
		return buildSystemPrompt({
			cwd: dirs.root,
			contextFiles: [{ path: path.join(dirs.root, "AGENTS.md"), content: "Project rule: run bun check." }],
			skills: [],
			rules: [],
			toolNames: ["read"],
			tools: READ_TOOL,
			activeRepoContext: null,
			workspaceTree: { ...EMPTY_TREE, rootPath: dirs.root },
			personality: "none",
			...(harnessProfile !== undefined && { harnessProfile }),
		});
	}

	it("serves the vendor's tool descriptions by wire name and keeps omp's directives out of the footer", async () => {
		writeCapture({ declarations: [{ name: "Read", description: "Reads a file from the local filesystem." }] });

		const { systemPrompt } = await build("claude-code");

		const served = servedHarnessPrompt(getBundledModel("anthropic", "claude-opus-5"));
		expect(served?.tools).toEqual({ Read: { description: "Reads a file from the local filesystem." } });
		expect(systemPrompt.join("\n")).not.toContain("<critical>");
		expect((await build()).systemPrompt.join("\n")).toContain("<critical>");
	});

	it("leads with the captured harness text verbatim and leaves the identity line to the wire layer", async () => {
		writeCapture();

		const { systemPrompt } = await build("claude-code");

		expect(systemPrompt[0]).toBe(HARNESS_TEXT);
		expect(systemPrompt.slice(1).join("\n\n")).toContain("Project rule: run bun check.");
		expect(systemPrompt.join("\n\n")).not.toContain("§ Workflow");

		const blocks = buildAnthropicSystemBlocks(systemPrompt, {
			includeClaudeCodeInstruction: true,
			firstUserMessageText: "ship it",
		});
		const texts = blocks?.map(block => block.text) ?? [];
		expect(texts.filter(text => text.includes(claudeCodeSystemInstruction))).toHaveLength(1);
		expect(texts[1]).toBe(claudeCodeSystemInstruction);
		expect(texts[0]).toStartWith("x-anthropic-billing-header:");
		expect(texts.join("\n")).not.toContain("cch=9f2c1");
	});

	it("drops the client's identity block even when the line is not the sentence omp emits", async () => {
		const rewordedIdentity = "You are a shell agent, built on some other product name.";
		writeCapture({ instructions: [RECORDED_BILLING_BLOCK, rewordedIdentity, HARNESS_MAIN_BLOCK] });

		const { systemPrompt } = await build("claude-code");

		expect(systemPrompt[0]).toBe(HARNESS_MAIN_BLOCK);
		expect(systemPrompt.join("\n\n")).not.toContain(rewordedIdentity);
	});

	it("keeps a one-line harness block that no billing header precedes", async () => {
		const oneLineOpener = "Always answer in the user's language.";
		writeCapture({ instructions: [oneLineOpener, HARNESS_MAIN_BLOCK] });

		const { systemPrompt } = await build("claude-code");

		expect(systemPrompt[0]).toBe([oneLineOpener, HARNESS_MAIN_BLOCK].join("\n\n"));
	});

	it("leaves the native prompt untouched when no capture is cached", async () => {
		const [profiled, native] = await Promise.all([build("claude-code"), build()]);

		expect(profiled.systemPrompt).toEqual(native.systemPrompt);
		expect(profiled.systemPrompt[0]).toContain("§ Workflow");
	});

	it("falls back to omp's own prompt for every capture that cannot be the vendor client's request", async () => {
		const branches: Array<{ name: string; overrides: CaptureOverrides }> = [
			{ name: "another client surface", overrides: { entrypoint: "sdk-cli" } },
			{ name: "fallback recording", overrides: { fallback: { reason: "synthesized" } } },
			{ name: "no declared tools", overrides: { tools: [] } },
			{ name: "no harness-owned text", overrides: { instructions: [claudeCodeSystemInstruction] } },
			{ name: "unknown envelope version", overrides: { schema: HARNESS_CAPTURE_SCHEMA + 1 } },
		];

		for (const { name, overrides } of branches) {
			fs.rmSync(dirs.cache, { recursive: true, force: true });
			resetHarnessPromptCache();
			writeCapture(overrides);

			const { systemPrompt } = await build("claude-code");

			expect(systemPrompt.join("\n\n"), name).not.toContain(HARNESS_MAIN_BLOCK);
			expect(systemPrompt[0], name).toContain("§ Workflow");
		}
	});

	it("keeps the user's recorded context file out of the built prompt", async () => {
		writeCapture({
			instructions: [HARNESS_REPORTING_BLOCK, HARNESS_MAIN_BLOCK, AMBIENT_CLAUDE_MD],
			ambient: [AMBIENT_CLAUDE_MD, "hi"],
		});

		const { systemPrompt } = await build("claude-code");
		const promptText = systemPrompt.join("\n\n");

		expect(systemPrompt[0]).toBe(HARNESS_TEXT);
		expect(promptText).not.toContain("vault://prod");
		expect(promptText).not.toContain("# CLAUDE.md instructions");
	});

	it("redacts the recording-session path in place while keeping the memory section byte-exact", async () => {
		writeCapture({ instructions: [RECORDED_BILLING_BLOCK, claudeCodeSystemInstruction, HARNESS_MEMORY_BLOCK] });

		const { systemPrompt } = await build("claude-code");

		expect(systemPrompt[0]).toBe(HARNESS_MEMORY_REDACTED);
		expect(systemPrompt[0]).toContain("# Memory");
		expect(systemPrompt.join("\n\n")).not.toContain("/tmp/ccrec-synthetic");
	});

	it("keeps a vendor section that merely mentions a path, redacting only the token", async () => {
		const toolsNote = "# Tools\n\nPrefer the file tools; shell logs land under /tmp/vendor-logs/ on failure.";
		writeCapture({ instructions: [RECORDED_BILLING_BLOCK, claudeCodeSystemInstruction, toolsNote] });

		const { systemPrompt } = await build("claude-code");

		expect(systemPrompt[0]).toBe(
			"# Tools\n\nPrefer the file tools; shell logs land under [redacted-session-path] on failure.",
		);
	});

	it("redacts session paths under roots the old content sniff missed", async () => {
		const exotic = "# Memory\n\nState lives at /root/.config/s1 on this machine.";
		const windows = "# Tools\n\nPer-machine state lives at C:\\Users\\bot\\memory on this machine.";
		writeCapture({ instructions: [RECORDED_BILLING_BLOCK, claudeCodeSystemInstruction, exotic, windows] });

		const { systemPrompt } = await build("claude-code");
		const promptText = systemPrompt.join("\n\n");

		expect(promptText).not.toContain("/root/.config/s1");
		expect(promptText).not.toContain("C:\\Users\\bot\\memory");
		expect(promptText).toContain("# Memory");
		expect(promptText).toContain("# Tools");
	});

	it("leaves bare environment references the vendor wrote generically untouched", async () => {
		const sandbox = "# Sandboxing\n\nNever repurpose `$HOME`; do not use `$HOME`, `~`, or `/` as a command target.";
		writeCapture({ instructions: [RECORDED_BILLING_BLOCK, claudeCodeSystemInstruction, sandbox] });

		const { systemPrompt } = await build("claude-code");

		expect(systemPrompt[0]).toBe(sandbox);
	});

	it("routes each profile to its own capture", async () => {
		const codexText = "You are Codex.\n\n# Sandboxing\n\nAsk before writing outside the workspace.";
		writeCapture();
		writeCapture({
			profile: "codex",
			entrypoint: "codex_exec",
			instructions: [codexText],
			tools: ["exec", "request_user_input"],
		});

		const { systemPrompt } = await build("codex");

		expect(systemPrompt[0]).toBe(codexText);
		expect(systemPrompt.join("\n\n")).not.toContain(HARNESS_MAIN_BLOCK);
	});

	it("forwards the model's harness profile through the public SDK entry point", async () => {
		writeCapture();

		const profiled = await buildSdkSystemPrompt({
			model: getBundledModel("anthropic", "claude-opus-5"),
			cwd: dirs.root,
		});
		const unprofiled = await buildSdkSystemPrompt({
			model: getBundledModel("anthropic", "claude-haiku-4-5"),
			cwd: dirs.root,
		});

		expect(profiled.systemPrompt[0]).toBe(HARNESS_TEXT);
		expect(unprofiled.systemPrompt[0]).toContain("§ Workflow");
	});
});
