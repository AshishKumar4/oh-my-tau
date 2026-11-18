Wait only when blocked with nothing else to do.
Blocks on background jobs/services you started, or on the answer to a question you sent this run, until one finishes or answers.
Nothing you started running and no answer owed? Returns at once.
- MUST wait only on your own jobs/services, or rarely the answer to a question that blocks you.
- NEVER wait for another agent's progress or for messages nobody owes you.
- Open items? Work on them instead: a running job wakes you with its result when it finishes. With open todo items, `wait` hands them back once; call it again only if every item needs the result.
- Nothing left but the result? End your turn; the job wakes you. Waiting works too and costs the same.
- Result in, other jobs still running? SHOULD act on it before waiting again.
Results and messages auto-deliver. NEVER poll while work remains.
