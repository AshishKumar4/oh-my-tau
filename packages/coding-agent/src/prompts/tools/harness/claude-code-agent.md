Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.

{{#if spawningDisabled}}
Agent spawning is currently disabled.
{{else}}{{#if agents.length}}
Available agent types:
{{#if hasModelMentions}}`m<N>` = user-tagged model (`<model agent="m<N>" name="…"/>`), not specialist; spawn only when user names it.
{{/if}}{{#list agents join=""}}- `{{name}}`{{#if readOnly}} (READ-ONLY; investigation only, no edits){{/if}}{{#if blocking}} (BLOCKING; inline result){{/if}}: {{description}}
{{/list}}
{{/if}}{{/if}}

When using the Agent tool, specify a subagent_type to select an agent: `"fork"` forks yourself (the fork inherits your full conversation context); any other type — or omitting it — starts a fresh agent (`{{defaultAgent}}` by default).

## When to use

Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.

{{#if asyncEnabled}}
Agents run in the background and keep their tool output out of your context. If you are a fork, execute directly — don't re-delegate. You'll be notified when an agent completes. Never fabricate or predict a pending agent's results — the notification is never something you write yourself; if the user asks before it arrives, say it's still running.
{{else}}
If you are a fork, execute directly — don't re-delegate. The call returns once the agent finishes, with its final report.
{{/if}}

- The agent's final report is not shown to the user — relay what matters.
{{#if ircEnabled}}
- Use SendMessage with the agent's ID to continue a previously spawned agent with its context intact; a new Agent call starts fresh (except subagent_type: "fork", which inherits your context).
{{/if}}
- Each agent type's model, reasoning effort, and tools come from its definition.
- Read `history://<agentId>` for an agent's transcript and `agent://<agentId>` for its final output.
{{#if isolationEnabled}}
- `isolation: "worktree"` runs the agent on its own git worktree; {{#if applyIsolatedChanges}}its successful changes are applied back to your checkout{{else}}its changes stay in that worktree and are not applied{{/if}}.
{{/if}}
{{#if batchEnabled}}
- For several agents that share background, make one call with `tasks`: one agent per item (`description`, `prompt`, optional `subagent_type`). The top-level `prompt` is the shared brief every agent receives, so write the common context once instead of repeating it per item; the top-level `description` labels the batch. Items inside `tasks` cannot use `subagent_type: "fork"`.
{{/if}}
