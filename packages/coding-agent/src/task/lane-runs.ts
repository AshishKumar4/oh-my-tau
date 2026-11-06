/**
 * The open run of each kept-alive lane (task/executor's `runLane`), in a module
 * of its own so readers outside the executor — `agent://`, deciding whether a
 * published output is the previous run's — see the same record.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "../session/agent-session";

/**
 * A kept-alive lane's open run: a wake run (`attachIrcWakeTurnMonitor`) or a
 * follow-up run (`runSubagentFollowUpTurn`). A lane has one run at a time, so
 * each yield is accepted by one monitor and delivered once.
 */
export interface LaneRun {
	/**
	 * Take a wake's turn into this run. Returns the turn's settle callback, or
	 * undefined once the run takes no more turns: it is ending, or its monitor
	 * was terminated or cancelled.
	 */
	join(records: AgentMessage[]): ((turnError?: unknown) => void) | undefined;
	/**
	 * Hand the lane to a successor run while this one finalizes: stop observing
	 * the session, and pin this run's background jobs to those the lane has
	 * running now, so this run's teardown leaves the successor's work alone.
	 */
	handOver(): void;
	/** Settles once the run has finalized and relayed its end. */
	readonly released: Promise<void>;
}

/** The open run of each kept-alive lane's session. */
export const laneRuns = new WeakMap<AgentSession, LaneRun>();
