# Instructions for MAC (Grok Bot): the Claude Brain message log

From Anthony. Anthony watches MAC and Claude talk on Claude Brain, a live page on his Mac (http://localhost:8777). Each message between you and Claude shows as a lightning bolt: blue for MAC to Claude, orange for Claude to MAC, red for BLOCKED.

The Brain already reads your runs folder (`~/.vader-mac-runs`) and VADER's `docs/CLAUDE INBOX.md`. It can't see three things: the exact time of inbox replies, messages you send from your own computer, and jobs on the Windows machine. This log fills those gaps.

## What to do

Append one line to this file for every message between MAC and Claude, in both directions:

`~/.vader-mac-runs/brain/comms.jsonl` (on Anthony's Mac; create the `brain` folder if it's missing)

## When to write a line

MAC to Claude (`"from": "mac", "to": "claude"`):

- `work_order`: you give Claude a new work order (CLAUDE INBOX entry or a job brief).
- `job_sent`: you hand a job to Claude (headless `claude -p`, a harness job, a Windows job).
- `job_started`: the job actually starts running (the harness `start` line).
- `reply`: any `FROM MAC` answer to Claude.
- `unblocked`: you clear something Claude reported as BLOCKED.

Claude to MAC (`"from": "claude", "to": "mac"`). You write these when Claude's output reaches you, or the harness writes them automatically:

- `report`: a `REPORT.md` or final reply arrives. Set `status` from its first line: `ok`, `blocked` or `error`.
- `reply`: a `TO MAC:` line from Claude.
- `blocked`: Claude says `TO MAC: BLOCKED`.
- `question`: Claude asks you something.
- `done`: Claude marks a work order DONE.
- `job_finished`: the job's process ended (any exit). Use `status: "error"` for a non-zero exit.

Don't log routine chatter such as status polling, heartbeats or watch-routine checks. Write one line per real message.

## Line format

One JSON object per line, ending in a newline:

| Field | Required | Value |
|---|---|---|
| `v` | yes | `1` |
| `id` | yes | Unique and stable, e.g. `"20261009T151657Z-wofix-sent"`. Writing the same id again means the same message; it won't fire twice. |
| `at` | yes | When it happened, in UTC with a `Z`, e.g. `"2026-10-09T15:16:57Z"`. Lines without a time zone are ignored. |
| `from` | yes | `"mac"` or `"claude"` |
| `to` | yes | the other one |
| `kind` | yes | one of the kinds above |
| `status` | no | `"ok"` (default), `"blocked"` or `"error"` |
| `job` | no | job folder name or one-shot id, e.g. `"wofix"` or `"k38b"`. Letters, digits, `.`, `_` and `-` only. |
| `wo` | no | work order number, as a number, e.g. `23` |
| `machine` | no | where it happened: `"mac"`, `"windows"` or `"grok"` |
| `text` | yes | A one-line summary under 280 characters, in plain words: what Anthony would want to read. |

Examples:

```json
{"v":1,"id":"20261009T151657Z-wofix-sent","at":"2026-10-09T15:16:57Z","from":"mac","to":"claude","kind":"job_sent","job":"wofix","machine":"mac","text":"wofix: fix the 2 CodeRabbit findings in _shared/wo-sop.md (Opus high)"}
{"v":1,"id":"20261009T151752Z-wofix-report","at":"2026-10-09T15:17:52Z","from":"claude","to":"mac","kind":"report","status":"ok","job":"wofix","machine":"mac","text":"TO MAC: DONE. Both CodeRabbit findings fixed."}
{"v":1,"id":"20261009T160200Z-wo023","at":"2026-10-09T16:02:00Z","from":"mac","to":"claude","kind":"work_order","wo":23,"machine":"grok","text":"WO #023: Channel page layout fix"}
{"v":1,"id":"20261009T161500Z-selflearn-start","at":"2026-10-09T16:15:00Z","from":"mac","to":"claude","kind":"job_started","job":"selflearn","machine":"windows","text":"selflearn trial started on Windows (Opus high)"}
```

## Rules

- **Append only.** Never edit, reorder or delete lines, and never rewrite the file. Write each line in one go (one `>>` of a complete line), so a half-written line is never left behind.
- **No secrets or private data.** No keys, tokens, passwords, cookies, personal details or file contents. Summaries only.
- **UTC times with `Z`.** For Windows or remote events, write the line when you learn of it, with the time it happened.
- **When the file passes 20 MB,** rename it to `comms-YYYYMMDD.jsonl` and start a new one. The Brain reads the newest 2 MB.
- **This is in addition to, not instead of,** the `TO MAC:` and `FROM MAC` lines in CLAUDE INBOX and the job reports. Keep those exactly as they are.
- **Don't change VADER code** or Claude's briefs for this. It's harness-only. Follow your usual harness change process (backup, tests) before editing `_shared`.

## Best: let the harness write the lines

Most lines can be written automatically, so nothing depends on remembering:

- `_shared/run-template.sh` and `resume-job.sh`: on the `start` line, write `job_started`. On `end`, write `job_finished` (status from the exit code). On `report-check`, write `report` (status from the report's first line).
- The Codex template doesn't need lines: Codex isn't Claude.
- The Windows harness (`submit-job.ps1`): you relay its start and end into this file when you check on it, with `"machine": "windows"`.
- When you write a `FROM MAC` line in CLAUDE INBOX, also write a `reply` line.

A helper that appends one line safely (JSON-escaped, UTC time, unique id):

```bash
brain_log() {  # brain_log FROM TO KIND STATUS JOB "TEXT"   e.g. brain_log mac claude job_sent ok wofix "wofix: fix 2 findings"
  python3 - "$@" <<'PY'
import datetime, json, os, sys, uuid
sender, receiver, kind, status, job, text = sys.argv[1:7]
path = os.path.expanduser("~/.vader-mac-runs/brain/comms.jsonl")
os.makedirs(os.path.dirname(path), exist_ok=True)
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
event = {"v": 1, "id": f"{now}-{job or 'na'}-{kind}-{uuid.uuid4().hex[:6]}", "at": now,
         "from": sender, "to": receiver, "kind": kind, "status": status or "ok",
         "machine": "mac", "text": " ".join(text.split())[:280]}
if job:
    event["job"] = job
with open(path, "a", encoding="utf-8") as f:
    f.write(json.dumps(event, ensure_ascii=False) + "\n")
PY
}
```

## How to check it works

1. Append one test line:
   `brain_log mac claude reply ok "" "Test from MAC: Claude Brain message log connected"`
2. With Claude Brain open, a blue bolt fires from MAC to Claude within about 2 seconds, and the test line appears in "Latest messages".
3. The footer of the page shows `comms` with a recent time.

Tell Anthony when the first real line is written.
