/**
 * A session restricted to an OAuth account pool must stay in it on every path
 * that resolves a credential for it, not only the model registry's key lookups:
 * tools that read raw `authStorage` under their own session ids (an advisor's
 * hosted search), a dedicated search key, advisor fallback walks, and a
 * registry lookup that must not touch the session's pin.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { CODEX_BASE_URL } from "@oh-my-pi/pi-catalog/wire/codex";
import { type OAuthAccountPools, SessionAccountPoolScope } from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BUILTIN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { searchAnthropic } from "@oh-my-pi/pi-coding-agent/web/search/providers/anthropic";
import { searchCodex } from "@oh-my-pi/pi-coding-agent/web/search/providers/codex";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

function trackStorage(): AuthStorage {
	const authStorage = createInMemoryAuthStorage();
	cleanups.push(() => authStorage.close());
	return authStorage;
}

/** A fetch that records every request and answers none of them usefully. */
function recordingFetch(): { fetch: typeof fetch; urls: string[] } {
	const urls: string[] = [];
	const fetchImpl = Object.assign(
		async (input: string | URL | Request): Promise<Response> => {
			urls.push(input instanceof Request ? input.url : input.toString());
			return new Response(null, { status: 500 });
		},
		{ preconnect: fetch.preconnect },
	);
	return { fetch: fetchImpl, urls };
}

describe("tool sessions of a pooled session", () => {
	const codexModel = buildModel({
		id: "pooled-codex-grounding",
		name: "Pooled Codex Grounding",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: CODEX_BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 16_384,
	});

	/** Auth storage with one Codex account that no pool below admits. */
	async function storageWithExcludedCodexAccount(): Promise<AuthStorage> {
		const authStorage = trackStorage();
		await authStorage.credentials.set("openai-codex", {
			type: "oauth",
			access: "access-excluded",
			refresh: "refresh-excluded",
			expires: Date.now() + 60 * 60_000,
			accountId: "acct-excluded",
			email: "excluded@example.com",
		});
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		return authStorage;
	}

	/** Start a session and return the tool sessions its primary and its advisor build. */
	async function startSessionToolSessions(
		authStorage: AuthStorage,
		options: { modelRegistry: ModelRegistry; providerSessionId: string; oauthAccountPools?: OAuthAccountPools },
	): Promise<ToolSession[]> {
		const tempDir = TempDir.createSync("@pi-auth-session-scope-tools-");
		cleanups.push(() => tempDir.removeSync());
		const toolSessions: ToolSession[] = [];
		const webSearch = BUILTIN_TOOLS.web_search;
		const spy = vi.spyOn(BUILTIN_TOOLS, "web_search").mockImplementation(session => {
			toolSessions.push(session);
			return webSearch(session);
		});
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5");
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			settings: Settings.isolated({ "async.enabled": false, "compaction.enabled": false }),
			model,
			toolNames: ["web_search"],
			disableExtensionDiscovery: true,
			...options,
		});
		cleanups.push(() => session.dispose());
		spy.mockRestore();
		const advisorSession = toolSessions.find(candidate => candidate.getAgentId?.() === "advisor");
		const primarySession = toolSessions.find(candidate => candidate !== advisorSession);
		if (!advisorSession || !primarySession) throw new Error("Expected the primary's and the advisor's tool sessions");
		return [primarySession, advisorSession];
	}

	/** Run Codex hosted search from each tool session with the inputs WebSearchTool hands every provider. */
	async function expectNoCodexSearchRequest(toolSessions: readonly ToolSession[]): Promise<void> {
		for (const toolSession of toolSessions) {
			const { fetch: fetchImpl, urls } = recordingFetch();
			const authStorageForTool = toolSession.authStorage;
			const modelRegistryForTool = toolSession.modelRegistry;
			if (!authStorageForTool || !modelRegistryForTool) throw new Error("Expected tool auth surfaces");
			await expect(
				searchCodex({
					query: "pooled search",
					systemPrompt: "Use web search.",
					authStorage: authStorageForTool,
					modelRegistry: modelRegistryForTool,
					model: codexModel,
					sessionId: toolSession.getSessionId?.() ?? undefined,
					fetch: fetchImpl,
				}),
			).rejects.toThrow();
			expect(urls).toEqual([]);
		}
	}

	it("sends no hosted search request from the primary's or the advisor's tools with an empty pool", async () => {
		const authStorage = await storageWithExcludedCodexAccount();
		const toolSessions = await startSessionToolSessions(authStorage, {
			modelRegistry: new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true }),
			providerSessionId: "pooled-provider-session",
			oauthAccountPools: { "openai-codex": [] },
		});
		await expectNoCodexSearchRequest(toolSessions);
	});

	it("keeps a nested agent without pools of its own inside the pools of the registry it inherits", async () => {
		const authStorage = await storageWithExcludedCodexAccount();
		// The parent's pool-scoped registry, as a parent hands it to a subagent with no pool entry.
		const parentScope = new SessionAccountPoolScope(authStorage, { "openai-codex": [] }, "parent-provider-session");
		cleanups.push(() => parentScope.release());
		const toolSessions = await startSessionToolSessions(authStorage, {
			modelRegistry: parentScope.registry(
				new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true }),
			),
			providerSessionId: "child-provider-session",
		});
		await expectNoCodexSearchRequest(toolSessions);
		// A lookup without an id resolves under the child's own id, not the parent's.
		const childRegistry = toolSessions[0]?.modelRegistry;
		if (!childRegistry) throw new Error("Expected the child's registry");
		expect(SessionAccountPoolScope.credentialSessionId(childRegistry, "openai-codex", undefined)).toBe(
			"child-provider-session",
		);
	});
});

describe("Anthropic hosted search for a pooled session", () => {
	it("never sends the dedicated search key for a session whose Anthropic pool is empty, named or not", async () => {
		const authStorage = trackStorage();
		const previousKey = Bun.env.ANTHROPIC_SEARCH_API_KEY;
		Bun.env.ANTHROPIC_SEARCH_API_KEY = "sk-ant-api03-dedicated-search-key";
		cleanups.push(() => {
			if (previousKey === undefined) delete Bun.env.ANTHROPIC_SEARCH_API_KEY;
			else Bun.env.ANTHROPIC_SEARCH_API_KEY = previousKey;
		});
		const scope = new SessionAccountPoolScope(authStorage, { anthropic: [] }, "pooled");
		cleanups.push(() => scope.release());
		const modelRegistry = scope.registry(new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true }));
		const model = buildModel({
			id: "claude-haiku-4-5",
			name: "Claude Haiku 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://anthropic-grounding.example.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 16_384,
		});

		// Without a session id the scoped registry resolves under the scope's primary id.
		for (const sessionId of ["pooled", undefined]) {
			const { fetch: fetchImpl, urls } = recordingFetch();
			await expect(
				searchAnthropic({
					query: "pooled search",
					systemPrompt: "Use web search.",
					authStorage,
					modelRegistry,
					model,
					sessionId,
					fetch: fetchImpl,
				}),
			).rejects.toThrow('Anthropic credentials not found for selected provider "anthropic".');
			expect(urls).toEqual([]);
		}
	});
});

describe("advisor fallback for a pooled session", () => {
	it("walks past a fallback model whose provider the pool excludes to the next one", async () => {
		const tempDir = TempDir.createSync("@pi-auth-session-scope-advisor-");
		cleanups.push(() => tempDir.removeSync());
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const excluded = getBundledModel("openai", "gpt-4o-mini");
		const permitted = getBundledModel("anthropic", "claude-opus-4-5");
		if (!primaryModel || !excluded || !permitted) throw new Error("Expected the bundled advisor chain models");
		const authStorage = trackStorage();
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		// The pool leaves openai no account; its runtime key never serves a pooled session.
		authStorage.keys.setRuntime("openai", "openai-test-key");
		const scope = new SessionAccountPoolScope(authStorage, { openai: [] }, "pooled-provider-session");
		cleanups.push(() => scope.release());
		const modelRegistry = scope.registry(new ModelRegistry(authStorage, tempDir.join("models.yml")));

		const unavailable = createMockModel({
			handler: () => ({ stopReason: "error", errorMessage: "503 Service Unavailable: upstream connect error" }),
		});
		const backup = createMockModel({ handler: () => ({ content: [], stopReason: "stop" }) });
		const advisorStreamFn = (
			model: Model<Api>,
			context: Context,
			options?: SimpleStreamOptions,
		): AssistantMessageEventStream =>
			model.id === permitted.id
				? backup.stream(model, context, options)
				: unavailable.stream(model, context, options);
		const primary = createMockModel({ responses: [{ content: ["primary answer"], stopReason: "stop" }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [] },
			streamFn: primary.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.fallbackChains": {
				advisor: [`${excluded.provider}/${excluded.id}`, `${permitted.provider}/${permitted.id}`],
			},
		});
		settings.setModelRole("advisor", `${primaryModel.provider}/${primaryModel.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			accountPoolScope: scope,
			advisorTools: [],
			advisorStreamFn,
		});
		cleanups.push(() => session.dispose());
		expect(session.setAdvisorEnabled(true)).toBe(true);

		session.prepareForHeadlessAdvisorDrain();
		await session.prompt("answer in one line");
		expect(await session.waitForAdvisorCatchup(10_000, { waitThroughRecovery: true })).toBe(true);
		expect(unavailable.calls.length).toBeGreaterThanOrEqual(1);
		expect(backup.calls).toHaveLength(1);
	}, 20_000);
});

describe("ModelRegistry lookups that do not record affinity", () => {
	const PROVIDER = "unit-registry-record-affinity";

	it("leave a session's pin and its last use untouched", async () => {
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		const authStorage = trackStorage();
		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "access-a", refresh: "refresh-a", expires: Date.now() + 60 * 60_000, accountId: "a" },
			{ type: "oauth", access: "access-b", refresh: "refresh-b", expires: Date.now() + 60 * 60_000, accountId: "b" },
		]);
		const registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		const active = (sessionId: string) =>
			authStorage.oauth.accounts(PROVIDER, sessionId).find(account => account.active);

		expect(
			(await registry.getApiKeyWithCredentialForProvider(PROVIDER, "probe", { recordAffinity: false }))?.apiKey,
		).toBeDefined();
		expect(active("probe")).toBeUndefined();

		const startMs = Date.now();
		let nowMs = startMs;
		vi.spyOn(Date, "now").mockImplementation(() => nowMs);
		await registry.getApiKeyWithCredentialForProvider(PROVIDER, "warm");
		const pinned = active("warm");
		expect(pinned?.lastUsedAtMs).toBe(startMs);
		nowMs = startMs + 120_000;
		await registry.getApiKeyWithCredentialForProvider(PROVIDER, "warm", { recordAffinity: false });
		expect(active("warm")).toMatchObject({ credentialId: pinned?.credentialId, lastUsedAtMs: startMs });
	});
});
