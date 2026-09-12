import { type } from "@oh-my-pi/omptype";
import type { ToolNamespace } from "@oh-my-pi/pi-ai";
import type { HarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import claudeCodeAgent from "../prompts/tools/harness/claude-code-agent.md" with { type: "text" };
import claudeCodeListAgents from "../prompts/tools/harness/claude-code-list-agents.md" with { type: "text" };
import claudeCodeSendMessage from "../prompts/tools/harness/claude-code-send-message.md" with { type: "text" };
import claudeCodeWebFetch from "../prompts/tools/harness/claude-code-web-fetch.md" with { type: "text" };
import claudeCodeTaskOutput from "../prompts/tools/harness/claude-code-task-output.md" with { type: "text" };
import claudeCodeTaskStop from "../prompts/tools/harness/claude-code-task-stop.md" with { type: "text" };
import claudeCodeSkill from "../prompts/tools/harness/claude-code-skill.md" with { type: "text" };
import codexCollaborationNamespace from "../prompts/tools/harness/codex-collaboration-namespace.md" with { type: "text" };
import codexFollowupTask from "../prompts/tools/harness/codex-followup-task.md" with { type: "text" };
import codexInterruptAgent from "../prompts/tools/harness/codex-interrupt-agent.md" with { type: "text" };
import codexListAgents from "../prompts/tools/harness/codex-list-agents.md" with { type: "text" };
import codexSendMessage from "../prompts/tools/harness/codex-send-message.md" with { type: "text" };
import codexSpawnAgent from "../prompts/tools/harness/codex-spawn-agent.md" with { type: "text" };
import codexWaitAgent from "../prompts/tools/harness/codex-wait-agent.md" with { type: "text" };
import codexWait from "../prompts/tools/harness/codex-wait.md" with { type: "text" };
import type { TaskEffort } from "../thinking";
import { ToolError } from "../tools/tool-errors";
import type { HarnessFacadeSpec } from "./facade";
import { CODEX_COLLABORATION_NAMESPACE } from "./manifest";

function unsupported(field: string, reason: string): never {
	throw new ToolError(`${field} is not supported: ${reason}. Retry without the field.`);
}

const claudeCodeSendMessageSchema = type({
	to: type("string").describe("Recipient: an agent name from ListAgents or a background agent id"),
	message: type("string").describe("Plain text message content"),
	"summary?": type("string").describe("Transcript label; not transmitted"),
	"notify_when_idle?": type("boolean").describe("Not available in this build; leave unset"),
});

const claudeCodeListAgentsSchema = type({
	"channel?": type("string").describe("Not available in this build; leave unset"),
	"q?": type("string").describe("Not available in this build; leave unset"),
});

const claudeCodeTaskOutputSchema = type({
	task_id: type("string").describe("The task ID to get output from"),
	block: type("boolean").describe("Whether to wait for completion"),
	timeout: type("number >= 0").describe("Max wait time in ms; 0 waits until the task settles"),
});

const claudeCodeTaskStopSchema = type({
	"task_id?": type("string").describe("The ID of the background task or agent to stop"),
	"shell_id?": type("string").describe("Deprecated: use task_id instead"),
});

const claudeCodeAgentSchema = type({
	description: type("string").describe("A short (3-5 word) description of the task"),
	prompt: type("string").describe("The task for the agent to perform"),
	"subagent_type?": type("string").describe("The type of specialized agent to use for this task"),
	"model?": type("'sonnet' | 'opus' | 'haiku' | 'fable'").describe(
		"Not available; the agent definition owns its model",
	),
	"isolation?": type("'worktree' | 'remote'").describe("worktree runs the agent on an isolated git worktree"),
});

const claudeCodeWebFetchSchema = type({
	url: type("string").describe("The URL to fetch content from"),
	prompt: type("string").describe("Not applied in this build; the full page content is returned"),
});

const claudeCodeSkillSchema = type({
	skill: type("string").describe("The skill name to load"),
	"args?": type("string").describe("Not available in this build; leave unset"),
});

const CLAUDE_CODE_TASK_OUTPUT: HarnessFacadeSpec<typeof claudeCodeTaskOutputSchema> = {
	target: "hub",
	wireName: "TaskOutput",
	description: claudeCodeTaskOutput,
	parameters: claudeCodeTaskOutputSchema,
	toParams: (args: typeof claudeCodeTaskOutputSchema.infer) =>
		args.block ? { op: "wait", ids: [args.task_id], timeoutMs: args.timeout } : { op: "jobs" },
};

const CLAUDE_CODE_FACADES: readonly HarnessFacadeSpec[] = [
	{
		target: "task",
		wireName: "Agent",
		replacesTarget: true,
		description: claudeCodeAgent,
		parameters: claudeCodeAgentSchema,
		intent: (args: Partial<typeof claudeCodeAgentSchema.infer>) => args.description,
		toParams: (args: typeof claudeCodeAgentSchema.infer, host) => {
			// `model` is a documented optional override in both vendors' schemas; omp's
			// agent definition owns the model, so the field is accepted and ignored
			// rather than costing the model a rejected delegation.
			if (args.subagent_type === "fork")
				unsupported('Agent.subagent_type "fork"', "subagents start with no inherited context");
			if (args.isolation === "remote") unsupported('Agent.isolation "remote"', "omp has no remote execution");
			if (args.isolation === "worktree" && !host.settings.get("task.isolation.enabled")) {
				unsupported('Agent.isolation "worktree"', "task.isolation.enabled is off in this session");
			}
			return {
				task: args.prompt,
				...(args.subagent_type !== undefined ? { agent: args.subagent_type } : {}),
				...(args.isolation === "worktree" ? { isolated: true } : {}),
			};
		},
	},
	{
		target: "hub",
		wireName: "SendMessage",
		description: claudeCodeSendMessage,
		parameters: claudeCodeSendMessageSchema,
		toParams: (args: typeof claudeCodeSendMessageSchema.infer) => {
			if (args.notify_when_idle === true) {
				unsupported("SendMessage.notify_when_idle", "omp has no idle notice; use TaskOutput to wait on an agent");
			}
			return { op: "send", to: args.to, message: args.message };
		},
	},
	{
		target: "hub",
		wireName: "ListAgents",
		description: claudeCodeListAgents,
		parameters: claudeCodeListAgentsSchema,
		toParams: (args: typeof claudeCodeListAgentsSchema.infer) => {
			if (args.channel !== undefined) unsupported("ListAgents.channel", "omp has no agent channels");
			if (args.q !== undefined) unsupported("ListAgents.q", "omp does not filter the roster");
			return { op: "list" };
		},
	},
	CLAUDE_CODE_TASK_OUTPUT,
	{
		target: "hub",
		wireName: "TaskStop",
		description: claudeCodeTaskStop,
		parameters: claudeCodeTaskStopSchema,
		toParams: (args: typeof claudeCodeTaskStopSchema.infer) => {
			const id = args.task_id ?? args.shell_id;
			if (id === undefined) throw new ToolError("TaskStop.task_id is required.");
			return { op: "cancel", ids: [id] };
		},
	},
	{
		target: "read",
		wireName: "WebFetch",
		description: claudeCodeWebFetch,
		parameters: claudeCodeWebFetchSchema,
		toParams: (args: typeof claudeCodeWebFetchSchema.infer) => ({ path: args.url }),
	},
	{
		target: "read",
		wireName: "Skill",
		description: claudeCodeSkill,
		parameters: claudeCodeSkillSchema,
		toParams: (args: typeof claudeCodeSkillSchema.infer) => {
			if (args.args !== undefined) unsupported("Skill.args", "skills take no arguments in omp");
			return { path: `skill://${args.skill}` };
		},
	},
];

const CODEX_COLLABORATION: ToolNamespace = {
	name: CODEX_COLLABORATION_NAMESPACE,
	description: codexCollaborationNamespace.trim(),
};

const CODEX_WAIT_AGENT_DEFAULT_TIMEOUT_MS = 30_000;
const CODEX_WAIT_DEFAULT_YIELD_MS = 10_000;

const CODEX_REASONING_EFFORTS: Readonly<Record<string, TaskEffort>> = {
	low: "lo",
	medium: "med",
	high: "hi",
	xhigh: "hi",
	max: "hi",
	ultra: "hi",
};

const codexSpawnAgentSchema = type({
	task_name: type("string").describe("Task name for the new agent. Use lowercase letters, digits, and underscores."),
	message: type("string").describe("Initial plain-text task for the new agent."),
	"model?": type("string").describe("Not available; the agent definition owns its model"),
	"reasoning_effort?": type("string").describe("Reasoning effort override for the new agent. Omit to inherit."),
	"fork_turns?": type("string").describe("Only `none` is available: the new agent starts with no inherited context"),
});

const codexTargetMessageSchema = type({
	target: type("string").describe("Agent id to message (from spawn_agent or list_agents)."),
	message: type("string").describe("Message text to send to the target agent."),
});

const codexListAgentsSchema = type({
	"path_prefix?": type("string").describe("Not available; agents have flat ids, not task paths"),
});

const codexInterruptAgentSchema = type({
	target: type("string").describe("Agent id to interrupt (from spawn_agent or list_agents)."),
});

const codexWaitAgentSchema = type({
	"timeout_ms?": type("number").describe(
		`Timeout in milliseconds. Defaults to ${CODEX_WAIT_AGENT_DEFAULT_TIMEOUT_MS}.`,
	),
});

const codexWaitSchema = type({
	cell_id: type("string").describe("Identifier of the running exec cell."),
	"max_tokens?": type("number").describe("Accepted but not applied; output is capped by the session."),
	"terminate?": type("boolean").describe("True stops the running exec cell; false or omitted waits for output."),
	"yield_time_ms?": type("number").describe(
		`Wait before yielding more output. Defaults to ${CODEX_WAIT_DEFAULT_YIELD_MS} ms.`,
	),
});

const CODEX_WAIT: HarnessFacadeSpec<typeof codexWaitSchema> = {
	target: "hub",
	wireName: "wait",
	description: codexWait,
	parameters: codexWaitSchema,
	toParams: (args: typeof codexWaitSchema.infer) =>
		args.terminate
			? { op: "cancel", ids: [args.cell_id] }
			: { op: "wait", ids: [args.cell_id], timeoutMs: args.yield_time_ms ?? CODEX_WAIT_DEFAULT_YIELD_MS },
};

const CODEX_FACADES: readonly HarnessFacadeSpec[] = [
	{
		target: "task",
		wireName: "spawn_agent",
		replacesTarget: true,
		namespace: CODEX_COLLABORATION,
		description: codexSpawnAgent,
		parameters: codexSpawnAgentSchema,
		intent: (args: Partial<typeof codexSpawnAgentSchema.infer>) => args.task_name,
		toParams: (args: typeof codexSpawnAgentSchema.infer, host) => {
			if (args.fork_turns !== undefined && args.fork_turns !== "none") {
				unsupported(`spawn_agent.fork_turns "${args.fork_turns}"`, "subagents start with no inherited context");
			}
			let effort: TaskEffort | undefined;
			if (args.reasoning_effort !== undefined) {
				effort = CODEX_REASONING_EFFORTS[args.reasoning_effort];
				if (effort === undefined) {
					unsupported(
						`spawn_agent.reasoning_effort "${args.reasoning_effort}"`,
						"use low, medium, high, xhigh, max, or ultra",
					);
				}
				if (!host.settings.get("task.enableEffort")) {
					unsupported("spawn_agent.reasoning_effort", "task.enableEffort is off in this session");
				}
			}
			return { name: args.task_name, task: args.message, ...(effort !== undefined ? { effort } : {}) };
		},
	},
	{
		target: "hub",
		wireName: "send_message",
		namespace: CODEX_COLLABORATION,
		description: codexSendMessage,
		parameters: codexTargetMessageSchema,
		toParams: (args: typeof codexTargetMessageSchema.infer) => ({
			op: "send",
			to: args.target,
			message: args.message,
		}),
	},
	{
		target: "hub",
		wireName: "followup_task",
		namespace: CODEX_COLLABORATION,
		description: codexFollowupTask,
		parameters: codexTargetMessageSchema,
		toParams: (args: typeof codexTargetMessageSchema.infer) => ({
			op: "send",
			to: args.target,
			message: args.message,
		}),
	},
	{
		target: "hub",
		wireName: "list_agents",
		namespace: CODEX_COLLABORATION,
		description: codexListAgents,
		parameters: codexListAgentsSchema,
		toParams: (args: typeof codexListAgentsSchema.infer) => {
			if (args.path_prefix !== undefined) {
				unsupported("list_agents.path_prefix", "agents have flat ids, not task paths");
			}
			return { op: "list" };
		},
	},
	{
		target: "hub",
		wireName: "interrupt_agent",
		namespace: CODEX_COLLABORATION,
		description: codexInterruptAgent,
		parameters: codexInterruptAgentSchema,
		toParams: (args: typeof codexInterruptAgentSchema.infer) => ({ op: "cancel", ids: [args.target] }),
	},
	{
		target: "hub",
		wireName: "wait_agent",
		namespace: CODEX_COLLABORATION,
		description: codexWaitAgent,
		parameters: codexWaitAgentSchema,
		toParams: (args: typeof codexWaitAgentSchema.infer) => ({
			op: "wait",
			timeoutMs: args.timeout_ms ?? CODEX_WAIT_AGENT_DEFAULT_TIMEOUT_MS,
		}),
	},
	CODEX_WAIT,
];

const FACADES: Readonly<Record<HarnessProfile, readonly HarnessFacadeSpec[]>> = {
	"claude-code": CLAUDE_CODE_FACADES,
	codex: CODEX_FACADES,
};

export function harnessFacadeSpecs(profile: HarnessProfile): readonly HarnessFacadeSpec[] {
	return FACADES[profile];
}

/** The facade each profile waits on one background job with (`hub` `op:"wait"` + `ids`). */
export const HARNESS_JOB_WAIT_FACADE: Readonly<Record<HarnessProfile, HarnessFacadeSpec>> = {
	"claude-code": CLAUDE_CODE_TASK_OUTPUT,
	codex: CODEX_WAIT,
};
