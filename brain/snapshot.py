"""Combine every source into one snapshot, and cheaply detect when any source changed."""

from __future__ import annotations

import hashlib
import os
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import gitread
from .comms import TAIL_BYTES as COMMS_TAIL
from .comms import comms_path, parse_comms
from .config import Config
from .inbox import parse_inbox
from .labels import job_action, order_action
from .mac_runs import scan_flat_jobs, scan_job_folders
from .machines import read_heartbeat, remote_jobs
from .readers import FileCache, clip, iso, mtime_iso, read_tail, read_text
from .status_files import parse_issues, parse_status

ONESHOT_LIMIT = 150  # newest one-shot jobs sent to the page; the total count is reported too
ATTENTION_WINDOW_S = 72 * 3600  # older problems are history, not alerts
# The only states that may alert or get a fix-request button (Anthony, 2026-10-09). Running and
# waiting jobs, OPEN and RUNNING work orders, and resolved jobs never do.
ALERT_STATES = {"blocked", "stalled", "gate_failed", "no_report", "error"}
ALERT_ORDER_STATES = {"BLOCKED"}


def fingerprint(cfg: Config) -> str:
    """A hash of names, sizes and mtimes of everything the snapshot reads. No file contents."""
    h = hashlib.sha1()

    def add_stat(path: str) -> None:
        try:
            st = os.stat(path)
        except OSError:
            h.update(f"{path}:missing;".encode())
            return
        h.update(f"{path}:{st.st_mtime_ns}:{st.st_size};".encode())

    add_stat(str(cfg.inbox_path))
    try:
        top = sorted(os.scandir(cfg.runs_dir), key=lambda e: e.name)
    except OSError:
        top = []
    for entry in top:
        try:
            st = entry.stat(follow_symlinks=False)
        except OSError:
            continue
        h.update(f"{entry.name}:{st.st_mtime_ns}:{st.st_size};".encode())
        if entry.is_dir(follow_symlinks=False) and not entry.name.startswith((".", "_")):
            try:
                for child in sorted(os.scandir(entry.path), key=lambda e: e.name):
                    cst = child.stat(follow_symlinks=False)
                    h.update(f"{entry.name}/{child.name}:{cst.st_mtime_ns}:{cst.st_size};".encode())
            except OSError:
                continue
    return h.hexdigest()


def _age_s(iso_ts: Optional[str], now: float) -> float:
    if not iso_ts:
        return float("inf")
    try:
        return now - datetime.fromisoformat(iso_ts).timestamp()
    except ValueError:
        return float("inf")


def build_attention(inbox: List[dict], folders: List[dict], oneshots: List[dict], now: float) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for entry in inbox:
        if entry["needs_attention"]:
            last = entry["replies"][-1]["text"] if entry["replies"] else entry["status_text"]
            items.append(
                {"source": "work_order", "id": entry["id"], "state": "BLOCKED", "title": entry["title"], "detail": last}
            )
    for job in folders:
        if job["state"] in ALERT_STATES and _age_s(job["updated_at"], now) < ATTENTION_WINDOW_S:
            items.append(
                {
                    "source": "job",
                    "kind": "folder",
                    "id": job["id"],
                    "state": job["state"],
                    "title": job["title"],
                    "detail": job["report_headline"],
                }
            )
    for job in oneshots:
        if job["state"] in ALERT_STATES and _age_s(job["updated_at"], now) < ATTENTION_WINDOW_S:
            items.append(
                {
                    "source": "job",
                    "kind": "oneshot",
                    "id": job["id"],
                    "state": job["state"],
                    "title": job["title"],
                    "detail": job["note"] or job["result_preview"],
                }
            )
    return items


STUCK_STATES = {"blocked", "no_report", "stalled", "gate_failed", "error"}
# Resolved states never raise an alert: "cleared" has explicit word from MAC (change log or comms
# "unblocked"); "followed_up" means MAC acted in the job folder after the report.
RESOLVED_STATES = {"cleared", "followed_up"}
RESOLVED_RE = re.compile(r"\b(committed|merged|pushed|done|approved|resolved|fixed|cleared|unblocked|closed)\b", re.I)
STILL_OPEN_RE = re.compile(r"\b(blocked|awaiting|waiting on|pending|failed)\b", re.I)


def _status_evidence(job: dict, entries: List[dict], since: str) -> List[tuple]:
    """(time, why, resolved?) from STATUS.md change-log entries that name the job after its report.

    An entry can mention the job more than once ("claudemd alert was stale; claudemd committed f1d2a32,
    resolved"). Each mention is judged from the job's name to the next sentence break: any still-open
    wording makes the entry open, else any resolved wording makes it resolved, else it's only a mention
    and is ignored.
    """
    name = re.compile(rf"\b{re.escape(job['id'])}\b", re.I)
    found = []
    for e in entries:
        if not e["at"] or e["at"] <= since:
            continue
        parts = [re.split(r"[.;]\s", e["text"][m.start() :], maxsplit=1)[0] for m in name.finditer(e["text"])]
        if not parts:
            continue
        if any(STILL_OPEN_RE.search(part) for part in parts):
            found.append((e["at"], f"STATUS.md: {clip(e['text'], 220)}", False))
        elif any(RESOLVED_RE.search(part) for part in parts):
            found.append((e["at"], f"STATUS.md: {clip(e['text'], 220)}", True))
    return found


def _comms_evidence(job: dict, comms: List[dict], since: str) -> List[tuple]:
    """(time, why, resolved?) from MAC's message log lines about the job after its report."""
    found = []
    for m in comms:
        if m.get("ref", {}).get("job") != job["id"] or not m.get("at") or m["at"] <= since:
            continue
        if m.get("mac_kind") == "unblocked":
            found.append((m["at"], f"MAC (comms log): {clip(m['text'], 200)}", True))
        elif m.get("blocked"):
            found.append((m["at"], f"comms log: {clip(m['text'], 200)}", False))
    return found


def _decision_evidence(job: dict, decisions: List[dict], status_at: Optional[str], since: str) -> List[tuple]:
    """A settled line in "Open decisions" that names the job (~~…~~ DONE/MERGED/…), seen after the report."""
    if not status_at or status_at <= since:
        return []
    name = re.compile(rf"\b{re.escape(job['id'])}\b", re.I)
    return [
        (status_at, f"STATUS.md decision: {clip(d['text'], 200)}", True)
        for d in decisions
        if d.get("settled") and d.get("word") != "DROPPED" and name.search(d["text"])
    ]


def _git_evidence(job: dict, since: str) -> List[tuple]:
    """The job's own worktree moved on after its report: a newer commit, or that commit merged into main."""
    wt = Path(job["path"]) / "wt" if job.get("path") else None
    if wt is None or not gitread.is_worktree(wt):
        return []
    found = gitread.head(wt)
    if not found:
        return []
    sha, ts = found
    at = iso(ts)
    if not since or at <= since:
        return []
    merged = gitread.merged_into(wt, "main")
    how = "merged into main" if merged else "committed in the job's worktree"
    return [(at, f"git: {sha[:7]} {how} after the report", True)]


def apply_followups(
    jobs: List[dict],
    entries: List[dict],
    comms: List[dict],
    decisions: Optional[List[dict]] = None,
    status_at: Optional[str] = None,
) -> None:
    """Clear a stuck job (folder or one-shot) when MAC says it's resolved after the report.

    For a one-shot with no result, MAC's word only counts after the order was sent.

    MAC often fixes things outside the job folder (a commit or merge in the repo) and says so in the
    STATUS.md change log, or logs kind "unblocked" in comms.jsonl. The newest such word decides:
    resolved wording clears the job; still-open wording (blocked, awaiting, pending) keeps it as is.
    """
    for job in jobs:
        if job["state"] not in STUCK_STATES and job["state"] != "followed_up":
            continue
        since = job.get("report_at") or job.get("stream_updated_at") or job.get("sent_at") or ""
        # Recheck before any alert: STATUS.md change log and decisions, MAC's log, and the job's git state.
        evidence = (
            _status_evidence(job, entries, since)
            + _comms_evidence(job, comms, since)
            + _decision_evidence(job, decisions or [], status_at, since)
            + _git_evidence(job, since)
        )
        if not evidence:
            continue
        at, why, resolved = max(evidence, key=lambda e: e[0])
        if resolved:
            job["state"] = "cleared"
            job["followed_up_by"] = why
            job["followed_up_at"] = at


def _source(path: Any) -> Dict[str, Any]:
    return {"path": str(path), "exists": os.path.exists(path), "updated_at": mtime_iso(path)}


def build_snapshot(cfg: Config, cache: FileCache, now: Optional[float] = None) -> Dict[str, Any]:
    now = time.time() if now is None else now
    inbox = cache.get(cfg.inbox_path, "inbox", lambda p: parse_inbox(read_text(p) or ""))
    folders = scan_job_folders(cfg.runs_dir, cache, now)
    oneshots = scan_flat_jobs(cfg.runs_dir, cache, now)
    status = cache.get(cfg.status_path, "status", lambda p: parse_status(read_text(p)))
    issues = cache.get(cfg.issues_path, "issues", lambda p: parse_issues(read_text(p)))
    comms, comms_skipped = cache.get(
        comms_path(cfg.runs_dir), "comms", lambda p: parse_comms(read_tail(p, COMMS_TAIL) or "")
    )
    for job in oneshots:
        job["machine"] = "MAC"
    apply_followups(
        folders + oneshots,
        status.get("entries", []),
        comms,
        status.get("decision_items", []),
        mtime_iso(cfg.status_path),
    )
    heartbeat = read_heartbeat(cfg.runs_dir, now)
    remote = remote_jobs(comms, folders + oneshots, heartbeat, now)
    # One flag the page trusts for fix-request buttons, so the rule lives in one place.
    for job in folders + oneshots:
        job.update(job_action(job))
    for entry in inbox:
        entry.update(order_action(entry))
    # Only NEEDS ANTHONY items get a fix-request button.
    for item in folders + oneshots + inbox:
        item["alertable"] = item["action"] == "needs_anthony"
    return {
        "generated_at": iso(now),
        "sources": {
            "inbox": _source(cfg.inbox_path),
            "runs": _source(cfg.runs_dir),
            "status": _source(cfg.status_path),
            "issues": _source(cfg.issues_path),
            "comms": {**_source(comms_path(cfg.runs_dir)), "optional": True},
        },
        "attention": build_attention(inbox, folders, oneshots, now),
        "windows": heartbeat,
        "remote_jobs": remote,
        "running_count": sum(j["state"] == "running" for j in folders) + sum(j["state"] == "waiting" for j in oneshots),
        "folders": folders,
        "oneshots": oneshots[:ONESHOT_LIMIT],
        "oneshot_total": len(oneshots),
        "inbox": inbox,
        "status": {k: v for k, v in status.items() if k != "entries"},
        "issues": issues,
        "_comms": (comms, comms_skipped),  # internal: the server reuses it, never sent to the page
    }
