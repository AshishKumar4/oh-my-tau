import type { Model } from "@oh-my-pi/pi-ai";
import { HARNESS_PROFILES } from "@oh-my-pi/pi-catalog/compat/axes";
import { type HarnessProfile, resolveHarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import type { SettingPath, SettingValue } from "../config/settings-schema";

/**
 * Effective harness profile for the active model under the persisted
 * `harness.mode` setting.
 *
 * - `native` forces `undefined` (omp tool names, prompts, and wire format).
 * - `auto` resolves the model's catalog profile, preserving today's behavior.
 * - A profile value forces that surface onto any model, even one the catalog
 *   leaves unprofiled.
 */
export function effectiveHarnessProfile(
	settings: { get(path: SettingPath): unknown },
	model: Model | undefined,
): HarnessProfile | undefined {
	if (model === undefined) return undefined;
	const mode = settings.get("harness.mode");
	if (mode === "native") return undefined;
	if (mode === "auto") {
		// `resolveHarnessProfile` walks the compat cascade, which reads
		// `model.identity`; unshaped stubs (stream-fn tests) have none, and the
		// pre-change behavior on them was always "no profile".
		if (model.identity === undefined) return undefined;
		return resolveHarnessProfile(model);
	}
	const profile = mode as HarnessProfile;
	return (HARNESS_PROFILES as readonly string[]).includes(profile) ? profile : undefined;
}
