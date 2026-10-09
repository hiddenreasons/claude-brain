"""Self-check on every load: one green or red line at the top of the page.

STATUS.md readable, Windows heartbeat under 3 minutes old, no stale locks, no unfilled placeholders.
Read-only: it looks at files, never touches them.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Dict, List

STALE_LOCK_S = 10 * 60


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)  # signal 0: existence check only, sends nothing
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _lock_is_stale(path: Path, now: float, git_lock: bool) -> bool:
    """A git index.lock older than 10 min is left from a crash (git removes it on exit). Any other lock
    is stale only when it names a process that is gone: an empty lock file is a flock() file, released
    by the OS when its holder exits, so its age means nothing."""
    try:
        st = path.stat()
    except OSError:
        return False
    if git_lock:
        return now - st.st_mtime > STALE_LOCK_S
    head = (path.read_text(errors="ignore")[:64] if st.st_size else "").strip()
    return head.isdigit() and not _pid_alive(int(head))


def _stale_locks(runs_dir: Path, now: float) -> List[str]:
    """Locks in the runs folder, its subfolders, and job worktrees' git dirs whose holder is gone."""
    found: List[str] = []

    def check(path: Path, label: str, git_lock: bool = False) -> None:
        if _lock_is_stale(path, now, git_lock):
            found.append(label)

    try:
        top = list(os.scandir(runs_dir))
    except OSError:
        return found
    for entry in top:
        if entry.is_file(follow_symlinks=False) and entry.name.endswith(".lock"):
            check(Path(entry.path), entry.name)
        if not entry.is_dir(follow_symlinks=False) or entry.name.startswith("."):
            continue
        try:
            children = list(os.scandir(entry.path))
        except OSError:
            continue
        for child in children:
            if child.is_file(follow_symlinks=False) and child.name.endswith(".lock"):
                check(Path(child.path), f"{entry.name}/{child.name}")
        gitfile = Path(entry.path) / "wt" / ".git"
        if gitfile.is_file():
            text = gitfile.read_text(errors="ignore").strip()
            if text.startswith("gitdir:"):
                check(Path(text[7:].strip()) / "index.lock", f"{entry.name}/wt index.lock", git_lock=True)
        elif (gitfile / "index.lock").exists():
            check(gitfile / "index.lock", f"{entry.name}/wt index.lock", git_lock=True)
    return found


def run(snapshot: Dict[str, Any], status_path: Path, runs_dir: Path, now: float = None) -> Dict[str, Any]:
    now = time.time() if now is None else now
    checks: List[Dict[str, Any]] = []
    readable = status_path.is_file() and os.access(status_path, os.R_OK)
    parsed = bool((snapshot.get("status") or {}).get("changelog") or (snapshot.get("status") or {}).get("decisions"))
    checks.append(
        {
            "name": "STATUS.md readable",
            "ok": readable and parsed,
            "detail": "read"
            if readable and parsed
            else "missing or unreadable"
            if not readable
            else "read, but nothing parsed",
        }
    )
    beat = snapshot.get("windows") or {}
    checks.append(
        {
            "name": "Windows heartbeat under 3 min",
            "ok": bool(beat.get("fresh")),
            "detail": beat.get("reason") or "no heartbeat",
        }
    )
    locks = _stale_locks(runs_dir, now)
    checks.append({"name": "No stale locks", "ok": not locks, "detail": ", ".join(locks[:4]) or "none"})
    ph = [
        f"{j['id']} ({', '.join('{{' + n + '}}' for n in j['placeholders'])})"
        for j in snapshot.get("folders", [])
        if j.get("placeholders") and j.get("lifecycle") not in ("done", "resolved")
    ]
    checks.append({"name": "No placeholders", "ok": not ph, "detail": "; ".join(ph[:3]) or "none"})
    bad = [c for c in checks if not c["ok"]]
    line = "All checks pass" if not bad else " · ".join(f"{c['name']}: {c['detail']}" for c in bad)
    return {"ok": not bad, "line": line, "checks": checks, "at": now}
