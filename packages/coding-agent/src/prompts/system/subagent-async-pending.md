Your `yield` recorded; {{count}} background job{{#if multiple}}s{{/if}} you own {{#if multiple}}are{{else}}is{{/if}} still running: {{jobs}}.

This run completes only after jobs settle AND you submit a fresh `yield` that accounts for results. Job results arrive as follow-up messages; a result after your `yield` supersedes it — it will NOT be accepted as final report. Decide now:
{{#if toolRefs.TaskStop}}- Job no longer needed? Call `{{toolRefs.TaskStop}}` with its id to cancel; re-yield.
- Otherwise stand by; when each result arrives{{else}}{{#if toolRefs.deviceWrite}}- Job no longer needed? Write `proc://<id>/kill` without `content` to cancel; re-yield.
- Otherwise stand by; when each result arrives{{else}}- Stand by; when each result arrives{{/if}}{{/if}}, submit a fresh `yield` that incorporates it (repeat report unchanged if result does not affect it).
