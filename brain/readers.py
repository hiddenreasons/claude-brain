"""Read-only file helpers. Nothing in Claude Brain opens a file for writing."""

from __future__ import annotations

import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple


def read_text(path: Path, max_bytes: Optional[int] = None) -> Optional[str]:
    """Return the file's text (head only when max_bytes is set), or None if it can't be read."""
    try:
        with open(path, "rb") as f:
            data = f.read() if max_bytes is None else f.read(max_bytes)
    except (FileNotFoundError, IsADirectoryError, PermissionError):
        return None
    return data.decode("utf-8", errors="replace")


def read_tail(path: Path, max_bytes: int) -> Optional[str]:
    """Return roughly the last max_bytes of a file, starting at a whole line."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            start = max(0, size - max_bytes)
            f.seek(start)
            data = f.read()
    except (FileNotFoundError, IsADirectoryError, PermissionError):
        return None
    if start > 0:
        # The first line is almost certainly cut in half; drop it.
        newline = data.find(b"\n")
        data = data[newline + 1 :] if newline >= 0 else b""
    return data.decode("utf-8", errors="replace")


def stat_key(path: Path) -> Optional[Tuple[int, int]]:
    try:
        st = path.stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def mtime_iso(path: Path) -> Optional[str]:
    try:
        return iso(path.stat().st_mtime)
    except OSError:
        return None


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")


def clip(text: Optional[str], limit: int) -> Optional[str]:
    if text is None or len(text) <= limit:
        return text
    return text[:limit].rstrip() + " …"


class FileCache:
    """Memoizes a parser's result per file until the file's mtime or size changes."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._items: Dict[Tuple[str, str], Tuple[Tuple[int, int], Any]] = {}

    def get(self, path: Path, kind: str, parse: Callable[[Path], Any]) -> Any:
        key = stat_key(path)
        cache_key = (str(path), kind)
        with self._lock:
            hit = self._items.get(cache_key)
            if hit is not None and key is not None and hit[0] == key:
                return hit[1]
        value = parse(path)
        if key is not None:
            with self._lock:
                self._items[cache_key] = (key, value)
        return value
