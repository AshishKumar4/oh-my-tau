import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

interface MessagesRequest {
	system?: unknown;
	tools?: unknown[];
	messages: unknown[];
}

function sse(events: Record<string, unknown>[]): Response {
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** One signed-thinking answer, streamed as the Messages API does; `readPath` ends it with a `read` call. */
function answer(turn: number, readPath?: string): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: `msg_${turn}`,
				type: "message",
				role: "assistant",
				content: [],
				model: "claude-opus-5-5",
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: `plan ${turn}` } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `sig-${turn}` } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: `answer ${turn}` } },
		{ type: "content_block_stop", index: 1 },
		...(readPath
			? [
					{
						type: "content_block_start",
						index: 2,
						content_block: { type: "tool_use", id: `toolu_${turn}`, name: "read", input: {} },
					},
					{
						type: "content_block_delta",
						index: 2,
						delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: readPath }) },
					},
					{ type: "content_block_stop", index: 2 },
				]
			: []),
		{
			type: "message_delta",
			delta: { stop_reason: readPath ? "tool_use" : "end_turn", stop_sequence: null },
			usage: { output_tokens: 5 },
		},
		{ type: "message_stop" },
	];
	return sse(events);
}

/** A successful on-demand compaction response carrying a signed summary block. */
function compactionAnswer(): Response {
	return sse([
		{
			type: "message_start",
			message: { id: "msg_compact", model: "claude-opus-5-5", usage: { input_tokens: 0, output_tokens: 0 } },
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "compaction", content: "summary", signature: "sig-compact" },
		},
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "compaction" }, usage: { input_tokens: 0, output_tokens: 0 } },
		{ type: "message_stop" },
	]);
}

/** Cache breakpoints follow the end of each request, so they are left out of the comparison. */
function withoutCacheControl(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value), (key, inner) => (key === "cache_control" ? undefined : inner));
}

describe("AgentSession Anthropic native compaction", () => {
	const previousProxy = Bun.env.PI_PROXY_ANTHROPIC;

	beforeEach(() => {
		// A provider proxy moves first-party requests off the Cowork transport
		// onto `globalThis.fetch`, where the spy below answers them.
		Bun.env.PI_PROXY_ANTHROPIC = "http://proxy.example.test:8080";
		__resetProxyCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousProxy === undefined) delete Bun.env.PI_PROXY_ANTHROPIC;
		else Bun.env.PI_PROXY_ANTHROPIC = previousProxy;
		__resetProxyCache();
	});

	const captured = () =>
		new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }), {
			status: 400,
			headers: { "content-type": "application/json" },
		});

	/** A real session whose Messages API requests are recorded and answered by `respond`. */
	async function openSession(
		tempDir: TempDir,
		respond: (request: number) => Response,
		extensions: ExtensionFactory[] = [],
	) {
		const model = getBundledModel("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected bundled claude-opus-5-5");
		const requests: MessagesRequest[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				if (!String(input).startsWith("https://api.anthropic.com/v1/messages")) {
					throw new Error(`Unexpected request to ${String(input)}`);
				}
				requests.push(JSON.parse(String(init?.body)));
				return respond(requests.length);
			}),
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "sk-ant-test");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated({ "compaction.methodOrder": ["remote"], "compaction.keepRecentTokens": 1 }),
			model,
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
		const close = async () => {
			await session.dispose();
			authStorage.close();
		};
		return { session, requests, moveCwd, close };
	}

	it("sends the summarized prefix with the live turn's system prompt, tools and message bytes", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-native-compaction-");
		// Two live turns answer; the compaction request is only captured.
		const { session, requests, close } = await openSession(tempDir, request =>
			request <= 2 ? answer(request) : captured(),
		);
		try {
			await session.prompt("first question");
			await session.prompt("second question");
			await expect(session.compact()).rejects.toThrow("captured");
		} finally {
			await close();
		}

		expect(requests).toHaveLength(3);
		const [, live, compaction] = requests;
		// The live turn carries the first-turn date/cwd reminder and the session's
		// projected tools; the compaction request must carry them too.
		expect(JSON.stringify(live.messages[0])).toContain("<system-reminder>");
		expect(compaction.system).toEqual(live.system);
		expect(compaction.tools).toEqual(live.tools);
		expect(compaction.messages.length).toBeGreaterThan(0);
		expect(withoutCacheControl(compaction.messages)).toEqual(
			withoutCacheControl(live.messages.slice(0, compaction.messages.length)),
		);
	});

	it("cuts after the summarized range when a context hook appends messages to every request", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-native-compaction-hook-");
		const appendNote: ExtensionFactory = pi => {
			pi.on("context", event => {
				const last = event.messages.at(-1);
				// A fresh note, and one spread from the last history message: both are added, not history.
				const notes: AgentMessage[] = [{ role: "user", content: "per-call note", timestamp: 0 }];
				if (last?.role === "user") notes.push({ ...last, content: "spread per-call note" });
				return { messages: [...event.messages, ...notes] };
			});
		};
		const { session, requests, close } = await openSession(
			tempDir,
			request => (request <= 2 ? answer(request) : captured()),
			[appendNote],
		);
		try {
			await session.prompt("first question");
			await session.prompt("second question");
			await expect(session.compact()).rejects.toThrow("captured");
		} finally {
			await close();
		}

		expect(requests).toHaveLength(3);
		const [, live, compaction] = requests;
		// The notes ride at the end of each live request; they are not part of the history.
		expect(JSON.stringify(live.messages.at(-1))).toContain("per-call note");
		// One-token keep-recent keeps only the last answer: the compaction request is the
		// history before it exactly as the live turn sent it, without the notes and
		// without the kept answer.
		expect(JSON.stringify(compaction.messages)).not.toContain("spread per-call note");
		expect(withoutCacheControl(compaction.messages)).toEqual(
			withoutCacheControl(live.messages.slice(0, compaction.messages.length)),
		);
		expect(JSON.stringify(compaction.messages)).not.toContain("answer 2");
		expect(JSON.stringify(compaction.messages)).not.toContain("per-call note");
	});

	it("cuts by history position when a context hook drops turns by the context's size", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-native-compaction-window-");
		// A window over the newest turns: the summarized history alone fits, the whole context does not.
		const keepNewestExchange: ExtensionFactory = pi => {
			pi.on("context", event => (event.messages.length > 3 ? { messages: event.messages.slice(-2) } : undefined));
		};
		const { session, requests, close } = await openSession(
			tempDir,
			request => (request <= 2 ? answer(request) : captured()),
			[keepNewestExchange],
		);
		try {
			await session.prompt("first question");
			await session.prompt("second question");
			await expect(session.compact()).rejects.toThrow("captured");
		} finally {
			await close();
		}

		expect(requests).toHaveLength(3);
		const compaction = JSON.stringify(requests[2].messages);
		// The whole context keeps the second exchange; its summarized part is the second question.
		expect(compaction).toContain("second question");
		expect(compaction).not.toContain("first question");
		expect(compaction).not.toContain("answer 2");
	});

	it("keeps summarized messages a context hook rewrites for every request, by spread or by clone", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-native-compaction-rewrite-");
		const hasText = (message: AgentMessage, text: string) =>
			message.role === "user" &&
			Array.isArray(message.content) &&
			message.content.some(block => block.type === "text" && block.text === text);
		const annotate: ExtensionFactory = pi => {
			pi.on("context", event => ({
				messages: event.messages.map(message => {
					if (message.role !== "user" || !Array.isArray(message.content)) return message;
					if (hasText(message, "first question")) {
						return { ...message, content: [{ type: "text" as const, text: "first question (annotated)" }] };
					}
					if (hasText(message, "second question")) {
						// A fresh object: it carries no provenance of its own.
						const clone = structuredClone(message);
						clone.content = [{ type: "text", text: "second question (annotated)" }];
						return clone;
					}
					return message;
				}),
			}));
		};
		const { session, requests, close } = await openSession(
			tempDir,
			request => (request <= 2 ? answer(request) : captured()),
			[annotate],
		);
		try {
			await session.prompt("first question");
			await session.prompt("second question");
			await expect(session.compact()).rejects.toThrow("captured");
		} finally {
			await close();
		}

		expect(requests).toHaveLength(3);
		const [, live, compaction] = requests;
		// The rewritten questions stay in the summarized range, the last one ending it:
		// the compaction request carries both as the live turn sent them, and stops
		// before the kept answer.
		expect(JSON.stringify(live.messages)).toContain("first question (annotated)");
		expect(JSON.stringify(live.messages.at(-1))).toContain("second question (annotated)");
		expect(withoutCacheControl(compaction.messages)).toEqual(withoutCacheControl(live.messages));
		expect(JSON.stringify(compaction.messages)).not.toContain("answer 2");
	});

	const note: AgentMessage = { role: "user", content: "per-call note", timestamp: 0 };
	const restructuringHooks: Array<[string, ExtensionFactory]> = [
		// Every message cloned (no provenance) and a note prepended: positions shift.
		[
			"prepends over clones",
			pi => pi.on("context", event => ({ messages: [note, ...event.messages.map(m => structuredClone(m))] })),
		],
		// The opening exchange repeated ahead of the clones: the shift keeps roles aligned.
		[
			"repeats the opening exchange over clones",
			pi =>
				pi.on("context", event => ({
					messages: [...event.messages.slice(0, 2), ...event.messages].map(m => structuredClone(m)),
				})),
		],
		// One array the hook keeps and returns on every call, whatever the history.
		[
			"returns one array it keeps across calls",
			pi => {
				const kept: AgentMessage[] = [note];
				pi.on("context", () => ({ messages: kept }));
			},
		],
		// The same shift at an unchanged length: a note prepended and the last message dropped.
		[
			"shifts clones at the same length",
			pi =>
				pi.on("context", event => ({
					messages: [note, ...event.messages.slice(0, -1).map(m => structuredClone(m))],
				})),
		],
	];

	for (const [label, hook] of restructuringHooks) {
		it(`declines rather than guess when a context hook ${label}`, async () => {
			using tempDir = TempDir.createSync("@pi-anthropic-native-compaction-restructure-");
			const { session, requests, close } = await openSession(
				tempDir,
				request => (request <= 2 ? answer(request) : captured()),
				[hook],
			);
			try {
				await session.prompt("first question");
				await session.prompt("second question");
				await expect(session.compact()).rejects.toThrow("cannot be located");
			} finally {
				await close();
			}
			// No native compaction request was sent with a guessed range.
			expect(requests).toHaveLength(2);
		});
	}

	it("locates the summarized range by each call's provenance when a hook reuses one note object", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-native-compaction-reused-");
		// One object across calls: untraced while the hook restructures, added once it appends.
		const reusedNote: AgentMessage = { role: "user", content: "reused per-call note", timestamp: 0 };
		let restructure = true;
		const hook: ExtensionFactory = pi => {
			pi.on("context", event => ({
				messages: restructure
					? [reusedNote, ...event.messages.map(m => structuredClone(m))]
					: [...event.messages, reusedNote],
			}));
		};
		const { session, requests, close } = await openSession(
			tempDir,
			request => (request <= 2 ? answer(request) : captured()),
			[hook],
		);
		try {
			await session.prompt("first question");
			await session.prompt("second question");
			restructure = false;
			await expect(session.compact()).rejects.toThrow("captured");
		} finally {
			await close();
		}

		expect(requests).toHaveLength(3);
		const compaction = requests[2];
		expect(JSON.stringify(compaction.messages)).toContain("second question");
		expect(JSON.stringify(compaction.messages)).not.toContain("reused per-call note");
		expect(JSON.stringify(compaction.messages)).not.toContain("answer 2");
	});

	it("keeps every summarized message when a reminder change mid tool loop inserted a control turn", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-native-compaction-control-");
		const file = tempDir.join("notes.txt");
		await Bun.write(file, "notes\n");
		const hooks: { moveCwd?: () => void } = {};
		const opened = await openSession(tempDir, request => {
			if (request === 2) {
				// The reminder changes while the tool runs: its continuation has no new user turn.
				hooks.moveCwd?.();
				return answer(request, file);
			}
			return request <= 4 ? answer(request) : captured();
		});
		hooks.moveCwd = opened.moveCwd;
		const { session, requests } = opened;
		try {
			await session.prompt("first question");
			await session.prompt("second question");
			await session.prompt("third question");
			await expect(session.compact()).rejects.toThrow("captured");
		} finally {
			await opened.close();
		}

		expect(requests).toHaveLength(5);
		const [, , , live, compaction] = requests;
		// The cut keeps only the last answer: the request is exactly what the
		// "third question" turn sent, the inserted control included.
		expect(JSON.stringify(compaction.messages)).not.toContain("answer 4");
		expect(withoutCacheControl(compaction.messages)).toEqual(withoutCacheControl(live.messages));
	});

	it("cuts a later compaction behind the earlier summary when a context hook adds a note to every request", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-native-compaction-summary-hook-");
		const appendNote: ExtensionFactory = pi => {
			pi.on("context", event => ({
				messages: [...event.messages, { role: "user", content: "per-call note", timestamp: 0 }],
			}));
		};
		const { session, requests, close } = await openSession(
			tempDir,
			request => (request === 3 ? compactionAnswer() : request === 5 ? captured() : answer(request)),
			[appendNote],
		);
		try {
			await session.prompt("first question");
			await session.prompt("second question");
			await session.compact();
			await session.prompt("third question");
			await expect(session.compact()).rejects.toThrow("captured");
		} finally {
			await close();
		}

		expect(requests).toHaveLength(5);
		const [live, compaction] = requests.slice(3);
		// The earlier summary converts to a message of its own making; it still counts as history.
		expect(JSON.stringify(compaction.messages[0])).toContain("sig-compact");
		expect(withoutCacheControl(compaction.messages)).toEqual(
			withoutCacheControl(live.messages.slice(0, compaction.messages.length)),
		);
		expect(JSON.stringify(compaction.messages)).toContain("third question");
		expect(JSON.stringify(compaction.messages)).not.toContain("per-call note");
		expect(JSON.stringify(compaction.messages)).not.toContain("answer 4");
	});

	it("replays a later compaction's prefix as sent, without disturbing the live reminder state", async () => {
		using tempDir = TempDir.createSync("@pi-anthropic-native-compaction-second-");
		const opened = await openSession(tempDir, request =>
			request === 3 ? compactionAnswer() : request === 6 ? captured() : answer(request),
		);
		const { session, requests } = opened;
		try {
			await session.prompt("first question");
			await session.prompt("second question");
			await session.compact();
			await session.prompt("third question");
			opened.moveCwd();
			await session.prompt("fourth question");
			await expect(session.compact()).rejects.toThrow("captured");
			await session.prompt("fifth question");
		} finally {
			await opened.close();
		}

		expect(requests).toHaveLength(7);
		const live = requests[4]!;
		const [compaction, next] = requests.slice(5);
		expect(withoutCacheControl(compaction.messages)).toEqual(
			withoutCacheControl(live.messages.slice(0, compaction.messages.length)),
		);
		// The next live turn still sends every earlier message unchanged.
		expect(withoutCacheControl(next.messages.slice(0, live.messages.length))).toEqual(
			withoutCacheControl(live.messages),
		);
	});
});
