import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

function screen(term: VirtualTerminal): string {
	return term
		.getViewport()
		.map(row => Bun.stripANSI(row).trimEnd())
		.join("\n");
}

/** Texts of the messages the next request would send, in order. */
function contextTexts(session: AgentSession): string[] {
	return session.agent.state.messages.flatMap((message: AgentMessage) => {
		if (message.role === "user") {
			return typeof message.content === "string"
				? [message.content]
				: message.content.flatMap(block => (block.type === "text" ? [block.text] : []));
		}
		if (message.role === "assistant")
			return message.content.flatMap(block => (block.type === "text" ? [block.text] : []));
		return [];
	});
}

describe("/undo on a real interactive session", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;

	beforeAll(() => {
		initTheme();
	});

	async function start(responses: Array<() => MockResponse | Promise<MockResponse>>): Promise<void> {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-undo-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		const mock = createMockModel({ responses });
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry,
		});
		term = new VirtualTerminal(100, 30);
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
		await mode.init({ suppressWelcomeIntro: true });
		// The app's own input loop: each submission runs as `omp` runs it.
		void (async () => {
			for (;;) await submitInteractiveInput(mode, session, await mode.getUserInput());
		})();
		await term.waitForRender();
	}

	async function submit(text: string, until: () => boolean): Promise<void> {
		mode.editor.setText("");
		term.sendInput(text);
		await term.waitForRender(() => mode.editor.getText() === text);
		term.sendInput("\r");
		await term.waitForRender(until);
	}

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("drops the last turn, keeps it as a branch, and puts its prompt back in the editor", async () => {
		await start([() => ({ content: ["first answer"] }), () => ({ content: ["second answer"] })]);
		await submit("first question", () => screen(term).includes("first answer") && !session.isStreaming);
		await submit("second question", () => screen(term).includes("second answer") && !session.isStreaming);
		const droppedId = session.sessionManager.getLeafId();

		await submit("/undo", () => mode.editor.getText() === "second question");

		expect(contextTexts(session)).toEqual(["first question", "first answer"]);
		expect(mode.editor.getText()).toBe("second question");
		expect(screen(term)).toContain("first answer");
		expect(screen(term)).not.toContain("second answer");
		// The dropped turn stays in the session tree as a branch.
		expect(session.sessionManager.getEntry(droppedId ?? "")).toBeDefined();

		// A second /undo drops the turn before it.
		await submit("/undo", () => mode.editor.getText() === "first question");
		expect(contextTexts(session)).toEqual([]);
		expect(screen(term)).not.toContain("first answer");

		await submit("/undo", () => screen(term).includes("Nothing to undo"));
		expect(screen(term)).toContain("Nothing to undo");
	});

	it("stops a running turn and drops it", async () => {
		const started = Promise.withResolvers<void>();
		await start([
			() => ({ content: ["first answer"] }),
			async () => {
				started.resolve();
				return { content: ["never shown"], delayMs: 60_000 };
			},
		]);
		await submit("first question", () => screen(term).includes("first answer") && !session.isStreaming);
		mode.editor.setText("");
		term.sendInput("long question");
		await term.waitForRender(() => mode.editor.getText() === "long question");
		term.sendInput("\r");
		await started.promise;

		await submit("/undo", () => mode.editor.getText() === "long question" && !session.isStreaming);

		expect(session.isStreaming).toBe(false);
		expect(contextTexts(session)).toEqual(["first question", "first answer"]);
		expect(mode.editor.getText()).toBe("long question");
		expect(screen(term)).not.toContain("never shown");
	});
});
