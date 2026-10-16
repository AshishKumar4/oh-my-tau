/**
 * `omp --restore` runs `/recover`'s implementation as the session starts: one
 * recovery path, so a restored session restarts a cut-off subagent once,
 * starts its own turn from the recovery notice, and a second restore (or a
 * later `/recover`) finds the interruption handled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getAgentTombstonePath } from "@oh-my-pi/pi-coding-agent/registry/agent-tombstone";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createSessionOpenData, SESSION_OPEN_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { RECOVER_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/resume-interrupted";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";

function toolTurn(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		...createAssistantMessage(""),
		content: [{ type: "toolCall", id, name, arguments: args }],
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

const laneReport: SingleResult = {
	index: 0,
	id: "Lane",
	agent: "task",
	agentSource: "bundled",
	task: "fix the lane",
	exitCode: 0,
	output: "lane report",
	stderr: "",
	truncated: false,
	durationMs: 1,
	tokens: 1,
	requests: 1,
};

describe("restoreSession (omp --restore)", () => {
	let dir: TempDir;
	let main: SessionManager;
	let jobs: AsyncJobManager;

	beforeEach(() => {
		dir = TempDir.createSync("@pi-restore-");
		main = SessionManager.create(dir.path(), path.join(dir.path(), "sessions"));
		jobs = new AsyncJobManager({ retentionMs: 0 });
		AgentRegistry.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await jobs.dispose();
		await main.close();
		AgentRegistry.resetGlobalForTests();
		dir.removeSync();
	});

	/** The session surface `/recover` works through, plus the notice turn `--restore` starts. */
	function session(): { session: AgentSession; notices: Array<{ customType: string; content: unknown }> } {
		const bus = new EventBus();
		const notices: Array<{ customType: string; content: unknown }> = [];
		const host = {
			sessionManager: main,
			asyncJobManager: jobs,
			eventBus: bus,
			subagentEventBus: bus,
			agent: { replaceMessages: () => {} },
			buildDisplaySessionContext: () => main.buildSessionContext(),
			getAgentId: () => "Main",
			sendCustomMessage: async (message: { customType: string; content: unknown }) => {
				notices.push(message);
				return true;
			},
		};
		return { session: host as unknown as AgentSession, notices };
	}

	it("restarts a cut-off subagent through /recover, starts the notice turn, and is handled the second time", async () => {
		// The subagent's transcript: the previous process died inside its bash call.
		const lane = SessionManager.create(dir.path(), path.join(dir.path(), "children"));
		lane.appendMessage(toolTurn("lane_call", "bash", { command: "bun test lane" }));
		await lane.flush();
		const laneFile = lane.getSessionFile();
		await lane.close();
		if (!laneFile) throw new Error("subagent session has no file");
		AgentRegistry.global().register({
			id: "Lane",
			displayName: "Lane",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: laneFile,
			status: "parked",
		});
		// The parent's journal: it spawned the lane and heard nothing back.
		main.appendMessage(toolTurn("spawn", "task", { tasks: [] }));
		main.appendMessage(
			toolResult("spawn", "task", {
				async: { state: "running", jobId: "Lane", type: "task" },
				progress: [{ id: "Lane", status: "running", description: "fix the lane" }],
			}),
		);
		main.appendMessage(createAssistantMessage("lane running"));
		main.appendCustomEntry(SESSION_OPEN_CUSTOM_TYPE, createSessionOpenData());
		const delivered: Array<{ id: string; text: string }> = [];
		jobs.registerDeliverySink("Main", (id, text) => {
			delivered.push({ id, text });
		});
		const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue(laneReport);
		const { session: restored, notices } = session();

		const outcome = await restoreSession(restored);
		await jobs.waitForAll();
		await jobs.drainDeliveries({ timeoutMs: 1000 });

		expect(outcome).toEqual({ turn: true, subagents: ["Lane"] });
		expect(followUp).toHaveBeenCalledTimes(1);
		// Resumed with /recover's message, not by running the cut-off call again.
		expect(followUp.mock.calls[0]?.[0]).toMatchObject({ id: "Lane", resultOwnerId: "Main" });
		expect(followUp.mock.calls[0]?.[0].message).toContain("A system glitch stopped OMP and interrupted your run");
		expect(delivered.some(delivery => delivery.id === "Lane" && delivery.text.includes("lane report"))).toBe(true);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.customType).toBe(RECOVER_CUSTOM_TYPE);
		expect(String(notices[0]?.content)).toContain("- `Lane` (fix the lane)");

		// The run is recorded: a second restore restarts nothing and starts no turn.
		expect(await restoreSession(restored)).toEqual({ turn: false, subagents: [] });
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(notices).toHaveLength(1);
	});

	it("goes on with a main turn a crash cut off before the answer, with nothing pending", async () => {
		// The previous process recorded the request and a tool's result, then died
		// before answering: no open call, job or subagent.
		main.appendMessage({ role: "user", content: "run the tests", timestamp: Date.now() });
		main.appendMessage(toolTurn("tests", "bash", { command: "bun test" }));
		main.appendMessage(toolResult("tests", "bash"));
		main.appendCustomEntry(SESSION_OPEN_CUSTOM_TYPE, createSessionOpenData());
		const entries = main.getBranch().length;
		const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn");
		const { session: restored, notices } = session();

		expect(await restoreSession(restored)).toEqual({ turn: true, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
		expect(notices).toHaveLength(1);
		expect(String(notices[0]?.content)).toContain("Your last turn was cut off before you answered it.");
		// Only the /recover record: the finished tool call does not run again.
		expect(
			main
				.getBranch()
				.slice(entries)
				.map(entry => entry.type),
		).toEqual(["custom"]);
		expect(await restoreSession(restored)).toEqual({ turn: false, subagents: [] });
	});

	it("restarts a live subagent the parent's message woke when the crash cut that run off", async () => {
		// The child had finished its spawn and was idle; the parent's message woke
		// it ("woken", not "revived") and the process died inside the new run.
		const lane = SessionManager.create(dir.path(), path.join(dir.path(), "children"));
		lane.appendMessage(createAssistantMessage("The first fix is in."));
		await Bun.sleep(5);
		main.appendMessage(toolTurn("wake", "write", { path: "agent://Lane" }));
		main.appendMessage(
			toolResult("wake", "write", {
				message: { op: "send", from: "Main", to: "Lane", receipts: [{ to: "Lane", outcome: "woken" }] },
			}),
		);
		main.appendMessage(createAssistantMessage("Lane is on the flaky test."));
		lane.appendCustomMessageEntry("irc:incoming", "Now fix the flaky test.", true, {
			id: "wake-msg",
			from: "Main",
			message: "Now fix the flaky test.",
		});
		lane.appendMessage(toolTurn("rerun", "bash", { command: "bun test --rerun-each 20" }));
		await lane.flush();
		const laneFile = lane.getSessionFile();
		await lane.close();
		if (!laneFile) throw new Error("subagent session has no file");
		AgentRegistry.global().register({
			id: "Lane",
			displayName: "Lane",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: laneFile,
			status: "parked",
		});
		main.appendCustomEntry(SESSION_OPEN_CUSTOM_TYPE, createSessionOpenData());
		const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue(laneReport);
		const { session: restored, notices } = session();

		const outcome = await restoreSession(restored);
		await jobs.waitForAll();

		expect(outcome).toEqual({ turn: true, subagents: ["Lane"] });
		expect(followUp).toHaveBeenCalledTimes(1);
		expect(followUp.mock.calls[0]?.[0]).toMatchObject({ id: "Lane", resultOwnerId: "Main" });
		expect(String(notices[0]?.content)).toContain("Restarted subagents");
	});

	it("goes on with each subagent cut off mid-turn as a job its parent receives, not with finished or killed ones", async () => {
		// Upstream's --restore scenario (2051670f54) on the merged path: three
		// spawned subagents, transcripts under the main session, the parent heard
		// from none. One was cut off mid tool call, one finished with its own
		// answer, one was cut off and then killed (its tombstone sits beside it).
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		const cutOff: Message[] = [
			{ role: "user", content: "work", timestamp: Date.now() },
			toolTurn("call_1", "read", { path: "a.ts" }),
		];
		const finished: Message[] = [
			{ role: "user", content: "work", timestamp: Date.now() },
			createAssistantMessage("all done"),
		];
		const writeSubagent = async (id: string, messages: Message[]): Promise<string> => {
			const file = path.join(mainFile.slice(0, -6), `${id}.jsonl`);
			const sub = await SessionManager.open(file, undefined, undefined, {
				initialCwd: dir.path(),
				parentSession: mainFile,
				suppressBreadcrumb: true,
			});
			sub.appendSessionInit({ systemPrompt: ["sub prompt"], task: `${id} task`, tools: ["read"] });
			for (const message of messages) sub.appendMessage(message);
			await sub.close();
			return file;
		};
		main.appendMessage(toolTurn("spawn", "task", { tasks: [] }));
		main.appendMessage(
			toolResult("spawn", "task", {
				async: { state: "running", jobId: "Cut", type: "task" },
				progress: ["Cut", "Done", "Killed"].map(id => ({ id, status: "running", description: `${id} task` })),
			}),
		);
		main.appendMessage(createAssistantMessage("fanned out"));
		// The children ran after the spawn.
		await Bun.sleep(5);
		await writeSubagent("Cut", cutOff);
		await writeSubagent("Done", finished);
		await fs.writeFile(getAgentTombstonePath(await writeSubagent("Killed", cutOff)), "");
		main.appendCustomEntry(SESSION_OPEN_CUSTOM_TYPE, createSessionOpenData());
		const delivered: Array<{ id: string; text: string }> = [];
		jobs.registerDeliverySink("Main", (id, text) => {
			delivered.push({ id, text });
		});
		const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockResolvedValue(laneReport);
		const { session: restored } = session();

		const outcome = await restoreSession(restored);
		await jobs.waitForAll();
		await jobs.drainDeliveries({ timeoutMs: 1000 });

		// Only the cut-off one runs again; the killed one stays killed. The
		// finished one is not restarted: its answer, which never reached the
		// parent, is delivered once instead.
		expect(followUp.mock.calls.map(([options]) => options.id)).toEqual(["Cut"]);
		expect(outcome.subagents.toSorted()).toEqual(["Cut", "Done"]);
		expect(delivered.map(delivery => delivery.id).toSorted()).toEqual(["Cut", "Done"]);
		expect(delivered.find(delivery => delivery.id === "Done")?.text).toContain("all done");
	});

	it("starts no turn when the previous process left nothing unfinished", async () => {
		main.appendMessage(createAssistantMessage("all done"));
		main.appendCustomEntry(SESSION_OPEN_CUSTOM_TYPE, createSessionOpenData());
		const followUp = vi.spyOn(executorModule, "runSubagentFollowUpTurn");
		const { session: restored, notices } = session();

		expect(await restoreSession(restored)).toEqual({ turn: false, subagents: [] });
		expect(followUp).not.toHaveBeenCalled();
		expect(notices).toEqual([]);
	});
});
