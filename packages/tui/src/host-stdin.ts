/**
 * Ownership marker for the process-wide stdin reader.
 *
 * The extension/hook host guard (`withHostGuard` in coding-agent) fences
 * third-party module evaluation off from host state, and restores the stdin
 * listener set it snapshotted before the module ran. That is right for a module
 * that hijacks stdin, and unsafe for the TUI's own reader: the guard reconciles
 * by listener identity, so any reader attached after the snapshot is dropped,
 * and a `wasPaused` snapshot taken before the reader existed can re-pause the
 * stream. `terminal.start()` and `enableInput()` both attach, and custom tools
 * are re-loaded per session (`sdk.ts`, once per in-process subagent), so the
 * two can interleave. The failure mode is a process that reads nothing while it
 * keeps rendering: no keyboard or mouse input until it is killed.
 *
 * Listeners marked here survive that reconciliation. The marker lives in `tui`
 * because `coding-agent` depends on this package and not the reverse; keeping
 * one definition means the guard and the terminal cannot drift apart.
 */
export const HOST_STDIN_LISTENER: unique symbol = Symbol.for("omp.hostStdinListener") as never;

type StdinListener = (...args: never[]) => void;

/** Marks `listener` host-owned so {@link HOST_STDIN_LISTENER} consumers preserve it. */
export function markHostStdinListener<T extends StdinListener>(listener: T): T {
	Reflect.set(listener, HOST_STDIN_LISTENER, true);
	return listener;
}
