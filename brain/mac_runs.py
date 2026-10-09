"""Read MAC's headless Claude jobs from ~/.vader-mac-runs.

Two shapes exist:
- one-shot jobs: msg<ID>.txt (the order MAC sent), out<ID>.json (Claude's result), err<ID>.txt
- job folders: <job>/brief.md, runs.log, iter-N.jsonl (live stream), iter-N.done, REPORT.md,
  GATE-PASSED / GATE-FAILED, claude.pid / run.pid
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .readers import FileCache, clip, iso, mtime_iso, read_tail, read_text

MSG_RE = re.compile(r"^msg(?P<id>[A-Za-z0-9_-]+)\.txt$")
ITER_RE = re.compile(r"^iter-(?P<n>\d+)\.jsonl$")
START_RE = re.compile(r"^start (?P<when>.+?) iter (?P<iter>\d+) .*?model (?P<model>\S+) effort (?P<effort>\S+)")
END_RE = re.compile(r"^end (?P<when>.+?) iter (?P<iter>\d+) exit (?P<code>-?\d+)")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")

WAITING_WINDOW_S = 6 * 3600  # a one-shot order without a result this recent may still be running
LIVE_WINDOW_S = 10 * 60  # a stream written to this recently is a running job
QUIET_WINDOW_S = 3 * 3600  # a live pid with a stream this recent is a running job that's quiet
ACTIVITY_TAIL_BYTES = 384 * 1024


def is_safe_id(value: str) -> bool:
    return bool(SAFE_ID_RE.match(value)) and value not in (".", "..")


# ---------- one-shot jobs ----------


def _first_line(text: str, limit: int = 160) -> str:
    for line in text.splitlines():
        line = line.strip()
        if line:
            return clip(line, limit) or ""
    return ""


def parse_result(path: Path) -> Optional[Dict[str, Any]]:
    """Parse a `claude -p --output-format json` result file. None when missing or unreadable."""
    raw = read_text(path)
    if raw is None:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return {"unreadable": True}
    if not isinstance(data, dict):
        return {"unreadable": True}
    model_usage = data.get("modelUsage") or {}
    denials = data.get("permission_denials") or []
    duration_ms = data.get("duration_ms")
    return {
        "unreadable": False,
        "is_error": bool(data.get("is_error")) or data.get("subtype") not in (None, "success"),
        "result": data.get("result") if isinstance(data.get("result"), str) else None,
        "session_id": data.get("session_id"),
        "cost_usd": data.get("total_cost_usd"),
        "duration_s": round(duration_ms / 1000) if isinstance(duration_ms, (int, float)) else None,
        "turns": data.get("num_turns"),
        "models": sorted(model_usage.keys()) if isinstance(model_usage, dict) else [],
        "denials": len(denials) if isinstance(denials, list) else 0,
    }


def scan_flat_jobs(runs_dir: Path, cache: FileCache, now: Optional[float] = None) -> List[Dict[str, Any]]:
    now = time.time() if now is None else now
    jobs: List[Dict[str, Any]] = []
    try:
        names = os.listdir(runs_dir)
    except OSError:
        return jobs
    for name in names:
        match = MSG_RE.match(name)
        if not match:
            continue
        job_id = match.group("id")
        msg_path = runs_dir / name
        out_path = runs_dir / f"out{job_id}.json"
        err_path = runs_dir / f"err{job_id}.txt"
        try:
            sent_ts = msg_path.stat().st_mtime
        except OSError:
            continue
        prompt = cache.get(msg_path, "head", lambda p: read_text(p, 4096) or "")
        result = cache.get(out_path, "result", parse_result)
        err_text = cache.get(err_path, "head", lambda p: read_text(p, 2048))

        if result is None:
            # No result yet: still running for up to 6 h, after that it's stalled (an alert).
            state = "waiting" if now - sent_ts < WAITING_WINDOW_S else "stalled"
        elif result["unreadable"]:
            state = "error"
        else:
            state = "error" if result["is_error"] else "done"

        result = result or {}
        jobs.append(
            {
                "kind": "oneshot",
                "id": job_id,
                "title": _first_line(prompt),
                "prompt_preview": clip(prompt, 600),
                "sent_at": iso(sent_ts),
                "finished_at": mtime_iso(out_path) if result else None,
                "updated_at": mtime_iso(out_path) if result else iso(sent_ts),
                "state": state,
                "note": "result file is unreadable"
                if result.get("unreadable")
                else "no result 6 h after MAC sent it"
                if state == "stalled"
                else None,
                "result_preview": clip(result.get("result"), 600),
                "session_id": result.get("session_id"),
                "cost_usd": result.get("cost_usd"),
                "duration_s": result.get("duration_s"),
                "turns": result.get("turns"),
                "models": result.get("models") or [],
                "denials": result.get("denials") or 0,
                "error_preview": clip(err_text.strip(), 400) if err_text and err_text.strip() else None,
            }
        )
    jobs.sort(key=lambda j: j["updated_at"] or "", reverse=True)
    return jobs


# ---------- live stream (stream-json) ----------


def _tool_summary(name: str, tool_input: Any) -> str:
    if not isinstance(tool_input, dict):
        return ""
    if name == "Bash":
        return str(tool_input.get("description") or tool_input.get("command") or "")
    for key in ("file_path", "notebook_path", "path"):
        if tool_input.get(key):
            return os.path.basename(str(tool_input[key])) or str(tool_input[key])
    for key in ("description", "pattern", "skill", "url", "query", "prompt"):
        if tool_input.get(key):
            return str(tool_input[key])
    return ""


def parse_activity(text: str, limit: int = 40) -> Dict[str, Any]:
    """Pull the readable actions (tool calls and Claude's words) out of a stream-json tail."""
    actions: List[Dict[str, Any]] = []
    session_id = None
    result = None
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        session_id = event.get("session_id") or session_id
        kind = event.get("type")
        if kind == "result":
            result = {
                "ok": event.get("subtype") == "success" and not event.get("is_error"),
                "text": clip(event.get("result") if isinstance(event.get("result"), str) else None, 1200),
                "cost_usd": event.get("total_cost_usd"),
            }
            continue
        if kind != "assistant":
            continue
        message = event.get("message") or {}
        for item in message.get("content") or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "tool_use":
                name = str(item.get("name") or "tool")
                actions.append(
                    {"kind": "tool", "name": name, "summary": clip(_tool_summary(name, item.get("input")), 200)}
                )
            elif item.get("type") == "text" and str(item.get("text") or "").strip():
                actions.append({"kind": "text", "text": clip(str(item["text"]).strip(), 400)})
    return {"actions": actions[-limit:], "session_id": session_id, "result": result}


# ---------- job folders ----------


def _pid_alive(path: Path) -> Optional[bool]:
    raw = read_text(path, 64)
    if not raw or not raw.strip().isdigit():
        return None
    try:
        os.kill(int(raw.strip()), 0)  # signal 0: existence check only, sends nothing
    except ProcessLookupError:
        return False
    except OSError:
        return None  # e.g. permission denied: can't tell
    return True


def parse_runs_log(text: Optional[str]) -> Dict[str, Any]:
    info: Dict[str, Any] = {"model": None, "effort": None, "started": None, "ended": None, "exit_code": None}
    for line in (text or "").splitlines():
        start = START_RE.match(line)
        if start:
            info.update(
                model=start.group("model"),
                effort=start.group("effort"),
                started=start.group("when"),
                ended=None,
                exit_code=None,
            )
            continue
        end = END_RE.match(line)
        if end:
            info.update(ended=end.group("when"), exit_code=int(end.group("code")))
    return info


GATE_CONFIRMATIONS = ("HANDOFF READ", "I read HANDOFF")
TITLE_PREFIX_RE = re.compile(r"^(?:JOB|TASK|Brief|Job|Task)\b\s*(?:\([^)]*\))?\s*[:—–-]\s*")
BOILERPLATE = ("YOUR RESPONSE MUST", "HANDOFF READ", "STARTUP GATE", "MANDATORY", "THE FULL HANDOFF", "READ /")


def brief_title(text: Optional[str], fallback: str) -> str:
    """The job's real task line. Briefs open with HANDOFF-gate boilerplate, often inside <handoff>."""
    if not text:
        return fallback
    marker = text.rfind("</handoff>")
    tail = text[marker + len("</handoff>") :] if marker >= 0 else text
    first_plain = None
    for raw in tail.splitlines():
        line = raw.strip().lstrip("#").strip()
        if not line or line.upper().startswith(BOILERPLATE) or line.startswith("<"):
            continue
        if raw.lstrip().startswith("#") or TITLE_PREFIX_RE.match(line):
            return clip(TITLE_PREFIX_RE.sub("", line), 160) or fallback
        first_plain = first_plain or line
    return clip(first_plain, 160) if first_plain else fallback


def _is_job_dir(names: List[str]) -> bool:
    return "brief.md" in names or "runs.log" in names or any(ITER_RE.match(n) for n in names)


def scan_job_folders(runs_dir: Path, cache: FileCache, now: Optional[float] = None) -> List[Dict[str, Any]]:
    now = time.time() if now is None else now
    jobs: List[Dict[str, Any]] = []
    try:
        entries = list(os.scandir(runs_dir))
    except OSError:
        return jobs
    for entry in entries:
        if not entry.is_dir(follow_symlinks=False) or entry.name.startswith((".", "_")):
            continue
        try:
            children = {c.name: c for c in os.scandir(entry.path)}
        except OSError:
            continue
        if not _is_job_dir(list(children)):
            continue
        jobs.append(_job_folder(Path(entry.path), children, cache, now))
    jobs.sort(key=lambda j: j["updated_at"] or "", reverse=True)
    return jobs


def _job_folder(path: Path, children: Dict[str, os.DirEntry], cache: FileCache, now: float) -> Dict[str, Any]:
    def mtime(name: str) -> Optional[float]:
        child = children.get(name)
        if child is None:
            return None
        try:
            return child.stat(follow_symlinks=False).st_mtime
        except OSError:
            return None

    iters = sorted(int(m.group("n")) for m in (ITER_RE.match(n) for n in children) if m)
    latest = iters[-1] if iters else None
    stream_name = f"iter-{latest}.jsonl" if latest is not None else None
    stream_mtime = mtime(stream_name) if stream_name else None
    done = latest is not None and f"iter-{latest}.done" in children

    runs = parse_runs_log(cache.get(path / "runs.log", "text", lambda p: read_text(p, 64 * 1024)))
    report_head = cache.get(path / "REPORT.md", "head", lambda p: read_text(p, 2048))
    report_headline = _first_line(report_head, 400) if report_head else None
    brief = cache.get(path / "brief.md", "head", lambda p: read_text(p, 256 * 1024))

    alive = None
    if latest is not None and not done:
        for pid_name in ("claude.pid", "run.pid"):
            if pid_name in children:
                alive = _pid_alive(path / pid_name)
                if alive is not None:
                    break

    activity: Dict[str, Any] = {"actions": [], "session_id": None, "result": None}
    if stream_name:
        activity = cache.get(
            path / stream_name,
            "activity",
            lambda p: parse_activity(read_tail(p, ACTIVITY_TAIL_BYTES) or "", limit=12),
        )
    last_result = activity.get("result")
    # Some jobs write their report elsewhere (e.g. _shared/next/); Claude's final reply still says how it went.
    headline_source = "report" if report_headline else None
    if report_headline is None and last_result and last_result.get("text"):
        lines = [ln for ln in last_result["text"].splitlines() if not ln.strip().startswith(GATE_CONFIRMATIONS)]
        report_headline = _first_line("\n".join(lines), 400) or None
        headline_source = "final reply" if report_headline else None

    report_ts = mtime("REPORT.md") or (stream_mtime if done else None)
    followed_up_by = None
    if report_ts is not None:
        later = [n for n in children if not _harness_file(n) and (mtime(n) or 0) > report_ts + 60]
        followed_up_by = sorted(later, key=lambda n: mtime(n) or 0)[-1] if later else None

    headline_upper = (report_headline or "").upper()
    if "GATE-FAILED" in children:
        state = "gate_failed"
    elif latest is None:
        state = "prepared"
    elif not done:
        recent = stream_mtime is not None and now - stream_mtime < LIVE_WINDOW_S
        quiet = alive is True and stream_mtime is not None and now - stream_mtime < QUIET_WINDOW_S
        state = "running" if recent or quiet else "stalled"
    elif "BLOCKED" in headline_upper[:40]:
        # A blocked report is only an open problem until MAC does something about it.
        state = "followed_up" if followed_up_by else "blocked"
    elif last_result is not None and not last_result.get("ok") and headline_source != "report":
        state = "error"
    elif report_headline is None:
        state = "no_report"
    else:
        state = "done"

    times = [t for t in (mtime(n) for n in children) if t is not None]
    return {
        "kind": "folder",
        "id": path.name,
        "title": brief_title(brief, path.name),
        "state": state,
        "iteration": latest,
        "model": runs["model"],
        "effort": runs["effort"],
        "started": runs["started"],
        "ended": runs["ended"] if done else None,
        "exit_code": runs["exit_code"] if done else None,
        "gate": "failed" if "GATE-FAILED" in children else ("passed" if "GATE-PASSED" in children else None),
        "report_headline": report_headline,
        "headline_source": headline_source,
        "report_at": iso(mtime("REPORT.md")) if mtime("REPORT.md") else None,
        "followed_up_by": followed_up_by,
        "followed_up_at": iso(mtime(followed_up_by)) if followed_up_by and mtime(followed_up_by) else None,
        "stream_updated_at": iso(stream_mtime) if stream_mtime else None,
        "updated_at": iso(max(times)) if times else None,
        "session_id": activity.get("session_id"),
        "activity": activity.get("actions") or [],
        "last_result": last_result,
    }


HARNESS_FILES = {"runs.log", "claude.pid", "run.pid", "waiter.pid", "LAUNCHED", "iter", "GATE-PASSED", "gate-check.log"}


def _harness_file(name: str) -> bool:
    """Files the job runner itself writes at the end of a run; they don't count as MAC following up."""
    return name in HARNESS_FILES or name.startswith("iter-") or name == "REPORT.md"


# ---------- full detail for one job (on demand) ----------


def job_detail(runs_dir: Path, kind: str, job_id: str) -> Optional[Dict[str, Any]]:
    if not is_safe_id(job_id):
        return None
    if kind == "oneshot":
        msg_path = runs_dir / f"msg{job_id}.txt"
        prompt = read_text(msg_path, 64 * 1024)
        if prompt is None:
            return None
        result = parse_result(runs_dir / f"out{job_id}.json") or {}
        return {
            "kind": kind,
            "id": job_id,
            "prompt": prompt,
            "result": result.get("result"),
            "errors": read_text(runs_dir / f"err{job_id}.txt", 16 * 1024),
        }
    if kind == "folder":
        path = runs_dir / job_id
        if not path.is_dir() or path.is_symlink():
            return None
        try:
            names = os.listdir(path)
        except OSError:
            return None
        iters = sorted(int(m.group("n")) for m in (ITER_RE.match(n) for n in names) if m)
        activity = {"actions": [], "result": None}
        if iters:
            activity = parse_activity(read_tail(path / f"iter-{iters[-1]}.jsonl", 2 * 1024 * 1024) or "", limit=200)
        brief = read_text(path / "brief.md", 256 * 1024)
        if brief and "</handoff>" in brief:
            brief = brief[brief.rfind("</handoff>") + len("</handoff>") :].strip()
        return {
            "kind": kind,
            "id": job_id,
            "brief": clip(brief, 40 * 1024),
            "report": read_text(path / "REPORT.md", 64 * 1024),
            "runs_log": read_text(path / "runs.log", 32 * 1024),
            "activity": activity["actions"],
            "last_result": activity["result"],
        }
    return None
