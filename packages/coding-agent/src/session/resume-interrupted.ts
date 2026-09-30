/**
 * `/recover`: recover the work a previous OMP process left interrupted.
 *
 * A power cut or crash writes no `session_exit` marker, so a resumed session
 * never learns what was cut off: `buildSessionContext` strips tool calls that
 * have no result, background jobs never deliver, and interrupted subagents
 * stay parked. This module finds that work in the previous process's slice of
 * the branch and restores it: interrupted tool calls get an explicit result,
 * lost background jobs are reported, and interrupted subagents are revived as
 * background jobs that deliver to their parent like a normal spawn.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AsyncJobManager } from "../async";
import { AgentRegistry } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { getBundledAgent } from "../task/agents";
import { discoverAgents, getAgent } from "../task/discovery";
import { runSubagentFollowUpTurn } from "../task/executor";
import type { AgentDefinition } from "../task/types";
import { SESSION_EXIT_CUSTOM_TYPE, summarizeToolArguments, TOOL_EXECUTION_START_CUSTOM_TYPE } from "./exit-diagnostics";
import type { SessionEntry } from "./session-entries";
import { SessionManager } from "./session-manager";

/**
 * Custom type of the entry recording one `/recover` run (idempotency and audit),
 * and of the message that tells the main agent what was recovered.
 */
export const RECOVER_CUSTOM_TYPE = "recover";

/** Result recorded for every tool call the interruption cut off. */
export const INTERRUPTED_TOOL_RESULT_TEXT =
	"A system glitch interrupted this tool call before it finished: the OMP process stopped unexpectedly. It may have partially run. Check the current state, then resume: re-run it if it is still needed.";

const SUBAGENT_RESUME_MESSAGE =
	"A system glitch stopped OMP and interrupted your run. Tool calls marked as interrupted may have partially run. Check the current state and resume your assignment from where you left off; if it is already complete, yield your final report again.";

const LABEL_MAX_CHARS = 120;

export interface InterruptedToolCall {
	toolCallId: string;
	toolName: string;
	label: string;
}

export interface InterruptedJob {
	jobId: string;
	type: "bash" | "eval" | "task";
	label: string;
}

export interface InterruptedWork {
	/** Tool calls of the interrupted turn that never got a result. */
	toolCalls: InterruptedToolCall[];
	/** Whether results can still follow the turn that issued them (nothing else was appended after it). */
	toolCallsRepairable: boolean;
	/** Background bash/eval jobs that started and never finished. */
	jobs: InterruptedJob[];
	/** Subagent spawns that started and never finished; `jobId` is the agent id. */
	agents: InterruptedJob[];
}

export type InterruptedWorkScan = { handled: true } | ({ handled: false } & InterruptedWork);

type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

function isCustom(entry: SessionEntry, customType: string): boolean {
	return entry.type === "custom" && entry.customType === customType;
}

function toolCallsOf(message: AgentMessage): ToolCallBlock[] {
	if (message.role !== "assistant") return [];
	return message.content.filter((block): block is ToolCallBlock => block.type === "toolCall");
}

/** Terminal records a crash or quit leaves behind (e.g. the resume-time "exited before completing" stub). */
function isAbortStub(message: AgentMessage): boolean {
	return (
		message.role === "assistant" &&
		(message.stopReason === "aborted" || message.stopReason === "error") &&
		toolCallsOf(message).length === 0
	);
}

function isActivity(entry: SessionEntry): boolean {
	if (entry.type === "message") return !isAbortStub(entry.message);
	return entry.type === "custom_message" || isCustom(entry, TOOL_EXECUTION_START_CUSTOM_TYPE);
}

function truncate(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > LABEL_MAX_CHARS ? `${oneLine.slice(0, LABEL_MAX_CHARS)}…` : oneLine;
}

function describeCall(name: string, args: unknown): string {
	const summary = summarizeToolArguments(args);
	if (summary?.command) return `${name}: ${truncate(summary.command)}`;
	if (summary?.path) return `${name}: ${truncate(summary.path)}`;
	if (isRecord(args) && typeof args.code === "string") return `${name}: ${truncate(args.code)}`;
	return name;
}

/**
 * Slice of `branch` written by the process that preceded this one: entries
 * before `processStartMs`, cut at `session_exit` markers. With activity after
 * the last marker that process crashed; otherwise it is the one that ended at
 * the last marker (a quit while work was running).
 */
function previousProcessSlice(
	branch: readonly SessionEntry[],
	processStartMs: number,
): { start: number; end: number } | undefined {
	let end = 0;
	while (end < branch.length && Date.parse(branch[end]!.timestamp) < processStartMs) end++;
	let lastExit = -1;
	for (let i = 0; i < end; i++) if (isCustom(branch[i]!, SESSION_EXIT_CUSTOM_TYPE)) lastExit = i;
	for (let i = lastExit + 1; i < end; i++) {
		if (isActivity(branch[i]!)) return { start: lastExit + 1, end };
	}
	if (lastExit < 0) return undefined;
	let previousExit = -1;
	for (let i = 0; i < lastExit; i++) if (isCustom(branch[i]!, SESSION_EXIT_CUSTOM_TYPE)) previousExit = i;
	return { start: previousExit + 1, end: lastExit + 1 };
}

function readRestartedAgents(entry: SessionEntry): InterruptedJob[] {
	if (entry.type !== "custom" || !isRecord(entry.data) || !Array.isArray(entry.data.restarted)) return [];
	return entry.data.restarted
		.filter(isRecord)
		.flatMap(item =>
			typeof item.jobId === "string" && typeof item.label === "string"
				? [{ jobId: item.jobId, type: "task" as const, label: item.label }]
				: [],
		);
}

/**
 * Find the work the previous process left interrupted on `branch`.
 * `processStartMs` separates this process's entries from earlier ones.
 */
export function findInterruptedWork(branch: readonly SessionEntry[], processStartMs: number): InterruptedWorkScan {
	const slice = previousProcessSlice(branch, processStartMs);
	if (!slice) return { handled: false, toolCalls: [], toolCallsRepairable: false, jobs: [], agents: [] };
	for (let i = slice.end; i < branch.length; i++) {
		if (isCustom(branch[i]!, RECOVER_CUSTOM_TYPE)) return { handled: true };
	}
	// A /recover run inside the slice already recovered everything before it;
	// only the subagents it restarted carry over as work that may be cut off again.
	let scanStart = slice.start;
	for (let i = slice.start; i < slice.end; i++) if (isCustom(branch[i]!, RECOVER_CUSTOM_TYPE)) scanStart = i;

	const calls = new Map<string, ToolCallBlock>();
	const open = new Map<string, InterruptedJob[]>();
	const start = (job: InterruptedJob): void => {
		const stack = open.get(job.jobId) ?? [];
		stack.push(job);
		open.set(job.jobId, stack);
	};
	// Job ids are process-local and reused across processes: a finish closes
	// the most recent open start with that id.
	const finish = (jobId: string): void => {
		open.get(jobId)?.pop();
	};
	let turn: { index: number; calls: ToolCallBlock[] } | undefined;

	for (let i = scanStart; i < slice.end; i++) {
		const entry = branch[i]!;
		if (isCustom(entry, RECOVER_CUSTOM_TYPE)) {
			for (const agent of readRestartedAgents(entry)) start(agent);
			continue;
		}
		if (entry.type === "custom_message" && entry.customType === "async-result" && isRecord(entry.details)) {
			const jobs = entry.details.jobs;
			if (Array.isArray(jobs))
				for (const job of jobs) if (isRecord(job) && typeof job.jobId === "string") finish(job.jobId);
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			const blocks = toolCallsOf(message);
			for (const block of blocks) calls.set(block.id, block);
			if (blocks.length > 0) turn = { index: i, calls: blocks };
			else if (!isAbortStub(message)) turn = undefined;
			continue;
		}
		if (message.role !== "toolResult") continue;
		const call = calls.get(message.toolCallId);
		const details = isRecord(message.details) ? message.details : undefined;
		const async = details && isRecord(details.async) ? details.async : undefined;
		if (async?.state === "running" && typeof async.jobId === "string") {
			if (async.type === "bash" || async.type === "eval") {
				start({ jobId: async.jobId, type: async.type, label: describeCall(message.toolName, call?.arguments) });
			} else if (async.type === "task" && Array.isArray(details?.progress)) {
				for (const item of details.progress) {
					if (!isRecord(item) || typeof item.id !== "string") continue;
					if (item.status === "completed" || item.status === "failed" || item.status === "aborted") continue;
					const label = typeof item.description === "string" ? item.description : item.id;
					start({ jobId: item.id, type: "task", label: truncate(label) });
				}
			}
		}
		// A `wait` (or TaskOutput) result reports the jobs it consumed.
		if (details && Array.isArray(details.jobs)) {
			for (const job of details.jobs) {
				if (isRecord(job) && typeof job.id === "string" && job.status !== "running") finish(job.id);
			}
		}
		if (!message.isError && call) {
			const killed =
				typeof call.arguments.path === "string"
					? /^proc:\/\/([^/]+)\/kill$/.exec(call.arguments.path)?.[1]
					: undefined;
			const stopped = call.name === "TaskStop" ? (call.arguments.task_id ?? call.arguments.shell_id) : undefined;
			if (killed) finish(killed);
			if (typeof stopped === "string") finish(stopped);
		}
	}

	const answered = new Set<string>();
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "toolResult") answered.add(entry.message.toolCallId);
	}
	const toolCalls = (turn?.calls ?? [])
		.filter(block => !answered.has(block.id))
		.map(block => ({ toolCallId: block.id, toolName: block.name, label: describeCall(block.name, block.arguments) }));
	// Results must directly follow the turn that issued the calls: anything the
	// model or user said since then rules out appending them.
	let toolCallsRepairable = turn !== undefined;
	for (let i = (turn?.index ?? branch.length) + 1; i < branch.length && toolCallsRepairable; i++) {
		const entry = branch[i]!;
		if (entry.type === "custom_message") toolCallsRepairable = false;
		else if (entry.type === "message" && entry.message.role !== "toolResult" && !isAbortStub(entry.message)) {
			toolCallsRepairable = false;
		}
	}

	const jobs: InterruptedJob[] = [];
	const agents: InterruptedJob[] = [];
	for (const stack of open.values()) {
		for (const job of stack) (job.type === "task" ? agents : jobs).push(job);
	}
	return { handled: false, toolCalls, toolCallsRepairable: toolCalls.length > 0 && toolCallsRepairable, jobs, agents };
}

/** Record the interruption result for each cut-off tool call, right after the turn that issued it. */
export function appendInterruptedToolResults(
	sessionManager: SessionManager,
	calls: readonly InterruptedToolCall[],
	now = Date.now(),
): void {
	for (const call of calls) {
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }],
			isError: true,
			timestamp: now,
		};
		sessionManager.appendMessage(result);
	}
}

function bulletList(items: readonly string[]): string {
	return items.map(item => `- ${item}`).join("\n");
}

/** A job's id, plus its label when the label adds something (a subagent's label is often its id). */
function jobName(job: InterruptedJob): string {
	return job.label === job.jobId ? `\`${job.jobId}\`` : `\`${job.jobId}\` (${job.label})`;
}

function jobLine(job: InterruptedJob): string {
	return `${jobName(job)}: a system glitch stopped it before it finished; it may have partially run. Re-run it if it is still needed.`;
}

/** Repair a parked subagent's own transcript and describe what else it lost, for its resume prompt. */
async function prepareSubagent(sessionFile: string, processStartMs: number): Promise<string> {
	const manager = await SessionManager.open(sessionFile);
	try {
		const scan = findInterruptedWork(manager.getBranch(), processStartMs);
		if (scan.handled) return SUBAGENT_RESUME_MESSAGE;
		if (scan.toolCallsRepairable) appendInterruptedToolResults(manager, scan.toolCalls);
		const lost = [
			...scan.jobs.map(jobLine),
			...scan.agents.map(agent => `subagent ${jobName(agent)} was interrupted too; message it to resume it.`),
		];
		return lost.length > 0
			? `${SUBAGENT_RESUME_MESSAGE}\n\nAlso interrupted:\n${bulletList(lost)}`
			: SUBAGENT_RESUME_MESSAGE;
	} finally {
		await manager.close();
	}
}

async function resolveAgentDefinition(sessionFile: string, cwd: string): Promise<AgentDefinition | undefined> {
	const name = (await SessionManager.peekSessionInit(sessionFile))?.init?.agent;
	if (name) {
		const discovered = getAgent((await discoverAgents(cwd)).agents, name) ?? getBundledAgent(name);
		if (discovered) return discovered;
	}
	return getBundledAgent("task");
}

/** The part of an `AgentSession` `/recover` works through. */
export interface RecoverHost {
	readonly sessionManager: SessionManager;
	readonly asyncJobManager: AsyncJobManager | undefined;
	readonly agent: { replaceMessages(messages: AgentMessage[]): void };
	buildDisplaySessionContext(): { messages: AgentMessage[] };
	getAgentId(): string | undefined;
}

/** `handled`: an earlier `/recover` already recovered this interruption. */
export type RecoverOutcome =
	| { status: "nothing" | "handled" }
	| {
			status: "resumed";
			/** Message for the main agent, which continues from it. */
			notice: string;
			/** One-line account for the user. */
			summary: string;
			restarted: InterruptedJob[];
	  };

export const RECOVER_IDLE_TEXT: Record<"nothing" | "handled", string> = {
	nothing: "Nothing to recover: the previous session ended with no interrupted work.",
	handled: "Nothing left to recover: /recover already handled this interruption.",
};

function count(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Recover the previous process's interrupted work on `host`'s session. The
 * caller starts the main agent's turn with {@link RecoverOutcome.notice}.
 */
export async function resumeInterruptedWork(
	host: RecoverHost,
	processStartMs: number = performance.timeOrigin,
): Promise<RecoverOutcome> {
	const sessionManager = host.sessionManager;
	const scan = findInterruptedWork(sessionManager.getBranch(), processStartMs);
	if (scan.handled) return { status: "handled" };
	if (scan.toolCalls.length === 0 && scan.jobs.length === 0 && scan.agents.length === 0) {
		return { status: "nothing" };
	}

	if (scan.toolCallsRepairable) {
		appendInterruptedToolResults(sessionManager, scan.toolCalls);
		host.agent.replaceMessages(host.buildDisplaySessionContext().messages);
	}

	const restarted: InterruptedJob[] = [];
	const notResumed: string[] = [];
	if (scan.agents.length > 0) {
		const registry = AgentRegistry.global();
		const rootSessionFile = sessionManager.getSessionFile();
		await ensurePersistedRoster(registry, rootSessionFile);
		const manager = host.asyncJobManager;
		const artifactsDir = rootSessionFile?.slice(0, -".jsonl".length);
		for (const interrupted of scan.agents) {
			const sessionFile = registry.get(interrupted.jobId)?.sessionFile;
			if (!sessionFile) {
				notResumed.push(`${jobName(interrupted)}: its transcript was not found.`);
				continue;
			}
			if (!manager) {
				notResumed.push(`${jobName(interrupted)}: background jobs are disabled.`);
				continue;
			}
			const message = await prepareSubagent(sessionFile, processStartMs);
			const agent = await resolveAgentDefinition(sessionFile, sessionManager.getCwd());
			if (!agent) {
				notResumed.push(`${jobName(interrupted)}: its agent definition was not found.`);
				continue;
			}
			try {
				manager.register(
					"task",
					interrupted.jobId,
					async ({ signal }) => {
						const result = await runSubagentFollowUpTurn({
							id: interrupted.jobId,
							agent,
							message,
							description: interrupted.label,
							signal,
							artifactsDir,
						});
						if (result.aborted) throw new Error(`Resumed ${interrupted.jobId} was cancelled.`);
						if (result.exitCode !== 0 || result.error) {
							throw new Error(
								`Resumed ${interrupted.jobId} failed: ${result.error ?? result.stderr ?? "unknown error"}`,
							);
						}
						return result.output.trim() || `(${interrupted.jobId} finished without a report)`;
					},
					{ id: interrupted.jobId, agentId: interrupted.jobId, ownerId: host.getAgentId() },
				);
				restarted.push(interrupted);
			} catch (error) {
				notResumed.push(`${jobName(interrupted)}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	sessionManager.appendCustomEntry(RECOVER_CUSTOM_TYPE, {
		toolCalls: scan.toolCalls.map(call => call.toolCallId),
		jobs: scan.jobs.map(job => job.jobId),
		restarted,
	});

	const sections: string[] = ["A system glitch stopped OMP. Resumed after the interruption:"];
	if (scan.toolCalls.length > 0) {
		const lead = scan.toolCallsRepairable
			? "Interrupted tool calls (each now carries an interruption result; it may have partially run):"
			: "Interrupted tool calls (a system glitch stopped them before they recorded a result; they may have partially run, so check the current state and re-run them if they are still needed):";
		sections.push(`${lead}\n${bulletList(scan.toolCalls.map(call => `\`${call.toolCallId}\` ${call.label}`))}`);
	}
	if (scan.jobs.length > 0) sections.push(`Lost background jobs:\n${bulletList(scan.jobs.map(jobLine))}`);
	if (restarted.length > 0) {
		sections.push(
			`Restarted subagents (their results arrive as they finish):\n${bulletList(restarted.map(jobName))}`,
		);
	}
	if (notResumed.length > 0) sections.push(`Subagents not restarted:\n${bulletList(notResumed)}`);
	sections.push("Continue your work.");
	const summary = [
		`Resumed: ${count(scan.toolCalls.length, "interrupted tool call")}`,
		count(scan.jobs.length, "lost background job"),
		`${count(restarted.length, "subagent")} restarted${notResumed.length > 0 ? ` (${notResumed.length} could not be)` : ""}`,
	].join(", ");
	return { status: "resumed", notice: sections.join("\n\n"), summary, restarted };
}
