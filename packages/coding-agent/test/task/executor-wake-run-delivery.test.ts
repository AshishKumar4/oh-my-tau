/**
 * A message-woken subagent's run lasts until it settles, like a follow-up run:
 * turns the lane drives itself after the wake (its own background-job results,
 * messages injected mid-turn, later wakes) belong to the same run. Its
 * owner-routed job opens with the run, and its yield reaches the parent exactly
 * once through that job. A wake the parent's message started that only answers
 * hands the answer to the parent through that job too (upstream a1a410e33e), and
 * no relay repeats it; a wake a peer started is relayed to that peer and
 * settles the parent's job without a delivery.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { registerArtifactsDir } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
import { attachIrcWakeTurnMonitor, runSubagentFollowUpTurn } from "@oh-my-pi/pi-coding-agent/task/executor";
import { type AgentDefinition, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, TempDir, untilAborted } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const LANE = "ProbeLane";
const REVIEWER = "Reviewer";
/** An agent other than `Main` that spawned the lane. */
const LEAD = "Lead";

const laneAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const authStorage = createInMemoryAuthStorage();
authStorage.keys.setRuntime("mock", "test-key");
const modelRegistry = new ModelRegistry(authStorage);

afterAll(() => {
	authStorage.close();
});

const backgroundSchema = type({ label: type("string") });

interface LaneOptions {
	/** Wall-clock cap for each wake run. */
	maxRuntimeMs?: number;
	/** Adopt the lane with this idle TTL, so it parks like a kept-alive subagent. */
	idleTtlMs?: number;
	/** Running-job cap of the job manager the lane and its parent share, read at every registration. */
	maxRunningJobs?: () => number;
	/** The agent that spawned the lane; `Main` by default. */
	parentId?: string;
	/** Runs write no `<id>.md` artifact. */
	noArtifacts?: boolean;
}

interface Lane {
	session: AgentSession;
	manager: AsyncJobManager;
	mock: MockModel;
	/** Async results the parent's job manager delivered to `Main`. */
	delivered: string[];
	/** Lifecycle frame statuses the lane's runs published. */
	lifecycle: string[];
	/** Resolves with the id of the first background job the lane started. */
	jobStarted: Promise<string>;
	/** Resolves with the id of the background job the lane started under `label`. */
	jobStartedAs: (label: string) => Promise<string>;
	/** Completes the lane's background job `label` with this output. */
	finishJob: (output: string, label?: string) => void;
	/** Resolves when a run publishes its end frame. */
	runEnded: Promise<void>;
	/** Waits for the run's relay and every delivery of the parent's jobs to land. */
	settle: () => Promise<void>;
	/** Where the lane's runs write `<id>.md`. */
	artifactsDir: string;
}

const openLanes: Lane[] = [];
const tempDirs: TempDir[] = [];

function toolCall(name: string, args: Record<string, unknown>): MockResponse {
	return { content: [{ type: "toolCall", name, arguments: args }] };
}

/**
 * A kept-alive subagent `LANE` whose parent is `Main`, scripted by `responses`
 * (the model is the only mocked seam). Its `background` tool starts a job the
 * lane owns on the shared job manager, the way `bash` backgrounds a command;
 * the test decides when that job finishes, and cancelling it stops it.
 */
function createLane(responses: MockHandler[], laneOptions: LaneOptions = {}): Lane {
	const tempDir = TempDir.createSync("@pi-wake-run-delivery-");
	tempDirs.push(tempDir);
	const manager = new AsyncJobManager({ maxRunningJobs: laneOptions.maxRunningJobs });
	const delivered: string[] = [];
	manager.registerDeliverySink(MAIN_AGENT_ID, (_jobId, text) => {
		delivered.push(text);
	});
	const jobStarted = Promise.withResolvers<string>();
	const jobs = new Map<string, { started: PromiseWithResolvers<string>; output: PromiseWithResolvers<string> }>();
	const jobFor = (label: string) => {
		let job = jobs.get(label);
		if (!job) {
			job = { started: Promise.withResolvers<string>(), output: Promise.withResolvers<string>() };
			jobs.set(label, job);
		}
		return job;
	};
	const backgroundTool: AgentTool<typeof backgroundSchema> = {
		name: "background",
		label: "Background",
		description: "Run a command in the background",
		parameters: backgroundSchema,
		async execute(_toolCallId, params) {
			const job = jobFor(params.label);
			const jobId = manager.register(
				"bash",
				params.label,
				({ signal }) => untilAborted(signal, job.output.promise),
				{ ownerId: LANE },
			);
			jobStarted.resolve(jobId);
			job.started.resolve(jobId);
			return { content: [{ type: "text", text: `Backgrounded as job ${jobId}.` }] };
		},
	};
	const yieldTool = new YieldTool({
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	});
	const tools: AgentTool[] = [yieldTool, backgroundTool];
	const mock = createMockModel({ responses });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		}),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		agentId: LANE,
		agentKind: "sub",
		asyncJobManager: manager,
	});
	const registry = AgentRegistry.global();
	registry.register({ id: MAIN_AGENT_ID, displayName: MAIN_AGENT_ID, kind: "main", session: null, status: "running" });
	registry.register({ id: REVIEWER, displayName: REVIEWER, kind: "sub", session: null, status: "running" });
	registry.register({ id: LEAD, displayName: LEAD, kind: "sub", session: null, status: "running" });
	const ref = registry.register({
		id: LANE,
		displayName: LANE,
		kind: "sub",
		parentId: laneOptions.parentId ?? MAIN_AGENT_ID,
		session,
		status: "idle",
	});
	registry.syncSessionStatus(LANE, session);
	if (laneOptions.idleTtlMs !== undefined) {
		AgentLifecycleManager.global().adopt(LANE, { idleTtlMs: laneOptions.idleTtlMs }, ref);
	}

	const eventBus = new EventBus();
	const lifecycle: string[] = [];
	const runEnded = Promise.withResolvers<void>();
	eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
		if (!isRecord(data) || data.id !== LANE || typeof data.status !== "string") return;
		lifecycle.push(data.status);
		if (data.status !== "started") runEnded.resolve();
	});
	attachIrcWakeTurnMonitor(session, {
		id: LANE,
		agent: laneAgent,
		eventBus,
		artifactsDir: laneOptions.noArtifacts ? undefined : tempDir.path(),
		maxRuntimeMs: laneOptions.maxRuntimeMs,
	});

	const lane: Lane = {
		artifactsDir: tempDir.path(),
		session,
		manager,
		mock,
		delivered,
		lifecycle,
		jobStarted: jobStarted.promise,
		jobStartedAs: label => jobFor(label).started.promise,
		finishJob: (output, label = "probe") => jobFor(label).output.resolve(output),
		runEnded: runEnded.promise,
		settle: async () => {
			await session.waitForIrcReplies();
			await manager.waitForOwnerJobs(MAIN_AGENT_ID);
			await manager.drainDeliveries({ timeoutMs: 2000, filter: { ownerId: MAIN_AGENT_ID } });
		},
	};
	openLanes.push(lane);
	return lane;
}

/** Lets any post-turn settle work run to completion. */
async function drainEventLoop(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

/** Polls `condition` until it holds or `timeoutMs` passes; returns whether it held. */
async function until(condition: () => boolean, timeoutMs = 2000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline) return false;
		await Bun.sleep(5);
	}
	return true;
}

/** Watches the bus; the returned reader lists the bodies the lane has sent to `to`. */
function captureRelays(): (to: string) => string[] {
	const send = vi.spyOn(IrcBus.global(), "send");
	return to =>
		send.mock.calls.flatMap(([message]) => (message.from === LANE && message.to === to ? [message.body] : []));
}

/** `Main`'s `wait` tool, over the job manager it shares with the lane. */
function parentWait(lane: Lane): WaitTool {
	return new WaitTool({
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "launch.enabled": false }),
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: lane.manager,
		getAgentId: () => MAIN_AGENT_ID,
	});
}

/** Ids of the running jobs `Main` owns on the lane's manager. */
function parentJobs(lane: Lane): string[] {
	return lane.manager.getRunningJobs({ ownerId: MAIN_AGENT_ID }).map(job => job.agentId ?? job.id);
}

describe("IRC wake run delivery", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const lane of openLanes.splice(0)) {
			await lane.session.dispose();
			await lane.manager.dispose({ timeoutMs: 1000 });
		}
		for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("delivers a yield made in a turn started by the lane's own background job", async () => {
		const lane = createLane([
			toolCall("background", { label: "probe" }),
			{ content: ["Waiting for the probe."] },
			toolCall("yield", { data: { report: "probe passed: 3 of 3" } }),
		]);
		const relaysTo = captureRelays();

		const receipt = await IrcBus.global().send({
			from: MAIN_AGENT_ID,
			to: LANE,
			body: "Run the probe, then report.",
		});
		expect(receipt.outcome).toBe("woken");
		await lane.jobStarted;
		await lane.session.waitForIdle();
		await drainEventLoop();

		// The wake turn ended on "Waiting for the probe.", but the run is still
		// open: the lane stays listed as running, and its parent has a running
		// job for it while it heard nothing yet.
		expect(lane.lifecycle).toEqual(["started"]);
		expect(parentJobs(lane)).toEqual([LANE]);
		expect(lane.delivered).toEqual([]);

		lane.finishJob("3 of 3 passed");
		await lane.runEnded;
		await lane.settle();

		expect(lane.delivered).toHaveLength(1);
		expect(lane.delivered[0]).toContain("probe passed: 3 of 3");
		expect(lane.lifecycle).toEqual(["started", "completed"]);
		// The parent hears through the job only, not again as a relay.
		expect(relaysTo(MAIN_AGENT_ID)).toEqual([]);
		expect(lane.manager.getRunningJobs()).toEqual([]);
	});

	it("marks the lane's published output as the previous run's while its run waits on its own job", async () => {
		const lane = createLane([
			toolCall("background", { label: "probe" }),
			{ content: ["Waiting for the probe."] },
			toolCall("yield", { data: { report: "probe passed: 3 of 3" } }),
		]);
		const unregisterDir = registerArtifactsDir(lane.artifactsDir);
		const previous = "previous run: probe never ran";
		await fs.writeFile(path.join(lane.artifactsDir, `${LANE}.md`), previous);
		const read = async () => (await new AgentProtocolHandler().resolve(new URL(`agent://${LANE}`) as never)).content;
		try {
			await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Run the probe, then report." });
			await lane.jobStarted;
			await lane.session.waitForIdle();
			await drainEventLoop();

			// Between turns, waiting on its own job: no turn streams, but the run
			// is open, and the file on disk is still the previous run's.
			expect(lane.session.isStreaming).toBe(false);
			const whileOpen = await read();
			expect(whileOpen).toStartWith(`> \`${LANE}\` is running a newer turn.`);
			expect(whileOpen.endsWith(previous)).toBe(true);

			lane.finishJob("3 of 3 passed");
			await lane.runEnded;
			await lane.settle();
			const settled = await read();
			expect(settled).not.toContain("running a newer turn");
			expect(settled).toContain("probe passed: 3 of 3");
		} finally {
			unregisterDir();
		}
	});

	it("warns on a JSON-path read of the previous run's output while the lane's run is open", async () => {
		const lane = createLane([
			toolCall("background", { label: "probe" }),
			{ content: ["Waiting for the probe."] },
			toolCall("yield", { data: { report: "probe passed: 3 of 3", counts: { passed: 3, total: 3 } } }),
		]);
		const unregisterDir = registerArtifactsDir(lane.artifactsDir);
		const previous = { report: "previous run: probe never ran", counts: { passed: 0, total: 3 } };
		await fs.writeFile(path.join(lane.artifactsDir, `${LANE}.md`), JSON.stringify(previous));
		const reader: ToolSession = {
			cwd: lane.artifactsDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => lane.artifactsDir,
			settings: Settings.isolated(),
		};
		/** The text blocks the model receives for `read <url>`. */
		const read = async (url: string) =>
			(await new ReadTool(reader).execute("read-lane", { path: url })).content.flatMap(part =>
				part.type === "text" ? [part.text] : [],
			);
		try {
			await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Run the probe, then report." });
			await lane.jobStarted;
			await lane.session.waitForIdle();
			await drainEventLoop();

			// The run is open between turns: both extractions are the previous run's.
			const report = await read(`agent://${LANE}/report`);
			expect(report).toHaveLength(2);
			expect(report[0]).toContain(`\`${LANE}\` is running a newer turn.`);
			expect(report[0]).toContain("PREVIOUS run");
			expect(report[1]).toBe(previous.report);
			const counts = await read(`agent://${LANE}/counts`);
			expect(counts).toHaveLength(2);
			expect(counts[0]).toContain("PREVIOUS run");
			expect(JSON.parse(counts[1] ?? "")).toEqual(previous.counts);

			lane.finishJob("3 of 3 passed");
			await lane.runEnded;
			await lane.settle();
			// The run rewrote the output: plain values, no warning.
			expect(await read(`agent://${LANE}/report`)).toEqual(["probe passed: 3 of 3"]);
			const settled = await read(`agent://${LANE}/counts`);
			expect(settled).toHaveLength(1);
			expect(JSON.parse(settled[0] ?? "")).toEqual({ passed: 3, total: 3 });
		} finally {
			unregisterDir();
		}
	});

	it("lets the parent's wait block on the woken lane and return its result", async () => {
		const lane = createLane([
			toolCall("background", { label: "probe" }),
			{ content: ["Waiting for the probe."] },
			toolCall("yield", { data: { report: "probe passed: 3 of 3" } }),
		]);
		const wait = parentWait(lane);

		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Run the probe, then report." });
		await lane.jobStarted;
		await lane.session.waitForIdle();
		let returned = false;
		const waiting = wait.execute("wait-1", {}).finally(() => {
			returned = true;
		});
		await drainEventLoop();
		expect(returned).toBe(false);

		lane.finishJob("3 of 3 passed");
		const result = await waiting;
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).toContain("probe passed: 3 of 3");
		await lane.settle();
		// The wait consumed the result; it is not delivered a second time.
		expect(lane.delivered).toEqual([]);
	});

	it("delivers a yield made after a parent message injected while the lane was streaming", async () => {
		let injected: string | undefined;
		const lane = createLane([
			async () => {
				// The lane is mid-turn (woken by the reviewer) when the parent writes.
				const receipt = await IrcBus.global().send({
					from: MAIN_AGENT_ID,
					to: LANE,
					body: "Also run the probe before you answer.",
				});
				injected = receipt.outcome;
				return toolCall("background", { label: "probe" });
			},
			{ content: ["Waiting for the probe."] },
			toolCall("yield", { data: { report: "review answered, probe passed" } }),
		]);
		const relaysTo = captureRelays();

		await IrcBus.global().send({ from: REVIEWER, to: LANE, body: "Is the fix ready for review?" });
		await lane.jobStarted;
		await lane.session.waitForIdle();
		await drainEventLoop();
		expect(injected).toBe("injected");
		expect(lane.delivered).toEqual([]);

		lane.finishJob("3 of 3 passed");
		await lane.runEnded;
		await lane.settle();

		expect(lane.delivered).toHaveLength(1);
		expect(lane.delivered[0]).toContain("review answered, probe passed");
		// The reviewer that woke the lane gets the run's answer once, not the
		// interim "Waiting for the probe.".
		const reviewerRelays = relaysTo(REVIEWER);
		expect(reviewerRelays).toHaveLength(1);
		expect(reviewerRelays[0]).toContain("review answered, probe passed");
		expect(relaysTo(MAIN_AGENT_ID)).toEqual([]);
	});

	it("folds a wake that lands while the run waits on its job into that run", async () => {
		const reviewerAnswered = Promise.withResolvers<void>();
		const lane = createLane([
			toolCall("background", { label: "probe" }),
			{ content: ["Waiting for the probe."] },
			() => {
				reviewerAnswered.resolve();
				return { content: ["Still waiting on the probe."] };
			},
			toolCall("yield", { data: { report: "probe passed: 3 of 3" } }),
		]);
		const relaysTo = captureRelays();

		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Run the probe, then report." });
		await lane.jobStarted;
		await lane.session.waitForIdle();
		const receipt = await IrcBus.global().send({ from: REVIEWER, to: LANE, body: "Status?" });
		expect(receipt.outcome).toBe("woken");
		await reviewerAnswered.promise;
		await lane.session.waitForIdle();
		await drainEventLoop();
		expect(lane.lifecycle).toEqual(["started"]);
		expect(relaysTo(REVIEWER)).toEqual([]);

		lane.finishJob("3 of 3 passed");
		await lane.runEnded;
		await lane.settle();

		expect(lane.lifecycle).toEqual(["started", "completed"]);
		expect(lane.delivered).toHaveLength(1);
		expect(lane.delivered[0]).toContain("probe passed: 3 of 3");
		const reviewerRelays = relaysTo(REVIEWER);
		expect(reviewerRelays).toHaveLength(1);
		expect(reviewerRelays[0]).toContain("probe passed: 3 of 3");
		expect(relaysTo(MAIN_AGENT_ID)).toEqual([]);
	});

	it("takes a message that lands after the wake turn's last aside poll while its job still runs", async () => {
		const lane = createLane([
			toolCall("background", { label: "probe" }),
			{ content: ["Waiting for the probe."] },
			{ content: ["The probe is still running."] },
			toolCall("yield", { data: { report: "probe passed: 3 of 3" } }),
		]);
		const relaysTo = captureRelays();
		// The wake turn's loop has made its final aside poll when it ends; the
		// session is still settling the turn, so the message waits as a tail.
		let tailSent = false;
		lane.session.agent.subscribe(event => {
			if (event.type !== "agent_end" || tailSent) return;
			tailSent = true;
			void IrcBus.global().send({ from: REVIEWER, to: LANE, body: "Is the probe still running?" });
		});

		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Run the probe, then report." });
		await lane.jobStarted;
		// Answered while the lane's own job is still running.
		expect(await until(() => lane.mock.calls.length >= 3)).toBe(true);
		expect(lane.lifecycle).toEqual(["started"]);

		lane.finishJob("3 of 3 passed");
		await lane.runEnded;
		await lane.settle();
		expect(lane.delivered).toHaveLength(1);
		expect(lane.delivered[0]).toContain("probe passed: 3 of 3");
		expect(relaysTo(REVIEWER)).toHaveLength(1);
	});

	it("delivers a yield made inside the wake turn exactly once", async () => {
		const lane = createLane([toolCall("yield", { data: { report: "answered directly" } })]);
		const relaysTo = captureRelays();

		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "What did you find?" });
		await lane.runEnded;
		await lane.settle();
		await drainEventLoop();

		expect(lane.delivered).toHaveLength(1);
		expect(lane.delivered[0]).toContain("answered directly");
		expect(lane.lifecycle).toEqual(["started", "completed"]);
		expect(relaysTo(MAIN_AGENT_ID)).toEqual([]);
	});

	it("delivers once, with the refreshed result, when the wake turn yields while its job still runs", async () => {
		const lane = createLane([
			toolCall("background", { label: "probe" }),
			toolCall("yield", { data: { report: "stale: probe still running" } }),
			// The run parks the early yield and tells the lane what it waits on.
			() => {
				lane.finishJob("3 of 3 passed");
				return { content: ["Standing by for the probe."] };
			},
			toolCall("yield", { data: { report: "fresh: probe passed" } }),
		]);

		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Run the probe, then report." });
		await lane.runEnded;
		await lane.settle();
		await drainEventLoop();

		expect(lane.delivered).toHaveLength(1);
		expect(lane.delivered[0]).toContain("fresh: probe passed");
		expect(lane.delivered[0]).not.toContain("stale: probe still running");
	});

	it("opens a fresh run for a wake that lands after a terminal yield ended the run", async () => {
		const lane = createLane([
			async () => {
				// Queued mid-turn; the terminal yield below stops the turn before
				// the loop reads it, so it wakes the lane once the run has ended.
				await IrcBus.global().send({ from: REVIEWER, to: LANE, body: "Please also run the probe." });
				return toolCall("yield", { data: { report: "first: status reported" } });
			},
			toolCall("background", { label: "probe" }),
			{ content: ["Waiting for the probe."] },
			toolCall("yield", { data: { report: "second: probe passed" } }),
		]);

		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Report your status." });
		await lane.jobStarted;
		await lane.session.waitForIdle();
		await drainEventLoop();
		lane.finishJob("3 of 3 passed");

		expect(await until(() => lane.lifecycle.filter(status => status === "completed").length === 2)).toBe(true);
		await lane.settle();
		expect(lane.delivered).toHaveLength(2);
		expect(lane.delivered[0]).toContain("first: status reported");
		expect(lane.delivered[1]).toContain("second: probe passed");
	});

	it("answers the parent through its job when the parent's message woke a lane that only answers", async () => {
		const lane = createLane([{ content: ["The fix is ready."] }, { content: ["Still ready."] }]);
		const relaysTo = captureRelays();

		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Is the fix ready?" });
		await lane.runEnded;
		await lane.settle();

		expect(lane.delivered).toEqual(["The fix is ready."]);
		expect(relaysTo(MAIN_AGENT_ID)).toEqual([]);
		expect(lane.manager.getRunningJobs()).toEqual([]);
		expect(lane.manager.getRecentJobs(10, { ownerId: MAIN_AGENT_ID }).map(job => job.status)).toEqual(["completed"]);
		expect(lane.lifecycle).toEqual(["started", "completed"]);
		expect(AgentRegistry.global().get(LANE)?.status).toBe("idle");

		// The run closed: the next wake opens (and closes) a run of its own.
		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Still?" });
		await lane.session.waitForIdle();
		await drainEventLoop();
		await lane.settle();
		expect(lane.delivered).toEqual(["The fix is ready.", "Still ready."]);
		expect(lane.lifecycle).toEqual(["started", "completed", "started", "completed"]);
		expect(relaysTo(MAIN_AGENT_ID)).toEqual([]);
	});

	it("answers the parent through its job when the parent steers a run a peer woke", async () => {
		const lane = createLane([
			async () => {
				// Mid-turn, the parent's message is steered into the running turn
				// (IrcBridge's parent-steer path): no wake observer sees it.
				await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Also check the mask path." });
				return { content: ["Checking line 42."] };
			},
			{ content: ["Line 42 is fine; the mask path is fixed."] },
		]);
		const relaysTo = captureRelays();

		await IrcBus.global().send({ from: REVIEWER, to: LANE, body: "Is line 42 fine?" });
		await lane.runEnded;
		await lane.settle();

		// The parent asked, so it hears the run's end once, through its job.
		expect(lane.delivered).toEqual(["Line 42 is fine; the mask path is fixed."]);
		expect(relaysTo(MAIN_AGENT_ID)).toEqual([]);
		expect(relaysTo(REVIEWER)).toEqual(["Line 42 is fine; the mask path is fixed."]);
	});

	it("tells the parent that woke it when a run fails, through its job alone", async () => {
		const lane = createLane([{ stopReason: "error", errorMessage: "provider exploded" }]);
		const relaysTo = captureRelays();

		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Run the probe, then report." });
		await lane.runEnded;
		await lane.settle();

		expect(relaysTo(MAIN_AGENT_ID)).toEqual([]);
		expect(lane.delivered).toHaveLength(1);
		expect(lane.delivered[0]).toContain("provider exploded");
		expect(lane.manager.getRecentJobs(10, { ownerId: MAIN_AGENT_ID }).map(job => job.status)).toEqual(["failed"]);
		expect(lane.lifecycle).toEqual(["started", "failed"]);
	});

	it("cancels the run and reaps its background work when the parent kills the lane's job", async () => {
		const lane = createLane([
			toolCall("background", { label: "probe" }),
			toolCall("yield", { data: { report: "stale: probe still running" } }),
			{ content: ["Standing by for the probe."] },
		]);

		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Run the probe, then report." });
		const probeId = await lane.jobStarted;
		expect(await until(() => lane.mock.calls.length >= 3)).toBe(true);
		await lane.session.waitForIdle();
		const [wakeJob] = lane.manager.getRunningJobs({ ownerId: MAIN_AGENT_ID });
		if (!wakeJob) throw new Error("the woken lane has no job for its parent");

		expect(lane.manager.cancel(wakeJob.id, { ownerId: MAIN_AGENT_ID })).toBe(true);
		expect(await until(() => lane.manager.getJob(probeId)?.status === "cancelled")).toBe(true);
		await lane.runEnded;
		await lane.settle();
		expect(lane.manager.getRunningJobs()).toEqual([]);
		expect(lane.delivered).toEqual([]);
	});

	it("reaps a timed-out run's background work so the idle lane parks", async () => {
		const lane = createLane([toolCall("background", { label: "server" }), { content: ["The server is up."] }], {
			maxRuntimeMs: 300,
			idleTtlMs: 50,
		});

		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Start the dev server." });
		const serverId = await lane.jobStarted;
		await lane.session.waitForIdle();
		// Idle while its own job runs is mid-run: the idle TTL does not park it.
		await Bun.sleep(150);
		expect(AgentRegistry.global().get(LANE)?.status).toBe("idle");

		await lane.runEnded;
		expect(lane.lifecycle).toEqual(["started", "aborted"]);
		expect(await until(() => lane.manager.getJob(serverId)?.status === "cancelled")).toBe(true);
		expect(await until(() => AgentRegistry.global().get(LANE)?.status === "parked")).toBe(true);
	});

	it("holds a follow-up run until the open wake run ends, so each yield is delivered once", async () => {
		const lane = createLane([
			toolCall("background", { label: "probe" }),
			{ content: ["Waiting for the probe."] },
			toolCall("yield", { data: { report: "probe passed: 3 of 3" } }),
			toolCall("yield", { data: { report: "handoff: summary written" } }),
		]);

		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Run the probe, then report." });
		await lane.jobStarted;
		await lane.session.waitForIdle();
		await drainEventLoop();

		const followUp = runSubagentFollowUpTurn({ id: LANE, agent: laneAgent, message: "Write the summary." });
		await drainEventLoop();
		// The follow-up has not prompted the lane: the wake run still owns it.
		expect(lane.mock.calls).toHaveLength(2);

		lane.finishJob("3 of 3 passed");
		const result = await followUp;
		await lane.settle();

		expect(lane.delivered).toHaveLength(1);
		expect(lane.delivered[0]).toContain("probe passed: 3 of 3");
		expect(result.output).toContain("handoff: summary written");
		expect(result.output).not.toContain("probe passed");
	});
	it("returns the parent's wait with the quiet settle when a run a peer started only answers", async () => {
		const lane = createLane([
			toolCall("background", { label: "probe" }),
			{ content: ["Waiting for the probe."] },
			{ content: ["The probe passed; nothing to record."] },
		]);
		const relaysTo = captureRelays();

		await IrcBus.global().send({ from: REVIEWER, to: LANE, body: "Does the probe pass?" });
		await lane.jobStarted;
		await lane.session.waitForIdle();
		let returned = false;
		const waiting = parentWait(lane)
			.execute("wait-1", {})
			.finally(() => {
				returned = true;
			});
		await drainEventLoop();
		expect(returned).toBe(false);

		lane.finishJob("3 of 3 passed");
		const result = await waiting;
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).toContain(`${LANE} answered by message and recorded no result.`);
		await lane.settle();
		expect(lane.delivered).toEqual([]);
		expect(relaysTo(REVIEWER)).toEqual(["The probe passed; nothing to record."]);
		expect(relaysTo(MAIN_AGENT_ID)).toEqual([]);
	});

	it("reaps only its own work when a successor run took the lane before its teardown", async () => {
		const lane = createLane([
			toolCall("background", { label: "probe" }),
			{ content: ["Waiting for the probe."] },
			toolCall("background", { label: "second" }),
			{ content: ["Waiting for the second probe."] },
			toolCall("yield", { data: { report: "second probe passed" } }),
		]);

		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Run the probe, then report." });
		const probeId = await lane.jobStartedAs("probe");
		await lane.session.waitForIdle();
		await drainEventLoop();
		// Hold the killed run's session abort, so the reviewer's wake takes the
		// lane and starts work while that run's teardown is still ahead.
		const abortGate = Promise.withResolvers<void>();
		const abort = lane.session.abort.bind(lane.session);
		vi.spyOn(lane.session, "abort").mockImplementation(async options => {
			await abortGate.promise;
			return abort(options);
		});
		const [wakeJob] = lane.manager.getRunningJobs({ ownerId: MAIN_AGENT_ID });
		if (!wakeJob) throw new Error("the woken lane has no job for its parent");
		expect(lane.manager.cancel(wakeJob.id, { ownerId: MAIN_AGENT_ID })).toBe(true);

		await IrcBus.global().send({ from: REVIEWER, to: LANE, body: "Run the second probe." });
		const secondId = await lane.jobStartedAs("second");
		expect(await until(() => lane.mock.calls.length >= 4)).toBe(true);
		await lane.session.waitForIdle();
		abortGate.resolve();

		expect(await until(() => lane.lifecycle.includes("aborted"))).toBe(true);
		expect(lane.manager.getJob(probeId)?.status).toBe("cancelled");
		expect(lane.manager.getJob(secondId)?.status).toBe("running");

		lane.finishJob("2 of 2 passed", "second");
		expect(await until(() => lane.lifecycle.includes("completed"))).toBe(true);
		await lane.settle();
		expect(lane.delivered).toHaveLength(1);
		expect(lane.delivered[0]).toContain("second probe passed");
	});

	it("does not relay a follow-up run's result to the parent whose status wake it took in", async () => {
		const statusAnswered = Promise.withResolvers<void>();
		const lane = createLane([
			toolCall("background", { label: "probe" }),
			{ content: ["Waiting for the probe."] },
			() => {
				statusAnswered.resolve();
				return { content: ["The probe is still running."] };
			},
			toolCall("yield", { data: { report: "handoff: probe passed" } }),
		]);
		const relaysTo = captureRelays();

		// The caller's job (here the test) carries the follow-up's result to the parent.
		const followUp = runSubagentFollowUpTurn({
			id: LANE,
			agent: laneAgent,
			message: "Run the probe, then report.",
			resultOwnerId: MAIN_AGENT_ID,
		});
		await lane.jobStarted;
		await lane.session.waitForIdle();
		await drainEventLoop();
		const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Status?" });
		expect(receipt.outcome).toBe("woken");
		await statusAnswered.promise;
		await lane.session.waitForIdle();

		lane.finishJob("3 of 3 passed");
		const result = await followUp;
		expect(result.output).toContain("handoff: probe passed");
		expect(relaysTo(MAIN_AGENT_ID)).toEqual([]);
	});

	it("does not drive a lane released while a follow-up waited for a wake run opened during its install", async () => {
		const lane = createLane([toolCall("background", { label: "probe" }), { content: ["Waiting for the probe."] }]);
		// The parent's message wakes the lane while the follow-up installs its
		// yield contract, so a wake run owns the lane once the install returns.
		const install = lane.session.setWorkPoolYieldItems.bind(lane.session);
		vi.spyOn(lane.session, "setWorkPoolYieldItems").mockImplementationOnce(async items => {
			await install(items);
			await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Run the probe, then report." });
			await lane.jobStarted;
			await lane.session.waitForIdle();
		});

		const followUp = runSubagentFollowUpTurn({ id: LANE, agent: laneAgent, message: "Write the summary." }).then(
			() => "drove the lane",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		await lane.jobStarted;
		await lane.session.waitForIdle();
		await drainEventLoop();
		expect(lane.lifecycle).toEqual(["started"]);

		// Released while the follow-up waits for that run to end.
		await AgentLifecycleManager.global().release(LANE);
		const outcome = await Promise.race([followUp, Bun.sleep(2000).then(() => "still waiting")]);
		expect(outcome).toMatch(/released/);
		expect(lane.mock.calls).toHaveLength(2);
	});

	it("routes the result through a job opened at the run's end when the parent's manager had no room at its start", async () => {
		let cap = 1;
		const lane = createLane(
			[
				() => {
					cap = 15;
					return toolCall("background", { label: "probe" });
				},
				{ content: ["Waiting for the probe."] },
				toolCall("yield", { data: { report: "probe passed: 3 of 3" } }),
			],
			{ maxRunningJobs: () => cap },
		);
		const filler = Promise.withResolvers<string>();
		lane.manager.register("bash", "filler", () => filler.promise, { ownerId: MAIN_AGENT_ID });
		const relaysTo = captureRelays();

		await IrcBus.global().send({ from: REVIEWER, to: LANE, body: "Run the probe, then report." });
		await lane.jobStarted;
		await lane.session.waitForIdle();
		expect(parentJobs(lane)).not.toContain(LANE);

		lane.finishJob("3 of 3 passed");
		await lane.runEnded;
		filler.resolve("filler done");
		await lane.settle();
		expect(lane.delivered.filter(text => text.includes("probe passed: 3 of 3"))).toHaveLength(1);
		expect(relaysTo(MAIN_AGENT_ID)).toEqual([]);
		expect(relaysTo(REVIEWER)).toHaveLength(1);
	});

	it("hands the result to the parent as a message when its manager never has room for the job", async () => {
		const lane = createLane([toolCall("yield", { data: { report: "answered directly" } })], {
			maxRunningJobs: () => 1,
		});
		const filler = Promise.withResolvers<string>();
		lane.manager.register("bash", "filler", () => filler.promise, { ownerId: MAIN_AGENT_ID });
		const relaysTo = captureRelays();

		await IrcBus.global().send({ from: REVIEWER, to: LANE, body: "What did you find?" });
		await lane.runEnded;
		await lane.session.waitForIrcReplies();

		const toParent = relaysTo(MAIN_AGENT_ID);
		expect(toParent).toHaveLength(1);
		expect(toParent[0]).toContain("answered directly");
		expect(relaysTo(REVIEWER)).toHaveLength(1);
		expect(parentJobs(lane)).not.toContain(LANE);
		filler.resolve("filler done");
	});
	it("does not relay a follow-up run's result to its job's owner when another agent spawned the lane", async () => {
		const statusAnswered = Promise.withResolvers<void>();
		const lane = createLane(
			[
				toolCall("background", { label: "probe" }),
				{ content: ["Waiting for the probe."] },
				() => {
					statusAnswered.resolve();
					return { content: ["The probe is still running."] };
				},
				toolCall("yield", { data: { report: "handoff: probe passed" } }),
			],
			{ parentId: LEAD },
		);
		const relaysTo = captureRelays();

		// `Main` runs the follow-up in its own job (a `/recover` restart of a
		// lane it had messaged): that job, not a relay, carries the result to it.
		const followUp = runSubagentFollowUpTurn({
			id: LANE,
			agent: laneAgent,
			message: "Run the probe, then report.",
			resultOwnerId: MAIN_AGENT_ID,
		});
		await lane.jobStarted;
		await lane.session.waitForIdle();
		await drainEventLoop();
		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Status?" });
		await statusAnswered.promise;
		await lane.session.waitForIdle();

		lane.finishJob("3 of 3 passed");
		const result = await followUp;
		expect(result.output).toContain("handoff: probe passed");
		expect(relaysTo(MAIN_AGENT_ID)).toEqual([]);
	});

	it("tells the lane's own parent a follow-up result that another agent's job carries", async () => {
		const lane = createLane([toolCall("yield", { data: { report: "recovered: probe passed" } })], {
			parentId: LEAD,
		});
		const relaysTo = captureRelays();

		const result = await runSubagentFollowUpTurn({
			id: LANE,
			agent: laneAgent,
			message: "A system glitch stopped OMP and interrupted your run.",
			resultOwnerId: MAIN_AGENT_ID,
		});
		await lane.session.waitForIrcReplies();

		expect(result.output).toContain("recovered: probe passed");
		const toLead = relaysTo(LEAD);
		expect(toLead).toHaveLength(1);
		expect(toLead[0]).toContain("recovered: probe passed");
		expect(relaysTo(MAIN_AGENT_ID)).toEqual([]);
	});

	it("hands the parent the yield summary when no job can carry it and no artifact was written", async () => {
		const lane = createLane([toolCall("yield", { data: { report: "answered without an artifact" } })], {
			maxRunningJobs: () => 1,
			noArtifacts: true,
		});
		const filler = Promise.withResolvers<string>();
		lane.manager.register("bash", "filler", () => filler.promise, { ownerId: MAIN_AGENT_ID });
		const relaysTo = captureRelays();

		await IrcBus.global().send({ from: REVIEWER, to: LANE, body: "What did you find?" });
		await lane.runEnded;
		await lane.session.waitForIrcReplies();

		const toParent = relaysTo(MAIN_AGENT_ID);
		expect(toParent).toHaveLength(1);
		expect(toParent[0]).toContain("answered without an artifact");
		expect(toParent[0]).not.toContain("produced no output");
		filler.resolve("filler done");
	});
});
