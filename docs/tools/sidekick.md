# sidekick

> Hand work to the Fusion lead's one persistent implementation worker: the first call spawns it, later calls continue the same agent, and a call made mid-handoff is steered into the running turn.

## Source
- Entry: `packages/coding-agent/src/tools/sidekick.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/sidekick.md`
- Handoff envelope: `packages/coding-agent/src/prompts/tools/sidekick-handoff.md`
- Key collaborators:
  - `packages/coding-agent/src/fusion/config.ts` — `isFusionLead`, `resolveSidekickModel`, `findSidekickRef` (one sidekick per lead), description slots.
  - `packages/coding-agent/src/fusion/settings.ts` — `fusion.enabled`, `fusion.sidekickModel`, `fusion.sidekickThinking`.
  - `packages/coding-agent/src/prompts/agents/sidekick.md` — the worker's agent definition and system prompt (`getSidekickAgent()` in `src/task/agents.ts`).
  - `packages/coding-agent/src/task/structured-subagent.ts` — first-handoff spawn (`runStructuredSubagent`).
  - `packages/coding-agent/src/task/executor.ts` — later handoffs (`runSubagentFollowUpTurn`).
  - `packages/coding-agent/src/async/job-manager.ts` — handoff jobs and report delivery.
  - `packages/coding-agent/src/prompts/system/fusion-lead.md` — the lead's Fusion section of the system prompt.
  - `packages/coding-agent/src/slash-commands/builtin-modes.ts` — `/fusion` (`on`, `off`, `status`, or a sidekick model selector).

## Registration / Visibility
- `loadMode = "essential"`, `strict = true`, `approval = "exec"`.
- Mounted only for a Fusion lead: `fusion.enabled = true` (default `false`) and the session is top-level or a subagent whose agent definition sets `sidekick: true`. The sidekick itself never gets the tool.
- `fusion.sidekickModel` (default `devin/swe-2`) must resolve the way `/model` resolves a selector and have configured auth; otherwise the tool is not mounted.
- A lead's explicit tool list gets `sidekick` added automatically unless the session sets `restrictToolNames`.
- `/fusion` changes the settings and remounts the tool and the lead prompt in place, without a new session.
- The sidekick is not a discoverable bundled agent: `task` cannot spawn one.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `message` | `string` (non-empty) | Yes | The brief: goal, plan, constraints, and how to verify. Trimmed before use. While a handoff is running it is steered into that handoff as an update. |
| `block` | `boolean` | No | Wait for the report inside this call. Default `true`. |

## Outputs
- Settled blocking handoff: the sidekick's report text, or `(the sidekick finished without a report)` when it returned nothing.
- `block: false`: `Handoff <n> dispatched to the sidekick (job \`<jobId>\`). Its report auto-delivers when it finishes; wait for it with \`<wait tool>\` rather than polling.`
- Blocking wait cut short (timeout or interrupt): `No report within 45m` or `The wait was interrupted`, then `; the sidekick is still working on handoff job \`<jobId>\`.` and the same wait hint.
- Mid-handoff call: `Update injected into the sidekick's running handoff (job \`<jobId>\`); its report will cover the updated brief.` The job part is absent for an inline handoff.
- `<wait tool>` is the tool the description names: `TaskOutput` under `claude-code` where the served capture declares it, otherwise `wait`. A session with no wait tool is told to end its turn instead; the report arrives as a notification.
- `details = { agentId?, jobId?, mode: "spawn" | "rebrief" | "interrupt", pending }`. `pending` is `true` when the call returned before the handoff settled.
- While a blocking call waits, progress updates read `Sidekick: <intent or current tool> (<n> tool calls, <duration>)`.

## Flow
1. Look up the lead's sidekick in the agent registry (keyed by the lead's agent id), or join a first spawn already in flight.
2. If that sidekick has a running handoff (an async job, or an inline handoff when async is off), steer the message into its live session wrapped as an assignment update and return at once (`mode: "interrupt"`).
3. Otherwise wrap the message in the handoff envelope: `Worker assignment. …` on the first handoff, `Assignment update. …` after that, with the brief inside `<lead_handoff>`.
4. First handoff (`mode: "spawn"`): run the bundled `sidekick` agent as a keep-alive subagent on the resolved model with `fusion.sidekickThinking`. Its system prompt names that model and effort; its artifacts are retained; LSP follows `task.enableLsp`. A second call during the spawn steers into it instead of spawning a twin.
5. Later handoffs (`mode: "rebrief"`): run a follow-up turn on the same agent, which keeps its conversation, shell, and process state.
6. With `async.enabled`, each handoff is a `task` job labelled `Sidekick handoff <n>` and owned by the lead. A blocking call waits for the job up to 45 minutes or until the call is aborted, and consumes the result so it is not delivered twice. Without async, the handoff runs inline and the call blocks until it ends.
7. While the lead blocks on a handoff, it is published as awaiting its sidekick. A sidekick parked in a message-only `wait` then returns instead of waiting on a lead that cannot answer.

## Modes / Variants
- Spawn, re-brief, and interrupt, as above.
- Blocking (default) or non-blocking dispatch. A blocking wait that times out or is interrupted becomes a background handoff whose report self-delivers.
- Per-lead sidekicks: the top-level session and each opted-in subagent lead get their own; they never share one.

## Side Effects
- Spawns and keeps alive one subagent per lead. It shares the filesystem and repository, edits files, and runs commands with its own tools (`read`, `edit`, `write`, `bash`, `grep`, `glob`, `eval`, `todo`).
- Registers an async job per handoff when async is on. Reports arrive as background results.
- Spends tokens on the sidekick model, which is pinned for the worker.

## Limits & Caps
- One sidekick per lead. Concurrent calls fold into the running handoff instead of queueing a second one.
- A blocking call waits at most 45 minutes (`SIDEKICK_MAX_BLOCK_SECONDS = 2700`). The handoff itself keeps running past that.
- The worker runs with the tool set its agent definition lists.

## Errors
- `Cannot spawn the sidekick: <reason>` when the sidekick model no longer resolves or the spawn is rejected.
- `Sidekick handoff failed: <error>` when the handoff exits non-zero or reports an error.
- `Sidekick handoff was cancelled[: <reason>]` when the handoff is aborted.
- `Sidekick <id> is mid-handoff but has no live session; wait for job <jobId> to settle, then re-brief.` when an update cannot be steered.
- `Sidekick spawn requires a model registry on this session.`

## Notes
- The lead keeps planning, decisions, and review. The lead prompt tells it to hand implementation and check runs to the sidekick, and to review the worker's full diff itself.
- `/fusion status` lists the lead model, the sidekick model and thinking level, and every live sidekick with its owner.
- While Fusion is on, the status line's model segment shows `<lead> ⚡ <sidekick-id>`.
