"""Parse VADER's docs/CLAUDE INBOX.md: MAC's work orders and the TO MAC / FROM MAC replies."""

from __future__ import annotations

import hashlib
import re
from typing import Any, Dict, List, Optional

from .readers import clip

# "## OPEN — 2026-10-07 · WO from MAC #022 - Home ..."
# "## PARKED (FIRST AFTER BUTTON-UP) - 2026-10-07 · WO from MAC #020 - ..."
# "## 2026-10-06 · Short 29 rendered final ..."
HEADER_RE = re.compile(
    r"^##\s+(?:(?P<status>[A-Z][A-Z0-9 ()/,'-]*?)\s+[—–-]\s+)?"
    r"(?P<date>\d{4}-\d{2}-\d{2})\s*·\s*(?P<title>.+?)\s*$"
)
WO_RE = re.compile(r"WO from MAC\s*#\s*(\d+)", re.IGNORECASE)
STATUS_LINE_RE = re.compile(r"^\*\*Status:\*\*\s*(.*)$")
FROM_LINE_RE = re.compile(r"^\*\*From(?::\*\*|\s)\s*(.*)$")
REPLY_RE = re.compile(r"^\s*(?:[-*]\s+)?(?P<dir>TO MAC|FROM MAC)\b\s*(?P<text>.*)$")

STATES = ("BLOCKED", "RUNNING", "OPEN", "PARKED", "DONE")
BODY_LIMIT = 4000


def _state_word(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    upper = text.strip().upper()
    if upper.startswith("UNBLOCKED"):
        return "OPEN"
    for word in STATES:
        if upper.startswith(word):
            return word
    return None


def derive_state(header_status: Optional[str], status_text: Optional[str], replies: List[dict]) -> str:
    """The header's status wins (MAC keeps it current); the Status line fills in when it's missing.

    A last reply of "TO MAC: BLOCKED" always means the entry is stuck waiting on MAC.
    """
    if replies and replies[-1]["direction"] == "to_mac" and replies[-1]["blocked"]:
        return "BLOCKED"
    if _state_word(status_text) == "BLOCKED":
        return "BLOCKED"
    return _state_word(header_status) or _state_word(status_text) or "NOTE"


def _entry_id(header: str, repeat: int) -> str:
    """Stable across edits elsewhere in the file: based on the header text, not its position."""
    digest = hashlib.sha1(header.strip().encode("utf-8")).hexdigest()[:12]
    return f"wo-{digest}" if repeat == 0 else f"wo-{digest}-{repeat}"


def parse_inbox(text: str) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    body: List[str] = []
    header_counts: Dict[str, int] = {}

    def finish() -> None:
        if current is None:
            return
        raw = "\n".join(body).strip()
        current["body"] = clip(raw, BODY_LIMIT)
        current["body_truncated"] = len(raw) > BODY_LIMIT
        current["state"] = derive_state(current["header_status"], current["status_text"], current["replies"])
        current["needs_attention"] = current["state"] == "BLOCKED"
        entries.append(current)

    for line_no, line in enumerate(text.splitlines(), start=1):
        if line.startswith("## "):
            finish()
            body = []
            match = HEADER_RE.match(line)
            title = match.group("title") if match else line[3:].strip()
            wo = WO_RE.search(title)
            # Leave the status word out of the id, so OPEN -> DONE is the same entry, changed.
            identity = f"{match.group('date')}|{title}" if match else line.strip()
            repeat = header_counts.get(identity, 0)
            header_counts[identity] = repeat + 1
            current = {
                "id": _entry_id(identity, repeat),
                "line": line_no,
                "header_status": (match.group("status").strip() if match and match.group("status") else None),
                "date": match.group("date") if match else None,
                "title": title,
                "wo": int(wo.group(1)) if wo else None,
                "from": None,
                "status_text": None,
                "replies": [],
            }
            continue
        if current is None:
            continue
        body.append(line)
        stripped = line.strip()
        if current["from"] is None:
            from_match = FROM_LINE_RE.match(stripped)
            if from_match:
                who = from_match.group(1).split(".")[0].strip(" *")
                current["from"] = "MAC" if "MAC" in stripped[:20] else clip(who, 80)
        if current["status_text"] is None:
            status_match = STATUS_LINE_RE.match(stripped)
            if status_match:
                current["status_text"] = clip(status_match.group(1).strip(), 400)
        reply = REPLY_RE.match(line)
        if reply:
            direction = "to_mac" if reply.group("dir") == "TO MAC" else "from_mac"
            reply_text = reply.group("text").lstrip(":( ").strip()
            current["replies"].append(
                {
                    "direction": direction,
                    "text": clip(reply_text, 1200),
                    "blocked": direction == "to_mac" and reply_text.upper().startswith("BLOCKED"),
                }
            )
    finish()
    return entries
