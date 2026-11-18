/**
 * A session restricted to an OAuth account pool gets `MissingApiKeyError`, not
 * `undefined`, for a provider its pool cannot serve. Context maintenance walks
 * candidate models (the promotion target, the compaction chain); to those walks
 * a pool-excluded candidate is unavailable, like one without credentials: it is
 * skipped and the walk moves on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { assistantMsg, userMsg } from "./utilities";

const pooled = getBundledModel("anthropic", "claude-sonnet-4-5");
const excluded = getBundledModel("openai", "gpt-4o");
if (!pooled || !excluded) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 and openai/gpt-4o");
const excludedKey = `${excluded.provider}/${excluded.id}`;

describe("context maintenance in a session restricted to an OAuth account pool", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-maintenance-pool-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		tempDir.removeSync();
	});

	/**
	 * A session on `current` (pooled provider) whose `getApiKey` rejects the
	 * excluded provider as a restricted session's key cascade does, with two
	 * finished turns and `compact()` recording each model it summarizes with.
	 */
	async function openSession(current: Model, settings: Record<string, unknown> = {}) {
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime(current.provider, "pooled-token");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([current, excluded]);
		const getApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		const keyRequests: string[] = [];
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation((model, sessionId, options) => {
			keyRequests.push(`${model.provider}/${model.id}`);
			if (model.provider !== excluded.provider) return getApiKey(model, sessionId, options);
			return Promise.reject(
				new AIError.MissingApiKeyError(
					model.provider,
					`No API key for provider: ${model.provider} (session ${sessionId} is restricted to its OAuth account pool and none of those accounts is available)`,
				),
			);
		});
		const summarizedWith: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			summarizedWith.push(`${model.provider}/${model.id}`);
			return {
				summary: "pooled summary",
				shortSummary: "pooled",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});
		const opened = new AgentSession({
			agent: new Agent({ initialState: { model: current, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.autoContinue": false,
				"compaction.keepRecentTokens": 1,
				"compaction.methodOrder": ["soft"],
				...settings,
			}),
			modelRegistry,
		});
		session = opened;
		opened.subscribe(() => {});
		for (const [question, answer] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			for (const message of [userMsg(question), assistantMsg(answer)]) {
				opened.agent.appendMessage(message);
				opened.sessionManager.appendMessage(message);
			}
		}
		return { session: opened, keyRequests, summarizedWith };
	}

	/** Ends a turn whose usage fills `model`'s window; resolves with the auto-compaction outcome. */
	async function fillWindow(current: AgentSession, model: Model): Promise<{ errorMessage?: string }> {
		const ended = Promise.withResolvers<{ errorMessage?: string }>();
		current.subscribe(event => {
			if (event.type === "auto_compaction_end") ended.resolve({ errorMessage: event.errorMessage });
		});
		const contextWindow = model.contextWindow;
		if (!contextWindow) throw new Error("Expected a context window");
		const assistant = {
			...assistantMsg("window filled"),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: contextWindow,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: contextWindow + 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		current.agent.emitExternalEvent({ type: "message_end", message: assistant });
		current.agent.emitExternalEvent({ type: "agent_end", messages: [assistant] });
		const outcome = await ended.promise;
		await current.waitForIdle();
		return outcome;
	}

	it("manual compaction skips an excluded configured compaction model for the next candidate", async () => {
		const current: Model = { ...pooled, compactionModel: excludedKey };
		const { session, keyRequests, summarizedWith } = await openSession(current);

		const result = await session.compact();

		expect(keyRequests[0]).toBe(excludedKey);
		expect(summarizedWith).toEqual([`${pooled.provider}/${pooled.id}`]);
		expect(result?.summary).toBe("pooled summary");
	});

	it("auto-compaction skips an excluded configured compaction model for the next candidate", async () => {
		const current: Model = { ...pooled, compactionModel: excludedKey };
		const { session, keyRequests, summarizedWith } = await openSession(current);

		const outcome = await fillWindow(session, current);

		expect(keyRequests).toContain(excludedKey);
		expect(outcome.errorMessage).toBeUndefined();
		expect(summarizedWith).toEqual([`${pooled.provider}/${pooled.id}`]);
	});

	it("an excluded promotion target leaves the model alone and lets compaction run", async () => {
		const current: Model = { ...pooled, contextWindow: 100_000, contextPromotionTarget: excludedKey };
		const { session, keyRequests, summarizedWith } = await openSession(current, {
			"contextPromotion.enabled": true,
		});

		const outcome = await fillWindow(session, current);

		expect(keyRequests).toContain(excludedKey);
		expect(session.model?.provider).toBe(pooled.provider);
		expect(outcome.errorMessage).toBeUndefined();
		expect(summarizedWith).toEqual([`${pooled.provider}/${pooled.id}`]);
	});
});
