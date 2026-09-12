import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type Model } from "@oh-my-pi/pi-ai";
import { resolveHarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EVAL_AGENT_BRIDGE_NAME } from "@oh-my-pi/pi-coding-agent/eval/agent-bridge";
import { EVAL_BUDGET_BRIDGE_NAME } from "@oh-my-pi/pi-coding-agent/eval/budget-bridge";
import { EVAL_COMPLETION_BRIDGE_NAME } from "@oh-my-pi/pi-coding-agent/eval/completion-bridge";
import {
	EVAL_CANCEL_BRIDGE_NAME,
	EVAL_STATUS_BRIDGE_NAME,
	EVAL_WAIT_BRIDGE_NAME,
} from "@oh-my-pi/pi-coding-agent/eval/handle-bridge";
import { EVAL_WORKPOOL_BRIDGE_NAME } from "@oh-my-pi/pi-coding-agent/eval/workpool-bridge";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { ToolNamespacesInfo } from "@oh-my-pi/pi-coding-agent/session/code-mode";
import { resolveCodeMode } from "@oh-my-pi/pi-coding-agent/session/code-mode";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { withHarnessCacheDir } from "../helpers/harness";

function required(model: Model | undefined, what: string): Model {
	if (!model) throw new Error(`Expected ${what}`);
	return model;
}

const FABLE = required(getBundledModel("anthropic", "claude-fable-5-1"), "bundled anthropic/claude-fable-5-1");
const ASTRA = required(getBundledModel("openai-codex", "gpt-6-astra"), "bundled openai-codex/gpt-6-astra");

const ORCHESTRATION_BRIDGE_TOOLS = [
	EVAL_AGENT_BRIDGE_NAME,
	EVAL_WORKPOOL_BRIDGE_NAME,
	EVAL_COMPLETION_BRIDGE_NAME,
	EVAL_BUDGET_BRIDGE_NAME,
	EVAL_WAIT_BRIDGE_NAME,
	EVAL_STATUS_BRIDGE_NAME,
	EVAL_CANCEL_BRIDGE_NAME,
];

describe("subagent harness surface", () => {
	withHarnessCacheDir("omp-subagent-harness-");
	const disposables: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const dispose of disposables.splice(0)) await dispose();
	});

	it("gives concurrent subagents on different profiles different direct tool surfaces", async () => {
		const registryDir = path.join(os.tmpdir(), `pi-subagent-harness-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		const authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(registryDir, "models.yml"));
		disposables.push(async () => {
			authStorage.close();
			removeSyncWithRetries(registryDir);
		});
		const build = async (agentId: string, model: Model) => {
			const { session } = await sdkModule.createAgentSession({
				cwd: registryDir,
				agentDir: registryDir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "providers.openai-codex.codeMode": "auto" }),
				model,
				agentId,
				agentName: "task",
				taskDepth: 1,
				hasUI: false,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			disposables.push(async () => {
				await session.dispose().catch(() => {});
			});
			return session;
		};

		const [claudeCode, codex] = await Promise.all([build("surface-fable", FABLE), build("surface-astra", ASTRA)]);

		expect(codex.getActiveToolNames()).toEqual(expect.arrayContaining(["eval", "task", "hub"]));
		expect(codex.getActiveToolNames()).not.toContain("read");
		expect(codex.getEnabledToolNames()).toContain("read");
		expect(codex.getToolForEvalBridge("read")?.name).toBe("read");
		expect(claudeCode.getActiveToolNames()).toContain("read");
		expect(claudeCode.codeModeNamespacesInfo).toBeUndefined();
		const codexNamespaces = codex.codeModeNamespacesInfo as ToolNamespacesInfo;
		expect(codexNamespaces.functions.functions.read.direct).toBe(false);
	});

	it("keeps the subagent orchestration protocol direct under an active harness profile", () => {
		const enabled = ["eval", "task", "hub", "read", ...ORCHESTRATION_BRIDGE_TOOLS];
		const direct = resolveCodeMode({
			provider: ASTRA.provider,
			toolMode: ASTRA.toolMode,
			setting: "auto",
			enabledToolNames: enabled,
			evalTransportAvailable: true,
		});

		expect(direct.active).toBe(true);
		expect([...direct.directToolNames].sort()).toEqual(["eval", ...ORCHESTRATION_BRIDGE_TOOLS].sort());
	});
});
