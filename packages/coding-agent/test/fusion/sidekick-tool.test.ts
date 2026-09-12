import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { findSidekickRef, listSidekickRefs } from "@oh-my-pi/pi-coding-agent/fusion/config";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getSidekickAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import * as structured from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { BUILTIN_TOOLS, createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SidekickTool } from "@oh-my-pi/pi-coding-agent/tools/sidekick";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const SIDEKICK_ID = "Sidekick";

/** A custom agent definition; `sidekick: true` opts its sessions into leading a sidekick of their own. */
function expertAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "expert",
		description: "Expert lane",
		systemPrompt: "Lead your lane.",
		source: "project",
		...overrides,
	};
}

function singleResult(output: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: SIDEKICK_ID,
		agent: "sidekick",
		agentSource: "bundled",
		task: "handoff",
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 1,
		requests: 1,
		...overrides,
	};
}

/** Mirrors the executor: the spawned agent lands in the registry under the lead that dispatched it. */
function registerSidekick(status: "idle" | "running", session: AgentSession | null = null, parentId = "Main"): void {
	AgentRegistry.global().register({
		id: parentId === "Main" ? SIDEKICK_ID : `${parentId}:${SIDEKICK_ID}`,
		displayName: "sidekick",
		kind: "sub",
		parentId,
		status,
		session,
	});
}

describe("fusion sidekick tool", () => {
	let tempDir: TempDir;
	let modelRegistry: ModelRegistry;
	let manager: AsyncJobManager;
	const deliveries: Array<{ id: string; text: string }> = [];
	const authStorage = createInMemoryAuthStorage();

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-fusion-");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const sidekickModel = createMockModel({ provider: "devin", id: "swe-2" });
		vi.spyOn(modelRegistry, "getAll").mockReturnValue([sidekickModel]);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([sidekickModel]);
		vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(true);
		manager = new AsyncJobManager({ retentionMs: 0 });
		deliveries.length = 0;
		manager.registerDeliverySink("Main", (id, text) => {
			deliveries.push({ id, text });
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const ref of listSidekickRefs()) AgentRegistry.global().unregister(ref.id);
		await manager.dispose();
		tempDir.removeSync();
	});

	function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
		return {
			cwd: tempDir.path(),
			hasUI: false,
			skipPythonPreflight: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			taskDepth: 0,
			modelRegistry,
			asyncJobManager: manager,
			settings: Settings.isolated({
				"fusion.enabled": true,
				"fusion.sidekickModel": "devin/swe-2",
				"task.maxRuntimeMs": 0,
			}),
			...overrides,
		};
	}

	function spawnSpy(output = "spawn report") {
		return vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
			// The executor registers the child under `session.getAgentId()`.
			const leadId = request.session.getAgentId?.() ?? "Main";
			registerSidekick("idle", null, leadId);
			return {
				result: singleResult(output, { id: findSidekickRef(leadId)?.id }),
				policy: {} as structured.EffectiveSubagentPolicy,
				mergeSummary: "",
				changesApplied: null,
				artifactsDir: tempDir.path(),
				temporaryArtifacts: true,
			};
		});
	}

	describe("mounting", () => {
		it("mounts only for a fusion lead whose sidekick model resolves with auth", async () => {
			const names = async (session: ToolSession) => (await createTools(session, ["read"])).map(tool => tool.name);
			expect(await names(makeSession())).toContain("sidekick");
			expect(await names(makeSession({ settings: Settings.isolated({ "fusion.enabled": false }) }))).not.toContain(
				"sidekick",
			);
			expect(await names(makeSession({ taskDepth: 1 }))).not.toContain("sidekick");
			vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(false);
			expect(await names(makeSession())).not.toContain("sidekick");
			expect(await BUILTIN_TOOLS.sidekick(makeSession())).toBeNull();
		});

		it("mounts for a subagent whose agent definition opts in with sidekick: true, and never for the sidekick itself", async () => {
			const names = async (session: ToolSession) => (await createTools(session, ["read"])).map(tool => tool.name);
			const expertLead = makeSession({
				taskDepth: 1,
				getAgentId: () => "Expert",
				agentDefinition: expertAgent({ sidekick: true }),
			});
			expect(await names(expertLead)).toContain("sidekick");
			// The lead prompt section keys on the mounted tool names, so a subagent lead renders it too.
			const { systemPrompt } = await buildSystemPrompt({
				cwd: tempDir.path(),
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames: await names(expertLead),
				tools: new Map(),
				workspaceTree: {
					rootPath: tempDir.path(),
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				personality: "none",
			});
			expect(systemPrompt.join("\n\n")).toContain("You have a `sidekick` tool");

			expect(await names(makeSession({ taskDepth: 1, agentDefinition: expertAgent() }))).not.toContain("sidekick");
			expect(await names(makeSession({ taskDepth: 1, agentDefinition: getSidekickAgent() }))).not.toContain(
				"sidekick",
			);
			expect(
				await names(
					makeSession({
						taskDepth: 1,
						agentDefinition: expertAgent({ sidekick: true }),
						settings: Settings.isolated({ "fusion.enabled": false }),
					}),
				),
			).not.toContain("sidekick");
		});
	});

	describe("per-lead sidekicks", () => {
		it("gives each subagent lead its own sidekick, distinct from its siblings' and the top-level lead's", async () => {
			const spawn = spawnSpy();
			const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockResolvedValue(singleResult("rebrief"));
			const leads = ["Main", "ExpertA", "ExpertB"].map(id => {
				const session =
					id === "Main"
						? makeSession()
						: makeSession({
								taskDepth: 1,
								getAgentId: () => id,
								agentDefinition: expertAgent({ sidekick: true }),
							});
				const tool = SidekickTool.createIf(session);
				if (!tool) throw new Error(`sidekick tool should mount for ${id}`);
				return { id, tool };
			});

			const agentIds: string[] = [];
			for (const lead of leads) {
				const result = await lead.tool.execute("c1", { message: `Work for ${lead.id}` });
				agentIds.push(result.details?.agentId ?? "");
				expect(spawn.mock.calls.at(-1)?.[0].session.getAgentId?.()).toBe(lead.id);
			}
			expect(new Set(agentIds).size).toBe(3);
			expect(spawn).toHaveBeenCalledTimes(3);
			for (const [index, lead] of leads.entries()) {
				expect(findSidekickRef(lead.id)?.id).toBe(agentIds[index]);
				expect(findSidekickRef(lead.id)?.parentId).toBe(lead.id);
			}

			// A second handoff from one expert re-briefs that expert's sidekick, not a sibling's or the root's.
			await leads[1].tool.execute("c2", { message: "More for A" });
			expect(spawn).toHaveBeenCalledTimes(3);
			expect(followUp).toHaveBeenCalledTimes(1);
			expect(followUp.mock.calls[0][0].id).toBe(agentIds[1]);
		});
	});

	describe("handoffs", () => {
		it("spawns once, then re-briefs the same agent with the update preamble", async () => {
			const spawn = spawnSpy();
			const followUp = vi
				.spyOn(executor, "runSubagentFollowUpTurn")
				.mockResolvedValue(singleResult("second report"));
			const tool = SidekickTool.createIf(makeSession());
			if (!tool) throw new Error("sidekick tool should mount");

			const first = await tool.execute("c1", { message: "Implement X" });
			expect(first.content[0]).toEqual({ type: "text", text: "spawn report" });
			expect(first.details?.agentId).toBe(SIDEKICK_ID);
			expect(spawn).toHaveBeenCalledTimes(1);
			const request = spawn.mock.calls[0][0];
			expect(request.agentDefinition?.name).toBe("sidekick");
			expect(request.agentDefinition?.thinkingLevel).toBe(Effort.Medium);
			expect(request.model).toBe("devin/swe-2");
			expect(request.keepAlive).toBe(true);
			expect(request.assignment).toStartWith("This is your first handoff from the lead.");
			expect(request.assignment).toEndWith("Implement X");

			const second = await tool.execute("c2", { message: "Now also Y" });
			expect(second.content[0]).toEqual({ type: "text", text: "second report" });
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(followUp).toHaveBeenCalledTimes(1);
			const turn = followUp.mock.calls[0][0];
			expect(turn.id).toBe(SIDEKICK_ID);
			expect(turn.message).toStartWith("The lead sent an update for the handoff you are working on.");
			expect(turn.message).toEndWith("Now also Y");
			// Consumed inline: nothing is re-delivered as a background result.
			expect(deliveries).toEqual([]);
		});

		it("block:false returns before the handoff settles and delivers the report as a background result", async () => {
			const release = Promise.withResolvers<void>();
			vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async () => {
				registerSidekick("idle");
				await release.promise;
				return {
					result: singleResult("late report"),
					policy: {} as structured.EffectiveSubagentPolicy,
					mergeSummary: "",
					changesApplied: null,
					artifactsDir: tempDir.path(),
					temporaryArtifacts: true,
				};
			});
			const tool = SidekickTool.createIf(makeSession());
			if (!tool) throw new Error("sidekick tool should mount");

			const result = await tool.execute("c1", { message: "Go", block: false });
			expect(result.details?.pending).toBe(true);
			const jobId = result.details?.jobId;
			if (!jobId) throw new Error("expected a job id");
			expect(manager.getJob(jobId)?.status).toBe("running");
			release.resolve();
			await manager.getJob(jobId)?.promise;
			await manager.drainDeliveries({ timeoutMs: 1000 });
			expect(deliveries).toEqual([{ id: jobId, text: "late report" }]);
		});

		it("steers a call that arrives mid-handoff into the running turn instead of spawning a second sidekick", async () => {
			const release = Promise.withResolvers<void>();
			const steered: string[] = [];
			const liveSession = {
				isStreaming: true,
				steer: async (text: string) => {
					steered.push(text);
				},
			} as unknown as AgentSession;
			const spawn = vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async request => {
				registerSidekick("running", liveSession);
				request.onProgress?.({
					index: 0,
					id: SIDEKICK_ID,
					agent: "sidekick",
					agentSource: "bundled",
					status: "running",
					task: "handoff",
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 0,
					tokens: 0,
					cost: 0,
					durationMs: 0,
				});
				await release.promise;
				return {
					result: singleResult("done"),
					policy: {} as structured.EffectiveSubagentPolicy,
					mergeSummary: "",
					changesApplied: null,
					artifactsDir: tempDir.path(),
					temporaryArtifacts: true,
				};
			});
			const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockResolvedValue(singleResult("unexpected"));
			const tool = SidekickTool.createIf(makeSession());
			if (!tool) throw new Error("sidekick tool should mount");

			const first = await tool.execute("c1", { message: "Go", block: false });
			const interrupt = await tool.execute("c2", { message: "Change of plan" });
			expect(interrupt.details?.mode).toBe("interrupt");
			expect(interrupt.details?.jobId).toBe(first.details?.jobId);
			expect(steered).toHaveLength(1);
			expect(steered[0]).toStartWith("The lead sent an update for the handoff you are working on.");
			expect(steered[0]).toEndWith("Change of plan");
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(followUp).not.toHaveBeenCalled();
			release.resolve();
			await manager.getJob(first.details?.jobId ?? "")?.promise;
		});
	});
});
