/**
 * `omp --restore`: as the session starts, go on with what its last process left
 * unfinished through `/recover`'s implementation ({@link resumeInterruptedWork}),
 * the one recovery path. Interrupted tool calls get an explicit interruption
 * result instead of running again, lost background jobs are reported, subagents
 * cut off mid-work are restarted as background jobs of their parent, and a
 * finished subagent's report that never reached its parent is delivered once.
 * The run is recorded, so a later `/recover` (or `--restore`) finds it handled.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { resumeInterruptedWork, startRecoveredTurn } from "../session/resume-interrupted";

/** What `omp --restore` went on with. */
export interface RestoreOutcome {
	/** The session's own turn goes on, from the recovery notice. */
	turn: boolean;
	/** Ids of the subagents restarted or whose undelivered report now arrives. */
	subagents: string[];
}

/** Recover `session`'s interrupted work and start its turn from the notice, as `/recover` does. */
export async function restoreSession(session: AgentSession): Promise<RestoreOutcome> {
	const outcome = await resumeInterruptedWork(session);
	if (outcome.status !== "resumed") return { turn: false, subagents: [] };
	// Not awaited, like `/recover`: the resumed turn runs on its own.
	startRecoveredTurn(session, outcome.notice).catch(error =>
		logger.warn("--restore could not start the resumed turn", {
			error: error instanceof Error ? error.message : String(error),
		}),
	);
	return { turn: true, subagents: [...outcome.restarted, ...outcome.recovered].map(job => job.jobId) };
}
