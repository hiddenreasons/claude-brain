"""Anthony's "Mark done": for a job he knows finished but the Brain doesn't show as completed.

His mark is a record in the Brain's own folder (owner-marks.jsonl, append-only; an undo is another record),
never a change to the job, its folder or MAC's files. Each mark remembers what the job looked like when he
clicked (its state and its last report time): if the job changes after that (MAC re-runs it, a new report
lands), the mark lapses and the job shows as it really is again.

A mark is VERIFIED only by proof the Brain can check: STATUS.md or git already resolving the job, a Windows
DONE report, or a commit named in the job's report that git confirms exists. Words in a BLOCKED report
(a file path, "40 passed") are not proof. Unverified marks leave Anthony's list and go to MAC to confirm.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import gitread
from .foundation import COMMIT_RE, PROOF_SOURCES, _job_texts
from .readers import read_text

MARKS_FILE = "owner-marks.jsonl"
KINDS = ("folder", "oneshot", "remote")
ACTIONS = ("done", "undo")
MARKABLE = ("blocked", "stalled")  # plus "done" that the Brain couldn't verify
SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")


def snapshot_of(kind: str, job: Dict[str, Any]) -> Dict[str, Any]:
    """What the job looked like when it was marked: the mark holds only while this is unchanged."""
    seen = {"folder": job.get("report_at"), "oneshot": job.get("updated_at"), "remote": job.get("last_at")}[kind]
    return {"state": job.get("state"), "seen": seen}


def markable(job: Dict[str, Any]) -> bool:
    life = job.get("lifecycle")
    return life in MARKABLE or (life == "done" and job.get("verified") is False)


def read_marks(brain_dir: Path) -> Dict[str, Dict[str, Any]]:
    """The latest mark per job ("kind:id"), undone ones removed. Bad lines are skipped."""
    latest: Dict[str, Dict[str, Any]] = {}
    for line in (read_text(brain_dir / MARKS_FILE, 64 * 1024 * 1024) or "").splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if isinstance(r, dict) and r.get("kind") in KINDS and r.get("id") and r.get("action") in ACTIONS:
            latest[f"{r['kind']}:{r['id']}"] = r
    return {k: r for k, r in latest.items() if r["action"] == "done"}


def _commit_exists(sha: str, repos: List[Path]) -> bool:
    if not SHA_RE.match(sha):
        return False
    return any(gitread.git(repo, "rev-parse", "--verify", "--quiet", f"{sha}^{{commit}}") for repo in repos)


def proof_for(job: Dict[str, Any], windows_recent: List[Dict[str, Any]], repos: List[Path]) -> Optional[Dict[str, str]]:
    if job.get("proof") and job.get("lifecycle_was") in ("done", "resolved"):
        return job["proof"]  # the Brain's own check had already found it
    followed = str(job.get("followed_up_by") or "")
    if followed.startswith(PROOF_SOURCES):
        return {"kind": "status" if followed.startswith("STATUS.md") else "commit", "text": followed[:80]}
    for r in windows_recent:
        if r.get("job") == job.get("id") and str(r.get("first_line") or "").startswith("TO MAC: DONE"):
            return {"kind": "report", "text": f"windows-status.json: {r['first_line'][:60]}"}
    texts = "\n".join(t for t in (*_job_texts(job), job.get("note"), job.get("last_text")) if t)
    job_repos = ([Path(job["path"]) / "wt"] if job.get("path") else []) + repos
    for m in COMMIT_RE.finditer(texts):
        if _commit_exists(m.group(1), job_repos):
            return {"kind": "commit", "text": f"{m.group(1)[:12]} (in git)"}
    return None


def apply(snapshot: Dict[str, Any], marks: Dict[str, Dict[str, Any]], repos: List[Path]) -> List[Dict[str, Any]]:
    """Label marked jobs, verify them, and take them off Anthony's list. Returns MAC's confirm items."""
    recent = (snapshot.get("windows") or {}).get("recent") or []
    groups = {
        "folder": snapshot.get("folders", []),
        "oneshot": snapshot.get("oneshots", []),
        "remote": snapshot.get("remote_jobs", []),
    }
    confirm: List[Dict[str, Any]] = []
    marked = set()
    for kind, jobs in groups.items():
        for job in jobs:
            mark = marks.get(f"{kind}:{job['id']}")
            if not mark:
                continue
            if {"state": mark.get("state"), "seen": mark.get("seen")} != snapshot_of(kind, job):
                job["owner_mark_lapsed"] = {"at": mark.get("at")}  # the job changed since: show it as it is
                continue
            marked.add((kind, job["id"]))
            job["lifecycle_was"] = job.get("lifecycle")
            proof = proof_for(job, recent, repos)
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
                        "detail": "No STATUS.md line, git resolution, Windows DONE report or commit in git shows it. "
                        "Confirm with proof.",
                        "machine": job.get("machine") or "MAC",
                        "at": mark.get("at"),
                        "up_next": "MAC",
                    }
                )

    def still_alerting(a: Dict[str, Any]) -> bool:
        return not (a.get("source") == "job" and (a.get("kind"), a["id"]) in marked)

    snapshot["attention"] = [a for a in snapshot.get("attention", []) if still_alerting(a)]
    return confirm
