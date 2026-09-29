import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { nothingToWaitForResult } from "@oh-my-pi/pi-coding-agent/async/job-control";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { sessionToolRefs } from "@oh-my-pi/pi-coding-agent/harness/effective-profile";
import { harnessFacadeSpecs } from "@oh-my-pi/pi-coding-agent/harness/facades";
import { harnessToolRefs } from "@oh-my-pi/pi-coding-agent/harness/manifest";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { composeSpawnAdvisory } from "@oh-my-pi/pi-coding-agent/task";
import { formatTaskResultSummary } from "@oh-my-pi/pi-coding-agent/task/result-summary";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { prompt } from "@oh-my-pi/pi-utils";
import ircIncomingTemplate from "../src/prompts/system/irc-incoming.md" with { type: "text" };
import skillfulNoticeTemplate from "../src/prompts/system/skillful-notice.md" with { type: "text" };
import subagentAsyncPendingTemplate from "../src/prompts/system/subagent-async-pending.md" with { type: "text" };
import subagentSystemPromptTemplate from "../src/prompts/system/subagent-system-prompt.md" with { type: "text" };
import subagentYieldReminderTemplate from "../src/prompts/system/subagent-yield-reminder.md" with { type: "text" };
import taskAsyncContractTemplate from "../src/prompts/tools/task-async-contract.md" with { type: "text" };
import taskFollowUpTemplate from "../src/prompts/tools/task-follow-up.md" with { type: "text" };
import { withHarnessCacheDir } from "./helpers/harness";

const NATIVE = harnessToolRefs(undefined);
const CLAUDE_CODE = harnessToolRefs("claude-code");
const CLAUDE_CODE_MODEL = getBundledModel<"anthropic-messages">("anthropic", "claude-opus-5");
const PARENT = "RefsParent";
const CHILD = "RefsChild";

/** omp primitives a Claude Code surface never names: its agents reach them through the facades. */
const OMP_PHRASES = ["write agent://", "`write`", "read proc://", "proc://<id>/kill", "`wait`", "`edit`", "`bash`"];

function leaks(text: string): string[] {
	return OMP_PHRASES.filter(phrase => text.includes(phrase));
}

afterEach(() => {
	AgentRegistry.global().unregister(CHILD);
	AgentRegistry.global().unregister(PARENT);
});

describe("harnessToolRefs", () => {
	it("keeps omp's literal names outside claude-code", () => {
		expect(NATIVE).toEqual({ task: "task", read: "read", write: "write", edit: "edit", bash: "bash", wait: "wait" });
		expect(harnessToolRefs("codex")).toBe(NATIVE);
		expect(harnessToolRefs("pi")).toBe(NATIVE);
	});

	it("names Claude Code's tools and withholds wait", () => {
		expect(CLAUDE_CODE).toMatchObject({ task: "Agent", read: "Read", write: "Write", edit: "Edit", bash: "Bash" });
		expect(CLAUDE_CODE.wait).toBeUndefined();
		// Every facade key names a real claude-code facade.
		const facades = new Set(harnessFacadeSpecs("claude-code").map(spec => spec.wireName));
		for (const key of ["Agent", "SendMessage", "TaskStop", "ListAgents", "Skill"]) {
			expect(CLAUDE_CODE[key]).toBe(key);
			expect(facades.has(key)).toBe(true);
		}
	});

	it("follows the session's effective profile", () => {
		const session = (mode: string) => ({
			settings: Settings.isolated({ "harness.mode": mode }),
			getActiveModel: () => CLAUDE_CODE_MODEL,
		});
		expect(sessionToolRefs(session("claude-code"))).toBe(CLAUDE_CODE);
		expect(sessionToolRefs(session("native"))).toBe(NATIVE);
	});
});

describe("multi-agent templates under claude-code", () => {
	const data = {
		ircEnabled: true,
		waitTool: true,
		aborted: false,
		isolated: false,
		resumable: true,
		transcriptAvailable: true,
		agentId: "ScanRepo",
		from: "Main",
		message: "status?",
		relayOnStop: true,
		interrupting: false,
		count: 2,
		multiple: true,
		jobs: "bg_1 (build), bg_2 (lint)",
		retryCount: 1,
		maxRetries: 3,
		budgetStop: false,
		agent: "ROLE",
		ircSelfId: "Worker",
		ircPeers: [{ id: "Peer", displayName: "task", kind: "sub", status: "running" }],
	};

	it("name the facades instead of omp's primitives", () => {
		const rendered = {
			contract: prompt.render(taskAsyncContractTemplate, { ...data, toolRefs: CLAUDE_CODE }),
			followUp: prompt.render(taskFollowUpTemplate, { ...data, toolRefs: CLAUDE_CODE }),
			incoming: prompt.render(ircIncomingTemplate, { ...data, toolRefs: CLAUDE_CODE }),
			pending: prompt.render(subagentAsyncPendingTemplate, { ...data, toolRefs: CLAUDE_CODE }),
			reminder: prompt.render(subagentYieldReminderTemplate, { ...data, toolRefs: CLAUDE_CODE }),
			system: prompt.render(subagentSystemPromptTemplate, { ...data, toolRefs: CLAUDE_CODE }),
		};
		for (const [name, text] of Object.entries(rendered)) {
			expect({ name, leaks: leaks(text) }).toEqual({ name, leaks: [] });
		}
		expect(rendered.contract).toContain('`SendMessage` (`to: "<id>"`');
		expect(rendered.contract).toContain('`TaskStop` (`task_id: "<id>"`) cancels/stops.');
		expect(rendered.contract).toContain("`Read proc://` lists jobs/services");
		expect(rendered.followUp).toContain('message it via `SendMessage` (`to: "ScanRepo"`) to follow up');
		expect(rendered.incoming).toContain('reply via `SendMessage` (`to: "Main"`, `message: "…"`)');
		expect(rendered.pending).toContain("Call `TaskStop` with its id to cancel; re-yield.");
		expect(rendered.reminder).toContain("(Edit, Write, Bash, search, etc.)");
		expect(rendered.system).toContain('Message peers via `SendMessage` with `to: "<id>"` and `message`');
		const skills = [{ name: "deploy", description: "Ship it" }];
		expect(prompt.render(skillfulNoticeTemplate, { skills, toolRefs: CLAUDE_CODE })).toContain(
			"you MUST load it with `Skill` before proceeding.",
		);
		expect(prompt.render(skillfulNoticeTemplate, { skills, toolRefs: NATIVE })).toContain(
			"you MUST read `skill://<name>` before proceeding.",
		);
	});

	it("render the native text unchanged", () => {
		expect(prompt.render(taskFollowUpTemplate, { ...data, toolRefs: NATIVE })).toBe(
			"ScanRepo is now idle — message it via `write agent://ScanRepo` to follow up; transcript at history://ScanRepo",
		);
		expect(prompt.render(subagentAsyncPendingTemplate, { ...data, toolRefs: NATIVE })).toContain(
			"Write `proc://<id>/kill` without `content` to cancel; re-yield.",
		);
		expect(prompt.render(ircIncomingTemplate, { ...data, toolRefs: NATIVE })).toContain(
			'reply via `write` (`path: "agent://Main"`, `content: "…"`), when available',
		);
		const contract = prompt.render(taskAsyncContractTemplate, { ...data, toolRefs: NATIVE });
		expect(contract).toContain("Completely blocked? Call `wait` to receive the first settled job or peer message.");
		expect(contract).toContain("`write proc://<id>/kill` cancels/stops; omit `content`.");
	});

	it("advise in the Agent tool's vocabulary", () => {
		const args = {
			agents: ["task", "task"],
			items: [{ task: "a" }, { task: "b" }],
			depthCapacity: true,
			ircEnabled: true,
			willRunAsync: true,
			scoutAvailable: true,
		};
		const claudeCode = composeSpawnAdvisory({ ...args, toolRefs: CLAUDE_CODE }) ?? "";
		expect(leaks(claudeCode)).toEqual([]);
		expect(claudeCode).toContain('`subagent_type: "scout"`');
		expect(claudeCode).toContain('`SendMessage` (`to: "all"` broadcasts)');
		const native = composeSpawnAdvisory(args) ?? "";
		expect(native).toContain('`agent: "scout"`');
		expect(native).toContain("`write agent://<id>` (`agent://all` broadcasts)");
		expect(composeSpawnAdvisory({ ...args, toolRefs: NATIVE })).toBe(native);
	});

	it("tells a parent to resume a stopped agent through SendMessage", () => {
		AgentRegistry.global().register({ id: CHILD, displayName: CHILD, kind: "sub", session: null, status: "idle" });
		const result: SingleResult = {
			index: 0,
			id: CHILD,
			agent: "task",
			agentSource: "bundled",
			task: "t",
			assignment: "a",
			exitCode: 0,
			output: "partial",
			stderr: "",
			truncated: false,
			durationMs: 5,
			tokens: 0,
			requests: 1,
			aborted: true,
			abortReason: "budget",
		};
		const claudeCode = formatTaskResultSummary(result, { totalDurationMs: 5, toolRefs: CLAUDE_CODE });
		expect(claudeCode).toContain(`message it via \`SendMessage\` (\`to: "${CHILD}"\`) to resume`);
		expect(formatTaskResultSummary(result, { totalDurationMs: 5 })).toContain(`\`write agent://${CHILD}\``);
	});

	it("keeps job-control guidance on the facades", () => {
		AgentRegistry.global().register({
			id: CHILD,
			displayName: CHILD,
			kind: "sub",
			session: null,
			status: "running",
			parentId: PARENT,
		});
		const session = (mode: string) =>
			({
				cwd: process.cwd(),
				hasUI: false,
				settings: Settings.isolated({ "harness.mode": mode }),
				getActiveModel: () => CLAUDE_CODE_MODEL,
				getAgentId: () => PARENT,
				getSessionFile: () => null,
				agentRegistry: AgentRegistry.global(),
			}) as unknown as ToolSession;
		const textOf = (mode: string) => {
			const part = nothingToWaitForResult(session(mode)).content[0];
			return part?.type === "text" ? part.text : "";
		};
		const claudeCode = textOf("claude-code");
		expect(claudeCode).toContain(CHILD);
		expect(leaks(claudeCode)).toEqual([]);
		expect(claudeCode).toContain('message them via `SendMessage` (`to: "<id>"`)');
		const native = textOf("native");
		expect(native).toContain("message them via `write agent://<id>`");
	});
});

describe("claude-code tool surface", () => {
	withHarnessCacheDir("omp-claude-code-surface-");
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	function stubTool(name: string): AgentTool {
		return {
			name,
			label: name,
			description: name,
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text", text: name }] };
			},
		};
	}

	async function presentedNames(mode: string): Promise<string[]> {
		const tools = ["read", "write", "wait", "task", "eval", "todo"].map(stubTool);
		const session = new AgentSession({
			agent: new Agent({ initialState: { model: CLAUDE_CODE_MODEL, systemPrompt: [], tools } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "harness.mode": mode }),
			modelRegistry: {
				getApiKey: async () => "test-key",
				hasConfiguredAuth: () => true,
				refreshSelectedModelMetadata: async (value: Model) => value,
				clearSuppressedSelector: () => undefined,
			} as never,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
			builtInToolNames: tools.map(tool => tool.name),
			rebuildSystemPrompt: async names => ({ systemPrompt: [`tools:${names.join(",")}`] }),
		});
		sessions.push(session);
		await session.setActiveToolsByName(tools.map(tool => tool.name));
		return session.agent.state.tools.map(tool => tool.name);
	}

	it("withholds wait only under claude-code, where no capture declares TaskOutput", async () => {
		const claudeCode = await presentedNames("claude-code");
		expect(claudeCode).not.toContain("wait");
		expect(claudeCode).not.toContain("TaskOutput");
		expect(claudeCode).toEqual(
			expect.arrayContaining(["Agent", "SendMessage", "TaskStop", "ListAgents", "WebFetch", "Skill", "eval", "todo"]),
		);

		const native = await presentedNames("native");
		expect(native).toContain("wait");
		expect(native).not.toContain("SendMessage");
	});
});
