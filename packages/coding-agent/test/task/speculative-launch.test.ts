/**
 * Contracts: speculative subagent launch for streamed batch `task` calls.
 *
 * 1. The scanner surfaces a `tasks[]` item only once its object closes —
 *    braces/quotes inside strings never close it early.
 * 2. An item's subagent starts while later items still stream; dispatch
 *    adopts the running agents instead of spawning duplicates.
 * 3. A finished call that is invalid, or whose items differ from what was
 *    launched, aborts every speculative agent.
 * 4. The host only authorizes launches under auto-allow approval with no
 *    extension lifecycle handlers.
 * 5. A spawn that forks the parent conversation never starts early: it
 *    inherits the turn that is still streaming, so dispatch snapshots it once
 *    the call finished (Claude Code's `Agent` fork included).
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AgentTool, AgentToolCall, SpeculativeOperationSink } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { harnessFacade } from "@oh-my-pi/pi-coding-agent/harness/facade";
import { harnessFacadeSpecs } from "@oh-my-pi/pi-coding-agent/harness/facades";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ForkRequestSnapshot } from "@oh-my-pi/pi-coding-agent/session/fork-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSpeculativeToolExecutionConfig } from "@oh-my-pi/pi-coding-agent/speculation/host";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { BatchArgsScanner, type TaskLaunchSession } from "@oh-my-pi/pi-coding-agent/task/speculative-launch";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { blockedAwaitsOf, WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import type { SingleResult, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const scoutAgent: AgentDefinition = {
	name: "scout",
	description: "Read-only scout",
	systemPrompt: "You are a scout.",
	source: "bundled",
	blocking: true,
};

const sink: SpeculativeOperationSink = {
	maxInFlight: 2,
	admit: async () => undefined,
	authorizeLaunch: async () => ({ allowed: true }),
	close: () => {},
};

function createSession(manager: AsyncJobManager, extra: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": true, "task.batch": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => null,
		asyncJobManager: manager,
		...extra,
	} as unknown as ToolSession;
}

function forkRequest(threadId: string): ForkRequestSnapshot {
	return {
		request: {
			provider: "openai-codex",
			model: "gpt-5.6-sol",
			baseUrl: "https://chatgpt.com/backend-api",
			accountId: "account",
			sessionId: "parent-session",
			threadId,
			input: [],
		},
		messageFingerprints: [],
	};
}

function makeResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: `${id} output.`,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
	};
}

/** Observable lifecycle of one mocked subagent run, keyed by agent id. */
interface SpawnEvents {
	started: PromiseWithResolvers<void>;
	aborted: PromiseWithResolvers<void>;
	release: PromiseWithResolvers<void>;
}

const args = {
	context: "ctx",
	tasks: [
		{ name: "Alpha", agent: "task", task: "Do A." },
		{ name: "Beta", agent: "task", task: "Do B." },
	],
};
const json = JSON.stringify(args);
/** Streamed through Alpha's closing brace, mid-way into Beta. */
const alphaClosed = json.slice(0, json.indexOf('{"name":"Beta"') + 10);
const toolCall: AgentToolCall = { type: "toolCall", id: "tc-spec", name: "task", arguments: {} };

describe("BatchArgsScanner", () => {
	it("surfaces items only once their object closes, ignoring braces inside strings", () => {
		const raw =
			'{"context":"shared }\\" ctx","tasks":[{"name":"A","task":"use {x} and \\"}\\""},{"name":"B","task":"b"}]}';
		const scanner = new BatchArgsScanner();
		const seen: number[] = [];
		for (let end = 1; end <= raw.length; end++) {
			scanner.feed(raw.slice(0, end));
			seen.push(scanner.items.length);
		}

		expect(scanner.context).toBe('shared }" ctx');
		expect(scanner.items).toEqual([
			{ name: "A", task: 'use {x} and "}"' },
			{ name: "B", task: "b" },
		]);
		// Each item appears exactly at the byte that closes it.
		expect(seen.indexOf(1)).toBe(raw.indexOf('"},{"name":"B"') + 1);
		expect(seen.indexOf(2)).toBe(raw.length - 3);
	});

	it("reads the shared brief from a facade's key, never from an item's field of the same name", () => {
		const raw =
			'{"description":"Audit","prompt":"shared brief","tasks":[{"description":"A","prompt":"Do A."},{"description":"B","prompt":"Do B."}]}';
		const scanner = new BatchArgsScanner("prompt");
		scanner.feed(raw.slice(0, raw.indexOf('{"description":"B"')));
		expect(scanner.context).toBe("shared brief");
		expect(scanner.items).toEqual([{ description: "A", prompt: "Do A." }]);
		scanner.feed(raw);
		expect(scanner.context).toBe("shared brief");
		expect(scanner.items).toHaveLength(2);
	});
});

describe("task speculative launch", () => {
	const managers: AsyncJobManager[] = [];
	const spawns = new Map<string, SpawnEvents>();
	const startedIds = new Set<string>();
	const spawn = (id: string): SpawnEvents => {
		let events = spawns.get(id);
		if (!events) {
			events = {
				started: Promise.withResolvers<void>(),
				aborted: Promise.withResolvers<void>(),
				release: Promise.withResolvers<void>(),
			};
			spawns.set(id, events);
		}
		return events;
	};

	async function openSession(
		extra?: Partial<ToolSession>,
	): Promise<{ tool: TaskTool; manager: AsyncJobManager; session: TaskLaunchSession }> {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await TaskTool.create(createSession(manager, extra));
		const session = await tool.speculation.stream?.open({ coordinator: sink, parentToolCallId: toolCall.id });
		if (!session) throw new Error("expected a task launch session");
		return { tool, manager, session: session as TaskLaunchSession };
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			const events = spawn(id);
			startedIds.add(id);
			options.signal?.addEventListener(
				"abort",
				() => {
					events.aborted.resolve();
					events.release.resolve();
				},
				{ once: true },
			);
			events.started.resolve();
			await events.release.promise;
			return makeResult(id);
		});
	});

	afterEach(async () => {
		for (const events of spawns.values()) events.release.resolve();
		spawns.clear();
		startedIds.clear();
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("starts each item as it closes and dispatch adopts the running agents", async () => {
		const { tool, manager, session } = await openSession();

		session.update(toolCall, alphaClosed);
		await spawn("Alpha").started.promise;
		expect(startedIds.has("Beta")).toBe(false);

		session.finalize({ toolCall, args });
		await spawn("Beta").started.promise;

		const result = await tool.execute(toolCall.id, args);

		expect(executorModule.runSubprocess).toHaveBeenCalledTimes(2);
		expect(result.details?.progress?.map(progress => progress.id)).toEqual(["Alpha", "Beta"]);
		spawn("Alpha").release.resolve();
		spawn("Beta").release.resolve();
		await manager.getJob("Alpha")!.promise;
		await manager.getJob("Beta")!.promise;
		expect(manager.getJob("Alpha")!.status).toBe("completed");
		expect(manager.getJob("Beta")!.status).toBe("completed");
	});

	it("aborts launched agents when the finished call is invalid", async () => {
		const { session } = await openSession();
		session.update(toolCall, alphaClosed);
		await spawn("Alpha").started.promise;

		session.finalize({
			toolCall,
			args: {
				context: "ctx",
				tasks: [
					{ name: "Alpha", task: "Do A." },
					{ name: "alpha", task: "dup" },
				],
			},
		});

		await spawn("Alpha").aborted.promise;
		expect([...startedIds]).toEqual(["Alpha"]);
	});

	it("aborts launched agents when finished items differ from what launched", async () => {
		const { session } = await openSession();
		session.update(toolCall, alphaClosed);
		await spawn("Alpha").started.promise;

		const changed = {
			context: "ctx",
			tasks: [
				{ name: "Alpha", agent: "task", task: "Do something else." },
				{ name: "Beta", agent: "task", task: "Do B." },
			],
		};
		expect(session.matchesFinalArgs(changed)).toBe(false);
		session.finalize({ toolCall, args: changed });

		await spawn("Alpha").aborted.promise;
		expect([...startedIds]).toEqual(["Alpha"]);
	});

	it("holds the turn on an inline speculative run only once dispatch adopts it", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent, scoutAgent],
			projectAgentsDir: null,
		});
		const registry = AgentRegistry.global();
		const heldIds = () => blockedAwaitsOf(registry, "Main").flatMap(block => (block.inline ? block.agents : []));
		const scoutArgs = {
			context: "ctx",
			tasks: [
				{ name: "Alpha", agent: "scout", task: "Do A." },
				{ name: "Beta", agent: "scout", task: "Do B." },
			],
		};
		const scoutJson = JSON.stringify(scoutArgs);
		const scoutAlphaClosed = scoutJson.slice(0, scoutJson.indexOf('{"name":"Beta"') + 10);

		// A run discarded before adoption never held the turn, which was still streaming.
		const discarded = await openSession({ agentRegistry: registry });
		discarded.session.update(toolCall, scoutAlphaClosed);
		await spawn("Alpha").started.promise;
		expect(heldIds()).toEqual([]);
		discarded.session.finalize({ toolCall, args: { ...scoutArgs, tasks: [scoutArgs.tasks[1]] } });
		await spawn("Alpha").aborted.promise;
		expect(heldIds()).toEqual([]);
		spawns.clear();

		// Adopted inline runs hold the turn by their pre-claimed ids until they
		// settle: each child's message-only `wait` returns once its hold lands.
		const adopted = await openSession({ agentRegistry: registry });
		adopted.session.update(toolCall, scoutAlphaClosed);
		await spawn("Alpha").started.promise;
		adopted.session.finalize({ toolCall, args: scoutArgs });
		await spawn("Beta").started.promise;
		for (const id of ["Main", "Alpha", "Beta"]) {
			registry.register({
				id,
				displayName: id,
				kind: id === "Main" ? "main" : "sub",
				parentId: id === "Main" ? undefined : "Main",
				session: { isStreaming: true } as never,
				status: "running",
			});
		}
		const childWait = (id: string) =>
			new WaitTool({
				cwd: "/tmp",
				settings: Settings.isolated({ "launch.enabled": false }),
				agentRegistry: registry,
				getAgentId: () => id,
			} as unknown as ToolSession).execute(`${id}-wait`, {});
		const waits = [childWait("Alpha"), childWait("Beta")];
		const executing = adopted.tool.execute(toolCall.id, scoutArgs);
		for (const result of await Promise.all(waits)) {
			expect(result.content[0]).toMatchObject({
				text: expect.stringContaining("`Main` is blocked waiting on your result"),
			});
		}
		expect(heldIds().sort()).toEqual(["Alpha", "Beta"]);
		spawn("Alpha").release.resolve();
		spawn("Beta").release.resolve();
		await executing;
		expect(heldIds()).toEqual([]);
	});

	it("never starts a forking spawn early, so it forks the finished parent turn", async () => {
		// While the call streams, the journal lacks the streaming turn and the
		// produced request is still the previous one; the turn's own request
		// lands only on its terminal event.
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "fork from here", timestamp: 1 });
		let producedRequest = forkRequest("previous-turn");
		const { tool, manager, session } = await openSession({
			sessionManager,
			getForkRequestSnapshot: () => producedRequest,
		});
		const agentSpec = harnessFacadeSpecs("claude-code").find(spec => spec.wireName === "Agent");
		if (!agentSpec) throw new Error("expected the claude-code Agent facade");
		const agent = harnessFacade(tool as unknown as AgentTool, agentSpec, { settings: Settings.isolated() });
		const agentArgs = { description: "Fork", prompt: "Do F.", subagent_type: "fork" };
		const forkArgs = agent.toNativeArgs?.(agentArgs) as Record<string, unknown>;
		expect(forkArgs).toEqual({ task: "Do F.", fork: "all" });

		session.finalize({ toolCall, args: forkArgs });
		producedRequest = forkRequest("finished-turn");
		const result = await agent.execute(toolCall.id, agentArgs);
		const agentId = (result.details as TaskToolDetails | undefined)?.progress?.[0]?.id;
		if (!agentId) throw new Error("expected the forked spawn to be scheduled");
		await spawn(agentId).started.promise;

		const runSubprocess = executorModule.runSubprocess as Mock<typeof executorModule.runSubprocess>;
		expect(runSubprocess).toHaveBeenCalledTimes(1);
		const fork = runSubprocess.mock.calls[0]?.[0].fork;
		expect(fork?.request).toEqual(forkRequest("finished-turn"));
		expect(fork?.messages.map(message => message.role)).toEqual(["user"]);
		spawn(agentId).release.resolve();
		await manager.getJob(agentId)!.promise;
		expect(manager.getJob(agentId)!.status).toBe("completed");
	});
});

describe("claude-code Agent speculative launch", () => {
	const managers: AsyncJobManager[] = [];
	const started: string[] = [];
	const releases: Array<() => void> = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const id = options.id ?? "?";
			started.push(id);
			const release = Promise.withResolvers<void>();
			releases.push(release.resolve);
			options.signal?.addEventListener("abort", () => release.resolve(), { once: true });
			await release.promise;
			return makeResult(id);
		});
	});

	afterEach(async () => {
		for (const release of releases.splice(0)) release();
		started.length = 0;
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("starts each streamed tasks item under the shared prompt and adopts it at dispatch", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await TaskTool.create(createSession(manager));
		const agentSpec = harnessFacadeSpecs("claude-code").find(spec => spec.wireName === "Agent");
		if (!agentSpec) throw new Error("expected the claude-code Agent facade");
		const agent = harnessFacade(tool as unknown as AgentTool, agentSpec, { settings: Settings.isolated() });
		const opened = await agent.speculation?.stream?.open({ coordinator: sink, parentToolCallId: toolCall.id });
		if (!opened) throw new Error("expected an Agent launch session");
		const session = opened as TaskLaunchSession;
		const agentArgs = {
			description: "Audit",
			prompt: "ctx",
			tasks: [
				{ description: "A", prompt: "Do A." },
				{ description: "B", prompt: "Do B." },
			],
		};
		const agentJson = JSON.stringify(agentArgs);
		const agentCall: AgentToolCall = { type: "toolCall", id: toolCall.id, name: "Agent", arguments: {} };

		session.update(agentCall, agentJson.slice(0, agentJson.indexOf('{"description":"B"') + 10));
		for (let attempt = 0; attempt < 500 && started.length === 0; attempt++) await Bun.sleep(2);
		expect(started).toHaveLength(1);

		// The final call is planned through the same projection.
		expect(session.matchesFinalArgs(agentArgs)).toBe(true);
		expect(session.matchesFinalArgs({ ...agentArgs, prompt: "other brief" })).toBe(false);
		session.finalize({ toolCall: agentCall, args: agentArgs });
		const result = await agent.execute(toolCall.id, agentArgs);

		// Two spawns total: the early launch was adopted, not repeated.
		expect(executorModule.runSubprocess).toHaveBeenCalledTimes(2);
		const ids = (result.details as TaskToolDetails | undefined)?.progress?.map(progress => progress.id) ?? [];
		expect(ids).toHaveLength(2);
		expect(ids[0]).toBe(started[0]);
		for (const release of releases.splice(0)) release();
		for (const id of ids) await manager.getJob(id)?.promise;
	});
});

describe("speculative launch authorization", () => {
	it("allows launches only under auto-allow approval without lifecycle handlers", async () => {
		const launch = { tool: { name: "task", approval: "exec" as const }, toolCall, args: { context: "ctx" } };
		const authorize = (approvalMode: string, handlers: boolean) => {
			const settings = Settings.isolated({ "tools.approvalMode": approvalMode });
			const session = {
				cwd: "/tmp",
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings,
			};
			return createSpeculativeToolExecutionConfig(settings, session, {
				hasHandlers: event => handlers && event === "tool_call",
			}).host?.authorizeLaunch?.(launch);
		};

		expect(await authorize("yolo", false)).toMatchObject({ allowed: true });
		expect(await authorize("yolo", true)).toMatchObject({ allowed: false });
		expect(await authorize("always-ask", false)).toMatchObject({ allowed: false });
	});
});
