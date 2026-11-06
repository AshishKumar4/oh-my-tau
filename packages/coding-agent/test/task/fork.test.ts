/**
 * forkMessages: the parent's resolved LLM context becomes the forked child's
 * inherited history — cut at the spawn call, converted through the shared
 * LLM projection (custom messages become visible turns), and bounded to the
 * last N user-message turns when asked.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ThinkingContent, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { forkMessages } from "@oh-my-pi/pi-coding-agent/task/fork";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistant(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...extra,
	};
}

function assistantText(text: string): AssistantMessage {
	return assistant([{ type: "text", text }]);
}

function assistantCall(id: string, name = "read", args: Record<string, unknown> = {}): AssistantMessage {
	return assistant([{ type: "toolCall", id, name, arguments: args }]);
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function custom(customType: string): CustomMessage {
	return {
		role: "custom",
		customType,
		content: "notice",
		display: false,
		timestamp: Date.now(),
	};
}

/** Messages the session journal accepts — the resolved-history subset of AgentMessage. */
type JournalMessage = Parameters<SessionManager["appendMessage"]>[0];

const SPAWN_CALL = "spawn-call-1";

function sessionWith(messages: JournalMessage[]): ToolSession {
	const sessionManager = SessionManager.inMemory();
	for (const message of messages) sessionManager.appendMessage(message);
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		sessionManager,
	};
}

/** Full transcript up to the in-flight spawn: two complete turns plus the assistant's spawn call. */
function history(): JournalMessage[] {
	return [
		user("remember the secret BLUE-HERON-42"),
		assistant([
			{ type: "thinking", thinking: "private reasoning", thinkingSignature: "sig" },
			{ type: "text", text: "Noted." },
		]),
		assistantCall("call-read", "read", { path: "x" }),
		toolResult("call-read", "file contents"),
		user("now spawn a worker"),
		assistantCall(SPAWN_CALL, "task", { task: "report the secret" }),
	];
}

describe("forkMessages", () => {
	it("inherits the full resolved history minus the spawn call", () => {
		const messages = forkMessages(sessionWith(history()), "all", SPAWN_CALL);
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "assistant", "toolResult", "user"]);
		expect(
			messages.some(
				message =>
					message.role === "assistant" &&
					message.content.some(block => block.type === "toolCall" && block.id === SPAWN_CALL),
			),
		).toBe(false);
		// The conversion stamps turn-initiator attribution on user messages.
		expect((messages[0] as UserMessage).attribution).toBe("user");
	});

	it("keeps only the last N user-message turns", () => {
		const messages = forkMessages(sessionWith(history()), { lastTurns: 1 }, SPAWN_CALL);
		expect(messages.map(message => message.role)).toEqual(["user"]);
		expect((messages[0] as UserMessage).content).toBe("now spawn a worker");

		const two = forkMessages(sessionWith(history()), { lastTurns: 2 }, SPAWN_CALL);
		expect(two.map(message => message.role)).toEqual(["user", "assistant", "assistant", "toolResult", "user"]);
	});

	it("drops a persisted spawn toolResult along with its call", () => {
		const messages = forkMessages(sessionWith([...history(), toolResult(SPAWN_CALL, "spawned")]), "all", SPAWN_CALL);
		expect(messages.some(message => message.role === "toolResult" && message.toolCallId === SPAWN_CALL)).toBe(false);
	});

	it("preserves provider-native assistant replay state for openai-codex", () => {
		const messages = forkMessages(
			sessionWith([
				user("hi"),
				assistant(
					[
						{ type: "thinking", thinking: "hidden", thinkingSignature: "sig" },
						{ type: "text", text: "hello" },
					],
					{ provider: "openai-codex", providerPayload: { type: "openaiResponsesHistory", items: [] } },
				),
				assistantCall(SPAWN_CALL),
			]),
			"all",
			SPAWN_CALL,
		);
		const inherited = messages[1] as AssistantMessage;
		expect(inherited.content).toEqual([
			{ type: "thinking", thinking: "hidden", thinkingSignature: "sig" },
			{ type: "text", text: "hello" },
		]);
		expect(inherited.providerPayload).toEqual({ type: "openaiResponsesHistory", items: [] });
	});

	it("strips copilot-bound assistant replay state on rehydration", () => {
		const messages = forkMessages(
			sessionWith([
				user("hi"),
				assistant(
					[
						{ type: "thinking", thinking: "hidden", thinkingSignature: "sig" },
						{ type: "text", text: "hello" },
					],
					{
						provider: "github-copilot",
						providerPayload: { type: "openaiResponsesHistory", items: [] },
					},
				),
				assistantCall(SPAWN_CALL),
			]),
			"all",
			SPAWN_CALL,
		);
		const inherited = messages[1] as AssistantMessage;
		const thinking = inherited.content[0] as ThinkingContent;
		expect(thinking.thinking).toBe("hidden");
		expect(thinking.thinkingSignature).toBeUndefined();
		expect(inherited.providerPayload).toBeUndefined();
	});

	it("keeps a thinking-only assistant turn as bound reasoning", () => {
		const messages = forkMessages(
			sessionWith([user("hi"), assistant([{ type: "thinking", thinking: "only thought" }]), user("again")]),
			"all",
			SPAWN_CALL,
		);
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
	});

	it("drops toolResults orphaned by a dropped or cut tool call", () => {
		// The call itself was filtered from the resolved context, but its
		// toolResult survived: without the pairing pass the child would inherit
		// a result for a call it never saw.
		const messages = forkMessages(
			sessionWith([user("hi"), toolResult("ghost-call", "output"), user("next")]),
			"all",
			SPAWN_CALL,
		);
		expect(messages.some(message => message.role === "toolResult")).toBe(false);
	});

	it("renders custom messages as visible turns instead of dropping them", () => {
		const messages = forkMessages(
			sessionWith([user("hi"), custom("async-result"), assistantText("ok"), user("next")]),
			"all",
			SPAWN_CALL,
		);
		expect(messages.map(message => message.role)).toEqual(["user", "developer", "assistant", "user"]);
		expect(messages[1]?.role === "developer" && messages[1].content).toEqual([{ type: "text", text: "notice" }]);
	});

	it("returns an empty list when nothing is forkable", () => {
		expect(forkMessages(sessionWith([]), "all", SPAWN_CALL)).toEqual([]);
		// Only the spawn call itself: nothing precedes it to inherit.
		expect(forkMessages(sessionWith([assistantCall(SPAWN_CALL)]), "all", SPAWN_CALL)).toEqual([]);
	});

	it("detaches inherited messages from the parent's resolved context", () => {
		const session = sessionWith([user("hi"), assistantCall("call-x"), toolResult("call-x", "out"), user("next")]);
		const messages = forkMessages(session, "all", SPAWN_CALL);
		const result = messages[2] as ToolResultMessage;
		expect(result.role).toBe("toolResult");
		const text = result.content[0];
		if (text?.type !== "text") throw new Error("expected text content");
		text.text = "mutated";
		// The parent's journal still resolves the original value: the snapshot
		// is deep-cloned, so later forks never observe the mutation.
		const second = forkMessages(session, "all", SPAWN_CALL)[2] as ToolResultMessage;
		const secondText = second.content[0];
		expect(secondText?.type === "text" && secondText.text).toBe("out");
	});

	it("rejects a session with no resolvable context instead of forking nothing", () => {
		const bare = { cwd: "/tmp" } as unknown as ToolSession;
		expect(() => forkMessages(bare, "all", SPAWN_CALL)).toThrow(ToolError);
	});

	it("sees through compaction: summary first, then kept and post-compaction turns", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(user("old turn"));
		sessionManager.appendMessage(assistantText("old answer"));
		const keptId = sessionManager.appendMessage(user("kept question"));
		sessionManager.appendMessage(assistantText("kept answer"));
		sessionManager.appendCompaction("summary text", "short", keptId, 3);
		sessionManager.appendCustomMessageEntry("skill-prompt", "run skill", false, undefined, "user");
		sessionManager.appendCustomMessageEntry("ext-notice", "extension note", false);
		sessionManager.appendMessage(user("latest"));
		sessionManager.appendMessage(assistantCall(SPAWN_CALL));

		const messages = forkMessages({ cwd: "/tmp", sessionManager } as unknown as ToolSession, "all", SPAWN_CALL);
		expect(messages.map(message => message.role)).toEqual([
			"user", // compaction summary
			"user", // kept question
			"assistant",
			"user", // skill-prompt custom message
			"developer", // generic custom message
			"user", // latest
		]);
		const summary = messages[0] as UserMessage;
		const summaryText = Array.isArray(summary.content) ? summary.content[0] : undefined;
		expect(summaryText?.type === "text" && summaryText.text).toContain("<summary>\nsummary text\n</summary>");
		expect((messages[1] as UserMessage).content).toBe("kept question");
		expect((messages[3] as UserMessage).content).toEqual([{ type: "text", text: "run skill" }]);
		expect(messages[4]?.role === "developer" && messages[4].content).toEqual([
			{ type: "text", text: "extension note" },
		]);
	});
});
