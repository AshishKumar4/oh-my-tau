---
name: lane-orchestration
description: Running work as Main across expert, debugger, reviewer, task and scout lanes. Use when work splits into parallel lanes or worktrees, when briefing, reviewing or merging a lane's work, or when keeping a project bible.
---

# Lane orchestration

Main orchestrates; lanes do the work. Main owns the design, every brief, every merge, the integration tip and the owner's questions. Main does small fixes itself.

## Roles

| Lane | Owns | Spawns |
|---|---|---|
| `expert` | One large area end to end, in its own worktree and branch: design, implementation, tests, review fixes. | Scouts freely; a reviewer or a task when it clearly pays off. Never another expert. |
| `debugger` | A failure with an unknown cause: reproduction, proven root cause, a red regression test on its own branch. It proposes the fix; the parent applies it. | Nothing. |
| `reviewer` | Every judgment: code review, audits, design critique. Loads `skill://thermo-nuclear-code-quality-review`. Findings by severity, each with evidence. | Nothing. |
| `task` | Mechanical, fully specified work: applying a verdict, operating a tool. | Nothing. |
| `scout` | Read-only search, code maps, git and data collection. | Nothing. |

- A task lane never designs or implements a feature. Expert work goes to an expert.
- Set `subagent_type` on every `tasks[]` item.
- Keep the number of expert lanes to what the owner approved. Ask before opening another; absorb new work into Main or an existing lane.

## Briefs

Every brief carries the same parts, in this order:

1. **Where**: worktree path, branch, base commit; what the lane must never touch (the primary checkout, other lanes' worktrees, live projects).
2. **What**: the work items, ordered, each with its source (issue, upstream commit, finding).
3. **Why**: the owner's goal and setup, so the lane can make judgment calls.
4. **How**: the project's conventions (commit shape, test rules, banned patterns); the contracts the lane must keep; "read the bible in full first".
5. **Output contract**: exactly what to report: commits, red/green evidence per fix, suites run with counts, risks, anything not done.

Brief the contract a change must keep, not only the number to hit. A lane told to beat a benchmark without its contracts will trade them away.

## Verifying a lane

- Read the diff and the evidence before merging. A lane's report is a claim.
- Reproduce one red/green yourself for each fix the decision rests on.
- A scout's "missing" or "present" is a cheap grep. Check the symbol yourself before acting on it.
- Never edit a worktree while its full test tier runs. The run stops proving anything; stop it, edit, commit, rerun.

## Reviews

- Save each reviewer's findings to disk the moment they arrive. A later wake overwrites `agent://` output.
- Ask for every finding in one pass. Rounds that drip one finding at a time multiply cost.
- Review rounds find bugs in the fixes for earlier findings. Ask for the fix that removes mechanism (delete the cache, reuse the one contract) over the one that adds it; that is what makes the rounds converge.
- Fix findings at the root, on the integrated result. Pull a lane off its work only for findings in its own area.
- Visual work (UI, design, wireframes): the building lane judges its own work at full size, every state. Reviewer, scout and debugger lanes stay off it. Main inspects every state before the owner sees anything.

## Ownership

- One owner per contract, per file, per list or table. A head that touches another lane's file starts with a design note of ten lines or fewer to Main. Main checks the note's claims before approving it.
- Before reshaping or removing something, find why it exists (`git log -S`, design notes). A rewrite carries a parity list: every capability of the old code mapped to the new code or to a drop the owner approved.
- A head is one complete, coherent change. Split only where each part stands on its own.

## Landing

- Finished, green, reviewed work lands now. Never hold it for a bigger head or for work not yet started.
- Merge every finished lane into one integration tip, then run one release from it. Never ship a smaller candidate and queue the rest behind it.
- Gate a lane's merge on the whole test tier on its tip. Run live and staging checks once, on the integrated tip, not per lane.
- Main resolves every integration conflict and fixes every finding on the integrated result.
- Pin a recoverable snapshot (a backup ref) before moving integrated work into the primary checkout.

## Stacked work

Dependent work never waits. A consumer stacks on its producer, and the lanes form a DAG:

1. Stack on the producer's landed commit, or on a base branch Main publishes (main plus the producer). Never on a batch tip.
2. Depth two at most.
3. A producer never rewrites a commit others stack on; it fixes with new commits.
4. Main keeps the DAG (producer, consumers, commits) in a file and tells consumers when a producer moves.
5. A consumer lands with its producer or after it. Dropping a producer from a batch drops its consumers.

## Messages and lifecycle

- Message lanes by name. A broadcast to `all` wakes every finished agent.
- Close finished helpers. Experts close their own.
- Don't poll a lane. Wait for its completion or its message.

## Machine

- Heavy suites run on a remote runner or under a memory cap (`systemd-run --user --scope -p MemoryMax=…`). Measure load with `pidstat`; `ps` shows lifetime averages.
- Work that must outlive the session runs as its own service unit. A child of an exiting shell dies silently.
- Scratch lives on disk, not in a RAM-backed `/tmp`. Remove it when done.
- Replace a running script atomically (temp file, then `mv`). Bash reads a script while it runs.
- No process outlives its task: no dev servers, probes or test servers left running.

## The project bible

Each long-running project keeps one bible: how Main runs it, distilled from the owner's own words, most recent wins, each decision dated. Every lane brief says to read it in full first. Add a lesson the moment a mistake costs time. Start from [`bible-template.md`](bible-template.md).
