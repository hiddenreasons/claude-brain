"""The only place the Brain writes: its own folder, ~/.vader-mac-runs/brain/ (Anthony, 2026-10-09).

Everything else stays read-only: jobs, queues, STATUS.md, git, settings. Inside its folder the Brain writes
only the files named here, never MAC's comms.jsonl, never through a symlink, and never deletes anything.
Logs are append-only. Files that MAC or Anthony edit (statuses in RECOMMENDATIONS.md, PROPOSED-LESSONS.md)
are rewritten keeping those edits.
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

LOGS = {"audit.jsonl", "alerts.jsonl", "learning.jsonl", "recommendations.jsonl", "lessons.jsonl", "flow.jsonl"}
PAGES = {"RECOMMENDATIONS.md", "PROPOSED-LESSONS.md", "LEARNING-LOG.md"}
DATED_RE = re.compile(r"^(?:digest-\d{4}-\d{2}-\d{2}|weekly-\d{4}-W\d{2})\.md$")
# MAC's files in the same folder: the Brain reads them, never writes them
NEVER = {"comms.jsonl", "codex-status.jsonl", "windows-status.json", "codex-status-ingest.py"}


class WriteRefusedError(PermissionError):
    pass


def allowed(name: str) -> bool:
    return name not in NEVER and (name in LOGS or name in PAGES or bool(DATED_RE.match(name)))


class BrainFiles:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self._lock = threading.Lock()

    def path(self, name: str) -> Path:
        if not isinstance(name, str) or "/" in name or "\\" in name or name.startswith(".") or not allowed(name):
            raise WriteRefusedError(f"the Brain may not write {name!r}")
        target = self.root / name
        if target.is_symlink():
            raise WriteRefusedError(f"{name} is a symlink; the Brain won't write through it")
        if target.resolve().parent != self.root.resolve():
            raise WriteRefusedError(f"{name} resolves outside the Brain's folder")
        return target

    def append(self, name: str, record: Dict[str, Any]) -> Dict[str, Any]:
        if not name.endswith(".jsonl"):
            raise WriteRefusedError(f"{name} is not an append-only log")
        record = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **record}
        with self._lock:
            target = self.path(name)
            self.root.mkdir(parents=True, exist_ok=True)
            with open(target, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        return record

    def write(self, name: str, text: str) -> bool:
        """Replace a page atomically. Returns False when it already had exactly this text."""
        if name.endswith(".jsonl"):
            raise WriteRefusedError(f"{name} is append-only")
        with self._lock:
            target = self.path(name)
            if self.read(name) == text:
                return False
            self.root.mkdir(parents=True, exist_ok=True)
            tmp = self.root / f".{name}.tmp"
            tmp.write_text(text, encoding="utf-8")
            os.replace(tmp, target)
        return True

    def read(self, name: str) -> Optional[str]:
        try:
            return self.path(name).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return None

    def records(self, name: str) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for line in (self.read(name) or "").splitlines():
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if isinstance(item, dict):
                out.append(item)
        return out


class Ledger:
    """Keys already written to an append-only log, so each event is recorded once, even across restarts."""

    def __init__(self, files: BrainFiles, name: str, key: str = "key") -> None:
        self.files, self.name, self.field = files, name, key
        self.keys = {r.get(key) for r in files.records(name)}

    def add(self, key: str, record: Dict[str, Any]) -> bool:
        if key in self.keys:
            return False
        self.files.append(self.name, {self.field: key, **record})
        self.keys.add(key)
        return True

    def has(self, key: str) -> bool:
        return key in self.keys


def audit(files: BrainFiles, event: str, job: str, change: str, who: str = "Brain") -> Dict[str, Any]:
    """The audit trail: every alert, clear and decision, append-only (time, job, change, who)."""
    return files.append("audit.jsonl", {"event": event, "job": job, "change": change, "who": who})


def latest(records: Iterable[Dict[str, Any]], n: int) -> List[Dict[str, Any]]:
    return list(records)[-n:][::-1]
