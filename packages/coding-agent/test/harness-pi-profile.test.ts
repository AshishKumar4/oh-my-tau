import { beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import {
	HARNESS_CAPTURE_SCHEMA,
	loadHarnessPrompt,
	resetHarnessPromptCache,
} from "@oh-my-pi/pi-coding-agent/harness/capture";
import { effectiveHarnessProfile } from "@oh-my-pi/pi-coding-agent/harness/effective-profile";
import { harnessFacadeSpecs } from "@oh-my-pi/pi-coding-agent/harness/facades";
import { harnessToolBinding, harnessWireRenames } from "@oh-my-pi/pi-coding-agent/harness/manifest";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";

// Fable is claude-code-profiled; Muse is unprofiled.
const FABLE = getBundledModel("anthropic", "claude-fable-5-1");
const MUSE = getBundledModel("opencode-zen", "muse-spark-1.3-contributor-free");

const EMPTY_TREE = {
	rootPath: "",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [],
};

describe("pi harness profile", () => {
	beforeEach(() => {
		resetHarnessPromptCache();
	});

	it("pins the pi manifest: one rename, natives untouched, no facades", () => {
		expect(harnessWireRenames("pi")).toEqual({ glob: "find" });
		// omp tools sharing pi's vocabulary keep their own names; pi-only tools
		// (ls, powershell) have no omp equivalent to bind.
		expect(harnessToolBinding("pi", "read")).toBeUndefined();
		expect(harnessToolBinding("pi", "bash")).toBeUndefined();
		expect(harnessToolBinding("pi", "edit")).toBeUndefined();
		expect(harnessToolBinding("pi", "write")).toBeUndefined();
		expect(harnessToolBinding("pi", "grep")).toBeUndefined();
		expect(harnessToolBinding("pi", "ls")).toBeUndefined();
		expect(harnessToolBinding("pi", "powershell")).toBeUndefined();
		expect(harnessFacadeSpecs("pi")).toEqual([]);
	});

	it("serves the bundled prompt with no capture directory", async () => {
		// No harness cache dir is set up in this suite: pi's prompt must come
		// from the binary, not the filesystem.
		const served = await loadHarnessPrompt("pi");
		if (served === null) throw new Error("expected the bundled pi prompt to serve");

		expect(served.clientVersion).toBe("bundled");
		expect(served.path).toBe("bundled:pi");
		expect(served.tools).toEqual({});
		// Skeleton sections per pi's assembled prompt: preamble + tools +
		// rules + docs + cwd.
		expect(served.text).toContain("You are an expert coding assistant operating inside pi, a coding agent harness.");
		expect(served.text).toContain("<tools>");
		expect(served.text).toContain("- read: Read file contents");
		expect(served.text).toContain("- bash: Execute bash commands");
		expect(served.text).toContain("<rules>");
		expect(served.text).toContain("<docs>");
		expect(served.text).toContain("<cwd>");
		// pi's install-local doc paths must not leak into the bundled text.
		expect(served.text).not.toContain("node_modules");
	});

	it("renders the cwd placeholder and strips the attribution comment at build time", async () => {
		const dir = TempDir.createSync("@pi-harness-pi-");
		try {
			const { systemPrompt } = await buildSystemPrompt({
				cwd: dir.path(),
				contextFiles: [],
				skills: [],
				rules: [],
				personality: "none",
				workspaceTree: { ...EMPTY_TREE, rootPath: dir.path() },
				activeRepoContext: null,
				harnessProfile: "pi",
			});

			const text = systemPrompt.join("\n\n");
			expect(text).not.toContain("{{cwd}}");
			expect(text).not.toContain("{{!");
			expect(text).toContain(`\n${dir.path()}\n`);
			// The bundled pi block leads; omp's footer follows, same as the
			// recorded profiles.
			expect(systemPrompt[0]).toContain("operating inside pi");
		} finally {
			dir.removeSync();
		}
	});

	it("never serves a stray pi capture from the cache directory", async () => {
		const temp = TempDir.createSync("@pi-harness-pi-capture-");
		try {
			const dir = `${temp.path()}/harness-cache/pi`;
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(
				`${dir}/0.85.1-cli.json`,
				JSON.stringify({
					schema: HARNESS_CAPTURE_SCHEMA,
					profile: "pi",
					clientVersion: "0.85.1",
					entrypoint: "cli",
					instructions: ["You are a forged pi capture."],
					tools: ["read"],
				}),
			);
			process.env.OMP_HARNESS_CACHE_DIR = `${temp.path()}/harness-cache`;
			resetHarnessPromptCache();

			const served = await loadHarnessPrompt("pi");
			if (served === null) throw new Error("expected the bundled pi prompt to serve");
			expect(served.text).toContain("operating inside pi");
			expect(served.text).not.toContain("forged pi capture");
			expect(served.clientVersion).toBe("bundled");
		} finally {
			delete process.env.OMP_HARNESS_CACHE_DIR;
			resetHarnessPromptCache();
			temp.removeSync();
		}
	});

	it("forces pi onto an unprofiled model while native and auto stay generic", () => {
		const pi = Settings.isolated({ "harness.mode": "pi" });
		const native = Settings.isolated({ "harness.mode": "native" });
		const auto = Settings.isolated({});

		expect(effectiveHarnessProfile(pi, MUSE)).toBe("pi");
		expect(effectiveHarnessProfile(pi, FABLE)).toBe("pi");
		expect(effectiveHarnessProfile(native, FABLE)).toBeUndefined();
		expect(effectiveHarnessProfile(auto, MUSE)).toBeUndefined();
		expect(effectiveHarnessProfile(auto, FABLE)).toBe("claude-code");
	});
});
