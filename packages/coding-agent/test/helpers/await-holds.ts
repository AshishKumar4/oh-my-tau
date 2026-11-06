import { vi } from "bun:test";
import type { AgentRegistryApi } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

/** A live `registry.awaits` hold: the agents its block waits on, and whether a message can end it. */
export interface RecordedAwaitHold {
	agents: readonly string[];
	interruptible: boolean;
}

/**
 * Record the `registry.awaits` holds `waiter` takes from now on; returns a reader of the
 * ones still held. The spy is undone by `vi.restoreAllMocks()`.
 */
export function recordAwaitHolds(registry: AgentRegistryApi, waiter: string): () => RecordedAwaitHold[] {
	const active = new Set<RecordedAwaitHold>();
	const hold = registry.awaits.hold.bind(registry.awaits);
	vi.spyOn(registry.awaits, "hold").mockImplementation((who, awaited, options) => {
		const release = hold(who, awaited, options);
		if (who !== waiter) return release;
		const entry: RecordedAwaitHold = { agents: awaited, interruptible: options.interruptible };
		active.add(entry);
		return () => {
			active.delete(entry);
			release();
		};
	});
	return () => [...active];
}
