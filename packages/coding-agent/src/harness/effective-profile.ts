import type { Model } from "@oh-my-pi/pi-ai";
import { type HarnessProfile, resolveHarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import type { ScopeLike } from "../config/registry";
import { harnessToolRefs } from "./manifest";
import { cfgHarnessMode } from "./settings";

/**
 * Effective harness profile for the active model under the persisted
 * `harness.mode` setting.
 *
 * - `native` forces `undefined` (omp tool names, prompts, and wire format).
 * - `auto` resolves the model's catalog profile, preserving today's behavior.
 * - A profile value forces that surface onto any model, even one the catalog
 *   leaves unprofiled.
 */
export function effectiveHarnessProfile(settings: ScopeLike, model: Model | undefined): HarnessProfile | undefined {
	if (model === undefined) return undefined;
	const mode = cfgHarnessMode.get(settings);
	if (mode === "native") return undefined;
	if (mode === "auto") {
		// `resolveHarnessProfile` walks the compat cascade, which reads
		// `model.identity`; unshaped stubs (stream-fn tests) have none, and the
		// pre-change behavior on them was always "no profile".
		if (model.identity === undefined) return undefined;
		return resolveHarnessProfile(model);
	}
	return mode;
}

/**
 * `toolRefs` for a tool session: the names of the tools it presents right now
 * (see `harnessSurface`). A bare session with no presentation owner gets the
 * literal omp names.
 */
export function sessionToolRefs(session: {
	getToolRefs?: () => Readonly<Record<string, string>>;
}): Readonly<Record<string, string>> {
	return session.getToolRefs?.() ?? harnessToolRefs(undefined);
}
