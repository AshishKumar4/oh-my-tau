import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { SUPERSEDED_NOTICE } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import type { Api, AssistantMessage, ImageContent, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const OLD_RESULT = "old file contents\n".repeat(100);
const NEW_RESULT = "new file contents\n".repeat(100);

function createPrefixBindingModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-fable-5-1",
		name: "Claude Fable 5.1",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(model: Model, content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: usage(),
		timestamp,
	};
}

function toolResult(toolCallId: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function newSession(model: Model, shortTurns = 0, attachImages = false): AgentSession {
	const sessionManager = SessionManager.inMemory();
	const now = Date.now();
	sessionManager.appendMessage({ role: "user", content: "Read the file twice.", timestamp: now - 500 });
	sessionManager.appendMessage(
		assistant(
			model,
			[{ type: "toolCall", id: "read-old", name: "read", arguments: { path: "src/foo.ts" } }],
			now - 400,
		),
	);
	sessionManager.appendMessage(toolResult("read-old", OLD_RESULT, now - 350));
	for (let turn = 0; turn < shortTurns; turn++) {
		const id = `small-${turn}`;
		sessionManager.appendMessage(
			assistant(model, [{ type: "toolCall", id, name: "bash", arguments: { command: "true" } }], now - 340),
		);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: now - 330,
		});
	}
	if (attachImages) {
		const image: ImageContent = {
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZQAAAABJRU5ErkJggg==",
			mimeType: "image/png",
			type: "image",
		};
		sessionManager.appendMessage({
			role: "fileMention",
			files: [
				{ path: "notes.md", content: "short notes" },
				{ path: "first.png", content: "", image },
				{ path: "second.png", content: "", image },
			],
			timestamp: now - 320,
		});
	}
	sessionManager.appendMessage(
		assistant(
			model,
			[{ type: "toolCall", id: "read-new", name: "read", arguments: { path: "src/foo.ts" } }],
			now - 300,
		),
	);
	sessionManager.appendMessage(toolResult("read-new", NEW_RESULT, now - 250));
	const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({
			"compaction.enabled": false,
			"compaction.dropUseless": false,
			"compaction.supersedeReads": true,
		}),
		modelRegistry: { getApiKey: async () => "test-key" } as never,
	});
	session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	return session;
}

async function runMaintenance(session: AgentSession): Promise<void> {
	const model = session.model;
	if (!model) throw new Error("Expected an active model");
	const finalAssistant = assistant(model, [{ type: "text", text: "Done." }], Date.now());
	session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });
	await session.waitForIdle();
}

function oldResultText(session: AgentSession): string {
	const message = session.agent.state.messages.find(
		(candidate): candidate is ToolResultMessage =>
			candidate.role === "toolResult" && candidate.toolCallId === "read-old",
	);
	if (!message) throw new Error("Expected the old read result");
	const text = message.content.find(block => block.type === "text");
	if (text?.type !== "text") throw new Error("Expected text in the old read result");
	return text.text;
}

describe("prefix-bound stale-result pruning", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	const hosts: Array<{ host: string; api: Api; provider: string; id: string; baseUrl: string; bounded: boolean }> = [
		{
			host: "first-party Claude",
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			baseUrl: "https://api.anthropic.com",
			bounded: true,
		},
		{
			host: "Bedrock Claude",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			bounded: true,
		},
		{
			host: "gateway Claude",
			api: "openai-completions",
			provider: "openrouter",
			id: "anthropic/claude-sonnet-4.5",
			baseUrl: "https://openrouter.ai/api/v1",
			bounded: true,
		},
		{
			host: "GPT control",
			api: "openai-responses",
			provider: "openai",
			id: "gpt-5",
			baseUrl: "https://api.openai.com/v1",
			bounded: false,
		},
	];

	it.each(hosts)(
		"$host prunes a short suffix but keeps only cache-reachable rewrites behind many small turns",
		async ({ api, provider, id, baseUrl, bounded }) => {
			const model = buildModel({
				api,
				provider,
				id,
				baseUrl,
				name: id,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
			});
			const short = newSession(model);
			const long = newSession(model, 12);
			sessions.push(short, long);

			await runMaintenance(short);
			await runMaintenance(long);

			expect(oldResultText(short)).toBe(SUPERSEDED_NOTICE);
			const expectedLong = bounded ? OLD_RESULT : SUPERSEDED_NOTICE;
			expect(oldResultText(long)).toBe(expectedLong);
			const persisted = long.sessionManager
				.buildSessionContext()
				.messages.find(message => message.role === "toolResult" && message.toolCallId === "read-old");
			expect(persisted).toMatchObject({ content: [{ type: "text", text: expectedLong }] });
		},
	);

	it("counts split file-mention image projections before deciding a warm read can be pruned", async () => {
		const claude = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!claude) throw new Error("Expected bundled Claude model");
		const withoutAttachment = newSession(claude, 4);
		const withAttachment = newSession(claude, 4, true);
		sessions.push(withoutAttachment, withAttachment);

		await runMaintenance(withoutAttachment);
		await runMaintenance(withAttachment);

		expect(oldResultText(withoutAttachment)).toBe(SUPERSEDED_NOTICE);
		expect(oldResultText(withAttachment)).toBe(OLD_RESULT);
	});

	it("keeps a warm superseded read for prefix binding while the control model prunes it", async () => {
		const prefixBindingSession = newSession(createPrefixBindingModel());
		const controlSession = newSession(createModel());
		sessions.push(prefixBindingSession, controlSession);

		await runMaintenance(prefixBindingSession);
		await runMaintenance(controlSession);

		expect(oldResultText(prefixBindingSession)).toBe(OLD_RESULT);
		expect(oldResultText(controlSession)).toBe(SUPERSEDED_NOTICE);
	});
});
