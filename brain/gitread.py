"""Read-only git: the Brain looks, never changes.

Every call passes --no-optional-locks (and GIT_OPTIONAL_LOCKS=0), because even `git status` would
otherwise refresh the index and take a lock. No command here writes to a repository, a worktree or a ref.
Results are cached for a short while so a refresh every two seconds doesn't run git every two seconds.
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

CACHE_S = 60.0
_cache: Dict[Tuple[str, ...], Tuple[float, Optional[str]]] = {}
READ_ONLY = {"log", "rev-parse", "merge-base", "status", "branch", "for-each-ref", "diff", "show"}


def git(cwd: Path, *args: str, timeout: float = 4.0) -> Optional[str]:
    """stdout of a read-only git command, or None if it failed or isn't a repository."""
    if not args or args[0] not in READ_ONLY:
        raise ValueError(f"git {args[:1]} is not on the read-only list")
    key = (str(cwd), *args)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_S:
        return hit[1]
    env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"}
    try:
        res = subprocess.run(
            ["git", "--no-optional-locks", "-C", str(cwd), *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
            check=False,
        )
        out = res.stdout if res.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        out = None
    _cache[key] = (time.time(), out)
    return out


def clear_cache() -> None:
    _cache.clear()


def is_worktree(path: Path) -> bool:
    return (path / ".git").exists()


def head(path: Path) -> Optional[Tuple[str, float]]:
    """(sha, commit time as epoch seconds) of HEAD."""
    out = git(path, "log", "-1", "--format=%H%x09%ct")
    if not out or "\t" not in out:
        return None
    sha, ts = out.strip().split("\t", 1)
    try:
        return sha, float(ts)
    except ValueError:
        return None


def merged_into(path: Path, base: str = "main") -> bool:
    """True when HEAD is already contained in `base`."""
    return git(path, "merge-base", "--is-ancestor", "HEAD", base) is not None


def branch(path: Path) -> Optional[str]:
    out = git(path, "rev-parse", "--abbrev-ref", "HEAD")
    return out.strip() if out and out.strip() != "HEAD" else None


def changed_files(path: Path) -> List[Tuple[str, str]]:
    """(status, file) for staged or uncommitted changes."""
    out = git(path, "status", "--porcelain=v1", "--untracked-files=no")
    rows = []
    for line in (out or "").splitlines():
        if len(line) > 3:
            rows.append((line[:2], line[3:].strip().strip('"')))
    return rows
