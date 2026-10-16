/**
 * Turns no task executor drives (IRC wakes on an idle session, user prompts on a
 * kept-alive subagent) run under the installed turn observer. Each turn gets one
 * monitor, finished exactly once when the turn ends, with the turn's own result.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { TempDir } from "@oh-my-pi/pi-utils";

/** The text of the newest assistant turn in `messages`. */
function lastReply(messages: readonly AgentMessage[]): string | undefined {
	const reply = messages.findLast(message => message.role === "assistant");
	if (reply?.role !== "assistant") return undefined;
	return reply.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
}

describe("AgentSession turn observation", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-turn-observation-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	it("finishes one monitor per turn across sequential wakes and prompts, each with its own result", async () => {
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [
				{ content: ["first wake reply"] },
				{ content: ["prompt reply"] },
				{ content: ["second wake reply"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		const current = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map(),
			agentId: "SubAgent",
		});
		session = current;

		const events: string[] = [];
		const delivered: Array<{ turn: number; reply: string | undefined; error: unknown }> = [];
		let open = 0;
		let mostOpen = 0;
		let started = 0;
		const finished: Array<PromiseWithResolvers<void>> = [];
		current.setIrcWakeTurnObserver(() => {
			const turn = ++started;
			open++;
			mostOpen = Math.max(mostOpen, open);
			events.push(`start ${turn}`);
			const done = Promise.withResolvers<void>();
			finished.push(done);
			return async error => {
				open--;
				events.push(`finish ${turn}`);
				delivered.push({ turn, reply: lastReply(current.messages), error });
				done.resolve();
			};
		});
		const wake = (id: string) =>
			current.deliverIrcMessage({
				id,
				from: "peer",
				to: "SubAgent",
				body: `wake ${id}`,
				ts: Date.now(),
			} as IrcMessage);

		await wake("m1");
		await finished[0]?.promise;
		await current.waitForIdle();
		await current.prompt("typed by the user", { attribution: "user" });
		await finished[1]?.promise;
		await wake("m2");
		await finished[2]?.promise;
		await current.waitForIdle();

		expect(mock.calls).toHaveLength(3);
		expect(events).toEqual(["start 1", "finish 1", "start 2", "finish 2", "start 3", "finish 3"]);
		expect(mostOpen).toBe(1);
		expect(delivered).toEqual([
			{ turn: 1, reply: "first wake reply", error: undefined },
			{ turn: 2, reply: "prompt reply", error: undefined },
			{ turn: 3, reply: "second wake reply", error: undefined },
		]);
	});

	it("starts no second monitor for a prompt queued behind a running wake turn", async () => {
		const wakeStarted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [
				async () => {
					wakeStarted.resolve();
					await release.promise;
					return { content: ["wake reply"] };
				},
				{ content: ["follow-up reply"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		const current = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map(),
			agentId: "SubAgent",
		});
		session = current;

		let starts = 0;
		const finishes: unknown[] = [];
		const finished = Promise.withResolvers<void>();
		current.setIrcWakeTurnObserver(() => {
			starts++;
			return async error => {
				finishes.push(error);
				finished.resolve();
			};
		});

		await current.deliverIrcMessage({
			id: "m1",
			from: "peer",
			to: "SubAgent",
			body: "status?",
			ts: Date.now(),
		} as IrcMessage);
		await wakeStarted.promise;
		await current.prompt("typed while the wake runs", { attribution: "user", streamingBehavior: "followUp" });
		release.resolve();
		await finished.promise;
		await current.waitForIdle();

		expect(starts).toBe(1);
		expect(finishes).toEqual([undefined]);
		expect(mock.calls.length).toBeGreaterThanOrEqual(2);
	});
});
