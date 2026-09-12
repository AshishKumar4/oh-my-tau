/**
 * Fusion `sidekick` tool — the lead's handoff surface to its one persistent
 * sidekick subagent.
 *
 * Exactly one sidekick exists per lead session. The first handoff spawns it as
 * a keep-alive task-executor subagent; later handoffs continue the SAME agent
 * (same registry id, full conversation history) as monitored follow-up turns,
 * and a handoff sent while one is already in flight is steered into the
 * running turn instead of queued. Every handoff turn is an async job, so a
 * non-blocking (or timed-out blocking) call's report self-delivers through the
 * ordinary background-job path and can be waited on with `hub`.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { resolveHarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import { formatDuration, prompt } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobManager } from "../async/job-manager";
import {
	buildFusionPromptData,
	findSidekickRef,
	isFusionLead,
	resolveSidekickModel,
	SIDEKICK_AGENT_NAME,
	SIDEKICK_LABEL,
	SIDEKICK_TOOL_NAME,
} from "../fusion/config";
import sidekickHandoffTemplate from "../prompts/tools/sidekick-handoff.md" with { type: "text" };
import sidekickDescription from "../prompts/tools/sidekick.md" with { type: "text" };
import { type AgentRef, MAIN_AGENT_ID } from "../registry/agent-registry";
import { getSidekickAgent } from "../task/agents";
import { runSubagentFollowUpTurn } from "../task/executor";
import { runStructuredSubagent, StructuredSubagentError } from "../task/structured-subagent";
import type { AgentProgress, SingleResult } from "../task/types";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

/**
 * Longest a blocking handoff waits inside one tool call, and the default when
 * `timeout` is omitted. A handoff that outlasts it keeps running; its report
 * then self-delivers like any background job.
 */
export const SIDEKICK_MAX_BLOCK_SECONDS = 1800;

const sidekickSchema = type({
	// `message` is inferred from the vendor prompt ("call the tool again with a new `message`"); the wire name was not captured.
	message: type("string > 0").describe(
		"The brief: goal, plan, constraints, and how to verify. While the sidekick is running, this is injected into the running handoff as an interrupt.",
	),
	"block?": type("boolean").describe("Wait for the handoff to finish and return its report (default true)."),
	"timeout?": type("number > 0").describe(
		`Seconds to wait when blocking; default and maximum ${SIDEKICK_MAX_BLOCK_SECONDS}.`,
	),
});

type SidekickParams = typeof sidekickSchema.infer;

/** How a call reached the sidekick. */
export type SidekickHandoffMode = "spawn" | "rebrief" | "interrupt";

export interface SidekickToolDetails {
	agentId?: string;
	jobId?: string;
	mode: SidekickHandoffMode;
	/** True when the call returned before the handoff settled (non-blocking, timeout, or interrupted wait). */
	pending: boolean;
}

function textResult(text: string, details: SidekickToolDetails): AgentToolResult<SidekickToolDetails> {
	return { content: [{ type: "text", text }], details };
}

/** The sidekick's report, or the failure the lead must act on. */
function reportOf(result: SingleResult): string {
	if (result.aborted) {
		throw new ToolError(`Sidekick handoff was cancelled${result.abortReason ? `: ${result.abortReason}` : "."}`);
	}
	if (result.exitCode !== 0 || result.error) {
		throw new ToolError(`Sidekick handoff failed: ${result.error ?? result.stderr ?? "unknown error"}`);
	}
	return result.output.trim() || "(the sidekick finished without a report)";
}

function describeProgress(progress: AgentProgress): string {
	const activity =
		progress.lastIntent ??
		(progress.currentTool ? `${progress.currentTool} ${progress.currentToolArgs ?? ""}`.trim() : "working");
	return `${SIDEKICK_LABEL}: ${activity} (${progress.toolCount} tool calls, ${formatDuration(progress.durationMs)})`;
}

function waitHint(jobId: string): string {
	return `Its report auto-delivers when it finishes; wait for it with \`hub\` (op: "wait", ids: ["${jobId}"]) rather than polling.`;
}

export class SidekickTool implements AgentTool<typeof sidekickSchema, SidekickToolDetails> {
	readonly name = SIDEKICK_TOOL_NAME;
	readonly label = SIDEKICK_LABEL;
	readonly approval = "exec" as const;
	readonly loadMode = "essential";
	readonly parameters = sidekickSchema;
	readonly strict = true;
	/** First-handoff guard: a second call during spawn joins it instead of spawning twice. */
	#spawning: Promise<AgentRef> | undefined;
	/** Inline (no job manager) handoff in flight, so a parallel call steers instead of re-briefing. */
	#inlineHandoff: Promise<SingleResult> | undefined;
	#handoffs = 0;

	private constructor(private readonly session: ToolSession) {}

	/** Mounted only for a Fusion lead whose sidekick model resolves with configured auth. */
	static createIf(session: ToolSession): SidekickTool | null {
		if (!isFusionLead(session) || !session.modelRegistry) return null;
		return resolveSidekickModel(session.settings, session.modelRegistry).model ? new SidekickTool(session) : null;
	}

	get description(): string {
		const model = this.session.getActiveModel?.();
		const profile = model ? resolveHarnessProfile(model) : undefined;
		return prompt.render(sidekickDescription, buildFusionPromptData({ profile, toolRefs: {} }));
	}

	async execute(
		_toolCallId: string,
		params: SidekickParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<SidekickToolDetails>,
	): Promise<AgentToolResult<SidekickToolDetails>> {
		const brief = params.message.trim();
		const block = params.block ?? true;
		const leadId = this.#leadId();
		const manager = this.session.settings.get("async.enabled") ? this.session.asyncJobManager : undefined;

		const ref = this.#spawning ? await this.#spawning : findSidekickRef(leadId);
		const runningJob =
			ref && manager ? manager.getRunningJobs({ ownerId: leadId }).find(job => job.agentId === ref.id) : undefined;
		if (ref && (runningJob || this.#inlineHandoff)) return this.#interrupt(ref, brief, runningJob);

		const handoff = ++this.#handoffs;
		const mode: SidekickHandoffMode = ref === undefined ? "spawn" : "rebrief";
		const message = prompt.render(sidekickHandoffTemplate, { first: ref === undefined, message: brief });
		// Progress streams into this call only while it is still waiting; a
		// handoff that outlives the call (non-blocking, timeout) reports through
		// its job instead of a callback whose tool result already returned.
		let waiting = block;
		const forwardProgress = (progress: AgentProgress): void => {
			if (!waiting) return;
			onUpdate?.({
				content: [{ type: "text", text: describeProgress(progress) }],
				details: { agentId: progress.id, mode, pending: true },
			});
		};
		const run = (runSignal: AbortSignal, onProgress: (progress: AgentProgress) => void): Promise<SingleResult> =>
			ref === undefined
				? this.#spawn(message, runSignal, onProgress)
				: this.#followUp(ref, message, runSignal, onProgress);

		if (!manager) {
			// Async jobs are off: every handoff blocks inside this call.
			const inline = run(signal ?? new AbortController().signal, forwardProgress);
			this.#inlineHandoff = inline;
			try {
				const result = await inline;
				return textResult(reportOf(result), { agentId: result.id, mode, pending: false });
			} finally {
				this.#inlineHandoff = undefined;
			}
		}

		const jobId = manager.register(
			"task",
			`${SIDEKICK_LABEL} handoff ${handoff}`,
			async ({ jobId: ownJobId, signal: runSignal, reportProgress }) => {
				const result = await run(runSignal, progress => {
					void reportProgress(describeProgress(progress));
					forwardProgress(progress);
				});
				const job = manager.getJob(ownJobId);
				if (job) job.agentId ??= result.id;
				return reportOf(result);
			},
			{ id: `${ref?.id ?? SIDEKICK_LABEL}-h${handoff}`, ownerId: leadId, agentId: ref?.id },
		);
		// A first-handoff job learns its agent id once the spawn registers it;
		// the mid-handoff interrupt lookup keys on it.
		const job = manager.getJob(jobId);
		if (job && !job.agentId) {
			void this.#spawning?.then(
				spawned => {
					job.agentId ??= spawned.id;
				},
				() => {},
			);
		}

		if (!block) {
			return textResult(`Handoff ${handoff} dispatched to the sidekick (job \`${jobId}\`). ${waitHint(jobId)}`, {
				agentId: ref?.id,
				jobId,
				mode,
				pending: true,
			});
		}
		try {
			return await this.#awaitJob(manager, jobId, params.timeout, signal, mode);
		} finally {
			waiting = false;
		}
	}

	#leadId(): string {
		return this.session.getAgentId?.() ?? MAIN_AGENT_ID;
	}

	/** Steer the update into the running handoff; the sidekick folds it in rather than restarting. */
	async #interrupt(
		ref: AgentRef,
		brief: string,
		job: AsyncJob | undefined,
	): Promise<AgentToolResult<SidekickToolDetails>> {
		const live = ref.session;
		if (!live) {
			throw new ToolError(
				`Sidekick ${ref.id} is mid-handoff but has no live session; wait for job ${job?.id ?? "(inline)"} to settle, then re-brief.`,
			);
		}
		await live.steer(prompt.render(sidekickHandoffTemplate, { first: false, message: brief }));
		return textResult(
			`Update injected into the sidekick's running handoff${job ? ` (job \`${job.id}\`)` : ""}; its report will cover the updated brief.`,
			{ agentId: ref.id, jobId: job?.id, mode: "interrupt", pending: true },
		);
	}

	async #spawn(
		message: string,
		signal: AbortSignal,
		onProgress: (progress: AgentProgress) => void,
	): Promise<SingleResult> {
		const { settings, modelRegistry } = this.session;
		if (!modelRegistry) throw new ToolError("Sidekick spawn requires a model registry on this session.");
		const model = resolveSidekickModel(settings, modelRegistry);
		if (!model.model) throw new ToolError(`Cannot spawn the sidekick: ${model.error}`);
		// Resolves as soon as the executor has registered the new agent, so a
		// concurrent second call can steer it instead of spawning a twin.
		const registered = Promise.withResolvers<AgentRef>();
		registered.promise.catch(() => {});
		this.#spawning = registered.promise;
		const settleRegistered = (): void => {
			const ref = findSidekickRef(this.#leadId());
			if (ref) registered.resolve(ref);
		};
		try {
			const execution = await runStructuredSubagent({
				session: this.session,
				invocationKind: "task",
				assignment: message,
				agentDefinition: { ...getSidekickAgent(), thinkingLevel: settings.get("fusion.sidekickThinking") },
				model: `${model.model.provider}/${model.model.id}`,
				identity: { label: SIDEKICK_LABEL },
				keepAlive: true,
				retainArtifacts: true,
				enableLsp: (this.session.enableLsp ?? true) && settings.get("task.enableLsp"),
				signal,
				onProgress: progress => {
					settleRegistered();
					onProgress(progress);
				},
			});
			settleRegistered();
			registered.reject(
				new ToolError("The sidekick's first handoff ended without registering it; re-brief to spawn again."),
			);
			return execution.result;
		} catch (error) {
			registered.reject(error);
			if (error instanceof StructuredSubagentError)
				throw new ToolError(`Cannot spawn the sidekick: ${error.message}`);
			throw error;
		} finally {
			this.#spawning = undefined;
		}
	}

	#followUp(
		ref: AgentRef,
		message: string,
		signal: AbortSignal,
		onProgress: (progress: AgentProgress) => void,
	): Promise<SingleResult> {
		return runSubagentFollowUpTurn({
			id: ref.id,
			agent: getSidekickAgent(),
			message,
			description: SIDEKICK_AGENT_NAME,
			signal,
			onProgress,
			eventBus: this.session.eventBus,
			subagentEventBus: this.session.subagentEventBus,
			artifactsDir: this.session.getSessionFile()?.slice(0, -6),
		});
	}

	/**
	 * Block on the handoff job up to the timeout (or the caller's abort, e.g. a
	 * user steer the lead must act on first). A settled job is consumed here so
	 * the async path does not deliver the same report twice.
	 */
	async #awaitJob(
		manager: AsyncJobManager,
		jobId: string,
		timeoutSeconds: number | undefined,
		signal: AbortSignal | undefined,
		mode: SidekickHandoffMode,
	): Promise<AgentToolResult<SidekickToolDetails>> {
		const job = manager.getJob(jobId);
		if (!job) throw new ToolError(`Sidekick handoff job ${jobId} vanished before it could be awaited.`);
		const timeoutMs = Math.min(timeoutSeconds ?? SIDEKICK_MAX_BLOCK_SECONDS, SIDEKICK_MAX_BLOCK_SECONDS) * 1000;
		const timeout = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => timeout.resolve("timeout"), timeoutMs);
		const aborted = Promise.withResolvers<"aborted">();
		const onAbort = (): void => aborted.resolve("aborted");
		signal?.addEventListener("abort", onAbort, { once: true });
		manager.watchJobs([jobId]);
		let outcome: "settled" | "timeout" | "aborted";
		try {
			outcome = await Promise.race([job.promise.then(() => "settled" as const), timeout.promise, aborted.promise]);
		} finally {
			manager.unwatchJobs([jobId]);
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
		// Read the captured row, not a fresh lookup: retention may already have
		// evicted a just-settled job from the manager's table.
		if (job.status !== "running") {
			manager.consumeJobResults([jobId]);
			if (job.status === "failed") throw new ToolError(job.errorText ?? "Sidekick handoff failed.");
			if (job.status === "cancelled") throw new ToolError("Sidekick handoff was cancelled.");
			return textResult(job.resultText ?? "", { agentId: job.agentId, jobId, mode, pending: false });
		}
		const reason =
			outcome === "aborted" ? "The wait was interrupted" : `No report within ${formatDuration(timeoutMs)}`;
		return textResult(`${reason}; the sidekick is still working on handoff job \`${jobId}\`. ${waitHint(jobId)}`, {
			agentId: job.agentId,
			jobId,
			mode,
			pending: true,
		});
	}
}
