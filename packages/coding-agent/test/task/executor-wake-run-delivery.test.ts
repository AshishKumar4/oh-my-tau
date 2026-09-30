/**
 * A message-woken subagent's run lasts until it settles, like a spawned run:
 * turns the lane drives itself after the wake (its own background-job results,
 * messages injected mid-turn) belong to the same run, and its yield reaches the
 * parent exactly once as an owner-routed async result. A wake that only
 * answers, with nothing left running, is relayed to the waker and closes.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
import { attachIrcWakeTurnMonitor } from "@oh-my-pi/pi-coding-agent/task/executor";
import { type AgentDefinition, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const LANE = "ProbeLane";
const REVIEWER = "Reviewer";

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

interface Lane {
	session: AgentSession;
	manager: AsyncJobManager;
	/** Async results the parent's job manager delivered to `Main`. */
	delivered: string[];
	/** Lifecycle frame statuses the lane's runs published. */
	lifecycle: string[];
	/** Resolves once the lane has started its background job. */
	jobStarted: Promise<void>;
	/** Completes the lane's background job with this output. */
	finishJob: (output: string) => void;
	/** Resolves when a run publishes its end frame. */
	runEnded: Promise<void>;
	/** Waits for the run's relay and every delivery of the parent's jobs to land. */
	settle: () => Promise<void>;
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
 * the test decides when that job finishes.
 */
function createLane(responses: MockHandler[]): Lane {
	const tempDir = TempDir.createSync("@pi-wake-run-delivery-");
	tempDirs.push(tempDir);
	const manager = new AsyncJobManager({});
	const delivered: string[] = [];
	manager.registerDeliverySink(MAIN_AGENT_ID, (_jobId, text) => {
		delivered.push(text);
	});
	const job = Promise.withResolvers<string>();
	const jobStarted = Promise.withResolvers<void>();
	const backgroundTool: AgentTool<typeof backgroundSchema> = {
		name: "background",
		label: "Background",
		description: "Run a command in the background",
		parameters: backgroundSchema,
		async execute(_toolCallId, params) {
			const jobId = manager.register("bash", params.label, () => job.promise, { ownerId: LANE });
			jobStarted.resolve();
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
	registry.register({ id: LANE, displayName: LANE, kind: "sub", parentId: MAIN_AGENT_ID, session, status: "idle" });
	registry.syncSessionStatus(LANE, session);

	const eventBus = new EventBus();
	const lifecycle: string[] = [];
	const runEnded = Promise.withResolvers<void>();
	eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
		if (!isRecord(data) || data.id !== LANE || typeof data.status !== "string") return;
		lifecycle.push(data.status);
		if (data.status !== "started") runEnded.resolve();
	});
	attachIrcWakeTurnMonitor(session, { id: LANE, agent: laneAgent, eventBus, artifactsDir: tempDir.path() });

	const lane: Lane = {
		session,
		manager,
		delivered,
		lifecycle,
		jobStarted: jobStarted.promise,
		finishJob: output => job.resolve(output),
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

/** Watches the bus; the returned reader lists the bodies the lane has sent to `to`. */
function captureRelays(): (to: string) => string[] {
	const send = vi.spyOn(IrcBus.global(), "send");
	return to =>
		send.mock.calls.flatMap(([message]) => (message.from === LANE && message.to === to ? [message.body] : []));
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
		// open: the lane stays listed as running and the parent heard nothing yet.
		expect(lane.lifecycle).toEqual(["started"]);
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

	it("relays a text-only answer with nothing pending, registers no job, and leaves nothing open", async () => {
		const lane = createLane([{ content: ["The fix is ready."] }, { content: ["Still ready."] }]);
		const relaysTo = captureRelays();

		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Is the fix ready?" });
		await lane.runEnded;
		await lane.settle();

		expect(relaysTo(MAIN_AGENT_ID)).toEqual(["The fix is ready."]);
		expect(lane.delivered).toEqual([]);
		expect(lane.manager.getRunningJobs()).toEqual([]);
		expect(lane.manager.getRecentJobs()).toEqual([]);
		expect(lane.lifecycle).toEqual(["started", "completed"]);
		expect(AgentRegistry.global().get(LANE)?.status).toBe("idle");

		// The run closed: the next wake opens (and closes) a run of its own.
		await IrcBus.global().send({ from: MAIN_AGENT_ID, to: LANE, body: "Still?" });
		await lane.session.waitForIdle();
		await drainEventLoop();
		await lane.settle();
		expect(relaysTo(MAIN_AGENT_ID)).toEqual(["The fix is ready.", "Still ready."]);
		expect(lane.lifecycle).toEqual(["started", "completed", "started", "completed"]);
		expect(lane.delivered).toEqual([]);
	});
});
