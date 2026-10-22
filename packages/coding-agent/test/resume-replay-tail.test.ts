import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { RECENT_TRANSCRIPT_LIMIT } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("resuming a long session", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;
	let jobs: AsyncJobManager | undefined;

	beforeAll(() => {
		initTheme();
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		await jobs?.dispose({ timeoutMs: 1000 });
		jobs = undefined;
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** A persisted session `fill` writes, reopened through the startup replay `omp` runs. */
	async function resume(
		fill: (manager: SessionManager, assistant: Assistant) => void,
		options: { settings?: Record<string, unknown>; asyncJobManager?: AsyncJobManager } = {},
	): Promise<void> {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-resume-tail-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		fill(manager, (content, stopReason, overrides) => ({
			role: "assistant",
			content,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: USAGE,
			stopReason,
			timestamp: Date.now(),
			...overrides,
		}));
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: manager.buildSessionContext().messages,
				},
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, ...options.settings }),
			modelRegistry,
			asyncJobManager: options.asyncJobManager,
		});
		term = new VirtualTerminal(120, 40, 200_000);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: term }),
		);
		await mode.init({ suppressWelcomeIntro: true, clearInitialTerminalHistory: true });
		await mode.renderInitialMessages({ preserveExistingChat: true });
	}

	/** Screen plus native scrollback, as plain text. */
	const reachable = (): string =>
		term
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row))
			.join("\n");
	/** Waits until the replay has written its oldest row `first` and its newest row `last`. */
	const replayed = (first: string, last: string): Promise<void> =>
		term.waitForRender(() => {
			const shown = reachable();
			return shown.includes(first) && shown.includes(last);
		});

	it("replays only the recent turns and says how many earlier messages it left out", async () => {
		let messages = 0;
		await resume((manager, assistant) => {
			for (let turn = 0; turn < 400; turn++) {
				manager.appendMessage({ role: "user", content: `question ${turn}`, attribution: "user", timestamp: 1 });
				const id = `call_${turn}`;
				manager.appendMessage(
					assistant([{ type: "toolCall", id, name: "bash", arguments: { command: "ls" } }], "toolUse"),
				);
				manager.appendMessage({
					role: "toolResult",
					toolCallId: id,
					toolName: "bash",
					content: [{ type: "text", text: "output" }],
					isError: false,
					timestamp: 1,
				});
				manager.appendMessage(assistant([{ type: "text", text: `answer ${turn}.` }], "stop"));
				messages += 4;
			}
		});
		await replayed("earlier messages not shown", "answer 399.");
		const shown = reachable();
		// Of 1,600 messages in 4-message turns the tail is the last 600: 150 turns, from a question.
		expect(messages - RECENT_TRANSCRIPT_LIMIT).toBe(1000);
		expect(shown).toContain("answer 399.");
		expect(shown).toContain("question 250");
		expect(shown).not.toContain("answer 249.");
		expect(shown).not.toContain("question 0\n");
		// A rebuild after resume (compaction, a setting change) keeps the same tail.
		mode.rebuildChatFromMessages();
		mode.ui.requestRender(true, { clearScrollback: true });
		await term.waitForRender(
			() => reachable().includes("earlier messages not shown") && reachable().includes("answer 399."),
		);
		expect(reachable()).toContain("question 250");
		expect(reachable()).not.toContain("answer 249.");
	});

	it("bounds a single turn longer than the tail at an assistant message", async () => {
		await resume((manager, assistant) => {
			manager.appendMessage({ role: "user", content: "run the whole migration", attribution: "user", timestamp: 1 });
			for (let step = 0; step < 1000; step++) {
				const id = `call_${step}`;
				manager.appendMessage(
					assistant([{ type: "toolCall", id, name: "bash", arguments: { command: `step ${step}` } }], "toolUse"),
				);
				manager.appendMessage({
					role: "toolResult",
					toolCallId: id,
					toolName: "bash",
					content: [{ type: "text", text: `done ${step}` }],
					isError: false,
					timestamp: 1,
				});
			}
			manager.appendMessage(assistant([{ type: "text", text: "migration finished." }], "stop"));
		});
		await replayed("earlier messages not shown", "migration finished.");
		const shown = reachable();
		// 2,002 messages; the tail starts at the first assistant message in the last 600: step 701.
		expect(shown).toContain('command="step 701"');
		expect(shown).not.toContain('command="step 700"');
		expect(shown).toContain("migration finished.");
		expect(shown).not.toContain("run the whole migration");
		expect(session.isStreaming).toBe(false);
	});

	it("keeps cache-miss explanations on the messages they belong to", async () => {
		await resume(
			(manager, assistant) =>
				// Every answer reads a warm cache except two cold ones inside the tail: turn 390's
				// follows a switch to another model, which explains it; turn 395's has no excuse.
				fillTurns(manager, assistant, 400, turn =>
					turn === 390
						? { usage: COLD, model: "claude-opus-4-5" }
						: turn === 395
							? { usage: COLD }
							: { usage: WARM },
				),
			{ settings: { "display.cacheMissMarker": true } },
		);
		// A cache-miss row renders only in a card's final layout, never in a compact live
		// frame, so waiting for it waits for the whole replay to settle.
		await replayed("cache miss", "answer 399.");
		const rows = reachable().split("\n");
		const misses = rows.filter(row => row.includes("cache miss"));
		expect(misses).toHaveLength(1);
		// The one marker trails the unexplained answer.
		const marker = rows.findIndex(row => row.includes("cache miss"));
		expect(rows.slice(0, marker).findLast(row => /answer \d+\./.test(row))).toContain("answer 395.");
	});

	it("keeps a background job's call in the tail while the job runs", async () => {
		jobs = new AsyncJobManager({});
		const stop = Promise.withResolvers<void>();
		const jobId = jobs.register(
			"bash",
			"bun run build --watch",
			async () => {
				await stop.promise;
				return "stopped";
			},
			{ id: "bg-build" },
		);
		try {
			await resume(
				(manager, assistant) => {
					// Turn 0 started the job; 399 turns followed while it kept running.
					manager.appendMessage({ role: "user", content: "start the watcher", attribution: "user", timestamp: 1 });
					manager.appendMessage(
						assistant(
							[
								{
									type: "toolCall",
									id: "call_watch",
									name: "bash",
									arguments: { command: "bun run build --watch" },
								},
							],
							"toolUse",
						),
					);
					manager.appendMessage({
						role: "toolResult",
						toolCallId: "call_watch",
						toolName: "bash",
						content: [{ type: "text", text: "Backgrounded" }],
						details: { async: { state: "running", jobId, type: "bash" } },
						isError: false,
						timestamp: 1,
					});
					manager.appendMessage(assistant([{ type: "text", text: "watcher started." }], "stop"));
					fillTurns(manager, assistant, 399);
				},
				{ asyncJobManager: jobs },
			);
			await replayed("earlier message not shown", "answer 398.");
			const shown = reachable();
			// The tail reaches back to the call, so its card can still show the job's progress.
			expect(shown).toContain("1 earlier message not shown");
			expect(shown).toContain("bun run build --watch");

			// Once the job finishes, a rebuild goes back to the normal recent tail.
			stop.resolve();
			await jobs.waitForAll();
			mode.rebuildChatFromMessages();
			mode.ui.requestRender(true, { clearScrollback: true });
			await replayed("1,000 earlier messages not shown", "answer 398.");
			expect(reachable()).not.toContain("bun run build --watch");
		} finally {
			stop.resolve();
		}
	});

	it("starts a tail of only tool results at the call that issued them", async () => {
		await resume((manager, assistant) => {
			manager.appendMessage({ role: "user", content: "check every package", attribution: "user", timestamp: 1 });
			const calls = Array.from({ length: 700 }, (_, index) => ({
				type: "toolCall" as const,
				id: `call_${index}`,
				name: "bash",
				arguments: { command: `check ${index}` },
			}));
			manager.appendMessage(assistant(calls, "toolUse"));
			for (const call of calls) {
				manager.appendMessage({
					role: "toolResult",
					toolCallId: call.id,
					toolName: "bash",
					content: [{ type: "text", text: `ok ${call.id}` }],
					isError: false,
					timestamp: 1,
				});
			}
		});
		await replayed("earlier message not shown", 'command="check 699"');
		const shown = reachable();
		// The last 600 messages are all results; the tail starts at their one call.
		expect(shown).toContain("1 earlier message not shown");
		expect(shown).toContain('command="check 0"');
		expect(shown).toContain('command="check 699"');
		expect(shown).not.toContain("check every package");
	});

	it("replays a short session whole, without a marker", async () => {
		await resume((manager, assistant) => {
			for (let turn = 0; turn < 3; turn++) {
				manager.appendMessage({ role: "user", content: `question ${turn}`, attribution: "user", timestamp: 1 });
				manager.appendMessage(assistant([{ type: "text", text: `answer ${turn}.` }], "stop"));
			}
		});
		await replayed("question 0", "answer 2.");
		const shown = reachable();
		expect(shown).toContain("answer 2.");
		expect(shown).not.toContain("earlier messages not shown");
	});
});

type Assistant = (
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	overrides?: Partial<AssistantMessage>,
) => AssistantMessage;

const WARM = { ...USAGE, input: 100, cacheRead: 50_000 };
const COLD = { ...USAGE, input: 100, cacheWrite: 60_000 };

/** `turns` four-message turns: a question, a bash call, its result, an answer. */
function fillTurns(
	manager: SessionManager,
	assistant: Assistant,
	turns: number,
	answer: (turn: number) => Partial<AssistantMessage> = () => ({}),
): void {
	for (let turn = 0; turn < turns; turn++) {
		manager.appendMessage({ role: "user", content: `question ${turn}`, attribution: "user", timestamp: 1 });
		const id = `call_${turn}`;
		manager.appendMessage(
			assistant([{ type: "toolCall", id, name: "bash", arguments: { command: "ls" } }], "toolUse"),
		);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: "output" }],
			isError: false,
			timestamp: 1,
		});
		manager.appendMessage(assistant([{ type: "text", text: `answer ${turn}.` }], "stop", answer(turn)));
	}
}
