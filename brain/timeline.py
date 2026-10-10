"""The 3-lane timeline: what ran when on Claude (this Mac), MAC and Windows, over the last day.

Bars: {id, label, start, end (None while running), state, title, open}. `start` can be None when only the
finish was logged (an older Windows entry with no started_at that MAC never logged starting); the page
draws those as a short mark at `end`. Ticks on MAC's lane are the messages MAC sent. Read-only: built from the snapshot.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from .machines import _when
from .readers import clip, iso

SPAN_S = 24 * 3600
LIFE_STATE = {"running": "running", "done": "done", "resolved": "done", "blocked": "blocked", "stalled": "blocked"}
TZ_ABBR_RE = re.compile(r"\s+(?:E[DS]T|UTC)$")


def _t(value: Any) -> Optional[float]:
    """Epoch seconds from ISO or runs.log's "2026-10-09 20:19:48 EDT" (Eastern)."""
    if isinstance(value, str):
        value = TZ_ABBR_RE.sub("", value.strip()).replace(" ", "T", 1)
    return _when(value)


def _bar(
    bid: str, label: str, start: Optional[float], end: Optional[float], state: str, title: str, opener: Dict[str, Any]
) -> Dict[str, Any]:
    return {
        "id": bid,
        "label": label,
        "start": iso(start) if start else None,
        "end": iso(end) if end else None,
        "state": state,
        "title": clip(title, 200) or label,
        "open": opener,
    }


def _claude_lane(snapshot: Dict[str, Any], since: float) -> List[Dict[str, Any]]:
    out = []
    for j in snapshot.get("folders", []):
        state = LIFE_STATE.get(j.get("lifecycle") or "", "")
        if not state:
            continue
        end = (
            None if state == "running" else _t(j.get("report_at") or j.get("stream_updated_at") or j.get("updated_at"))
        )
        start = _t(j.get("started")) or (state == "running" and _t(j.get("state_since"))) or None
        if start is None and end and j.get("duration_s"):
            start = end - j["duration_s"]
        if (end or 9e18) < since or (start is None and end is None):
            continue
        out.append(
            _bar(
                f"job:{j['id']}",
                j["id"],
                start,
                end,
                state,
                j.get("title") or j["id"],
                {"type": "job", "kind": "folder", "id": j["id"]},
            )
        )
    for o in snapshot.get("oneshots", []):
        running = o.get("state") == "waiting"
        end = None if running else _t(o.get("updated_at"))
        start = _t(o.get("sent_at"))
        if start is None and end and o.get("duration_s"):
            start = end - o["duration_s"]
        if (end or 9e18) < since or start is None:
            continue
        state = "running" if running else "blocked" if o.get("state") in ("error", "blocked") else "done"
        out.append(
            _bar(
                f"job:{o['id']}",
                f"one-shot {o['id']}",
                start,
                end,
                state,
                o.get("title") or o["id"],
                {"type": "job", "kind": "oneshot", "id": o["id"]},
            )
        )
    return out


def _started_from_messages(messages: List[Dict[str, Any]], job: str) -> Optional[float]:
    times = [_t(m.get("at")) for m in messages if (m.get("ref") or {}).get("job") == job and m.get("at")]
    times = [t for t in times if t]
    return min(times) if times else None


def _windows_lane(snapshot: Dict[str, Any], messages: List[Dict[str, Any]], since: float) -> List[Dict[str, Any]]:
    out, seen = [], set()
    remote = {r["id"]: r for r in snapshot.get("remote_jobs", []) if r.get("machine") == "WINDOWS"}
    for r in (snapshot.get("windows") or {}).get("recent") or []:
        job, end = r.get("job"), _t(r.get("ended_at") or r.get("finished_at"))
        if not job or not end or end < since or job in seen:
            continue
        seen.add(job)
        # windows-status.json carries started_at for recent jobs (MAC, 2026-10-09); older entries fall back
        # to MAC's log, else only the finish is drawn.
        start = (
            _t(r.get("started_at"))
            or _t((remote.get(job) or {}).get("started_at"))
            or _started_from_messages(messages, job)
        )
        state = "blocked" if "BLOCKED" in str(r.get("first_line") or "") else "done"
        out.append(
            _bar(
                f"win:{job}",
                job,
                start if start and start < end else None,
                end,
                state,
                r.get("first_line") or job,
                {"type": "node", "id": f"win:{job}"},
            )
        )
    for job, r in remote.items():
        if r.get("state") != "running" or job in seen:
            continue
        seen.add(job)
        start = _t(r.get("started_at")) or _started_from_messages(messages, job) or _t(r.get("state_since"))
        out.append(
            _bar(
                f"win:{job}",
                job,
                start,
                None,
                "running",
                r.get("last_text") or job,
                {"type": "node", "id": f"win:{job}"},
            )
        )
    return out


def _codex(snapshot: Dict[str, Any], machine: str, since: float) -> List[Dict[str, Any]]:
    out = []
    for c in (snapshot.get("codex") or {}).get("jobs") or []:
        if c.get("machine") != machine:
            continue
        start, end = _t(c.get("started_at")), _t(c.get("ended_at"))
        if (end or 9e18) < since or start is None:
            continue
        state = {"done": "done", "failed": "blocked"}.get(c.get("state"), "running")
        out.append(
            _bar(
                f"codex:{c['job']}",
                f"Codex {str(c['job']).split('-')[0]}",
                start,
                end,
                state,
                f"Codex pictures {c['job']}: {c.get('result') or c.get('state')}",
                {"type": "node", "id": f"codex:{c['job']}"},
            )
        )
    return out


def build(snapshot: Dict[str, Any], messages: List[Dict[str, Any]], now: float) -> Dict[str, Any]:
    since = now - SPAN_S
    ticks = []
    for m in messages:
        at = _t(m.get("at"))
        if at and at >= since and m.get("direction") == "to_claude":
            job = (m.get("ref") or {}).get("job")
            ticks.append(
                {
                    "at": iso(at),
                    "label": job or "MAC",
                    "title": clip(m.get("text"), 160),
                    "machine": m.get("machine") or "mac",
                }
            )
    return {
        "from": iso(since),
        "to": iso(now),
        "lanes": {
            "claude": _claude_lane(snapshot, since),
            "mac": _codex(snapshot, "MAC", since),
            "windows": _windows_lane(snapshot, messages, since) + _codex(snapshot, "WINDOWS", since),
        },
        "ticks": ticks[:200],
    }
