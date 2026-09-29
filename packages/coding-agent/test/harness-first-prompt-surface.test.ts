import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { HARNESS_CAPTURE_SCHEMA } from "@oh-my-pi/pi-coding-agent/harness/capture";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { withHarnessCacheDir } from "./helpers/harness";

const LEAD = getBundledModel<"anthropic-messages">("anthropic", "claude-opus-5");
const SIDEKICK = getBundledModel<"anthropic-messages">("anthropic", "claude-haiku-4-5");

describe("claude-code first prompt surface", () => {
	const dirs = withHarnessCacheDir("omp-harness-first-prompt-");
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = path.join(os.tmpdir(), `omp-harness-first-prompt-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(tempDir);
	});

	/** A 2.1.269-like capture: it still declares TaskOutput, which then stands in for `wait`. */
	function writeCapture(): void {
		const capture = {
			schema: HARNESS_CAPTURE_SCHEMA,
			profile: "claude-code",
			clientVersion: "2.1.269",
			entrypoint: "cli",
			capturedAt: "2026-09-09T10:00:00.000Z",
			instructions: ["You are Claude Code.\n\n# Tone\n\nTerse."],
			tools: ["Bash", "Read", "TaskOutput"],
			declarations: [
				{ name: "Read", description: "Reads a file from the local filesystem." },
				{ name: "TaskOutput", description: "Retrieves output from a running or completed task." },
			],
		};
		const dir = path.join(dirs.cache, "claude-code");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "2.1.269-cli.json"), JSON.stringify(capture));
	}

	it("builds the first prompt with the served capture loaded, so a rebuild reproduces it", async () => {
		// A fresh process: the capture cache is empty until something loads it.
		writeCapture();
		const workDir = path.join(tempDir, `work-${Snowflake.next()}`);
		fs.mkdirSync(workDir, { recursive: true });
		const { session } = await createAgentSession({
			cwd: workDir,
			agentDir: workDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"harness.mode": "claude-code",
				"fusion.enabled": true,
				"fusion.sidekickModel": `${SIDEKICK.provider}/${SIDEKICK.id}`,
			}),
			model: LEAD,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: workDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		try {
			const first = session.systemPrompt.join("\n\n");
			await session.refreshBaseSystemPrompt();
			expect(session.systemPrompt.join("\n\n")).toBe(first);
			// That stable prompt matches the tools on the wire: the Fusion lead
			// section names TaskOutput, which this capture declares.
			expect(first).toContain("wait for the report with `TaskOutput`");
			expect(first).not.toContain("the report arrives as a notification");
			expect(session.getToolRefs().wait).toBe("TaskOutput");
			expect(session.agent.state.tools.map(tool => tool.name)).toContain("TaskOutput");
		} finally {
			await session.dispose();
		}
	});
});
