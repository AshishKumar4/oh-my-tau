import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { findSidekickRef, listSidekickRefs } from "@oh-my-pi/pi-coding-agent/fusion/config";
import type { VendorTool } from "@oh-my-pi/pi-coding-agent/harness/capture";
import { harnessSurface } from "@oh-my-pi/pi-coding-agent/harness/facades";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getSidekickAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import * as structured from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { BUILTIN_TOOLS, createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { SidekickTool } from "@oh-my-pi/pi-coding-agent/tools/sidekick";
import { blockedAwaitsOf, WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const SIDEKICK_ID = "Sidekick";
const SIDEKICK_TOOL = "sidekick";

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
			expect(request.assignment).toStartWith("Worker assignment.");
			// The brief rides inside the `<lead_handoff>` envelope.
			expect(request.assignment).toEndWith("<lead_handoff>\nImplement X\n</lead_handoff>");
			// The worker prompt is rendered for this pairing: the model/effort
			// footer names the sidekick's own runtime, and no template slots leak.
			expect(request.agentDefinition?.systemPrompt).toStartWith(
				"You are the implementation worker in a Fusion session.",
			);
			expect(request.agentDefinition?.systemPrompt).toEndWith("Model: swe-2; reasoning effort: medium.");
			expect(request.agentDefinition?.systemPrompt).not.toContain("{{");

			const second = await tool.execute("c2", { message: "Now also Y" });
			expect(second.content[0]).toEqual({ type: "text", text: "second report" });
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(followUp).toHaveBeenCalledTimes(1);
			const turn = followUp.mock.calls[0][0];
			expect(turn.id).toBe(SIDEKICK_ID);
			expect(turn.message).toStartWith("Assignment update.");
			expect(turn.message).toEndWith("<lead_handoff>\nNow also Y\n</lead_handoff>");
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
			// The hint names the wait tool the session actually has.
			const hint = result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(hint).toContain("wait for it with `wait`");
			expect(hint).not.toContain("hub");
			release.resolve();
			await manager.getJob(jobId)?.promise;
			await manager.drainDeliveries({ timeoutMs: 1000 });
			expect(deliveries).toEqual([{ id: jobId, text: "late report" }]);
		});

		it("under Claude Code names the wait path the surface presents, in the description and the background hint", async () => {
			const taskOutput: VendorTool = { description: "Retrieves output", inputSchema: {} };
			const settings = Settings.isolated({
				"fusion.enabled": true,
				"fusion.sidekickModel": "devin/swe-2",
				"task.maxRuntimeMs": 0,
				"harness.mode": "claude-code",
			});
			/** The lead's session; `declaresTaskOutput` models a pre-2.1.284 capture. */
			const claudeCodeSession = (
				declaresTaskOutput: boolean,
				toolNames = ["read", "write", "wait", "task", SIDEKICK_TOOL],
			): ToolSession => {
				const surface = harnessSurface("claude-code", toolNames, {
					settings,
					vendorTool: name => (declaresTaskOutput && name === "TaskOutput" ? taskOutput : undefined),
				});
				return makeSession({
					settings,
					getActiveModel: () => getBundledModel("anthropic", "claude-opus-5"),
					getToolRefs: () => surface.toolRefs,
				});
			};
			/** A `block: false` handoff's hint, the job released afterwards. */
			const backgroundHint = async (tool: SidekickTool): Promise<string> => {
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
				const result = await tool.execute("c1", { message: "Go", block: false });
				release.resolve();
				const jobId = result.details?.jobId;
				if (jobId) await manager.getJob(jobId)?.promise;
				for (const ref of listSidekickRefs()) AgentRegistry.global().unregister(ref.id);
				return result.content[0]?.type === "text" ? result.content[0].text : "";
			};

			// 2.1.284: TaskOutput is not served, so `wait` is presented as itself.
			const bare = SidekickTool.createIf(claudeCodeSession(false));
			if (!bare) throw new Error("sidekick tool should mount");
			expect(bare.description).toContain("wait for it with `wait`");
			const bareHint = await backgroundHint(bare);
			expect(bareHint).toContain("wait for it with `wait` rather than polling.");
			for (const text of [bare.description, bareHint]) {
				expect(text).not.toContain("TaskOutput");
				expect(text).not.toContain("undefined");
			}

			// A session with no wait tool at all ends its turn for the report.
			const waitless = SidekickTool.createIf(claudeCodeSession(false, ["read", "write", "task", SIDEKICK_TOOL]));
			if (!waitless) throw new Error("sidekick tool should mount");
			expect(waitless.description).toContain(
				"end your turn rather than polling; the report arrives as a notification.",
			);
			expect(await backgroundHint(waitless)).toContain(
				"Its report arrives as a notification when it finishes; end your turn rather than polling.",
			);

			// An older capture serves TaskOutput in `wait`'s place: both name it.
			const served = SidekickTool.createIf(claudeCodeSession(true));
			if (!served) throw new Error("sidekick tool should mount");
			expect(served.description).toContain("wait for it with `TaskOutput`");
			expect(await backgroundHint(served)).toContain("wait for it with `TaskOutput` rather than polling.");
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
			expect(steered[0]).toStartWith("Assignment update.");
			expect(steered[0]).toEndWith("<lead_handoff>\nChange of plan\n</lead_handoff>");
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(followUp).not.toHaveBeenCalled();
			release.resolve();
			await manager.getJob(first.details?.jobId ?? "")?.promise;
		});
	});

	describe("blocked awaits", () => {
		const streaming = { isStreaming: true } as unknown as AgentSession;

		/**
		 * Run one first handoff whose sidekick, once registered, waits for a
		 * message while the lead's turn is parked on it and an unrelated lane
		 * streams. Returns the sidekick's wait text.
		 */
		async function sidekickWaitText(overrides: Partial<ToolSession>): Promise<string> {
			const registry = AgentRegistry.global();
			registry.register({ id: "Main", displayName: "Main", kind: "main", session: streaming, status: "running" });
			registry.register({
				id: "Lane",
				displayName: "Lane",
				kind: "sub",
				parentId: "Main",
				session: streaming,
				status: "running",
			});
			try {
				let waitText = "";
				vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async () => {
					// A first handoff learns the sidekick's id only once it registers.
					registerSidekick("running", streaming);
					const waitSession = {
						cwd: tempDir.path(),
						settings: Settings.isolated({ "launch.enabled": false }),
						agentRegistry: registry,
						getAgentId: () => SIDEKICK_ID,
					} as unknown as ToolSession;
					const waited = await new WaitTool(waitSession).execute("sidekick-wait", {});
					waitText = waited.content[0]?.type === "text" ? waited.content[0].text : "";
					return {
						result: singleResult("report"),
						policy: {} as structured.EffectiveSubagentPolicy,
						mergeSummary: "",
						changesApplied: null,
						artifactsDir: tempDir.path(),
						temporaryArtifacts: true,
					};
				});
				const tool = SidekickTool.createIf(makeSession({ agentRegistry: registry, ...overrides }));
				if (!tool) throw new Error("sidekick tool should mount");
				const result = await tool.execute("c1", { message: "Implement X" });
				expect(result.content[0]).toEqual({ type: "text", text: "report" });
				// The lead's hold ends with the handoff.
				expect(blockedAwaitsOf(registry, "Main")).toEqual([]);
				return waitText;
			} finally {
				registry.unregister("Main");
				registry.unregister("Lane");
			}
		}

		it("holds the lead's turn on an inline handoff, so its waiting sidekick returns", async () => {
			const text = await sidekickWaitText({ asyncJobManager: undefined });
			expect(text).toContain("`Main` is blocked waiting on your result: it reads no message until you `yield`.");
		});

		it("holds the lead's turn while it blocks on the handoff job, learning the sidekick's id late", async () => {
			const text = await sidekickWaitText({});
			expect(text).toContain("`Main` is blocked waiting on your result: it reads no message until you `yield`.");
		});
	});
});
