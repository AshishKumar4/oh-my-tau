/**
 * Built-in flows spawn the bundled agent that fits their work: `omp commit`
 * file analysis only reads, so it runs `scout`; `/cleanse` repair workers edit,
 * so they run `task`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createCleanseAgentRuntime } from "@oh-my-pi/pi-coding-agent/cleanse/agent";
import { runCommitAgentSession } from "@oh-my-pi/pi-coding-agent/commit/agentic/agent";
import * as modelResolver from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

function model() {
	const found = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!found) throw new Error("Expected bundled model claude-sonnet-4-5");
	return found;
}

/** Capture every subagent the flow dispatches; each finishes at once with a fixed payload. */
function captureSpawns(): ExecutorOptions[] {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: loadBundledAgents(),
		projectAgentsDir: null,
	});
	const spawned: ExecutorOptions[] = [];
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async (options): Promise<SingleResult> => {
		spawned.push(options);
		return {
			index: options.index ?? 0,
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
			requests: 1,
		};
	});
	return spawned;
}

describe("built-in flow agent routing", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-consumer-agent-routing-");
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir.removeSync();
	});

	it("analyzes commit files with scout under the analysis output schema", async () => {
		await $`git init -q`.cwd(tempDir.path());
		const settings = Settings.isolated({ "task.isolation.enabled": false });
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "agent.db"));
		const created = Promise.withResolvers<CreateAgentSessionOptions>();
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			created.resolve(options);
			throw new Error("stop after capturing the commit session options");
		});
		await runCommitAgentSession({
			cwd: tempDir.path(),
			model: model(),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			authStorage,
			changelogTargets: [],
			requireChangelog: false,
		}).catch(() => undefined);
		const commitSession = await created.promise;
		expect(commitSession.spawns).toBe("scout");
		const analyze = commitSession.customTools?.find(tool => tool.name === "analyze_files");
		if (!analyze) throw new Error("expected the analyze_files tool");

		const spawned = captureSpawns();
		const ctx = { sessionManager: { getSessionFile: () => null } } as unknown as CustomToolContext;
		await analyze.execute("analyze", { files: ["src/a.ts"] }, undefined, ctx, undefined);

		expect(spawned.map(options => options.agent.name)).toEqual(["scout"]);
		expect(spawned[0]?.outputSchemaSource).toBe("caller");
		expect(spawned[0]?.outputSchema).toMatchObject({
			properties: { summary: { type: "string" }, highlights: {}, risks: {} },
		});
		authStorage.close();
	});

	it("repairs cleanse diagnostics with task workers", async () => {
		const sessionsDir = path.join(tempDir.path(), "sessions");
		const createSession = SessionManager.create.bind(SessionManager);
		// Keep the cleanse journal out of the real sessions directory.
		vi.spyOn(SessionManager, "create").mockImplementation(cwd => createSession(cwd, sessionsDir));
		vi.spyOn(Settings, "init").mockResolvedValue(Settings.isolated({ "task.isolation.enabled": false }));
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "agent.db"));
		vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
		vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
		const resolved = model();
		vi.spyOn(modelResolver, "resolveCliModel").mockReturnValue({
			model: resolved,
			selector: `${resolved.provider}/${resolved.id}`,
			warning: undefined,
			error: undefined,
		});
		const spawned = captureSpawns();

		const runtime = await createCleanseAgentRuntime({ cwd: tempDir.path(), model: "sonnet" });
		const outcome = await runtime.dispatchWorker(
			{
				index: 0,
				weight: 1,
				groups: [
					{
						file: "src/a.ts",
						weight: 1,
						diagnostics: [{ checker: "tsc", file: "src/a.ts", line: 1, severity: "error", message: "boom" }],
					},
				],
			},
			{ worker: 1, peers: [], checkers: [] },
		);
		await runtime.close();

		expect(outcome.success).toBe(true);
		expect(spawned.map(options => options.agent.name)).toEqual(["task"]);
		authStorage.close();
	});
});
