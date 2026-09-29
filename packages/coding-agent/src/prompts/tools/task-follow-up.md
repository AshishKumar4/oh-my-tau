{{#if aborted}}
{{#if resumable}}
{{agentId}} was stopped but is still resumable — {{#if ircEnabled}}{{#if toolRefs.SendMessage}}message it via `{{toolRefs.SendMessage}}` (`to: "{{agentId}}"`) to resume; {{else}}{{#if toolRefs.deviceWrite}}message it via `write agent://{{agentId}}` to resume; {{/if}}{{/if}}{{/if}}{{#if transcriptAvailable}}transcript at history://{{agentId}}{{else}}transcript unavailable{{/if}}
{{else}}
{{agentId}} was aborted — {{#if transcriptAvailable}}transcript at history://{{agentId}}{{else}}transcript unavailable{{/if}}
{{/if}}
{{else}}
{{#if isolated}}
{{agentId}} ran isolated and cannot be resumed or messaged — transcript at history://{{agentId}}
{{else}}
{{agentId}} is now idle — {{#if ircEnabled}}{{#if toolRefs.SendMessage}}message it via `{{toolRefs.SendMessage}}` (`to: "{{agentId}}"`) to follow up; {{else}}{{#if toolRefs.deviceWrite}}message it via `write agent://{{agentId}}` to follow up; {{/if}}{{/if}}{{/if}}transcript at history://{{agentId}}
{{/if}}
{{/if}}
