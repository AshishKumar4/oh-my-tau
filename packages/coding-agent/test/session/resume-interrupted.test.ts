import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	createSessionOpenData,
	INTERRUPTED_TOOL_RESULT_TEXT,
	SESSION_EXIT_CUSTOM_TYPE,
	SESSION_OPEN_CUSTOM_TYPE,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import {
	findInterruptedWork,
	RECOVER_CUSTOM_TYPE,
	type RecoverHost,
	resumeInterruptedWork,
} from "@oh-my-pi/pi-coding-agent/session/resume-interrupted";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult, StructuredSubagentOutput } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

function toolTurn(...calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): AssistantMessage {
	return {
		...createAssistantMessage(""),
		content: calls.map(call => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: call.args })),
		stopReason: "toolUse",
	};
}

function toolResult(toolCallId: string, toolName: string, details?: Record<string, unknown>): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		details,
		timestamp: Date.now(),
	};
}

/** `session_open` marker a live session writes on resume: from this process, or from an earlier one. */
function openedBy(manager: SessionManager, processId: "this" | number): void {
	manager.appendCustomEntry(
		SESSION_OPEN_CUSTOM_TYPE,
		processId === "this"
			? createSessionOpenData()
			: { pid: processId, processStartedAt: processId, recordedAt: new Date().toISOString() },
	);
}

function sessionExit(manager: SessionManager): void {
	manager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
		reason: "dispose",
		kind: "normal",
		recordedAt: new Date().toISOString(),
	});
}

function stoppedTurn(stopReason: "aborted" | "error"): AssistantMessage {
	return { ...createAssistantMessage(""), stopReason };
}

function singleResult(output: string): SingleResult {
	return {
		index: 0,
		id: "Lane",
		agent: "task",
		agentSource: "bundled",
		task: "fix the lane",
		exitCode: 0,
		output,
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 1,
		requests: 1,
	};
}

/** An IRC message from `from` as a recipient's transcript records it. */
function ircFrom(manager: SessionManager, from: string, text: string, options: { wakeRelay?: boolean } = {}): void {
	manager.appendCustomMessageEntry("irc:incoming", text, true, {
		id: `${from}-${Date.now()}`,
		from,
		message: text,
		...(options.wakeRelay ? { wakeRelay: true } : {}),
	});
}

/** The parent messaged parked subagent `to`, reviving it for a new run. */
function revived(manager: SessionManager, to: string): void {
	const id = `wake_${to}_${Date.now()}`;
	manager.appendMessage(toolTurn({ id, name: "write", args: { path: `agent://${to}` } }));
	manager.appendMessage(
		toolResult(id, "write", { message: { op: "send", from: "Main", to, receipts: [{ to, outcome: "revived" }] } }),
	);
}

/** A successful `yield` call and the result the yield tool records for it. */
function yielded(manager: SessionManager, id: string, args: { data?: unknown; type?: string | string[] }): void {
	manager.appendMessage(toolTurn({ id, name: "yield", args }));
	manager.appendMessage(toolResult(id, "yield", { status: "success", ...args }));
}

/** Lets entry timestamps (ms resolution) tell writes apart. */
function tick(): Promise<void> {
	return Bun.sleep(5);
}

function resultsFor(manager: SessionManager, toolCallId: string): ToolResultMessage[] {
	return manager
		.getBranch()
		.flatMap(entry =>
			entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId
				? [entry.message]
				: [],
		);
}

describe("/recover", () => {
	let dir: TempDir;
	let manager: SessionManager;

	beforeEach(() => {
		dir = TempDir.createSync("@recover-");
		manager = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"));
		AgentRegistry.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.close();
		dir.removeSync();
	});

	const bus = new EventBus();

	function host(jobs?: AsyncJobManager): RecoverHost & { replaced: AgentMessage[][] } {
		const replaced: AgentMessage[][] = [];
		return {
			sessionManager: manager,
			asyncJobManager: jobs,
			eventBus: bus,
			subagentEventBus: bus,
			agent: { replaceMessages: messages => replaced.push(messages) },
			buildDisplaySessionContext: () => manager.buildSessionContext(),
			getAgentId: () => "Main",
			replaced,
		};
	}

	/** A parked subagent of `Main` whose transcript `lane` the test writes; close it with {@link parked}. */
	function laneSession(): SessionManager {
		return SessionManager.create(dir.path(), path.join(dir.path(), "children"));
	}

	async function parked(id: string, lane: SessionManager): Promise<string> {
		await lane.flush();
		const file = lane.getSessionFile();
		await lane.close();
		if (!file) throw new Error("subagent session has no file");
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: file,
			status: "parked",
		});
		return file;
	}

	function deliveries(
		jobs: AsyncJobManager,
	): Array<{ id: string; text: string; status?: string; structured?: StructuredSubagentOutput }> {
		const delivered: Array<{ id: string; text: string; status?: string; structured?: StructuredSubagentOutput }> = [];
		jobs.registerDeliverySink("Main", (id, text, job) => {
			delivered.push({ id, text, status: job?.status, structured: job?.structured });
		});
		return delivered;
	}

	/** Runs `/recover` with restarts mocked; returns its outcome, the restarted ids, and what reached `Main`. */
	async function recover(jobs = new AsyncJobManager({ retentionMs: 0 })) {
		const delivered = deliveries(jobs);
		const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockResolvedValue(singleResult("report"));
		const outcome = await resumeInterruptedWork(host(jobs));
		await jobs.waitForAll();
		await jobs.drainDeliveries({ timeoutMs: 1000 });
		if (outcome.status !== "resumed") throw new Error(`expected resumed, got ${outcome.status}`);
		const restartedIds = followUp.mock.calls.map(([options]) => options.id);
		followUp.mockRestore();
		await jobs.dispose();
		return { outcome, restartedIds, delivered };
	}

	it("gives a crash-interrupted tool call a glitch result and keeps it in context", async () => {
		manager.appendMessage(toolTurn({ id: "call_1", name: "bash", args: { command: "bun test" } }));
		openedBy(manager, "this");
		const h = host();

		const outcome = await resumeInterruptedWork(h);

		expect(outcome.status).toBe("resumed");
		const [result] = resultsFor(manager, "call_1");
		expect(result?.isError).toBe(true);
		expect(result?.content).toEqual([{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }]);
		const context = h.replaced.at(-1) ?? [];
		const assistant = context.find(message => message.role === "assistant");
		expect(assistant?.role === "assistant" && assistant.content.some(block => block.type === "toolCall")).toBe(true);
		if (outcome.status === "resumed") expect(outcome.notice).toContain("`call_1` bash: bun test");
	});

	it("only lists the call when something was said after the interrupted turn", async () => {
		manager.appendMessage(toolTurn({ id: "call_1", name: "bash", args: { command: "make" } }));
		manager.appendMessage({ role: "user", content: "hello?", timestamp: Date.now() });
		openedBy(manager, "this");

		const outcome = await resumeInterruptedWork(host());

		expect(resultsFor(manager, "call_1")).toEqual([]);
		expect(outcome.status === "resumed" && outcome.notice).toContain("stopped them before they recorded a result");
	});

	it("lists background jobs that never finished and skips finished ones", async () => {
		manager.appendMessage(
			toolTurn(
				{ id: "a", name: "bash", args: { command: "sleep 100" } },
				{ id: "b", name: "bash", args: { command: "echo done" } },
				{ id: "c", name: "bash", args: { command: "bun run build" } },
			),
		);
		manager.appendMessage(toolResult("a", "bash", { async: { state: "running", jobId: "bg_1", type: "bash" } }));
		manager.appendMessage(toolResult("b", "bash", { async: { state: "running", jobId: "bg_2", type: "bash" } }));
		manager.appendMessage(toolResult("c", "bash", { async: { state: "running", jobId: "bg_3", type: "bash" } }));
		manager.appendCustomMessageEntry("async-result", "done", true, { jobs: [{ jobId: "bg_2", type: "bash" }] });
		manager.appendMessage(toolTurn({ id: "w", name: "wait", args: {} }));
		manager.appendMessage(toolResult("w", "wait", { op: "wait", jobs: [{ id: "bg_3", status: "completed" }] }));
		manager.appendMessage(createAssistantMessage("waiting on bg_1"));
		openedBy(manager, "this");

		const scan = findInterruptedWork(manager.getBranch());

		expect(scan.handled).toBe(false);
		if (!scan.handled) {
			expect(scan.jobs.map(job => job.jobId)).toEqual(["bg_1"]);
			expect(scan.jobs[0]?.label).toBe("bash: sleep 100");
			expect(scan.toolCalls).toEqual([]);
		}
	});

	it("pairs reused job ids with the process that started them", async () => {
		manager.appendMessage(toolTurn({ id: "a", name: "bash", args: { command: "first" } }));
		manager.appendMessage(toolResult("a", "bash", { async: { state: "running", jobId: "bg_1", type: "bash" } }));
		sessionExit(manager);
		manager.appendMessage(toolTurn({ id: "b", name: "bash", args: { command: "second" } }));
		manager.appendMessage(toolResult("b", "bash", { async: { state: "running", jobId: "bg_1", type: "bash" } }));
		manager.appendCustomMessageEntry("async-result", "done", true, { jobs: [{ jobId: "bg_1", type: "bash" }] });
		manager.appendMessage(toolTurn({ id: "c", name: "bash", args: { command: "third" } }));
		manager.appendMessage(toolResult("c", "bash", { async: { state: "running", jobId: "bg_2", type: "bash" } }));
		manager.appendMessage(createAssistantMessage("working"));
		openedBy(manager, "this");

		const scan = findInterruptedWork(manager.getBranch());

		// Only the crashed process after the last exit counts, and its bg_1 finished.
		expect(!scan.handled && scan.jobs.map(job => job.label)).toEqual(["bash: third"]);
	});

	it("revives interrupted subagents as jobs that report to the parent", async () => {
		const parkChild = async (id: string, command: string): Promise<string> => {
			const child = SessionManager.create(dir.path(), path.join(dir.path(), "children"));
			child.appendMessage(toolTurn({ id: `${id}_call`, name: "bash", args: { command } }));
			await child.flush();
			const file = child.getSessionFile();
			await child.close();
			if (!file) throw new Error("child session has no file");
			AgentRegistry.global().register({
				id,
				displayName: id,
				kind: "sub",
				session: null,
				sessionFile: file,
				status: "parked",
			});
			return file;
		};
		const laneFile = await parkChild("Lane", "bun test lane");
		await parkChild("Scout", "rg todo");

		manager.appendMessage(toolTurn({ id: "spawn", name: "task", args: { tasks: [] } }));
		manager.appendMessage(
			toolResult("spawn", "task", {
				async: { state: "running", jobId: "Lane", type: "task" },
				progress: [
					{ id: "Lane", status: "running", description: "fix the lane" },
					// A spawn without a description is labelled by its id.
					{ id: "Scout", status: "running" },
				],
			}),
		);
		manager.appendMessage(createAssistantMessage("lane running"));
		openedBy(manager, "this");

		const jobs = new AsyncJobManager({ retentionMs: 0 });
		const delivered: Array<{ id: string; text: string }> = [];
		jobs.registerDeliverySink("Main", (id, text) => {
			delivered.push({ id, text });
		});
		const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockResolvedValue(singleResult("lane report"));

		const outcome = await resumeInterruptedWork(host(jobs));
		await jobs.waitForAll();
		await jobs.drainDeliveries({ timeoutMs: 1000 });

		if (outcome.status !== "resumed") throw new Error(`expected resumed, got ${outcome.status}`);
		expect(outcome.restarted.map(agent => agent.jobId)).toEqual(["Lane", "Scout"]);
		expect(outcome.notice).toContain("- `Lane` (fix the lane)\n- `Scout`\n");
		expect(followUp).toHaveBeenCalledTimes(2);
		expect(followUp.mock.calls[0]?.[0].id).toBe("Lane");
		// The session's buses carry the restart's lifecycle frames to the running-subagents list.
		expect(followUp.mock.calls[0]?.[0].eventBus).toBe(bus);
		expect(followUp.mock.calls[0]?.[0].subagentEventBus).toBe(bus);
		// The restart's job delivers to this session's agent, so its relays skip it.
		expect(followUp.mock.calls[0]?.[0].resultOwnerId).toBe("Main");
		expect(followUp.mock.calls[0]?.[0].message).toContain("A system glitch stopped OMP and interrupted your run");
		expect(delivered.some(delivery => delivery.id === "Lane" && delivery.text.includes("lane report"))).toBe(true);
		const laneBranch = (await SessionManager.open(laneFile)).getBranch();
		expect(
			laneBranch.some(
				entry =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === "Lane_call" &&
					entry.message.isError,
			),
		).toBe(true);
		await jobs.dispose();
	});

	it("resumes work cut off by a normal quit", async () => {
		manager.appendMessage(toolTurn({ id: "a", name: "bash", args: { command: "long job" } }));
		manager.appendMessage(toolResult("a", "bash", { async: { state: "running", jobId: "bg_1", type: "bash" } }));
		manager.appendMessage(createAssistantMessage("started"));
		sessionExit(manager);
		openedBy(manager, "this");

		const scan = findInterruptedWork(manager.getBranch());

		expect(!scan.handled && scan.jobs.map(job => job.jobId)).toEqual(["bg_1"]);
	});

	it("does nothing the second time", async () => {
		manager.appendMessage(toolTurn({ id: "call_1", name: "bash", args: { command: "bun test" } }));
		openedBy(manager, "this");

		expect((await resumeInterruptedWork(host())).status).toBe("resumed");
		expect((await resumeInterruptedWork(host())).status).toBe("handled");
		expect(resultsFor(manager, "call_1")).toHaveLength(1);
		expect(
			manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === RECOVER_CUSTOM_TYPE),
		).toHaveLength(1);
	});

	it("reports nothing when the previous process finished its work", async () => {
		manager.appendMessage(toolTurn({ id: "a", name: "bash", args: { command: "ls" } }));
		manager.appendMessage(toolResult("a", "bash"));
		manager.appendMessage(createAssistantMessage("all done"));
		openedBy(manager, "this");

		expect((await resumeInterruptedWork(host())).status).toBe("nothing");
	});

	it.each([
		["with session_open markers", true],
		["on a file older than the markers", false],
	])("keeps a quit's unwind tail with the process that quit (%s)", (_label, markers) => {
		if (markers) openedBy(manager, 101);
		manager.appendMessage(
			toolTurn({ id: "a", name: "bash", args: { command: "long job" } }, { id: "w", name: "wait", args: {} }),
		);
		manager.appendMessage(toolResult("a", "bash", { async: { state: "running", jobId: "bg_1", type: "bash" } }));
		// A quit writes session_exit, then aborts: the blocked `wait` settles after the marker.
		sessionExit(manager);
		manager.appendMessage({ ...toolResult("w", "wait"), isError: true });
		manager.appendMessage(stoppedTurn("aborted"));
		openedBy(manager, "this");

		const scan = findInterruptedWork(manager.getBranch());

		expect(!scan.handled && scan.jobs.map(job => job.jobId)).toEqual(["bg_1"]);
	});

	it("ignores a crash two processes back that a later process moved on from", () => {
		openedBy(manager, 101);
		manager.appendMessage(toolTurn({ id: "a", name: "bash", args: { command: "sleep 100" } }));
		manager.appendMessage(toolResult("a", "bash", { async: { state: "running", jobId: "bg_1", type: "bash" } }));
		manager.appendMessage(createAssistantMessage("crashed while bg_1 ran"));
		openedBy(manager, 202);
		manager.appendMessage({ role: "user", content: "carry on", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("done"));
		sessionExit(manager);
		openedBy(manager, "this");

		const scan = findInterruptedWork(manager.getBranch());

		expect(!scan.handled && [...scan.jobs, ...scan.agents, ...scan.toolCalls]).toEqual([]);
	});

	it("tracks parked agents woken by a message until their result arrives", () => {
		const woke = (id: string, to: string) => {
			manager.appendMessage(toolTurn({ id, name: "write", args: { path: `agent://${to}` } }));
			manager.appendMessage(
				toolResult(id, "write", {
					message: { op: "send", from: "Main", to, receipts: [{ to, outcome: "revived" }] },
				}),
			);
		};
		woke("a", "Lane");
		woke("b", "Scout");
		woke("c", "Lane");
		manager.appendMessage(toolTurn({ id: "d", name: "write", args: { path: "agent://Live" } }));
		manager.appendMessage(
			toolResult("d", "write", {
				message: { op: "send", to: "Live", receipts: [{ to: "Live", outcome: "injected" }] },
			}),
		);
		manager.appendCustomMessageEntry("async-result", "done", true, { jobs: [{ jobId: "Scout", type: "task" }] });
		manager.appendMessage(createAssistantMessage("lanes running"));
		openedBy(manager, "this");

		const scan = findInterruptedWork(manager.getBranch());

		expect(!scan.handled && scan.agents.map(agent => agent.jobId)).toEqual(["Lane"]);
	});

	it("steps past a process that opened the file and did nothing", () => {
		manager.appendMessage(toolTurn({ id: "a", name: "bash", args: { command: "sleep 100" } }));
		manager.appendMessage(toolResult("a", "bash", { async: { state: "running", jobId: "bg_1", type: "bash" } }));
		manager.appendMessage(createAssistantMessage("crashed while bg_1 ran"));
		openedBy(manager, 202);
		sessionExit(manager);
		openedBy(manager, "this");

		const scan = findInterruptedWork(manager.getBranch());

		expect(!scan.handled && scan.jobs.map(job => job.jobId)).toEqual(["bg_1"]);
	});

	it("never counts this process's own work as interrupted", () => {
		manager.appendMessage(createAssistantMessage("previous process finished"));
		openedBy(manager, "this");
		manager.appendMessage(toolTurn({ id: "a", name: "bash", args: { command: "sleep 100" } }));
		manager.appendMessage(toolResult("a", "bash", { async: { state: "running", jobId: "bg_1", type: "bash" } }));
		manager.appendMessage(toolTurn({ id: "b", name: "bash", args: { command: "still running" } }));

		const scan = findInterruptedWork(manager.getBranch());

		expect(!scan.handled && [...scan.jobs, ...scan.toolCalls]).toEqual([]);
	});

	it("repairs a call behind the resume-time abort stub", async () => {
		manager.appendMessage(toolTurn({ id: "call_1", name: "bash", args: { command: "bun test" } }));
		manager.appendMessage(stoppedTurn("aborted"));
		openedBy(manager, "this");

		const outcome = await resumeInterruptedWork(host());

		expect(outcome.status).toBe("resumed");
		expect(resultsFor(manager, "call_1")).toHaveLength(1);
	});

	it("does not treat an earlier result with a reused call id as answering the interrupted call", () => {
		manager.appendMessage(toolTurn({ id: "x", name: "bash", args: { command: "first" } }));
		manager.appendMessage(toolResult("x", "bash"));
		manager.appendMessage(toolTurn({ id: "x", name: "bash", args: { command: "second" } }));
		openedBy(manager, "this");

		const scan = findInterruptedWork(manager.getBranch());

		expect(!scan.handled && scan.toolCalls.map(call => call.label)).toEqual(["bash: second"]);
	});

	it("reports a subagent it cannot prepare and still records the run", async () => {
		AgentRegistry.global().register({
			id: "Broken",
			displayName: "Broken",
			kind: "sub",
			session: null,
			sessionFile: path.join(dir.path(), "missing.jsonl"),
			status: "parked",
		});
		manager.appendMessage(toolTurn({ id: "spawn", name: "task", args: { tasks: [] } }));
		manager.appendMessage(
			toolResult("spawn", "task", {
				async: { state: "running", jobId: "Broken", type: "task" },
				progress: [{ id: "Broken", status: "running" }],
			}),
		);
		manager.appendMessage(createAssistantMessage("lane running"));
		openedBy(manager, "this");
		const jobs = new AsyncJobManager({ retentionMs: 0 });
		const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockResolvedValue(singleResult("report"));

		const outcome = await resumeInterruptedWork(host(jobs));

		if (outcome.status !== "resumed") throw new Error(`expected resumed, got ${outcome.status}`);
		expect(outcome.restarted).toEqual([]);
		expect(outcome.notice).toContain("Subagents not restarted:\n- `Broken`: ");
		expect(followUp).not.toHaveBeenCalled();
		expect((await resumeInterruptedWork(host(jobs))).status).toBe("handled");
		await jobs.dispose();
	});

	it("restarts transcripts of removed bundled agents under the agent that replaced them", async () => {
		for (const [id, agent] of [
			["Scanner", "security-reviewer"],
			["Mechanic", "sonic"],
		]) {
			const child = SessionManager.create(dir.path(), path.join(dir.path(), "children"));
			child.appendSessionInit({ systemPrompt: [`${agent} prompt`], task: "work", tools: ["read"], agent });
			// Cut off mid-call: a finished transcript would not be restarted.
			child.appendMessage(toolTurn({ id: `${id}_call`, name: "read", args: { path: "src" } }));
			await child.flush();
			const file = child.getSessionFile();
			await child.close();
			if (!file) throw new Error("child session has no file");
			AgentRegistry.global().register({
				id,
				displayName: id,
				kind: "sub",
				session: null,
				sessionFile: file,
				status: "parked",
			});
		}
		manager.appendMessage(toolTurn({ id: "spawn", name: "task", args: { tasks: [] } }));
		manager.appendMessage(
			toolResult("spawn", "task", {
				async: { state: "running", jobId: "Scanner", type: "task" },
				progress: [
					{ id: "Scanner", status: "running" },
					{ id: "Mechanic", status: "running" },
				],
			}),
		);
		manager.appendMessage(createAssistantMessage("agents running"));
		openedBy(manager, "this");
		const jobs = new AsyncJobManager({ retentionMs: 0 });
		const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockResolvedValue(singleResult("report"));

		await resumeInterruptedWork(host(jobs));
		await jobs.waitForAll();

		expect(followUp.mock.calls.map(([options]) => [options.id, options.agent.name])).toEqual([
			["Scanner", "reviewer"],
			["Mechanic", "task"],
		]);
		await jobs.dispose();
	});

	it("restarts a subagent once when /recover runs twice at the same time", async () => {
		const child = SessionManager.create(dir.path(), path.join(dir.path(), "children"));
		child.appendMessage(toolTurn({ id: "lane_call", name: "bash", args: { command: "bun test" } }));
		await child.flush();
		const laneFile = child.getSessionFile();
		await child.close();
		if (!laneFile) throw new Error("child session has no file");
		AgentRegistry.global().register({
			id: "Lane",
			displayName: "Lane",
			kind: "sub",
			session: null,
			sessionFile: laneFile,
			status: "parked",
		});
		manager.appendMessage(toolTurn({ id: "spawn", name: "task", args: { tasks: [] } }));
		manager.appendMessage(
			toolResult("spawn", "task", {
				async: { state: "running", jobId: "Lane", type: "task" },
				progress: [{ id: "Lane", status: "running" }],
			}),
		);
		manager.appendMessage(createAssistantMessage("lane running"));
		openedBy(manager, "this");
		const jobs = new AsyncJobManager({ retentionMs: 0 });
		const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockResolvedValue(singleResult("report"));

		const [first, second] = await Promise.all([resumeInterruptedWork(host(jobs)), resumeInterruptedWork(host(jobs))]);
		await jobs.waitForAll();

		expect([first.status, second.status]).toEqual(["resumed", "handled"]);
		expect(followUp).toHaveBeenCalledTimes(1);
		await jobs.dispose();
	});
	it("does not restart a subagent that finished with a text answer, and recovers one that never reached the parent", async () => {
		const answered = laneSession();
		const silent = laneSession();
		revived(manager, "Answered");
		revived(manager, "Silent");
		ircFrom(answered, "Main", "Is the fix ready?");
		answered.appendMessage(createAssistantMessage("The fix is ready."));
		ircFrom(manager, "Answered", "The fix is ready.", { wakeRelay: true });
		ircFrom(silent, "Main", "Get the fix reviewed.");
		silent.appendMessage(createAssistantMessage("Sent it to the reviewer."));
		ircFrom(manager, "Silent", "Sent it to the reviewer.", { wakeRelay: true });
		await tick();
		// The reviewer's reply woke Silent again; its conclusion went only to the reviewer.
		ircFrom(silent, "Reviewer", "Approved.");
		silent.appendMessage(createAssistantMessage("The reviewer approved the fix; nothing is left."));
		await parked("Answered", answered);
		await parked("Silent", silent);
		manager.appendMessage(createAssistantMessage("waiting on the reviews"));
		openedBy(manager, "this");
		const jobs = new AsyncJobManager({ retentionMs: 0 });
		const delivered = deliveries(jobs);
		const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockResolvedValue(singleResult("report"));

		const outcome = await resumeInterruptedWork(host(jobs));
		await jobs.waitForAll();
		await jobs.drainDeliveries({ timeoutMs: 1000 });

		if (outcome.status !== "resumed") throw new Error(`expected resumed, got ${outcome.status}`);
		expect(followUp).not.toHaveBeenCalled();
		expect(outcome.restarted).toEqual([]);
		expect(outcome.skipped.map(agent => agent.jobId)).toEqual(["Answered"]);
		expect(outcome.recovered.map(agent => agent.jobId)).toEqual(["Silent"]);
		expect(outcome.notice).toContain("- `Answered`: its last report already reached you.");
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.id).toBe("Silent");
		expect(delivered[0]?.text).toContain("The reviewer approved the fix; nothing is left.");
		await jobs.dispose();
	});

	it("delivers once, without restarting it, a finished subagent's yield that never reached the parent", async () => {
		const lane = laneSession();
		revived(manager, "Lane");
		ircFrom(lane, "Main", "Run the probe, then report.");
		lane.appendMessage(toolTurn({ id: "probe", name: "bash", args: { command: "./probe" } }));
		lane.appendMessage(toolResult("probe", "bash", { async: { state: "running", jobId: "bg_1", type: "bash" } }));
		lane.appendMessage(createAssistantMessage("Waiting for the probe."));
		ircFrom(manager, "Lane", "Waiting for the probe.", { wakeRelay: true });
		await tick();
		lane.appendCustomMessageEntry("async-result", "3 of 3 passed", true, { jobs: [{ jobId: "bg_1", type: "bash" }] });
		yielded(lane, "y", { data: { report: "probe passed: 3 of 3" } });
		const laneFile = await parked("Lane", lane);
		manager.appendMessage(createAssistantMessage("waiting on Lane"));
		openedBy(manager, "this");
		const jobs = new AsyncJobManager({ retentionMs: 0 });
		const delivered = deliveries(jobs);
		const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockResolvedValue(singleResult("report"));

		const outcome = await resumeInterruptedWork(host(jobs));
		await jobs.waitForAll();
		await jobs.drainDeliveries({ timeoutMs: 1000 });

		if (outcome.status !== "resumed") throw new Error(`expected resumed, got ${outcome.status}`);
		expect(followUp).not.toHaveBeenCalled();
		expect(outcome.recovered.map(agent => agent.jobId)).toEqual(["Lane"]);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.text).toContain("Recovered result of `Lane`");
		expect(delivered[0]?.text).toContain("probe passed: 3 of 3");
		expect((await resumeInterruptedWork(host(jobs))).status).toBe("handled");
		expect(delivered).toHaveLength(1);
		// A finished transcript is left as it was.
		const laneBranch = (await SessionManager.open(laneFile)).getBranch();
		expect(laneBranch.at(-1)?.type === "message" && laneBranch.at(-1)).toMatchObject({
			message: { role: "toolResult" },
		});
		await jobs.dispose();
	});

	it("does not count a peer the subagent messaged as its unfinished work", async () => {
		const lane = laneSession();
		revived(manager, "Lane");
		ircFrom(lane, "Main", "Get the fix reviewed.");
		// Reviewer is Main's subagent: its run reports to Main, not to Lane.
		revived(lane, "Reviewer");
		lane.appendMessage(createAssistantMessage("Sent the fix to Reviewer; nothing else is pending."));
		ircFrom(manager, "Lane", "Sent the fix to Reviewer; nothing else is pending.", { wakeRelay: true });
		await parked("Lane", lane);
		AgentRegistry.global().register({
			id: "Reviewer",
			displayName: "Reviewer",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "parked",
		});
		manager.appendMessage(createAssistantMessage("waiting on the review"));
		openedBy(manager, "this");
		const jobs = new AsyncJobManager({ retentionMs: 0 });
		const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockResolvedValue(singleResult("report"));

		const outcome = await resumeInterruptedWork(host(jobs));

		if (outcome.status !== "resumed") throw new Error(`expected resumed, got ${outcome.status}`);
		expect(followUp).not.toHaveBeenCalled();
		expect(outcome.skipped.map(agent => agent.jobId)).toEqual(["Lane"]);
		await jobs.dispose();
	});

	it("restarts a subagent whose turn the previous process's quit cut off", async () => {
		const lane = laneSession();
		openedBy(manager, 101);
		revived(manager, "Lane");
		ircFrom(lane, "Main", "Run the tests.");
		lane.appendMessage(toolTurn({ id: "tests", name: "bash", args: { command: "bun test" } }));
		await tick();
		sessionExit(manager);
		// The quit aborts the subagent's running call after the parent's exit marker.
		lane.appendMessage({ ...toolResult("tests", "bash"), isError: true });
		lane.appendMessage(stoppedTurn("aborted"));
		await parked("Lane", lane);
		openedBy(manager, "this");
		const jobs = new AsyncJobManager({ retentionMs: 0 });
		const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockResolvedValue(singleResult("report"));

		const outcome = await resumeInterruptedWork(host(jobs));
		await jobs.waitForAll();

		if (outcome.status !== "resumed") throw new Error(`expected resumed, got ${outcome.status}`);
		expect(outcome.restarted.map(agent => agent.jobId)).toEqual(["Lane"]);
		expect(followUp).toHaveBeenCalledTimes(1);
		await jobs.dispose();
	});

	it("does not restart a finished subagent over a call an older process left dangling", async () => {
		const lane = laneSession();
		lane.appendMessage(toolTurn({ id: "old", name: "bash", args: { command: "make" } }));
		await tick();
		openedBy(manager, 101);
		await tick();
		revived(manager, "Lane");
		ircFrom(lane, "Main", "Is the build fixed?");
		lane.appendMessage(createAssistantMessage("Yes, the build is fixed."));
		ircFrom(manager, "Lane", "Yes, the build is fixed.", { wakeRelay: true });
		const laneFile = await parked("Lane", lane);
		manager.appendMessage(createAssistantMessage("done"));
		openedBy(manager, "this");
		const jobs = new AsyncJobManager({ retentionMs: 0 });
		const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockResolvedValue(singleResult("report"));

		const outcome = await resumeInterruptedWork(host(jobs));

		if (outcome.status !== "resumed") throw new Error(`expected resumed, got ${outcome.status}`);
		expect(followUp).not.toHaveBeenCalled();
		expect(outcome.skipped.map(agent => agent.jobId)).toEqual(["Lane"]);
		const laneManager = await SessionManager.open(laneFile);
		expect(resultsFor(laneManager, "old")).toEqual([]);
		await laneManager.close();
		await jobs.dispose();
	});

	it("does not resurrect a subagent an earlier /recover considered but did not restart", async () => {
		const lane = laneSession();
		const ghost = laneSession();
		manager.appendMessage(toolTurn({ id: "spawn", name: "task", args: { tasks: [] } }));
		manager.appendMessage(
			toolResult("spawn", "task", {
				async: { state: "running", jobId: "Lane", type: "task" },
				progress: [
					{ id: "Lane", status: "running" },
					{ id: "Ghost", status: "running" },
				],
			}),
		);
		lane.appendMessage(toolTurn({ id: "lane_call", name: "bash", args: { command: "bun test" } }));
		ghost.appendMessage({ role: "user", content: "Check the docs.", timestamp: Date.now() });
		ghost.appendMessage(createAssistantMessage("The docs are fine."));
		ircFrom(manager, "Ghost", "The docs are fine.");
		const laneFile = await parked("Lane", lane);
		await parked("Ghost", ghost);
		await tick();
		// The previous process ran /recover: it restarted Lane and skipped Ghost, then crashed mid-run.
		openedBy(manager, 101);
		const jobs = new AsyncJobManager({ retentionMs: 0 });
		const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockResolvedValue(singleResult("report"));
		const earlier = await resumeInterruptedWork(host(jobs));
		if (earlier.status !== "resumed") throw new Error(`expected resumed, got ${earlier.status}`);
		expect(earlier.restarted.map(agent => agent.jobId)).toEqual(["Lane"]);
		await jobs.waitForAll();
		await tick();
		const laneAgain = await SessionManager.open(laneFile);
		laneAgain.appendMessage(toolTurn({ id: "lane_call_2", name: "bash", args: { command: "bun test" } }));
		await laneAgain.flush();
		await laneAgain.close();
		manager.appendMessage(createAssistantMessage("Lane restarted"));
		openedBy(manager, "this");
		followUp.mockClear();

		const outcome = await resumeInterruptedWork(host(jobs));
		await jobs.waitForAll();

		if (outcome.status !== "resumed") throw new Error(`expected resumed, got ${outcome.status}`);
		expect(outcome.restarted.map(agent => agent.jobId)).toEqual(["Lane"]);
		expect([...outcome.recovered, ...outcome.skipped]).toEqual([]);
		expect(followUp.mock.calls.map(([options]) => options.id)).toEqual(["Lane"]);
		expect(outcome.notice).not.toContain("Ghost");
		await jobs.dispose();
	});

	it("does not count work the parent stopped through a harness facade as interrupted", () => {
		manager.appendMessage(
			toolTurn(
				{ id: "spawn", name: "task", args: { tasks: [] } },
				{ id: "bg", name: "bash", args: { command: "serve" } },
			),
		);
		manager.appendMessage(
			toolResult("spawn", "task", {
				async: { state: "running", jobId: "Lane", type: "task" },
				progress: [{ id: "Lane", status: "running" }],
			}),
		);
		manager.appendMessage(toolResult("bg", "bash", { async: { state: "running", jobId: "bg_1", type: "bash" } }));
		// Claude Code's TaskStop: recorded as `write` with the vendor's arguments.
		for (const id of ["Lane", "bg_1"]) {
			manager.appendMessage(toolTurn({ id: `stop_${id}`, name: "write", args: { task_id: id } }));
			manager.appendMessage(
				toolResult(`stop_${id}`, "write", {
					proc: {
						op: "cancel",
						jobs: [{ id, status: "cancelled" }],
						cancelled: [{ id, status: "cancelled" }],
					},
				}),
			);
		}
		manager.appendMessage(createAssistantMessage("stopped both"));
		openedBy(manager, "this");

		const scan = findInterruptedWork(manager.getBranch());

		expect(!scan.handled && [...scan.agents, ...scan.jobs]).toEqual([]);
	});
	it("restarts a subagent the crash cut off between its tool results and its next response", async () => {
		const lane = laneSession();
		revived(manager, "Lane");
		ircFrom(lane, "Main", "Fix the build.");
		// Every call is answered, but the loop was about to sample again on these results.
		lane.appendMessage(toolTurn({ id: "read", name: "read", args: { path: "build.ts" } }));
		lane.appendMessage(toolResult("read", "read"));
		await parked("Lane", lane);
		manager.appendMessage(createAssistantMessage("waiting on Lane"));
		openedBy(manager, "this");

		const { outcome, restartedIds } = await recover();

		expect(restartedIds).toEqual(["Lane"]);
		expect(outcome.restarted.map(agent => agent.jobId)).toEqual(["Lane"]);
	});

	it("restarts a subagent whose last turn paused rather than ended", async () => {
		const lane = laneSession();
		revived(manager, "Lane");
		ircFrom(lane, "Main", "Fix the build.");
		lane.appendMessage({
			...createAssistantMessage("Checking the build config next."),
			stopDetails: { type: "pause_turn" },
		});
		await parked("Lane", lane);
		manager.appendMessage(createAssistantMessage("waiting on Lane"));
		openedBy(manager, "this");

		const { outcome, restartedIds, delivered } = await recover();

		expect(restartedIds).toEqual(["Lane"]);
		expect(outcome.recovered).toEqual([]);
		expect(delivered.map(item => item.id)).toEqual(["Lane"]);
		expect(delivered[0]?.text).toBe("report");
	});

	it("delivers a recovered report again when the previous recovery's delivery never reached the journal", async () => {
		const lost = laneSession();
		const landed = laneSession();
		for (const [id, lane] of [
			["Lost", lost],
			["Landed", landed],
		] as const) {
			revived(manager, id);
			ircFrom(lane, "Main", "Report your findings.");
			yielded(lane, `${id}_y`, { data: { report: `${id} findings` } });
			await parked(id, lane);
		}
		await tick();
		// The previous process ran /recover, then crashed: only Landed's result made it into the journal.
		openedBy(manager, 101);
		const first = await recover();
		expect(first.outcome.recovered.map(agent => agent.jobId)).toEqual(["Lost", "Landed"]);
		manager.appendCustomMessageEntry("async-result", "Landed findings", true, {
			jobs: [{ jobId: "Landed", type: "task" }],
		});
		manager.appendMessage(createAssistantMessage("reading the recovered results"));
		openedBy(manager, "this");

		const { outcome, restartedIds, delivered } = await recover();

		expect(restartedIds).toEqual([]);
		expect(outcome.recovered.map(agent => agent.jobId)).toEqual(["Lost"]);
		expect(delivered.map(item => item.id)).toEqual(["Lost"]);
		expect(delivered[0]?.text).toContain("Lost findings");
	});

	it("recovers a sectioned yield's assembled result and its structured output", async () => {
		const lane = laneSession();
		lane.appendSessionInit({
			systemPrompt: ["reviewer prompt"],
			task: "review",
			tools: ["read", "yield"],
			agent: "reviewer",
			outputSchema: {
				properties: { findings: { type: "array", items: { type: "string" } }, verdict: { type: "string" } },
			},
		});
		revived(manager, "Lane");
		ircFrom(lane, "Main", "Review the fix.");
		yielded(lane, "s1", { type: ["findings"], data: "P1: the cache key ignores the locale" });
		yielded(lane, "s2", { type: ["verdict"], data: "incorrect" });
		// The data-less finalize keeps the sections as the result.
		yielded(lane, "done", { type: "result" });
		await parked("Lane", lane);
		manager.appendMessage(createAssistantMessage("waiting on the review"));
		openedBy(manager, "this");

		const { outcome, delivered } = await recover();

		expect(outcome.recovered.map(agent => agent.jobId)).toEqual(["Lane"]);
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.text).toContain("P1: the cache key ignores the locale");
		expect(delivered[0]?.text).toContain('"verdict": "incorrect"');
		expect(delivered[0]?.text).not.toContain('"type": "result"');
		expect(delivered[0]?.structured).toMatchObject({
			status: "valid",
			data: { findings: ["P1: the cache key ignores the locale"], verdict: "incorrect" },
		});
	});

	it("keeps the original start of subagents a /recover cut off before it recorded an outcome", async () => {
		const lane = laneSession();
		const legacy = laneSession();
		const laneStart = Date.now();
		revived(manager, "Lane");
		revived(manager, "Legacy");
		for (const [id, session] of [
			["Lane", lane],
			["Legacy", legacy],
		] as const) {
			ircFrom(session, "Main", "Report your findings.");
			yielded(session, `${id}_y`, { data: { report: `${id} findings` } });
			await parked(id, session);
		}
		await tick();
		// The previous process's /recover crashed before its outcome; an older binary recorded no start for Legacy.
		openedBy(manager, 101);
		manager.appendCustomEntry(RECOVER_CUSTOM_TYPE, {
			toolCalls: [],
			jobs: [],
			agents: [
				{ jobId: "Lane", type: "task", label: "Lane", startedAt: laneStart },
				{ jobId: "Legacy", type: "task", label: "Legacy" },
			],
		});
		manager.appendMessage(createAssistantMessage("recovering"));
		openedBy(manager, "this");

		const { outcome, restartedIds, delivered } = await recover();

		expect(restartedIds).toEqual([]);
		expect(outcome.recovered.map(agent => agent.jobId)).toEqual(["Lane", "Legacy"]);
		expect(delivered.map(item => item.text)).toEqual([
			expect.stringContaining("Lane findings"),
			expect.stringContaining("Legacy findings"),
		]);
	});

	it("does not count work a fork child inherited from its parent as its own", async () => {
		manager.appendMessage(toolTurn({ id: "spawn", name: "task", args: { tasks: [] } }));
		manager.appendMessage(
			toolResult("spawn", "task", {
				async: { state: "running", jobId: "Fork", type: "task" },
				progress: [{ id: "Fork", status: "running" }],
			}),
		);
		const child = laneSession();
		// The fork copies the parent's history, running background job and live spawn included.
		child.appendMessage(toolTurn({ id: "serve", name: "bash", args: { command: "bun run serve" } }), {
			inherited: true,
		});
		child.appendMessage(toolResult("serve", "bash", { async: { state: "running", jobId: "bg_1", type: "bash" } }), {
			inherited: true,
		});
		child.appendMessage(toolTurn({ id: "spawn", name: "task", args: { tasks: [] } }), { inherited: true });
		child.appendMessage(
			toolResult("spawn", "task", {
				async: { state: "running", jobId: "Fork", type: "task" },
				progress: [{ id: "Fork", status: "running" }],
			}),
			{ inherited: true },
		);
		child.appendSessionInit({
			systemPrompt: ["fork prompt"],
			task: "check the docs",
			tools: ["read"],
			agent: "task",
		});
		child.appendMessage({ role: "user", content: "Check the docs.", timestamp: Date.now() });
		yielded(child, "y", { data: { report: "the docs are fine" } });
		await parked("Fork", child);
		manager.appendMessage(createAssistantMessage("waiting on Fork"));
		openedBy(manager, "this");

		const { outcome, restartedIds, delivered } = await recover();

		expect(restartedIds).toEqual([]);
		expect(outcome.recovered.map(agent => agent.jobId)).toEqual(["Fork"]);
		expect(delivered[0]?.text).toContain("the docs are fine");
	});
});

describe("/recover after the SDK's resume repair", () => {
	let dir: TempDir;
	const sessions: AgentSession[] = [];
	const registries: ModelRegistry[] = [];

	beforeEach(() => {
		dir = TempDir.createSync("@recover-sdk-");
		AgentRegistry.resetGlobalForTests();
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const registry of registries.splice(0)) registry.authStorage.close();
		dir.removeSync();
	});

	it("reports a call a quit left running, continues once, and adds no second result", async () => {
		// The previous process quit while `bash` ran: session_exit lists the call as pending.
		const previous = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"));
		previous.appendMessage({ role: "user", content: "run the tests", timestamp: Date.now() });
		previous.appendMessage(toolTurn({ id: "call_1", name: "bash", args: { command: "bun test" } }));
		previous.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: "call_1",
			toolName: "bash",
			startedAt: new Date().toISOString(),
		});
		previous.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "dispose",
			kind: "normal",
			recordedAt: new Date().toISOString(),
			pendingToolCalls: [{ toolCallId: "call_1", toolName: "bash", args: { command: "bun test" } }],
		});
		await previous.flush();
		const file = previous.getSessionFile();
		await previous.close();
		if (!file) throw new Error("previous session has no file");

		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(auth);
		registries.push(modelRegistry);
		const mock = createMockModel({ responses: [{ content: [{ type: "text", text: "re-running the tests" }] }] });
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			modelRegistry,
			model: mock,
			sessionManager: await SessionManager.open(file),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
			}),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: [],
		});
		sessions.push(session);
		session.agent.streamFn = mock.stream;
		const resultsOf = () =>
			session.sessionManager
				.getBranch()
				.flatMap(entry =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "call_1"
						? [entry.message]
						: [],
				);
		// Opening paired the call with an interruption result for the provider.
		expect(resultsOf()).toHaveLength(1);

		const output: string[] = [];
		const result = await executeAcpBuiltinSlashCommand("/recover", {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			cwd: dir.path(),
			output: text => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		});
		await session.waitForIdle();

		expect(result).toEqual({ consumed: true, agentInvoked: true });
		expect(output.join("\n")).toContain("1 interrupted tool call");
		const notice = session.sessionManager
			.getBranch()
			.flatMap(entry =>
				entry.type === "custom_message" && entry.customType === RECOVER_CUSTOM_TYPE ? [entry.content] : [],
			);
		expect(notice.join("\n")).toContain("`call_1` bash: bun test");
		expect(mock.calls).toHaveLength(1);
		expect(resultsOf()).toHaveLength(1);
	});
});
