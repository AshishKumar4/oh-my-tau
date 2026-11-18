<irc>
Incoming IRC message from agent `{{from}}`{{#if replyTo}} (reply to {{replyTo}}){{/if}}{{#if progress}} (progress; its reply follows later){{/if}}:

{{message}}

{{#if interrupting}}Sent while waiting/working. Active interruptible wait stopped early for immediate reading.{{/if}}

{{#unless progress}}{{#if relayOnStop}}{{#if toolRefs.SendMessage}}If response expected, reply via `{{toolRefs.SendMessage}}` (`to: "{{from}}"`, `message: "…"`), when available; otherwise what you `yield` or say last this turn is delivered to `{{from}}` when you stop.{{else}}{{#if toolRefs.deviceWrite}}If response expected, reply via `write` (`path: "agent://{{from}}"`, `content: "…"`), when available; otherwise what you `yield` or say last this turn is delivered to `{{from}}` when you stop.{{else}}If response expected, what you `yield` or say last this turn is delivered to `{{from}}` when you stop.{{/if}}{{/if}}{{else}}{{#if toolRefs.SendMessage}}If response expected, reply via `{{toolRefs.SendMessage}}` (`to: "{{from}}"`, `message: "…"`); may finish current step first. No one replies on your behalf.{{else}}{{#if toolRefs.deviceWrite}}If response expected, reply via `write` (`path: "agent://{{from}}"`, `content: "…"`); may finish current step first. No one replies on your behalf.{{/if}}{{/if}}{{/if}}{{#if toolRefs.SendMessage}} An acknowledgement or progress note before the real answer goes to `{{toolRefs.SendMessage}}` with `to: "{{from}}?progress"`, so `{{from}}` keeps waiting for the answer.{{else}}{{#if toolRefs.deviceWrite}} An acknowledgement or progress note before the real answer goes to `agent://{{from}}?progress`, so `{{from}}` keeps waiting for the answer.{{/if}}{{/if}}{{/unless}}
</irc>
