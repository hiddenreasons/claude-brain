"""Codex activity, read-only, from ~/.vader-mac-runs/brain/codex-status.jsonl.

One JSON line per event, append-only and deduplicated by MAC:
  {"at", "machine": "WINDOWS"|"MAC", "sender": "codex", "job", "event": "started"|"finished"|"failed",
   "result": "exit 0, 8 pngs" | null, "output_dir"}
The Brain never writes this file. A job is running from its "started" until a "finished" or "failed";
failed jobs need MAC's attention (never Anthony's).
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .readers import clip, read_tail

TAIL_BYTES = 512 * 1024
EVENTS = {"started", "finished", "failed"}
PICTURES_RE = re.compile(r"(\d+)\s*(?:pngs?|jpe?gs?|pictures?|images?)\b", re.I)


def codex_path(runs_dir: Path) -> Path:
    return runs_dir / "brain" / "codex-status.jsonl"


def _stamp(value: Any) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
    try:
        stamp = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.astimezone()


def parse_codex(text: str) -> List[Dict[str, Any]]:
    """Valid events, oldest first, each once (a repeated line is the same event)."""
    events: List[Dict[str, Any]] = []
    seen = set()
    for line in (text or "").splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if not isinstance(e, dict) or e.get("event") not in EVENTS or not isinstance(e.get("job"), str):
            continue
        stamp = _stamp(e.get("at"))
        if stamp is None:
            continue
        key = (e["job"], e["event"], stamp.isoformat())
        if key in seen:
            continue
        seen.add(key)
        events.append(
            {
                # UTC, like MAC's log, so the comms feed sorts every sender on one clock
                "at": stamp.astimezone(timezone.utc).isoformat(timespec="seconds"),
                "ts": stamp.timestamp(),
                "job": clip(e["job"], 120),
                "event": e["event"],
                "machine": "WINDOWS" if str(e.get("machine", "")).upper() == "WINDOWS" else "MAC",
                "result": clip(e.get("result"), 200) if isinstance(e.get("result"), str) else None,
                "output_dir": clip(e.get("output_dir"), 300) if isinstance(e.get("output_dir"), str) else None,
            }
        )
    events.sort(key=lambda e: e["ts"])
    return events


def pictures(result: Optional[str]) -> int:
    m = PICTURES_RE.search(result or "")
    return int(m.group(1)) if m else 0


def summarize(events: List[Dict[str, Any]], now: float) -> Dict[str, Any]:
    jobs: Dict[str, Dict[str, Any]] = {}
    for e in events:
        job = jobs.setdefault(
            e["job"],
            {
                "job": e["job"],
                "machine": e["machine"],
                "state": "running",
                "started_at": None,
                "ended_at": None,
                "result": None,
                "output_dir": None,
            },
        )
        job["machine"] = e["machine"]
        job["output_dir"] = e["output_dir"] or job["output_dir"]
        if e["event"] == "started":
            # a restart begins a new run of the same job
            job.update({"state": "running", "started_at": e["at"], "ended_at": None, "result": None})
        else:
            job.update(
                {"state": "done" if e["event"] == "finished" else "failed", "ended_at": e["at"], "result": e["result"]}
            )
    today = datetime.fromtimestamp(now).astimezone().date()
    done_today = [
        e for e in events if e["event"] == "finished" and datetime.fromtimestamp(e["ts"]).astimezone().date() == today
    ]
    ordered = sorted(jobs.values(), key=lambda j: j["ended_at"] or j["started_at"] or "", reverse=True)
    return {
        "jobs": ordered,
        "running": [j for j in ordered if j["state"] == "running"],
        "failed": [j for j in ordered if j["state"] == "failed"],
        "today": {"done": len(done_today), "pictures": sum(pictures(e["result"]) for e in done_today)},
        "events": len(events),
    }


def read_codex(runs_dir: Path, now: float) -> Dict[str, Any]:
    text = read_tail(codex_path(runs_dir), TAIL_BYTES) or ""
    events = parse_codex(text)
    out = summarize(events, now)
    out["found"] = codex_path(runs_dir).exists()
    out["_events"] = events  # internal: turned into comms-feed lines by the server
    return out


def codex_messages(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Each Codex event as one line in the comms feed, with Codex as its own sender."""
    out = []
    for e in events:
        text = f"{e['job']} {e['event']}" + (f": {e['result']}" if e["result"] else "")
        out.append(
            {
                "id": f"codex:{e['job']}:{e['event']}:{e['at']}",
                "direction": "codex",
                "kind": "codex",
                "mac_kind": e["event"],
                "text": text,
                "at": e["at"],
                "blocked": e["event"] == "failed",
                "cleared": False,
                "ref": {"source": "codex", "job": e["job"], "wo": None},
                "machine": e["machine"].lower(),
            }
        )
    return out
