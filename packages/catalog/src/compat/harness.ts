import type { Model } from "../types";
import { HARNESS_PROFILES } from "./axes";
import { resolveCascade } from "./cascade";
import { resolveCatalogPolicy } from "./catalog-policy";

/**
 * Whether the transport is an agent client that builds the system prompt and
 * keeps the conversation itself (Antigravity CLI). The caller then contributes
 * only user and project context, presents every tool directly, and starts no
 * automatic side conversations: each would be a separate client conversation
 * that cannot share the primary's prompt cache.
 */
export function isAgentClient(model: Model): boolean {
	return resolveCatalogPolicy(model).agentClient === true;
}

export type HarnessProfile = (typeof HARNESS_PROFILES)[number];

function isHarnessProfile(value: unknown): value is HarnessProfile {
	return typeof value === "string" && (HARNESS_PROFILES as readonly string[]).includes(value);
}

/**
 * Keyed on the model object, never on its id: the profile axis selects on
 * api, class, family, and revision, and the per-request `prepareModel` clones
 * (cloudflare-ai-gateway, the OpenAI/Anthropic shims) re-emit one provider/id
 * pair under a rewritten api. A miss walks the whole rule cascade — measured
 * 7.7µs against a 10ns hit — and a live session resolves one object per model,
 * so the cascade runs once and the several hundred later reads are lookups.
 */
const RESOLVED_PROFILES = new WeakMap<Model, HarnessProfile | null>();

export function resolveHarnessProfile(model: Model): HarnessProfile | undefined {
	const memoized = RESOLVED_PROFILES.get(model);
	if (memoized !== undefined) return memoized ?? undefined;
	const { identity } = model;
	const profile = resolveCascade({
		provider: model.provider,
		api: model.api,
		class: identity.class,
		model: model.id,
		reasoning: Boolean(model.reasoning),
		...(identity.family !== undefined && { family: identity.family }),
		...(identity.revision !== undefined && { revision: identity.revision }),
	}).catalog.harnessProfile;
	const resolved = isHarnessProfile(profile) ? profile : null;
	RESOLVED_PROFILES.set(model, resolved);
	return resolved ?? undefined;
}
