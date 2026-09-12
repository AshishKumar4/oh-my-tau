/**
 * Fusion mode configuration: a frontier lead paired with one persistent
 * sidekick subagent. This module owns every settings-derived Fusion decision
 * (is this session a lead, which model the sidekick runs on) and the
 * registry lookup that makes "exactly one sidekick per lead" true.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { HarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import type { ModelRegistry } from "../config/model-registry";
import { getModelMatchPreferences, resolveCliModel } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { HARNESS_JOB_WAIT_FACADE } from "../harness/facades";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentDefinition } from "../task/types";

/** Agent definition name of the sidekick; also its registry display name. */
export const SIDEKICK_AGENT_NAME = "sidekick";
/** Registry id requested for the sidekick (the output manager may suffix it on collision). */
export const SIDEKICK_LABEL = "Sidekick";
/** Tool the lead hands work off with. */
export const SIDEKICK_TOOL_NAME = "sidekick";

/** How the lead names itself to the user under each harness profile; `assistant` otherwise. */
const LEAD_IDENTITY_BY_PROFILE: Readonly<Record<HarnessProfile, string>> = {
	"claude-code": "Claude Code",
	codex: "Codex",
};

/** Template data the lead prompt and the `sidekick` tool description render their slots from. */
export interface FusionPromptData extends Record<string, unknown> {
	sidekickTool: string;
	/** The tool the lead waits for a background handoff with: the profile's job-wait facade, else `hub`. */
	readTool: string;
	leadIdentity: string;
}

export function buildFusionPromptData(options: {
	profile: HarnessProfile | undefined;
	/** Presented names of mounted tools (`toolRefs`); the sidekick entry must be present. */
	toolRefs: Readonly<Record<string, string>>;
}): FusionPromptData {
	const { profile, toolRefs } = options;
	const hubRef = toolRefs.hub ?? "hub";
	return {
		sidekickTool: toolRefs[SIDEKICK_TOOL_NAME] ?? SIDEKICK_TOOL_NAME,
		readTool: profile === undefined ? hubRef : HARNESS_JOB_WAIT_FACADE[profile].wireName,
		leadIdentity: profile === undefined ? "assistant" : LEAD_IDENTITY_BY_PROFILE[profile],
	};
}

export interface FusionSessionLike {
	settings: Settings;
	taskDepth?: number;
	/** The agent definition a subagent session runs under; undefined for the top-level session. */
	agentDefinition?: Pick<AgentDefinition, "sidekick">;
}

/**
 * The single source of truth for "does this session lead a sidekick": Fusion
 * is on, and the session is either the root or a subagent whose agent
 * definition opted in with `sidekick: true`. Every Fusion gate (tool mount,
 * lead prompt, direct-edit reminder, report-first notice) goes through here.
 */
export function isFusionLead(session: FusionSessionLike): boolean {
	if (!session.settings.get("fusion.enabled")) return false;
	return (session.taskDepth ?? 0) === 0 || session.agentDefinition?.sidekick === true;
}

export interface SidekickModelResolution {
	pattern: string;
	model: Model<Api> | undefined;
	/** Actionable reason the sidekick cannot run when `model` is undefined. */
	error?: string;
}

/**
 * Resolve `fusion.sidekickModel` the way `/model` resolves a selector, then
 * require configured auth: a catalog-only model would mount a tool whose
 * every call fails at spawn.
 */
export function resolveSidekickModel(settings: Settings, modelRegistry: ModelRegistry): SidekickModelResolution {
	const pattern = (settings.get("fusion.sidekickModel") ?? "").trim();
	if (!pattern) return { pattern, model: undefined, error: "fusion.sidekickModel is empty." };
	const resolved = resolveCliModel({
		cliModel: pattern,
		modelRegistry,
		settings,
		preferences: getModelMatchPreferences(settings),
	});
	if (!resolved.model) {
		return {
			pattern,
			model: undefined,
			error: resolved.error ?? `Sidekick model "${pattern}" is not in the model registry.`,
		};
	}
	if (!modelRegistry.hasConfiguredAuth(resolved.model)) {
		return {
			pattern,
			model: undefined,
			error: `No API key configured for sidekick model ${resolved.model.provider}/${resolved.model.id}.`,
		};
	}
	return { pattern, model: resolved.model };
}

/** Every live sidekick in this process, one per lead (the top-level session and each opted-in subagent lead). */
export function listSidekickRefs(): AgentRef[] {
	return AgentRegistry.global()
		.list()
		.filter(ref => ref.displayName === SIDEKICK_AGENT_NAME && ref.status !== "aborted");
}

/**
 * The lead's live sidekick, if one has been spawned in this process: the
 * registry is the source of truth for "exactly one sidekick per lead", so a
 * remounted tool and the session's own hooks agree on which agent it is. A
 * sidekick is registered under its own lead's id, so subagent leads never
 * share the root session's sidekick or each other's.
 */
export function findSidekickRef(leadId: string): AgentRef | undefined {
	return listSidekickRefs().find(ref => ref.parentId === leadId);
}

/** How `/fusion status` names the lead a sidekick belongs to. */
export function describeSidekickOwner(ref: AgentRef): string {
	return ref.parentId === undefined || ref.parentId === MAIN_AGENT_ID ? "top-level" : ref.parentId;
}
