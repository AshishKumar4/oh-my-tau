# monitor

> Stream events from a long-running script or a WebSocket as notifications, Claude Code's `Monitor`.

## Source

- Entry: `packages/coding-agent/src/tools/monitor.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/monitor.md`
- Event delivery: `packages/coding-agent/src/session/monitor-events.ts`

## Input and availability

Claude Code's schema: `description` (shown in every notification), `timeout_ms` (default 300000; clamped to 1 second … 30 minutes), and exactly one of `command` (a shell script) or `ws` (`{ url, protocols? }`). It is a discoverable tool (`xd://` on the native surface); under the claude-code profile it is presented as `Monitor` and deferred behind ToolSearch, as Claude Code defers it. It needs the session's background job manager.

## Behavior

- Starts a background job of type `monitor` owned by the caller and returns its id at once.
- Each stdout line of `command` is an event; lines within 200 ms share one notification. Stderr goes to an output artifact the final notice names; it triggers nothing. The command runs in its own per-job shell with the same cwd, environment and git guard as a background `bash` job.
- With `ws`, each text frame is one event; binary frames arrive as `[binary frame, N bytes]`; socket errors are reported as events.
- Events reach the session that started the monitor through its completion-notice queue: they end a blocked `wait`, join a running turn at its next boundary, and start a turn in an idle session. They are queued ahead of job results, so a monitor's last events precede its end notice.
- The watch ends when the command exits (exit code reported), the socket closes (close code reported), the deadline passes, more than 30 notifications arrive within a minute, or the job is cancelled. One end notice says which, with the event count.
- The command passes the same approval as a background `bash` command (`BashTool.commandApproval`): interception, the user's `bash.patterns`, and critical commands. With an ACP client, a command asks permission like `bash`; a WebSocket monitor only receives and is read-approved.

## Related surfaces

- `write proc://<id>/kill` (Claude Code: `TaskStop`) cancels a monitor like any job; `read proc://<id>` shows its event count and latest event.
- `bash` with `async`/`run_in_background` and an `until` loop is the single-notification alternative.
