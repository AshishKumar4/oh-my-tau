import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { loadRoleAgents } from "@oh-my-pi/pi-coding-agent/modes/agents-hub-deps";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";

/** No CLI, configured or installed extension roots: only the project and bundled agents. */
const NO_EXTENSIONS: EffectiveExtensionRoots = {
	explicit: [],
	mode: "explicit-only",
	configured: [],
	configuredLevel: "user",
};

function agentFile(name: string, model: string): string {
	return ["---", `name: ${name}`, `description: ${name} agent`, `model: "${model}"`, "---", `Be ${name}.`].join("\n");
}

describe("loadRoleAgents", () => {
	let tempDir: string;
	let projectDir: string;
	let originalClaudeConfigDir: string | undefined;

	beforeEach(() => {
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		restoreEnvValue("CLAUDE_CONFIG_DIR", undefined);
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-role-agents-"));
		const home = path.join(tempDir, "home");
		projectDir = path.join(tempDir, "project");
		const agentsDir = path.join(projectDir, ".omp", "agents");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(agentsDir, { recursive: true });
		// User agents and plugin registries resolve under this empty home, never the real one.
		vi.spyOn(os, "homedir").mockReturnValue(home);
		clearClaudePluginRootsCache();
		fs.writeFileSync(path.join(agentsDir, "planner.md"), agentFile("planner", "@slow"));
		fs.writeFileSync(path.join(agentsDir, "idle-planner.md"), agentFile("idle-planner", "@slow"));
		fs.writeFileSync(path.join(agentsDir, "pinned.md"), agentFile("pinned", "anthropic/claude-sonnet-4-5"));
		fs.writeFileSync(path.join(agentsDir, "triage.md"), agentFile("triage", "@REVIEWER"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearClaudePluginRootsCache();
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		removeSyncWithRetries(tempDir);
	});

	test("groups enabled agents under the role their effective model names", async () => {
		const settings = Settings.isolated({
			modelRoles: {
				slow: "anthropic/claude-opus-4-5",
				smol: "anthropic/claude-haiku-4-5",
				REVIEWER: "openai/gpt-5.6",
			},
			"task.agentModelOverrides": {
				reviewer: "@REVIEWER",
				"security-reviewer": ["@REVIEWER"],
				scout: "openai/gpt-5.6-mini",
			},
			"task.disabledAgents": ["idle-planner"],
		});

		const roleAgents = await loadRoleAgents(projectDir, settings, NO_EXTENSIONS);

		// The bundled reviewers follow their overrides onto the custom role; the agent file's own
		// `@REVIEWER` joins them, and the names come back sorted.
		expect(roleAgents.get("REVIEWER")).toEqual(["reviewer", "security-reviewer", "triage"]);
		// The bundled reviewer's `@slow` is overridden away and the disabled planner is left out.
		expect(roleAgents.get("slow")).toEqual(["planner"]);
		// A literal override takes scout off `@smol`; sonic keeps it.
		expect(roleAgents.get("smol")).toEqual(["sonic"]);
		const onAnyRole = [...roleAgents.values()].flat();
		expect(onAnyRole).not.toContain("pinned");
		expect(onAnyRole).not.toContain("scout");
		expect(onAnyRole).not.toContain("idle-planner");
	});
});
