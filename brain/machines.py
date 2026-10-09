"""Know the machine: every job is MAC or WINDOWS.

MAC jobs are the job folders and one-shots on this Mac. WINDOWS jobs are the ones MAC's message log says
run on Windows; their state comes from Windows' heartbeat, which MAC copies to
~/.vader-mac-runs/_xfer/win/heartbeat.json (the same copy VADER's win_node.py reads). Without a fresh
heartbeat a Windows job's state is the message log's word, and says so.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from .readers import iso, read_text

FRESH_S = 3 * 60  # the self-check wants a heartbeat under 3 minutes old
STALE_S = 15 * 60
EASTERN = ZoneInfo("America/New_York")
RUNNING_WORDS = {"running", "busy", "working", "started", "in-progress"}
DONE_WORDS = {"done", "finished", "complete", "completed", "succeeded", "success"}
STOP_WORDS = {"stopped", "failed", "error", "killed", "crashed", "auto-stopped", "timeout", "timed-out"}


def heartbeat_path(runs_dir: Path) -> Path:
    return runs_dir / "_xfer" / "win" / "heartbeat.json"


def _when(value: Any) -> Optional[float]:
    """Epoch seconds from `at`: ISO 8601 (no offset means Eastern, as on the Windows box) or epoch s/ms."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value) / (1000 if value > 1e12 else 1)
    if not isinstance(value, str) or not value.strip():
        return None
    text = re.sub(r"(\.\d{6})\d+", r"\1", value.strip().replace("Z", "+00:00"))
    try:
        stamp = datetime.fromisoformat(text)
    except ValueError:
        try:
            return _when(float(text))
        except ValueError:
            return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=EASTERN)
    return stamp.timestamp()


def windows_status_path(runs_dir: Path) -> Path:
    return runs_dir / "brain" / "windows-status.json"


def _load(path: Path) -> Any:
    """Parsed JSON, None when the file is missing, ValueError (the class) when it isn't JSON."""
    raw = read_text(path, 256 * 1024)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return ValueError


def read_heartbeat(runs_dir: Path, now: float) -> Dict[str, Any]:
    path = heartbeat_path(runs_dir)
    out: Dict[str, Any] = {
        "path": str(path),
        "found": False,
        "fresh": False,
        "stale": True,
        "age_s": None,
        "at": None,
        "job": None,
        "job_state": None,
        "last_log_line": None,
        "error": None,
        "machine_up": None,
        "running_jobs": [],
        "recent": [],
    }
    # MAC's copy at _xfer/win/heartbeat.json, else the "heartbeat" block of brain/windows-status.json.
    beat = _load(path)
    status = _load(windows_status_path(runs_dir))
    if isinstance(status, dict):
        out["recent"] = [r for r in status.get("recent") or [] if isinstance(r, dict) and r.get("job")]
        if beat is None and isinstance(status.get("heartbeat"), dict):
            beat, out["path"] = status["heartbeat"], str(windows_status_path(runs_dir))
    if beat is None:
        out["reason"] = "no heartbeat copy on this Mac yet"
        return out
    if beat is ValueError:
        out["reason"] = "heartbeat.json isn't valid JSON"
        return out
    if not isinstance(beat, dict):
        out["reason"] = "heartbeat.json isn't an object"
        return out
    stamp = _when(beat.get("at"))
    age = now - stamp if stamp is not None else None
    state = str(beat.get("job_state") or "").strip().lower().replace("_", "-") or None
    out.update(
        {
            "found": True,
            "at": iso(stamp) if stamp is not None else None,
            "age_s": age,
            "fresh": age is not None and age < FRESH_S,
            "stale": age is None or age > STALE_S,
            "job": (str(beat.get("job") or beat.get("current_job") or "").strip() or None),
            "job_state": state,
            "last_log_line": beat.get("last_log_line"),
            "error": beat.get("error") or None,
            "machine_up": beat.get("machine_up"),
            "running_jobs": [str(j) for j in beat.get("running_jobs") or [] if isinstance(j, str)],
        }
    )
    out["reason"] = (
        "no time in the heartbeat"
        if age is None
        else f"heartbeat {int(age // 60)} min old"
        if not out["fresh"]
        else "heartbeat fresh"
    )
    return out


def _windows_state(job_id: str, beat: Dict[str, Any]) -> Optional[str]:
    """A Windows job's state from a fresh heartbeat, or None when the heartbeat can't say."""
    if not beat.get("found") or beat.get("stale"):
        return None
    if job_id in (beat.get("running_jobs") or []):
        return "running"
    if beat.get("job") != job_id:
        return "stopped"  # Windows is on another job (or none), so this one isn't running
    word = beat.get("job_state") or ""
    if word in RUNNING_WORDS:
        return "running"
    if word in DONE_WORDS:
        return "done"
    if word in STOP_WORDS:
        return "stalled"
    return None


def remote_jobs(
    comms: List[Dict[str, Any]], local: List[Dict[str, Any]], beat: Dict[str, Any], now: float
) -> List[Dict[str, Any]]:
    """Jobs MAC's log says it started and never logged finishing, with their machine and state.

    A job whose folder here has stopped is left out: MAC just didn't log the finish.
    """
    stopped_here = {j["id"] for j in local if j.get("state") not in ("running", "waiting")}
    running_here = {j["id"] for j in local if j.get("state") in ("running", "waiting")}
    last: Dict[str, Dict[str, Any]] = {}
    started: Dict[str, str] = {}
    machine: Dict[str, str] = {}
    for m in sorted(comms, key=lambda m: m.get("at") or ""):
        job = (m.get("ref") or {}).get("job")
        if not job or not m.get("at"):
            continue
        last[job] = m
        if m.get("machine"):
            machine[job] = m["machine"]
        if m.get("mac_kind") == "job_started":
            started[job] = m["at"]
    # Windows' own list of finished jobs (windows-status.json "recent") beats a start with no logged finish.
    finished = {r["job"]: r for r in beat.get("recent") or []}
    out: List[Dict[str, Any]] = []
    for job, m in last.items():
        if m.get("mac_kind") != "job_started" or job in stopped_here or job in running_here:
            continue
        is_win = machine.get(job) == "windows"
        state, source = "running", "MAC's message log (start logged, no finish)"
        done = finished.get(job)
        done_ts, start_ts = _when((done or {}).get("finished_at")), _when(started.get(job))
        if is_win and done and done_ts and (start_ts is None or done_ts >= start_ts):
            state = "done"
            source = f"windows-status.json: finished {iso(done_ts)} ({done.get('first_line') or 'no first line'})"
        elif is_win:
            from_beat = _windows_state(job, beat)
            if from_beat:
                state, source = from_beat, "Windows heartbeat"
            else:
                source += "; no fresh Windows heartbeat to confirm"
        out.append(
            {
                "id": job,
                "machine": "WINDOWS" if is_win else "MAC",
                "state": state,
                "source": source,
                "started_at": started.get(job),
                "last_at": m.get("at"),
                "last_text": m.get("text"),
            }
        )
    # Jobs Windows' heartbeat says are running that MAC's log never mentioned.
    if beat.get("found") and not beat.get("stale"):
        known = {j["id"] for j in out} | running_here | stopped_here
        for job in beat.get("running_jobs") or []:
            if job not in known:
                out.append(
                    {
                        "id": job,
                        "machine": "WINDOWS",
                        "state": "running",
                        "source": "Windows heartbeat",
                        "started_at": None,
                        "last_at": beat.get("at"),
                        "last_text": beat.get("last_log_line"),
                    }
                )
    return out
