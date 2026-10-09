"""What the Brain records after each refresh, in its own folder only (brainfiles.py).

Part 1: one alert per job state (job, state, report time); clears; settled decisions; placeholder bugs.
Each goes to the append-only audit trail exactly once, even across restarts.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any, Dict, List

from .brainfiles import BrainFiles, Ledger, audit

log = logging.getLogger("claude-brain")


def _digest(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def alert_key(item: Dict[str, Any], jobs: Dict[str, Dict[str, Any]]) -> str:
    """One alert per (job, state, report time). A new state or a rewritten REPORT.md makes a new key."""
    if item["source"] == "job":
        job = jobs.get(f"{item['kind']}:{item['id']}", {})
        stamp = job.get("report_at") or job.get("updated_at") or ""
        return f"job:{item['kind']}:{item['id']}|{item['state']}|{stamp}"
    return f"order:{item['id']}|{item['state']}|{_digest(item.get('detail') or '')}"


class Recorder:
    def __init__(self, files: BrainFiles) -> None:
        self.files = files
        self.alerts = Ledger(files, "alerts.jsonl")
        self.seen = Ledger(files, "audit.jsonl", key="key")

    def _once(self, key: str, event: str, job: str, change: str, who: str) -> bool:
        if self.seen.has(key):
            return False
        self.files.append("audit.jsonl", {"key": key, "event": event, "job": job, "change": change, "who": who})
        self.seen.keys.add(key)
        return True

    def record(self, snapshot: Dict[str, Any]) -> Dict[str, int]:
        counts = {"alerts": 0, "clears": 0, "decisions": 0, "bugs": 0}
        jobs = {f"{j['kind']}:{j['id']}": j for j in snapshot.get("folders", []) + snapshot.get("oneshots", [])}
        alert_log = {r.get("key"): r for r in self.files.records("alerts.jsonl")}
        for item in snapshot.get("attention", []):
            key = alert_key(item, jobs)
            if self.alerts.add(key, {"job": item["id"], "state": item["state"], "title": item.get("title")}):
                audit(
                    self.files,
                    "alert",
                    item["id"],
                    f"{item['state']}: {item.get('detail') or item.get('title') or ''}"[:300],
                )
                counts["alerts"] += 1
                alert_log[key] = {"at": None}
            item["alert_key"] = key
            item["first_alerted_at"] = (alert_log.get(key) or {}).get("at")
        for job in jobs.values():
            if job.get("state") == "cleared" and job.get("followed_up_at"):
                who = "git" if str(job.get("followed_up_by", "")).startswith("git") else "MAC"
                if self._once(
                    f"clear:{job['id']}|{job['followed_up_at']}",
                    "clear",
                    job["id"],
                    str(job.get("followed_up_by") or "")[:300],
                    who,
                ):
                    counts["clears"] += 1
            if job.get("placeholders"):
                names = ", ".join(f"{{{{{n}}}}}" for n in job["placeholders"])
                if self._once(
                    f"bug:placeholder:{job['id']}|{names}",
                    "bug",
                    job["id"],
                    f"brief.md has unfilled {names}; title fell back to the folder name and task line",
                    "Brain",
                ):
                    counts["bugs"] += 1
        for d in (snapshot.get("status") or {}).get("decision_items", []):
            if d.get("settled") and self._once(
                f"decision:{_digest(d['text'])}",
                "decision",
                ", ".join(d.get("ids") or []) or "-",
                d["text"][:300],
                "Anthony / MAC (STATUS.md)",
            ):
                counts["decisions"] += 1
        return counts


def safe_record(recorder: Recorder | None, snapshot: Dict[str, Any]) -> Dict[str, int]:
    """Recording must never stop the live page."""
    if recorder is None:
        return {}
    try:
        return recorder.record(snapshot)
    except Exception:
        log.exception("Brain could not record this refresh; the page is unaffected")
        return {}


def audit_tail(files: BrainFiles | None, n: int = 30) -> List[Dict[str, Any]]:
    if files is None:
        return []
    return [{k: r.get(k) for k in ("at", "event", "job", "change", "who")} for r in files.records("audit.jsonl")[-n:]][
        ::-1
    ]
