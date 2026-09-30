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

	function host(jobs?: AsyncJobManager): RecoverHost & { replaced: AgentMessage[][] } {
		const replaced: AgentMessage[][] = [];
		return {
			sessionManager: manager,
			asyncJobManager: jobs,
			agent: { replaceMessages: messages => replaced.push(messages) },
			buildDisplaySessionContext: () => manager.buildSessionContext(),
			getAgentId: () => "Main",
			replaced,
		};
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

	it("restarts a subagent once when /recover runs twice at the same time", async () => {
		const child = SessionManager.create(dir.path(), path.join(dir.path(), "children"));
		child.appendMessage(createAssistantMessage("working"));
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
});
