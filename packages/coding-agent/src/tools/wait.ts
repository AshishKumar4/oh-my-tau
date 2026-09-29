import { type } from "@oh-my-pi/omptype";
import {
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	TOOL_INTERRUPT_ABORT_REASON,
} from "@oh-my-pi/pi-agent-core";
import { formatDuration, prompt } from "@oh-my-pi/pi-utils";
import { IrcBus } from "../irc/bus";
import waitDescription from "../prompts/tools/wait.md" with { type: "text" };
import waitNoMessageTemplate from "../prompts/tools/wait-no-message.md" with { type: "text" };
import type { ToolSession } from ".";
import type { AsyncJob, AsyncJobManager } from "../async/job-manager";
import { buildJobResult, nothingToWaitForResult, snapshotJobs, undeliveredJobs } from "../async/job-control";
import { hasLiveOwnedService, listServices, waitForOwnedServiceCompletion } from "../launch/services";
import { drainPendingInbox, messageResult } from "../irc/messaging";
import type { AgentRef, AgentRegistry } from "../registry/agent-registry";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { throwIfAborted } from "./tool-errors";

import { cfgLaunchEnabled } from "./settings";

const waitSchema = type({});
const WAIT_MAX_MS = 30 * 60_000;
const PROGRESS_INTERVAL_MS = 500;
/** Running peers named in a no-message result before collapsing the rest into a count. */
const MESSAGE_WAIT_PEER_PREVIEW = 5;

interface WaitMessaging {
	registry: AgentRegistry;
	senderId: string;
}

function takeQueuedMessage(messaging: WaitMessaging | undefined): IrcMessage | undefined {
	if (!messaging) return undefined;
	return drainPendingInbox(messaging.registry, messaging.senderId) ?? IrcBus.global().take(messaging.senderId);
}

/**
 * An await an agent's turn is blocked in, as a message-only `wait` sees it when
 * deciding whether anyone is left to message it.
 */
export interface BlockedAwait {
	/**
	 * Agents whose results the await is blocked on. A `wait` race ends on the
	 * first of them or on a message — with none listed, on a message alone.
	 */
	agents: readonly string[];
	/**
	 * An inline await (a blocking `task` spawn, a `sidekick` handoff, an eval
	 * `wait()`) ends only once every listed agent settles, and its agent reads no
	 * message meanwhile.
	 */
	inline?: boolean;
	/** It can end with no agent acting: a race's bash job or service leg, an inline timeout. */
	independent?: boolean;
}

interface RegistryAwaits {
	/** Awaits each agent's turn is blocked in; parallel tool calls can hold several. */
	byAgent: Map<string, BlockedAwait[]>;
	/** Checks of message-only waits, re-run on every hold and release. */
	listeners: Set<() => void>;
}

/**
 * Awaits agents' turns are blocked in right now, per registry. Delivery watches
 * cannot answer "is this agent parked on that result?": a workpool watches every
 * member turn while its owner keeps working.
 */
const blockedAwaits = new WeakMap<AgentRegistry, RegistryAwaits>();

function registryAwaits(registry: AgentRegistry): RegistryAwaits {
	let awaits = blockedAwaits.get(registry);
	if (!awaits) {
		awaits = { byAgent: new Map(), listeners: new Set() };
		blockedAwaits.set(registry, awaits);
	}
	return awaits;
}

/**
 * Mark `agentId`'s turn as blocked in `block` until the returned release runs.
 * Both edges re-run every message-only `wait` check on the registry.
 */
export function holdBlockedAwait(registry: AgentRegistry, agentId: string, block: BlockedAwait): () => void {
	const awaits = registryAwaits(registry);
	const held = awaits.byAgent.get(agentId);
	if (held) held.push(block);
	else awaits.byAgent.set(agentId, [block]);
	for (const listener of awaits.listeners) listener();
	return () => {
		const current = awaits.byAgent.get(agentId);
		const index = current?.indexOf(block) ?? -1;
		if (!current || index === -1) return;
		current.splice(index, 1);
		if (current.length === 0) awaits.byAgent.delete(agentId);
		for (const listener of awaits.listeners) listener();
	};
}

/** The caller's peers with a live turn in flight, in roster order. */
function runningPeers(messaging: WaitMessaging): AgentRef[] {
	return messaging.registry.listVisibleTo(messaging.senderId).filter(ref => messaging.registry.isRunning(ref));
}

/**
 * Whether some running peer can act without waiting on the caller or on another
 * peer. A peer blocked in an await acts only once the await ends, and it cannot
 * end while it needs the caller or a running agent: with no running peer left
 * free, that agent is blocked too, so when no peer can act nobody is left to
 * send the caller a message (#13513). A peer blocked in nothing, or in an await
 * that can end alone or on a settling (idle, starting, finishing) agent, still
 * can.
 */
function anyPeerCanAct(messaging: WaitMessaging, running: readonly AgentRef[]): boolean {
	const byAgent = blockedAwaits.get(messaging.registry)?.byAgent;
	const runningIds = new Set(running.map(ref => ref.id));
	// Neither the caller nor running: its result lands without anyone acting.
	const settlesAlone = (id: string): boolean => id !== messaging.senderId && !runningIds.has(id);
	return running.some(ref =>
		(byAgent?.get(ref.id) ?? []).every(
			block =>
				block.independent === true ||
				(block.inline ? block.agents.every(settlesAlone) : block.agents.some(settlesAlone)),
		),
	);
}

/**
 * Settles once the caller should stop waiting for a message: running peers
 * remain, but none can act. Of the waiters caught in such a deadlock, those a
 * blocked agent awaits settle first — their `yield` or message is what frees
 * the rest, so every other waiter keeps waiting for it; with no waiter awaited,
 * all of them settle. Re-checked on every registry and blocked-await change; an
 * empty roster is the bus liveness check's to report, and that wake re-evaluates.
 */
function watchDeadlock(messaging: WaitMessaging): { settled: Promise<void>; dispose: () => void } {
	const { promise, resolve } = Promise.withResolvers<void>();
	const check = (): void => {
		const running = runningPeers(messaging);
		if (running.length === 0 || anyPeerCanAct(messaging, running)) return;
		const byAgent = blockedAwaits.get(messaging.registry)?.byAgent;
		const awaited = new Set([...(byAgent?.values() ?? [])].flat().flatMap(block => block.agents));
		// A message-only wait is a race on no agent and no independent leg.
		const awaitedWaiter = running.some(
			ref =>
				awaited.has(ref.id) &&
				byAgent?.get(ref.id)?.some(block => !block.inline && !block.independent && block.agents.length === 0),
		);
		if (awaited.has(messaging.senderId) || !awaitedWaiter) resolve();
	};
	const { listeners } = registryAwaits(messaging.registry);
	listeners.add(check);
	const unsubscribeRegistry = messaging.registry.onChange(check);
	check();
	return {
		settled: promise,
		dispose: () => {
			listeners.delete(check);
			unsubscribeRegistry();
		},
	};
}

/**
 * Nobody left can message the caller: name the running peers and, when one is
 * blocked on the caller's own result, say so and whether it can read a message.
 */
function noMessageResult(messaging: WaitMessaging, startedAt: number): AgentToolResult<CoordinationDetails> {
	const running = runningPeers(messaging).map(ref => ref.id);
	const byAgent = blockedAwaits.get(messaging.registry)?.byAgent;
	let awaitedBy: string | undefined;
	let askable = false;
	for (const id of running) {
		const block = byAgent?.get(id)?.find(held => held.agents.includes(messaging.senderId));
		if (!block) continue;
		awaitedBy = id;
		// A `wait` race wakes on a message; an inline await does not.
		askable = block.inline !== true;
		break;
	}
	const text = prompt.render(waitNoMessageTemplate, {
		elapsed: formatDuration(Date.now() - startedAt),
		peers: running.slice(0, MESSAGE_WAIT_PEER_PREVIEW),
		more: Math.max(0, running.length - MESSAGE_WAIT_PEER_PREVIEW),
		awaitedBy,
		askable,
	});
	return {
		content: [{ type: "text", text }],
		details: { op: "wait", jobs: [] },
		// A no-message result carries nothing once consumed.
		useless: true,
	};
}

/** Whether `session` has the `wait` tool active, so prompts may point blocked callers at it. */
export function hasWaitTool(session: ToolSession): boolean {
	return session.isToolActive?.("wait") ?? true;
}

export class WaitTool implements AgentTool<typeof waitSchema, CoordinationDetails> {
	readonly name = "wait";
	readonly label = "Wait";
	readonly summary = "Wait for the next background result or peer message";
	readonly description = prompt.render(waitDescription);
	readonly parameters = waitSchema;
	readonly strict = true;
	readonly interruptible = true;
	readonly approval = "read";
	readonly loadMode = "essential";
	readonly intent = "optional";

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		_params: typeof waitSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<CoordinationDetails>,
	): Promise<AgentToolResult<CoordinationDetails>> {
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.() ?? undefined;
		const messaging = registry && senderId ? { registry, senderId } : undefined;
		const manager = this.session.asyncJobManager;
		const ownerFilter = { ownerId: senderId };

		const pending = takeQueuedMessage(messaging);
		if (pending && messaging) return messageResult(messaging.senderId, pending);
		if (cfgLaunchEnabled.get(this.session.settings)) await listServices(this.session, signal);
		const startedAt = Date.now();
		const deadline = startedAt + WAIT_MAX_MS;
		for (;;) {
			const queued = takeQueuedMessage(messaging);
			if (queued && messaging) return messageResult(messaging.senderId, queued);
			const jobs = manager?.getRunningJobs(ownerFilter) ?? [];
			// An accepted completion whose delivery has not reached the transcript
			// yet (queued, parked on the yield queue, or skipped while an earlier
			// wait watched it) is exactly what this wait is for: return it now
			// instead of reporting nothing to wait for.
			const undelivered = manager ? undeliveredJobs(manager, senderId) : [];
			if (manager && undelivered.length > 0) {
				return buildJobResult(this.session, manager, "wait", [...undelivered, ...jobs], []);
			}
			const serviceRunning = hasLiveOwnedService(this.session);
			const runningPeer = messaging ? runningPeers(messaging).length > 0 : false;
			if (jobs.length === 0 && !runningPeer && !serviceRunning) {
				return nothingToWaitForResult(this.session);
			}
			const result = await this.#blockUntilWake({
				jobs,
				manager,
				messaging,
				serviceRunning,
				startedAt,
				deadline,
				signal,
				onUpdate,
			});
			if (result) return result;
		}
	}

	/**
	 * Block on one snapshot of wake sources. Returns undefined when the last
	 * running peer stopped with nothing else to report: its accepted result may
	 * register or settle a job right after, so the caller re-evaluates.
	 */
	async #blockUntilWake(args: {
		jobs: AsyncJob[];
		manager: AsyncJobManager | undefined;
		messaging: WaitMessaging | undefined;
		serviceRunning: boolean;
		/** When the wait began, for a no-message result's elapsed time. */
		startedAt: number;
		deadline: number;
		signal: AbortSignal | undefined;
		onUpdate: AgentToolUpdateCallback<CoordinationDetails> | undefined;
	}): Promise<AgentToolResult<CoordinationDetails> | undefined> {
		const { jobs, manager, messaging, serviceRunning, signal, onUpdate } = args;
		// Only a peer message can end this block.
		const messageOnly = jobs.length === 0 && !serviceRunning;
		const watchedIds = jobs.map(job => job.id);
		manager?.watchJobs(watchedIds);
		const serviceAbort = new AbortController();
		const serviceLeg = serviceRunning ? waitForOwnedServiceCompletion(this.session, serviceAbort.signal) : undefined;
		const busAbort = messaging ? new AbortController() : undefined;
		const busCancelled = new Error("wait settled");
		const busLeg: Promise<{ message: IrcMessage | null; error: Error | null }> | undefined =
			messaging && busAbort
				? IrcBus.global()
						.wait(
							messaging.senderId,
							{},
							0,
							busAbort.signal,
							messageOnly ? { liveness: messaging } : undefined,
						)
						.then(
							message => ({ message, error: null }),
							error => ({
								message: null,
								error:
									error === busCancelled ? null : error instanceof Error ? error : new Error(String(error)),
							}),
						)
				: undefined;
		const { promise: timeout, resolve: timedOut } = Promise.withResolvers<void>();
		const timer = setTimeout(timedOut, Math.max(0, args.deadline - Date.now()));
		const abort = Promise.withResolvers<void>();
		const onAbort = () => abort.resolve();
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		const emitProgress = () =>
			onUpdate?.({
				content: [{ type: "text", text: "" }],
				details: { op: "wait", jobs: snapshotJobs(this.session, jobs) },
			});
		const progressTimer = onUpdate && jobs.length > 0 ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		if (jobs.length > 0) emitProgress();
		// Published before the peer check below: agents that start waiting on each
		// other in turn must each find the other already blocked.
		const releaseAwait = messaging
			? holdBlockedAwait(messaging.registry, messaging.senderId, {
					agents: jobs.flatMap(job => (job.agentId ? [job.agentId] : [])),
					independent: serviceRunning || jobs.some(job => !job.agentId),
				})
			: undefined;
		const deadlock = messageOnly && messaging ? watchDeadlock(messaging) : undefined;
		let wake: "job" | "message" | "service" | "deadlock" | "timeout" | "abort";
		try {
			wake = await Promise.race([
				...jobs.map(job => job.promise.then(() => "job" as const)),
				...(busLeg ? [busLeg.then(() => "message" as const)] : []),
				...(serviceLeg ? [serviceLeg.then(() => "service" as const)] : []),
				...(deadlock ? [deadlock.settled.then(() => "deadlock" as const)] : []),
				timeout.then(() => "timeout" as const),
				abort.promise.then(() => "abort" as const),
			]);
		} finally {
			clearTimeout(timer);
			deadlock?.dispose();
			releaseAwait?.();
			clearInterval(progressTimer);
			busAbort?.abort(busCancelled);
			serviceAbort.abort();
			signal?.removeEventListener("abort", onAbort);
		}
		// Unwatch only after the result is built: a job recovered below is
		// consumed first, while one left unreported (message or interrupt won
		// the race) is re-enqueued for its ordinary async delivery.
		try {
			// A dequeued message wins a photo-finish with a job: the job remains
			// deliverable, whereas a lost message cannot be recovered from the bus.
			if (busLeg && messaging) {
				const { message, error } = await busLeg;
				if (message) return messageResult(messaging.senderId, message);
				if (error && !signal?.aborted) return undefined;
			}
			if (signal?.aborted) {
				// Steering, a peer IRC, or a completion notice cut the wait short:
				// the designed wake path, so the message injects after a normal
				// result. Any other abort stops the run.
				if (signal.reason === TOOL_INTERRUPT_ABORT_REASON) {
					return {
						content: [{ type: "text", text: "Wait interrupted by message." }],
						details: { op: "wait", jobs: [], interrupted: true },
						useless: true,
					};
				}
				throwIfAborted(signal);
			}
			if (manager && jobs.length > 0) return buildJobResult(this.session, manager, "wait", jobs, []);
			if (wake === "deadlock" && messaging) return noMessageResult(messaging, args.startedAt);
			return {
				content: [
					{
						type: "text",
						text:
							wake === "service"
								? "A service finished. Read proc:// for its status and output."
								: "Wait limit reached; background work may still be running. Read proc:// for status.",
					},
				],
				details: { op: "wait", jobs: [] },
			};
		} finally {
			manager?.unwatchJobs(watchedIds);
		}
	}
}
