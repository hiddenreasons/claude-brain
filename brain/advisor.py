"""Advisor for MAC: recommend, never act.

Each new finding (flow.py) becomes one recommendation, logged once in recommendations.jsonl and written to
~/.vader-mac-runs/brain/RECOMMENDATIONS.md: what, why, expected gain, the recommended option, and a
Status line MAC edits (open / applied / declined / deferred). The Brain rewrites the page keeping MAC's
statuses. For applied ones it compares the finding's measure before and after, and reports that weekly.
Flow samples (flow.jsonl, at most one an hour) give it the before and after.
"""

from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from .brainfiles import BrainFiles, Ledger

STATUSES = ("open", "applied", "declined", "deferred")
STATUS_LINE_RE = re.compile(r"^###\s+(R-[0-9a-f]{6})\b.*?$|^-\s*\*\*Status:\*\*\s*(\w+)(.*)$", re.M)
MIN_DAYS = 2  # need this much data on each side before calling it


def rec_id(key: str) -> str:
    return "R-" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:6]


def read_statuses(text: Optional[str]) -> Dict[str, Dict[str, str]]:
    """MAC's edits: the Status line under each "### R-xxxxxx" heading."""
    out: Dict[str, Dict[str, str]] = {}
    current = None
    for m in STATUS_LINE_RE.finditer(text or ""):
        if m.group(1):
            current = m.group(1)
        elif current and m.group(2):
            word = m.group(2).lower()
            if word in STATUSES:
                out[current] = {"status": word, "note": m.group(3).strip(" -—:")}
    return out


def sample_flow(files: BrainFiles, flow: Dict[str, Any], findings: List[Dict[str, Any]], now: datetime) -> bool:
    """One flow sample an hour (append-only): the measures recommendations are judged by."""
    hour = now.strftime("%Y-%m-%dT%H")
    ledger = Ledger(files, "flow.jsonl", key="hour")
    mac = flow.get("MAC", {})
    measures: Dict[str, float] = {}
    for f in findings:
        if f["metric"] == "idle_with_queue_min":
            value = (mac.get("idle_min") or 0) if f["machine"] == "MAC" else 15
        else:
            value = len(f.get("jobs") or []) or 1
        measures[f["metric"]] = measures.get(f["metric"], 0) + value
    return ledger.add(hour, {"mac": mac, "windows": flow.get("WINDOWS", {}), "measures": measures})


def _measure(samples: List[Dict[str, Any]], metric: str, start: datetime, end: datetime) -> Optional[float]:
    vals = []
    for s in samples:
        try:
            at = datetime.fromisoformat(s["at"])
        except (KeyError, ValueError):
            continue
        if start <= at < end:
            vals.append(float((s.get("measures") or {}).get(metric) or 0))
    return round(sum(vals) / len(vals), 2) if vals else None


def judge(rec: Dict[str, Any], applied_at: datetime, samples: List[Dict[str, Any]], now: datetime) -> Dict[str, Any]:
    """Did an applied recommendation help? Average of its measure before vs after (lower is better)."""
    span = timedelta(days=7)
    if now - applied_at < timedelta(days=MIN_DAYS):
        return {"verdict": "too early", "before": None, "after": None}
    before = _measure(samples, rec["metric"], applied_at - span, applied_at)
    after = _measure(samples, rec["metric"], applied_at, now)
    if before is None or after is None:
        return {"verdict": "not enough data", "before": before, "after": after}
    verdict = "helped" if after < before * 0.8 else "worse" if after > before * 1.2 else "no clear change"
    return {"verdict": verdict, "before": before, "after": after}


class Advisor:
    def __init__(self, files: BrainFiles) -> None:
        self.files = files
        self.ledger = Ledger(files, "recommendations.jsonl", key="id")

    def record(self, findings: List[Dict[str, Any]]) -> int:
        new = 0
        for f in findings:
            if self.ledger.add(
                rec_id(f["key"]),
                {k: f.get(k) for k in ("key", "kind", "machine", "what", "why", "gain", "option", "impact", "metric")},
            ):
                new += 1
        return new

    def recommendations(self, now: datetime) -> List[Dict[str, Any]]:
        statuses = read_statuses(self.files.read("RECOMMENDATIONS.md"))
        samples = self.files.records("flow.jsonl")
        out = []
        for r in self.files.records("recommendations.jsonl"):
            st = statuses.get(r["id"], {"status": "open", "note": ""})
            rec = {**r, **st}
            if st["status"] == "applied":
                applied = _applied_date(st.get("note")) or _first_status_seen(self.files, r["id"]) or now
                rec["result"] = judge(rec, applied, samples, now)
            out.append(rec)
        rank = {"open": 0, "deferred": 1, "applied": 2, "declined": 3}
        out.sort(key=lambda r: (rank.get(r["status"], 9), -(r.get("impact") or 0), -_epoch(r.get("at") or "")))
        return out

    def write_page(self, recs: List[Dict[str, Any]]) -> bool:
        lines = [
            "# Recommendations for MAC",
            "",
            "Written by Claude Brain, which only recommends; nothing here has been done.",
            "Ranked by impact, newest first.",
            "MAC: change a **Status:** line to `applied`, `declined` or `deferred` (add a date for applied, e.g.",
            "`applied 2026-10-10`). The Brain keeps your edits and reports weekly whether applied ones helped.",
            "",
        ]
        for r in recs:
            lines += [
                f"### {r['id']} · {r.get('kind')} · {r.get('machine')} · impact {r.get('impact')}",
                "",
                f"- **What:** {r.get('what')}",
                f"- **Why:** {r.get('why')}",
                f"- **Expected gain:** {r.get('gain')}",
                f"- **Recommended option:** {r.get('option')}",
                f"- **Status:** {r['status']}{(' ' + r['note']) if r.get('note') else ''}",
                f"- **First seen:** {r.get('at')}",
            ]
            if r.get("result"):
                res = r["result"]
                lines.append(f"- **Did it help?** {res['verdict']} (before {res['before']}, after {res['after']})")
            lines.append("")
        return self.files.write("RECOMMENDATIONS.md", "\n".join(lines))


def _epoch(iso_ts: str) -> float:
    try:
        return datetime.fromisoformat(iso_ts).timestamp()
    except ValueError:
        return 0.0


def _applied_date(note: Optional[str]) -> Optional[datetime]:
    m = re.search(r"\d{4}-\d{2}-\d{2}", note or "")
    return datetime.fromisoformat(m.group(0)).astimezone() if m else None


def _first_status_seen(files: BrainFiles, rid: str) -> Optional[datetime]:
    for r in files.records("audit.jsonl"):
        if r.get("event") == "recommendation" and r.get("job") == rid and "applied" in str(r.get("change")):
            try:
                return datetime.fromisoformat(r["at"])
            except (KeyError, ValueError):
                return None
    return None
