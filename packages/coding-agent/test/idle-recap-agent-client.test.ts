import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { EphemeralTurnOptions, EphemeralTurnResult } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { IdleMaintenance, type IdleMaintenanceSession } from "@oh-my-pi/pi-coding-agent/session/idle-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

// An idle recap is a side turn over the conversation. An agent client (Antigravity CLI) keeps its
// own conversation, so that side turn would replay the history into a separate cold one.

afterEach(() => {
	vi.useRealTimers();
});

/** End one generated turn on `model`, let the idle recap come due, and return the side turns it ran. */
async function recapSideTurns(model: Model): Promise<EphemeralTurnOptions[]> {
	const listeners: AgentSessionEventListener[] = [];
	const sideTurns: EphemeralTurnOptions[] = [];
	const messages: AgentMessage[] = [
		{ role: "user", content: "fix the flaky test", timestamp: 1 },
		{
			role: "assistant",
			content: [{ type: "text", text: "Fixed the flaky test." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		},
	];
	const session: IdleMaintenanceSession = {
		settings: Settings.isolated({ "recap.enabled": true, "recap.idleSeconds": 1, "compaction.enabled": false }),
		sessionManager: SessionManager.inMemory(),
		isCompacting: false,
		isSessionTransitioning: false,
		model,
		messages,
		isRunActive: false,
		isStreaming: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
		promptCacheEntry: undefined,
		subscribe: listener => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		waitForRunEnd: async () => {},
		waitForAdmittedSubmissions: async () => {},
		getContextUsage: () => undefined,
		getGoalModeState: () => undefined,
		getTodoPhases: () => [],
		runIdleCompaction: async () => {},
		runEphemeralTurn: async (args: EphemeralTurnOptions): Promise<EphemeralTurnResult> => {
			sideTurns.push(args);
			throw new Error("side turn recorded");
		},
	};
	vi.useFakeTimers();
	const maintenance = new IdleMaintenance(session, {});
	try {
		for (const listener of listeners) listener({ type: "agent_end", messages });
		for (let tick = 0; tick < 10; tick++) await Promise.resolve();
		// The recap comes due one idle second after the turn ends.
		vi.advanceTimersByTime(1_000);
		for (let tick = 0; tick < 10; tick++) await Promise.resolve();
	} finally {
		maintenance.dispose();
	}
	return sideTurns;
}

describe("idle recap behind an agent client", () => {
	it("runs no recap side turn when the model keeps its own conversation", async () => {
		const agentClient = getBundledModel("antigravity-cli", "gemini-4-neon");
		if (!agentClient) throw new Error("Expected antigravity-cli/gemini-4-neon to be bundled");
		expect(await recapSideTurns(agentClient)).toEqual([]);
	});

	it("still recaps a regular model's idle session", async () => {
		const regular = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!regular) throw new Error("Expected anthropic/claude-sonnet-4-5 to be bundled");
		expect(await recapSideTurns(regular)).toHaveLength(1);
	});
});
