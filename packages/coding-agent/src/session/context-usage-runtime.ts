import { type CompactionSettings, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	computeCompactionBoundaries,
	computeContextBreakdown,
	type CompactionBoundaries,
	type ContextBreakdown,
	type ContextSavingsEstimate,
} from "@oh-my-pi/pi-tui/status-line/context-usage";
import type { Settings } from "../config/settings";
import type { AgentSession } from "./agent-session";
import { resolveSpeculationMethod } from "./compaction-methods";
import { servedHarnessPrompt } from "../harness/capture";
import { effectiveHarnessProfile } from "../harness/effective-profile";
import { estimateInlineSavings } from "./snapcompact-inline";
import { resolveSpeculationLeadTokens } from "./speculation-lead";

/** Resolve session policy before handing pure boundary arithmetic to the UI. */
export function getSessionCompactionBoundaries(
	settings: Pick<Settings, "getGroup">,
	contextWindow: number,
	model?: Model | null,
): CompactionBoundaries | null {
	if (!(contextWindow > 0)) return null;
	const configured = settings.getGroup("compaction");
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
	model?: import("@oh-my-pi/pi-ai").Model;
	settings: Pick<Settings, "get">;
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
		const renderSystemPrompt = session.settings.get("snapcompact.systemPrompt");
		const renderToolResults = session.settings.get("snapcompact.toolResults");
		if (renderSystemPrompt !== "none" || renderToolResults) {
			snapcompact = estimateInlineSavings({
				options: { renderSystemPrompt, renderToolResults, shape: session.settings.get("snapcompact.shape") },
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
			settings: session.settings,
			// Bind rather than wrap: a duck-typed session without the method must
			// stay absent here, or the local-estimate branch is never taken and
			// the call throws instead.
			getContextBreakdown: session.getContextBreakdown?.bind(session),
		},
		{
			compaction: session.settings.getGroup("compaction"),
			sourceRevision: session.settings.revision,
			skillful: session.settings.get("skillful"),
			snapcompact,
		},
	);
}
