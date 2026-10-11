# Console redesign: verification of Brain main through 931507b (2026-10-10)

Branch `claude/console-redesign`, cut from `main` (931507b). Not merged; Brain `main` stays at 77b29b1 until Anthony decides.

| WO "Done" item | Result | Proof |
|---|---|---|
| claude.exec = live code stream of the running job's real actions | Shipped | 671be32, `brain/static/hud.js` `codeStream` (job activity + Windows heartbeat); idle shows the last real run |
| comms = animated wire, fires only on real handoffs | Shipped | 671be32 `buildWire`/`firePacket`; `handleMessages(snap)` is skipped in sample mode (`app.js` load); `consoles.test.js`, `volley.test.js` |
| mac.command = order columns (queued/running/blocked/done) | Shipped on this branch (was partly shipped) | Six columns: Needs you, Blocked, Running, Queued, Parked, Done (`hud.js` `orderColumns`, `recentDone`). Blocked is checked first because `labels.order_action` gives every BLOCKED order the action `needs_anthony` (pinned in `tests/test_labels.py`); the first five columns add up to the open-orders number, and "waiting on you" leaves blocked orders out (`needsYouOrders`) so it matches NEEDS YOU. Done shows DONE orders opened today or in the last 2 calendar days, newest first, with the visible note "opened in the last 3 days": neither the inbox nor its replies carry a finish date, so the column does not claim one. Live data had none on 2026-10-10 |
| Live data only, none outside Sample mode | Shipped | `hud.js` has no sample data; `?demo` only adds bolts/sparks from jobs really in progress (`app.js` `startDemo`) |
| Updates within seconds of a change | Shipped, not timed end to end | SSE `/events` -> `scheduleLoad` 250 ms debounce -> `/api/snapshot`; README says a couple of seconds |
| Readable at phone width | Shipped | Screenshots at 500 px (the smallest this browser allows): no horizontal overflow; CSS breakpoints 1100/640. A true 375 px device was not tested |
| Calm / Reduce Motion respected | Shipped | 1a99449 (receiver glow is a plain state); `html.calm` rules in `style.css`; volley test "reduced motion"; page showed "Motion: Calm (Mac setting)" |
| Existing tests pass | Pass | `node --test tests/js/*.test.js`: 39/39 (the bare directory form fails with MODULE_NOT_FOUND). `pytest`: 251 passed when MAC ran it outside the sandbox on 6d5f70a; not re-run after this round (no Python change) |
| New tests for each console | Was missing for claude.exec | Added 4 tests in `tests/js/consoles.test.js` (stream content, Windows heartbeat gate and 2-job cap, "new" marking, heat strip cells/blocked dot/bad data). Comms and orders already had tests |

## Changed by this branch
- `brain/static/hud.js`: Blocked and Done columns (`orderColumns(orders, done)`, `recentDone`); the column name sits in its own span so a long name ends in an ellipsis.
- `brain/static/style.css`: Blocked/Done colours; column headers stay on one line; below 480 px the radar sits above the columns and chips show the number over the title.
- `tests/js/consoles.test.js`: 4 claude.exec tests; order-column tests on real state/action pairs, a Blocked test, and a Done window test (today, 2 days, 3 days, future, undated, invalid).
- `tests/test_labels.py`: pins the state/action pairs the columns rely on.
## Open for MAC
- Done is by opening date, labelled that way. A real finish date needs a backend change (out of scope).
- 375 px (emulated) checked again: six columns inside the panel, headers on one line, the Done note wraps and stays visible, no overflow. Full-width was not re-shot; the 480 px rules do not touch it.
- Commit 6d5f70a's message says "Done uses the finish date", which is wrong; correct the wording when the branch is squash-merged.
- This report sits at the repo root and is already on `main`; the review suggests the PR description instead.
