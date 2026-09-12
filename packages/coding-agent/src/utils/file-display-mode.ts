/**
 * Resolve line-display mode for file-like outputs (read, grep, @file mentions).
 */

import { resolveHarnessProfile } from "@oh-my-pi/pi-catalog/compat/harness";
import { type EditModeSessionLike, resolveEditMode } from "./edit-mode";

/**
 * Shape of a plain line-number prefix: omp's `N|` or `cat -n`'s `%6d\t`.
 * Claude Code's `Read` returns the latter and its `Edit` tells the model to
 * strip "line number + tab", so under that profile the model gets the shape
 * it was trained against.
 */
export type LineNumbering = "pipe" | "cat";

export interface FileDisplayMode {
	lineNumbers: boolean;
	hashLines: boolean;
	numbering: LineNumbering;
}

/** Session-like object providing settings and tool availability for display mode resolution. */
export interface FileDisplayModeSession extends EditModeSessionLike {
	/** Whether the edit tool is available. Hashlines are suppressed without it. */
	hasEditTool?: boolean;
	settings: EditModeSessionLike["settings"] & {
		get(key: "readLineNumbers" | "edit.mode"): unknown;
	};
}

/**
 * Computes effective line display mode from session settings/env.
 * Hashline mode takes precedence and implies line-addressed output everywhere.
 * Hashlines are suppressed when the edit tool is not available (e.g. scout agents),
 * when the caller signals a `raw` read, and when the source is `immutable`
 * (e.g. internal URLs like artifact://, agent://, memory:// — there is no edit
 * path that could consume the anchors). Raw output is returned as-is.
 */
export function resolveFileDisplayMode(
	session: FileDisplayModeSession,
	options?: { raw?: boolean; immutable?: boolean },
): FileDisplayMode {
	const { settings } = session;
	const hasEditTool = session.hasEditTool ?? true;
	const editMode = resolveEditMode(session);
	const usesHashLineAnchors = editMode === "hashline";
	const raw = options?.raw === true;
	const immutable = options?.immutable === true;
	const hashLines = !raw && !immutable && hasEditTool && usesHashLineAnchors;
	const model = session.getActiveModel?.();
	const vendorNumbering = model !== undefined && resolveHarnessProfile(model) === "claude-code";
	return {
		hashLines,
		numbering: vendorNumbering ? "cat" : "pipe",
		lineNumbers: !raw && (hashLines || vendorNumbering || settings.get("readLineNumbers") === true),
	};
}
