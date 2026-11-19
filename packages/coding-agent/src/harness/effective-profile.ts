import type { Model } from "@oh-my-pi/pi-ai";
import { type HarnessProfile, resolveHarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import type { ScopeLike } from "../config/registry";
import { servedHarnessPrompt } from "./capture";
import { harnessToolRefs } from "./manifest";
import { cfgHarnessMode } from "./settings";

/**
 * Profiles `auto` serves only while a valid capture of the vendor client is
 * loaded. Without one the model keeps omp's native surface instead of vendor
 * tool names under omp's own prompt.
 */
const AUTO_NEEDS_CAPTURE: Readonly<Record<HarnessProfile, boolean>> = {
	"claude-code": false,
	codex: false,
	pi: false,
	"gemini-cli": true,
};

/**
 * The profile `harness.mode` selects for `model` before `auto` asks for a
 * capture: the profile whose capture a session loads.
 *
 * - `native` forces `undefined` (omp tool names, prompts, and wire format).
 * - `auto` resolves the model's catalog profile.
 * - A profile value forces that surface onto any model, even one the catalog
 *   leaves unprofiled.
 */
export function harnessProfileCandidate(settings: ScopeLike, model: Model | undefined): HarnessProfile | undefined {
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
 * Effective harness profile for the active model under the persisted
 * `harness.mode` setting: {@link harnessProfileCandidate}, except that `auto`
 * leaves a capture-gated profile unserved until its capture has loaded.
 */
export function effectiveHarnessProfile(settings: ScopeLike, model: Model | undefined): HarnessProfile | undefined {
	const profile = harnessProfileCandidate(settings, model);
	if (profile === undefined || !AUTO_NEEDS_CAPTURE[profile] || cfgHarnessMode.get(settings) !== "auto") return profile;
	return servedHarnessPrompt(model, profile) === undefined ? undefined : profile;
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
