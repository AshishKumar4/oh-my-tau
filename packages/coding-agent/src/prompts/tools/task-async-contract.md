Results auto-deliver; NEVER poll.{{#if waitTool}} Completely blocked? Call `{{toolRefs.wait}}` to receive the first settled job{{#if ircEnabled}} or peer message{{/if}}.{{/if}}
{{#if ircEnabled}}{{#if toolRefs.SendMessage}}Coordinate while peers run via `{{toolRefs.SendMessage}}` (`to: "<id>"`, or `"all"` to broadcast).{{else}}{{#if toolRefs.deviceWrite}}Coordinate while peers run via `write agent://<id>` (or `agent://all` to broadcast).{{/if}}{{/if}}{{/if}}

{{#if toolRefs.read}}`{{toolRefs.read}} proc://` lists jobs/services; `{{toolRefs.read}} proc://<id>` inspects status/output without consuming delivery.{{/if}}{{#if toolRefs.TaskStop}} `{{toolRefs.TaskStop}}` (`task_id: "<id>"`) cancels/stops.{{else}}{{#if toolRefs.deviceWrite}} `write proc://<id>/kill` cancels/stops; omit `content`.{{/if}}{{/if}}

Job IDs are process-local; delivered results expire shortly (~30s), unconsumed results within ~5min. Agent output/transcripts remain readable at `agent://<id>` / `history://<id>`.{{#if ircEnabled}}{{#if toolRefs.SendMessage}} `{{toolRefs.SendMessage}}` messages a live agent.{{else}}{{#if toolRefs.deviceWrite}} `write agent://<id>` messages a live agent.{{/if}}{{/if}}{{/if}}

`completed`: subagent yielded successfully; claimed artifacts unverified.
