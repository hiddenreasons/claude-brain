"""Builders for fake VADER and MAC run folders. Tests never touch the real ones."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain.config import Config  # noqa: E402


def write(path: Path, text: str, age_s: float = 0.0) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    if age_s:
        ts = time.time() - age_s
        os.utime(path, (ts, ts))
    return path


def stream(*events: dict) -> str:
    return "\n".join(json.dumps(e) for e in events) + "\n"


def tool_use(name: str, **tool_input) -> dict:
    return {
        "type": "assistant",
        "session_id": "sess-1",
        "message": {"content": [{"type": "tool_use", "name": name, "input": tool_input}]},
    }


def said(text: str) -> dict:
    return {"type": "assistant", "session_id": "sess-1", "message": {"content": [{"type": "text", "text": text}]}}


def result_event(text: str, ok: bool = True) -> dict:
    return {
        "type": "result",
        "subtype": "success" if ok else "error_during_execution",
        "is_error": not ok,
        "result": text,
        "session_id": "sess-1",
        "total_cost_usd": 1.25,
    }


def result_json(text: str = "All done.", is_error: bool = False, **extra) -> str:
    data = {
        "type": "result",
        "subtype": "success",
        "is_error": is_error,
        "result": text,
        "session_id": "abc",
        "total_cost_usd": 2.5,
        "duration_ms": 125_000,
        "num_turns": 12,
        "modelUsage": {"claude-opus-5-5": {}},
        "permission_denials": [{"tool_name": "Bash"}],
    }
    data.update(extra)
    return json.dumps(data)


INBOX = """# Claude inbox

## OPEN — 2026-10-07 · WO from MAC #022 - Home: Command look

**From MAC (Grok Bot).** Rebuild Home.

**Status:** running (started by MAC, Oct 7).

---

## DONE — 2026-10-07 · WO from MAC #019 - Schedule two Shorts

**From MAC (Grok Bot).** Schedule them.

**Status:** UNBLOCKED by MAC 9:41 AM (was BLOCKED).
- TO MAC: BLOCKED can't read the files.
- FROM MAC (9:41 AM ET): Both blockers are fixed.
- TO MAC: DONE (2026-10-07). Both scheduled.

## OPEN — 2026-10-07 · Final render stalls

**From:** Claude (autopilot). Render stalls at 40%.
- TO MAC: BLOCKED needs a code look before the next render.

## PARKED (FIRST AFTER BUTTON-UP) - 2026-10-07 · WO from MAC #020 - VADER learns from itself

**Status:** PARKED until after the button-up pass.

## 2026-09-30 · Owner posts from Review in VADER, never from chat

Plain note, no status.
"""


@pytest.fixture
def tree(tmp_path: Path):
    vader = tmp_path / "VADER"
    runs = tmp_path / "runs"
    write(vader / "docs" / "CLAUDE INBOX.md", INBOX)
    runs.mkdir()
    write(
        runs / "STATUS.md",
        """# STATUS

## 2. Running / queued jobs

Nothing running.

## 5. Open decisions awaiting Anthony

- **Push/merge `claude/restyle-rework`**. Needs Proceed.
- **CLAUDE.md edits**:
  - line 29 model rule

## 6. Change log

- 2026-10-08 21:53 ET — created file.
- 2026-10-09 10:44 VADER c3: selflearn trial launched.
""",
    )
    write(
        runs / "ISSUES-LOG.md",
        """# Harness issues log

| Date | Job | What happened | Root cause | Fix | Mechanically prevented? |
|---|---|---|---|---|---|
| 2026-10-08 | layoutcodex | The job ran 84 times. | KeepAlive | Stopped. | no |

## 2026-10-08 22:44 ET: Claude bypassed its sandbox (logged by VADER c3)
- What: wrote to the Desktop.
""",
    )
    return Config(vader_dir=vader, runs_dir=runs, port=8799, poll_seconds=0.05)
