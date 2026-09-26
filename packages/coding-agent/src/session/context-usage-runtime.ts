import { type CompactionSettings, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	computeCompactionBoundaries,
	computeContextBreakdown,
	type CompactionBoundaries,
	type ContextBreakdown,
	type ContextSavingsEstimate,
} from "@oh-my-pi/pi-tui/status-line/context-usage";
import type { ScopeLike } from "../config/registry";
import type { AgentSession } from "./agent-session";
import { resolveSpeculationMethod } from "./compaction-methods";
import { servedHarnessPrompt } from "../harness/capture";
import { effectiveHarnessProfile } from "../harness/effective-profile";
import { estimateInlineSavings } from "./snapcompact-inline";
import { resolveSpeculationLeadTokens } from "./speculation-lead";

import { cfgSkillful } from "./settings";
import {
	cfgCompaction,
	cfgSnapcompactShape,
	cfgSnapcompactSystemPrompt,
	cfgSnapcompactToolResults,
} from "./context-settings";

/** Resolve session policy before handing pure boundary arithmetic to the UI. */
export function getSessionCompactionBoundaries(
	settings: ScopeLike,
	contextWindow: number,
	model?: Model | null,
): CompactionBoundaries | null {
	if (!(contextWindow > 0)) return null;
	const configured = cfgCompaction.get(settings);
	const compaction: CompactionSettings = configured;
	if (!compaction.enabled || compaction.strategy === "off") return null;
	const threshold = resolveThresholdTokens(contextWindow, compaction);
	if (!(threshold > 0) || threshold > contextWindow) return null;
	const speculates = configured.asyncEnabled !== false && resolveSpeculationMethod(model, configured) !== undefined;
	return computeCompactionBoundaries(
		compaction,
		contextWindow,
		speculates ? resolveSpeculationLeadTokens(threshold) : undefined,
	);
}

/**
 * Vendor-prompt reference for skills-subtraction placement: when a harness
 * profile serves the recorded vendor prompt as system-prompt block 0, omp's
 * own template (carrying the skills listing) moves to block 1. The loaded
 * prompt object is stable per profile, so identity comparison is cheap.
 */
export function sessionVendorPromptRef(session: {
	model?: Model;
	settings: ScopeLike;
}): { readonly text: string } | undefined {
	return servedHarnessPrompt(session.model, effectiveHarnessProfile(session.settings, session.model));
}

/** Read host settings and optionally run the provider's inline-image planner. */
export function computeSessionContextBreakdown(
	session: AgentSession,
	options?: { snapcompactSavings?: boolean },
): ContextBreakdown {
	let snapcompact: ContextSavingsEstimate | undefined;
	if (options?.snapcompactSavings) {
		const renderSystemPrompt = cfgSnapcompactSystemPrompt.get(session.settings);
		const renderToolResults = cfgSnapcompactToolResults.get(session.settings);
		if (renderSystemPrompt !== "none" || renderToolResults) {
			snapcompact = estimateInlineSavings({
				options: { renderSystemPrompt, renderToolResults, shape: cfgSnapcompactShape.get(session.settings) },
				model: session.model,
				systemPrompt: session.systemPrompt ?? [],
				messages: session.messages ?? [],
			});
		}
	}
	// Read each member off the live session. Spreading it (`{ ...session }`)
	// copies own enumerable properties only, so every class-body getter and
	// method is dropped: `messages`, `systemPrompt` and `skills` arrive
	// undefined and `getContextBreakdown` disappears, which silently demotes
	// this to a local estimate over an empty conversation.
	return computeContextBreakdown(
		{
			model: session.model,
			vendorPromptRef: sessionVendorPromptRef(session),
			agent: session.agent,
			messages: session.messages,
			systemPrompt: session.systemPrompt,
			skills: session.skills,
			// Bind rather than wrap: a duck-typed session without the method must
			// stay absent here, or the local-estimate branch is never taken and
			// the call throws instead.
			getContextBreakdown: session.getContextBreakdown?.bind(session),
		},
		{
			compaction: cfgCompaction.get(session.settings),
			sourceRevision: session.settings.revision,
			skillful: cfgSkillful.get(session.settings),
			snapcompact,
		},
	);
}
