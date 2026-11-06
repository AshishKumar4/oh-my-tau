/**
 * Contract: a vibe worker's spawn options carry the pre-expansion model role
 * and an id built from the worker name the user passed in.
 *
 * `#resolveWorker` expands the worker's role alias (`good` -> `task` -> `@task`,
 * `fast` -> `task` on its `@smol` tier) into concrete patterns, so the role
 * survives only as a separate field forwarded across `ResolvedVibeWorker` ->
 * `VibeRecord` -> `#buildSpawnOptions` -> `runSubprocess`. The executor keys the
 * child's inherited `retry.fallbackChains` entry off it; drop any link in that
 * chain and vibe children silently retry on the `default` role's chain.
 *
 * The id keeps only `[A-Za-z0-9_-]` from that name and falls back to a
 * generated name when nothing survives.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { cfgAdvisorEnabled } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as nameGenerator from "@oh-my-pi/pi-coding-agent/task/name-generator";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { VibeCli } from "@oh-my-pi/pi-tui/tools/vibe";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";

const realRunSubprocess = executorModule.runSubprocess;

function makeParentSession(settings: Settings): ToolSession {
	return {
		cwd: "/tmp",
		settings,
		asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
		getSessionId: () => "parent-session",
		// No session file: spawn skips lifecycle persistence and stays in-memory.
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		taskDepth: 0,
		enableLsp: false,
	} as unknown as ToolSession;
}

/** Spawn one worker and capture the ExecutorOptions the vibe path hands the executor. */
async function spawnAndCaptureOptions(cli: VibeCli, settings: Settings, name?: string): Promise<ExecutorOptions> {
	const captured = Promise.withResolvers<ExecutorOptions>();
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		captured.resolve(options);
		return {
			index: 0,
			id: options.id,
			agent: options.agent.name,
			agentSource: "bundled",
			task: options.task,
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		} as SingleResult;
	});

	const registry = VibeSessionRegistry.global();
	await registry.spawn(makeParentSession(settings), { cli, name, prompt: "work" });
	return captured.promise;
}

describe("vibe worker spawn options", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("forwards the `task` role behind the `good` worker's expanded patterns", async () => {
		const options = await spawnAndCaptureOptions(
			"good",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" },
			}),
		);

		expect(options.modelOverride).toEqual(["anthropic/sonnet"]);
		expect(options.modelRole).toBe("task");
	});

	it("forwards the `smol` role behind the `fast` worker's expanded patterns", async () => {
		const options = await spawnAndCaptureOptions(
			"fast",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", smol: "fast/hy3" },
			}),
		);

		expect(options.modelOverride).toEqual(["fast/hy3"]);
		expect(options.modelRole).toBe("smol");
	});

	it("runs the `fast` tier on the edit-capable `task` agent at medium thinking", async () => {
		const options = await spawnAndCaptureOptions(
			"fast",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", smol: "fast/hy3" },
			}),
		);

		expect(options.agent.name).toBe("task");
		// No explicit tool list: the worker keeps the full coding surface, edit and write included.
		expect(options.agent.tools).toBeUndefined();
		expect(options.thinkingLevel).toBe(Effort.Medium);
	});

	it("keeps the `fast` tier on `@smol` when `task` has a per-agent model override", async () => {
		const options = await spawnAndCaptureOptions(
			"fast",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", smol: "fast/hy3" },
				"task.agentModelOverrides": { task: "openai-codex/sol" },
			}),
		);

		expect(options.modelOverride).toEqual(["fast/hy3"]);
		expect(options.modelRole).toBe("smol");
	});

	it("keeps the `fast` tier off `task`'s per-agent prewalk and advisor", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const target = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!primary || !target) throw new Error("Expected bundled Claude models");
		const modelRegistry = {
			authStorage: {},
			refresh: async () => {},
			awaitBackgroundRefresh: async () => {},
			getAvailable: () => [primary, target],
			getApiKey: async () => "test-key",
			hasConfiguredAuth: () => true,
		} as unknown as ModelRegistry;
		// Ordinary `task` spawns hand off to a prewalk target and get an advisor.
		const settings = Settings.isolated({
			modelRoles: {
				default: "anthropic/claude-sonnet-4-5",
				task: "anthropic/claude-sonnet-4-5",
				smol: "anthropic/claude-sonnet-4-5",
			},
			"task.agentPrewalk": { task: "anthropic/claude-sonnet-4-6" },
			"task.agentAdvisor": { task: "on" },
		});
		const sessions = new Map<VibeCli, CreateAgentSessionOptions>();
		for (const cli of ["fast", "good"] as const) {
			const options = await spawnAndCaptureOptions(cli, settings);
			vi.restoreAllMocks();
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async created => {
				if (!created) throw new Error("expected session options");
				sessions.set(cli, created);
				throw new Error("stop after capturing the worker session options");
			});
			await realRunSubprocess({ ...options, modelRegistry });
			vi.restoreAllMocks();
		}

		const fast = sessions.get("fast");
		const good = sessions.get("good");
		if (!fast?.settings || !good?.settings) throw new Error("expected both worker sessions");
		expect(fast.prewalk).toBeUndefined();
		expect(cfgAdvisorEnabled.get(fast.settings)).toBe(false);
		expect(good.prewalk?.target.id).toBe(target.id);
		expect(cfgAdvisorEnabled.get(good.settings)).toBe(true);
	});

	it("keeps the role identity when a per-agent model override replaces the alias", async () => {
		// `task.agentModelOverrides` wins over the agent definition, and an explicit
		// selector carries no role — the child must then inherit `default`, not
		// capture the routing of whichever role happens to name the same model.
		const options = await spawnAndCaptureOptions(
			"good",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" },
				"task.agentModelOverrides": { task: "openai-codex/sol" },
			}),
		);

		expect(options.modelOverride).toEqual(["openai-codex/sol"]);
		expect(options.modelRole).toBeUndefined();
	});

	it("restricts the first spawn to the worker agent's account pool, as revival does", async () => {
		// Without it a worker runs unrestricted until it is parked and revived.
		const options = await spawnAndCaptureOptions(
			"good",
			Settings.isolated({
				modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" },
				"task.agentAccountPools": {
					task: { anthropic: ["email:a@example.com|org:org-a"] },
					sonic: { anthropic: [] },
				},
			}),
		);

		expect(options.oauthAccountPools).toEqual({ anthropic: ["email:a@example.com|org:org-a"] });
	});

	it("keeps only [A-Za-z0-9_-] from a custom worker name", async () => {
		const options = await spawnAndCaptureOptions("good", Settings.isolated(), "../My Worker!");

		expect(options.id).toBe("MyWorker");
	});

	it("falls back to a generated name when nothing in the custom name survives", async () => {
		vi.spyOn(nameGenerator, "generateTaskName").mockReturnValue("GeneratedWorker");

		const options = await spawnAndCaptureOptions("good", Settings.isolated(), "!!!");

		expect(options.id).toBe("GeneratedWorker");
	});
});
