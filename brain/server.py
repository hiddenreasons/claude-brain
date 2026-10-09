"""Local web server: the page, a JSON snapshot, per-job detail, and a live update stream (SSE).

GET only, loopback only. It reads files; it never writes, deletes or runs anything.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlsplit

from .config import Config
from .mac_runs import MSG_RE, is_safe_id, job_detail
from .messages import derive_messages, stamp_and_sort
from .obsidian import VaultExporter, check_vault
from .readers import FileCache, iso
from .snapshot import build_snapshot, fingerprint

log = logging.getLogger("brain")

STATIC_DIR = Path(__file__).parent / "static"
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/brains.js": ("brains.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
}
SSE_HEARTBEAT_S = 15.0


class BrainState:
    """Holds the latest snapshot and wakes live-stream clients when it changes."""

    def __init__(self, cfg: Config, exporter_factory=None) -> None:
        self.cfg = cfg
        self.cache = FileCache()
        self.exporter = exporter_factory(self.cache) if exporter_factory else None
        self._export_logged = False
        self.cond = threading.Condition()
        self.version = 0
        self.snapshot_bytes = b"{}"
        self._fingerprint: Optional[str] = None
        self._known_ids: Dict[str, set] = {"oneshot": set(), "folder": set()}
        self._first_seen: Dict[str, Optional[str]] = {}
        self.stopping = threading.Event()

    def refresh(self, force: bool = False) -> bool:
        fp = fingerprint(self.cfg)
        if not force and fp == self._fingerprint:
            return False
        snapshot = build_snapshot(self.cfg, self.cache)
        snapshot["messages"] = stamp_and_sort(
            derive_messages(snapshot), self._first_seen, iso(time.time()), initial=self.version == 0
        )
        payload = json.dumps(snapshot, ensure_ascii=False).encode("utf-8")
        with self.cond:
            self._fingerprint = fp
            self.snapshot_bytes = payload
            # Every job id is detail-able, including one-shots older than the page's list limit.
            self._known_ids = {
                "oneshot": {j["id"] for j in snapshot["oneshots"]} | self._all_oneshot_ids(),
                "folder": {j["id"] for j in snapshot["folders"]},
            }
            self.version += 1
            self.cond.notify_all()
        if self.exporter is not None:
            self._export(snapshot)
        return True

    def _export(self, snapshot: Dict[str, Any]) -> None:
        try:
            stats = self.exporter.export(snapshot)
        except Exception:  # a vault problem must never stop the live page
            log.exception("Obsidian export failed; will retry on the next change")
            return
        changed = {k: v for k, v in stats.items() if k != "unchanged"}
        if not self._export_logged or changed:
            log.info("Obsidian vault: %s", ", ".join(f"{v} {k}" for k, v in sorted(stats.items())))
            self._export_logged = True

    def _all_oneshot_ids(self) -> set:
        try:
            names = [p.name for p in self.cfg.runs_dir.iterdir()]
        except OSError:
            return set()
        return {m.group("id") for m in (MSG_RE.match(n) for n in names) if m}

    def knows(self, kind: str, job_id: str) -> bool:
        with self.cond:
            return job_id in self._known_ids.get(kind, set())

    def watch(self) -> None:
        while not self.stopping.wait(self.cfg.poll_seconds):
            try:
                if self.refresh():
                    log.info("sources changed; snapshot v%d", self.version)
            except Exception:  # keep watching; a bad file must not kill the live view
                log.exception("refresh failed; will retry")

    def stop(self) -> None:
        self.stopping.set()
        with self.cond:
            self.cond.notify_all()


def make_handler(state: BrainState):
    allowed_hosts = {f"127.0.0.1:{state.cfg.port}", f"localhost:{state.cfg.port}", f"[::1]:{state.cfg.port}"}

    class Handler(BaseHTTPRequestHandler):
        server_version = "ClaudeBrain"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: Any) -> None:
            log.debug("%s %s", self.address_string(), fmt % args)

        def _send(self, status: int, body: bytes, content_type: str, extra: Optional[Dict[str, str]] = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for key, value in {**SECURITY_HEADERS, **(extra or {})}.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, data: Any) -> None:
            self._send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

        def _error(self, status: HTTPStatus, message: str) -> None:
            self._json(status, {"error": message})

        def do_GET(self) -> None:  # noqa: N802 (http.server naming)
            # Block DNS-rebinding: only answer requests addressed to this machine's loopback.
            if self.headers.get("Host", "") not in allowed_hosts:
                self._error(HTTPStatus.MISDIRECTED_REQUEST, "unexpected Host header")
                return
            url = urlsplit(self.path)
            if url.path in STATIC_FILES:
                name, content_type = STATIC_FILES[url.path]
                self._send(HTTPStatus.OK, (STATIC_DIR / name).read_bytes(), content_type)
            elif url.path == "/api/snapshot":
                with state.cond:
                    body = state.snapshot_bytes
                self._send(HTTPStatus.OK, body, "application/json; charset=utf-8")
            elif url.path == "/api/job":
                self._job(parse_qs(url.query))
            elif url.path == "/events":
                self._events()
            else:
                self._error(HTTPStatus.NOT_FOUND, "not found")

        def _job(self, query: Dict[str, list]) -> None:
            kind = (query.get("kind") or [""])[0]
            job_id = (query.get("id") or [""])[0]
            if kind not in ("oneshot", "folder") or not is_safe_id(job_id) or not state.knows(kind, job_id):
                self._error(HTTPStatus.NOT_FOUND, "unknown job")
                return
            detail = job_detail(state.cfg.runs_dir, kind, job_id)
            if detail is None:
                self._error(HTTPStatus.NOT_FOUND, "job files are gone")
                return
            self._json(HTTPStatus.OK, detail)

        def _events(self) -> None:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            for key, value in SECURITY_HEADERS.items():
                self.send_header(key, value)
            self.end_headers()
            self.close_connection = True
            with state.cond:
                seen = state.version
            try:
                self.wfile.write(f"event: update\ndata: {seen}\n\n".encode())
                self.wfile.flush()
                while not state.stopping.is_set():
                    with state.cond:
                        state.cond.wait_for(
                            lambda last=seen: state.version != last or state.stopping.is_set(), SSE_HEARTBEAT_S
                        )
                        current = state.version
                    if current != seen:
                        seen = current
                        self.wfile.write(f"event: update\ndata: {seen}\n\n".encode())
                    else:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass  # the page closed or reloaded

        def _not_allowed(self) -> None:
            self._error(HTTPStatus.METHOD_NOT_ALLOWED, "read-only: GET only")

        do_POST = do_PUT = do_PATCH = do_DELETE = _not_allowed  # noqa: N815

    return Handler


def exporter_factory_for(cfg: Config):
    """Returns a factory for the Obsidian exporter, or None (with a reason logged) when export is off or unsafe."""
    if not cfg.export or cfg.vault_dir is None:
        log.info("Obsidian export is off")
        return None
    try:
        check_vault(cfg.vault_dir, [cfg.vader_dir, cfg.runs_dir])
    except ValueError as exc:
        log.warning("Obsidian export is off: %s", exc)
        return None
    log.info("Obsidian export on: writing notes into %s (and nowhere else)", cfg.vault_dir)
    return lambda cache: VaultExporter(cfg.vault_dir, [cfg.vader_dir, cfg.runs_dir], cfg.runs_dir, cache)


def serve(cfg: Config) -> None:
    state = BrainState(cfg, exporter_factory_for(cfg))
    state.refresh(force=True)
    httpd = ThreadingHTTPServer((cfg.host, cfg.port), make_handler(state))
    httpd.daemon_threads = True
    watcher = threading.Thread(target=state.watch, name="brain-watch", daemon=True)
    watcher.start()
    log.info("Claude Brain is live at http://%s:%d (read-only; Ctrl+C to stop)", "localhost", cfg.port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log.info("stopping")
    finally:
        state.stop()
        httpd.server_close()
