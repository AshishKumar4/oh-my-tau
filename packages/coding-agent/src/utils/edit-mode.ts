import type { Model } from "@oh-my-pi/pi-ai";
import { classifyModel } from "@oh-my-pi/pi-catalog/identity";
import { $flag } from "@oh-my-pi/pi-utils";
import { effectiveHarnessProfile } from "../harness/effective-profile";

import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit";
import type { Settings } from "../config/settings";
import { cfgEditMode, editModelVariants } from "../edit/settings";

/** First `edit.modelVariants` entry whose pattern occurs in `model` (case-insensitive). */
export function editVariantForModel(settings: Settings, model: string | undefined): EditMode | undefined {
	if (!model) return undefined;
	const modelLower = model.toLowerCase();
	return editModelVariants.get(settings).find(variant => modelLower.includes(variant.patternLower))?.mode;
}

export interface EditModeSessionLike {
	settings: Settings;
	getActiveModelString?: () => string | undefined;
	getActiveModel?: () => Model | undefined;
}

export function resolveEditMode(session: EditModeSessionLike): EditMode {
	const activeModel = session.getActiveModelString?.();
	const modelVariant = editVariantForModel(session.settings, activeModel);
	if (modelVariant) return modelVariant;

	const mode = cfgEditMode.get(session.settings);
	// `PI_EDIT_VARIANT` pins the mode exactly; only settings-derived hashline adapts to the model.
	if (cfgEditMode.provenance(session.settings) === "env") return mode;
	if (mode === "hashline" && !$flag("PI_STRICT_EDIT_MODE")) {
		const model = session.getActiveModel?.();
		const profile = model && effectiveHarnessProfile(session.settings, model);
		if (profile === "claude-code") return "replace";
		// Codex editing primitive is the freeform V4A apply_patch; the codex
		// profile serves tools.apply_patch inside exec, which bridges to this
		// tool — it must speak V4A, not hashlines.
		if (profile === "codex") return "apply_patch";
		if (activeModel) {
			const identity = classifyModel("", activeModel, { lenient: true });
			if (
				identity.class === "kimi" ||
				identity.class === "mimo" ||
				identity.class === "minimax" ||
				identity.class === "deepseek" ||
				identity.class === "stepfun" ||
				identity.family === "codex-spark" ||
				(identity.class === "glm" && identity.family === "flash" && identity.revision === "5.3.0")
			) {
				return "replace";
			}
		}
	}
	return mode;
}
