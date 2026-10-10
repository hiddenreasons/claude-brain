"""Guardrails: rules that keep the Brain from showing or drafting something wrong.

- No empty templates: a {{PLACEHOLDER}} never reaches a title or a drafted message.
- Only ask Anthony when needed: "confirm done" items go to MAC (VADER c3); approvals point to VADER Approvals.
- Decisions: which are settled, which are open, and the A-xxx IDs they cite.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}\}")
# "Confirm wofix is done", "MAC to confirm it landed", "verify it's done": a check MAC can make itself.
CONFIRM_DONE_RE = re.compile(
    r"\bconfirm(?:s|ed|ing)?\b[^.;]{0,50}\b(?:done|complete[sd]?|finished|landed|merged|committed|in place|live)\b"
    r"|\bverify\b[^.;]{0,30}\b(?:done|landed|merged|committed)\b",
    re.I,
)
APPROVAL_RE = re.compile(
    r"\b(?:approv\w*|sign[- ]?off|go/no-go|ok to|okay to|decide|decision|choose|pick one|option [a-c])\b", re.I
)
SETTLED_RE = re.compile(r"^~~[\s\S]+?~~\s*(DONE|DECIDED|APPROVED|DROPPED|RESOLVED|MERGED|CANCELLED|CANCELED)\b", re.I)
DECISION_ID_RE = re.compile(r"\bA-\d{3}\b")
MAC_ROUTE = "MAC (VADER c3)"
APPROVALS = "VADER Approvals"


def placeholders(text: Optional[str]) -> List[str]:
    """Names of unfilled {{PLACEHOLDERS}} in a text, in order, without repeats."""
    seen: List[str] = []
    for m in PLACEHOLDER_RE.finditer(text or ""):
        if m.group(1) not in seen:
            seen.append(m.group(1))
    return seen


# Launch tokens: briefs carry them on purpose; run-template.sh fills them into <job>/iter-N.prompt at launch.
HARNESS_TOKENS = ("STATUS_SHA12", "STATUS_SHA256", "STATUS_MD")


def unfilled(brief: Optional[str], prompt: Optional[str] = None) -> List[str]:
    """Real template bugs: placeholders in the brief other than the launch tokens, and any placeholder
    still left in the prompt Claude was actually sent (the latest iter-N.prompt)."""
    out = [n for n in placeholders(brief) if n not in HARNESS_TOKENS]
    return out + [n for n in placeholders(prompt) if n not in out]


def is_confirm_done(text: Optional[str]) -> bool:
    return bool(CONFIRM_DONE_RE.search(text or ""))


def decision_item(text: str) -> Dict[str, Any]:
    """One line of "Open decisions awaiting Anthony": settled or open, and who it is really for."""
    settled = SETTLED_RE.match(text.strip())
    if settled:
        return {
            "text": text,
            "settled": True,
            "word": settled.group(1).upper(),
            "route": None,
            "via": None,
            "ids": DECISION_ID_RE.findall(text),
        }
    if is_confirm_done(text):
        # A "confirm it's done" check is MAC's to make, never Anthony's.
        return {
            "text": text,
            "settled": False,
            "word": "MAC TO CONFIRM",
            "route": "mac",
            "via": MAC_ROUTE,
            "ids": DECISION_ID_RE.findall(text),
        }
    via = APPROVALS if APPROVAL_RE.search(text) else None
    return {
        "text": text,
        "settled": False,
        "word": "NEEDS YOU",
        "route": "anthony",
        "via": via,
        "ids": DECISION_ID_RE.findall(text),
    }
