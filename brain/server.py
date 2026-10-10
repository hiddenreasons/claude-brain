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

from . import marks, timeline
from .brainfiles import BrainFiles, audit
from .codex import codex_messages
from .comms import merge
from .config import Config
from .effects import Recorder, audit_tail, safe_record
from .mac_runs import MSG_RE, is_safe_id, job_detail
from .messages import derive_messages, mark_cleared, stamp_and_sort
from .obsidian import VaultExporter, check_vault
from .readers import FileCache, iso
from .snapshot import build_snapshot, fingerprint

log = logging.getLogger("brain")

STATIC_DIR = Path(__file__).parent / "static"
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/volley.js": ("volley.js", "text/javascript; charset=utf-8"),
    "/synapse.js": ("synapse.js", "text/javascript; charset=utf-8"),
    "/readable.js": ("readable.js", "text/javascript; charset=utf-8"),
    "/rules.js": ("rules.js", "text/javascript; charset=utf-8"),
    "/brains.js": ("brains.js", "text/javascript; charset=utf-8"),
    "/hud.js": ("hud.js", "text/javascript; charset=utf-8"),
    "/ask.js": ("ask.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'none'; "
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
        self._markable: Dict[str, Dict[str, Any]] = {}
        self._first_seen: Dict[str, Optional[str]] = {}
        self.stopping = threading.Event()
        self._refresh_lock = threading.Lock()
        self.files = BrainFiles(cfg.brain_dir) if cfg.record else None
        self.recorder = Recorder(self.files) if self.files else None

    def refresh(self, force: bool = False) -> bool:
        with self._refresh_lock:
            return self._refresh(force)

    def _refresh(self, force: bool) -> bool:
        fp = fingerprint(self.cfg)
        if not force and fp == self._fingerprint:
            return False
        snapshot = build_snapshot(self.cfg, self.cache)
        comms, skipped = snapshot.pop("_comms")
        # Jobs running elsewhere: from MAC's log, minus any whose folder here has stopped, with WINDOWS
        # state taken from the heartbeat (machines.remote_jobs).
        remote_running = [j["id"] for j in snapshot["remote_jobs"] if j["state"] == "running"]
        snapshot["messages"] = stamp_and_sort(
            mark_cleared(
                merge(derive_messages(snapshot), comms) + codex_messages(snapshot["codex"].pop("_events")),
                snapshot["folders"],
            ),
            self._first_seen,
            iso(time.time()),
            initial=self.version == 0,
        )
        snapshot["timeline"] = timeline.build(snapshot, snapshot["messages"], time.time())
        snapshot["running_count"] += len(remote_running)
        snapshot["comms"] = {"events": len(comms), "skipped": skipped, "running": remote_running}
        # One alert per job state, clears, decisions and bugs go to the Brain's own audit trail.
        safe_record(self.recorder, snapshot)
        snapshot["audit"] = audit_tail(self.files)
        snapshot["recommendations"] = [
            {
                k: r.get(k)
                for k in ("id", "kind", "machine", "what", "option", "impact", "status", "note", "result", "at")
            }
            for r in (self.recorder.recommendations if self.recorder else [])
        ]
        payload = json.dumps(snapshot, ensure_ascii=False).encode("utf-8")
        with self.cond:
            self._fingerprint = fp
            self.snapshot_bytes = payload
            # Every job id is detail-able, including one-shots older than the page's list limit.
            self._known_ids = {
                "oneshot": {j["id"] for j in snapshot["oneshots"]} | self._all_oneshot_ids(),
                "folder": {j["id"] for j in snapshot["folders"]},
                "remote": {j["id"] for j in snapshot["remote_jobs"]},
            }
            self._markable = {
                f"{kind}:{j['id']}": marks.snapshot_of(kind, j)
                for kind, jobs in (
                    ("folder", snapshot["folders"]),
                    ("oneshot", snapshot["oneshots"]),
                    ("remote", snapshot["remote_jobs"]),
                )
                for j in jobs
                if marks.markable(j) and "owner_mark" not in j
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

    def mark_target(self, kind: str, job_id: str) -> Optional[Dict[str, Any]]:
        """How a markable job looks right now (state + last report time), or None if it can't be marked."""
        with self.cond:
            return self._markable.get(f"{kind}:{job_id}")

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
    allowed_origins = {f"http://{h}" for h in allowed_hosts}

    class Handler(BaseHTTPRequestHandler):
        server_version = "ClaudeBrain"
        protocol_version = "HTTP/1.1"
        timeout = 30  # a request that stalls mid-body can't hold a thread forever

        def log_message(self, fmt: str, *args: Any) -> None:
            log.debug("%s %s", self.address_string(), fmt % args)

        def _send(self, status: int, body: bytes, content_type: str, extra: Optional[Dict[str, str]] = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            for key, value in {"Cache-Control": "no-store", **SECURITY_HEADERS, **(extra or {})}.items():
                self.send_header(key, value)
            if self.close_connection:
                self.send_header("Connection", "close")  # tell the client too, so it doesn't reuse the socket
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
            elif url.path == "/api/refresh":
                # The Update button: re-read every source now instead of waiting for the next poll.
                state.refresh(force=True)
                with state.cond:
                    body = state.snapshot_bytes
                self._send(HTTPStatus.OK, body, "application/json; charset=utf-8")
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
            self.close_connection = True  # any body is left unread: never parse it as a next request
            self._error(HTTPStatus.METHOD_NOT_ALLOWED, "read-only: GET only")

        do_PUT = do_PATCH = do_DELETE = _not_allowed  # noqa: N815

        def do_POST(self) -> None:  # noqa: N802 (http.server naming)
            # The one write: Anthony's "Mark done", recorded in the Brain's own folder. Only this page can send
            # it: loopback Host and Origin, a JSON body and a custom header (a cross-site form can't do both).
            # The connection closes after every POST, so a body left unread (refused, too big) can never be
            # read as the next request on a keep-alive connection.
            self.close_connection = True
            if urlsplit(self.path).path != "/api/mark":
                self._not_allowed()
                return
            if (
                self.headers.get("Host", "") not in allowed_hosts
                or self.headers.get("Origin", "") not in allowed_origins
                or self.headers.get("X-Brain-Action") != "mark"
                or not self.headers.get("Content-Type", "").startswith("application/json")
            ):
                self._error(HTTPStatus.FORBIDDEN, "marks come only from the Brain's own page")
                return
            if state.files is None:
                self._error(HTTPStatus.SERVICE_UNAVAILABLE, "recording is off")
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(min(length, 2048)) or b"{}") if 0 < length <= 2048 else None
            except ValueError:
                body = None
            if not isinstance(body, dict):
                self._error(HTTPStatus.BAD_REQUEST, "send {kind, id, action}")
                return
            kind, job_id, action = body.get("kind"), body.get("id"), body.get("action")
            if kind not in marks.KINDS or action not in marks.ACTIONS or not isinstance(job_id, str):
                self._error(HTTPStatus.NOT_FOUND, "unknown job")
                return
            if action == "done":
                # Only a job the page shows as blocked, stalled or unverified, and remember how it looked now.
                target = state.mark_target(kind, job_id) if is_safe_id(job_id) else None
                if target is None:
                    self._error(HTTPStatus.CONFLICT, "only a blocked, stalled or unverified job can be marked done")
                    return
                # The mark covers what Anthony was looking at: if a new report landed since, he checks it first.
                if body.get("seen") != target["seen"] or body.get("state") != target["state"]:
                    self._error(HTTPStatus.CONFLICT, "the job changed since the page showed it; look again")
                    return
                entry = {"kind": kind, "id": job_id, "action": "done", "who": "Anthony", **target}
            else:
                # An undo works even after the job has left the page, so a mark can always be taken back.
                if f"{kind}:{job_id}" not in marks.read_marks(state.cfg.brain_dir):
                    self._error(HTTPStatus.NOT_FOUND, "no mark to undo")
                    return
                entry = {"kind": kind, "id": job_id, "action": "undo", "who": "Anthony"}
            record = state.files.append(marks.MARKS_FILE, entry)
            try:
                change = "marked done" if action == "done" else "mark undone"
                audit(state.files, "owner-mark", job_id, change, "Anthony")
                state.refresh(force=True)
            except Exception:  # the mark is saved; the page picks it up on the next refresh
                log.exception("mark saved, but the audit line or refresh failed")
            self._json(HTTPStatus.OK, {"ok": True, "mark": record})

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


class QuietServer(ThreadingHTTPServer):
    """A browser closing a video or reloading mid-response is normal; don't print a traceback for it."""

    daemon_threads = True

    def handle_error(self, request, client_address) -> None:  # noqa: ANN001
        import sys

        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


def serve(cfg: Config) -> None:
    state = BrainState(cfg, exporter_factory_for(cfg))
    state.refresh(force=True)
    httpd = QuietServer((cfg.host, cfg.port), make_handler(state))
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
