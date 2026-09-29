import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import type { TaskParams } from "@oh-my-pi/pi-tui/tools/task";

function session(manager?: AsyncJobManager, agentId = "Main"): ToolSession {
	return {
		cwd: process.cwd(),
		settings: Settings.isolated({ "launch.enabled": false }),
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => agentId,
	} as unknown as ToolSession;
}

/** Register an agent whose turn is in flight, so `isRunning` corroborates it. */
function registerRunning(id: string, parentId?: string): void {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: parentId ? "sub" : "main",
		parentId,
		session: { isStreaming: true } as never,
		status: "running",
	});
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const part = result.content[0];
	return part?.type === "text" ? (part.text ?? "") : "";
}

/** Whether `promise` is still unsettled once every queued microtask has run. */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	const settle = () => {
		settled = true;
	};
	void promise.then(settle, settle);
	for (let turn = 0; turn < 50 && !settled; turn++) await Promise.resolve();
	return !settled;
}

describe("wait", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("a settling job is recovered once, suppressing its async duplicate", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		const id = manager.register("bash", "build", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager)).execute("wait-1", {});
		resolve("build complete");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "build complete" });
		expect(manager.isJobResultConsumed(id)).toBe(true);
		expect(manager.isDeliverySuppressed(id)).toBe(true);
	});

	test("returns immediately when no job, running peer, or owned service can wake it", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({
			id: "Idle",
			displayName: "Idle",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		const result = await new WaitTool(session()).execute("wait-2", {});
		expect(result.details).toMatchObject({ op: "wait", jobs: [] });
		expect(result.useless).toBe(true);
	});

	test("an interrupted wait leaves later job completion auto-deliverable", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			delivered.push(text);
		});
		const { promise, resolve } = Promise.withResolvers<string>();
		manager.register("bash", "still running", async () => promise, { ownerId: "Main" });
		const controller = new AbortController();
		const waiting = new WaitTool(session(manager)).execute("interrupted", {}, controller.signal);
		controller.abort();
		await expect(waiting).rejects.toThrow("Operation aborted");
		resolve("finished afterward");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual(["finished afterward"]);
	});

	test("a message interrupt returns a non-error result and leaves the completion auto-deliverable", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			delivered.push(text);
		});
		const { promise, resolve } = Promise.withResolvers<string>();
		manager.register("bash", "still running", async () => promise, { ownerId: "Main" });
		const controller = new AbortController();
		const waiting = new WaitTool(session(manager)).execute("interrupted-by-message", {}, controller.signal);
		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		const result = await waiting;
		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Wait interrupted by message." }]);
		expect(result.details).toMatchObject({ op: "wait", interrupted: true });
		resolve("finished afterward");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual(["finished afterward"]);
	});

	test("returns a settled job whose delivery has not reached the transcript yet", async () => {
		const manager = new AsyncJobManager({});
		// The owner's sink parks the result like a yield-queue receipt awaiting injection.
		const injected = Promise.withResolvers<void>();
		const sinkEntered = Promise.withResolvers<string>();
		manager.registerDeliverySink("Main", async (_id, text) => {
			sinkEntered.resolve(text);
			await injected.promise;
		});
		const id = manager.register("task", "EchoPeer", async () => "received=kestrel42", {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		expect(await sinkEntered.promise).toBe("received=kestrel42");

		const result = await new WaitTool(session(manager)).execute("wait-undelivered", {});
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "received=kestrel42" });
		expect(manager.isDeliverySuppressed(id)).toBe(true);
		injected.resolve();
	});

	test("blocks on a peer's completion job registered after the wait started", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({
			id: "EchoPeer",
			displayName: "EchoPeer",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const waiting = new WaitTool(session(manager)).execute("wait-peer-yield", {});
		// The peer's yield is accepted mid-turn: its completion job exists before the ref goes idle.
		const finalized = Promise.withResolvers<string>();
		const id = manager.register("task", "EchoPeer", async () => finalized.promise, {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		registry.setStatus("EchoPeer", "idle");
		finalized.resolve("followup-done");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "followup-done" });
	});

	test("a root orchestrator keeps waiting while its revived lanes run, then returns their message", async () => {
		vi.useFakeTimers();
		registerRunning("Main");
		// Lanes woken through `write agent://<lane>`: wake turns, not jobs Main owns.
		registerRunning("LaneA", "Main");
		registerRunning("LaneB", "Main");
		const waiting = new WaitTool(session()).execute("orchestrator-wait", {});
		vi.advanceTimersByTime(600_000);
		expect(await stillPending(waiting)).toBe(true);
		await IrcBus.global().send({ from: "LaneB", to: "Main", body: "lane B merged" });
		const result = await waiting;
		expect(result.details?.waited).toMatchObject({ from: "LaneB", body: "lane B merged" });
	});

	test("an owned job that appears mid-wait is waited on after its peer stops", async () => {
		vi.useFakeTimers();
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({
			id: "EchoPeer",
			displayName: "EchoPeer",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const waiting = new WaitTool(session(manager)).execute("message-then-job", {});
		vi.advanceTimersByTime(1_000);
		const finalized = Promise.withResolvers<string>();
		const id = manager.register("task", "EchoPeer", async () => finalized.promise, {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		registry.setStatus("EchoPeer", "idle");
		await Promise.resolve();
		// Long after the peer stopped: only the job (or the job-wait cap) may end this wait.
		vi.advanceTimersByTime(300_000);
		finalized.resolve("late result");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "late result" });
	});

	test("returns at once when its owner blocks in wait on its result, not on a delivery watch", async () => {
		vi.useFakeTimers();
		const registry = AgentRegistry.global();
		const streaming = { isStreaming: true } as never;
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: streaming, status: "running" });
		registry.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Main",
			session: streaming,
			status: "running",
		});
		// Subagents share the process job manager with their owner.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const childRun = Promise.withResolvers<string>();
		manager.register("task", "Child", async () => childRun.promise, {
			id: "Child",
			agentId: "Child",
			ownerId: "Main",
		});
		// A workpool watches each member turn to suppress auto-delivery while its owner keeps working.
		manager.watchJobs(["Child"]);
		const childWait = new WaitTool(session(manager, "Child")).execute("child-wait", {});
		vi.advanceTimersByTime(600_000);
		expect(await stillPending(childWait)).toBe(true);
		const parentWait = new WaitTool(session(manager, "Main")).execute("parent-wait", {});
		const text = firstText(await childWait);
		expect(text).toStartWith("No message within 10m");
		expect(text).toContain("agent://Main");
		childRun.resolve("migration API ready");
		expect((await parentWait).details?.jobs?.[0]).toMatchObject({ id: "Child", status: "completed" });
	});

	test("returns at once to a child its owner runs inline", async () => {
		const registry = AgentRegistry.global();
		registerRunning("Main");
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [
				{
					name: "task",
					description: "General-purpose task agent",
					systemPrompt: "You are a task agent.",
					source: "bundled",
				},
			],
			projectAgentsDir: null,
		});
		let childText = "";
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			registerRunning(id, "Main");
			childText = firstText(await new WaitTool(session(undefined, id)).execute("child-wait", {}));
			return {
				index: 0,
				id,
				agent: options.agent.name,
				agentSource: "bundled",
				task: "task prompt",
				assignment: "Build the migration API.",
				exitCode: 0,
				output: "Migration API built.",
				stderr: "",
				truncated: false,
				durationMs: 5,
				tokens: 0,
				requests: 1,
			};
		});
		const tool = await TaskTool.create({
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "async.enabled": false, "task.batch": true }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			agentRegistry: registry,
		} as unknown as ToolSession);
		await tool.execute("inline-spawn", {
			context: "Ship the migration API.",
			tasks: [{ name: "Child", agent: "task", task: "Build the migration API." }],
		} as TaskParams);
		expect(childText).toContain("`Main` is blocked waiting on your result");
		// An owner parked in an inline spawn reads no message until the child settles.
		expect(childText).not.toContain("agent://Main");
	});

	test("siblings that both wait only for a message each return at once", async () => {
		vi.useFakeTimers();
		// Main is between turns: nobody else is left to message either sibling.
		AgentRegistry.global().register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "idle" });
		registerRunning("Left", "Main");
		registerRunning("Right", "Main");
		const left = new WaitTool(session(undefined, "Left")).execute("left-wait", {});
		// Right is still working and could message Left.
		expect(await stillPending(left)).toBe(true);
		const right = new WaitTool(session(undefined, "Right")).execute("right-wait", {});
		for (const result of await Promise.all([left, right])) {
			const text = firstText(result);
			expect(text).toStartWith("No message within");
			expect(text).not.toContain("blocked waiting on your result");
			expect(result.useless).toBe(true);
		}
	});

	test("re-checks when the last peer that could message it stops running", async () => {
		vi.useFakeTimers();
		registerRunning("Main");
		registerRunning("Child", "Main");
		registerRunning("Lane", "Main");
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const childRun = Promise.withResolvers<string>();
		manager.register("task", "Child", async () => childRun.promise, {
			id: "Child",
			agentId: "Child",
			ownerId: "Main",
		});
		const parentWait = new WaitTool(session(manager, "Main")).execute("parent-wait", {});
		const childWait = new WaitTool(session(manager, "Child")).execute("child-wait", {});
		vi.advanceTimersByTime(600_000);
		// Lane is still working and could message Child.
		expect(await stillPending(childWait)).toBe(true);
		AgentRegistry.global().setStatus("Lane", "idle");
		expect(firstText(await childWait)).toContain("agent://Main");
		childRun.resolve("migration API ready");
		await parentWait;
	});

	test("returns at once to a grandchild whose owner and owner's owner both wait on results", async () => {
		registerRunning("Main");
		registerRunning("Lane", "Main");
		registerRunning("Scout", "Lane");
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const laneRun = Promise.withResolvers<string>();
		const scoutRun = Promise.withResolvers<string>();
		manager.register("task", "Lane", async () => laneRun.promise, { id: "Lane", agentId: "Lane", ownerId: "Main" });
		manager.register("task", "Scout", async () => scoutRun.promise, {
			id: "Scout",
			agentId: "Scout",
			ownerId: "Lane",
		});
		const mainWait = new WaitTool(session(manager, "Main")).execute("main-wait", {});
		const laneWait = new WaitTool(session(manager, "Lane")).execute("lane-wait", {});
		// Main is blocked on Lane, which is blocked on Scout: nobody is left to message Scout.
		const scoutText = firstText(await new WaitTool(session(manager, "Scout")).execute("scout-wait", {}));
		expect(scoutText).toContain("agent://Lane");
		scoutRun.resolve("scouted");
		await laneWait;
		laneRun.resolve("lane done");
		await mainWait;
	});

	test("a root orchestrator keeps waiting while a lane's child breaks the lane's cycle", async () => {
		vi.useFakeTimers();
		registerRunning("Main");
		registerRunning("Lane", "Main");
		registerRunning("Scout", "Lane");
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const scoutRun = Promise.withResolvers<string>();
		manager.register("task", "Scout", async () => scoutRun.promise, {
			id: "Scout",
			agentId: "Scout",
			ownerId: "Lane",
		});
		const laneWait = new WaitTool(session(manager, "Lane")).execute("lane-wait", {});
		const mainWait = new WaitTool(session(manager, "Main")).execute("main-wait", {});
		// Only Scout's `yield` can move Lane, so only Scout is handed the turn back.
		const scoutText = firstText(await new WaitTool(session(manager, "Scout")).execute("scout-wait", {}));
		expect(scoutText).toContain("agent://Lane");
		expect(await stillPending(mainWait)).toBe(true);
		scoutRun.resolve("scouted");
		await laneWait;
		await IrcBus.global().send({ from: "Lane", to: "Main", body: "lane merged" });
		expect((await mainWait).details?.waited).toMatchObject({ from: "Lane", body: "lane merged" });
	});

	test("returns an incoming peer message without any background jobs", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({
			id: "Peer",
			displayName: "Peer",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const waiting = new WaitTool(session()).execute("message-only", {});
		await IrcBus.global().send({ from: "Peer", to: "Main", body: "shared file released" });
		const result = await waiting;
		expect(result.details?.waited).toMatchObject({ from: "Peer", body: "shared file released" });
	});

	test("returns an incoming peer message while the watched job remains live", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "Peer", kind: "sub", parentId: "Main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise } = Promise.withResolvers<string>();
		const id = manager.register("bash", "unfinished", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager)).execute("wait-3", {});
		await IrcBus.global().send({ from: "Peer", to: "Main", body: "the file is yours" });
		const result = await waiting;
		expect(result.details?.waited).toMatchObject({ from: "Peer", body: "the file is yours" });
		expect(manager.getJob(id)?.status).toBe("running");
		manager.cancel(id);
	});
});
