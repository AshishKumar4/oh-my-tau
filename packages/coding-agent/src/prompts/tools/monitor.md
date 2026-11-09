Start a background monitor that streams events from a long-running script or a WebSocket. Each stdout line is an event: you keep working, and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user, even if one lands while you are waiting for the user to answer a question.

Pick by how many notifications you need:
- **One** ("tell me when the server is ready / the build finishes"): run a background bash command that exits when the condition is true, e.g. `until grep -q "Ready in" dev.log; do sleep 0.5; done`. Its completion is the one notification.
- **One per occurrence, until the monitor expires** (re-arm to continue): a monitor with an unbounded command (`tail -f`, `inotifywait -m`, `while true`).
- **One per occurrence, until a known end**: a monitor with a command that emits lines and then exits.

Your script's stdout is the event stream. Each line becomes a notification. Exit ends the watch.

```
# Each matching log line is an event
tail -f /var/log/app.log | grep --line-buffered "ERROR"

# Each file change is an event
inotifywait -m --format '%e %f' /watched/dir

# Per-occurrence with a natural end: emit each CI check as it lands, exit when the run completes
prev=""
while true; do
  s=$(gh pr checks 123 --json name,bucket)
  cur=$(jq -r '.[] | select(.bucket!="pending") | "\(.name): \(.bucket)"' <<<"$s" | sort)
  comm -13 <(echo "$prev") <(echo "$cur")
  prev=$cur
  jq -e 'all(.bucket!="pending")' <<<"$s" >/dev/null && break
  sleep 30
done
```

**Don't use an unbounded command for a single notification.** `tail -f`, `inotifywait -m` and `while true` never exit on their own, so the monitor stays armed until it expires even after the event fired. `tail -f log | grep -m 1 …` does not fix this: if the log goes quiet after the match, `tail` never receives SIGPIPE.

**Script quality:**
- Every pipe stage must flush per line, or matches sit in its buffer unseen: `grep` needs `--line-buffered`, `awk` needs `fflush()`. `head` cannot flush.
- In poll loops, survive transient failures (`curl … || true`): one failed request must not kill the monitor.
- Poll every 30s or more for remote APIs, every 0.5–1s for local checks.
- Write a specific `description`; it appears in every notification ("errors in deploy.log", not "watching logs").
- Only stdout is the event stream. Stderr goes to a file the final notice names; it triggers nothing. For a command you run directly (e.g. `python train.py 2>&1 | grep --line-buffered …`), merge stderr with `2>&1` so its failures reach your filter.

**Coverage: silence is not success.** When watching a job for an outcome, match every terminal state, not just the happy path. A monitor that greps only for the success marker stays silent through a crash loop, a hang or an unexpected exit, and silence looks identical to "still running". Before arming, ask: if this process crashed right now, would my filter emit anything?

```
# Wrong: silent on crash, hang or any non-success exit
tail -f run.log | grep --line-buffered "elapsed_steps="

# Right: progress plus the failure signatures you would act on
tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|assert|Killed|OOM|nan"
```

For poll loops checking job state, emit on every terminal status (`succeeded|failed|cancelled|timeout`). If you cannot enumerate the failure signatures, broaden the filter: some noise beats a missed crash loop.

**Volume:** every notification is a message, so filter to the lines you would act on. A monitor sending more than 30 notifications in a minute is stopped; re-arm it with a tighter filter. Lines within 200ms of each other share one notification.

The command runs in the same shell environment as bash. Exit ends the watch and reports the exit code. Every monitor expires after `timeout_ms` (default 5 minutes, at most 30 minutes): it is killed and you get one notice with its event count. Re-arm it if you still need the watch; for a long watch set `timeout_ms` to the maximum and re-arm on each expiry. Cancel it early like any background job.

**`ws` source:** opens a WebSocket and streams each incoming text frame as an event; no shell, no polling. Binary frames arrive as `[binary frame, N bytes]`. Socket close ends the watch with its close code. Prefer it to a `websocat` command; use a command when you need to filter frames first.
