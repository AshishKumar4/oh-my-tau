import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { harnessToolRefs } from "@oh-my-pi/pi-coding-agent/harness/manifest";

/** Spread first in a session fake; keep state and behavior overrides on the fake itself. */
export function createSessionDefaults() {
	return {
		setActiveToolsByName: async (_toolNames: string[]) => {},
		getMountedXdevToolNames: () => [],
		getEnabledToolNames: () => [],
		getToolRefs: () => harnessToolRefs(undefined),
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getToolByName: () => undefined,
		getLastAssistantMessage: () => undefined,
		hasPendingAsyncWork: () => false,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		holdIrcWakes: () => () => {},
		isParentIrcSteer: () => false,
		isAdvisorActive: () => false,
		subscribeRunState: () => () => {},
		addDisposer: () => {},
	} satisfies Partial<AgentSession>;
}
