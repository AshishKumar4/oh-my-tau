/**
 * `/recover`: recover the work a previous OMP process left interrupted.
 *
 * `buildSessionContext` strips tool calls that have no result, background jobs
 * never deliver, and interrupted subagents stay parked. From what
 * `recovery-journal.ts` finds, this module restores that work: interrupted
 * tool calls get an explicit result, lost background jobs are reported,
 * interrupted subagents are revived as background jobs that deliver to their
 * parent like a normal spawn, a finished subagent's undelivered report is
 * delivered, and a turn cut off before the agent answered goes on.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AsyncJobError, type AsyncJobManagerApi } from "../async";
import type { Settings } from "../config/settings";
import { AgentRegistry } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { getBundledAgent, resolveRetiredAgentName } from "../task/agents";
import { discoverAgents, getAgent } from "../task/discovery";
import { runSubagentFollowUpTurn, softRequestBudgetFor } from "../task/executor";
import { cfgTaskMaxRuntimeMs } from "../task/settings";
import type { AgentDefinition } from "../task/types";
import type { EventBus } from "../utils/event-bus";
import type { AgentSession } from "./agent-session";
import { createInterruptedToolResult } from "./exit-diagnostics";
import {
	findInterruptedWork,
	type InterruptedJob,
	type InterruptedToolCall,
	inspectSubagent,
	type OutputContract,
	type ProcessSpan,
	RECOVER_CUSTOM_TYPE,
	RECOVER_OUTCOME_CUSTOM_TYPE,
	reachedParent,
	type SubagentReport,
} from "./recovery-journal";
import { SessionManager } from "./session-manager";

const SUBAGENT_RESUME_MESSAGE =
	"A system glitch stopped OMP and interrupted your run. Tool calls marked as interrupted may have partially run. Check the current state and resume your assignment from where you left off; if it is already complete, deliver your final report again.";

/** Record the interruption result for each cut-off tool call that has none yet, right after the turn that issued it. */
export function appendInterruptedToolResults(
	sessionManager: SessionManager,
	calls: readonly InterruptedToolCall[],
	now = Date.now(),
): void {
	for (const call of calls) {
		if (call.resultRecorded) continue;
		sessionManager.appendMessage(createInterruptedToolResult({ id: call.toolCallId, name: call.toolName }, now));
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
		const registry = AgentRegistry.global();
		const state = inspectSubagent(
			manager.getBranch(),
			span,
			startedAt,
			contract,
			agentId => registry.get(agentId)?.parentId === id,
		);
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
	readonly asyncJobManager: AsyncJobManagerApi | undefined;
	/** Buses a restarted subagent announces itself on, so it shows in the running-subagents list like a spawn. */
	readonly eventBus: EventBus | undefined;
	readonly subagentEventBus: EventBus | undefined;
	readonly agent: { replaceMessages(messages: AgentMessage[]): void };
	buildDisplaySessionContext(): { messages: AgentMessage[] };
	/** Persists the eval snapshot startup deferred until the interrupted calls have results. */
	persistEvalStateContext(): void;
	getAgentId(): string | undefined;
	/** Caps a restarted subagent's run like any other: its wall-clock limit and soft request budget. */
	readonly settings: Settings;
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
 * caller starts the main agent's turn with {@link startRecoveredTurn}.
 */
export async function resumeInterruptedWork(host: RecoverHost): Promise<RecoverOutcome> {
	const sessionManager = host.sessionManager;
	const scan = findInterruptedWork(sessionManager.getBranch());
	if (scan.handled) return { status: "handled" };
	if (!scan.unfinishedTurn && scan.toolCalls.length === 0 && scan.jobs.length === 0 && scan.agents.length === 0) {
		return { status: "nothing" };
	}

	if (scan.toolCallsRepairable) {
		appendInterruptedToolResults(sessionManager, scan.toolCalls);
		host.persistEvalStateContext();
		host.agent.replaceMessages(host.buildDisplaySessionContext().messages);
	}
	// Recorded before the first await: a second /recover while this one is still
	// restarting subagents, or after it throws, must not restart them again.
	sessionManager.appendCustomEntry(RECOVER_CUSTOM_TYPE, {
		toolCalls: scan.toolCalls.map(call => call.toolCallId),
		jobs: scan.jobs.map(job => job.jobId),
		agents: scan.agents,
		...(scan.unfinishedTurn ? { unfinishedTurn: true } : {}),
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
			// A killed subagent's transcript is tombstoned and comes back `aborted`:
			// the kill ended its work, whatever the parent's journal still shows.
			if (ref.status === "aborted") {
				notResumed.push(`${jobName(interrupted)}: it was killed.`);
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
					if (
						!report ||
						reachedParent(sessionManager.getBranch(), interrupted.jobId, report, interrupted.requestedAt)
					) {
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
							maxRuntimeMs: cfgTaskMaxRuntimeMs.get(host.settings),
							...softRequestBudgetFor(agent.name, host.settings),
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
	// Interrupted tool calls already say the turn was cut off.
	const unansweredTurn = scan.unfinishedTurn && scan.toolCalls.length === 0;
	if (unansweredTurn) sections.push("Your last turn was cut off before you answered it.");
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
		`Resumed: ${unansweredTurn ? "the unanswered turn, " : ""}${count(scan.toolCalls.length, "interrupted tool call")}`,
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

/**
 * Start the main agent's turn on a `resumed` outcome's notice. `/recover` and
 * `--restore` both continue this way; callers do not await the turn, so a host
 * whose prompt turn owns the event subscription keeps it open across it.
 */
export function startRecoveredTurn(session: Pick<AgentSession, "sendCustomMessage">, notice: string) {
	return session.sendCustomMessage(
		{ customType: RECOVER_CUSTOM_TYPE, content: notice, display: true, attribution: "user" },
		{ triggerTurn: true },
	);
}
