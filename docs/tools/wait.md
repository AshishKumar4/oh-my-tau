# wait

> Block until the next background result, peer message, or steering interrupt when there is no other work to do.

## Source
- Entry: `packages/coding-agent/src/tools/wait.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/wait.md`
- Job delivery: `packages/coding-agent/src/async/job-manager.ts`

## Input and availability
`wait` has no arguments. It is an essential, read-approved, interruptible tool available when async jobs, peer messaging, or supervised services are enabled; it does not select a particular peer or job.

## Behavior
- Returns on the first settled caller-owned job or incoming peer message. Job results delivered by this call are consumed so no duplicate async-result follows.
- A steering/tool interrupt returns `Wait interrupted by message.` with `details.interrupted=true`; other aborts propagate. Handle the incoming notice before calling `wait` again.
- A single 2-hour safety cap returns a still-running snapshot; there is no polling ladder or per-call timeout.
- If no owned job, running visible peer, or owned service can wake it, returns immediately with “Nothing to wait for” and a snapshot.
- With no owned job or service, only a peer message can end the wait. It returns at once when a running peer is blocked on the caller's result — parked on it in an inline `task` spawn, a blocking `sidekick` handoff, an eval `wait()` with auto-background off, or a `wait` on its job — and no other agent that peer awaits (a sibling in the same fan-out, eval `wait()`, or `wait`) can still act, naming that peer, whatever else is running: a sibling that can still act may yet message the caller. Otherwise it keeps blocking while any running peer could still send a message. Once every running peer is itself blocked — in a message-only `wait`, or awaiting the caller or another blocked agent — it returns at once, naming those peers. When a blocked agent awaits one of the stuck waiters, only that waiter returns: its `yield` or message is what frees the rest. A spawn still queued for its concurrency permit counts as blocked, not as finishing on its own.
- With no owned jobs, a service finishing returns a notice directing the caller to `proc://` for status/output; with jobs, the call returns their current snapshot/result instead.
- Results and peer messages also auto-deliver without calling `wait`. Continue useful work instead of polling.
- Queued peer messages are checked first. Already-settled but undelivered owned jobs are returned without another wait. If a peer message wins a race with job completion, that job remains eligible for normal async delivery.
- Job waits emit progress snapshots every 500 ms when an update callback is present. Job results/snapshots use `details: { op: "wait", jobs: ... }`; peer-message results use the messaging result shape.

## Related surfaces
- `read proc://` lists caller-visible jobs and project services; `read proc://<id>` inspects state/output without consuming delivery.
- `write proc://<id>/kill` cancels a job or owned subagent, or stops a service; no `content` needed. Bare `proc://<id>` writes send stdin only to a service, including empty input.
- `write agent://<id>` sends a peer message; `agent://all` broadcasts to visible live peers. Bare `read history://` discovers registered agent transcripts. The final result of a subagent is delivered to its parent automatically.
- Start supervised services with `bash` `name` and optional `ready`; inspect and control them through `proc://`.
