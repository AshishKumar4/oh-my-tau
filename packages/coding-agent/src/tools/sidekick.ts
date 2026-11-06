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
 * ordinary background-job path and can be waited on with `wait`.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { effectiveHarnessProfile, sessionToolRefs } from "../harness/effective-profile";
import { formatDuration, prompt } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobManagerApi } from "../async/job-manager";
import {
	buildFusionPromptData,
	type FusionPromptData,
	findSidekickRef,
	isFusionLead,
	renderSidekickPrompt,
	resolveSidekickModel,
	SIDEKICK_AGENT_NAME,
	SIDEKICK_LABEL,
	SIDEKICK_TOOL_NAME,
} from "../fusion/config";
import sidekickHandoffTemplate from "../prompts/tools/sidekick-handoff.md" with { type: "text" };
import sidekickDescription from "../prompts/tools/sidekick.md" with { type: "text" };
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { getSidekickAgent } from "../task/agents";
import { runSubagentFollowUpTurn } from "../task/executor";
import {
	reserveStructuredSubagentId,
	runStructuredSubagent,
	StructuredSubagentError,
} from "../task/structured-subagent";
import type { AgentProgress, SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { cfgFusionSidekickThinking } from "../fusion/settings";
import { cfgTaskEnableLsp } from "../task/settings";
import type { ToolSession } from "./index";
import { cfgAsyncEnabled } from "./settings";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/**
 * Longest a blocking handoff waits inside one tool call. A handoff that
 * outlasts it keeps running; its report then self-delivers like any
 * background job.
 */
export const SIDEKICK_MAX_BLOCK_SECONDS = 2700;

// The sidekick handoff contract: `message` and `block` only.
const sidekickSchema = type({
	message: type("string > 0").describe(
		"The brief: goal, plan, constraints, and how to verify. While the sidekick is running, this is injected into the running handoff as an interrupt.",
	),
	"block?": type("boolean").describe(
		"Wait for the worker report (default true). If interrupted or timed out, the worker continues and reports asynchronously.",
	),
});

type SidekickParams = typeof sidekickSchema.infer;

/** How a call reached the sidekick. */
export type SidekickHandoffMode = "spawn" | "rebrief" | "interrupt";

/** A handoff's sidekick: the one the lead has, or a new one this call spawns. */
type SidekickClaim =
	| { ref: AgentRef }
	| { ref?: undefined; agentId: string; registered: PromiseWithResolvers<AgentRef> };

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

export class SidekickTool implements AgentTool<typeof sidekickSchema, SidekickToolDetails> {
	readonly name = SIDEKICK_TOOL_NAME;
	readonly label = SIDEKICK_LABEL;
	readonly approval = "exec" as const;
	readonly loadMode = "essential";
	readonly parameters = sidekickSchema;
	readonly strict = true;
	/** First-handoff guard: a second call during spawn joins it instead of spawning twice. */
	#spawning: Promise<AgentRef> | undefined;
	/** The last {@link #claim}; each call claims after the one before it, so concurrent first handoffs spawn once. */
	#claiming: Promise<unknown> = Promise.resolve();
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
		return prompt.render(sidekickDescription, this.#promptData());
	}

	/** Description slots under the session's current harness profile and the tools it presents. */
	#promptData(): FusionPromptData {
		const model = this.session.getActiveModel?.();
		const profile = model ? effectiveHarnessProfile(this.session.settings, model) : undefined;
		return buildFusionPromptData({ profile, toolRefs: sessionToolRefs(this.session) });
	}

	/** For a handoff that outlives the call: the description's wait tool, or ending the turn; never polling. */
	#waitHint(): string {
		const { readTool } = this.#promptData();
		return readTool
			? `Its report auto-delivers when it finishes; wait for it with \`${readTool}\` rather than polling.`
			: "Its report arrives as a notification when it finishes; end your turn rather than polling.";
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
		const manager = cfgAsyncEnabled.get(this.session.settings) ? this.session.asyncJobManager : undefined;

		const claiming = this.#claiming.then(() => this.#claim(leadId));
		this.#claiming = claiming.catch(() => {});
		const claim = await claiming;
		const { ref } = claim;
		// A spawn this call claimed but never started must not leave a waiting call hanging.
		const spawn = ref ? undefined : claim.registered;
		try {
			const runningJob =
				ref && manager
					? manager.getRunningJobs({ ownerId: leadId }).find(job => job.agentId === ref.id)
					: undefined;
			if (ref && (runningJob || this.#inlineHandoff)) return await this.#interrupt(ref, brief, runningJob);
			return await this.#handOff(claim, { brief, block, leadId, manager, signal, onUpdate });
		} catch (error) {
			spawn?.reject(error);
			throw error;
		}
	}

	/**
	 * Who this handoff goes to: the sidekick the lead already has (one from
	 * before a restart is a parked transcript until the roster loads it, and
	 * reviving it keeps the pairing's conversation), the one a concurrent first
	 * handoff is spawning, or a new one. A new one gets its id here, so its job,
	 * this call's result and the lead's journal name it from the start (a worker
	 * starts the job's body only after `register` returns); `registered` settles
	 * once the executor registers it.
	 */
	async #claim(leadId: string): Promise<SidekickClaim> {
		if (this.#spawning) return { ref: await this.#spawning };
		await ensurePersistedRoster(AgentRegistry.global(), this.session.getSessionFile());
		const ref = findSidekickRef(leadId);
		if (ref) return { ref };
		const agentId = await reserveStructuredSubagentId(this.session, { label: SIDEKICK_LABEL });
		const registered = Promise.withResolvers<AgentRef>();
		const spawning = registered.promise;
		this.#spawning = spawning;
		spawning.then(
			() => {},
			() => {
				if (this.#spawning === spawning) this.#spawning = undefined;
			},
		);
		return { agentId, registered };
	}

	async #handOff(
		claim: SidekickClaim,
		args: {
			brief: string;
			block: boolean;
			leadId: string;
			manager: AsyncJobManagerApi | undefined;
			signal: AbortSignal | undefined;
			onUpdate: AgentToolUpdateCallback<SidekickToolDetails> | undefined;
		},
	): Promise<AgentToolResult<SidekickToolDetails>> {
		const { brief, block, leadId, manager, signal, onUpdate } = args;
		const { ref } = claim;
		const agentId = ref ? ref.id : claim.agentId;
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
				details: { agentId, mode, pending: true },
			});
		};
		const run = (runSignal: AbortSignal, onProgress: (progress: AgentProgress) => void): Promise<SingleResult> =>
			ref
				? this.#followUp(ref, message, runSignal, onProgress)
				: this.#spawn(claim.agentId, claim.registered, message, runSignal, onProgress);

		if (!manager) {
			// Async jobs are off: every handoff blocks inside this call.
			const inline = run(signal ?? new AbortController().signal, forwardProgress);
			this.#inlineHandoff = inline;
			const releaseAwait = this.#holdHandoffAwait(agentId);
			try {
				const result = await inline;
				return textResult(reportOf(result), { agentId, mode, pending: false });
			} finally {
				this.#inlineHandoff = undefined;
				releaseAwait();
			}
		}

		const jobId = manager.register(
			"task",
			`${SIDEKICK_LABEL} handoff ${handoff}`,
			async ({ signal: runSignal, reportProgress }) =>
				reportOf(
					await run(runSignal, progress => {
						void reportProgress(describeProgress(progress));
						forwardProgress(progress);
					}),
				),
			{ id: `${agentId}-h${handoff}`, ownerId: leadId, agentId },
		);

		if (!block) {
			return textResult(`Handoff ${handoff} dispatched to the sidekick (job \`${jobId}\`). ${this.#waitHint()}`, {
				agentId,
				jobId,
				mode,
				pending: true,
			});
		}
		try {
			return await this.#awaitJob(manager, jobId, signal, mode);
		} finally {
			waiting = false;
		}
	}

	#leadId(): string {
		return this.session.getAgentId?.() ?? MAIN_AGENT_ID;
	}

	/**
	 * Publish that the lead's turn is blocked on its sidekick, reading no message,
	 * until the returned release runs: a sidekick waiting on a reply from the lead
	 * then returns instead of waiting on a lead that cannot answer.
	 */
	#holdHandoffAwait(sidekickId: string): () => void {
		return (
			this.session.agentRegistry?.awaits.hold(this.#leadId(), [sidekickId], { interruptible: false }) ?? (() => {})
		);
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

	/** Spawn the sidekick a call claimed; `registered` resolves once the executor registers it, so a concurrent call steers it. */
	async #spawn(
		agentId: string,
		registered: PromiseWithResolvers<AgentRef>,
		message: string,
		signal: AbortSignal,
		onProgress: (progress: AgentProgress) => void,
	): Promise<SingleResult> {
		const settleRegistered = (): void => {
			const ref = findSidekickRef(this.#leadId());
			if (ref) registered.resolve(ref);
		};
		try {
			const { settings, modelRegistry } = this.session;
			if (!modelRegistry) throw new ToolError("Sidekick spawn requires a model registry on this session.");
			const model = resolveSidekickModel(settings, modelRegistry);
			if (!model.model) throw new ToolError(`Cannot spawn the sidekick: ${model.error}`);
			const sidekick = getSidekickAgent();
			const thinkingLevel = cfgFusionSidekickThinking.get(settings);
			const execution = await runStructuredSubagent({
				session: this.session,
				invocationKind: "task",
				assignment: message,
				agentDefinition: {
					...sidekick,
					thinkingLevel,
					systemPrompt: renderSidekickPrompt(sidekick.systemPrompt, model.model, thinkingLevel),
				},
				model: `${model.model.provider}/${model.model.id}`,
				identity: { id: agentId },
				keepAlive: true,
				retainArtifacts: true,
				enableLsp: (this.session.enableLsp ?? true) && cfgTaskEnableLsp.get(settings),
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
			if (this.#spawning === registered.promise) this.#spawning = undefined;
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
			resultOwnerId: this.#leadId(),
		});
	}

	/**
	 * Block on the handoff job up to the fixed wait (or the caller's abort, e.g.
	 * a user steer the lead must act on first). A settled job is consumed here
	 * so the async path does not deliver the same report twice.
	 */
	async #awaitJob(
		manager: AsyncJobManagerApi,
		jobId: string,
		signal: AbortSignal | undefined,
		mode: SidekickHandoffMode,
	): Promise<AgentToolResult<SidekickToolDetails>> {
		const job = manager.getJob(jobId);
		if (!job) throw new ToolError(`Sidekick handoff job ${jobId} vanished before it could be awaited.`);
		const timeout = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => timeout.resolve("timeout"), SIDEKICK_MAX_BLOCK_SECONDS * 1000);
		const aborted = Promise.withResolvers<"aborted">();
		const onAbort = (): void => aborted.resolve("aborted");
		signal?.addEventListener("abort", onAbort, { once: true });
		manager.watchJobs([jobId]);
		const releaseAwait = job.agentId ? this.#holdHandoffAwait(job.agentId) : () => {};
		let outcome: "settled" | "timeout" | "aborted";
		let settled: AsyncJob = job;
		try {
			outcome = await Promise.race([job.promise.then(() => "settled" as const), timeout.promise, aborted.promise]);
			// A worker's row is a snapshot: look it up again while the watch keeps it.
			// Retention may still have evicted it; then the captured row is the newest.
			settled = manager.getJob(jobId) ?? job;
		} finally {
			releaseAwait();
			manager.unwatchJobs([jobId]);
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
		if (settled.status !== "running") {
			manager.consumeJobResults([jobId]);
			if (settled.status === "failed") throw new ToolError(settled.errorText ?? "Sidekick handoff failed.");
			if (settled.status === "cancelled") throw new ToolError("Sidekick handoff was cancelled.");
			return textResult(settled.resultText ?? "", { agentId: settled.agentId, jobId, mode, pending: false });
		}
		const reason =
			outcome === "aborted"
				? "The wait was interrupted"
				: `No report within ${formatDuration(SIDEKICK_MAX_BLOCK_SECONDS * 1000)}`;
		return textResult(`${reason}; the sidekick is still working on handoff job \`${jobId}\`. ${this.#waitHint()}`, {
			agentId: settled.agentId,
			jobId,
			mode,
			pending: true,
		});
	}
}
