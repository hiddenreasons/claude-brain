"""One action label per job and work order, so Anthony can see at a glance what to do.

needs_anthony: a real problem or an owner decision. Only these get a "Copy fix request" button.
in_progress:   someone is on it right now (running job, RUNNING work order).
queued:        waiting its turn (OPEN or PARKED work order, prepared job).
done:          done, cleared by MAC, or MAC is handling it. Shown in a collapsed Done section.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional

from .readers import clip

ALERT_STATES = {"blocked", "stalled", "gate_failed", "no_report", "error"}
ACTION_ORDER = {"needs_anthony": 0, "in_progress": 1, "queued": 2, "done": 3}

# Wording that means the item is waiting on Anthony himself.
OWNER_WAIT_RE = re.compile(
    r"\bwait(?:s|ing)? on\b[^.;]{0,30}\b(?:owner|anthony)\b"
    r"|\bawaiting (?:the )?(?:owner|anthony)\b"
    r"|\b(?:owner|anthony) (?:judges|decides|to decide|to approve|approval|ok|oks|review)\b"
    r"|\bfor the owner\b"
    r"|\bneeds? (?:the )?(?:owner|anthony)(?:'s)? (?:ok|okay|approval|decision|review)\b",
    re.I,
)
# Wording that says what an item is queued behind (checked on the Status line and "Queue order:" only).
BEHIND_RES = [
    re.compile(r"\b(?:runs?|starts?)\s+(?:only\s+|right\s+)?after\s+([^.;\n,(]+)", re.I),
    re.compile(r"\buntil after\s+([^.;\n]+)", re.I),
    re.compile(r"\bafter\s+(WO\s*#\s*\d+|#\d+)", re.I),
    re.compile(r"\buntil\s+([^.;\n(]+)", re.I),
]
QUEUE_ORDER_RE = re.compile(r"\bqueue order:\s*([^.\n]+)", re.I)
# "until Anthony approves the list" waits on Anthony; "until after the dashboard finish, Anthony's
# review and the button-up" is a parked item waiting its turn.
OWNER_FIRST_RE = re.compile(r"^(?:the\s+)?(?:owner|anthony)\b", re.I)
SELF_RE = re.compile(r"\s*(?:this|it|that)\b", re.I)
WHO_RE = re.compile(r"\b(Claude Eng|Claude|Codex|VV2|MAC|Grok Bot)\b")


def label(
    action: str, note: Optional[str] = None, who: Optional[str] = None, at: Optional[str] = None
) -> Dict[str, Any]:
    return {"action": action, "action_note": note, "action_who": who, "action_at": at}


def job_action(job: Dict[str, Any]) -> Dict[str, Any]:
    state = job["state"]
    if state in ALERT_STATES:
        why = job.get("note") or job.get("report_headline") or state.replace("_", " ")
        return label("needs_anthony", clip(why, 160))
    if state in ("running", "waiting"):
        if job.get("kind") == "folder":
            who = (
                "Claude · " + " ".join(x for x in (job.get("model"), job.get("effort")) if x)
                if job.get("model")
                else "Claude"
            )
            return label("in_progress", None, who, job.get("stream_updated_at"))
        return label("in_progress", "sent, no result yet", "Claude (one-shot)", job.get("sent_at"))
    if state == "prepared":
        return label("queued", "brief ready, no Claude run yet")
    return label("done")  # done, cleared, followed_up


def waiting_behind(entry: Dict[str, Any]) -> Optional[str]:
    """What the inbox says this is waiting for: from its Status line, else its "Queue order:" line."""
    queue = QUEUE_ORDER_RE.search((entry.get("body") or "")[:800])
    for text in (entry.get("status_text") or "", queue.group(1) if queue else ""):
        for pattern in BEHIND_RES:
            for match in pattern.finditer(text):
                # "VV2 waits until this is done" is someone waiting on this item, not what it's behind.
                if not SELF_RE.match(match.group(1)):
                    return clip(match.group(1).strip(" ,-—–)"), 90)
    return clip(queue.group(1).strip(), 90) if queue else None


def order_action(entry: Dict[str, Any]) -> Dict[str, Any]:
    state = entry["state"]
    if state == "BLOCKED":
        last = entry["replies"][-1]["text"] if entry.get("replies") else entry.get("status_text")
        return label("needs_anthony", clip(last, 160))
    if state in ("DONE", "NOTE"):
        return label("done")
    behind = waiting_behind(entry)
    owner_text = f"{entry.get('title', '')} {entry.get('status_text') or ''}"
    owner = OWNER_WAIT_RE.search(owner_text)
    if behind and OWNER_FIRST_RE.search(behind):
        return label("needs_anthony", f"waiting on Anthony: {behind}")
    # Other owner wording counts unless the item is still queued behind other work first.
    if owner and not (behind and state != "RUNNING"):
        return label("needs_anthony", f"waiting on Anthony: {clip(owner.group(0), 60)}")
    if state == "RUNNING":
        who = WHO_RE.search(entry.get("status_text") or "")
        return label("in_progress", clip(entry.get("status_text"), 120), who.group(1) if who else None)
    return label(
        "queued", f"after {behind}" if behind and not behind.lower().startswith(("after", "until")) else behind
    )


def sort_key(item: Dict[str, Any]) -> tuple:
    return (ACTION_ORDER.get(item.get("action"), 9),)
