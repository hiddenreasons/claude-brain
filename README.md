# Claude Brain

A live, read-only page that shows the work going on between MAC (Grok Bot) and Claude on VADER and Hidden Reasons.

It refreshes by itself within a couple of seconds of any change. It never writes, deletes, posts or runs anything in VADER, Hidden Reasons or MAC's runs folder. The only place it writes is its own Obsidian vault.

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

At the top, Claude's brain (orange, left) and MAC's brain (blue, right). A bolt fires only when a real message passes between them:

- **Blue bolt, MAC to Claude:** a new work order, a job sent, a `FROM MAC` reply.
- **Orange bolt, Claude to MAC:** a `TO MAC` reply, a report written, a one-shot job's result.
- **Red bolt with a white-hot core:** anything BLOCKED, or a job that errored.
- **Faint steady arc:** a MAC job is running right now.

The brains are Codex's artwork (`brain/static/media/*-brain.png`), or Runway idle loops (`*-loop.mp4`) when present; the page falls back to drawing its own. Either side has a HUD panel: Claude's 24 h outcomes, latest jobs and a hex grid of the last 60 jobs on the left; MAC's open-order age radar, counters, 24 h traffic chart and open orders on the right. Every shape in them is real data; hover or click for the item.

The **Motion** switch at the top chooses Full (video loops, strobing strikes, HUD animation) or Calm (still brains, single strikes). It starts from the system's Reduce Motion setting and remembers your choice in this browser.

The brain loops came from Runway (Veo 3.1, first and last frame set to Codex's stills), cropped to a square and re-encoded with VADER's ffmpeg. The page crossfades each clip's end into its start. The other takes (Kling O3 Pro) and a comparison sheet are in `imagery/candidates/`, which isn't committed.

Hover a bolt, or a line in "Latest messages", to see the message. Messages that existed before the page opened don't fire. `http://localhost:8777/?demo` shows labeled sample bolts for checking the look; they are not real messages.

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
- GET only. There is no endpoint that changes anything.
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
