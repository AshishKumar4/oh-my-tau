# oh-my-tau profile

This is how I run OMP: my working rules, two extra subagents, the playbook I use to split work across them, and the two skills my rules depend on. It installs as an OMP plugin, so it works on oh-my-tau and on upstream OMP.

## What you get

| Piece | Where | What it does |
|---|---|---|
| Working rules | `rules/working-rules.md` | Applied to every session and subagent. How I want work done: root causes over patches, behavioural tests, strict code quality, plain writing, careful data handling, and how to delegate. |
| `expert` agent | `agents/expert.md` | Owns a large piece of work end to end in its own worktree: design, implementation, tests and review fixes. |
| `debugger` agent | `agents/debugger.md` | Reproduces a failure, proves its root cause, and writes a failing regression test. It proposes the fix; it doesn't ship it. |
| `lane-orchestration` skill | `skills/lane-orchestration/` | How the main agent runs expert, debugger, reviewer, task and scout lanes: briefs, verification, reviews, landing work, stacked work, and a project bible template. |
| `thermo-nuclear-code-quality-review` skill | `skills/` | The strict review every code review and pre-merge pass follows. |
| `no-ai-slop` skill | `skills/` | The standard for prose: docs, READMEs, PR descriptions. MIT-licensed; see its `NOTICE.md`. |

OMP's own `reviewer`, `task` and `scout` agents fill the other lanes.

## Install

From an oh-my-tau checkout, after `./scripts/install-harness.sh`:

```sh
omp plugin install ./profile
```

This links the directory, so `git pull` updates the profile too. To remove it, run `omp plugin uninstall oh-my-tau-profile`.

## Models

Both agents use the `slow` model role. Set it to your strongest model with `/model`, or in `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  slow: anthropic/claude-opus-5-5
```

Without a `slow` role they use your default model, or OMP's built-in choice if you haven't set one.

## Making it yours

The rules are written in my voice and reflect my preferences. Before you rely on them, read `rules/working-rules.md` and change what doesn't fit. Your project's own `AGENTS.md` still applies on top of them.
