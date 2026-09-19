import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { CompactionPreparation, CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionBeforeCompactResult } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/**
 * `session_before_compact` handlers may answer with `rewrite`: kept entries
 * edited in place before anything else in the round, consulted exactly once
 * per maintenance round. These tests drive the real maintenance path with a
 * fake extension runner and assert the contract from the outside: what
 * persists, which lifecycle events fire, how often the hook is consulted, and
 * when the configured method still runs.
 */

type HookCall = { preparation: CompactionPreparation; branchEntries: SessionEntry[] };
type HookAnswer = (call: HookCall, index: number) => SessionBeforeCompactResult | undefined;

const usage = (input: number) => ({
	input,
	output: 1000,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const PLACEHOLDER = "[pruned by extension]";

describe("AgentSession extension history rewrite", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let events: AgentSessionEvent[];
	let hookCalls: HookCall[];
	let hookAnswer: HookAnswer;
	let contextTokensAtCall: (number | undefined)[];

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage?.close();
	});

	beforeEach(() => {
		sessionManager = SessionManager.inMemory();
		events = [];
		hookCalls = [];
		hookAnswer = () => undefined;
		contextTokensAtCall = [];

		const extensionRunner = {
			hasHandlers: (type: string) => type === "session_before_compact",
			emit: async (event: {
				type: string;
				preparation?: CompactionPreparation;
				branchEntries?: SessionEntry[];
				supportsRewrite?: boolean;
			}) => {
				if (event.type !== "session_before_compact" || !event.preparation || !event.branchEntries) return undefined;
				// The seam mutates entry.message in place after the consult, so a bare
				// reference would retroactively show the rewrite; snapshot per call.
				const call = {
					preparation: event.preparation,
					branchEntries: event.branchEntries.map(entry =>
						entry.type === "message" ? { ...entry, message: structuredClone(entry.message) } : entry,
					),
				};
				expect(event.supportsRewrite).toBe(true);
				hookCalls.push(call);
				contextTokensAtCall.push(session.getContextUsage()?.tokens);
				return hookAnswer(call, hookCalls.length - 1);
			},
			emitBeforeAgentStart: async () => undefined,
		};

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		// 200k window with a 64k reservation: threshold 170k, recovery band 136k.
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": false,
				"compaction.methodOrder": ["soft"],
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
			extensionRunner: extensionRunner as never,
		});
		session.subscribe(event => events.push(event));
	});

	afterEach(async () => {
		await session?.dispose();
		vi.restoreAllMocks();
	});

	/** Seed user → assistant(toolCall) → toolResult(`tokens` worth of text) → user. */
	function seedToolTurn(tokens: number): { toolResultId: string; userId: string } {
		const toolCallId = `call_${Math.random().toString(36).slice(2)}`;
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1 });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "ls" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: usage(16),
			timestamp: 2,
		});
		const toolResultId = sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: "lorem ipsum dolor ".repeat(Math.ceil(tokens / 4)) }],
			isError: false,
			timestamp: 3,
		});
		const userId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "now do the next thing" }],
			timestamp: 4,
		});
		return { toolResultId, userId };
	}

	function entryMessage(entryId: string): AgentMessage {
		const entry = sessionManager.getBranch().find(candidate => candidate.id === entryId);
		if (!entry || entry.type !== "message") throw new Error(`entry ${entryId} is not a message on the branch`);
		return entry.message;
	}

	function toolResultText(message: AgentMessage): string {
		const content = (message as ToolResultMessage).content[0];
		return content?.type === "text" ? content.text : "";
	}

	function prunedToolResultMessage(entryId: string, text = PLACEHOLDER): AgentMessage {
		const original = entryMessage(entryId) as ToolResultMessage;
		return { ...original, content: [{ type: "text", text }] };
	}

	function prunedToolResult(entryId: string, text = PLACEHOLDER): SessionBeforeCompactResult {
		return { rewrite: [{ entryId, message: prunedToolResultMessage(entryId, text) }] };
	}

	function extensionCompaction(preparation: CompactionPreparation): CompactionResult {
		return {
			summary: "extension summary",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		};
	}

	function compactionEntries(): SessionEntry[] {
		return sessionManager.getBranch().filter(entry => entry.type === "compaction");
	}

	function lifecycle(): Extract<AgentSessionEvent, { type: "auto_compaction_start" | "auto_compaction_end" }>[] {
		return events.filter(
			(event): event is Extract<AgentSessionEvent, { type: "auto_compaction_start" | "auto_compaction_end" }> =>
				event.type === "auto_compaction_start" || event.type === "auto_compaction_end",
		);
	}

	/** Fire a post-turn threshold check billed at `contextTokens` and wait until maintenance settles. */
	async function triggerThreshold(contextTokens: number): Promise<void> {
		const settled = Promise.withResolvers<void>();
		let pending = 0;
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") pending++;
			if (event.type === "auto_compaction_end") {
				pending--;
				// A fallback re-enters synchronously after its end event; yield once so
				// the follow-up start (if any) is observed before we declare settled.
				queueMicrotask(() => {
					if (pending === 0) settled.resolve();
				});
			}
		});
		const assistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: usage(contextTokens),
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: assistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
		await settled.promise;
		await session.waitForIdle();
	}

	/** Stand in for the soft (context-full) summarizer so the native method is fast and deterministic. */
	function mockNativeSummary() {
		return vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "native summary",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
	}

	describe("automatic maintenance", () => {
		it("settles the round in place when the rewrite reaches the recovery band", async () => {
			const { toolResultId, userId } = seedToolTurn(90_000);
			hookAnswer = () => prunedToolResult(toolResultId);
			const nativeSummary = mockNativeSummary();

			await triggerThreshold(190_000);

			expect(hookCalls.length).toBe(1);
			expect(nativeSummary).not.toHaveBeenCalled();
			expect(compactionEntries()).toEqual([]);
			expect(toolResultText(entryMessage(toolResultId))).toBe(PLACEHOLDER);
			expect(entryMessage(userId).role).toBe("user");
			// The live agent runs on the rewritten history, not a stale replay.
			const liveToolResult = session.agent.state.messages.find(message => message.role === "toolResult");
			expect(liveToolResult && toolResultText(liveToolResult)).toBe(PLACEHOLDER);

			expect(lifecycle().map(event => [event.type, event.action])).toEqual([
				["auto_compaction_start", "context-full"],
				["auto_compaction_end", "rewrite"],
			]);
			const end = lifecycle()[1];
			expect(end.type === "auto_compaction_end" && end.result).toBeUndefined();
			expect(end.type === "auto_compaction_end" && end.skipped).toBeFalsy();
			expect(end.type === "auto_compaction_end" && end.errorMessage).toBeUndefined();
		});

		it("keeps context accounting honest when no usage anchor survives the rewrite", async () => {
			// Every recent turn aborted (a provider outage), so no assistant usage
			// can anchor accounting. The rewrite then lands with nothing to correct
			// and the gauge must still price the live history it is about to send,
			// not report an empty conversation.
			const { toolResultId } = seedToolTurn(90_000);
			hookAnswer = () => prunedToolResult(toolResultId);
			mockNativeSummary();

			await triggerThreshold(190_000);

			const aborted = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "" }],
				api: "anthropic-messages" as const,
				provider: "anthropic" as const,
				model: "claude-sonnet-4-5",
				stopReason: "aborted" as const,
				usage: undefined,
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: aborted });
			await session.waitForIdle();

			const breakdown = session.getContextBreakdown();
			expect(breakdown).toBeDefined();
			expect(session.agent.state.messages.length).toBeGreaterThan(0);
			// Unanchored is fine; reporting the conversation as weightless is not.
			expect(breakdown && breakdown.messagesTokens).toBeGreaterThan(0);
		});

		it("runs the configured method natively when the rewrite stops short of the band", async () => {
			const { toolResultId, userId } = seedToolTurn(20_000);
			hookAnswer = () => prunedToolResult(toolResultId);
			const nativeSummary = mockNativeSummary();

			await triggerThreshold(190_000);

			// One consultation per round: the fallback re-entry runs natively.
			expect(hookCalls.length).toBe(1);
			expect(nativeSummary).toHaveBeenCalledTimes(1);
			// The single consultation saw the original body; the rewrite lands
			// before the native pass re-reads the branch.
			const sight = hookCalls[0].branchEntries.find(entry => entry.id === toolResultId);
			expect(sight?.type === "message" && toolResultText(sight.message)).not.toBe(PLACEHOLDER);

			expect(lifecycle().map(event => [event.type, event.action])).toEqual([
				["auto_compaction_start", "context-full"],
				["auto_compaction_end", "rewrite"],
				["auto_compaction_start", "context-full"],
				["auto_compaction_end", "context-full"],
			]);
			const partial = lifecycle()[1];
			expect(partial.type === "auto_compaction_end" && partial.skipped).toBeFalsy();
			expect(partial.type === "auto_compaction_end" && partial.errorMessage).toContain("still above the threshold");
			const committed = lifecycle()[3];
			expect(committed.type === "auto_compaction_end" && committed.result?.summary).toBe("native summary");

			expect(compactionEntries().length).toBe(1);
			expect(toolResultText(entryMessage(toolResultId))).toBe(PLACEHOLDER);
			expect(entryMessage(userId).role).toBe("user");
		});

		it("commits a compaction answer on top of the rewrite in the same result", async () => {
			const { toolResultId } = seedToolTurn(20_000);
			hookAnswer = call => ({
				...prunedToolResult(toolResultId),
				compaction: extensionCompaction(call.preparation),
			});
			const nativeSummary = mockNativeSummary();

			await triggerThreshold(190_000);

			expect(hookCalls.length).toBe(1);
			expect(nativeSummary).not.toHaveBeenCalled();
			expect(toolResultText(entryMessage(toolResultId))).toBe(PLACEHOLDER);
			expect(compactionEntries().length).toBe(1);
			expect(lifecycle().map(event => [event.type, event.action])).toEqual([
				["auto_compaction_start", "context-full"],
				["auto_compaction_end", "context-full"],
			]);
			const end = lifecycle()[1];
			expect(end.type === "auto_compaction_end" && end.result?.summary).toBe("extension summary");
		});

		it("treats a rewrite nothing applies as no answer and runs the configured method", async () => {
			const { toolResultId, userId } = seedToolTurn(20_000);
			const originalUser = entryMessage(userId);
			hookAnswer = () => {
				const asAssistant: AgentMessage = {
					role: "assistant",
					content: [{ type: "text", text: "rewritten" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "stop",
					usage: usage(1),
					timestamp: 5,
				};
				return {
					rewrite: [
						{ entryId: userId, message: asAssistant },
						{ entryId: "not-on-this-branch", message: prunedToolResultMessage(toolResultId) },
					],
				};
			};
			const nativeSummary = mockNativeSummary();

			await triggerThreshold(190_000);

			expect(entryMessage(userId)).toEqual(originalUser);
			expect(toolResultText(entryMessage(toolResultId))).not.toBe(PLACEHOLDER);
			expect(hookCalls.length).toBe(1);
			expect(nativeSummary).toHaveBeenCalledTimes(1);
			expect(compactionEntries().length).toBe(1);
			// No "rewrite" end event at all: nothing was applied.
			expect(lifecycle().map(event => [event.type, event.action])).toEqual([
				["auto_compaction_start", "context-full"],
				["auto_compaction_end", "context-full"],
			]);
		});

		it("honors cancel over a rewrite in the same result", async () => {
			const { toolResultId } = seedToolTurn(20_000);
			hookAnswer = () => ({ ...prunedToolResult(toolResultId), cancel: true });

			await triggerThreshold(190_000);

			expect(hookCalls.length).toBe(1);
			expect(toolResultText(entryMessage(toolResultId))).not.toBe(PLACEHOLDER);
			expect(compactionEntries()).toEqual([]);
			const end = lifecycle()[1];
			expect(end.type === "auto_compaction_end" && end.aborted).toBe(true);
		});
	});

	describe("manual compaction", () => {
		it("resolves undefined when the rewrite alone answers the request", async () => {
			const { toolResultId } = seedToolTurn(20_000);
			hookAnswer = () => prunedToolResult(toolResultId);
			const nativeSummary = mockNativeSummary();

			const result = await session.compact();

			expect(result).toBeUndefined();
			expect(hookCalls.length).toBe(1);
			expect(nativeSummary).not.toHaveBeenCalled();
			expect(toolResultText(entryMessage(toolResultId))).toBe(PLACEHOLDER);
			expect(compactionEntries()).toEqual([]);
		});

		it("commits the handler's compaction on top of the applied rewrite", async () => {
			const { toolResultId } = seedToolTurn(20_000);
			hookAnswer = call => ({
				...prunedToolResult(toolResultId),
				compaction: extensionCompaction(call.preparation),
			});
			const nativeSummary = mockNativeSummary();

			const result = await session.compact();
			if (!result) throw new Error("expected a compaction result");

			expect(result.summary).toBe("extension summary");
			expect(hookCalls.length).toBe(1);
			expect(nativeSummary).not.toHaveBeenCalled();
			expect(toolResultText(entryMessage(toolResultId))).toBe(PLACEHOLDER);
			expect(compactionEntries().length).toBe(1);
		});

		it("runs the requested method when the rewrite applies nothing", async () => {
			const { toolResultId } = seedToolTurn(20_000);
			hookAnswer = () => ({
				rewrite: [{ entryId: "not-on-this-branch", message: prunedToolResultMessage(toolResultId) }],
			});
			const nativeSummary = mockNativeSummary();

			const result = await session.compact();
			if (!result) throw new Error("expected a compaction result");

			expect(result.summary).toBe("native summary");
			expect(hookCalls.length).toBe(1);
			expect(nativeSummary).toHaveBeenCalledTimes(1);
			expect(toolResultText(entryMessage(toolResultId))).not.toBe(PLACEHOLDER);
			expect(compactionEntries().length).toBe(1);
		});
	});
});
