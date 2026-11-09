Not blocking: you have open items. Still running:
{{#each jobs}}
- `{{id}}`{{#if label}} ({{label}}){{/if}}
{{/each}}
{{#if service}}
- a service you started
{{/if}}
Each wakes you with its result when it finishes; answers you are owed arrive as messages. Work on these meanwhile:
{{#each items}}
- {{this}}
{{/each}}
If everything left needs the result, end your turn (it wakes you), or call `wait` again to block until it lands.
