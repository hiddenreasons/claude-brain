"""What the Brain records after each refresh, in its own folder only (brainfiles.py).

Part 1: one alert per job state (job, state, report time); clears; settled decisions; placeholder bugs.
Each goes to the append-only audit trail exactly once, even across restarts.
"""

from __future__ import annotations

import hashlib
import logging
import time
from datetime import datetime
from typing import Any, Dict, List

from .advisor import Advisor, sample_flow
from .brainfiles import BrainFiles, Ledger, audit
from .learning import (
    apply_approved,
    held_by_grace,
    lesson_id,
    lessons_page,
    postmortems,
    proposals,
    read_lesson_statuses,
    weekly_stats,
)

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
        self.advisor = Advisor(files)
        self.recommendations: List[Dict[str, Any]] = []
        self.alerts = Ledger(files, "alerts.jsonl")
        self.seen = Ledger(files, "audit.jsonl", key="key")
        self.postmortems = Ledger(files, "learning.jsonl", key="key")
        self.lessons = Ledger(files, "lessons.jsonl", key="id")
        self.learning: Dict[str, Any] = {}

    def _lessons(self) -> List[Dict[str, Any]]:
        """Every proposed lesson (append-only log) with the status Anthony or MAC set on the page."""
        statuses = read_lesson_statuses(self.files.read("PROPOSED-LESSONS.md"))
        out = []
        for r in self.files.records("lessons.jsonl"):
            st = statuses.get(r["id"], {"status": "proposed", "note": ""})
            out.append({**r, **st})
        rank = {"proposed": 0, "approved": 1, "declined": 2}
        out.sort(key=lambda lesson: (rank.get(lesson["status"], 9), lesson.get("at") or ""))
        return out

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
        # Approved lessons only (drafts change nothing): known-issue notes, and holds on self-clearing alerts.
        approved = [lesson for lesson in self._lessons() if lesson["status"] == "approved"]
        apply_approved(snapshot, approved)
        for item in snapshot.get("attention", []):
            key = alert_key(item, jobs)
            source_job = jobs.get(f"{item.get('kind')}:{item['id']}", {})
            held = held_by_grace(
                item, approved, time.time(), source_job.get("report_at") or source_job.get("updated_at")
            )
            if held:
                item["held_by"] = held
                continue
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
        for item in snapshot.get("mac_attention", []):
            key = f"mac:{item['source']}:{item['id']}|{item['state']}|{item.get('at') or ''}"
            if self.alerts.add(key, {"job": item["id"], "state": item["state"], "title": item["title"], "for": "MAC"}):
                audit(
                    self.files, "alert", item["id"], f"for MAC: {item['title']}: {item['detail']}"[:300], "Brain -> MAC"
                )
                counts["alerts"] += 1
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
        # Part 4: recommendations for MAC (recommend, never act), the hourly flow sample, MAC's status edits.
        now = datetime.now().astimezone()
        findings = (snapshot.get("flow") or {}).get("findings", [])
        counts["recommendations"] = self.advisor.record(findings)
        sample_flow(self.files, (snapshot.get("flow") or {}).get("machines", {}), findings, now)
        recs = self.advisor.recommendations(now)
        for r in recs:
            if r["status"] != "open":
                self._once(
                    f"rec-status:{r['id']}|{r['status']}",
                    "recommendation",
                    r["id"],
                    f"status {r['status']} {r.get('note') or ''}".strip(),
                    "MAC",
                )
        self.advisor.write_page(recs)
        self.recommendations = recs
        # Part 5: post-mortems, proposed lessons (drafts), weekly stats.
        restarts = {st["id"]: st["count"] for st in (snapshot.get("ops") or {}).get("storms", [])}
        for pm in postmortems(snapshot, restarts):
            if self.postmortems.add(pm["key"], {"kind": "postmortem", **{k: v for k, v in pm.items() if k != "key"}}):
                counts["postmortems"] = counts.get("postmortems", 0) + 1
        alerts_log, audit_log = self.files.records("alerts.jsonl"), self.files.records("audit.jsonl")
        for prop in proposals(findings, alerts_log, audit_log):
            lid = lesson_id(prop["key"])
            if self.lessons.add(lid, prop):
                audit(self.files, "proposal", lid, f"proposed lesson: {prop['title']}"[:300])
                counts["proposals"] = counts.get("proposals", 0) + 1
        lessons = self._lessons()
        for lesson in lessons:
            if lesson["status"] != "proposed":
                self._once(
                    f"lesson-status:{lesson['id']}|{lesson['status']}",
                    "lesson",
                    lesson["id"],
                    f"{lesson['status']}: {lesson['title']}"[:300],
                    "Anthony / MAC",
                )
        self.files.write("PROPOSED-LESSONS.md", lessons_page(lessons))
        self.files.write("LEARNING-LOG.md", learning_log_page(self.files.records("learning.jsonl")))
        snapshot["learning"] = self.learning = {
            "proposed": [lsn for lsn in lessons if lsn["status"] == "proposed"],
            "approved": [lsn for lsn in lessons if lsn["status"] == "approved"],
            "weekly": weekly_stats(alerts_log, audit_log, now),
            "recent_postmortems": [r for r in self.files.records("learning.jsonl") if r.get("kind") == "postmortem"][
                -8:
            ][::-1],
        }
        year, week, _ = now.isocalendar()
        self.files.write(
            f"weekly-{year}-W{week:02d}.md", weekly_text(recs, snapshot.get("learning") or {}, f"{year}-W{week:02d}")
        )
        day = now.date().isoformat()
        if self.files.write(f"digest-{day}.md", digest_text(snapshot, day)):
            counts["digest"] = 1
        return counts


def digest_text(snapshot: Dict[str, Any], day: str) -> str:
    """End-of-day summary: done / blocked / waiting on Anthony / lessons proposed (rewritten through the day)."""
    jobs = snapshot.get("folders", []) + snapshot.get("oneshots", [])

    def on_day(iso_ts: Any) -> bool:
        if not iso_ts:
            return False
        try:
            return datetime.fromisoformat(str(iso_ts)).astimezone().date().isoformat() == day
        except ValueError:
            return False

    done = [j for j in jobs if j.get("lifecycle") in ("done", "resolved") and on_day(j.get("updated_at"))]
    blocked = [
        j
        for j in jobs + snapshot.get("remote_jobs", [])
        if j.get("lifecycle") in ("blocked", "stalled") and on_day(j.get("updated_at") or j.get("last_at"))
    ]
    waiting = [i for i in jobs + snapshot.get("inbox", []) if i.get("up_next") == "Anthony"]
    decisions = [d for d in (snapshot.get("status") or {}).get("decision_items", []) if d.get("up_next") == "Anthony"]
    lessons = (snapshot.get("learning") or {}).get("proposed", [])
    codex = (snapshot.get("codex") or {}).get("today", {})

    def name(i: Dict[str, Any]) -> str:
        title = str(i.get("title") or "")
        return title if title.lower().startswith(str(i["id"]).lower()) else f"{i['id']}: {title}".rstrip(": ")

    def proof(j: Dict[str, Any]) -> str:
        p = j.get("proof")
        return f"{p['kind']} {p['text']}" if p else "UNVERIFIED"

    lines = [
        f"# Claude Brain digest, {day}",
        "",
        "Written by Claude Brain (read-only view of MAC and Claude). Updated through the day.",
        "",
    ]
    lines += [f"## Done ({len(done)})", ""] + [f"- {name(j)} ({proof(j)})" for j in done] + [""]
    lines += [f"## Blocked or stalled ({len(blocked)})", ""]
    lines += [
        f"- {j['id']}: {j.get('lifecycle_why') or j.get('report_headline') or j.get('state')}" for j in blocked
    ] + [""]
    lines += [f"## Waiting on Anthony ({len(waiting) + len(decisions)})", ""]
    lines += [f"- {name(i)}" for i in waiting] + [f"- decision: {d['text'][:200]}" for d in decisions] + [""]
    lines += [
        "## Codex today",
        "",
        f"- {codex.get('done', 0)} picture jobs done, {codex.get('pictures', 0)} pictures",
        "",
    ]
    lines += [f"## Lessons proposed ({len(lessons)})", ""] + [f"- {lesson['title']}" for lesson in lessons] + [""]
    return "\n".join(lines)


def learning_log_page(records: List[Dict[str, Any]]) -> str:
    """Post-mortems, newest first (every one kept; the log is append-only)."""
    lines = ["# Learning log", "", "Short post-mortems Claude Brain writes after each job resolves.", ""]
    for r in [r for r in records if r.get("kind") == "postmortem"][::-1][:300]:
        lines += [
            f"## {r.get('job')} · {r.get('lifecycle')} · {r.get('at')}",
            "",
            f"- **What happened:** {r.get('happened')}",
            f"- **What slowed it:** {r.get('slowed')}",
            f"- **What fixed it:** {r.get('fixed')}",
            "",
        ]
    return "\n".join(lines)


def weekly_text(recs: List[Dict[str, Any]], learning: Dict[str, Any], week: str) -> str:
    """Weekly report: did the recommendations MAC applied help, and how the Brain's own alerts are doing."""
    applied = [r for r in recs if r["status"] == "applied"]
    lines = [
        f"# Claude Brain weekly report, {week}",
        "",
        "Written by Claude Brain. It only reports; nothing was changed.",
        "",
    ]
    lines += [f"## Applied recommendations ({len(applied)})", ""]
    for r in applied:
        res = r.get("result") or {}
        lines.append(
            f"- {r['id']} {r.get('what')}: **{res.get('verdict', 'not judged')}** "
            f"(before {res.get('before')}, after {res.get('after')})"
        )
    if not applied:
        lines.append("- none applied yet")
    counts = {s: sum(1 for r in recs if r["status"] == s) for s in ("open", "deferred", "declined")}
    lines += ["", f"Open {counts['open']} · deferred {counts['deferred']} · declined {counts['declined']}", ""]
    stats = learning.get("weekly") or {}
    lines += ["## The Brain's own alerts this week", ""]
    lines += [
        f"- alerts: {stats.get('alerts', 0)}",
        f"- false alerts (cleared within 15 min): {stats.get('false_alerts', 0)}",
        f"- duplicate alerts stopped: {stats.get('duplicates', 0)}",
        f"- median time to clear: {stats.get('median_clear_min', '—')} min",
        "",
    ]
    return "\n".join(lines)


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
