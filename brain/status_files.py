"""Parse MAC's STATUS.md (decisions waiting on Anthony, change log) and ISSUES-LOG.md."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .readers import clip

SECTION_RE = re.compile(r"^##\s+(?:\d+\.\s*)?(?P<title>.+?)\s*$")
TABLE_ROW_RE = re.compile(r"^\|\s*(?P<date>\d{4}-\d{2}-\d{2}[^|]*)\|(?P<rest>.*)\|\s*$")
# "## 2026-10-08 22:44 ET: Claude bypassed its sandbox" (the time has its own colon)
ISSUE_HEADING_RE = re.compile(
    r"^##\s+(?P<date>\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?(?:\s+[A-Z]{2,4})?):\s*(?P<title>.+)$"
)


def _sections(text: str) -> Dict[str, List[str]]:
    sections: Dict[str, List[str]] = {}
    current: Optional[str] = None
    for line in text.splitlines():
        match = SECTION_RE.match(line)
        if match and line.startswith("## "):
            current = match.group("title").lower()
            sections[current] = []
        elif current is not None:
            sections[current].append(line)
    return sections


def _top_bullets(lines: List[str]) -> List[str]:
    """Top-level "- " bullets, with their indented sub-bullets folded in."""
    bullets: List[str] = []
    for line in lines:
        if line.startswith("- "):
            bullets.append(line[2:].strip())
        elif bullets and line.startswith((" ", "\t")) and line.strip():
            bullets[-1] += " " + line.strip()
    return bullets


def _find(sections: Dict[str, List[str]], *needles: str) -> List[str]:
    for title, lines in sections.items():
        if all(n in title for n in needles):
            return lines
    return []


# "2026-10-09 13:21 VADER c3: ..." or "2026-10-08 21:53 ET — ..." (MAC writes local Mac time)
ENTRY_TIME_RE = re.compile(r"^(?P<day>\d{4}-\d{2}-\d{2})\s+(?P<time>\d{1,2}:\d{2})")


def entry_time(text: str) -> Optional[str]:
    """UTC ISO time of a change-log entry, from its leading local timestamp."""
    match = ENTRY_TIME_RE.match(text)
    if not match:
        return None
    try:
        local = datetime.strptime(f"{match.group('day')} {match.group('time')}", "%Y-%m-%d %H:%M").astimezone()
    except ValueError:
        return None
    return local.astimezone(timezone.utc).isoformat(timespec="seconds")


def _change_log(sections: Dict[str, List[str]]) -> List[str]:
    """The change log's bullets, plus dated bullets MAC appends below later headings.

    MAC keeps adding "- 2026-10-09 14:57 VADER c3: ..." lines at the end of the file, which can fall
    under a newer section such as "Decision log (IDs)". Those count; that section's own "- A-001 ..."
    lines don't start with a date, so they stay out.
    """
    log: List[str] = []
    seen = False
    for title, lines in sections.items():
        if "change log" in title and not seen:
            seen = True
            log.extend(_top_bullets(lines))
        elif seen:
            log.extend(b for b in _top_bullets(lines) if ENTRY_TIME_RE.match(b))
    return log


def parse_status(text: Optional[str]) -> Dict[str, Any]:
    if not text:
        return {"decisions": [], "changelog": [], "entries": [], "running_note": None}
    sections = _sections(text)
    running_lines = [ln for ln in _find(sections, "running") if ln.strip()]
    log = _change_log(sections)
    return {
        "decisions": [clip(b, 600) for b in _top_bullets(_find(sections, "decision"))],
        "changelog": [clip(b, 600) for b in log][-15:][::-1],
        # Every timed entry, for matching follow-ups to jobs (not sent to the page).
        "entries": [{"at": entry_time(b), "text": b} for b in log if entry_time(b)],
        "running_note": clip(" ".join(running_lines[:2]).strip(), 500) or None,
    }


def parse_issues(text: Optional[str], limit: int = 12) -> List[Dict[str, Any]]:
    if not text:
        return []
    issues: List[Dict[str, Any]] = []
    for line in text.splitlines():
        row = TABLE_ROW_RE.match(line)
        if row:
            cells = [c.strip() for c in row.group("rest").split("|")]
            issues.append(
                {
                    "date": row.group("date").strip(),
                    "job": cells[0] if cells else "",
                    "what": clip(cells[1] if len(cells) > 1 else "", 500),
                    "prevented": (cells[-1].lower() if cells else ""),
                }
            )
            continue
        heading = ISSUE_HEADING_RE.match(line)
        if heading:
            issues.append(
                {
                    "date": heading.group("date").strip(),
                    "job": "",
                    "what": clip(heading.group("title"), 500),
                    "prevented": "",
                }
            )
    issues.sort(key=lambda i: i["date"], reverse=True)
    return issues[:limit]
