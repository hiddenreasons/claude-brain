"""The WINDOWS box: a short terminal-style list from ~/.vader-mac-runs/brain/windows-status.json (read-only).

MAC refreshes the file about every 10 minutes. The reader is lenient about its shape, since the format
is MAC's: the update time under "updated_at", "last_update", "at" or "generated_at" (ISO or epoch), and
the jobs as {"jobs": [{"name"/"job"/"id", "state"/"status"}]}, or as "running"/"queued"/"ready" lists of
names or such objects. Only running and waiting jobs are listed; "no jobs" when there are none, and
"offline" when the update is more than 15 minutes old or missing.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from .readers import clip, iso, read_text

OFFLINE_S = 15 * 60
TIME_KEYS = ("copied_at", "updated_at", "last_update", "at", "generated_at", "time")
SHOWN = {"running", "ready", "queued", "waiting", "pending", "starting", "busy"}
LIST_KEYS = {"running": "RUNNING", "queued": "QUEUED", "ready": "READY", "waiting": "WAITING", "pending": "PENDING"}


def windows_status_path(runs_dir: Path) -> Path:
    return runs_dir / "brain" / "windows-status.json"


def _when(value: Any) -> Optional[float]:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value) / (1000 if value > 1e12 else 1)
    if isinstance(value, str) and value.strip():
        try:
            # Windows writes 7-digit fractions ("17:43:07.4509137-04:00"); Python 3.9 reads at most 6.
            stamp = datetime.fromisoformat(re.sub(r"(\.\d{6})\d+", r"\1", value.strip().replace("Z", "+00:00")))
        except ValueError:
            return None
        return (stamp if stamp.tzinfo else stamp.astimezone()).timestamp()
    return None


def _job(item: Any, default_state: Optional[str] = None) -> Optional[Dict[str, str]]:
    if isinstance(item, str) and item.strip():
        return {"name": clip(item.strip(), 40), "state": (default_state or "RUNNING").upper()}
    if isinstance(item, dict):
        name = item.get("name") or item.get("job") or item.get("id") or item.get("title")
        state = item.get("state") or item.get("status") or default_state
        if isinstance(name, str) and name.strip() and isinstance(state, str) and state.strip():
            return {"name": clip(name.strip(), 40), "state": state.strip().upper().replace("_", " ")}
    return None


def _accepting(value: Any) -> Dict[str, Any]:
    """ "accepting" as true/false, "yes"/"no: reason", or {"ok"|"value"|"accepting": bool, "reason": text}."""
    reason = None
    if isinstance(value, dict):
        reason = value.get("reason") or value.get("why")
        value = next((value[k] for k in ("ok", "value", "accepting", "yes") if k in value), None)
    if isinstance(value, str):
        word, _, rest = value.strip().partition(":")
        if not rest:
            word, _, rest = value.strip().partition(" ")
        value = {"yes": True, "true": True, "no": False, "false": False}.get(word.strip().lower())
        reason = reason or (rest.strip(" -—") or None)
    if not isinstance(value, bool):
        return {"known": False, "yes": None, "reason": None}
    return {"known": True, "yes": value, "reason": clip(reason, 160) if isinstance(reason, str) else None}


def read_windows_status(
    runs_dir: Path, now: float, codex_running: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    path = windows_status_path(runs_dir)
    out: Dict[str, Any] = {
        "found": False,
        "updated_at": None,
        "age_s": None,
        "offline": True,
        "jobs": [],
        "accepting": {"known": False, "yes": None, "reason": None},
        "rules": [],
        "reason": "no windows-status.json yet",
    }
    raw = read_text(path, 256 * 1024)
    if raw is None:
        return out
    try:
        data = json.loads(raw)
    except ValueError:
        out["reason"] = "windows-status.json isn't valid JSON"
        return out
    if not isinstance(data, dict):
        out["reason"] = "windows-status.json isn't an object"
        return out
    out["found"] = True
    beat = data.get("heartbeat") if isinstance(data.get("heartbeat"), dict) else {}
    stamp = next((_when(data.get(k)) for k in TIME_KEYS if _when(data.get(k)) is not None), None)
    if stamp is None:
        stamp = _when(beat.get("at"))
    jobs: List[Dict[str, str]] = []
    # MAC's copy: heartbeat.running_jobs are running; the queue waits its turn (READY)
    running = [j for j in beat.get("running_jobs") or [] if isinstance(j, str)]
    if not running and str(beat.get("job_state") or "").lower() == "running" and beat.get("job"):
        running = [str(beat["job"])]
    jobs += [{"name": clip(j, 40), "state": "RUNNING"} for j in running]
    for item in data.get("queue") or []:
        job = _job(item, "READY")
        if job:
            jobs.append(job)
    # Codex picture jobs running on Windows, from codex-status.jsonl ("codex B08")
    for c in codex_running or []:
        if c.get("machine") == "WINDOWS":
            jobs.append({"name": f"codex {str(c['job']).split('-')[0]}", "state": "RUNNING"})
    for item in data.get("jobs") or []:
        job = _job(item)
        if job:
            jobs.append(job)
    for key, state in LIST_KEYS.items():
        for item in data.get(key) or []:
            job = _job(item, state)
            if job:
                jobs.append(job)
    seen = set()
    shown = []
    for job in jobs:
        if job["state"].lower() in SHOWN and job["name"] not in seen:
            seen.add(job["name"])
            shown.append(job)
    order = {"RUNNING": 0, "BUSY": 0, "STARTING": 1}
    shown.sort(key=lambda j: order.get(j["state"], 2))
    out["jobs"] = shown
    out["accepting"] = _accepting(data.get("accepting"))
    rules = data.get("rules")
    rules = [rules] if isinstance(rules, str) else rules if isinstance(rules, list) else []
    out["rules"] = [clip(r, 160) for r in rules if isinstance(r, str) and r.strip()][:8]
    if stamp is None:
        out["reason"] = "no update time in windows-status.json"
        return out
    out["updated_at"] = iso(stamp)
    out["age_s"] = now - stamp
    out["offline"] = out["age_s"] > OFFLINE_S
    out["reason"] = f"last update {int(out['age_s'] // 60)} min ago" if out["offline"] else "live"
    return out
