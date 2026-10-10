import { afterEach, beforeAll, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(() => initTheme());
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
