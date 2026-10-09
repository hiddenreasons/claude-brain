"""Where Claude Brain looks, and where it listens. Everything here is read-only input."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional

DEFAULT_PORT = 8777  # VADER itself uses 8765; stay clear of it.
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


@dataclass(frozen=True)
class Config:
    vader_dir: Path
    runs_dir: Path
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    poll_seconds: float = 2.0
    vault_dir: Optional[Path] = None  # Obsidian vault; the only folder the Brain writes to
    export: bool = True

    @property
    def inbox_path(self) -> Path:
        return self.vader_dir / "docs" / "CLAUDE INBOX.md"

    @property
    def status_path(self) -> Path:
        return self.runs_dir / "STATUS.md"

    @property
    def issues_path(self) -> Path:
        return self.runs_dir / "ISSUES-LOG.md"


def parse_port(raw: str) -> int:
    try:
        port = int(raw)
    except ValueError:
        raise ValueError(f"port must be a whole number, got {raw!r}") from None
    if not 1024 <= port <= 65535:
        raise ValueError(f"port must be between 1024 and 65535, got {port}")
    return port


def load_config(env: Mapping[str, str] = os.environ) -> Config:
    home = Path.home()
    vader_dir = Path(env.get("BRAIN_VADER_DIR", str(home / "Documents" / "Active Projects" / "VADER")))
    runs_dir = Path(env.get("BRAIN_RUNS_DIR", str(home / ".vader-mac-runs")))
    vault_dir = Path(env.get("BRAIN_VAULT_DIR", str(home / "Documents" / "Active Projects" / "Claude Brain Vault")))
    return Config(
        vader_dir=vader_dir.expanduser(),
        runs_dir=runs_dir.expanduser(),
        port=parse_port(env.get("BRAIN_PORT", str(DEFAULT_PORT))),
        vault_dir=vault_dir.expanduser(),
    )
