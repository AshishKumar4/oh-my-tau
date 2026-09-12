<p align="center">
  <strong>oh-my-tau</strong><br>
  <em>A fork of Oh My Pi that lets a model keep the coding agent it was trained on, and pairs it with a cheaper sidekick.</em>
</p>

<p align="center">
  Fork of <a href="https://github.com/can1357/oh-my-pi">Oh My Pi</a> by <a href="https://github.com/can1357">@can1357</a>,
  itself a fork of <a href="https://github.com/badlogic/pi-mono">Pi</a> by <a href="https://github.com/mariozechner">@mariozechner</a>.
</p>

> **Disclaimer:** an AI assistant writes and maintains this document. It is presented as-is.

τ = 2π. Oh My Pi went past Pi, and this goes past Oh My Pi. Everything upstream ships is here; read the
[upstream README](https://github.com/can1357/oh-my-pi#readme) for the agent itself, its providers, tools and configuration.
This page covers only what the fork adds: harness profiles and Fusion mode.

## Harness profiles

Frontier models are post-trained against a specific coding agent. Claude Opus 5 and Fable 5.1 learned Claude Code.
GPT-6 Astra and GPT-5.6 Sol learned Codex. Each one has a house style: its own tool names, its own schemas, its own
system prompt. Run those models under a different agent and you are asking them to work in a house they do not know.

This fork lets them keep the house. Under a *harness profile*, omp presents the vendor's surface instead of its own:

| | Claude Code profile | Codex profile |
|---|---|---|
| Models | `claude-opus-5`, `claude-fable-5-1` | `gpt-6-astra`, `gpt-5.6-sol` |
| Tools | `Read`, `Write`, `Edit`, `Bash`, `Agent`, `AskUserQuestion`, `WebSearch`, `WebFetch`, `Skill`, `SendMessage`, `ListAgents`, `TaskOutput`, `TaskStop` | `exec` with its grammar, namespaced `functions` / `collaboration` groups |
| Tool descriptions and schemas | the vendor's own, verbatim from the capture | the vendor's own, verbatim from the capture |
| System prompt | the real Claude Code prompt, recorded per model | the real Codex prompt |
| Prompt cache | identity and last system block at 1h, matching the client | unchanged |

The capture is recorded once per model, because the vendor prompt names the model it runs on. A Fable session reads
Fable's prompt and an Opus session reads Opus's.

Tools with no vendor counterpart are **bridged, not hidden**. `SendMessage`, `ListAgents`, `TaskOutput` and `TaskStop`
map onto omp's `hub`; `spawn_agent` and `wait_agent` map onto `task`. The call executes as the real omp tool and is
recorded under the omp name, so approval policy, renderers, session state and subagent accounting all keep working.
The agent still sees omp's full tool layer. Nothing is taken away to make the costume fit.

Every other model is untouched. The profile is chosen by model lineage, so a Haiku or Gemini session behaves exactly
as it does upstream.

## Fusion mode

Fusion is Cognition's two-agent harness for Devin, ported here from the Devin CLI. A frontier **lead** owns the
session: it talks to you, plans, writes briefs and reviews the result. One persistent **sidekick** does the hands-on
work: it explores, implements, runs the tests and reports back. The two exchange briefs and reports, never their
conversations, so each keeps its own warm prompt cache.

The lead prompt and the sidekick prompt are the ones the Devin CLI ships. The lead gets one extra tool, `sidekick`,
with the same contract: blocking by default, re-briefable while it runs, exactly one sidekick per session. Nothing
else changes for the lead; it keeps the profile above and omp's full tool layer.

```
/fusion                 toggle
/fusion on | off
/fusion status          lead, sidekick, and the live sidekick's id and usage
/fusion devin/swe-2:high   change the sidekick model or its thinking level
```

The default sidekick is `devin/swe-2`, which needs a Devin login (`omp` reads the same credentials the Devin CLI
uses). The settings panel has a **Fusion** tab, and the status line shows the pair as `fable-5-1 ⚡ swe-2` while it
is on. The lead prompt costs about 5,000 tokens of cached prefix per request.

On one SWE-bench Verified instance rated 1 to 4 hours (`django__django-15957`), an Opus lead with an SWE-2 sidekick
passed all 4 hidden tests and kept all 75 regression tests green. The lead spent 28 turns investigating and wrote
one 8,800-character brief; the sidekick made the 3 edits and ran the tests. More runs are in progress.

## Install

```sh
git clone https://github.com/AshishKumar4/oh-my-pi.git
cd oh-my-pi
./scripts/install-harness.sh
```

The repository is still named `oh-my-pi` while the rename to `oh-my-tau` is pending; use the URL above until it moves.

The script builds the binary, installs it beside any existing `omp` (backing that one up first), and records the
vendor prompts. It needs `bun`, `cargo`, `git` and `python3`. It records a Claude Code capture if `claude` is on
your PATH (one per model, Fable and Opus by default; set `OMP_HARNESS_CLAUDE_MODELS` to change the list), and a
Codex capture if `codex` is.

Split the phases with `--build-only` or `--record-only`. Re-run it after upgrading Claude Code or Codex: captures are
keyed by client version, and an older one keeps serving until you refresh it.

## Why the prompts are recorded and not shipped

The vendor system prompts are proprietary text. Committing them would redistribute someone else's copyrighted work,
so this repository contains none of it. The test fixtures store structure only, never prose.

Instead the script records the prompt locally from the client you already license. It starts a loopback recording
gateway, points a real `claude` or `codex` session at it once, and stores what that client sent under
`~/.omp/cache/harness/<profile>/`. Your captures never leave your machine.

Recording binds to loopback only. A capture becomes the system prompt of later sessions, so anything that could reach
the gateway could author them.

## Configuration

| Setting | Effect |
|---|---|
| `OMP_HARNESS_CACHE_DIR` | where captures are read from; point it elsewhere to park them |
| `providers.cacheRetention` | `short` restores 5-minute prompt caching under the profile |
| `skills.ignoredSkills` | drop skills you never use from the prompt |
| `tools.disabled` | built-in tools that never mount, by name (`glob`, `grep`, `manage_skill`) |
| `tools.xdevDocs: catalog` | stop inlining `xd://` device docs |
| `fusion.enabled` | Fusion mode on or off; `/fusion` writes this |
| `fusion.sidekickModel` | the sidekick, default `devin/swe-2` |
| `fusion.sidekickThinking` | the sidekick's thinking level, default `medium` |

To turn impersonation off without uninstalling, move `~/.omp/cache/harness` aside. Tool renaming and cache framing
follow the profile; the vendor prompt needs a capture.

## Known gaps

- **The sidekick prompt variant is fixed to the strong one.** Devin tunes its lead prompt by sidekick strength; this
  port uses the SWE-2 (strong) variant. Pointing `/fusion` at a weaker sidekick does not switch to the weak variant.
- **Devin's server-side harness bundles are not captured.** The CLI applies per-role "harness UIDs" it fetches at
  runtime. Everything embedded in the client, the whole lead and sidekick prompts, is here; those bundles are not.
- **`hub` and `eval` stay visible** under a profile, though no vendor ships them. That is the design: the agent keeps
  omp's full capability rather than a reduced impersonation.
- **The Codex profile has no live inference turn yet.** Its prompt, tool surface and wire shape are verified against
  a real capture at unit and gateway level, but no completion has come back from a profiled Codex request.
- Beta headers diverge from the captured client in both directions. Recorded in the golden fixtures, not fixed.

## Staying current

The fork tracks upstream by merge, not rebase, so `main` here is upstream `main` plus the harness work. Upstream
releases do not reach a from-source install, so re-run the install script to pick up a newer merge.

## Credits and licence

All of the agent is upstream work by [@can1357](https://github.com/can1357) and, before that,
[@mariozechner](https://github.com/mariozechner). The fork adds two features on top. The Fusion prompts are Cognition's, recorded from the Devin CLI you license. Licence is unchanged from
upstream; see [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
