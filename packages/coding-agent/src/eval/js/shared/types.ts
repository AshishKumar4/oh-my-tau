/**
 * Structured status payload emitted by helpers (`read`, `write`, `env`, etc.) and the
 * tool-call bridge. Surfaces to the model as part of `displays` so it has machine-readable
 * context about what side effects happened.
 */
export interface JsStatusEvent {
	op: string;
	[key: string]: unknown;
}

/**
 * One unit of structured output from a JS eval cell. `text` chunks flow through a separate
 * channel.
 */
export type JsDisplayOutput =
	| { type: "json"; data: unknown }
	| { type: "image"; data: string; mimeType: string }
	| { type: "status"; event: JsStatusEvent };

/**
 * Property key marking the error `exit()` throws under the codex exec surface.
 * `Symbol.for` keeps it identical across realms (worker realm vs host realm);
 * the worker treats a caught error carrying it as a successful early end of
 * the cell, mirroring the vendor's `exit()` helper.
 */
export const CODEX_EXEC_EXIT_KEY = Symbol.for("omp.codexExec.exit");

/** Whether `error` is the codex `exit()` sentinel rather than a real failure. */
export function isCodexExecExit(error: unknown): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		(error as Record<PropertyKey, unknown>)[CODEX_EXEC_EXIT_KEY] === true
	);
}

/**
 * Globals the codex exec surface owns while installed — both the vendor
 * helpers and the `tools` proxy it substitutes for the native one. The worker
 * records these with the runtime's global-owner stack after every
 * install/uninstall so stacked runtimes restore the right values.
 */
export const CODEX_EXEC_GLOBAL_KEYS = [
	"tools",
	"__omp_tool_catalog__",
	"__omp_codex_store__",
	"text",
	"notify",
	"exit",
	"image",
	"audio",
	"generatedImage",
	"store",
	"load",
	"yield_control",
	"ALL_TOOLS",
] as const;
