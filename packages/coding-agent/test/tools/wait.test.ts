import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalWait } from "@oh-my-pi/pi-coding-agent/eval/handle-bridge";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { blockedAwaitsOf, WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import type { TaskParams } from "@oh-my-pi/pi-tui/tools/task";

function session(manager?: AsyncJobManager, agentId = "Main", settings: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: process.cwd(),
		settings: Settings.isolated({ "launch.enabled": false, ...settings }),
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => agentId,
	} as unknown as ToolSession;
}

/** A task job `Main` owns for agent `id`; cancelling it rejects the run, as a real spawn's abort does. */
function ownedJob(manager: AsyncJobManager, id: string, ownerId = "Main"): PromiseWithResolvers<string> {
	const run = Promise.withResolvers<string>();
	manager.register(
		"task",
		id,
		async ({ signal }) => {
			signal.addEventListener("abort", () => run.reject(new Error(`${id} cancelled`)), { once: true });
			return run.promise;
		},
		{ id, agentId: id, ownerId },
	);
	return run;
}

/**
 * Run `Child` through the real inline `task` path. The mocked executor reports
 * the child's first progress, as a live child does before any tool call, then
 * parks it in a message-only `wait`; returns that wait's text.
 */
async function inlineChildWaitText(): Promise<string> {
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
		const progress = {
			index: 0,
			id,
			agent: options.agent.name,
			agentSource: "bundled" as const,
			task: "task prompt",
			durationMs: 5,
			tokens: 0,
			requests: 1,
		};
		options.onProgress?.({ ...progress, status: "running", recentTools: [], recentOutput: [], toolCount: 0, cost: 0 });
		registerRunning(id, "Main");
		childText = firstText(await new WaitTool(session(undefined, id)).execute("child-wait", {}));
		return {
			...progress,
			assignment: "Build the migration API.",
			exitCode: 0,
			output: "Migration API built.",
			stderr: "",
			truncated: false,
		};
	});
	const tool = await TaskTool.create({
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "task.batch": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "Main",
		agentRegistry: AgentRegistry.global(),
	} as unknown as ToolSession);
	await tool.execute("inline-spawn", {
		context: "Ship the migration API.",
		tasks: [{ name: "Child", agent: "task", task: "Build the migration API." }],
	} as TaskParams);
	// The owner's turn is released once the inline child settles.
	expect(blockedAwaitsOf(AgentRegistry.global(), "Main")).toEqual([]);
	return childText;
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
		registerRunning("Main");
		const childText = await inlineChildWaitText();
		expect(childText).toStartWith("No message within");
		expect(childText).toContain("`Main` is blocked waiting on your result");
		// An owner parked in an inline spawn reads no message until the child settles.
		expect(childText).not.toContain("agent://Main");
	});

	test("returns at once to a child its owner runs inline while an unrelated peer streams", async () => {
		registerRunning("Main");
		// A revived lane, blocked in nothing: it could message the child but owes it nothing.
		registerRunning("Lane", "Main");
		const childText = await inlineChildWaitText();
		expect(childText).not.toContain("none can come");
		expect(childText).toContain("`Main` is blocked waiting on your result: it reads no message until you `yield`.");
	});

	test("returns at once when its owner waits on its result alone while an unrelated peer streams", async () => {
		vi.useFakeTimers();
		registerRunning("Main");
		registerRunning("Child", "Main");
		registerRunning("Lane", "Main");
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const childRun = ownedJob(manager, "Child");
		const parentWait = new WaitTool(session(manager, "Main")).execute("parent-wait", {});
		const text = firstText(await new WaitTool(session(manager, "Child")).execute("child-wait", {}));
		// Lane could still message Child, so no deadlock is claimed; only Main is named.
		expect(text).not.toContain("none can come");
		expect(text).toContain("`Main` is blocked waiting on your result: ask it via `agent://Main`");
		childRun.resolve("migration API ready");
		await parentWait;
	});

	test("keeps waiting while its owner also waits on a sibling that is still working", async () => {
		vi.useFakeTimers();
		registerRunning("Main");
		registerRunning("Builder", "Main");
		registerRunning("Reviewer", "Main");
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const builderRun = ownedJob(manager, "Builder");
		const reviewerRun = ownedJob(manager, "Reviewer");
		// Main wakes on either result; Builder waits for Reviewer's message.
		const parentWait = new WaitTool(session(manager, "Main")).execute("parent-wait", {});
		const builderWait = new WaitTool(session(manager, "Builder")).execute("builder-wait", {});
		vi.advanceTimersByTime(600_000);
		expect(await stillPending(builderWait)).toBe(true);
		await IrcBus.global().send({ from: "Reviewer", to: "Builder", body: "schema ready" });
		expect((await builderWait).details?.waited).toMatchObject({ from: "Reviewer", body: "schema ready" });
		builderRun.resolve("built");
		await parentWait;
		reviewerRun.resolve("reviewed");
	});

	test("does not count a spawn queued for its permit as finishing on its own", async () => {
		registerRunning("Main");
		registerRunning("Child", "Main");
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const childRun = ownedJob(manager, "Child");
		// With `task.maxConcurrency` 1, Queued waits for Child's permit: no run, no registry ref.
		const queuedRun = Promise.withResolvers<string>();
		manager.register("task", "Queued", async () => queuedRun.promise, {
			id: "Queued",
			agentId: "Queued",
			ownerId: "Main",
			queued: true,
		});
		const parentWait = new WaitTool(session(manager, "Main")).execute("parent-wait", {});
		expect(firstText(await new WaitTool(session(manager, "Child")).execute("child-wait", {}))).toContain(
			"agent://Main",
		);
		childRun.resolve("migration API ready");
		await parentWait;
		queuedRun.resolve("queued done");
	});

	test("an aborted wait releases its hold", async () => {
		registerRunning("Main");
		const registry = AgentRegistry.global();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const childRun = ownedJob(manager, "Child");
		const controller = new AbortController();
		const parentWait = new WaitTool(session(manager, "Main")).execute("parent-wait", {}, controller.signal);
		expect(blockedAwaitsOf(registry, "Main")).toMatchObject([{ agents: ["Child"], independent: false }]);
		controller.abort();
		await expect(parentWait).rejects.toThrow("Operation aborted");
		expect(blockedAwaitsOf(registry, "Main")).toEqual([]);
		childRun.resolve("migration API ready");
	});

	test("returns at once to an agent its owner awaits in an eval wait(), and releases the hold after", async () => {
		registerRunning("Main");
		registerRunning("Worker", "Main");
		registerRunning("Lane", "Main");
		const registry = AgentRegistry.global();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const workerRun = ownedJob(manager, "Worker");
		const evalSession = session(manager, "Main", { "eval.autoBackground.enabled": false });
		const evalWait = runEvalWait({ items: [{ kind: "agent", id: "Worker" }] }, { session: evalSession });
		expect(blockedAwaitsOf(registry, "Main")).toMatchObject([
			{ agents: ["Worker"], inline: true, independent: false },
		]);
		const text = firstText(await new WaitTool(session(manager, "Worker")).execute("worker-wait", {}));
		expect(text).toContain("`Main` is blocked waiting on your result: it reads no message until you `yield`.");
		workerRun.resolve("done");
		expect((await evalWait).items[0]).toMatchObject({ status: "completed", text: "done" });
		expect(blockedAwaitsOf(registry, "Main")).toEqual([]);
	});

	test("an eval wait() with a timeout can end alone, and a timed-out or aborted one releases its hold", async () => {
		vi.useFakeTimers();
		registerRunning("Main");
		registerRunning("Worker", "Main");
		const registry = AgentRegistry.global();
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		ownedJob(manager, "Worker");
		const evalSession = session(manager, "Main", { "eval.autoBackground.enabled": false });
		const timed = runEvalWait({ items: [{ kind: "agent", id: "Worker" }], timeoutMs: 60_000 }, { session: evalSession });
		expect(blockedAwaitsOf(registry, "Main")).toMatchObject([
			{ agents: ["Worker"], inline: true, independent: true },
		]);
		// Main resumes on its timeout without Worker's result, so Worker keeps waiting for a message.
		const workerWait = new WaitTool(session(manager, "Worker")).execute("worker-wait", {});
		expect(await stillPending(workerWait)).toBe(true);
		vi.advanceTimersByTime(60_000);
		expect((await timed).items[0]).toMatchObject({ status: "running" });
		expect(blockedAwaitsOf(registry, "Main")).toEqual([]);
		expect(await stillPending(workerWait)).toBe(true);

		const controller = new AbortController();
		const aborted = runEvalWait(
			{ items: [{ kind: "agent", id: "Worker" }] },
			{ session: evalSession, signal: controller.signal },
		);
		// Without a timeout Main needs Worker's result to go on.
		expect(firstText(await workerWait)).toContain("`Main` is blocked waiting on your result");
		controller.abort();
		await expect(aborted).rejects.toThrow();
		expect(blockedAwaitsOf(registry, "Main")).toEqual([]);
	});

	test("publishes no hold for an eval wait() that auto-background can hand back", async () => {
		registerRunning("Main");
		registerRunning("Worker", "Main");
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const workerRun = ownedJob(manager, "Worker");
		const evalSession = session(manager, "Main", { "eval.autoBackground.enabled": true });
		const evalWait = runEvalWait({ items: [{ kind: "agent", id: "Worker" }] }, { session: evalSession });
		expect(blockedAwaitsOf(AgentRegistry.global(), "Main")).toEqual([]);
		workerRun.resolve("done");
		await evalWait;
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
		// Main is a root orchestrator waiting on its lanes' messages, not on a job.
		const mainWait = new WaitTool(session(undefined, "Main")).execute("main-wait", {});
		const childWait = new WaitTool(session(undefined, "Child")).execute("child-wait", {});
		vi.advanceTimersByTime(600_000);
		// Lane is still working and could message either of them.
		expect(await stillPending(childWait)).toBe(true);
		AgentRegistry.global().setStatus("Lane", "idle");
		for (const result of await Promise.all([mainWait, childWait])) {
			expect(firstText(result)).toStartWith("No message within 10m, and none can come");
		}
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
