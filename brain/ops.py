"""Operations: usage, possible loops, restart storms, time in state, decision IDs, branch hygiene,
cross-machine conflicts. Everything here is read-only and shown, never acted on.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import gitread
from .readers import clip, iso, read_text

LOOP_S = 20 * 60  # 20+ min of work with no file changes
STORM_WINDOW_S = 60 * 60
STORM_COUNT = 3
STALE_WORK_S = 24 * 3600
RUNS_START_RE = re.compile(r"^start (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
GUARD_RE = re.compile(r"^restart-guard (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})")
BRANCH_RE = re.compile(r"\b((?:claude|codex|feat|fix|chore|vv2)/[\w.-]+)")
FILE_RE = re.compile(r"\b((?:vader|docs|tests|tools|harness|brain|spec)/[\w./-]+\.\w{1,5})\b")
DECISION_ID_RE = re.compile(r"\bA-\d{3}\b")


def _local(text: str) -> Optional[float]:
    try:
        return datetime.strptime(text, "%Y-%m-%d %H:%M:%S").astimezone().timestamp()
    except ValueError:
        return None


# ---------- 12. usage and possible loops ----------


def read_usage(runs_dir: Path) -> Dict[str, Any]:
    """Usage left per machine, if anything reports it: ~/.vader-mac-runs/brain/usage.json
    ({"MAC": {"left_pct": 64, ...}, "WINDOWS": {...}, "at": ...}). No file: no data, said plainly."""
    raw = read_text(runs_dir / "brain" / "usage.json", 64 * 1024)
    if raw is None:
        return {"found": False, "machines": {}, "note": "no usage source yet (brain/usage.json)"}
    try:
        data = json.loads(raw)
    except ValueError:
        return {"found": False, "machines": {}, "note": "usage.json isn't valid JSON"}
    machines = {}
    for name in ("MAC", "WINDOWS"):
        m = data.get(name) or data.get(name.lower()) if isinstance(data, dict) else None
        if isinstance(m, dict):
            left = m.get("left_pct", m.get("left"))
            machines[name] = {
                "left_pct": left if isinstance(left, (int, float)) else None,
                "note": clip(m.get("note"), 80),
            }
    return {"found": True, "machines": machines, "note": None}


def possible_loops(folders: List[Dict[str, Any]], now: float) -> List[Dict[str, Any]]:
    """A running job whose log keeps moving for 20+ min while nothing in its worktree changes."""
    out = []
    for job in folders:
        if job.get("state") != "running" or not job.get("path"):
            continue
        started = _local(str(job.get("started") or "")[:19])
        if started is None or now - started < LOOP_S:
            continue
        wt = Path(job["path"]) / "wt"
        if not gitread.is_worktree(wt):
            continue
        changes = []
        for _status, name in gitread.changed_files(wt):
            try:
                changes.append((wt / name).stat().st_mtime)
            except OSError:
                continue
        head = gitread.head(wt)
        if head:
            changes.append(head[1])
        quiet = int((now - max(max(changes) if changes else started, started)) // 60)
        moved = job.get("stream_updated_at")
        log_moving = bool(moved) and now - datetime.fromisoformat(moved).timestamp() < 5 * 60
        if log_moving and quiet * 60 >= LOOP_S:
            why = f"log still moving, no file changed in its worktree for {quiet} min"
            out.append({"id": job["id"], "machine": "MAC", "minutes": quiet, "why": why})
    return out


# ---------- 13. restart storms ----------


def restart_times(job_path: Path) -> List[float]:
    """Every (re)start and refused restart of a job: starts.log, runs.log "start" and restart-guard lines."""
    times: List[float] = []
    for line in (read_text(job_path / "starts.log", 64 * 1024) or "").splitlines():
        first = line.split(" ", 1)[0]
        if first.isdigit():
            times.append(float(first))
    for line in (read_text(job_path / "runs.log", 128 * 1024) or "").splitlines():
        m = RUNS_START_RE.match(line) or GUARD_RE.match(line)
        if m:
            ts = _local(m.group(1))
            if ts is not None:
                times.append(ts)
    return sorted(set(times))


def restart_storms(folders: List[Dict[str, Any]], now: float) -> List[Dict[str, Any]]:
    out = []
    for job in folders:
        if not job.get("path"):
            continue
        recent = [t for t in restart_times(Path(job["path"])) if now - t <= STORM_WINDOW_S]
        if len(recent) >= STORM_COUNT:
            out.append(
                {
                    "id": job["id"],
                    "count": len(recent),
                    "since": iso(recent[0]),
                    "why": f"{len(recent)} starts or restart attempts in the last 60 min",
                }
            )
    return out


# ---------- 14. time in state ----------


def state_since(item: Dict[str, Any]) -> Optional[str]:
    life = item.get("lifecycle")
    if item.get("kind") == "folder":
        if life == "running":
            ts = _local(str(item.get("started") or "")[:19])
            return iso(ts) if ts else item.get("stream_updated_at")
        return item.get("followed_up_at") or item.get("report_at") or item.get("updated_at")
    if item.get("kind") == "oneshot":
        return item.get("sent_at") if life == "running" else item.get("finished_at") or item.get("updated_at")
    if "wo" in item:  # work order: the date it was opened
        date = item.get("date")
        try:
            return datetime.strptime(date, "%Y-%m-%d").astimezone().isoformat(timespec="seconds") if date else None
        except ValueError:
            return None
    return item.get("started_at") or item.get("last_at")


# ---------- 15. decision IDs in briefs ----------


def first_decision_day(decision_log: Dict[str, Dict[str, Any]]) -> Optional[str]:
    days = sorted(str(v.get("when") or "")[:10] for v in decision_log.values() if v.get("when"))
    return days[0] if days else None


def missing_decision_id(job: Dict[str, Any], since_day: Optional[str]) -> bool:
    """Briefs written since the decision log started must cite the A-xxx IDs they follow."""
    if not since_day or job.get("decision_ids") or not job.get("brief_at"):
        return False
    return job["brief_at"][:10] >= since_day and job.get("lifecycle") not in ("done", "resolved")


# ---------- 16. branch hygiene ----------


def branch_hygiene(vader_dir: Path, folders: List[Dict[str, Any]], now: float) -> Dict[str, Any]:
    merged = []
    current = gitread.branch(vader_dir)
    for line in (gitread.git(vader_dir, "branch", "--merged", "main", "--format=%(refname:short)") or "").splitlines():
        name = line.strip()
        if name and name not in ("main", "master", current):
            merged.append(name)
    stale: List[Dict[str, Any]] = []

    def old_changes(path: Path, where: str) -> None:
        for status, name in gitread.changed_files(path):
            try:
                age = now - (path / name).stat().st_mtime
            except OSError:
                continue
            if age > STALE_WORK_S:
                stale.append(
                    {"where": where, "file": name, "status": status.strip() or "?", "days": round(age / 86400, 1)}
                )

    old_changes(vader_dir, "VADER")
    for job in folders:
        wt = Path(job["path"]) / "wt" if job.get("path") else None
        if wt and gitread.is_worktree(wt):
            old_changes(wt, f"{job['id']}/wt")
    return {"merged": merged, "stale": stale[:40], "stale_total": len(stale)}


# ---------- 17. cross-machine conflicts ----------


def cross_machine_conflicts(
    folders: List[Dict[str, Any]], remote: List[Dict[str, Any]], messages: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """A running Mac job and a running Windows job touching the same branch or file."""
    mac: Dict[str, Dict[str, set]] = {}
    for job in folders:
        if job.get("state") not in ("running", "waiting") or not job.get("path"):
            continue
        wt = Path(job["path"]) / "wt"
        if not gitread.is_worktree(wt):
            continue
        b = gitread.branch(wt)
        mac[job["id"]] = {"branches": {b} if b else set(), "files": {f for _s, f in gitread.changed_files(wt)}}
    out = []
    for rj in remote:
        if rj.get("machine") != "WINDOWS" or rj.get("state") != "running":
            continue
        text = " ".join(m.get("text") or "" for m in messages if (m.get("ref") or {}).get("job") == rj["id"])
        w_branches, w_files = set(BRANCH_RE.findall(text)), set(FILE_RE.findall(text))
        for mid, touch in mac.items():
            same = sorted((touch["branches"] & w_branches) | (touch["files"] & w_files))
            if same:
                out.append(
                    {
                        "mac": mid,
                        "windows": rj["id"],
                        "same": same[:6],
                        "why": f"MAC job {mid} and WINDOWS job {rj['id']} both touch {', '.join(same[:3])}",
                    }
                )
    return out


def apply(
    snapshot: Dict[str, Any], vader_dir: Path, runs_dir: Path, now: float, comms: List[Dict[str, Any]]
) -> Dict[str, Any]:
    folders = snapshot["folders"]
    since_day = first_decision_day((snapshot.get("status") or {}).get("decision_log") or {})
    items = folders + snapshot["oneshots"] + snapshot["inbox"] + snapshot.get("remote_jobs", [])
    overdue = []
    for item in items:
        item["state_since"] = state_since(item)
        if item.get("kind") == "folder":
            item["no_decision_id"] = missing_decision_id(item, since_day)
        if item.get("up_next") == "Anthony" and item["state_since"]:
            try:
                waited = now - datetime.fromisoformat(item["state_since"]).timestamp()
            except ValueError:
                continue
            if waited >= 30 * 60:
                overdue.append({"id": item["id"], "title": item.get("title"), "minutes": int(waited // 60)})
    overdue.sort(key=lambda o: -o["minutes"])
    storms = restart_storms(folders, now)
    for s in storms:
        next(j for j in folders if j["id"] == s["id"]).setdefault("flags", []).append(f"RESTART STORM: {s['why']}")
    loops = possible_loops(folders, now)
    for lp in loops:
        next(j for j in folders if j["id"] == lp["id"]).setdefault("flags", []).append(f"POSSIBLE LOOP: {lp['why']}")
    return {
        "usage": read_usage(runs_dir),
        "loops": loops,
        "storms": storms,
        "overdue": overdue,
        "hygiene": branch_hygiene(vader_dir, folders, now),
        "conflicts": cross_machine_conflicts(folders, snapshot.get("remote_jobs", []), comms),
        "no_decision_id": [j["id"] for j in folders if j.get("no_decision_id")],
    }
