import type { Model } from "@oh-my-pi/pi-ai";
import { type HarnessProfile, resolveHarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import type { SettingValue } from "../config/settings-schema";

/** Persisted `harness.mode` value; `auto` follows the active model's catalog profile. */
export type HarnessMode = SettingValue<"harness.mode">;

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
	settings: { get(path: "harness.mode"): HarnessMode },
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
	return mode;
}
