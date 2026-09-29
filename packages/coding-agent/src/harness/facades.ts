import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolSpeculationPolicy } from "@oh-my-pi/pi-agent-core";
import type { TSchema, ToolNamespace } from "@oh-my-pi/pi-ai";
import type { HarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import { prompt } from "@oh-my-pi/pi-utils";
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
import type { TaskEffort } from "@oh-my-pi/pi-tui/thinking";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { completeOnTier } from "../eval/completion-bridge";
import { isIrcEnabled } from "../irc/messaging";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { cfgTaskBatch, cfgTaskEnableEffort, cfgTaskIsolationEnabled } from "../task/settings";
import { cfgFetchEnabled } from "../tools/settings";
import type { HarnessFacadeHost, HarnessFacadeSpec } from "./facade";
import { CODEX_COLLABORATION_NAMESPACE } from "./manifest";

function unsupported(field: string, reason: string): never {
	throw new ToolError(`${field} is not supported: ${reason}. Retry without the field.`);
}

const claudeCodeSendMessageSchema = type({
	to: type("string").describe(
		'Recipient: an agent name (from a spawn result or ListAgents), "main" for the main conversation, or "all"',
	),
	message: type("string").describe("Plain text message content"),
});

const claudeCodeListAgentsSchema = type({});

const claudeCodeTaskOutputSchema = type({
	task_id: type("string").describe("The task you are waiting on"),
});

const claudeCodeTaskStopSchema = type({
	"task_id?": type("string").describe("The ID of the background task to stop, or a background agent's name"),
	"shell_id?": type("string").describe("Deprecated: use task_id instead"),
});

const claudeCodeWebFetchSchema = type({
	url: type("string").describe("The URL to fetch content from"),
	prompt: type("string").describe("The prompt to run on the fetched content"),
});

const claudeCodeSkillSchema = type({
	skill: type("string").describe("The skill name, exactly as the skills listing shows it"),
	"args?": type("string").describe("Optional arguments for the skill"),
});

const claudeCodeAgentItem = {
	description: type("string").describe("A short (3-5 word) description of the task"),
	prompt: type("string").describe("The task for the agent to perform"),
	"subagent_type?": type("string").describe("The type of specialized agent to use for this task"),
};

interface ClaudeCodeAgentItem {
	description: string;
	prompt: string;
	subagent_type?: string;
}

interface ClaudeCodeAgentArgs extends ClaudeCodeAgentItem {
	isolation?: "worktree";
	tasks?: ClaudeCodeAgentItem[];
}

const claudeCodeAgentSchemas = new Map<string, TSchema>();

/**
 * Claude Code's Agent schema with only what a session honors: no `model` (an
 * agent's definition owns its model), `isolation` while task isolation is
 * enabled, and the batch `tasks` form while `task.batch` is on. `tasks` comes
 * last so a streamed call closes its shared `prompt` before the first item.
 */
function claudeCodeAgentSchema(isolation: boolean, batch: boolean): TSchema {
	const key = `${isolation}:${batch}`;
	let schema = claudeCodeAgentSchemas.get(key);
	if (!schema) {
		schema = type.raw({
			...claudeCodeAgentItem,
			...(isolation
				? { "isolation?": type("'worktree'").describe('"worktree" runs the agent on its own git worktree') }
				: {}),
			...(batch
				? {
						"tasks?": type(claudeCodeAgentItem)
							.array()
							.describe("One agent per item; each receives the top-level `prompt` as a shared brief"),
					}
				: {}),
		}) as unknown as TSchema;
		claudeCodeAgentSchemas.set(key, schema);
	}
	return schema;
}

/**
 * Agent call → task params. The flat form is one spawn; `tasks` becomes the
 * task tool's batch `{ context, tasks[] }` with the top-level `prompt` as the
 * shared context. Tolerates a partially streamed batch (speculative launch
 * plans from each prefix).
 */
function claudeCodeAgentParams(args: ClaudeCodeAgentArgs, host: HarnessFacadeHost): Record<string, unknown> {
	if (args.isolation === "worktree" && !cfgTaskIsolationEnabled.get(host.settings)) {
		unsupported('Agent.isolation "worktree"', "task isolation is off in this session");
	}
	const isolated = args.isolation === "worktree" ? { isolated: true } : {};
	if (args.tasks !== undefined) {
		const tasks = args.tasks.map(item => {
			if (item.subagent_type === "fork") {
				throw new ToolError('subagent_type "fork" applies to a single Agent call, not to `tasks` items.');
			}
			return { task: item.prompt, ...(item.subagent_type !== undefined ? { agent: item.subagent_type } : {}) };
		});
		return { context: args.prompt, tasks, ...isolated };
	}
	// `subagent_type: "fork"` forks the conversation, not an agent type:
	// the default task agent runs with the parent's history inherited.
	const isFork = args.subagent_type === "fork";
	return {
		task: args.prompt,
		...(args.subagent_type !== undefined && !isFork ? { agent: args.subagent_type } : {}),
		...(isFork ? { fork: "all" as const } : {}),
		...isolated,
	};
}

/** The task tool surface the Agent facade reuses: its roster-backed description and batch speculation. */
interface TaskToolSurface {
	renderDescriptionAs?(template: string): string;
	speculationFor?(projection: { contextKey: string; toParams: (args: unknown) => unknown }): ToolSpeculationPolicy;
}

const WEB_FETCH_ANSWER_RULE = "Provide a concise response based only on the content above.";

/** Claude Code's WebFetch secondary prompt: the page, then the caller's prompt. */
function webFetchPrompt(page: string, request: string): string {
	return `Web page content:\n---\n${page}\n---\n\n${request}\n\n${WEB_FETCH_ANSWER_RULE}`;
}

function resultText(result: AgentToolResult): string {
	return result.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
}

// Background-job control maps onto omp's primitives: `wait` (block for the
// next result), `write proc://<id>/kill` (cancel), `write agent://<id>`
// (message), and `read history://` (roster).
const CLAUDE_CODE_TASK_OUTPUT: HarnessFacadeSpec<typeof claudeCodeTaskOutputSchema> = {
	target: "wait",
	wireName: "TaskOutput",
	replacesTarget: true,
	ownSurface: true,
	description: claudeCodeTaskOutput,
	parameters: claudeCodeTaskOutputSchema,
	// Claude Code 2.1.284 removed TaskOutput; serve it only to a capture that declares it.
	mounts: host => host.vendorTool?.("TaskOutput") !== undefined,
	toParams: () => ({}),
};

const CLAUDE_CODE_WEB_FETCH: HarnessFacadeSpec<typeof claudeCodeWebFetchSchema> = {
	target: "read",
	wireName: "WebFetch",
	ownSurface: true,
	description: claudeCodeWebFetch,
	parameters: claudeCodeWebFetchSchema,
	mounts: host => cfgFetchEnabled.get(host.settings),
	toParams: args => ({ path: args.url }),
	// The page comes through `read`; the session's smol model answers
	// `prompt` over it. Without a smol model the page itself is the result.
	run: async ({ args, host, signal, forward }) => {
		const page = await forward();
		if (page.isError || !host.session) return page;
		let answer: string | undefined;
		try {
			answer = await completeOnTier(
				webFetchPrompt(resultText(page), args.prompt),
				"smol",
				host.session,
				signal ?? new AbortController().signal,
			);
		} catch {
			if (signal?.aborted) throw signal.reason;
		}
		return answer ? { content: [{ type: "text", text: answer }] } : page;
	},
};

const CLAUDE_CODE_SKILL: HarnessFacadeSpec<typeof claudeCodeSkillSchema> = {
	target: "read",
	wireName: "Skill",
	ownSurface: true,
	description: claudeCodeSkill,
	parameters: claudeCodeSkillSchema,
	toParams: args => ({ path: `skill://${args.skill}` }),
	// Arguments reach the skill the way Claude Code passes them: replacing
	// `$ARGUMENTS` in its instructions, else appended after them.
	run: async ({ args, forward }) => {
		const loaded = await forward();
		const value = args.args?.trim();
		if (loaded.isError || !value) return loaded;
		const body = resultText(loaded);
		const text = body.includes("$ARGUMENTS")
			? body.replaceAll("$ARGUMENTS", value)
			: `${body}\n\nARGUMENTS: ${value}`;
		return { ...loaded, content: [{ type: "text", text }] };
	},
};

const CLAUDE_CODE_FACADES: readonly HarnessFacadeSpec[] = [
	{
		target: "task",
		wireName: "Agent",
		replacesTarget: true,
		ownSurface: true,
		description: prompt.render(claudeCodeAgent, { agents: [], defaultAgent: "task", asyncEnabled: true }),
		parameters: claudeCodeAgentSchema(false, false),
		describe: target => (target as AgentTool & TaskToolSurface).renderDescriptionAs?.(claudeCodeAgent),
		schema: host =>
			claudeCodeAgentSchema(cfgTaskIsolationEnabled.get(host.settings), cfgTaskBatch.get(host.settings)),
		intent: (args: Partial<ClaudeCodeAgentArgs>) => args.description,
		toParams: (args: ClaudeCodeAgentArgs, host) => claudeCodeAgentParams(args, host),
		speculation: (target, toParams) =>
			(target as AgentTool & TaskToolSurface).speculationFor?.({ contextKey: "prompt", toParams }),
	},
	{
		target: "write",
		wireName: "SendMessage",
		ownSurface: true,
		description: claudeCodeSendMessage,
		parameters: claudeCodeSendMessageSchema,
		mounts: host => isIrcEnabled(host.settings, host.session?.taskDepth ?? 0),
		toParams: (args: typeof claudeCodeSendMessageSchema.infer) => {
			const to = args.to.trim();
			return { path: `agent://${to.toLowerCase() === "main" ? MAIN_AGENT_ID : to}`, content: args.message };
		},
	},
	{
		target: "read",
		wireName: "ListAgents",
		ownSurface: true,
		description: claudeCodeListAgents,
		parameters: claudeCodeListAgentsSchema,
		toParams: () => ({ path: "history://?live" }),
	},
	CLAUDE_CODE_TASK_OUTPUT,
	{
		target: "write",
		wireName: "TaskStop",
		ownSurface: true,
		description: claudeCodeTaskStop,
		parameters: claudeCodeTaskStopSchema,
		toParams: (args: typeof claudeCodeTaskStopSchema.infer) => {
			const id = args.task_id ?? args.shell_id;
			if (id === undefined) throw new ToolError("TaskStop.task_id is required.");
			return { path: `proc://${id}/kill` };
		},
	},
	CLAUDE_CODE_WEB_FETCH,
	CLAUDE_CODE_SKILL,
];

const CODEX_COLLABORATION: ToolNamespace = {
	name: CODEX_COLLABORATION_NAMESPACE,
	description: codexCollaborationNamespace.trim(),
};
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
	"fork_turns?": type("string").describe(
		"Optional number of turns to fork. Defaults to `all`. Use `none`, `all`, or a positive integer string such as `3` to fork only the most recent turns.",
	),
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
	"timeout_ms?": type("number").describe("Accepted but not applied; the wait returns on the next result or message."),
});

const codexWaitSchema = type({
	cell_id: type("string").describe("Identifier of the running exec cell."),
	"max_tokens?": type("number").describe("Accepted but not applied; output is capped by the session."),
	"terminate?": type("boolean").describe("Not available; stop a running cell with interrupt_agent."),
	"yield_time_ms?": type("number").describe("Accepted but not applied; the wait returns on the next result."),
});

const CODEX_WAIT: HarnessFacadeSpec<typeof codexWaitSchema> = {
	target: "wait",
	wireName: "wait",
	// The vendor's `wait` shares omp's tool name, so it stands in for it on this surface.
	replacesTarget: true,
	description: codexWait,
	parameters: codexWaitSchema,
	toParams: (args: typeof codexWaitSchema.infer) => {
		if (args.terminate === true) {
			throw new ToolError(
				`wait.terminate is not supported: stop the cell with interrupt_agent (target "${args.cell_id}"). Retry without the field to wait.`,
			);
		}
		return {};
	},
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
			// Vendor parity (codex-rs spawn.rs fork_mode): absent or
			// whitespace-only defaults to `all`; `none`/`all` are
			// case-insensitive; anything else must parse as a positive integer.
			const raw = args.fork_turns?.trim();
			let fork: "all" | number | undefined;
			if (raw === undefined || raw === "" || raw.toLowerCase() === "all") {
				fork = "all";
			} else if (raw.toLowerCase() === "none") {
				fork = undefined;
			} else if (/^\+?\d+$/.test(raw)) {
				const n = Number(raw);
				if (Number.isSafeInteger(n) && n > 0) fork = n;
				else throw new ToolError("fork_turns must be `none`, `all`, or a positive integer string");
			} else {
				throw new ToolError("fork_turns must be `none`, `all`, or a positive integer string");
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
				if (!cfgTaskEnableEffort.get(host.settings)) {
					unsupported("spawn_agent.reasoning_effort", "task.enableEffort is off in this session");
				}
			}
			return {
				name: args.task_name,
				task: args.message,
				...(fork !== undefined ? { fork } : {}),
				...(effort !== undefined ? { effort } : {}),
			};
		},
	},
	{
		target: "write",
		wireName: "send_message",
		namespace: CODEX_COLLABORATION,
		description: codexSendMessage,
		parameters: codexTargetMessageSchema,
		toParams: (args: typeof codexTargetMessageSchema.infer) => ({
			path: `agent://${args.target}`,
			content: args.message,
		}),
	},
	{
		target: "write",
		wireName: "followup_task",
		namespace: CODEX_COLLABORATION,
		description: codexFollowupTask,
		parameters: codexTargetMessageSchema,
		toParams: (args: typeof codexTargetMessageSchema.infer) => ({
			path: `agent://${args.target}`,
			content: args.message,
		}),
	},
	{
		target: "read",
		wireName: "list_agents",
		namespace: CODEX_COLLABORATION,
		description: codexListAgents,
		parameters: codexListAgentsSchema,
		toParams: (args: typeof codexListAgentsSchema.infer) => {
			if (args.path_prefix !== undefined) {
				unsupported("list_agents.path_prefix", "agents have flat ids, not task paths");
			}
			return { path: "history://" };
		},
	},
	{
		target: "write",
		wireName: "interrupt_agent",
		namespace: CODEX_COLLABORATION,
		description: codexInterruptAgent,
		parameters: codexInterruptAgentSchema,
		toParams: (args: typeof codexInterruptAgentSchema.infer) => ({ path: `proc://${args.target}/kill` }),
	},
	{
		target: "wait",
		wireName: "wait_agent",
		namespace: CODEX_COLLABORATION,
		description: codexWaitAgent,
		parameters: codexWaitAgentSchema,
		toParams: () => ({}),
	},
	CODEX_WAIT,
];

// pi has no built-in subagent or multi-agent surface to facade; every omp
// tool the profile does not rename keeps its native name.
const FACADES: Readonly<Record<HarnessProfile, readonly HarnessFacadeSpec[]>> = {
	"claude-code": CLAUDE_CODE_FACADES,
	codex: CODEX_FACADES,
	pi: [],
};

export function harnessFacadeSpecs(profile: HarnessProfile): readonly HarnessFacadeSpec[] {
	return FACADES[profile];
}

/**
 * The facade each profile waits on background work with (omp's `wait`).
 * Profiles without a wait facade (pi) fall back to `wait` itself.
 */
export const HARNESS_JOB_WAIT_FACADE: Partial<Readonly<Record<HarnessProfile, HarnessFacadeSpec>>> = {
	"claude-code": CLAUDE_CODE_TASK_OUTPUT,
	codex: CODEX_WAIT,
};
