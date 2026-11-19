import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { __resetProxyCache } from "@oh-my-pi/pi-ai/utils/proxy";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

// An agent client (Antigravity CLI) keeps its own conversation and never receives omp's
// stored transcript, so a long stored history must not trigger compaction while the model
// reports a small context; for any other model the stored estimate still floors the decision.

const OPUS = getBundledModel<"anthropic-messages">("anthropic", "claude-opus-5-5");
const AGY_ENDPOINT = "https://agy-bridge.example.test";
const THRESHOLD_TOKENS = 40_000;

function sse(events: Record<string, unknown>[]): Response {
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A short reply that reports a small context, as an agent client reports its own conversation. */
function smallReply(): Response {
	return sse([
		{
			type: "message_start",
			message: {
				id: "msg_1",
				type: "message",
				role: "assistant",
				content: [],
				model: "test",
				stop_reason: null,
				usage: { input_tokens: 1_000, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	]);
}

describe("compaction behind an agent client", () => {
	const previousProxy = Bun.env.PI_PROXY_ANTHROPIC;
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-client-compaction-");
		// A provider proxy moves first-party requests onto `globalThis.fetch`, where the spy answers them.
		Bun.env.PI_PROXY_ANTHROPIC = "http://proxy.example.test:8080";
		__resetProxyCache();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async input => {
				const url = String(input);
				if (
					!url.startsWith("https://api.anthropic.com/v1/messages") &&
					!url.startsWith(`${AGY_ENDPOINT}/v1/messages`)
				) {
					throw new Error(`Unexpected request to ${url}`);
				}
				return smallReply();
			}),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		tempDir.removeSync();
		if (previousProxy === undefined) delete Bun.env.PI_PROXY_ANTHROPIC;
		else Bun.env.PI_PROXY_ANTHROPIC = previousProxy;
		__resetProxyCache();
	});

	/** Run one turn over a stored history far above the threshold; return how many compactions started. */
	async function compactionsAfterTurn(useAgentClient: boolean): Promise<number> {
		await Bun.write(
			tempDir.join("models.yml"),
			`providers:\n  antigravity-cli:\n    baseUrl: ${AGY_ENDPOINT}\n    api: anthropic-messages\n    apiKey: agy-key\n    models:\n      - id: agy-test\n        name: Agy Test\n        reasoning: false\n        input: [text]\n        contextWindow: 200000\n        maxTokens: 8192\n`,
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("anthropic", "sk-ant-test");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const agyModel = modelRegistry.find("antigravity-cli", "agy-test");
		if (!agyModel) throw new Error("antigravity-cli/agy-test is not registered");
		const model = useAgentClient ? agyModel : OPUS;
		const sessionManager = SessionManager.inMemory(tempDir.path());
		// ~150K tokens of stored history, all of it older than the agent client's own conversation.
		for (let index = 0; index < 30; index++) {
			sessionManager.appendMessage({
				role: "user",
				content: `question ${index} ${"q".repeat(10_000)}`,
				timestamp: Date.now(),
			});
			const answer: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: `answer ${index} ${"a".repeat(10_000)}` }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1_000,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1_010,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			sessionManager.appendMessage(answer);
		}
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.thresholdTokens": THRESHOLD_TOKENS,
				"harness.mode": "native",
			}),
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
		let starts = 0;
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") starts++;
		});
		try {
			await session.prompt("next question");
			await session.waitForIdle();
		} finally {
			await session.dispose();
			authStorage.close();
		}
		return starts;
	}

	it("counts only the client's reported context, so a long stored history does not compact", async () => {
		expect(await compactionsAfterTurn(true)).toBe(0);
	});

	it("still floors a regular model's decision by the stored history", async () => {
		expect(await compactionsAfterTurn(false)).toBeGreaterThan(0);
	});
});
