import { afterEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	ModelSpec,
	ToolCall,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { DateCwdReminderInjector, renderDateCwdReminder } from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { formatLocalCalendarDate } from "@oh-my-pi/pi-tui/chrome/local-date";
import { normalizePromptPath } from "@oh-my-pi/pi-coding-agent/utils/prompt-path";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("date-cwd-reminder", () => {
	afterEach(() => {
		clearCustomApis();
	});

	describe("DateCwdReminderInjector", () => {
		it("preserves retained turns and reminder controls after compaction changes the root", () => {
			const injector = new DateCwdReminderInjector();
			const first: Message = { role: "user", content: "first", timestamp: 1 };
			const retained: Message = { role: "user", content: "retained", timestamp: 2 };
			const toolTurn = createAssistantMessage("continuing a tool turn");
			const original = injector.transform(
				{ systemPrompt: ["system"], messages: [first, retained, toolTurn] },
				"2026-08-14",
				"/old",
			);
			const live = injector.transform(
				{ systemPrompt: ["system"], messages: [first, retained, toolTurn] },
				"2026-08-15",
				"/new",
			);
			const control = live.messages.at(-1);
			if (!control || control.role !== "developer") throw new Error("Expected an appended reminder control");
			expect(live.messages.slice(0, original.messages.length)).toEqual(original.messages);
			const summary: Message = { role: "user", content: "compaction summary", timestamp: 3 };
			const compacted = injector.transform(
				{ systemPrompt: ["system"], messages: [summary, retained, toolTurn] },
				"2026-08-15",
				"/new",
			);
			expect(compacted.messages.slice(1)).toEqual([...original.messages.slice(1), control]);
			expect(compacted.messages[0]?.content).toBe(
				`${renderDateCwdReminder("2026-08-15", "/new")}\n\ncompaction summary`,
			);
		});
		it("sends a turn's current content with the reminder it carries after an owner rewrites it in place", () => {
			const injector = new DateCwdReminderInjector();
			const first: UserMessage = { role: "user", content: "first", timestamp: 1 };
			const transform = () =>
				injector.transform({ systemPrompt: ["system"], messages: [first] }, "2026-08-14", "/work").messages[0];
			const reminder = renderDateCwdReminder("2026-08-14", "/work");
			expect(transform()).toEqual({ ...first, content: `${reminder}\n\nfirst` });

			first.content = "[shaken]";
			const rewritten = transform();

			expect(rewritten).toEqual({ ...first, content: `${reminder}\n\n[shaken]` });
			expect(transform()).toBe(rewritten);
		});

		it("keeps a changed reminder on the history, not on a context hook's per-call note", () => {
			const injector = new DateCwdReminderInjector();
			const first: Message = { role: "user", content: "first", timestamp: 1 };
			const toolTurn = createAssistantMessage("continuing a tool turn");
			const note = (): Message => {
				const message: Message = { role: "user", content: "per-call note", timestamp: 0 };
				markPerCallContextMessage(message, "added");
				return message;
			};
			const transform = (date: string) =>
				injector.transform({ systemPrompt: ["system"], messages: [first, toolTurn, note()] }, date, "/work")
					.messages;
			const sent = transform("2026-08-14");

			const changed = transform("2026-08-15");
			const next = transform("2026-08-15");

			// Mid tool loop there is no new user turn: a control follows the last history message.
			expect(changed.slice(0, 2)).toEqual(sent.slice(0, 2));
			expect(changed[2]).toMatchObject({ role: "developer", content: renderDateCwdReminder("2026-08-15", "/work") });
			expect(changed.at(-1)?.content).toBe("per-call note");
			expect(next.slice(0, 3)).toEqual(changed.slice(0, 3));
		});

		it("injects the first reminder without mutating the context", () => {
			const systemPrompt = ["PROJECT\n<critical>\n- Must act.\n</critical>"];
			const messages: Message[] = [{ role: "user", content: "hello", timestamp: 1 }, createAssistantMessage("hi")];
			const context: Context = { systemPrompt, messages };
			const injector = new DateCwdReminderInjector();

			const out = injector.transform(context, "2026-08-14", "/work/omp");

			expect(out).not.toBe(context);
			expect(out.systemPrompt).toBe(systemPrompt);
			expect(out.messages).not.toBe(messages);
			expect(out.messages[0]).toEqual({
				role: "user",
				content: `${renderDateCwdReminder("2026-08-14", "/work/omp")}\n\nhello`,
				timestamp: 1,
			});
			expect(out.messages[1]).toBe(messages[1]);
			expect(context.messages).toBe(messages);
		});

		it("prepends a text part before image parts", () => {
			const context: Context = {
				systemPrompt: ["system"],
				messages: [
					{
						role: "user",
						content: [{ type: "image", data: "img", mimeType: "image/png" }],
						timestamp: 1,
					},
				],
			};

			const out = new DateCwdReminderInjector().transform(context, "2026-08-14", "/work/omp");

			expect(out.messages[0]?.content).toEqual([
				{ type: "text", text: renderDateCwdReminder("2026-08-14", "/work/omp") },
				{ type: "image", data: "img", mimeType: "image/png" },
			]);
		});

		it("leaves contexts without a system prompt or user message untouched", () => {
			const injector = new DateCwdReminderInjector();
			const noSystem: Context = {
				systemPrompt: [],
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			};
			const noUser: Context = { systemPrompt: ["system"], messages: [createAssistantMessage("hi")] };

			expect(injector.transform(noSystem, "2026-08-14", "/cwd")).toBe(noSystem);
			expect(injector.transform(noUser, "2026-08-14", "/cwd")).toBe(noUser);
		});

		it("keeps prior reminder bytes and moves a changed reminder to the next user turn", () => {
			const injector = new DateCwdReminderInjector();
			const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
			const firstContext: Context = { systemPrompt: ["system"], messages: [firstUser] };

			const first = injector.transform(firstContext, "2026-08-14", "/old");
			const firstInjected = first.messages[0]!;
			const secondUser: Message = { role: "user", content: "second", timestamp: 2 };
			const second = injector.transform(
				{
					systemPrompt: firstContext.systemPrompt,
					messages: [firstUser, createAssistantMessage("done"), secondUser],
				},
				"2026-08-15",
				"/new",
			);

			expect(second.messages[0]).toBe(firstInjected);
			expect(second.messages[0]?.content).toBe(firstInjected.content);
			expect(second.messages[2]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/new")}\n\nsecond`);
			expect(firstUser.content).toBe("first");
			expect(secondUser.content).toBe("second");
		});

		it("reuses injected message objects on provider request replay", () => {
			const injector = new DateCwdReminderInjector();
			const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
			const context: Context = { systemPrompt: ["system"], messages: [firstUser] };

			const first = injector.transform(context, "2026-08-14", "/work/omp");
			const replay = injector.transform({ ...context, messages: [...context.messages] }, "2026-08-14", "/work/omp");

			expect(replay.messages[0]).toBe(first.messages[0]);
		});

		it("keeps the reminders of turns a compaction retains when the first user turn changes", () => {
			const injector = new DateCwdReminderInjector();
			const first: Message = { role: "user", content: "first", timestamp: 1 };
			const kept: Message = { role: "user", content: "kept", timestamp: 2 };
			const toolTurn = createAssistantMessage("calling a tool");
			// The cwd moves mid tool loop: the continuation carries the reminder as a control.
			injector.transform({ systemPrompt: ["system"], messages: [first] }, "2026-08-14", "/old");
			injector.transform(
				{ systemPrompt: ["system"], messages: [first, createAssistantMessage("a"), kept, toolTurn] },
				"2026-08-14",
				"/old",
			);
			const live = injector.transform(
				{ systemPrompt: ["system"], messages: [first, createAssistantMessage("a"), kept, toolTurn] },
				"2026-08-14",
				"/new",
			);
			const control = live.messages.at(-1)!;
			expect(control.role).toBe("developer");

			// A compaction replaces everything before `kept` with a new summary turn.
			const summary: Message = { role: "user", content: "summary", timestamp: 3 };
			const after = injector.transform(
				{ systemPrompt: ["system"], messages: [summary, kept, toolTurn] },
				"2026-08-14",
				"/new",
			);

			// The retained tail is sent exactly as before; only the new summary gets the current reminder.
			expect(after.messages.slice(1)).toEqual([kept, toolTurn, control]);
			expect(after.messages[0]?.content).toBe(`${renderDateCwdReminder("2026-08-14", "/new")}\n\nsummary`);
		});
	});
});

/** A decodable one-pixel PNG. */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("date-cwd reminder on the provider wire", () => {
	const sessions: Array<{ dispose(): Promise<void> }> = [];

	afterEach(async () => {
		clearCustomApis();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("keeps the date/cwd out of the system prompt and pins the reminder to the first user turn across requests", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reminder-");
		const api = "test-date-cwd-reminder";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "date-cwd-reminder",
			name: "Date cwd reminder",
			api,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
		});
		sessions.push(session);

		try {
			await session.sendUserMessage("first");

			expect(contexts).toHaveLength(1);
			// The volatile line must no longer live in the system prompt: open-weight
			// chat templates render tool schemas after the system content, so any
			// per-request byte there invalidates the whole tool-schema cache (#7404).
			const systemPrompt = contexts[0]!.systemPrompt?.join("\n") ?? "";
			expect(systemPrompt).not.toContain("Today");
			expect(systemPrompt).not.toContain("current working directory");
			expect(systemPrompt).not.toContain(formatLocalCalendarDate());

			const firstUser = contexts[0]!.messages[0]!;
			expect(firstUser.role).toBe("user");
			const firstText =
				typeof firstUser.content === "string" ? firstUser.content : JSON.stringify(firstUser.content);
			expect(firstText).toContain("<system-reminder>");
			expect(firstText).toContain(formatLocalCalendarDate());
			expect(firstText).toContain(normalizePromptPath(tempDir.path()));

			// A second request must re-emit byte-identical reminder bytes so the
			// conversation prefix (system + tools + first turn) stays cached.
			await session.sendUserMessage("second");
			expect(contexts).toHaveLength(2);
			const secondFirst = contexts[1]!.messages[0]!;
			expect(secondFirst.role).toBe("user");
			expect(typeof secondFirst.content).toBe(typeof firstUser.content);
			expect(secondFirst.content).toEqual(firstUser.content);
		} finally {
			authStorage.close();
		}
	});

	/** Eight screenshots: over an unlisted provider's five-image floor. */
	const screenshots = () =>
		Array.from({ length: 8 }, (): ImageContent => ({ type: "image", data: PNG_1X1, mimeType: "image/png" }));

	/** A real session over `seed`'s history whose provider requests reach `contexts`; its provider gets the five-image floor. */
	async function openImageCapSession(tempDir: TempDir, seed: (sessionManager: SessionManager) => void) {
		const api = "test-date-cwd-image-cap";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") }));
			return stream;
		});
		const model = buildModel({
			id: "date-cwd-image-cap",
			name: "Date cwd image cap",
			api,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 1024,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		seed(sessionManager);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);
		return { session, sessionManager, contexts, close: () => authStorage.close() };
	}

	const imageCount = (context: Context | undefined) =>
		context?.messages.flatMap(message =>
			Array.isArray(message.content) ? message.content.filter(part => part.type === "image") : [],
		).length;

	it("keeps the first turn's reminder across a cwd move while the image cap drops the same images", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-image-cap-");
		const opened = await openImageCapSession(tempDir, sessionManager => {
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "compare these screenshots" }, ...screenshots()],
				timestamp: 1,
			});
			sessionManager.appendMessage({ ...createAssistantMessage("compared"), timestamp: 2 });
		});
		const movedCwd = vi.spyOn(opened.sessionManager, "getCwd");
		try {
			await opened.session.prompt("first");
			movedCwd.mockReturnValue(tempDir.join("moved"));
			await opened.session.prompt("second");
		} finally {
			movedCwd.mockRestore();
			opened.close();
		}

		expect(opened.contexts).toHaveLength(2);
		const [first, second] = opened.contexts;
		// Both requests are over the cap and drop the same oldest images.
		expect(imageCount(first)).toBe(5);
		expect(imageCount(second)).toBe(5);
		expect(second?.messages.slice(0, first?.messages.length)).toEqual(first?.messages);
		expect(JSON.stringify(second?.messages.at(-1))).toContain(tempDir.join("moved"));
	});

	it("sends a tool result's shaken content while the image cap drops the same images", async () => {
		using tempDir = TempDir.createSync("@pi-image-cap-shake-");
		const opened = await openImageCapSession(tempDir, sessionManager => {
			sessionManager.appendMessage({ role: "user", content: "inspect the screenshots", timestamp: 1 });
			sessionManager.appendMessage({
				...createAssistantMessage("capturing"),
				content: [{ type: "toolCall", id: "call_shots", name: "bash", arguments: { command: "shoot" } }],
				stopReason: "toolUse",
				timestamp: 2,
			});
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "call_shots",
				toolName: "bash",
				content: [{ type: "text", text: "CAPTURE-LOG ".repeat(800) }, ...screenshots()],
				isError: false,
				timestamp: 3,
			});
			// Recent context shake keeps: the tool result sits before it.
			sessionManager.appendMessage({
				role: "user",
				content: `newer context ${"tail ".repeat(4_000)}`,
				timestamp: 4,
			});
			sessionManager.appendMessage({ ...createAssistantMessage("noted"), timestamp: 5 });
		});
		try {
			await opened.session.prompt("first");
			const shaken = await opened.session.shake("elide");
			expect(shaken.toolResultsDropped).toBe(1);
			await opened.session.prompt("second");
		} finally {
			opened.close();
		}

		expect(opened.contexts).toHaveLength(2);
		const [first, second] = opened.contexts;
		const toolResult = (context: Context | undefined) =>
			JSON.stringify(context?.messages.find(message => message.role === "toolResult"));
		// Both requests drop the same three screenshots; the second carries what shake left.
		expect(imageCount(first)).toBe(5);
		expect(imageCount(second)).toBe(5);
		expect(toolResult(first)).toContain("CAPTURE-LOG");
		expect(toolResult(second)).not.toContain("CAPTURE-LOG");
	});

	it("keeps sent steering turns stable across midnight during a real tool continuation", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-steer-");
		await Bun.write(tempDir.join("notes.txt"), "notes");
		const api = "test-date-cwd-steer";
		const contexts: Context[] = [];
		const pushRead = (stream: AssistantMessageEventStream, id: string) => {
			const toolCall: ToolCall = { type: "toolCall", id, name: "read", arguments: { path: "notes.txt" } };
			const message: AssistantMessage = {
				...createAssistantMessage(""),
				content: [toolCall],
				stopReason: "toolUse",
			};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
			stream.push({ type: "done", reason: "toolUse", message });
		};
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			const request = contexts.length;
			queueMicrotask(() => {
				if (request === 1) {
					void session.steer("steered");
					pushRead(stream, "read-first");
				} else if (request === 2) {
					setSystemTime(new Date(2026, 7, 15, 0, 1));
					pushRead(stream, "read-next");
				} else {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
				}
			});
			return stream;
		});
		const model = buildModel({
			id: "date-cwd-steer",
			name: "Date cwd steer",
			api,
			provider: "managed-primary",
			baseUrl: "https://api.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		});
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			toolNames: ["read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
		});
		sessions.push(session);
		setSystemTime(new Date(2026, 7, 14, 23, 59));
		try {
			await session.sendUserMessage("first");
			await session.waitForIdle();
			const before = contexts[1];
			const after = contexts[2];
			if (!before || !after) throw new Error("Expected both tool-continuation requests");
			expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
			expect(after.messages.at(-1)).toMatchObject({
				role: "developer",
				content: renderDateCwdReminder("2026-08-15", normalizePromptPath(tempDir.path())),
			});
		} finally {
			setSystemTime();
			authStorage.close();
		}
	});
});

describe("date-cwd reminder across reader views of a snapcompact archive", () => {
	const PER_CALL_NOTE = "per-call note";

	afterEach(() => {
		clearCustomApis();
		vi.restoreAllMocks();
	});

	/**
	 * A live session on a GPT model over an archive it rendered with reasoning.
	 * Live requests reach `contexts` after the provider transforms, the date/cwd
	 * reminder included.
	 */
	async function openSession(tempDir: TempDir, extensions: ExtensionFactory[] = []) {
		const api = "test-date-cwd-reader-view";
		const contexts: Context[] = [];
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
			});
			return stream;
		});
		const gpt = buildModel({
			id: "gpt-5.4",
			name: "GPT reader",
			api,
			provider: "managed-primary",
			baseUrl: "https://api.example.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 32_000,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const keptId = sessionManager.appendMessage({ role: "user", content: "Kept turn.", timestamp: 1 });
		const archived = await snapcompact.compact(
			{
				firstKeptEntryId: keptId,
				messagesToSummarize: [
					{ role: "user", content: "Plan the migration.", timestamp: 0 },
					{
						...createAssistantMessage("Migrated."),
						content: [
							{ type: "thinking", thinking: "PRIVATE-REASONING about the migration." },
							{ type: "text", text: "Migrated." },
						],
					},
				],
				turnPrefixMessages: [],
				tokensBefore: 10_000,
				fileOps: snapcompact.createFileOps(),
			},
			{ model: gpt },
		);
		expect(archived.summary).toContain("¶think:");
		sessionManager.appendCompaction(archived.summary, archived.shortSummary, keptId, archived.tokensBefore, {
			details: archived.details,
			preserveData: archived.preserveData,
			method: "snapcompact",
		});
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(gpt.provider, "test-key");
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: gpt,
			extensions,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		// A reminder change is what a date rollover or a cwd move produces; the cwd is the deterministic one.
		const moveCwd = () => vi.spyOn(sessionManager, "getCwd").mockReturnValue(tempDir.join("moved"));
		/** A side request over the live history, as the reader `model` reads it (the live model by default). */
		const sideRequest = async (model?: Model) =>
			session.agent.buildSideRequestContext(await session.convertMessagesToLlm(session.messages, undefined, model));
		const close = async () => {
			await session.dispose();
			authStorage.close();
		};
		return { session, contexts, moveCwd, sideRequest, close };
	}

	/** The request's history: a hook's note rides at its end, exactly as the hook wrote it. */
	function history(context: Context | undefined): Message[] {
		if (!context) throw new Error("Expected a live request");
		const last = context.messages.at(-1);
		if (last?.role !== "user" || last.content !== PER_CALL_NOTE) return context.messages;
		return context.messages.slice(0, -1);
	}

	function expectExtends(next: Context | undefined, previous: Context | undefined): void {
		const sent = history(previous);
		expect(history(next).slice(0, sent.length)).toEqual(sent);
	}

	/** Appends a fresh note to every request, as a Better Compact style context hook does. */
	const appendNote: ExtensionFactory = pi => {
		pi.on("context", event => ({
			messages: [...event.messages, { role: "user", content: PER_CALL_NOTE, timestamp: 0 }],
		}));
	};

	it("keeps the live model's sent bytes when a request for a reader without reasoning passes through", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-reader-view-");
		const claude = getBundledModel("anthropic", "claude-opus-5-5");
		const opened = await openSession(tempDir);
		try {
			await opened.session.prompt("first");
			opened.moveCwd();
			const side = await opened.sideRequest(claude);
			expect(JSON.stringify(side.messages)).not.toContain("PRIVATE-REASONING");
			await opened.session.prompt("second");
		} finally {
			await opened.close();
		}

		expect(opened.contexts).toHaveLength(2);
		expectExtends(opened.contexts[1], opened.contexts[0]);
	});

	it("keeps the live model's sent bytes across a side request on the same model", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-same-reader-");
		const opened = await openSession(tempDir);
		try {
			await opened.session.prompt("first");
			opened.moveCwd();
			await opened.sideRequest();
			await opened.session.prompt("second");
		} finally {
			await opened.close();
		}

		expectExtends(opened.contexts[1], opened.contexts[0]);
	});

	it("keeps the live model's sent bytes across a reminder change when a context hook adds a note to every request", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-hook-");
		const opened = await openSession(tempDir, [appendNote]);
		try {
			await opened.session.prompt("first");
			opened.moveCwd();
			await opened.session.prompt("second");
		} finally {
			await opened.close();
		}

		for (const context of opened.contexts) expect(context.messages.at(-1)?.content).toBe(PER_CALL_NOTE);
		expectExtends(opened.contexts[1], opened.contexts[0]);
		// The moved cwd rides on the turn that followed the move.
		expect(JSON.stringify(history(opened.contexts[1]).at(-1))).toContain(tempDir.join("moved"));
	});

	it("keeps the live model's sent bytes across a side request when a context hook adds a note to every request", async () => {
		using tempDir = TempDir.createSync("@pi-date-cwd-same-reader-hook-");
		const opened = await openSession(tempDir, [appendNote]);
		try {
			await opened.session.prompt("first");
			opened.moveCwd();
			await opened.sideRequest();
			await opened.session.prompt("second");
		} finally {
			await opened.close();
		}

		expectExtends(opened.contexts[1], opened.contexts[0]);
	});
});
