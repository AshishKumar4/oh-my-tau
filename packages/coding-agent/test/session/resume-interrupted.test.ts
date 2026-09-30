import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	createSessionOpenData,
	SESSION_EXIT_CUSTOM_TYPE,
	SESSION_OPEN_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import {
	findInterruptedWork,
	INTERRUPTED_TOOL_RESULT_TEXT,
	RECOVER_CUSTOM_TYPE,
	type RecoverHost,
	resumeInterruptedWork,
} from "@oh-my-pi/pi-coding-agent/session/resume-interrupted";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";

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

	function deliveries(jobs: AsyncJobManager): Array<{ id: string; text: string }> {
		const delivered: Array<{ id: string; text: string }> = [];
		jobs.registerDeliverySink("Main", (id, text) => {
			delivered.push({ id, text });
		});
		return delivered;
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
			child.appendSessionInit({ systemPrompt: `${agent} prompt`, task: "work", tools: ["read"], agent });
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
		lane.appendMessage(toolTurn({ id: "y", name: "yield", args: { data: { report: "probe passed: 3 of 3" } } }));
		lane.appendMessage(toolResult("y", "yield"));
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
});
