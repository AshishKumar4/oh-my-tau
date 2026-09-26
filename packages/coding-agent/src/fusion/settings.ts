/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { getThinkingLevelMetadata } from "@oh-my-pi/pi-tui/thinking";
import { register } from "../config/registry";

// Fusion mode: a frontier lead that plans, briefs, and reviews, paired with
// one persistent sidekick subagent that implements and verifies.
export const cfgFusionEnabled = register({
	id: "fusion.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "fusion",
		group: "Fusion",
		label: "Fusion Mode",
		description:
			"Pair the lead model with one persistent sidekick subagent that implements and verifies; the lead plans, briefs, and reviews. Mounts the `sidekick` tool when the sidekick model is available.",
	},
});

export const cfgFusionSidekickModel = register({
	id: "fusion.sidekickModel",
	type: "string",
	default: "devin/swe-2",
	ui: {
		tab: "fusion",
		group: "Fusion",
		label: "Sidekick Model",
		description: "Model selector for the sidekick subagent (provider/id, fuzzy id, or @role alias).",
	},
});

export const cfgFusionSidekickThinking = register({
	id: "fusion.sidekickThinking",
	type: "enum",
	values: THINKING_EFFORTS,
	default: "medium",
	ui: {
		tab: "fusion",
		group: "Fusion",
		label: "Sidekick Thinking",
		description: "Reasoning depth for the sidekick subagent.",
		options: THINKING_EFFORTS.map(getThinkingLevelMetadata),
	},
});
