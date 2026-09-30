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
 *
 * The parent's journal only says which subagents it started and heard nothing
 * from since; each subagent's own transcript says whether the previous process
 * cut it off mid-work (restart it) or whether it had finished (deliver the
 * result that never reached the parent, or leave it be).
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { StructuredSubagentOutput, YieldItem } from "@oh-my-pi/pi-tui/tools/task";
import { isRecord } from "@oh-my-pi/pi-utils";
import { AsyncJobError, type AsyncJobManager } from "../async";
import { AgentRegistry } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { getBundledAgent, resolveRetiredAgentName } from "../task/agents";
import { discoverAgents, getAgent } from "../task/discovery";
import { finalizeSubprocessOutput, runSubagentFollowUpTurn } from "../task/executor";
import { type SubprocessToolEvent, subprocessToolRegistry } from "../task/subprocess-tool-registry";
import type { AgentDefinition } from "../task/types";
import type { EventBus } from "../utils/event-bus";
import { ASYNC_RESULT_MESSAGE_TYPE } from "./async-job-delivery";
import {
	SESSION_EXIT_CUSTOM_TYPE,
	SESSION_OPEN_CUSTOM_TYPE,
	summarizeToolArguments,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
} from "./exit-diagnostics";
import type { SessionEntry } from "./session-entries";
import { type PersistedSessionInit, SessionManager } from "./session-manager";

/**
 * Custom type of the entry recording one `/recover` run (idempotency and audit),
 * and of the message that tells the main agent what was recovered.
 */
export const RECOVER_CUSTOM_TYPE = "recover";

/**
 * Custom type of the entry a `/recover` run appends once it has handled its
 * subagents: which of them it restarted and whose report it delivered, so a
 * later scan counts only those as still pending until the parent's journal
 * shows their results.
 */
export const RECOVER_OUTCOME_CUSTOM_TYPE = "recover_outcome";

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
	/** When the parent last started it, in epoch ms (subagents only); unknown for legacy records. */
	startedAt?: number;
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
	/** When the previous process began (unbounded when the file shows no earlier process) and, if it quit, when. */
	process: ProcessSpan;
}

/** The time span of one process's work on a session, in epoch ms. */
export interface ProcessSpan {
	since: number;
	exitedAt?: number;
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

function isStoppedTurn(message: AgentMessage): boolean {
	return message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error");
}

/** Terminal records a crash or quit leaves behind (e.g. the resume-time "exited before completing" stub). */
function isAbortStub(message: AgentMessage): boolean {
	return isStoppedTurn(message) && toolCallsOf(message).length === 0;
}

/**
 * Whether `entry` shows a process working, as opposed to one unwinding: a quit
 * writes `session_exit` first and only then aborts, so the aborted turn and
 * tool results it settles land after its own exit marker.
 */
function isActivity(entry: SessionEntry): boolean {
	if (entry.type === "message") return entry.message.role !== "toolResult" && !isStoppedTurn(entry.message);
	return entry.type === "custom_message" || isCustom(entry, TOOL_EXECUTION_START_CUSTOM_TYPE);
}

function isOpenedByThisProcess(entry: SessionEntry): boolean {
	return (
		entry.type === "custom" &&
		entry.customType === SESSION_OPEN_CUSTOM_TYPE &&
		isRecord(entry.data) &&
		entry.data.pid === process.pid &&
		entry.data.processStartedAt === performance.timeOrigin
	);
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

function hasActivity(branch: readonly SessionEntry[], start: number, end: number): boolean {
	for (let i = start; i < end; i++) if (isActivity(branch[i]!)) return true;
	return false;
}

/**
 * Slice of `branch` written by the last process before this one that did any
 * work. It ends where this process opened the file (the whole branch for a
 * parked subagent's transcript) and starts at that process's `session_open`
 * marker; a process that only opened the file and left interrupted nothing,
 * so the scan steps past it. Files older than those markers fall back to
 * `session_exit` markers: with activity after the last one that process
 * crashed; otherwise it is the one that ended there, together with the
 * records it wrote while unwinding.
 */
function previousProcessSlice(branch: readonly SessionEntry[]): { start: number; end: number } | undefined {
	let end = branch.findIndex(isOpenedByThisProcess);
	if (end < 0) end = branch.length;
	for (let i = end - 1; i >= 0; i--) {
		if (!isCustom(branch[i]!, SESSION_OPEN_CUSTOM_TYPE)) continue;
		if (hasActivity(branch, i + 1, end)) return { start: i + 1, end };
		end = i;
	}
	let lastExit = -1;
	for (let i = 0; i < end; i++) if (isCustom(branch[i]!, SESSION_EXIT_CUSTOM_TYPE)) lastExit = i;
	if (hasActivity(branch, lastExit + 1, end)) return { start: lastExit + 1, end };
	if (lastExit < 0) return undefined;
	let previousExit = -1;
	for (let i = 0; i < lastExit; i++) if (isCustom(branch[i]!, SESSION_EXIT_CUSTOM_TYPE)) previousExit = i;
	return { start: previousExit + 1, end };
}

function entryTime(entry: SessionEntry): number {
	return Date.parse(entry.timestamp);
}

/**
 * Subagent records of a `/recover` entry, started at `restartedAt` when given,
 * else when the parent last started them before it (unknown for legacy
 * records, and for bare ids an older outcome wrote).
 */
function agentsOf(value: unknown, restartedAt?: number): InterruptedJob[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(item => {
		if (typeof item === "string")
			return [{ jobId: item, type: "task" as const, label: item, startedAt: restartedAt }];
		if (!isRecord(item) || typeof item.jobId !== "string" || typeof item.label !== "string") return [];
		const startedAt = restartedAt ?? (typeof item.startedAt === "number" ? item.startedAt : undefined);
		return [{ jobId: item.jobId, type: "task" as const, label: item.label, startedAt }];
	});
}

/**
 * The subagents the `/recover` run recorded at `branch[index]` left pending:
 * those it restarted (started again then) and those whose report it delivered
 * (still owed until the parent's journal shows the result), per its outcome
 * entry; or every one it considered, as started when the parent last started
 * them, when it never recorded an outcome (an older run, or one cut off while
 * restarting).
 */
function pendingAfterRecover(branch: readonly SessionEntry[], index: number, end: number): InterruptedJob[] {
	const entry = branch[index]!;
	if (entry.type !== "custom" || !isRecord(entry.data)) return [];
	for (let i = index + 1; i < end; i++) {
		const next = branch[i]!;
		if (isCustom(next, RECOVER_CUSTOM_TYPE)) break;
		if (next.type === "custom" && next.customType === RECOVER_OUTCOME_CUSTOM_TYPE && isRecord(next.data)) {
			return [...agentsOf(next.data.restarted, entryTime(entry)), ...agentsOf(next.data.recovered)];
		}
	}
	return agentsOf(entry.data.agents);
}

/**
 * Where a transcript's own work starts: after its first `session_init`. A
 * fork child's journal opens with the parent's history copied in (with fresh
 * timestamps); that work, jobs and yields included, is the parent's.
 */
function ownedStart(branch: readonly SessionEntry[]): number {
	return branch.findIndex(entry => entry.type === "session_init") + 1;
}

/** Records of jobs a `wait`, `jobs`, `cancel` or `proc://` result reports, top-level or under `proc`. */
function reportedJobs(details: Record<string, unknown> | undefined): Record<string, unknown>[] {
	const proc = details && isRecord(details.proc) ? details.proc : undefined;
	return [details?.jobs, proc?.jobs, proc?.cancelled].flatMap(list =>
		Array.isArray(list) ? list.filter(isRecord) : [],
	);
}

/** Work started in `branch[from..to)` and whether it finished, plus the last turn that issued tool calls. */
interface WorkScan {
	turn: { index: number; calls: ToolCallBlock[] } | undefined;
	/** Starts still open per job id; a finish closes the most recent start with that id. */
	open: Map<string, InterruptedJob[]>;
}

/**
 * `ownsRevived` says whether an agent the transcript's owner revived by
 * messaging it is that owner's work: a revived agent's run delivers to its
 * parent, not to whoever messaged it.
 */
function scanWork(
	branch: readonly SessionEntry[],
	from: number,
	to: number,
	ownsRevived: (agentId: string) => boolean = () => true,
): WorkScan {
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
	let turn: WorkScan["turn"];

	for (let i = from; i < to; i++) {
		const entry = branch[i]!;
		if (isCustom(entry, RECOVER_CUSTOM_TYPE)) {
			for (const agent of pendingAfterRecover(branch, i, to)) start(agent);
			continue;
		}
		if (
			entry.type === "custom_message" &&
			entry.customType === ASYNC_RESULT_MESSAGE_TYPE &&
			isRecord(entry.details)
		) {
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
		const startedAt = entryTime(entry);
		if (async?.state === "running" && typeof async.jobId === "string") {
			if (async.type === "bash" || async.type === "eval") {
				start({ jobId: async.jobId, type: async.type, label: describeCall(message.toolName, call?.arguments) });
			} else if (async.type === "task" && Array.isArray(details?.progress)) {
				for (const item of details.progress) {
					if (!isRecord(item) || typeof item.id !== "string") continue;
					if (item.status === "completed" || item.status === "failed" || item.status === "aborted") continue;
					const label = typeof item.description === "string" ? item.description : item.id;
					start({ jobId: item.id, type: "task", label: truncate(label), startedAt });
				}
			}
		}
		// Messaging a parked agent revives it for a new run, which delivers its result like a spawn.
		const sent = details && isRecord(details.message) ? details.message : undefined;
		if (sent && Array.isArray(sent.receipts)) {
			for (const receipt of sent.receipts) {
				if (
					isRecord(receipt) &&
					receipt.outcome === "revived" &&
					typeof receipt.to === "string" &&
					ownsRevived(receipt.to)
				) {
					start({ jobId: receipt.to, type: "task", label: receipt.to, startedAt });
				}
			}
		}
		// A `wait` (or TaskOutput), job-control or `proc://` result reports the
		// jobs it consumed or stopped, including kills through a harness facade.
		for (const job of reportedJobs(details)) {
			if (typeof job.id === "string" && job.status !== "running") finish(job.id);
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
	return { turn, open };
}

/** Find the work the previous process left interrupted on `branch`. */
export function findInterruptedWork(branch: readonly SessionEntry[]): InterruptedWorkScan {
	const slice = previousProcessSlice(branch);
	if (!slice) {
		return {
			handled: false,
			toolCalls: [],
			toolCallsRepairable: false,
			jobs: [],
			agents: [],
			process: { since: Number.NEGATIVE_INFINITY },
		};
	}
	for (let i = slice.end; i < branch.length; i++) {
		if (isCustom(branch[i]!, RECOVER_CUSTOM_TYPE)) return { handled: true };
	}
	// A /recover run inside the slice already recovered everything before it;
	// only the subagents it left pending carry over.
	let scanStart = Math.max(slice.start, ownedStart(branch));
	for (let i = scanStart; i < slice.end; i++) if (isCustom(branch[i]!, RECOVER_CUSTOM_TYPE)) scanStart = i;
	const { turn, open } = scanWork(branch, scanStart, slice.end);

	// Only results after the turn answer it: providers can reuse tool-call ids across turns.
	const answered = new Set<string>();
	for (let i = (turn?.index ?? branch.length) + 1; i < branch.length; i++) {
		const entry = branch[i]!;
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
		// An agent runs once at a time, so it is restarted once however often it was started.
		const latest = stack.at(-1);
		if (latest?.type === "task") agents.push(latest);
		else jobs.push(...stack);
	}
	let exitedAt: number | undefined;
	for (let i = slice.start; i < slice.end; i++) {
		if (isCustom(branch[i]!, SESSION_EXIT_CUSTOM_TYPE)) exitedAt = entryTime(branch[i]!);
	}
	// Opened after an earlier process: that marker is where this one began.
	const opener = branch[slice.start - 1];
	const since =
		opener && (isCustom(opener, SESSION_OPEN_CUSTOM_TYPE) || isCustom(opener, SESSION_EXIT_CUSTOM_TYPE))
			? entryTime(opener)
			: Number.NEGATIVE_INFINITY;
	return {
		handled: false,
		toolCalls,
		toolCallsRepairable: toolCalls.length > 0 && toolCallsRepairable,
		jobs,
		agents,
		process: { since, exitedAt },
	};
}

/**
 * A finished subagent's last report: its run's result as the executor
 * finalizes it from the run's yields, or else the text it last answered with.
 */
interface SubagentReport {
	text: string;
	structured?: StructuredSubagentOutput;
	/** Set when the finalized result is a failure (schema violation, aborted yield). */
	error?: string;
	/** When it was written, epoch ms. */
	at: number;
	yielded: boolean;
	/** For a text answer: when the run that wrote it last took a prompt, epoch ms. */
	promptedAt?: number;
}

/** How a subagent's own transcript left it when the previous process ended. */
type SubagentState = { status: "interrupted" } | { status: "finished"; report: SubagentReport | undefined };

/** The output contract a subagent's result is finalized against. */
type OutputContract = Pick<PersistedSessionInit, "outputSchema" | "outputSchemaMode"> | null | undefined;

function isPrompt(entry: SessionEntry): boolean {
	if (entry.type === "message") return entry.message.role === "user" || entry.message.role === "developer";
	return (
		entry.type === "custom_message" &&
		(entry.customType === "irc:incoming" || entry.customType === ASYNC_RESULT_MESSAGE_TYPE)
	);
}

function textOf(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return message.content
		.flatMap(block => (block.type === "text" ? [block.text] : []))
		.join("\n")
		.trim();
}

/** A `yield` call and its recorded result, as the executor's yield handler reads them. */
function yieldEvent(call: ToolCallBlock, result: ToolResultMessage): SubprocessToolEvent {
	return {
		toolName: call.name,
		toolCallId: call.id,
		args: call.arguments,
		result: { content: result.content, details: result.details },
		isError: result.isError,
	};
}

/**
 * Whether the agent loop stops after `message` instead of sampling again: a
 * text-only `stop` that is not a `pause_turn`, or a tool turn a terminal
 * `yield` ended. A tool turn whose calls are merely answered is not an end:
 * the loop runs another inference on those results.
 */
function endsRun(message: AgentMessage, results: ReadonlyMap<string, ToolResultMessage>): boolean {
	if (message.role !== "assistant") return false;
	const calls = toolCallsOf(message);
	if (calls.length === 0) return message.stopReason === "stop" && message.stopDetails?.type !== "pause_turn";
	const handler = subprocessToolRegistry.getHandler("yield");
	return calls.some(call => {
		const result = results.get(call.id);
		if (call.name !== "yield" || !result || result.isError) return false;
		return handler?.shouldTerminate?.(yieldEvent(call, result)) ?? true;
	});
}

/**
 * The report of the run in `branch[from..end)`: its yields folded and
 * validated by {@link finalizeSubprocessOutput} exactly as the executor
 * finalizes a live run (sections, data-less finalizes, last-turn results,
 * aborted yields), or else the text its last turn answered with.
 */
function runReport(
	branch: readonly SessionEntry[],
	from: number,
	end: number,
	results: ReadonlyMap<string, ToolResultMessage>,
	contract: OutputContract,
	promptedAt: number | undefined,
): SubagentReport | undefined {
	const handler = subprocessToolRegistry.getHandler("yield");
	const items: YieldItem[] = [];
	let yieldedAt = 0;
	// As the run monitor tracks it: the latest report turn's text, dropped by a
	// turn that started more work.
	let reportTurnText: string | undefined;
	let lastAnswer: { text: string; at: number } | undefined;
	for (let i = from; i < end; i++) {
		const entry = branch[i]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		const calls = toolCallsOf(message);
		const text = message.content
			.flatMap(block => (block.type === "text" && block.text ? [block.text] : []))
			.join("\n");
		if (calls.some(call => call.name !== "yield")) reportTurnText = undefined;
		else if (text.trim()) reportTurnText = text;
		lastAnswer =
			calls.length === 0 && message.stopReason === "stop" && text.trim()
				? { text: textOf(message), at: entryTime(entry) }
				: undefined;
		for (const call of calls) {
			const result = results.get(call.id);
			if (call.name !== "yield" || !result) continue;
			const item = handler?.extractData?.(yieldEvent(call, result));
			if (!isRecord(item)) continue;
			items.push(item as YieldItem);
			yieldedAt = entryTime(entry);
		}
	}
	if (items.length === 0) {
		return lastAnswer && { text: lastAnswer.text, at: lastAnswer.at, yielded: false, promptedAt };
	}
	const finalized = finalizeSubprocessOutput({
		rawOutput: reportTurnText ?? "",
		exitCode: 0,
		stderr: "",
		doneAborted: false,
		signalAborted: false,
		yieldItems: items,
		outputSchema: contract?.outputSchema,
		outputSchemaMode: contract?.outputSchemaMode,
		lastAssistantText: reportTurnText,
	});
	const failed = finalized.exitCode !== 0 || finalized.abortedViaYield;
	return {
		text: finalized.rawOutput,
		structured: finalized.structuredOutput,
		error: failed ? finalized.stderr || "the subagent aborted its task" : undefined,
		at: yieldedAt,
		yielded: true,
	};
}

/**
 * Judge parked subagent `id` from its own transcript: `span` is the previous
 * process's, `startedAt` when the parent last started the subagent (unknown:
 * unbounded), and `contract` the output contract its results are finalized
 * against.
 *
 * It was cut off mid-work when, among what that process wrote, a tool call or
 * an owned background job it started has no result, a prompt has no answer,
 * the process's quit aborted a turn, or its last turn is not one the agent
 * loop stops at ({@link endsRun}). Calls an older process left dangling do not
 * count, nor do peers it messaged (their runs report to their own parents),
 * nor history a fork copied in before its own work began. Otherwise it had
 * finished: its report is its run's result since `startedAt`
 * ({@link runReport}).
 */
function inspectSubagent(
	branch: readonly SessionEntry[],
	id: string,
	span: ProcessSpan,
	startedAt: number,
	contract: OutputContract,
): SubagentState {
	let end = branch.findIndex(isOpenedByThisProcess);
	if (end < 0) end = branch.length;
	const owned = ownedStart(branch);
	let from = branch.findIndex((entry, i) => i >= owned && entryTime(entry) >= span.since);
	if (from < 0 || from > end) from = end;
	const registry = AgentRegistry.global();
	const { turn, open } = scanWork(branch, from, end, agentId => registry.get(agentId)?.parentId === id);
	const answered = new Set<string>();
	for (let i = (turn?.index ?? end) + 1; i < end; i++) {
		const entry = branch[i]!;
		if (entry.type === "message" && entry.message.role === "toolResult") answered.add(entry.message.toolCallId);
	}
	if (turn?.calls.some(call => !answered.has(call.id))) return { status: "interrupted" };
	if ([...open.values()].some(stack => stack.length > 0)) return { status: "interrupted" };
	let lastAssistant = -1;
	for (let i = end - 1; i >= owned && lastAssistant < 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "message" && entry.message.role === "assistant") lastAssistant = i;
	}
	for (let i = Math.max(from, lastAssistant + 1); i < end; i++) {
		if (isPrompt(branch[i]!)) return { status: "interrupted" };
	}
	const { exitedAt } = span;
	for (let i = from; i < end && exitedAt !== undefined; i++) {
		const entry = branch[i]!;
		if (entryTime(entry) < exitedAt || entry.type !== "message") continue;
		const message = entry.message;
		if (isStoppedTurn(message) || (message.role === "toolResult" && message.isError))
			return { status: "interrupted" };
	}

	const results = new Map<string, ToolResultMessage>();
	let promptedAt: number | undefined;
	for (let i = owned; i < end; i++) {
		const entry = branch[i]!;
		if (isPrompt(entry)) promptedAt = entryTime(entry);
		if (entry.type === "message" && entry.message.role === "toolResult") {
			results.set(entry.message.toolCallId, entry.message);
		}
	}
	const last = branch[lastAssistant];
	if (last?.type !== "message" || !endsRun(last.message, results)) return { status: "interrupted" };
	let runStart = branch.findIndex((entry, i) => i >= owned && entryTime(entry) >= startedAt);
	if (runStart < 0) runStart = end;
	return { status: "finished", report: runReport(branch, runStart, end, results, contract, promptedAt) };
}

/**
 * Whether `report` of subagent `id` reached the parent whose journal is
 * `branch`: its job's result was delivered or read, or it messaged the parent.
 * A `yield` counts from when it was made; a text answer, from the prompt its
 * run last took, since a message the subagent sent the parent during that run
 * answers it (the wake relay's own already-messaged rule).
 */
function reachedParent(branch: readonly SessionEntry[], id: string, report: SubagentReport): boolean {
	const since = report.yielded ? report.at : (report.promptedAt ?? report.at);
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entryTime(entry) < since) break;
		if (entry.type === "custom_message" && isRecord(entry.details)) {
			const { details } = entry;
			if (entry.customType === "irc:incoming" && details.from === id) return true;
			if (
				entry.customType === ASYNC_RESULT_MESSAGE_TYPE &&
				Array.isArray(details.jobs) &&
				details.jobs.some(job => isRecord(job) && job.jobId === id)
			) {
				return true;
			}
		}
		if (entry.type === "message" && entry.message.role === "toolResult") {
			const details = isRecord(entry.message.details) ? entry.message.details : undefined;
			if (reportedJobs(details).some(job => job.id === id && job.status !== "running")) return true;
		}
	}
	return false;
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

/**
 * Open a parked subagent's transcript and judge it ({@link inspectSubagent}).
 * One the previous process cut off gets its interrupted tool calls repaired,
 * and the resume prompt describing what else it lost.
 */
async function prepareSubagent(
	sessionFile: string,
	id: string,
	span: ProcessSpan,
	startedAt: number,
	contract: OutputContract,
): Promise<{ status: "interrupted"; message: string } | { status: "finished"; report: SubagentReport | undefined }> {
	const manager = await SessionManager.open(sessionFile, undefined, undefined, {
		suppressBreadcrumb: true,
		throwIfMissing: true,
	});
	try {
		const state = inspectSubagent(manager.getBranch(), id, span, startedAt, contract);
		if (state.status === "finished") return state;
		const scan = findInterruptedWork(manager.getBranch());
		if (scan.handled) return { status: "interrupted", message: SUBAGENT_RESUME_MESSAGE };
		if (scan.toolCallsRepairable) appendInterruptedToolResults(manager, scan.toolCalls);
		const lost = [
			...scan.jobs.map(jobLine),
			...scan.agents.map(agent => `subagent ${jobName(agent)} was interrupted too; message it to resume it.`),
		];
		return {
			status: "interrupted",
			message:
				lost.length > 0
					? `${SUBAGENT_RESUME_MESSAGE}\n\nAlso interrupted:\n${bulletList(lost)}`
					: SUBAGENT_RESUME_MESSAGE,
		};
	} finally {
		await manager.close();
	}
}

async function resolveAgentDefinition(
	name: string | undefined,
	discovered: () => Promise<AgentDefinition[]>,
): Promise<AgentDefinition | undefined> {
	if (name) {
		const agent = getAgent(await discovered(), name) ?? getBundledAgent(resolveRetiredAgentName(name));
		if (agent) return agent;
	}
	return getBundledAgent("task");
}

/** The part of an `AgentSession` `/recover` works through. */
export interface RecoverHost {
	readonly sessionManager: SessionManager;
	readonly asyncJobManager: AsyncJobManager | undefined;
	/** Buses a restarted subagent announces itself on, so it shows in the running-subagents list like a spawn. */
	readonly eventBus: EventBus | undefined;
	readonly subagentEventBus: EventBus | undefined;
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
			/** Subagents cut off mid-work, restarted. */
			restarted: InterruptedJob[];
			/** Finished subagents whose last report never reached the parent; delivered now. */
			recovered: InterruptedJob[];
			/** Finished subagents with nothing lost. */
			skipped: InterruptedJob[];
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
export async function resumeInterruptedWork(host: RecoverHost): Promise<RecoverOutcome> {
	const sessionManager = host.sessionManager;
	const scan = findInterruptedWork(sessionManager.getBranch());
	if (scan.handled) return { status: "handled" };
	if (scan.toolCalls.length === 0 && scan.jobs.length === 0 && scan.agents.length === 0) {
		return { status: "nothing" };
	}

	if (scan.toolCallsRepairable) {
		appendInterruptedToolResults(sessionManager, scan.toolCalls);
		host.agent.replaceMessages(host.buildDisplaySessionContext().messages);
	}
	// Recorded before the first await: a second /recover while this one is still
	// restarting subagents, or after it throws, must not restart them again.
	sessionManager.appendCustomEntry(RECOVER_CUSTOM_TYPE, {
		toolCalls: scan.toolCalls.map(call => call.toolCallId),
		jobs: scan.jobs.map(job => job.jobId),
		agents: scan.agents,
	});

	const restarted: InterruptedJob[] = [];
	const recovered: InterruptedJob[] = [];
	const skipped: string[] = [];
	const skippedJobs: InterruptedJob[] = [];
	const notResumed: string[] = [];
	if (scan.agents.length > 0) {
		const registry = AgentRegistry.global();
		const rootSessionFile = sessionManager.getSessionFile();
		await ensurePersistedRoster(registry, rootSessionFile);
		const manager = host.asyncJobManager;
		const ownerId = host.getAgentId();
		const artifactsDir = rootSessionFile?.slice(0, -".jsonl".length);
		let discovery: Promise<AgentDefinition[]> | undefined;
		const discovered = (): Promise<AgentDefinition[]> => {
			discovery ??= discoverAgents(sessionManager.getCwd()).then(result => result.agents);
			return discovery;
		};
		for (const interrupted of scan.agents) {
			const ref = registry.get(interrupted.jobId);
			if (!ref?.sessionFile) {
				notResumed.push(`${jobName(interrupted)}: its transcript was not found.`);
				continue;
			}
			if (ref.session) {
				notResumed.push(`${jobName(interrupted)}: it is already running in this session.`);
				continue;
			}
			if (!manager) {
				notResumed.push(`${jobName(interrupted)}: background jobs are disabled.`);
				continue;
			}
			const sessionFile = ref.sessionFile;
			try {
				const init = (await SessionManager.peekSessionInit(sessionFile))?.init;
				const prepared = await prepareSubagent(
					sessionFile,
					interrupted.jobId,
					scan.process,
					interrupted.startedAt ?? Number.NEGATIVE_INFINITY,
					init,
				);
				if (prepared.status === "finished") {
					const { report } = prepared;
					if (!report || reachedParent(sessionManager.getBranch(), interrupted.jobId, report)) {
						skipped.push(
							`${jobName(interrupted)}: ${report ? "its last report already reached you." : "it stopped without a report."}`,
						);
						skippedJobs.push(interrupted);
						continue;
					}
					// Delivered like a restarted run's result: through a job this agent owns.
					const lead = `Recovered result of \`${interrupted.jobId}\`: it finished before OMP stopped, but this ${report.yielded ? "result" : "answer"} never reached you.`;
					const { structured, error } = report;
					manager.register(
						"task",
						interrupted.jobId,
						async () => {
							if (error) throw new AsyncJobError(`${lead} It failed: ${error}\n\n${report.text}`, structured);
							const text = `${lead}\n\n${report.text}`;
							return structured ? { text, structured } : text;
						},
						{ id: interrupted.jobId, agentId: interrupted.jobId, ownerId },
					);
					recovered.push(interrupted);
					continue;
				}
				const agent = await resolveAgentDefinition(init?.agent, discovered);
				if (!agent) {
					notResumed.push(`${jobName(interrupted)}: its agent definition was not found.`);
					continue;
				}
				const { message } = prepared;
				manager.register(
					"task",
					interrupted.jobId,
					async ({ signal }) => {
						const result = await runSubagentFollowUpTurn({
							id: interrupted.jobId,
							agent,
							message,
							description: interrupted.label,
							outputSchema: init?.outputSchema,
							outputSchemaMode: init?.outputSchemaMode,
							signal,
							eventBus: host.eventBus,
							subagentEventBus: host.subagentEventBus,
							artifactsDir,
							resultOwnerId: ownerId,
						});
						const text = result.output.trim() || `(${interrupted.jobId} finished without a report)`;
						const structured = result.structuredOutput;
						if (result.aborted || result.exitCode !== 0 || result.error) {
							const reason = result.aborted
								? "was cancelled"
								: `failed: ${result.error ?? result.stderr ?? "unknown error"}`;
							throw new AsyncJobError(`Resumed ${interrupted.jobId} ${reason}\n\n${text}`, structured);
						}
						return structured ? { text, structured } : text;
					},
					{ id: interrupted.jobId, agentId: interrupted.jobId, ownerId },
				);
				restarted.push(interrupted);
			} catch (error) {
				notResumed.push(`${jobName(interrupted)}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		// A later scan counts only these as pending: restarted ones as started
		// again, recovered ones (with their original start) until the parent's
		// journal shows the delivered result. The rest were finished or could
		// not be restarted.
		sessionManager.appendCustomEntry(RECOVER_OUTCOME_CUSTOM_TYPE, {
			restarted,
			recovered,
			skipped: skippedJobs.map(agent => agent.jobId),
		});
	}

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
			`Restarted subagents (cut off mid-work; their results arrive as they finish):\n${bulletList(restarted.map(jobName))}`,
		);
	}
	if (recovered.length > 0) {
		sections.push(
			`Recovered results (these subagents had finished, but their last report never reached you; it arrives now as their result):\n${bulletList(recovered.map(jobName))}`,
		);
	}
	if (skipped.length > 0) sections.push(`Skipped subagents (finished; nothing to recover):\n${bulletList(skipped)}`);
	if (notResumed.length > 0) sections.push(`Subagents not restarted:\n${bulletList(notResumed)}`);
	sections.push("Continue your work.");
	const summary = [
		`Resumed: ${count(scan.toolCalls.length, "interrupted tool call")}`,
		count(scan.jobs.length, "lost background job"),
		`${count(restarted.length, "subagent")} restarted${notResumed.length > 0 ? ` (${notResumed.length} could not be)` : ""}`,
		`${count(recovered.length, "result")} recovered`,
		`${skipped.length} skipped`,
	].join(", ");
	return {
		status: "resumed",
		notice: sections.join("\n\n"),
		summary,
		restarted,
		recovered,
		skipped: skippedJobs,
	};
}
