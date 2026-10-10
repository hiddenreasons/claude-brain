# Claude Brain

A live, read-only page that shows the work going on between MAC (Grok Bot) and Claude on VADER and Hidden Reasons.

It refreshes by itself within a couple of seconds of any change. It never writes, deletes, posts or runs anything in VADER, Hidden Reasons or MAC's job folders. It writes only its own records in `~/.vader-mac-runs/brain/` (audit trail, alerts, recommendations, lessons, digests, Anthony's "Mark done" clicks) and its Obsidian vault; MAC's files in that folder (`comms.jsonl`, `codex-status.jsonl`, `windows-status.json`) are read, never written.

## Start it

In Terminal:

```bash
cd ~/Documents/"Active Projects"/"Claude Brain" && python3 -m brain
```

Then open http://localhost:8777. Stop it with Ctrl+C.

**Runs by itself:** a login item (`~/Library/LaunchAgents/com.anthony.claude-brain.plist`) starts the Brain at login through a small background app, `~/Applications/Claude Brain Server.app` (the app is what holds macOS's permission to read Documents), and restarts it within seconds if it stops. Its log is `~/Library/Logs/claude-brain.log`. To turn it off: `launchctl bootout gui/$(id -u)/com.anthony.claude-brain`, then delete those two files. While it runs, don't also start `python3 -m brain` by hand: the port is taken.

No install step: it uses only Python's standard library (Python 3.9 or newer; the Mac's built-in `python3` works).

Quick check without the web page:

```bash
python3 -m brain --check
```

## What it shows

At the top, two Death Stars drawn on a canvas in the style of VADER's Issues tab: Grok Bot / MAC (blue, left) and Claude (orange, right).

- **Nodes are live items.** MAC's station: jobs MAC talked about in the last day (its own, Windows ones, and the twins of Claude's), its live work orders, and approvals waiting on Anthony. Claude's station: Claude's jobs and the work orders. The marker shows the action label: a red diamond with a dashed ring for NEEDS ANTHONY, a white ring with a running arc for IN PROGRESS, a dim ring for QUEUED, a faint dot for DONE (gone after a day).
- **Every job has its own colour**, picked from its name, and the same colour on both stations. Hover or click a node to mark its twin and see the job's name; click to open its terminal window (only NEEDS ANTHONY gets a fix-request button).
- **Every message fires one bolt** from the sending job's node to its twin: MAC → Claude flies left to right, replies fly back, and the receiving node glows when it lands. At most three fly at once; the rest queue. The rules are in `brain/static/volley.js` (tested by `tests/js/volley.test.js`, which pytest runs).
- **Motion:** the switch at the top chooses Full or Calm. It starts from the system's Reduce Motion setting and remembers your choice in this browser. Calm means no bolts, just a still flash on both nodes.

Messages that existed before the page opened don't fire. `http://localhost:8777/?demo` fires labeled sample volleys between real twin jobs for checking the look; they are not real messages.

Under the stations, Claude's console (24 h outcomes, latest jobs, a hex grid of the last 60 jobs), the comms feed (newest first, sender tags, a status badge per message) and MAC's console (open-order age radar, counters, open orders). Every shape is real data; hover or click for the item.

| Panel | Where it comes from |
|---|---|
| Needs attention | Blocked work orders, failed startup gates, stalled or errored jobs from the last 3 days (older ones stay marked NEEDS ANTHONY in the lists) |
| Running now | MAC's job folders whose live stream (`iter-N.jsonl`) is being written, with Claude's latest actions |
| MAC → Claude jobs | Every job MAC gave Claude: job folders (`brief.md`, `REPORT.md`, `runs.log`) and one-shot orders (`msg*.txt` / `out*.json` / `err*.txt`). Click one for the full order, result, report and activity |
| Waiting on Anthony | "Open decisions awaiting Anthony" in MAC's `STATUS.md` |
| Work orders | `VADER/docs/CLAUDE INBOX.md`, with each `TO MAC:` / `FROM MAC` reply as a thread |
| MAC change log, Incidents | `STATUS.md` change log and `ISSUES-LOG.md` |

Job states, in plain words:

- **Running**: Claude wrote to its live stream in the last 10 minutes (or its process is alive and wrote in the last 3 hours).
- **Stalled**: the run never finished, and nothing has been written for a while. A one-shot order with no result 6 hours after MAC sent it is stalled too.
- **Blocked**: Claude's report starts `TO MAC: BLOCKED`, and MAC hasn't touched the job folder since.
- **MAC followed up**: the report said blocked, and MAC wrote files in the folder afterwards (for example a commit log).
- **Cleared by MAC**: MAC's `STATUS.md` change log or message log says the problem is fixed.
- **No report**: the run finished with no `REPORT.md` and no final reply.
- **No Claude run**: a brief exists but no Claude run started (for example a Codex job).

Every job and work order also gets one action label (`brain/labels.py`). The lists group by it, in this order:

- **NEEDS ANTHONY** (red): blocked, stalled, gate failed, no report or error jobs; BLOCKED work orders; work orders waiting on Anthony's decision. Only these get a "Copy fix request" button.
- **IN PROGRESS** (amber): running jobs and RUNNING work orders, with who is on it and when the log last moved.
- **QUEUED** (dim): OPEN and PARKED work orders, with what they wait behind when the inbox says.
- **DONE** (green): done, cleared or MAC followed up. These sit in a collapsed Done section.

Costs shown on jobs are Claude's own list-price estimates from the result files, not charges. The Max plan doesn't bill per job.

## MAC's message log

MAC (Grok Bot) can append one line per MAC/Claude message to `~/.vader-mac-runs/brain/comms.jsonl`, which gives exact times and covers work on Grok Bot's computer and the Windows machine. The format and instructions for MAC are in [docs/GROKBOT-COMMS-LOG.md](docs/GROKBOT-COMMS-LOG.md). Without it, the Brain works from the files it already reads.

## Obsidian notes

While it runs, the Brain keeps one note per MAC work order and per job in the Obsidian vault at `~/Documents/Active Projects/Claude Brain Vault`, plus a `Claude Brain` index note. Notes link to each other (a work order lists the jobs that mention it), so Obsidian's graph shows the connections.

- Each note has a line that reads `claude-brain:end`. Everything above it is rewritten when the source changes. **Anything you write below it is kept.**
- Delete that line and the note becomes yours: the Brain never touches it again.
- The Brain never deletes a note, and writes nowhere outside the vault. It refuses to start the export if the vault is inside VADER or MAC's runs folder.
- Turn it off with `python3 -m brain --no-export`.

## Settings

Environment variables, all optional:

| Variable | Default |
|---|---|
| `BRAIN_VADER_DIR` | `~/Documents/Active Projects/VADER` |
| `BRAIN_RUNS_DIR` | `~/.vader-mac-runs` |
| `BRAIN_PORT` | `8777` (VADER uses 8765) |
| `BRAIN_VAULT_DIR` | `~/Documents/Active Projects/Claude Brain Vault` |

`--port 8778` on the command line also works.

## Safety

- Reads VADER, Hidden Reasons and MAC's runs folder; writes only into the Obsidian vault.
- Listens on this Mac only (127.0.0.1), and answers only requests addressed to localhost.
- GET only, except one: `POST /api/mark` records Anthony's "Mark done" (or its undo) in the Brain's own `owner-marks.jsonl`. It answers only the page itself (loopback Host and Origin, a JSON body, an `X-Brain-Action: mark` header) and never changes the job.
- All text from files is shown as text, never as HTML, and the page loads nothing from the internet.
- A test proves a full read of every source leaves every file's content and timestamp unchanged.

## Limits

- It sees only files on this Mac. Jobs on the Windows machine (`C:\VADER-WIN`) and anything only on Grok Bot's own computer don't show up.
- Claude chats you run by hand in the desktop app aren't shown yet. Only MAC's harness jobs and the inbox are.

## Development

```bash
~/.vader/env/bin/python -m pytest          # the 7 server tests need permission to open a local port
~/.vader/env/bin/python -m ruff check .
~/.vader/env/bin/python -m ruff format .
```
