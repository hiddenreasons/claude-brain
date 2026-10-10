# Console redesign: verification of Brain main through 931507b (2026-10-10)

Branch `claude/console-redesign`, cut from `main` (931507b). Staged, not committed, not merged.

| WO "Done" item | Result | Proof |
|---|---|---|
| claude.exec = live code stream of the running job's real actions | Shipped | 671be32, `brain/static/hud.js` `codeStream` (job activity + Windows heartbeat); idle shows the last real run |
| comms = animated wire, fires only on real handoffs | Shipped | 671be32 `buildWire`/`firePacket`; `handleMessages(snap)` is skipped in sample mode (`app.js` load); `consoles.test.js`, `volley.test.js` |
| mac.command = order columns (queued/running/blocked/done) | Partly shipped | Columns are Needs you / Running / Queued / Parked (671be32, 1a99449): no Blocked or Done column. Blocked orders show red in "Needs you" and in the Blocked KPI; done orders are not shown |
| Live data only, none outside Sample mode | Shipped | `hud.js` has no sample data; `?demo` only adds bolts/sparks from jobs really in progress (`app.js` `startDemo`) |
| Updates within seconds of a change | Shipped, not timed end to end | SSE `/events` -> `scheduleLoad` 250 ms debounce -> `/api/snapshot`; README says a couple of seconds |
| Readable at phone width | Shipped | Screenshots at 500 px (the smallest this browser allows): no horizontal overflow; CSS breakpoints 1100/640. A true 375 px device was not tested |
| Calm / Reduce Motion respected | Shipped | 1a99449 (receiver glow is a plain state); `html.calm` rules in `style.css`; volley test "reduced motion"; page showed "Motion: Calm (Mac setting)" |
| Existing tests pass | Pass | `node --test tests/js`: 36/36 with the new tests. `pytest`: server tests need a port and cannot run in the sandbox (PermissionError in `tests/test_server.py:33`); not run here |
| New tests for each console | Was missing for claude.exec | Added 4 tests in `tests/js/consoles.test.js` (stream content, Windows heartbeat gate and 2-job cap, "new" marking, heat strip cells/blocked dot/bad data). Comms and orders already had tests |

## Changed by this branch
- `tests/js/consoles.test.js`: 4 new claude.exec tests. No app code changed.

## Open for MAC
- mac.command columns do not match the WO wording (Blocked, Done). Add them, or accept Parked and the Blocked KPI? Not built; this is a design call.
- Screenshots were taken but could not be saved to `~/AI Files/Claude/Images/` (the browser tool only writes inside workspace roots). They are in the chat only.
