"""Anthony's "Mark done": for a job he knows finished but the Brain doesn't show as completed.

His mark is a record in the Brain's own folder (owner-marks.jsonl, append-only; an undo is another record),
never a change to the job, its folder or MAC's files. The Brain then verifies it: a commit, a test result or
a file path in the job's report, a git or STATUS.md resolution, or (for a Windows job) a DONE report in
windows-status.json. Verified marks show as done with the proof. Unverified ones show "marked done by
Anthony, unverified", stop alerting Anthony, and go to MAC to confirm with proof.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from .foundation import PROOF_SOURCES, _job_texts, find_proof
from .readers import read_text

MARKS_FILE = "owner-marks.jsonl"
KINDS = ("folder", "oneshot", "remote")
ACTIONS = ("done", "undo")


def read_marks(brain_dir: Path) -> Dict[str, Dict[str, Any]]:
    """The latest mark per job ("kind:id"), undone ones removed. Bad lines are skipped."""
    latest: Dict[str, Dict[str, Any]] = {}
    for line in (read_text(brain_dir / MARKS_FILE, 2 * 1024 * 1024) or "").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if isinstance(r, dict) and r.get("kind") in KINDS and r.get("id") and r.get("action") in ACTIONS:
            latest[f"{r['kind']}:{r['id']}"] = r
    return {k: r for k, r in latest.items() if r["action"] == "done"}


def proof_for(job: Dict[str, Any], windows_recent: List[Dict[str, Any]]) -> Optional[Dict[str, str]]:
    if job.get("proof"):
        return job["proof"]
    followed = str(job.get("followed_up_by") or "")
    if followed.startswith(PROOF_SOURCES):
        return {"kind": "status" if followed.startswith("STATUS.md") else "commit", "text": followed[:80]}
    found = find_proof(*_job_texts(job), job.get("note"), job.get("result_preview"), job.get("last_text"))
    if found:
        return found
    for r in windows_recent:
        if r.get("job") == job.get("id") and str(r.get("first_line") or "").startswith("TO MAC: DONE"):
            return {"kind": "report", "text": f"windows-status.json: {r['first_line'][:60]}"}
    return None


def apply(snapshot: Dict[str, Any], marks: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Label marked jobs, verify them, and take them off Anthony's list. Returns MAC's confirm items."""
    recent = (snapshot.get("windows") or {}).get("recent") or []
    groups = {
        "folder": snapshot.get("folders", []),
        "oneshot": snapshot.get("oneshots", []),
        "remote": snapshot.get("remote_jobs", []),
    }
    confirm: List[Dict[str, Any]] = []
    marked_ids = set()
    for kind, jobs in groups.items():
        for job in jobs:
            mark = marks.get(f"{kind}:{job['id']}")
            if not mark:
                continue
            marked_ids.add(job["id"])
            proof = proof_for(job, recent)
            job["owner_mark"] = {"at": mark.get("at"), "verified": bool(proof), "proof": proof}
            job["lifecycle"] = "done"
            job["lifecycle_why"] = "marked done by Anthony" + ("" if proof else "; no proof found yet")
            job["verified"] = bool(proof)
            job["proof"] = proof
            job["up_next"] = None if proof else "MAC"
            job["action"] = "done"
            job["action_note"] = (
                f"marked done by Anthony · verified ({proof['kind']} {proof['text']})"
                if proof
                else "marked done by Anthony · unverified, MAC to confirm"
            )
            job["alertable"] = False
            if not proof:
                confirm.append(
                    {
                        "source": "owner-mark",
                        "id": job["id"],
                        "state": "marked done, unverified",
                        "title": f"{job['id']}: Anthony marked it done",
                        "detail": "No commit, test result, file or STATUS.md line shows it. Confirm with proof.",
                        "machine": job.get("machine") or "MAC",
                        "at": mark.get("at"),
                        "up_next": "MAC",
                    }
                )
    snapshot["attention"] = [
        a for a in snapshot.get("attention", []) if a.get("id") not in marked_ids or a.get("source") == "work_order"
    ]
    return confirm
