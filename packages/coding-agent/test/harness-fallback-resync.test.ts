import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { resolveHarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { HARNESS_CAPTURE_SCHEMA } from "@oh-my-pi/pi-coding-agent/harness/capture";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type BuildSystemPromptResult,
	buildSystemPrompt,
	buildSystemPromptToolMetadata,
} from "@oh-my-pi/pi-coding-agent/system-prompt";
import { TempDir } from "@oh-my-pi/pi-utils";
import { withHarnessCacheDir } from "./helpers/harness";

const FABLE = getBundledModel<"anthropic-messages">("anthropic", "claude-fable-5-1");
const ASTRA = getBundledModel<"openai-codex-responses">("openai-codex", "gpt-6-astra");

const CLAUDE_CODE_TEXT = "You are Claude Code.\n\n# Tone\n\nTerse.";
const CODEX_TEXT = "You are Codex.\n\n# Sandboxing\n\nAsk before writing outside the workspace.";

describe("harness prompt across an automatic fallback", () => {
	const dirs = withHarnessCacheDir("omp-harness-fallback-");
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-harness-fallback-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		authStorage.setRuntimeApiKey("openai-codex", "openai-codex-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		modelRegistry.clearSuppressedSelectors();
		if (session) {
			await session.dispose();
			session = undefined;
		}
	});

	async function writeCapture(profile: "claude-code" | "codex", entrypoint: string, text: string): Promise<void> {
		const capture = {
			schema: HARNESS_CAPTURE_SCHEMA,
			profile,
			clientVersion: "1.0.0",
			entrypoint,
			capturedAt: "2026-09-09T10:00:00.000Z",
			instructions: [text],
			tools: ["exec"],
		};
		await Bun.write(path.join(dirs.cache, profile, `1.0.0-${entrypoint}.json`), JSON.stringify(capture));
	}

	it("serves the fallback model its own harness prompt on the retried request", async () => {
		await writeCapture("claude-code", "cli", CLAUDE_CODE_TEXT);
		await writeCapture("codex", "codex_exec", CODEX_TEXT);

		const leadingBlocks: Array<{ model: string; block: string | undefined }> = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: FABLE, systemPrompt: [], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				const systemPrompt = Array.isArray(context.systemPrompt) ? context.systemPrompt : [context.systemPrompt];
				leadingBlocks.push({ model: `${model.provider}/${model.id}`, block: systemPrompt[0] });
				if (model.provider === FABLE.provider && model.id === FABLE.id) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else {
					mock.push({ content: [`ok:${model.provider}/${model.id}`] });
				}
				return mock.stream(model, context, options);
			},
		});
		const rebuildSystemPrompt = (
			toolNames: string[],
			tools: Map<string, AgentTool>,
		): Promise<BuildSystemPromptResult> =>
			buildSystemPrompt({
				cwd: dirs.root,
				contextFiles: [],
				skills: [],
				rules: [],
				toolNames,
				tools: buildSystemPromptToolMetadata(tools),
				activeRepoContext: null,
				workspaceTree: { rootPath: dirs.root, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				personality: "none",
				harnessProfile: resolveHarnessProfile(agent.state.model),
			});
		agent.setSystemPrompt((await rebuildSystemPrompt([], new Map())).systemPrompt);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": { default: [`${ASTRA.provider}/${ASTRA.id}`] },
		});
		settings.setModelRole("default", `${FABLE.provider}/${FABLE.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			rebuildSystemPrompt,
		});

		await session.prompt("list the repo");
		await session.waitForIdle();

		expect(leadingBlocks).toEqual([
			{ model: `${FABLE.provider}/${FABLE.id}`, block: CLAUDE_CODE_TEXT },
			{ model: `${ASTRA.provider}/${ASTRA.id}`, block: CODEX_TEXT },
		]);
	});
});
