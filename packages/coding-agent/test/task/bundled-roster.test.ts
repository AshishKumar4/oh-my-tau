/**
 * The bundled roster: `task` is a laborer that cannot spawn, `scout` reads and
 * runs read-only commands but cannot edit, and the retired `sonic` and
 * `security-reviewer` agents are gone from discovery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const NO_EXTENSIONS: EffectiveExtensionRoots = {
	explicit: [],
	mode: "explicit-only",
	configured: [],
	configuredLevel: "user",
};

function bundled(name: string): AgentDefinition {
	const agent = getBundledAgent(name);
	if (!agent) throw new Error(`Expected bundled agent ${name}`);
	return agent;
}

/** Run `agent` through the executor and return the options its child session was created with. */
async function childSessionOptions(agent: AgentDefinition): Promise<CreateAgentSessionOptions> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model claude-sonnet-4-5");
	const registry = {
		authStorage: {},
		refresh: async () => {},
		awaitBackgroundRefresh: async () => {},
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
		hasConfiguredAuth: () => true,
	} as unknown as ModelRegistry;
	const captured = Promise.withResolvers<CreateAgentSessionOptions>();
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		if (!options) throw new Error("expected session options");
		captured.resolve(options);
		throw new Error("stop after capturing the child session options");
	});
	await runSubprocess({
		cwd: "/tmp",
		task: "do work",
		index: 0,
		id: `Roster${agent.name}`,
		settings: Settings.isolated(),
		modelRegistry: registry,
		enableLsp: false,
		agent: { ...agent, model: [`${model.provider}/${model.id}`] },
	});
	return captured.promise;
}

describe("bundled agent roster", () => {
	let tempDir: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bundled-roster-"));
		const home = path.join(tempDir, "home");
		projectDir = path.join(tempDir, "project");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
		// User agents and plugin registries resolve under this empty home, never the real one.
		vi.spyOn(os, "homedir").mockReturnValue(home);
		clearClaudePluginRootsCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearClaudePluginRootsCache();
		removeSyncWithRetries(tempDir);
	});

	it("discovers only scout, reviewer and task as bundled agents", async () => {
		const { agents } = await discoverAgents(projectDir, os.homedir(), NO_EXTENSIONS);

		const bundledNames = agents.filter(agent => agent.source === "bundled").map(agent => agent.name);
		expect(bundledNames.sort()).toEqual(["reviewer", "scout", "task"]);
	});

	it("gives the task agent's session no spawn allowance", async () => {
		expect(bundled("task").spawns).toBeUndefined();

		const options = await childSessionOptions(bundled("task"));

		expect(options.spawns).toBe("");
	});

	it("gives scout bash for git and data collection but no edit or write tools", async () => {
		const options = await childSessionOptions(bundled("scout"));

		expect(options.toolNames).toContain("bash");
		expect(options.toolNames).not.toContain("edit");
		expect(options.toolNames).not.toContain("write");
		expect(options.toolNames).not.toContain("task");
		expect(options.spawns).toBe("");
	});
});
