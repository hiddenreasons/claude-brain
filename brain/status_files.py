"""Parse MAC's STATUS.md (decisions waiting on Anthony, change log) and ISSUES-LOG.md."""

from __future__ import annotations

import re
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


def parse_status(text: Optional[str]) -> Dict[str, Any]:
    if not text:
        return {"decisions": [], "changelog": [], "running_note": None}
    sections = _sections(text)
    running_lines = [ln for ln in _find(sections, "running") if ln.strip()]
    return {
        "decisions": [clip(b, 600) for b in _top_bullets(_find(sections, "decision"))],
        "changelog": [clip(b, 600) for b in _top_bullets(_find(sections, "change log"))][-15:][::-1],
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
