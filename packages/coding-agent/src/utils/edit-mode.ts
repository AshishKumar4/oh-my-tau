import type { Model } from "@oh-my-pi/pi-ai";
import { resolveHarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import { classifyModel } from "@oh-my-pi/pi-catalog/identity";
import { $env, $flag } from "@oh-my-pi/pi-utils";

export type EditMode = "replace" | "patch" | "hashline" | "apply_patch" | "sloppy";

export const DEFAULT_EDIT_MODE: EditMode = "hashline";

const EDIT_MODE_IDS = {
	apply_patch: "apply_patch",
	hashline: "hashline",
	patch: "patch",
	replace: "replace",
	sloppy: "sloppy",
} as const satisfies Record<string, EditMode>;

export const EDIT_MODES = Object.keys(EDIT_MODE_IDS) as EditMode[];

export function normalizeEditMode(mode?: string | null): EditMode | undefined {
	if (!mode) return undefined;
	return EDIT_MODE_IDS[mode as keyof typeof EDIT_MODE_IDS];
}

export interface EditModeSettingsLike {
	get(key: "edit.mode"): unknown;
	getEditVariantForModel?(model: string | undefined): EditMode | null;
}

export interface EditModeSessionLike {
	settings: EditModeSettingsLike;
	getActiveModelString?: () => string | undefined;
	getActiveModel?: () => Model | undefined;
}

export function resolveEditMode(session: EditModeSessionLike): EditMode {
	const activeModel = session.getActiveModelString?.();
	const modelVariant = session.settings.getEditVariantForModel?.(activeModel);
	if (modelVariant) return modelVariant;

	const envMode = normalizeEditMode($env.PI_EDIT_VARIANT);
	if (envMode) return envMode;

	const settingsMode = normalizeEditMode(String(session.settings.get("edit.mode") ?? ""));
	const mode = settingsMode ?? DEFAULT_EDIT_MODE;
	if (mode === "hashline" && !$flag("PI_STRICT_EDIT_MODE")) {
		const model = session.getActiveModel?.();
		const profile = model && resolveHarnessProfile(model);
		if (profile === "claude-code") return "replace";
		// Codex's editing primitive is the freeform V4A apply_patch; the codex
		// profile serves `tools.apply_patch` inside exec, which bridges to this
		// tool — it must speak V4A, not hashlines.
		if (profile === "codex") return "apply_patch";
		if (activeModel) {
			const identity = classifyModel("", activeModel, { lenient: true });
			if (
				identity.class === "kimi" ||
				identity.class === "mimo" ||
				identity.class === "deepseek" ||
				identity.class === "stepfun"
			) {
				return "replace";
			}
		}
	}
	return mode;
}
