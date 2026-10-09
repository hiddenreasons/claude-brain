# Claude Brain

A live, read-only page that shows the work going on between MAC (Grok Bot) and Claude on VADER and Hidden Reasons.

It refreshes by itself within a couple of seconds of any change. It only reads files: it never writes, deletes, posts or runs anything in VADER, Hidden Reasons or MAC's runs folder.

## Start it

In Terminal:

```bash
cd ~/Documents/"Active Projects"/"Claude Brain" && python3 -m brain
```

Then open http://localhost:8777. Stop it with Ctrl+C.

No install step: it uses only Python's standard library (Python 3.9 or newer; the Mac's built-in `python3` works).

Quick check without the web page:

```bash
python3 -m brain --check
```

## What it shows

| Panel | Where it comes from |
|---|---|
| Needs attention | Blocked work orders, failed startup gates, stalled or errored jobs from the last 3 days |
| Running now | MAC's job folders whose live stream (`iter-N.jsonl`) is being written, with Claude's latest actions |
| MAC → Claude jobs | Every job MAC gave Claude: job folders (`brief.md`, `REPORT.md`, `runs.log`) and one-shot orders (`msg*.txt` / `out*.json` / `err*.txt`). Click one for the full order, result, report and activity |
| Waiting on Anthony | "Open decisions awaiting Anthony" in MAC's `STATUS.md` |
| Work orders | `VADER/docs/CLAUDE INBOX.md`, with each `TO MAC:` / `FROM MAC` reply as a thread |
| MAC change log, Incidents | `STATUS.md` change log and `ISSUES-LOG.md` |

Job states, in plain words:

- **Running**: Claude wrote to its live stream in the last 10 minutes (or its process is alive and wrote in the last 3 hours).
- **Stalled**: the run never finished, and nothing has been written for a while.
- **Blocked**: Claude's report starts `TO MAC: BLOCKED`, and MAC hasn't touched the job folder since.
- **MAC followed up**: the report said blocked, and MAC wrote files in the folder afterwards (for example a commit log).
- **No report**: the run finished with no `REPORT.md` and no final reply.
- **No Claude run**: a brief exists but no Claude run started (for example a Codex job).

Costs shown on jobs are Claude's own list-price estimates from the result files, not charges. The Max plan doesn't bill per job.

## Settings

Environment variables, all optional:

| Variable | Default |
|---|---|
| `BRAIN_VADER_DIR` | `~/Documents/Active Projects/VADER` |
| `BRAIN_RUNS_DIR` | `~/.vader-mac-runs` |
| `BRAIN_PORT` | `8777` (VADER uses 8765) |

`--port 8778` on the command line also works.

## Safety

- Listens on this Mac only (127.0.0.1), and answers only requests addressed to localhost.
- GET only. There is no endpoint that changes anything.
- All text from files is shown as text, never as HTML, and the page loads nothing from the internet.
- A test proves a full read of every source leaves every file's content and timestamp unchanged.

## Limits

- It sees only files on this Mac. Jobs on the Windows machine (`C:\VADER-WIN`) and anything only on Grok Bot's own computer don't show up.
- Claude chats you run by hand in the desktop app aren't shown yet. Only MAC's harness jobs and the inbox are.

## Development

```bash
~/.vader/env/bin/python -m pytest          # 62 tests; the 7 server tests need permission to open a local port
~/.vader/env/bin/python -m ruff check .
~/.vader/env/bin/python -m ruff format .
```
