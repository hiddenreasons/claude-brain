"""Turn the snapshot into the messages passed between MAC and Claude.

Each message has a stable id, so the page can fire one bolt per new message and never re-fire an
old one. Direction: "to_claude" (MAC -> Claude) or "to_mac" (Claude -> MAC).

Times come from the files where they exist (job sent / result / report). Inbox replies carry no
time, so the Brain stamps them with the moment it first saw them; ones that were already there when
the Brain started get no time.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .readers import clip

TEXT_LIMIT = 280
SEND_LIMIT = 200  # newest messages sent to the page


def _blocked(text: Optional[str]) -> bool:
    return bool(text) and "BLOCKED" in text.upper()[:40] and not text.upper().startswith("UNBLOCKED")


def local_iso(stamp: Optional[str]) -> Optional[str]:
    """runs.log times look like '2026-10-09 09:01:03 EDT' in the Mac's local time."""
    if not stamp:
        return None
    try:
        local = datetime.strptime(stamp[:19], "%Y-%m-%d %H:%M:%S").astimezone()
    except ValueError:
        return None
    # Same form as every other time in the snapshot (UTC), so they sort as strings.
    return local.astimezone(timezone.utc).isoformat(timespec="seconds")


def _msg(
    mid: str,
    direction: str,
    kind: str,
    text: Optional[str],
    at: Optional[str],
    ref: Dict[str, str],
    blocked: bool = False,
) -> Dict[str, Any]:
    return {
        "id": mid,
        "direction": direction,
        "kind": kind,
        "text": clip((text or "").strip(), TEXT_LIMIT),
        "at": at,
        "blocked": blocked,
        "ref": ref,
    }


def derive_messages(snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
    messages: List[Dict[str, Any]] = []

    for entry in snapshot.get("inbox", []):
        ref = {"source": "work_order", "id": entry["id"]}
        from_mac = entry.get("from") == "MAC" or entry.get("wo") is not None
        messages.append(
            _msg(
                f"{entry['id']}:entry",
                "to_claude" if from_mac else "to_mac",
                "work_order" if from_mac else "to_mac",
                entry["title"],
                None,
                ref,
            )
        )
        for i, reply in enumerate(entry.get("replies", [])):
            to_mac = reply["direction"] == "to_mac"
            messages.append(
                _msg(
                    f"{entry['id']}:r{i}",
                    "to_mac" if to_mac else "to_claude",
                    "to_mac" if to_mac else "from_mac",
                    reply["text"],
                    None,
                    ref,
                    blocked=bool(reply.get("blocked")),
                )
            )

    for job in snapshot.get("oneshots", []):
        ref = {"source": "job", "kind": "oneshot", "id": job["id"]}
        messages.append(_msg(f"oneshot:{job['id']}:sent", "to_claude", "job_sent", job["title"], job["sent_at"], ref))
        if job.get("finished_at"):
            text = job.get("note") or job.get("result_preview")
            messages.append(
                _msg(
                    f"oneshot:{job['id']}:result",
                    "to_mac",
                    "job_result",
                    text,
                    job["finished_at"],
                    ref,
                    blocked=job["state"] == "error" or _blocked(text),
                )
            )

    for job in snapshot.get("folders", []):
        if job.get("iteration") is None:
            continue
        ref = {"source": "job", "kind": "folder", "id": job["id"]}
        base = f"folder:{job['id']}:i{job['iteration']}"
        messages.append(_msg(f"{base}:sent", "to_claude", "job_sent", job["title"], local_iso(job.get("started")), ref))
        if job["state"] in ("done", "blocked", "followed_up", "gate_failed", "no_report", "error"):
            text = job.get("report_headline") or f"Run ended ({job['state'].replace('_', ' ')})"
            blocked = job["state"] in ("blocked", "gate_failed", "error") or _blocked(job.get("report_headline"))
            at = job.get("report_at") or job.get("stream_updated_at")
            messages.append(_msg(f"{base}:report", "to_mac", "report", text, at, ref, blocked=blocked))
    return messages


def stamp_and_sort(
    messages: List[Dict[str, Any]], first_seen: Dict[str, Optional[str]], now_iso: str, initial: bool
) -> List[Dict[str, Any]]:
    """Give untimed messages the time the Brain first saw them; newest first; keep the newest SEND_LIMIT."""
    for message in messages:
        if message["id"] not in first_seen:
            first_seen[message["id"]] = None if initial else now_iso
        if message["at"] is None:
            message["at"] = first_seen[message["id"]]
    messages.sort(key=lambda m: m["at"] or "", reverse=True)
    return messages[:SEND_LIMIT]
