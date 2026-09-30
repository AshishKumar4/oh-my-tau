import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { nothingToWaitForResult } from "@oh-my-pi/pi-coding-agent/async/job-control";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { VendorTool } from "@oh-my-pi/pi-coding-agent/harness/capture";
import { sessionToolRefs } from "@oh-my-pi/pi-coding-agent/harness/effective-profile";
import { harnessSurface } from "@oh-my-pi/pi-coding-agent/harness/facades";
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
import claudeCodeAgentTemplate from "../src/prompts/tools/harness/claude-code-agent.md" with { type: "text" };
import taskAsyncContractTemplate from "../src/prompts/tools/task-async-contract.md" with { type: "text" };
import taskCoordinationAdvisoryTemplate from "../src/prompts/tools/task-coordination-advisory.md" with { type: "text" };
import taskFollowUpTemplate from "../src/prompts/tools/task-follow-up.md" with { type: "text" };
import { withHarnessCacheDir } from "./helpers/harness";

const NATIVE = harnessToolRefs(undefined);
const CLAUDE_CODE_MODEL = getBundledModel<"anthropic-messages">("anthropic", "claude-opus-5");

/** Every omp tool a root Claude Code session enables by default that the facades care about. */
const ROOT_TOOLS = ["read", "write", "edit", "bash", "task", "wait", "eval", "todo"];
const TASK_OUTPUT: VendorTool = { description: "Retrieves output", inputSchema: {} };

/**
 * The claude-code surface over `tools`: `taskOutput` models a pre-2.1.284 capture
 * that still declares TaskOutput; 2.1.284 captures do not.
 */
function claudeCodeSurface(
	tools: readonly string[],
	options: { taskOutput?: boolean; settings?: Settings; taskDepth?: number } = {},
) {
	return harnessSurface("claude-code", tools, {
		settings: options.settings ?? Settings.isolated(),
		...(options.taskDepth !== undefined && { session: { taskDepth: options.taskDepth } as unknown as ToolSession }),
		vendorTool: name => (options.taskOutput && name === "TaskOutput" ? TASK_OUTPUT : undefined),
	});
}

/** A root session serving a 2.1.284 capture: no TaskOutput, so nothing waits on the wire. */
const CLAUDE_CODE = claudeCodeSurface(ROOT_TOOLS).toolRefs;
/** A read-only subagent (scout, reviewer): no `write`, so no messaging or stop facade. */
const READ_ONLY = claudeCodeSurface(["read", "bash"], { taskDepth: 1 }).toolRefs;
/** A root session that cannot spawn: peer messaging is off, so neither SendMessage nor ListAgents mounts. */
const NO_PEERS = claudeCodeSurface(ROOT_TOOLS, {
	settings: Settings.isolated({ "task.maxRecursionDepth": 0 }),
}).toolRefs;

/** Facade names no prose uses: any mention names the tool. */
const FACADE_ONLY_NAMES = ["SendMessage", "TaskStop", "ListAgents", "TaskOutput", "WebFetch"];

/** Facade and tool names a surface must never mention when it did not mount them. */
function unmountedNames(refs: Readonly<Record<string, string>>): string[] {
	const names = ["SendMessage", "TaskStop", "ListAgents", "Skill", "TaskOutput", "WebFetch", "Write", "Edit"];
	return names.filter(name => !Object.values(refs).includes(name));
}
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
		expect(NATIVE).toEqual({
			task: "task",
			read: "read",
			write: "write",
			edit: "edit",
			bash: "bash",
			wait: "wait",
			deviceWrite: "write",
		});
		expect(harnessToolRefs("codex")).toBe(NATIVE);
		expect(harnessToolRefs("pi")).toBe(NATIVE);
		expect(harnessSurface(undefined, ROOT_TOOLS, { settings: Settings.isolated() }).toolRefs).toBe(NATIVE);
	});

	it("names exactly what a 2.1.284 surface presents: no TaskOutput, so no wait", () => {
		const surface = claudeCodeSurface(ROOT_TOOLS);
		expect(surface.toolRefs).toMatchObject({
			task: "Agent",
			read: "Read",
			write: "Write",
			edit: "Edit",
			bash: "Bash",
			Agent: "Agent",
			SendMessage: "SendMessage",
			TaskStop: "TaskStop",
			ListAgents: "ListAgents",
			Skill: "Skill",
			WebFetch: "WebFetch",
		});
		expect(surface.toolRefs.wait).toBeUndefined();
		expect(surface.toolRefs.TaskOutput).toBeUndefined();
		// Withheld with nothing standing in: prompts and predicates drop it.
		expect([...surface.unavailable]).toEqual(["wait"]);
		expect(surface.hidden.has("wait")).toBe(true);
		expect(surface.facades.map(spec => spec.wireName)).not.toContain("TaskOutput");
	});

	it("names TaskOutput for wait where an older capture still declares it", () => {
		const surface = claudeCodeSurface(ROOT_TOOLS, { taskOutput: true });
		expect(surface.toolRefs.wait).toBe("TaskOutput");
		expect(surface.toolRefs.TaskOutput).toBe("TaskOutput");
		expect([...surface.unavailable]).toEqual([]);
		expect(surface.hidden.has("wait")).toBe(true);
	});

	it("mounts SendMessage and ListAgents together, only with write and peer messaging", () => {
		// A read-only subagent has peer messaging but no `write` to message with.
		expect(READ_ONLY).toEqual({ read: "Read", bash: "Bash", Skill: "Skill", WebFetch: "WebFetch" });
		// A root that cannot spawn has `write` but no peers: TaskStop stays, messaging goes.
		expect(NO_PEERS.TaskStop).toBe("TaskStop");
		expect(NO_PEERS.SendMessage).toBeUndefined();
		expect(NO_PEERS.ListAgents).toBeUndefined();
		// Neither mounts without the other: ListAgents lists whom SendMessage reaches.
		const writeOnly = claudeCodeSurface(["write"], { taskDepth: 1 }).toolRefs;
		expect(writeOnly.SendMessage).toBe("SendMessage");
		expect(writeOnly.ListAgents).toBeUndefined();
		const readOnlyChild = claudeCodeSurface(["read"], { taskDepth: 1 }).toolRefs;
		expect(readOnlyChild.ListAgents).toBeUndefined();
	});

	it("reads the session's presented refs, falling back to omp's names", () => {
		expect(sessionToolRefs({ getToolRefs: () => CLAUDE_CODE })).toBe(CLAUDE_CODE);
		expect(sessionToolRefs({})).toBe(NATIVE);
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

	it("never name a facade or tool a narrower surface did not mount", () => {
		for (const [surface, refs] of Object.entries({ READ_ONLY, NO_PEERS })) {
			const rendered = {
				contract: prompt.render(taskAsyncContractTemplate, { ...data, toolRefs: refs }),
				followUp: prompt.render(taskFollowUpTemplate, { ...data, toolRefs: refs }),
				incoming: prompt.render(ircIncomingTemplate, { ...data, toolRefs: refs }),
				incomingIdle: prompt.render(ircIncomingTemplate, { ...data, relayOnStop: false, toolRefs: refs }),
				pending: prompt.render(subagentAsyncPendingTemplate, { ...data, toolRefs: refs }),
				reminder: prompt.render(subagentYieldReminderTemplate, { ...data, toolRefs: refs }),
				system: prompt.render(subagentSystemPromptTemplate, { ...data, toolRefs: refs }),
				coordination: prompt.render(taskCoordinationAdvisoryTemplate, { count: 2, toolRefs: refs }),
				agent: prompt.render(claudeCodeAgentTemplate, {
					agents: [],
					defaultAgent: "task",
					asyncEnabled: true,
					ircEnabled: true,
					toolRefs: refs,
				}),
			};
			for (const [name, text] of Object.entries(rendered)) {
				const named = unmountedNames(refs).filter(
					tool => text.includes(`\`${tool}\``) || (FACADE_ONLY_NAMES.includes(tool) && text.includes(tool)),
				);
				expect({ surface, name, leaks: leaks(text), named }).toEqual({ surface, name, leaks: [], named: [] });
				expect(text).not.toContain("undefined");
			}
		}
		// A subagent that cannot message has no peer section at all.
		const system = prompt.render(subagentSystemPromptTemplate, { ...data, toolRefs: READ_ONLY });
		expect(system).not.toContain("# Peers");
		// With SendMessage mounted the Agent description keeps its continuation line.
		const agent = prompt.render(claudeCodeAgentTemplate, {
			agents: [],
			defaultAgent: "task",
			asyncEnabled: true,
			ircEnabled: true,
			toolRefs: CLAUDE_CODE,
		});
		expect(agent).toContain("- Use SendMessage with the agent's ID to continue a previously spawned agent");
		expect(agent).toContain("- Read `history://<agentId>` for an agent's transcript");
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
		const session = (refs: Readonly<Record<string, string>> | undefined) =>
			({
				cwd: process.cwd(),
				hasUI: false,
				settings: Settings.isolated(),
				getActiveModel: () => CLAUDE_CODE_MODEL,
				getAgentId: () => PARENT,
				getSessionFile: () => null,
				agentRegistry: AgentRegistry.global(),
				...(refs && { getToolRefs: () => refs }),
			}) as unknown as ToolSession;
		const textOf = (refs: Readonly<Record<string, string>> | undefined) => {
			const part = nothingToWaitForResult(session(refs)).content[0];
			return part?.type === "text" ? part.text : "";
		};
		const claudeCode = textOf(CLAUDE_CODE);
		expect(claudeCode).toContain(CHILD);
		expect(leaks(claudeCode)).toEqual([]);
		expect(claudeCode).toContain('message them via `SendMessage` (`to: "<id>"`)');
		// Without write there is no message or stop tool to name, and no wait.
		const readOnly = textOf(READ_ONLY);
		expect(readOnly).toContain(CHILD);
		expect(leaks(readOnly)).toEqual([]);
		for (const tool of ["SendMessage", "TaskStop", "TaskOutput"]) expect(readOnly).not.toContain(tool);
		expect(readOnly).toContain("These agents have no job entry; transcripts at `history://<id>`.");
		const native = textOf(undefined);
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

	async function presentedNames(
		mode: string,
		toolNames: readonly string[] = ["read", "write", "wait", "task", "eval", "todo"],
	): Promise<{
		presented: string[];
		promptNames: string[];
		promptToolNames: string[];
		refs: Readonly<Record<string, string>>;
	}> {
		const tools = toolNames.map(stubTool);
		let promptNames: string[] = [];
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
			rebuildSystemPrompt: async names => {
				promptNames = [...names];
				return { systemPrompt: [`tools:${names.join(",")}`] };
			},
		});
		sessions.push(session);
		await session.setActiveToolsByName(tools.map(tool => tool.name));
		return {
			presented: session.agent.state.tools.map(tool => tool.name),
			promptNames,
			promptToolNames: session.getPromptToolNames(),
			refs: session.getToolRefs(),
		};
	}

	it("withholds wait only under claude-code, where no capture declares TaskOutput", async () => {
		const claudeCode = await presentedNames("claude-code");
		expect(claudeCode.presented).not.toContain("wait");
		expect(claudeCode.presented).not.toContain("TaskOutput");
		expect(claudeCode.presented).toEqual(
			expect.arrayContaining([
				"Agent",
				"SendMessage",
				"TaskStop",
				"ListAgents",
				"WebFetch",
				"Skill",
				"eval",
				"todo",
			]),
		);
		// Prompt gates never see the withheld tool, and the refs match the wire.
		expect(claudeCode.promptNames).not.toContain("wait");
		expect(claudeCode.promptNames).toContain("task");
		expect(claudeCode.promptToolNames).toEqual(claudeCode.promptNames);
		expect(claudeCode.refs.wait).toBeUndefined();
		expect(claudeCode.refs.task).toBe("Agent");
		expect(claudeCode.refs.SendMessage).toBe("SendMessage");

		const native = await presentedNames("native");
		expect(native.presented).toContain("wait");
		expect(native.presented).not.toContain("SendMessage");
		expect(native.promptNames).toContain("wait");
		expect(native.promptToolNames).toEqual(native.promptNames);
		expect(native.refs).toBe(NATIVE);
	});

	it("mounts ListAgents only beside SendMessage", async () => {
		const readOnly = await presentedNames("claude-code", ["read", "bash", "task"]);
		expect(readOnly.presented).not.toContain("SendMessage");
		expect(readOnly.presented).not.toContain("ListAgents");
		expect(readOnly.presented).not.toContain("TaskStop");
		expect(readOnly.refs.ListAgents).toBeUndefined();
		// Stub tools keep their own names; the facades still mount over them.
		expect(readOnly.presented).toEqual(expect.arrayContaining(["read", "bash", "Agent", "Skill"]));
	});
});
