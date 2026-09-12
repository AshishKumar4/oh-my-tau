/**
 * forkMessages: the parent's resolved LLM context becomes the forked child's
 * inherited history — cut at the spawn call, stripped of replay-unsafe
 * provider state, and bounded to the last N user-message turns when asked.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { forkMessages } from "@oh-my-pi/pi-coding-agent/task/fork";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

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

function custom(customType: string): AgentMessage {
	return {
		role: "custom",
		customType,
		content: "notice",
		display: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

const SPAWN_CALL = "spawn-call-1";

function sessionWith(messages: AgentMessage[]): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		sessionManager: {
			buildSessionContext: () => ({ messages }),
		},
	} as unknown as ToolSession;
}

/** Full transcript up to the in-flight spawn: two complete turns plus the assistant's spawn call. */
function history(): AgentMessage[] {
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
	it("inherits the full history minus the spawn call", () => {
		const messages = forkMessages(sessionWith(history()), "all", SPAWN_CALL);
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "assistant", "toolResult", "user"]);
		expect(
			messages.some(
				message =>
					message.role === "assistant" &&
					message.content.some(block => block.type === "toolCall" && block.id === SPAWN_CALL),
			),
		).toBe(false);
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

	it("strips thinking blocks and provider replay payloads from assistant messages", () => {
		const messages = forkMessages(
			sessionWith([
				user("hi"),
				assistant(
					[
						{ type: "thinking", thinking: "hidden" },
						{ type: "redactedThinking", data: "opaque" },
						{ type: "text", text: "hello" },
					],
					{ providerPayload: { type: "openaiResponsesHistory", items: [] } },
				),
				assistantCall(SPAWN_CALL),
			]),
			"all",
			SPAWN_CALL,
		);
		const inherited = messages[1] as AssistantMessage;
		expect(inherited.content).toEqual([{ type: "text", text: "hello" }]);
		expect(inherited.providerPayload).toBeUndefined();
	});

	it("drops an assistant message left with no replayable content", () => {
		const messages = forkMessages(
			sessionWith([user("hi"), assistant([{ type: "thinking", thinking: "only thought" }]), user("again")]),
			"all",
			SPAWN_CALL,
		);
		expect(messages.map(message => message.role)).toEqual(["user", "user"]);
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

	it("drops non-LLM roles from the inherited history", () => {
		const messages = forkMessages(
			sessionWith([user("hi"), custom("async-result"), assistantText("ok"), user("next")]),
			"all",
			SPAWN_CALL,
		);
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
	});

	it("returns an empty list when nothing is forkable", () => {
		expect(forkMessages(sessionWith([]), "all", SPAWN_CALL)).toEqual([]);
		// Only the spawn call itself: nothing precedes it to inherit.
		expect(forkMessages(sessionWith([assistantCall(SPAWN_CALL)]), "all", SPAWN_CALL)).toEqual([]);
	});
});
