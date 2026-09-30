Executes a bash command and returns its output.

- Prefer absolute paths over `cd`, and do not rely on shell state (env vars, functions) carrying over between calls.
- Command output is displayed to you, not reliably to the user.
- `timeout` is in milliseconds: default {{defaultTimeoutMs}}, max {{maxTimeoutMs}}. Foreground-only calls use this default; background commands without an explicit timeout have no deadline.
- `run_in_background` runs the command detached: it keeps running across turns and its result is delivered to you when it exits. No `&` needed.
- `description` says in a few plain words what the command does; the user reads it instead of the command.
- Commands run without a terminal: avoid interactive flags such as `git rebase -i` or `git add -i`.
