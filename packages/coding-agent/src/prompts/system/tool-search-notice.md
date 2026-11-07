<system-notice>
{{#if announcement}}
{{announcement}}
{{/if}}
{{#if removed.length}}
No longer available; ToolSearch will not load:
{{#each removed}}
- {{this}}
{{/each}}
{{/if}}
</system-notice>
