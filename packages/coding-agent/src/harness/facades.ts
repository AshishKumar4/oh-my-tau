import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolSpeculationPolicy } from "@oh-my-pi/pi-agent-core";
import type { TSchema, ToolNamespace } from "@oh-my-pi/pi-ai";
import type { HarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import { compareRevision, parseRevision } from "@oh-my-pi/pi-catalog/compat/revision";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model } from "@oh-my-pi/pi-catalog/types";
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
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { completeOnTier } from "../eval/completion-bridge";
import { isIrcEnabled } from "../irc/messaging";
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import { formatModelStringWithRouting } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { approvedPerCallModels, parentModelGrantPattern, spawnModelGrants } from "../task/model-approval";
import { cfgTaskBatch, cfgTaskEnableEffort, cfgTaskIsolationEnabled, perCallModelEnabled } from "../task/settings";
import { cfgFetchEnabled } from "../tools/settings";
import type { HarnessFacadeHost, HarnessFacadeSpec } from "./facade";
import { CODEX_COLLABORATION_NAMESPACE, harnessToolRefs } from "./manifest";

function unsupported(field: string, reason: string): never {
	throw new ToolError(`${field} is not supported: ${reason}. Retry without the field.`);
}

/** Vendor effort names → the exact level a spawn runs at; Codex's `ultra` is omp's top level. */
const VENDOR_EFFORTS: Readonly<Record<string, Effort>> = {
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
	ultra: Effort.Max,
};

/** Peer messaging is on: always for a subagent, for the root while it can spawn one. */
function peerMessaging(host: HarnessFacadeHost): boolean {
	return isIrcEnabled(host.settings, host.session?.taskDepth ?? 0);
}

const claudeCodeSendMessageSchema = type({
	to: type("string").describe(
		'Recipient: an agent name (from a spawn result or ListAgents), "main" for the main conversation, or "all" (main agent only). Append "?progress" for a note that does not end the recipient\'s wait',
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

const CLAUDE_CODE_MODEL_ALIASES = ["sonnet", "opus", "haiku", "fable"] as const;
type ClaudeCodeModelAlias = (typeof CLAUDE_CODE_MODEL_ALIASES)[number];
type ClaudeCodeEffort = "low" | "medium" | "high" | "xhigh" | "max";

const claudeCodeAgentModel = {
	"model?": type("'sonnet' | 'opus' | 'haiku' | 'fable'").describe(
		"Optional model override for this agent: the newest approved model of that family. Takes precedence over the agent definition's model frontmatter; an agent whose model the user configured rejects it. If omitted, uses the agent definition's model, else inherits from the parent. Ignored for subagent_type: \"fork\" — forks always inherit the parent model.",
	),
};

const claudeCodeAgentEffort = {
	"effort?": type("'low' | 'medium' | 'high' | 'xhigh' | 'max'").describe(
		'Reasoning effort for this agent. Set this ONLY when the user, or instructions such as CLAUDE.md or a skill, explicitly ask that this agent or delegated work run at a specific effort level, never on your own judgment; otherwise omit it and the agent runs at its usual effort. Ignored for subagent_type: "fork": a fork runs at your own effort.',
	),
};

interface ClaudeCodeAgentItem {
	description: string;
	prompt: string;
	subagent_type?: string;
	model?: ClaudeCodeModelAlias;
	effort?: ClaudeCodeEffort;
}

interface ClaudeCodeAgentArgs extends ClaudeCodeAgentItem {
	isolation?: "worktree";
	tasks?: ClaudeCodeAgentItem[];
}

/** Which optional Agent fields a session honors. */
interface ClaudeCodeAgentSurface {
	isolation: boolean;
	batch: boolean;
	/** `model`, while `task.perCallModel` admits task calls. */
	model: boolean;
	/** `effort`, while `task.enableEffort` is on: the task tool honors a caller's effort only then. */
	effort: boolean;
}

function claudeCodeAgentSurface(settings: Settings): ClaudeCodeAgentSurface {
	return {
		isolation: cfgTaskIsolationEnabled.get(settings),
		batch: cfgTaskBatch.get(settings),
		model: perCallModelEnabled(settings, "task"),
		effort: cfgTaskEnableEffort.get(settings),
	};
}

const claudeCodeAgentSchemas = new Map<string, TSchema>();

/**
 * Claude Code's Agent schema with only what a session honors: `model` and
 * `effort` while the settings let a call choose them, `isolation` while task
 * isolation is enabled, and the batch `tasks` form while `task.batch` is on.
 * `tasks` comes last so a streamed call closes its shared `prompt` before the
 * first item.
 */
function claudeCodeAgentSchema(surface: ClaudeCodeAgentSurface): TSchema {
	const key = `${surface.isolation}:${surface.batch}:${surface.model}:${surface.effort}`;
	let schema = claudeCodeAgentSchemas.get(key);
	if (!schema) {
		const item = {
			...claudeCodeAgentItem,
			...(surface.model ? claudeCodeAgentModel : {}),
			...(surface.effort ? claudeCodeAgentEffort : {}),
		};
		schema = type.raw({
			...item,
			...(surface.isolation
				? { "isolation?": type("'worktree'").describe('"worktree" runs the agent on its own git worktree') }
				: {}),
			...(surface.batch
				? {
						"tasks?": type(item)
							.array()
							.describe("One agent per item; each receives the top-level `prompt` as a shared brief"),
					}
				: {}),
		}) as unknown as TSchema;
		claudeCodeAgentSchemas.set(key, schema);
	}
	return schema;
}

/** Claude Code's family alias → the exact selector the task tool's per-call `model` takes. */
function claudeCodeModelSelector(
	alias: ClaudeCodeModelAlias,
	agent: string | undefined,
	host: HarnessFacadeHost,
): string {
	const registry = host.session?.modelRegistry;
	if (!registry) unsupported("Agent.model", "this session has no model registry");
	const parent = host.session?.getActiveModel?.();
	const parentModelPattern = parent && parentModelGrantPattern(parent);
	const approved = approvedPerCallModels(
		spawnModelGrants(host.settings, {
			agentName: agent ?? "task",
			...(parentModelPattern !== undefined ? { parentModelPattern } : {}),
		}),
		registry,
	);
	// The newest of the family; the parent's provider wins a tie.
	const newest = (family: ClaudeCodeModelAlias): Model | undefined =>
		approved
			.filter(model => model.identity.class === "anthropic" && model.identity.family === family)
			.map(model => {
				const { revision } = model.identity;
				return { model, revision: revision === undefined ? undefined : parseRevision(revision) };
			})
			.sort((a, b) => {
				const byRevision =
					a.revision && b.revision
						? compareRevision(b.revision, a.revision)
						: Number(!a.revision) - Number(!b.revision);
				return (
					byRevision ||
					Number(b.model.provider === parent?.provider) - Number(a.model.provider === parent?.provider)
				);
			})[0]?.model;
	const model = newest(alias);
	if (model) return formatModelStringWithRouting(model);
	const others = CLAUDE_CODE_MODEL_ALIASES.filter(other => other !== alias && newest(other));
	throw new ToolError(
		`Agent.model "${alias}" names no approved model in this session${others.length > 0 ? `; approved: ${others.map(other => `"${other}"`).join(", ")}` : ""}. Omit model to use the agent's configured model.`,
	);
}

/** An item's `model`/`effort` as task spawn params; a named model carries the effort as its `:level`. */
function claudeCodeSpawnRouting(
	item: ClaudeCodeAgentItem,
	host: HarnessFacadeHost,
): { model?: string; effort?: Effort } {
	const surface = claudeCodeAgentSurface(host.settings);
	if (item.effort !== undefined && !surface.effort) {
		unsupported("Agent.effort", "task.enableEffort is off in this session");
	}
	const effort = item.effort === undefined ? undefined : VENDOR_EFFORTS[item.effort];
	if (item.model === undefined) return effort === undefined ? {} : { effort };
	if (!surface.model) unsupported("Agent.model", "task.perCallModel is off in this session");
	const selector = claudeCodeModelSelector(item.model, item.subagent_type, host);
	return { model: effort === undefined ? selector : `${selector}:${effort}` };
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
		// Like task's batch shape, a per-spawn field at the top level is refused, never silently dropped.
		for (const field of ["subagent_type", "model", "effort"] as const) {
			if (args[field] !== undefined) {
				throw new ToolError(`Agent.${field} with \`tasks\` is not supported: set it on each \`tasks\` item.`);
			}
		}
		const tasks = args.tasks.map(item => {
			if (item.subagent_type === "fork") {
				throw new ToolError('subagent_type "fork" applies to a single Agent call, not to `tasks` items.');
			}
			return {
				task: item.prompt,
				...(item.subagent_type !== undefined ? { agent: item.subagent_type } : {}),
				...claudeCodeSpawnRouting(item, host),
			};
		});
		return { context: args.prompt, tasks, ...isolated };
	}
	// `subagent_type: "fork"` forks the conversation, not an agent type:
	// the default task agent runs with the parent's history and model.
	if (args.subagent_type === "fork") return { task: args.prompt, fork: "all", ...isolated };
	return {
		task: args.prompt,
		...(args.subagent_type !== undefined ? { agent: args.subagent_type } : {}),
		...claudeCodeSpawnRouting(args, host),
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

/**
 * `agent://` URL for a facade's recipient string. A `?query` (`?progress` for a
 * quiet note) stays on the URL; the vendor's `main` names omp's main agent.
 */
function agentMessageUrl(recipient: string): string {
	const trimmed = recipient.trim();
	const queryAt = trimmed.indexOf("?");
	const id = queryAt < 0 ? trimmed : trimmed.slice(0, queryAt);
	const query = queryAt < 0 ? "" : trimmed.slice(queryAt);
	return `agent://${id.toLowerCase() === "main" ? MAIN_AGENT_ID : id}${query}`;
}

const CLAUDE_CODE_FACADES: readonly HarnessFacadeSpec[] = [
	{
		target: "task",
		wireName: "Agent",
		replacesTarget: true,
		ownSurface: true,
		description: prompt.render(claudeCodeAgent, { agents: [], defaultAgent: "task", asyncEnabled: true }),
		parameters: claudeCodeAgentSchema({ isolation: false, batch: false, model: false, effort: false }),
		describe: target => (target as AgentTool & TaskToolSurface).renderDescriptionAs?.(claudeCodeAgent),
		schema: host => claudeCodeAgentSchema(claudeCodeAgentSurface(host.settings)),
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
		mounts: peerMessaging,
		toParams: (args: typeof claudeCodeSendMessageSchema.infer) => ({
			path: agentMessageUrl(args.to),
			content: args.message,
		}),
	},
	{
		target: "read",
		wireName: "ListAgents",
		ownSurface: true,
		description: claudeCodeListAgents,
		parameters: claudeCodeListAgentsSchema,
		// It lists whom SendMessage reaches, so it mounts exactly when SendMessage does.
		requires: ["write"],
		mounts: peerMessaging,
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
	target: type("string").describe(
		'Agent id to message (from spawn_agent or list_agents); "all" (main agent only) broadcasts, and a "?progress" suffix sends a progress note.',
	),
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
			let effort: Effort | undefined;
			if (args.reasoning_effort !== undefined) {
				effort = VENDOR_EFFORTS[args.reasoning_effort];
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
			path: agentMessageUrl(args.target),
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
			path: agentMessageUrl(args.target),
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

/** What a harness profile presents over a set of enabled omp tools. */
export interface HarnessSurface {
	/** Facades that mount, in presentation order. */
	readonly facades: readonly HarnessFacadeSpec[];
	/** Enabled tools kept off the wire as themselves: replaced by a mounted facade. */
	readonly hidden: ReadonlySet<string>;
	/** Tool names for omp's own prompt templates; see {@link harnessToolRefs}. */
	readonly toolRefs: Readonly<Record<string, string>>;
}

const NATIVE_SURFACE: HarnessSurface = {
	facades: [],
	hidden: new Set(),
	toolRefs: harnessToolRefs(undefined),
};

/**
 * `profile`'s surface over `enabledToolNames`: the one computation presentation,
 * prompt gates, tool predicates and `toolRefs` all read, so no prompt names a
 * tool the wire does not carry. A facade mounts when its target (and every
 * tool it `requires`) is enabled and registered and its `mounts` predicate
 * accepts the session.
 */
export function harnessSurface(
	profile: HarnessProfile | undefined,
	enabledToolNames: readonly string[],
	host: HarnessFacadeHost,
	isRegistered: (name: string) => boolean = () => true,
): HarnessSurface {
	if (profile === undefined) return NATIVE_SURFACE;
	const enabled = new Set(enabledToolNames);
	const facades = harnessFacadeSpecs(profile).filter(
		spec =>
			enabled.has(spec.target) &&
			isRegistered(spec.target) &&
			(spec.requires ?? []).every(name => enabled.has(name)) &&
			spec.mounts?.(host) !== false,
	);
	return {
		facades,
		hidden: new Set(facades.flatMap(spec => (spec.replacesTarget ? [spec.target] : []))),
		toolRefs: harnessToolRefs(profile, { toolNames: enabledToolNames, facades }),
	};
}
