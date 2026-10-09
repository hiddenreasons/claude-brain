"""Read MAC's message log: ~/.vader-mac-runs/brain/comms.jsonl.

MAC appends one JSON line per message between MAC and Claude (format in docs/GROKBOT-COMMS-LOG.md).
This covers what the Brain can't see in the files on this Mac: exact times for inbox replies,
messages sent from Grok Bot's own computer, and jobs on the Windows machine.

Bad lines are skipped and counted, never fatal. The log is only ever read.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .readers import clip, read_tail

TAIL_BYTES = 2 * 1024 * 1024
PARTIES = ("mac", "claude")
KINDS = {
    "work_order",
    "job_sent",
    "job_started",
    "reply",
    "question",
    "report",
    "blocked",
    "unblocked",
    "done",
    "job_finished",
}
STATUSES = ("ok", "blocked", "error")
SAFE_JOB_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
RUNNING_WINDOW = timedelta(hours=6)
DEDUPE_WINDOW_S = 300


def comms_path(runs_dir: Path) -> Path:
    return runs_dir / "brain" / "comms.jsonl"


def _utc_iso(value: Any) -> Optional[str]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None  # a time without a zone can't be placed; MAC is asked to write UTC
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds")


def _brain_kind(kind: str, sender: str) -> str:
    """Map MAC's kinds onto the labels the page already knows."""
    if kind == "work_order":
        return "work_order"
    if kind in ("job_sent", "job_started"):
        return "job_sent"
    if kind in ("report", "done", "job_finished"):
        return "report"
    return "from_mac" if sender == "mac" else "to_mac"


def parse_comms(text: str) -> Tuple[List[Dict[str, Any]], int]:
    """Return (messages in the Brain's shape, number of lines skipped)."""
    messages: List[Dict[str, Any]] = []
    skipped = 0
    seen: set = set()
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            skipped += 1
            continue
        if not isinstance(event, dict):
            skipped += 1
            continue
        sender, receiver = event.get("from"), event.get("to")
        at = _utc_iso(event.get("at"))
        kind = event.get("kind")
        if sender not in PARTIES or receiver not in PARTIES or sender == receiver or at is None or kind not in KINDS:
            skipped += 1
            continue
        status = event.get("status") if event.get("status") in STATUSES else "ok"
        raw_id = event.get("id")
        if not isinstance(raw_id, str) or not raw_id.strip():
            raw_id = hashlib.sha1(line.encode("utf-8")).hexdigest()[:16]
        mid = f"comms:{raw_id.strip()[:120]}"
        if mid in seen:
            continue  # a repeated line is the same message, not a new one
        seen.add(mid)
        job = event.get("job") if isinstance(event.get("job"), str) and SAFE_JOB_RE.match(event["job"]) else None
        wo = event.get("wo") if isinstance(event.get("wo"), int) and not isinstance(event.get("wo"), bool) else None
        machine = event.get("machine") if isinstance(event.get("machine"), str) else None
        messages.append(
            {
                "id": mid,
                "direction": "to_claude" if receiver == "claude" else "to_mac",
                "kind": _brain_kind(kind, sender),
                "mac_kind": kind,
                "text": clip(str(event.get("text") or "").replace("\n", " ").strip(), 280),
                "at": at,
                "blocked": status in ("blocked", "error") or kind == "blocked",
                "ref": {"source": "comms", "job": job, "wo": wo},
                "machine": clip(machine, 20) if machine else None,
            }
        )
    return messages, skipped


def read_comms(runs_dir: Path) -> Tuple[List[Dict[str, Any]], int]:
    text = read_tail(comms_path(runs_dir), TAIL_BYTES)
    return parse_comms(text) if text else ([], 0)


def running_from_comms(messages: List[Dict[str, Any]], now: datetime) -> List[str]:
    """Jobs MAC says started (e.g. on Windows) with no finish logged yet, within the last 6 hours."""
    state: Dict[str, Tuple[str, str]] = {}
    for m in sorted(messages, key=lambda m: m["at"]):
        job = m["ref"].get("job")
        if job and m["mac_kind"] in ("job_started", "job_finished", "done", "report"):
            state[job] = (m["mac_kind"], m["at"])
    cutoff = now - RUNNING_WINDOW
    return sorted(
        job for job, (kind, at) in state.items() if kind == "job_started" and datetime.fromisoformat(at) >= cutoff
    )


def _norm(text: str) -> str:
    text = re.sub(r"^(to mac|from mac)\b[:\s(]*", "", (text or "").lower())
    return re.sub(r"\W+", " ", text).strip()[:50]


def merge(derived: List[Dict[str, Any]], comms: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """MAC's log wins. Drop a message the Brain worked out from files when MAC logged the same one,
    so a single message never fires two bolts."""
    if not comms:
        return derived

    def seconds(iso: Optional[str]) -> Optional[float]:
        return datetime.fromisoformat(iso).timestamp() if iso else None

    by_job: Dict[Tuple[str, str], List[float]] = {}
    texts = {(m["direction"], _norm(m["text"])) for m in comms if m["text"]}
    for m in comms:
        job = m["ref"].get("job")
        phase = "sent" if m["kind"] == "job_sent" else "report" if m["kind"] == "report" else None
        if job and phase:
            by_job.setdefault((job, phase), []).append(seconds(m["at"]))

    kept = []
    for m in derived:
        ref = m.get("ref", {})
        if ref.get("source") == "job":
            phase = "sent" if m["kind"] == "job_sent" else "report"
            at = seconds(m.get("at"))
            near = by_job.get((ref.get("id"), phase), [])
            if at is not None and any(abs(at - t) <= DEDUPE_WINDOW_S for t in near):
                continue
        elif ref.get("source") == "work_order" and (m["direction"], _norm(m["text"])) in texts:
            continue
        kept.append(m)
    return kept + comms
