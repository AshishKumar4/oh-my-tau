Invoke a skill.

A skill is a packaged set of instructions the user or project has set up for a particular kind of task (deploy steps, a review checklist, a repo-specific workflow). Available skills are listed with their descriptions in the system prompt. When the task at hand is one a listed skill covers, call this tool first — the skill's instructions load into the turn for you to follow in place of your default approach.

- `skill`: exact name from the listing, no leading slash.
- `args`: optional arguments for the skill; they are passed along with its instructions.

Only names from the listing (or that the user typed explicitly) are valid.
