import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SESSION_EXIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
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

const PREVIOUS_PROCESS_TIME = Date.UTC(2026, 8, 29, 18, 0, 0);

/** End the "previous process": entries written so far predate the returned start time; later ones follow it. */
function processBoundary(): number {
	const start = PREVIOUS_PROCESS_TIME + 60_000;
	setSystemTime(start + 1_000);
	return start;
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
		setSystemTime(PREVIOUS_PROCESS_TIME);
		dir = TempDir.createSync("@recover-");
		manager = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"));
		AgentRegistry.resetGlobalForTests();
	});

	afterEach(async () => {
		setSystemTime();
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
		const start = processBoundary();
		const h = host();

		const outcome = await resumeInterruptedWork(h, start);

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
		const start = processBoundary();

		const outcome = await resumeInterruptedWork(host(), start);

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
		const start = processBoundary();

		const scan = findInterruptedWork(manager.getBranch(), start);

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
		manager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "dispose",
			kind: "normal",
			recordedAt: new Date().toISOString(),
		});
		manager.appendMessage(toolTurn({ id: "b", name: "bash", args: { command: "second" } }));
		manager.appendMessage(toolResult("b", "bash", { async: { state: "running", jobId: "bg_1", type: "bash" } }));
		manager.appendCustomMessageEntry("async-result", "done", true, { jobs: [{ jobId: "bg_1", type: "bash" }] });
		manager.appendMessage(toolTurn({ id: "c", name: "bash", args: { command: "third" } }));
		manager.appendMessage(toolResult("c", "bash", { async: { state: "running", jobId: "bg_2", type: "bash" } }));
		manager.appendMessage(createAssistantMessage("working"));
		const start = processBoundary();

		const scan = findInterruptedWork(manager.getBranch(), start);

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
		const start = processBoundary();

		const jobs = new AsyncJobManager({ retentionMs: 0 });
		const delivered: Array<{ id: string; text: string }> = [];
		jobs.registerDeliverySink("Main", (id, text) => {
			delivered.push({ id, text });
		});
		const followUp = vi.spyOn(executor, "runSubagentFollowUpTurn").mockResolvedValue(singleResult("lane report"));

		const outcome = await resumeInterruptedWork(host(jobs), start);
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
		manager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "dispose",
			kind: "normal",
			recordedAt: new Date().toISOString(),
		});
		const start = processBoundary();

		const scan = findInterruptedWork(manager.getBranch(), start);

		expect(!scan.handled && scan.jobs.map(job => job.jobId)).toEqual(["bg_1"]);
	});

	it("does nothing the second time", async () => {
		manager.appendMessage(toolTurn({ id: "call_1", name: "bash", args: { command: "bun test" } }));
		const start = processBoundary();

		expect((await resumeInterruptedWork(host(), start)).status).toBe("resumed");
		expect((await resumeInterruptedWork(host(), start)).status).toBe("handled");
		expect(resultsFor(manager, "call_1")).toHaveLength(1);
		expect(
			manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === RECOVER_CUSTOM_TYPE),
		).toHaveLength(1);
	});

	it("reports nothing when the previous process finished its work", async () => {
		manager.appendMessage(toolTurn({ id: "a", name: "bash", args: { command: "ls" } }));
		manager.appendMessage(toolResult("a", "bash"));
		manager.appendMessage(createAssistantMessage("all done"));
		const start = processBoundary();

		expect((await resumeInterruptedWork(host(), start)).status).toBe("nothing");
	});
});
