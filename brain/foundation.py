"""Foundation: one lifecycle, proof, who's up next, and drift, for every job and work order.

- One source of truth: state comes only from STATUS.md, REPORT.md (with the final reply) and git, read
  fresh on every refresh. The Brain keeps no state of its own; its files are logs. When two sources
  disagree the item gets a DRIFT flag that says which.
- Same lifecycle everywhere, MAC and WINDOWS: queued → running → done / blocked / stalled → resolved.
  Resolved needs proof from STATUS.md or a commit; anything less stays blocked and says why.
- Who's up next on every item: Anthony, MAC, Claude, Codex or Windows.
- Proof on every DONE: a commit, a test result or a file path, or it reads "unverified".
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from .readers import clip

LIFECYCLE = ("queued", "running", "done", "blocked", "stalled", "resolved")
JOB_LIFECYCLE = {
    "prepared": "queued",
    "running": "running",
    "waiting": "running",
    "done": "done",
    "blocked": "blocked",
    "error": "blocked",
    "gate_failed": "blocked",
    "no_report": "blocked",
    "followed_up": "blocked",
    "stalled": "stalled",
    "cleared": "resolved",
}
ORDER_LIFECYCLE = {
    "OPEN": "queued",
    "PARKED": "queued",
    "RUNNING": "running",
    "DONE": "done",
    "NOTE": "done",
    "BLOCKED": "blocked",
}
REMOTE_LIFECYCLE = {"running": "running", "done": "done", "stalled": "stalled", "stopped": "stalled"}

COMMIT_RE = re.compile(r"\b(?:commit(?:ted)?|merged|sha|tip|PR\s*#\d+\s+as)\b[^.\n]{0,40}?\b([0-9a-f]{7,40})\b", re.I)
BARE_SHA_RE = re.compile(r"`([0-9a-f]{7,40})`")
TESTS_RE = re.compile(
    r"\b(\d+\s*(?:/\s*\d+\s*)?(?:tests?\s+)?pass(?:ed|ing)?|\d+\s+passed|all\s+(?:\d+\s+)?tests?\s+pass(?:ed)?|"
    r"tests?\s+(?:pass(?:ed)?|green)|\(\d+/\d+\))",
    re.I,
)
FILE_RE = re.compile(r"(?:`|\b)((?:[\w.~-]+/)+[\w.-]+\.(?:md|py|js|json|html|css|ps1|sh|png|mp4|txt|diff))\b")
APPROVAL_WORDS = re.compile(r"\b(danger_guard|--approve|approval|approve|owner|Anthony|VADER Approvals)\b", re.I)
CODEX_WORDS = re.compile(r"\b(codex|pictures? only)\b", re.I)
PROOF_SOURCES = ("STATUS.md", "git:")


def find_proof(*texts: Optional[str]) -> Optional[Dict[str, str]]:
    """The first commit, test result or file path named in a report, reply or status line."""
    joined = "\n".join(t for t in texts if t)
    if not joined:
        return None
    m = COMMIT_RE.search(joined) or BARE_SHA_RE.search(joined)
    if m:
        return {"kind": "commit", "text": m.group(1)[:12]}
    m = TESTS_RE.search(joined)
    if m:
        return {"kind": "tests", "text": clip(m.group(1), 40)}
    m = FILE_RE.search(joined)
    if m:
        return {"kind": "file", "text": clip(m.group(1), 80)}
    return None


def _job_texts(job: Dict[str, Any]) -> List[Optional[str]]:
    last = job.get("last_result") or {}
    return [
        job.get("report_head"),
        job.get("report_headline"),
        last.get("text"),
        job.get("result_preview"),
        job.get("followed_up_by"),
    ]


def job_foundation(job: Dict[str, Any]) -> Dict[str, Any]:
    state = job.get("state", "")
    life = JOB_LIFECYCLE.get(state, "queued")
    drift: List[str] = []
    why = None
    if state == "cleared" and not str(job.get("followed_up_by") or "").startswith(PROOF_SOURCES):
        # Cleared on MAC's message log alone: not proof yet.
        life, why = "blocked", "cleared in MAC's log only; no STATUS.md entry or commit yet"
        drift.append("MAC's log says it's resolved, but STATUS.md and git don't show it yet")
    if state == "followed_up":
        why = "MAC is handling it; resolved once STATUS.md or a commit shows it"
    proof = None
    if life in ("done", "resolved"):
        proof = find_proof(*_job_texts(job))
        if proof is None and life == "resolved" and str(job.get("followed_up_by") or "").startswith("STATUS.md"):
            proof = {"kind": "status", "text": "STATUS.md entry"}
    # Who's up next
    detail = " ".join(t for t in _job_texts(job) if t)
    if life == "running":
        nxt = "Codex" if CODEX_WORDS.search(job.get("title") or "") else "Claude"
    elif life in ("blocked", "stalled"):
        nxt = "MAC" if state == "followed_up" or not APPROVAL_WORDS.search(detail) else "Anthony"
    elif life == "queued":
        nxt = "MAC"  # a brief is ready; MAC launches it
    elif life == "done" and proof is None:
        nxt = "MAC"  # confirm it with a commit, a test run or a file
    else:
        nxt = None
    return {
        "lifecycle": life,
        "lifecycle_why": why,
        "proof": proof,
        "verified": bool(proof) if life in ("done", "resolved") else None,
        "up_next": nxt,
        "drift": drift,
    }


SENDER_RE = re.compile(r"^WO from MAC\s*#?\d*")
BUILDERS = (
    ("Codex", re.compile(r"\bcodex\b", re.I)),
    ("Windows", re.compile(r"\bwindows\b", re.I)),
    ("Claude", re.compile(r"\bclaude\b", re.I)),
    ("MAC", re.compile(r"\b(MAC|Grok Bot)\b")),
)


def order_foundation(entry: Dict[str, Any]) -> Dict[str, Any]:
    state = entry.get("state", "")
    life = ORDER_LIFECYCLE.get(state, "queued")
    texts = [entry.get("status_text"), *(r.get("text") for r in entry.get("replies") or [])]
    proof = find_proof(*texts) if life == "done" else None
    action = entry.get("action")
    if action == "needs_anthony":
        nxt = "Anthony"
    elif action == "done":
        nxt = None if proof or state == "NOTE" else "MAC"
    elif entry.get("action_who") == "MAC":
        nxt = "MAC"
    elif state == "PARKED":
        nxt = "MAC"  # MAC decides when it comes off the shelf
    else:
        # the builder the status line names; the title's "WO from MAC" is the sender, not the builder
        title = SENDER_RE.sub("", entry.get("title") or "")
        hay = f"{entry.get('status_text') or ''} {title}"
        nxt = next((who for who, rx in BUILDERS if rx.search(hay)), "Claude")
    return {
        "lifecycle": life,
        "lifecycle_why": None,
        "proof": proof,
        "verified": (bool(proof) or state == "NOTE") if life == "done" else None,
        "up_next": nxt,
        "drift": [],
    }


def remote_foundation(job: Dict[str, Any], local_ids: set) -> Dict[str, Any]:
    life = REMOTE_LIFECYCLE.get(job.get("state", ""), "running")
    drift = []
    if job.get("state") == "stopped":
        drift.append("MAC's log says it's running, but the Windows heartbeat shows another job")
    return {
        "lifecycle": life,
        "lifecycle_why": job.get("source"),
        "proof": None,
        "verified": None,
        "up_next": "Windows" if job.get("machine") == "WINDOWS" else "MAC",
        "drift": drift,
    }


def comms_drift(folders: List[Dict[str, Any]], comms: List[Dict[str, Any]]) -> None:
    """A job folder that stopped while MAC's log still says it's running (MAC didn't log the finish)."""
    last: Dict[str, Dict[str, Any]] = {}
    for m in sorted(comms, key=lambda m: m.get("at") or ""):
        job = (m.get("ref") or {}).get("job")
        if job and m.get("at"):
            last[job] = m
    for job in folders:
        m = last.get(job["id"])
        if m and m.get("mac_kind") == "job_started" and job.get("state") not in ("running", "waiting", "prepared"):
            job.setdefault("drift", []).append("MAC's log still says it's running; the job folder here has stopped")


def apply(snapshot: Dict[str, Any], comms: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Add lifecycle, proof, up next and drift to every item, and a summary for the page."""
    for job in snapshot["folders"] + snapshot["oneshots"]:
        extra = job_foundation(job)
        job.update({**extra, "drift": job.get("drift", []) + extra["drift"]})
    comms_drift(snapshot["folders"], comms)
    for entry in snapshot["inbox"]:
        entry.update(order_foundation(entry))
    local = {j["id"] for j in snapshot["folders"] + snapshot["oneshots"]}
    for job in snapshot.get("remote_jobs", []):
        job.update(remote_foundation(job, local))
    for d in (snapshot.get("status") or {}).get("decision_items", []):
        d["up_next"] = None if d.get("settled") else ("MAC" if d.get("route") == "mac" else "Anthony")
    items = snapshot["folders"] + snapshot["oneshots"] + snapshot["inbox"] + snapshot.get("remote_jobs", [])
    drift = [
        {"id": i["id"], "kind": i.get("kind") or ("order" if "wo" in i else "remote"), "why": w}
        for i in items
        for w in i.get("drift", [])
    ]
    return {
        "drift": drift,
        "unverified": [j["id"] for j in snapshot["folders"] + snapshot["oneshots"] if j.get("verified") is False],
        "mine": sum(1 for i in items if i.get("up_next") == "Anthony")
        + sum(1 for d in (snapshot.get("status") or {}).get("decision_items", []) if d.get("up_next") == "Anthony"),
    }
