Loads deferred tools so they can be called. Deferred tools are announced by name only; until loaded, their schemas are unknown and calls to them fail.

Query forms:
- `select:<name>[,<name>...]` loads these tools by name
- keywords load up to `max_results` tools whose names or descriptions match best
- `+term` requires `term` in the tool name; remaining keywords rank the matches
