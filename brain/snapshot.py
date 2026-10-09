"""Combine every source into one snapshot, and cheaply detect when any source changed."""

from __future__ import annotations

import hashlib
import os
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

from .config import Config
from .inbox import parse_inbox
from .mac_runs import scan_flat_jobs, scan_job_folders
from .readers import FileCache, iso, mtime_iso, read_text
from .status_files import parse_issues, parse_status

ONESHOT_LIMIT = 150  # newest one-shot jobs sent to the page; the total count is reported too
ATTENTION_WINDOW_S = 72 * 3600  # older problems are history, not alerts
FOLDER_PROBLEMS = {"gate_failed", "blocked", "stalled", "no_report"}


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
        if job["state"] in FOLDER_PROBLEMS and _age_s(job["updated_at"], now) < ATTENTION_WINDOW_S:
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
        if job["state"] == "error" and _age_s(job["updated_at"], now) < ATTENTION_WINDOW_S:
            items.append(
                {
                    "source": "job",
                    "kind": "oneshot",
                    "id": job["id"],
                    "state": "error",
                    "title": job["title"],
                    "detail": job["note"] or job["result_preview"],
                }
            )
    return items


def _source(path: Any) -> Dict[str, Any]:
    return {"path": str(path), "exists": os.path.exists(path), "updated_at": mtime_iso(path)}


def build_snapshot(cfg: Config, cache: FileCache, now: Optional[float] = None) -> Dict[str, Any]:
    now = time.time() if now is None else now
    inbox = cache.get(cfg.inbox_path, "inbox", lambda p: parse_inbox(read_text(p) or ""))
    folders = scan_job_folders(cfg.runs_dir, cache, now)
    oneshots = scan_flat_jobs(cfg.runs_dir, cache, now)
    status = cache.get(cfg.status_path, "status", lambda p: parse_status(read_text(p)))
    issues = cache.get(cfg.issues_path, "issues", lambda p: parse_issues(read_text(p)))
    return {
        "generated_at": iso(now),
        "sources": {
            "inbox": _source(cfg.inbox_path),
            "runs": _source(cfg.runs_dir),
            "status": _source(cfg.status_path),
            "issues": _source(cfg.issues_path),
        },
        "attention": build_attention(inbox, folders, oneshots, now),
        "folders": folders,
        "oneshots": oneshots[:ONESHOT_LIMIT],
        "oneshot_total": len(oneshots),
        "inbox": inbox,
        "status": status,
        "issues": issues,
    }
