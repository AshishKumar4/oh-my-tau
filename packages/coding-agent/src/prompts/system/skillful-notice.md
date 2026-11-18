The available skills were omitted from the system prompt but are listed here for this session. When a task matches one of them, {{#if toolRefs.Skill}}you MUST load it with `{{toolRefs.Skill}}` before proceeding.{{else}}you MUST read `skill://<name>` before proceeding.{{/if}}
<skills>
{{#each skills}}
- {{name}}: {{description}}
{{/each}}
</skills>
