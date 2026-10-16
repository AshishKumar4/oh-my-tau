/**
 * Regression: a provider whose streamed tool-call id never materializes until
 * agent-loop's `done`-time mint (`ensureUniqueToolCallIds`) surfaces the id
 * change only on the final message snapshot — the last `message_update` still
 * carries `""`, so the delta-driven `#migrateStreamedToolCallId` replay in
 * `#handleMessageUpdate` never fires and `#handleMessageEnd` must reconcile the
 * per-index ids itself. Without that replay the `""`-keyed card ghosts: it shows
 * 'running' until `#sealAbandonedForegroundTools` while `tool_execution_start`
 * under the minted id finds no card and mounts a second one — a visible ghost
 * per empty-id call, plus a lost stream preview (held under the pre-mint id).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { Component } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme();
});
afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
});

it("retains pending grouped reads when a shared entry changes to a different tool", async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	const streaming = message([]);
	streaming.content = [
		{ type: "toolCall", id: "read-keeper", name: "read", arguments: { path: "/tmp/keeper.txt" } },
		{ type: "toolCall", id: "", name: "read", arguments: { path: "/tmp/other.txt" } },
		{ type: "toolCall", id: "", name: "bash", arguments: { command: "echo fixture" } },
	];
	const final: AssistantMessage = {
		...streaming,
		content: streaming.content.map((block, index) =>
			block.type === "toolCall" ? { ...block, id: index === 0 ? block.id : `final-${index}` } : block,
		),
	};
	const ctx = createInteractiveModeContext({
		streamingMessage: streaming,
		streamingComponent: new AssistantMessageComponent(),
	});
	const controller = new EventController(ctx);
	try {
		await controller.handleEvent({
			type: "message_update",
			message: streaming,
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: "{}", partial: streaming },
		});
		const keeper = ctx.pendingTools.get("read-keeper");
		if (!(keeper instanceof ReadToolGroupComponent)) throw new Error("Expected grouped read");
		await controller.handleEvent({ type: "message_end", message: final });
		expect(ctx.pendingTools.get("read-keeper")).toBe(keeper);
		expect(keeper.isTranscriptBlockFinalized()).toBe(false);
		for (const block of final.content) {
			if (block.type !== "toolCall") continue;
			await controller.handleEvent({
				type: "tool_execution_start",
				toolCallId: block.id,
				toolName: block.name,
				args: block.arguments,
				intent: undefined,
			});
		}
		expect(keeper.isTranscriptBlockFinalized()).toBe(false);
		for (const block of final.content) {
			if (block.type !== "toolCall") continue;
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: block.id,
				toolName: block.name,
				result: {
					content: [{ type: "text", text: "Read fixture content" }],
					details: block.name === "read" ? { totalLines: 1 } : undefined,
				},
				isError: false,
			});
		}
		expect(keeper.isTranscriptBlockFinalized()).toBe(true);
		const rendered = keeper
			.render(120)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("keeper.txt");
		expect(
			ctx.chatContainer.children
				.filter(child => child instanceof ToolExecutionComponent)
				.map(child => child.toolName),
		).toEqual(["bash"]);
	} finally {
		controller.dispose();
		for (const component of ctx.chatContainer.children)
			if (component instanceof ToolExecutionComponent || component instanceof ReadToolGroupComponent)
				component.seal();
	}
});

it.each([true, false])(
	"rebuilds an incompatible shared renderer instead of carrying it to a different tool, write first=%s",
	async writeFirst => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const write = { type: "toolCall", id: "", name: "write", arguments: { path: "/tmp/owned.txt", content: "data" } };
		const bash = { type: "toolCall", id: "", name: "bash", arguments: { command: "echo fixture" } };
		const streaming = message([]);
		streaming.content = writeFirst
			? [
					{ ...write, type: "toolCall" },
					{ ...bash, type: "toolCall" },
				]
			: [
					{ ...bash, type: "toolCall" },
					{ ...write, type: "toolCall" },
				];
		const finalized: AssistantMessage = {
			...streaming,
			content: streaming.content.map((block, index) =>
				block.type === "toolCall" ? { ...block, id: `settled-${index}` } : block,
			),
		};
		const ctx = createInteractiveModeContext({
			streamingMessage: streaming,
			streamingComponent: new AssistantMessageComponent(),
		});
		const controller = new EventController(ctx);
		try {
			await controller.handleEvent({
				type: "message_update",
				message: streaming,
				assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{}", partial: streaming },
			});
			await controller.handleEvent({ type: "message_end", message: finalized });
			for (const block of finalized.content) {
				if (block.type !== "toolCall") continue;
				await controller.handleEvent({
					type: "tool_execution_start",
					toolCallId: block.id,
					toolName: block.name,
					args: block.arguments,
					intent: undefined,
				});
				const card = ctx.pendingTools.get(block.id);
				if (!(card instanceof ToolExecutionComponent)) throw new Error("Expected tool-specific card");
				expect(card.toolName).toBe(block.name);
				expect(card.describe().p?.key).toBe(block.id);
				await controller.handleEvent({
					type: "tool_execution_end",
					toolCallId: block.id,
					toolName: block.name,
					result: { content: [{ type: "text", text: "Done" }] },
					isError: false,
				});
			}
			expect(ctx.chatContainer.children.filter(child => child instanceof ToolExecutionComponent)).toHaveLength(2);
		} finally {
			controller.dispose();
			for (const component of ctx.chatContainer.children)
				if (component instanceof ToolExecutionComponent) component.seal();
		}
	},
);

function message(ids: string[]): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		timestamp: Date.now(),
		content: ids.map((id, index) => ({
			type: "toolCall",
			id,
			name: "write",
			arguments: { path: `/tmp/${index}.txt`, content: `value-${index}` },
		})),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

it.each(["", "shared"])("settles one card per sibling when final IDs split from %s", async original => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	const streaming = message([original, original]);
	const finalIds = original ? [original, "repaired"] : ["minted-first", "minted-second"];
	const finalized = message(finalIds);
	const ctx = createInteractiveModeContext({
		streamingMessage: streaming,
		streamingComponent: new AssistantMessageComponent(),
	});
	const controller = new EventController(ctx);
	try {
		await controller.handleEvent({
			type: "message_update",
			message: streaming,
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "{}", partial: streaming },
		});
		const shared = ctx.pendingTools.get(original);
		if (!(shared instanceof ToolExecutionComponent)) throw new Error("Expected streamed tool card");
		const args = vi.spyOn(shared, "updateArgs");
		await controller.handleEvent({
			type: "tool_stream_update",
			toolCallId: original,
			toolName: "write",
			update: { text: "writing" },
		});
		await controller.handleEvent({ type: "message_end", message: finalized });
		if (original) expect(args).toHaveBeenLastCalledWith({ path: "/tmp/0.txt", content: "value-0" }, original);
		for (const block of finalized.content) {
			if (block.type !== "toolCall") continue;
			await controller.handleEvent({
				type: "tool_execution_start",
				toolCallId: block.id,
				toolName: block.name,
				args: block.arguments,
				intent: undefined,
			});
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: block.id,
				toolName: block.name,
				result: { content: [{ type: "text", text: `wrote ${block.arguments.path}` }] },
				isError: false,
			});
		}
		expect(ctx.pendingTools.has("")).toBe(false);
		const cards = ctx.chatContainer.children.filter(child => child instanceof ToolExecutionComponent);
		expect(cards).toHaveLength(2);
		expect(cards).toContain(shared);
		expect(cards.map(card => card.describe().p?.key).sort()).toEqual([...finalIds].sort());
		const rendered = cards
			.flatMap(card => card.render(120))
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("0.txt");
		expect(rendered).toContain("1.txt");
	} finally {
		controller.dispose();
		for (const component of ctx.chatContainer.children)
			if (component instanceof ToolExecutionComponent) component.seal();
	}
});

function makeStreamingMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

// Components the controller mounts during a dispatch (pending tool previews).
// Sealed in afterEach so their spinner intervals never outlive the test file.
const mountedComponents: Component[] = [];

function createFixture(streamingMessage: AssistantMessage) {
	const streamingComponent = new AssistantMessageComponent();
	const ctx = createInteractiveModeContext({ streamingComponent, streamingMessage });
	const addChild = ctx.chatContainer.addChild.bind(ctx.chatContainer);
	vi.spyOn(ctx.chatContainer, "addChild").mockImplementation(child => {
		mountedComponents.push(child);
		addChild(child);
	});
	const controller = new EventController(ctx);
	return { controller, ctx };
}

describe("EventController reconciles streamed tool-call ids at message_end", () => {
	afterEach(() => {
		for (const component of mountedComponents.splice(0)) {
			if (component instanceof ToolExecutionComponent) component.seal();
		}
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("settles the streamed empty-id card under the minted id — no ghost card at execution start", async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const args = { file_path: "/tmp/a.ts", content: "x" };
		// The call streams under a never-materialized id; agent-loop mints the id
		// only on the final snapshot, so no delta ever shows the change.
		const streamed = makeStreamingMessage([{ type: "toolCall", id: "", name: "write", arguments: args }]);
		const minted = makeStreamingMessage([{ type: "toolCall", id: "call_1", name: "write", arguments: args }]);
		const { controller, ctx } = createFixture(streamed);

		await controller.handleEvent({
			type: "message_update",
			message: streamed,
			assistantMessageEvent: undefined as never,
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		const streamedCard = ctx.pendingTools.get("");
		expect(streamedCard).toBeDefined();

		await controller.handleEvent({
			type: "message_end",
			message: minted,
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "write",
			args,
			intent: undefined,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);

		// ONE card — the streamed card migrated under the minted id and execution
		// reused it. Without the message_end reconciliation a second card mounts
		// under `call_1` and the streamed `""` card ghosts until sealed.
		expect(ctx.pendingTools.get("call_1")).toBe(streamedCard);
		expect(ctx.pendingTools.has("")).toBe(false);
		expect([...ctx.pendingTools.keys()]).toEqual(["call_1"]);
		const cards = ctx.chatContainer.children.filter(child => child instanceof ToolExecutionComponent);
		expect(cards).toHaveLength(1);
		controller.dispose();
	});

	it("keeps one settled card per sibling when a reused id splits at message_end", async () => {
		// Failure mode if this regresses: both siblings stream under ONE reused id
		// (`call-1`), sharing the single `pendingTools` entry. agent-loop's repair
		// re-keys the second at `done` (`call-1_dup1`), and the naive per-index
		// migration moves that one shared card to `call-1_dup1` — index 0 (still
		// `call-1`) is left with NO streamed card (reverse ghost): its args and
		// stream preview ride its sibling's card while its own card only appears
		// at `tool_execution_start`. Invariant: after message_end +
		// tool_execution_start for both siblings, exactly ONE settled card per id,
		// no ghost, and the streamed card (with its preview) is a real card of the
		// id that keeps it.
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		const argsA = { file_path: "/tmp/a.ts", content: "x" };
		const argsB = { file_path: "/tmp/b.ts", content: "y" };
		const streamed = makeStreamingMessage([
			{ type: "toolCall", id: "call-1", name: "write", arguments: argsA },
			{ type: "toolCall", id: "call-1", name: "write", arguments: argsB },
		]);
		const minted = makeStreamingMessage([
			{ type: "toolCall", id: "call-1", name: "write", arguments: argsA },
			{ type: "toolCall", id: "call-1_dup1", name: "write", arguments: argsB },
		]);
		const { controller, ctx } = createFixture(streamed);

		await controller.handleEvent({
			type: "message_update",
			message: streamed,
			assistantMessageEvent: undefined as never,
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		// During streaming BOTH indices share the one `call-1` entry.
		const sharedCard = ctx.pendingTools.get("call-1");
		expect(sharedCard).toBeDefined();
		const previewSpy = vi.spyOn(sharedCard!, "updateStreamPreview");
		const argsSpy = vi.spyOn(sharedCard!, "updateArgs");
		await controller.handleEvent({
			type: "tool_stream_update",
			toolCallId: "call-1",
			update: { text: "writing" },
		} as Extract<AgentSessionEvent, { type: "tool_stream_update" }>);
		expect(previewSpy).toHaveBeenCalledWith({ text: "writing" });

		await controller.handleEvent({
			type: "message_end",
			message: minted,
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		// The still-referenced `call-1` keeps the streamed card (with its preview);
		// the re-keyed sibling must not steal it — it picks up its own card at
		// tool_execution_start.
		expect(ctx.pendingTools.get("call-1")).toBe(sharedCard);
		expect(ctx.pendingTools.has("call-1_dup1")).toBe(false);
		// The kept card renders its own call's args — not the sibling's, which
		// was the last writer on the shared card while the id was still shared.
		expect(argsSpy).toHaveBeenLastCalledWith(argsA, "call-1");

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "write",
			args: argsA,
			intent: undefined,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call-1_dup1",
			toolName: "write",
			args: argsB,
			intent: undefined,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		const splitCard = ctx.pendingTools.get("call-1_dup1");
		expect(ctx.pendingTools.get("call-1")).toBe(sharedCard);
		expect(splitCard).toBeDefined();
		expect(splitCard).not.toBe(sharedCard);

		// Exactly one card per id in the transcript: the streamed card the kept id
		// owns, plus the card the split sibling picked up at execution start.
		const cards = ctx.chatContainer.children.filter(child => child instanceof ToolExecutionComponent);
		expect(cards).toHaveLength(2);
		expect(cards.some(card => card === sharedCard)).toBe(true);
		expect(cards.some(card => card === splitCard)).toBe(true);

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "write",
			result: { content: [{ type: "text", text: "ok:a" }], details: {} },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call-1_dup1",
			toolName: "write",
			result: { content: [{ type: "text", text: "ok:b" }], details: {} },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		// Both siblings settled — no card stuck pending.
		expect(ctx.pendingTools.size).toBe(0);
		controller.dispose();
	});
});
