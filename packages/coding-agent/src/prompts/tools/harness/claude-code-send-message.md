# SendMessage

Send a message to another agent.

```json
{"to": "researcher", "message": "start on task #1"}
```

| `to` | |
|---|---|
| `"researcher"` | An agent by name: the agentId from its spawn result, or a name from `ListAgents` |
| `"main"` | The main conversation |
| `"all"` | Every live agent at once |

Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from other agents are delivered automatically; you don't check an inbox. Refer to agents by name — names keep working after an agent completes (a message resumes it). A running agent reads your message at its next tool round; an idle or finished agent resumes to handle it. When relaying, don't quote the original — it's already rendered to the user.
