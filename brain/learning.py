"""Self-learning, drafts only.

- After each job resolves: a short post-mortem (what happened, what slowed it, what fixed it).
- When the same failure, or the same false alert, happens 2+ times: a proposed lesson with a draft rule.
- Proposals wait in ~/.vader-mac-runs/brain/PROPOSED-LESSONS.md until Anthony or MAC sets
  **Status:** approved (or declined). Nothing changes before that. An approved lesson changes only the
  Brain's own alerting, as data, never code: a "known issue" note on matching blocked jobs, or a 15-minute
  hold before alerting on a signature that keeps clearing itself. MAC copies approved lessons into
  ~/.vader-mac-runs/LESSONS.md; the Brain never writes outside its folder.
- Weekly: false alerts, duplicate alerts and time to clear, to show whether it's getting better.
History is never deleted: the logs are append-only and pages keep every entry.
"""

from __future__ import annotations

import hashlib
import re
import statistics
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from .flow import failure_signature

FALSE_ALERT_MIN = 15
LESSON_STATUSES = ("proposed", "approved", "declined")
LESSON_LINE_RE = re.compile(r"^###\s+(L-[0-9a-f]{6})\b.*?$|^-\s*\*\*Status:\*\*\s*(\w+)(.*)$", re.M)


def lesson_id(key: str) -> str:
    return "L-" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:6]


def _ts(iso_ts: Any) -> Optional[float]:
    try:
        return datetime.fromisoformat(str(iso_ts)).timestamp()
    except (TypeError, ValueError):
        return None


# ---------- 23. post-mortems ----------


def postmortem(job: Dict[str, Any], restarts: int = 0) -> Dict[str, Any]:
    slowed = []
    if (job.get("iteration") or 1) > 1:
        slowed.append(f"{job['iteration']} iterations")
    if restarts >= 2:
        slowed.append(f"{restarts} starts or restart attempts")
    if job.get("gate") == "failed":
        slowed.append("the startup gate failed")
    if job.get("followed_up_by") or job.get("lifecycle") == "resolved":
        slowed.append("it was blocked and needed a follow-up")
    sig = failure_signature(job.get("report_headline"))
    if sig and job.get("lifecycle") == "resolved":
        slowed.append(f"blocked by: {sig}")
    if job.get("duration_s") and job["duration_s"] > 90 * 60:
        slowed.append(f"a long run ({round(job['duration_s'] / 60)} min)")
    proof = job.get("proof")
    fixed = job.get("followed_up_by") or (f"{proof['kind']} {proof['text']}" if proof else "no proof recorded")
    return {
        "key": f"pm:{job['id']}|{job.get('followed_up_at') or job.get('report_at') or job.get('updated_at')}",
        "job": job["id"],
        "title": job.get("title"),
        "lifecycle": job.get("lifecycle"),
        "happened": job.get("report_headline") or job.get("result_preview") or "finished",
        "slowed": "; ".join(slowed) or "nothing notable",
        "fixed": fixed,
        "signature": sig,
    }


def postmortems(snapshot: Dict[str, Any], restarts: Dict[str, int]) -> List[Dict[str, Any]]:
    return [
        postmortem(j, restarts.get(j["id"], 0))
        for j in snapshot.get("folders", [])
        if j.get("lifecycle") in ("done", "resolved")
    ]


# ---------- 24. proposals ----------


def false_alerts(alerts: List[Dict[str, Any]], audit: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Alerts that cleared within 15 minutes: the Brain spoke too soon."""
    clears: Dict[str, List[float]] = {}
    for r in audit:
        if r.get("event") == "clear" and _ts(r.get("at")):
            clears.setdefault(r.get("job"), []).append(_ts(r["at"]))
    out = []
    for a in alerts:
        at = _ts(a.get("at"))
        if at is None:
            continue
        later = [c for c in clears.get(a.get("job"), []) if c >= at]
        if later and min(later) - at <= FALSE_ALERT_MIN * 60:
            out.append({**a, "cleared_after_min": round((min(later) - at) / 60, 1)})
    return out


def proposals(
    findings: List[Dict[str, Any]], alerts: List[Dict[str, Any]], audit: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    out = []
    for f in findings:
        if f.get("kind") == "repeated-failure":
            sig = f["signature"]
            out.append(
                {
                    "key": f"failure:{sig}",
                    "kind": "failure",
                    "signature": sig,
                    "title": f"Same failure {len(f['jobs'])} times: {sig}",
                    "evidence": f"jobs: {', '.join(f['jobs'])}",
                    "draft": f"Harness: handle '{sig}' before launch (check it in the startup gate); Brain: mark jobs "
                    f"blocked by it as a known issue with the fix, so MAC sees the fix, not a fresh alert.",
                    "effect": "known-issue",
                }
            )
    by_sig: Dict[str, List[Dict[str, Any]]] = {}
    for fa in false_alerts(alerts, audit):
        sig = failure_signature(fa.get("title") or "") or fa.get("state") or "unknown"
        by_sig.setdefault(sig, []).append(fa)
    for sig, items in by_sig.items():
        if len(items) >= 2:
            out.append(
                {
                    "key": f"false-alert:{sig}",
                    "kind": "false-alert",
                    "signature": sig,
                    "title": f"{len(items)} alerts on '{sig}' cleared within {FALSE_ALERT_MIN} min",
                    "evidence": f"jobs: {', '.join(sorted({i.get('job') or '?' for i in items}))}",
                    "draft": f"Brain: hold alerts on '{sig}' for {FALSE_ALERT_MIN} min and recheck before alerting.",
                    "effect": "grace",
                }
            )
    return out


def read_lesson_statuses(text: Optional[str]) -> Dict[str, Dict[str, str]]:
    out: Dict[str, Dict[str, str]] = {}
    current = None
    for m in LESSON_LINE_RE.finditer(text or ""):
        if m.group(1):
            current = m.group(1)
        elif current and m.group(2) and m.group(2).lower() in LESSON_STATUSES:
            out[current] = {"status": m.group(2).lower(), "note": m.group(3).strip(" -—:")}
    return out


def lessons_page(lessons: List[Dict[str, Any]]) -> str:
    lines = [
        "# Proposed lessons",
        "",
        "Drafted by Claude Brain from repeated failures and false alerts. Drafts only: nothing changes until",
        "Anthony or MAC changes a **Status:** line to `approved` (or `declined`). An approved lesson changes",
        "only the Brain's own alerting. MAC: copy approved lessons into ~/.vader-mac-runs/LESSONS.md.",
        "",
    ]
    for lesson in lessons:
        lines += [
            f"### {lesson['id']} · {lesson['kind']} · {lesson['title']}",
            "",
            f"- **Evidence:** {lesson.get('evidence')}",
            f"- **Draft rule:** {lesson.get('draft')}",
            f"- **Status:** {lesson['status']}{(' ' + lesson['note']) if lesson.get('note') else ''}",
            f"- **First proposed:** {lesson.get('at')}",
            "",
        ]
    return "\n".join(lines)


# ---------- 25. approved lessons, as data ----------


def apply_approved(snapshot: Dict[str, Any], approved: List[Dict[str, Any]]) -> None:
    """Known-issue lessons label matching blocked jobs. (Grace lessons are applied by the Recorder.)"""
    known = {lesson["signature"]: lesson for lesson in approved if lesson.get("effect") == "known-issue"}
    if not known:
        return
    for job in snapshot.get("folders", []) + snapshot.get("oneshots", []):
        sig = failure_signature(job.get("report_headline") or job.get("note"))
        if sig in known and job.get("lifecycle") in ("blocked", "stalled"):
            job["known_issue"] = f"{known[sig]['id']}: {known[sig]['draft']}"


def held_by_grace(
    item: Dict[str, Any], approved: List[Dict[str, Any]], now: float, since: Optional[str]
) -> Optional[str]:
    """An approved grace lesson holds a fresh alert on its signature for 15 minutes."""
    sig = failure_signature(f"{item.get('title') or ''} {item.get('detail') or ''}") or item.get("state")
    for lesson in approved:
        if lesson.get("effect") == "grace" and lesson.get("signature") == sig:
            started = _ts(since)
            if started is not None and now - started < FALSE_ALERT_MIN * 60:
                return lesson["id"]
    return None


# ---------- 26. weekly stats ----------


def weekly_stats(alerts: List[Dict[str, Any]], audit: List[Dict[str, Any]], now: datetime) -> Dict[str, Any]:
    start = (now - timedelta(days=7)).timestamp()
    week = [a for a in alerts if (_ts(a.get("at")) or 0) >= start]
    seen: Dict[tuple, int] = {}
    for a in week:
        seen[(a.get("job"), a.get("state"))] = seen.get((a.get("job"), a.get("state")), 0) + 1
    clears = [r for r in audit if r.get("event") == "clear" and (_ts(r.get("at")) or 0) >= start]
    times = []
    for a in week:
        at = _ts(a.get("at"))
        later = [_ts(c["at"]) for c in clears if c.get("job") == a.get("job") and (_ts(c["at"]) or 0) >= (at or 0)]
        if at and later:
            times.append((min(later) - at) / 60)
    return {
        "alerts": len(week),
        "false_alerts": len([f for f in false_alerts(week, audit)]),
        "duplicates": sum(n - 1 for n in seen.values() if n > 1),
        "median_clear_min": round(statistics.median(times)) if times else None,
    }
