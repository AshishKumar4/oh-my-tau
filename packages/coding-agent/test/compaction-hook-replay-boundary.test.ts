import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, ImageContent, Message, UserMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { customMessageEntryMessage } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { TempDir } from "@oh-my-pi/pi-utils";

// A hook-supplied native compaction that covers only the history before the
// kept tail must persist its replay boundary, or the rebuilt context drops the
// tail instead of replaying it after the native history.
describe("hook-provided compaction replay boundary", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage?.close();
	});

	it("persists and returns the boundary a session_before_compact hook reports", async () => {
		const sessionManager = SessionManager.inMemory();
		const assistant = (text: string, timestamp: number) => ({
			role: "assistant" as const,
			content: [{ type: "text" as const, text }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 1000,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp,
		});
		sessionManager.appendMessage({ role: "user", content: "first request", timestamp: 1 });
		sessionManager.appendMessage(assistant("first answer", 2));
		sessionManager.appendMessage({ role: "user", content: "second request", timestamp: 3 });
		sessionManager.appendMessage(assistant("second answer", 4));

		let boundary: string | undefined;
		const extensionRunner = {
			hasHandlers: (type: string) => type === "session_before_compact",
			emit: async (event: { type: string; preparation?: CompactionPreparation }) => {
				if (event.type !== "session_before_compact" || !event.preparation) return undefined;
				boundary = event.preparation.lastSummarizedEntryId;
				return {
					compaction: {
						summary: "compacted",
						shortSummary: undefined,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						preserveData: {
							openaiRemoteCompaction: {
								provider: "openai",
								replacementHistory: [{ type: "compaction", encrypted_content: "enc" }],
							},
						},
						providerReplayThroughEntryId: boundary,
					},
				};
			},
			emitBeforeAgentStart: async () => undefined,
		};
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model: bundled, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.keepRecentTokens": 1 }),
			modelRegistry,
			extensionRunner: extensionRunner as never,
		});

		const result = await session.compact();

		expect(boundary).toBeDefined();
		expect(result?.providerReplayThroughEntryId).toBe(boundary);
		const entry = sessionManager
			.getBranch()
			.findLast((candidate): candidate is CompactionEntry => candidate.type === "compaction");
		expect(entry?.providerReplayThroughEntryId).toBe(boundary);
	});
});

// A usage anchor after a compaction paid only for the history the compaction
// kept: a remote compaction that covered the history before the kept tail
// replays the tail after its native history, and a local one replays from its
// first kept entry. Rewriting a kept entry must lower the anchor; rewriting
// history the compaction replaced must not.
describe("usage anchor correction below a compaction", () => {
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected built-in anthropic model to exist");
	const model = bundled;
	const usage = {
		input: 16,
		output: 8,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 24,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const png: ImageContent = { type: "image", data: "iVBORw0KGgo", mimeType: "image/png" };
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-replay-through-anchor-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(async () => {
		authStorage?.close();
		await tempDir.remove();
	});

	const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) => ({
		role: "assistant" as const,
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason,
		usage,
		timestamp: Date.now(),
	});

	/**
	 * `early` and `late` are each one turn: `early` is what the compaction
	 * replaced (ending at a remote compaction's replay-through boundary), `late`
	 * opens the kept tail. The compaction entry follows, then a usage anchor
	 * reporting a 20,000-token prompt.
	 */
	function openSession(
		early: Message[],
		late: Message[],
		compaction: "remote" | "local" = "remote",
	): { session: AgentSession; manager: SessionManager } {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		let replayThrough = "";
		for (const message of early) replayThrough = manager.appendMessage(message);
		let firstKept = "";
		for (const message of late) {
			const id = manager.appendMessage(message);
			firstKept ||= id;
		}
		manager.appendCompaction(
			`${compaction} summary`,
			undefined,
			firstKept,
			30_000,
			compaction === "local"
				? {}
				: {
						preserveData: {
							openaiRemoteCompaction: {
								provider: "openai",
								replacementHistory: [{ type: "compaction", encrypted_content: "enc" }],
							},
						},
						providerReplayThroughEntryId: replayThrough,
					},
		);
		manager.appendMessage({
			...assistant([{ type: "text", text: `latest answer\n${"tail ".repeat(4_000)}` }], "stop"),
			usage: { ...usage, input: 20_000, totalTokens: 20_008 },
		});
		const current = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		current.agent.replaceMessages(current.buildDisplaySessionContext().messages);
		session = current;
		return { session: current, manager };
	}

	/** The correction recorded on the usage anchor. */
	function anchorCorrection(manager: SessionManager): number | undefined {
		const anchor = manager
			.getBranch()
			.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
		return anchor?.type === "message" && anchor.message.role === "assistant"
			? anchor.message.contextSnapshot?.historyRewriteTokensRemoved
			: undefined;
	}

	it("lowers the anchor by a dropped image in the kept tail, and not by one the native history replaced", async () => {
		const withImage = (text: string): UserMessage & { content: [{ type: "text"; text: string }, ImageContent] } => ({
			role: "user",
			content: [{ type: "text", text }, png],
			timestamp: Date.now(),
		});
		const early = withImage("early screenshot");
		const late = withImage("kept screenshot");
		const { session, manager } = openSession(
			[early, assistant([{ type: "text", text: "seen" }], "stop")],
			[late, assistant([{ type: "text", text: "seen too" }], "stop")],
		);
		expect(session.getContextUsage()?.tokens).toBe(20_000);
		const tokenizer = session.agent.tokenizer;
		const imageTokens = (message: ReturnType<typeof withImage>) =>
			tokenizer.countMessage(message) - tokenizer.countMessage({ ...message, content: [message.content[0]] });
		const earlyTokens = imageTokens(early);
		const lateTokens = imageTokens(late);
		expect(lateTokens).toBeGreaterThan(0);

		const result = await session.shake("images");

		expect(result.imagesDropped).toBe(2);
		expect(result.tokensFreed).toBe(earlyTokens + lateTokens);
		expect(anchorCorrection(manager)).toBe(lateTokens);
		expect(session.getContextUsage()?.tokens).toBe(20_000 - lateTokens);
	});

	it("leaves the anchor alone when only history the native payload replaced loses an image", async () => {
		const { session, manager } = openSession(
			[
				{ role: "user", content: [{ type: "text", text: "early screenshot" }, png], timestamp: Date.now() },
				assistant([{ type: "text", text: "seen" }], "stop"),
			],
			[
				{ role: "user", content: "kept request", timestamp: Date.now() },
				assistant([{ type: "text", text: "ok" }], "stop"),
			],
		);

		const result = await session.shake("images");

		expect(result.tokensFreed).toBeGreaterThan(0);
		expect(anchorCorrection(manager)).toBeUndefined();
		expect(session.getContextUsage()?.tokens).toBe(20_000);
	});

	it("lowers the anchor by a tool result elided from the kept tail", async () => {
		const toolTurn = (id: string, text: string): Message[] => [
			{ role: "user", content: "do it", timestamp: Date.now() },
			assistant([{ type: "toolCall", id, name: "bash", arguments: { command: "ls" } }], "toolUse"),
			{
				role: "toolResult",
				toolCallId: id,
				toolName: "bash",
				content: [{ type: "text", text }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		const { session, manager } = openSession(
			toolTurn("call_early", "E".repeat(20_000)),
			toolTurn("call_kept", "K".repeat(20_000)),
		);

		const result = await session.shake("elide");

		// Only the kept tail is shaken: the native history replaced the earlier turn.
		expect(result.toolResultsDropped).toBe(1);
		expect(result.tokensFreed).toBeGreaterThan(0);
		expect(anchorCorrection(manager)).toBe(result.tokensFreed);
		expect(session.getContextUsage()?.tokens).toBe(20_000 - result.tokensFreed);
	});

	it("lowers the anchor by a dropped image a local compaction kept, and not by one it summarized away", async () => {
		const withImage = (text: string): UserMessage & { content: [{ type: "text"; text: string }, ImageContent] } => ({
			role: "user",
			content: [{ type: "text", text }, png],
			timestamp: Date.now(),
		});
		const early = withImage("summarized screenshot");
		const late = withImage("kept screenshot");
		const { session, manager } = openSession(
			[early, assistant([{ type: "text", text: "seen" }], "stop")],
			[late, assistant([{ type: "text", text: "seen too" }], "stop")],
			"local",
		);
		expect(session.getContextUsage()?.tokens).toBe(20_000);
		const tokenizer = session.agent.tokenizer;
		const imageTokens = (message: typeof early) =>
			tokenizer.countMessage(message) - tokenizer.countMessage({ ...message, content: [message.content[0]] });
		// Measured first: the shake rewrites the stored messages in place.
		const earlyTokens = imageTokens(early);
		const lateTokens = imageTokens(late);
		expect(lateTokens).toBeGreaterThan(0);

		const result = await session.shake("images");

		expect(result.imagesDropped).toBe(2);
		expect(result.tokensFreed).toBe(earlyTokens + lateTokens);
		expect(anchorCorrection(manager)).toBe(lateTokens);
		expect(session.getContextUsage()?.tokens).toBe(20_000 - lateTokens);
	});

	it("lowers the anchor by thinking dropped from a turn a local compaction kept, and not from one it summarized away", async () => {
		const thinkingTurn = (label: string) =>
			assistant(
				[
					{ type: "thinking", thinking: `${label} reasoning ${"step ".repeat(400)}` },
					{ type: "text", text: `${label} answer` },
				],
				"stop",
			);
		const early = thinkingTurn("summarized");
		const late = thinkingTurn("kept");
		const { session, manager } = openSession(
			[{ role: "user", content: "early request", timestamp: Date.now() }, early],
			[{ role: "user", content: "kept request", timestamp: Date.now() }, late],
			"local",
		);
		const tokenizer = session.agent.tokenizer;
		const floor = { excludeEncryptedReasoning: true } as const;
		const thinkingTokens = (turn: typeof early) =>
			tokenizer.countMessage(turn, floor) -
			tokenizer.countMessage({ ...turn, content: turn.content.filter(block => block.type !== "thinking") }, floor);
		// Measured first: the shake rewrites the stored messages in place.
		const earlyTokens = thinkingTokens(early);
		const lateTokens = thinkingTokens(late);
		expect(lateTokens).toBeGreaterThan(0);

		const result = await session.shake("thinking");

		expect(result.thinkingBlocksDropped).toBe(2);
		expect(result.tokensFreed).toBe(earlyTokens + lateTokens);
		expect(anchorCorrection(manager)).toBe(lateTokens);
		expect(session.getContextUsage()?.tokens).toBe(20_000 - lateTokens);
	});

	/** Image tokens of `message`: its count with and without its image blocks. */
	function imageTokens(session: AgentSession, message: AgentMessage): number {
		if (!("content" in message) || !Array.isArray(message.content)) return 0;
		const tokenizer = session.agent.tokenizer;
		const floor = { excludeEncryptedReasoning: true } as const;
		const text = message.content.filter(block => block.type !== "image");
		return (
			tokenizer.countMessage(message, floor) -
			tokenizer.countMessage({ ...message, content: text } as AgentMessage, floor)
		);
	}

	/**
	 * An experimental context rollover: request R, an obsolete tool turn whose
	 * result carries an image, then the kept tail T (a continuation with no
	 * request of its own). The rollover's prompt restores R ahead of T and drops
	 * the obsolete turn; a usage anchor reports 20,000 after it.
	 */
	function openRollover(request: "user" | "custom") {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const requestId =
			request === "user"
				? manager.appendMessage({
						role: "user",
						content: [{ type: "text", text: "REQUEST with a screenshot" }, png],
						timestamp: Date.now(),
					})
				: manager.appendCustomMessageEntry(
						"irc:incoming",
						[{ type: "text", text: "REQUEST from the parent with a screenshot" }, png],
						false,
						{ fromParent: true },
						"user",
					);
		manager.appendMessage(
			assistant(
				[{ type: "toolCall", id: "call_obsolete", name: "bash", arguments: { command: "shot" } }],
				"toolUse",
			),
		);
		const obsoleteId = manager.appendMessage({
			role: "toolResult",
			toolCallId: "call_obsolete",
			toolName: "bash",
			content: [
				{ type: "text", text: "OBSOLETE capture" },
				{ ...png, data: `${png.data}AAAA` },
			],
			isError: false,
			timestamp: Date.now(),
		});
		const tailId = manager.appendMessage(assistant([{ type: "text", text: "TAIL continuing the request" }], "stop"));
		manager.appendCompaction("rollover notes", undefined, tailId, 30_000, {
			details: { kind: "experimental-context-rollover" },
		});
		manager.appendMessage({
			...assistant([{ type: "text", text: `latest answer\n${"tail ".repeat(4_000)}` }], "stop"),
			usage: { ...usage, input: 20_000, totalTokens: 20_008 },
		});
		const current = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		current.agent.replaceMessages(current.buildDisplaySessionContext().messages);
		session = current;
		const entry = (id: string) => {
			const found = manager.getEntry(id);
			if (!found) throw new Error(`Missing entry ${id}`);
			return found;
		};
		const messageOf = (id: string): AgentMessage => {
			const found = entry(id);
			if (found.type === "message") return found.message;
			if (found.type === "custom_message") {
				const message = customMessageEntryMessage(found);
				if (message) return message;
			}
			throw new Error(`Entry ${id} carries no message`);
		};
		return { session: current, manager, request: () => messageOf(requestId), obsolete: () => messageOf(obsoleteId) };
	}

	for (const request of ["user", "custom"] as const) {
		it(`lowers the anchor by an image in the request a rollover restores (${request} request), and not by the obsolete turn's`, async () => {
			const opened = openRollover(request);
			const { session, manager } = opened;
			const sent = JSON.stringify(session.buildDisplaySessionContext().messages);
			expect(sent).toContain("REQUEST");
			expect(sent).toContain("TAIL continuing");
			expect(sent).not.toContain("OBSOLETE");
			expect(session.getContextUsage()?.tokens).toBe(20_000);
			// Measured first: the shake rewrites the stored messages in place.
			const requestTokens = imageTokens(session, opened.request());
			const obsoleteTokens = imageTokens(session, opened.obsolete());
			expect(requestTokens).toBeGreaterThan(0);
			expect(obsoleteTokens).toBeGreaterThan(0);

			const result = await session.shake("images");

			expect(result.imagesDropped).toBe(2);
			expect(result.tokensFreed).toBe(requestTokens + obsoleteTokens);
			const restored = session.buildDisplaySessionContext().messages;
			expect(JSON.stringify(restored)).toContain("REQUEST");
			expect(JSON.stringify(restored)).not.toContain('"type":"image"');
			expect(anchorCorrection(manager)).toBe(requestTokens);
			expect(session.getContextUsage()?.tokens).toBe(20_000 - requestTokens);
		});
	}

	it("leaves the anchor alone when only history before a /clear boundary loses an image", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "cleared screenshot" }, png],
			timestamp: Date.now(),
		});
		manager.appendMessage(assistant([{ type: "text", text: "seen" }], "stop"));
		manager.appendResetBoundary();
		manager.appendMessage({ role: "user", content: "fresh request", timestamp: Date.now() });
		manager.appendMessage({
			...assistant([{ type: "text", text: `fresh answer\n${"tail ".repeat(4_000)}` }], "stop"),
			usage: { ...usage, input: 20_000, totalTokens: 20_008 },
		});
		const current = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		current.agent.replaceMessages(current.buildDisplaySessionContext().messages);
		session = current;
		expect(current.getContextUsage()?.tokens).toBe(20_000);

		const result = await current.shake("images");

		expect(result.tokensFreed).toBeGreaterThan(0);
		expect(anchorCorrection(manager)).toBeUndefined();
		expect(current.getContextUsage()?.tokens).toBe(20_000);
	});
});
