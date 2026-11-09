import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { MonitorEvent } from "@oh-my-pi/pi-coding-agent/session/monitor-events";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { MonitorTool } from "@oh-my-pi/pi-coding-agent/tools/monitor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-monitor-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	AsyncJobManager.resetForTests();
	await removeWithRetries(root);
});

/**
 * A monitor's own session: a real job manager, its events collected, its stderr in `root`.
 * Monitors run real shell processes, so the scripts below pace themselves with `sleep`;
 * fake timers would freeze the shell executor's own timers too.
 */
function monitorSession(settings = Settings.isolated({})) {
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	const events: MonitorEvent[] = [];
	const firstEvent = Promise.withResolvers<void>();
	let artifacts = 0;
	const session = {
		cwd: root,
		settings,
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getSessionId: () => "s1",
		getSessionFile: () => undefined,
		deliverMonitorEvent: (event: MonitorEvent) => {
			events.push(event);
			firstEvent.resolve();
		},
		allocateOutputArtifact: async () => {
			artifacts++;
			return { id: `a${artifacts}`, path: path.join(root, `stderr-${artifacts}.log`) };
		},
	} as unknown as ToolSession;
	return { tool: new MonitorTool(session), manager, events, firstEvent: firstEvent.promise };
}

async function settled(manager: AsyncJobManager, jobId: string): Promise<string> {
	const job = manager.getJob(jobId);
	if (!job) throw new Error(`no job ${jobId}`);
	await job.promise;
	return job.resultText ?? job.errorText ?? "";
}

describe("monitor", () => {
	it("batches stdout lines into events, keeps stderr out of them, and reports the exit code", async () => {
		const { tool, manager, events } = monitorSession();
		const started = await tool.execute("call-1", {
			description: "build output",
			timeout_ms: 10_000,
			command: "echo one; echo two; sleep 0.6; echo three; echo oops >&2; exit 3",
		});
		const jobId = started.details?.jobId ?? "";
		const notice = await settled(manager, jobId);
		expect(events.map(event => event.text)).toEqual(["one\ntwo", "three"]);
		expect(events.every(event => event.jobId === jobId && event.description === "build output")).toBe(true);
		expect(notice).toContain("exited with code 3 after 2 events");
		expect(notice).toContain("Its stderr is at artifact://a1");
		expect(await Bun.file(path.join(root, "stderr-1.log")).text()).toBe("oops\n");
	});

	it("expires at its deadline with one notice and its event count", async () => {
		const { tool, manager, events } = monitorSession();
		const started = await tool.execute("call-1", {
			description: "quiet log",
			timeout_ms: 1_000,
			command: "while true; do sleep 0.1; done",
		});
		const notice = await settled(manager, started.details?.jobId ?? "");
		expect(events).toEqual([]);
		expect(notice).toContain("expired after 1.0s with 0 events. Re-arm it to keep watching.");
	});

	it("stops its command when cancelled", async () => {
		const { tool, manager, events, firstEvent } = monitorSession();
		const started = await tool.execute("call-1", {
			description: "ticker",
			timeout_ms: 60_000,
			command: "while true; do echo tick; sleep 0.3; done",
		});
		const jobId = started.details?.jobId ?? "";
		await firstEvent;
		manager.cancel(jobId);
		await manager.getJob(jobId)?.promise.catch(() => {});
		expect(events.length).toBeGreaterThan(0);
		expect(manager.getJob(jobId)?.status).toBe("cancelled");
	});

	it("streams WebSocket frames as events, stops a flood, and reports how the socket ended", async () => {
		const frames = ["deploy 0", "deploy 1", "deploy 2"];
		const server = Bun.serve({
			port: 0,
			fetch: (request, srv) => (srv.upgrade(request) ? undefined : new Response("no", { status: 400 })),
			websocket: {
				open(ws) {
					for (const frame of frames) ws.send(frame);
					ws.send(new Uint8Array(5));
					ws.close(4001, "done");
				},
				message() {},
			},
		});
		try {
			const { tool, manager, events } = monitorSession();
			const started = await tool.execute("call-1", {
				description: "deploy events",
				timeout_ms: 10_000,
				ws: { url: `ws://127.0.0.1:${server.port}` },
			});
			const notice = await settled(manager, started.details?.jobId ?? "");
			expect(events.map(event => event.text)).toEqual([...frames, "[binary frame, 5 bytes]"]);
			expect(notice).toContain("the socket closed with code 4001 (done) after 4 events");
		} finally {
			server.stop(true);
		}
	});

	it("stops a monitor that sends more than 30 notifications in a minute", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: (request, srv) => (srv.upgrade(request) ? undefined : new Response("no", { status: 400 })),
			websocket: {
				open(ws) {
					for (let i = 0; i < 40; i++) ws.send(`line ${i}`);
				},
				message() {},
			},
		});
		try {
			const { tool, manager, events } = monitorSession();
			const started = await tool.execute("call-1", {
				description: "firehose",
				timeout_ms: 10_000,
				ws: { url: `ws://127.0.0.1:${server.port}` },
			});
			const notice = await settled(manager, started.details?.jobId ?? "");
			expect(events).toHaveLength(30);
			expect(notice).toContain("stopped: more than 30 notifications in a minute (30 events delivered)");
		} finally {
			server.stop(true);
		}
	});

	it("needs exactly one source", async () => {
		const { tool } = monitorSession();
		await expect(tool.execute("call-1", { description: "x", timeout_ms: 1_000 })).rejects.toThrow(
			"exactly one of `command` or `ws`",
		);
	});

	it("applies the session's bash rules to its command", () => {
		const settings = Settings.isolated({ "bash.patterns": [{ match: "rm *", approval: "deny" }] });
		const { tool } = monitorSession(settings);
		expect(tool.approval({ description: "x", timeout_ms: 1_000, command: "rm -rf build" })).toMatchObject({
			policy: "deny",
		});
		expect(tool.approval({ description: "x", timeout_ms: 1_000, ws: { url: "ws://x" } })).toBe("read");
	});
});

describe("monitor in a session", () => {
	const MOCK_API_SOURCE = "test/monitor-session";

	beforeEach(() => {
		const home = path.join(root, "home");
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(home, ".omp", "agent"));
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		registerMockApi(MOCK_API_SOURCE);
	});

	afterEach(async () => {
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		unregisterCustomApis(MOCK_API_SOURCE);
		__resetDirsFromEnvForTests();
		AgentStorage.close();
		closeModelCache();
	});

	it("ends a blocked wait with the event, which reaches the next request", async () => {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const requests: string[] = [];
		const script = [
			{
				content: [
					{
						type: "toolCall" as const,
						name: "monitor",
						arguments: {
							description: "training run",
							timeout_ms: 30_000,
							command: "sleep 0.5; echo 'loss=nan at step 40'; sleep 30",
						},
					},
				],
			},
			{ content: [{ type: "toolCall" as const, name: "wait", arguments: {} }] },
			{ content: ["Stopping the run: the loss diverged."] },
		];
		const mock = createMockModel({
			handler: context => {
				requests.push(JSON.stringify(context.messages));
				return script[requests.length - 1] ?? { content: ["ok"] };
			},
		});
		const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
		const { session } = await createAgentSession({
			cwd: root,
			authStorage,
			modelRegistry,
			model: mock,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false }),
			sessionManager: SessionManager.inMemory(root),
			disableExtensionDiscovery: true,
			preloadedExtensionPaths: [],
			preloadedCustomToolPaths: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			cacheWarming: false,
			toolNames: ["monitor", "wait"],
			restrictToolNames: true,
		});
		try {
			await session.prompt("watch the training run");
			await session.waitForIdle();
			const transcript = requests[2];
			if (transcript === undefined) throw new Error(`expected a third request, got ${requests.length}`);
			// The wait ended on the event instead of its 25-minute window...
			expect(transcript).toContain("Wait interrupted");
			// ...and the event itself reached the model, framed as a monitor's, not the user's.
			expect(transcript).toContain("loss=nan at step 40");
			expect(transcript).toContain("training run");
			expect(transcript).toContain("not replies from the user");
		} finally {
			await session.dispose();
		}
	}, 20_000);
});
