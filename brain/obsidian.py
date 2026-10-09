"""Obsidian export: one note per MAC work order and per job, kept up to date inside the vault.

This is the only part of Claude Brain that writes files, and it writes only inside the vault folder.
Each note has a generated part and a marker line; anything Anthony writes below the marker is kept.
A note whose marker was removed is treated as his and never touched again. Nothing is ever deleted.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .mac_runs import job_detail, scan_flat_jobs
from .readers import FileCache, clip

log = logging.getLogger("brain.obsidian")

END_MARKER = "%% claude-brain:end · Claude Brain rewrites everything above this line. Write your own notes below it. %%"
MANIFEST = Path(".claude-brain") / "manifest.json"
INDEX_NOTE = "Claude Brain.md"
BAD_NAME_CHARS = re.compile(r'[\\/:*?"<>|#^\[\]`%\x00-\x1f]+')
WO_REF_RE = re.compile(r"\b(?:WO|work order)\s*#?\s*0*(\d{1,4})\b", re.IGNORECASE)
STATE_WORDS = {
    "running": "Running",
    "waiting": "Waiting",
    "done": "Done",
    "blocked": "Blocked",
    "error": "Error",
    "gate_failed": "Gate failed",
    "stalled": "Stalled",
    "no_report": "No report",
    "followed_up": "MAC followed up",
    "cleared": "Cleared by MAC",
    "prepared": "No Claude run",
}


# ---------- small helpers ----------


def _is_within(child: str, parent: str) -> bool:
    return child == parent or child.startswith(parent.rstrip(os.sep) + os.sep)


def check_vault(vault: Path, protected: Iterable[Path]) -> str:
    """Return the vault's real path, or raise ValueError if writing there could touch protected files."""
    real = os.path.realpath(vault)
    if not os.path.isdir(real):
        raise ValueError(f"vault folder not found: {vault}")
    for path in protected:
        other = os.path.realpath(path)
        if _is_within(real, other) or _is_within(other, real):
            raise ValueError(f"vault {vault} overlaps a read-only folder ({path}); refusing to write there")
    return real


def note_name(title: str, fallback: str = "untitled", limit: int = 90) -> str:
    name = BAD_NAME_CHARS.sub(" ", title or "")
    name = re.sub(r"\s+", " ", name).strip(" .-")
    if len(name) > limit:
        cut = name[:limit]
        name = cut[: cut.rfind(" ")] if " " in cut[limit // 2 :] else cut  # end on a whole word
    return name.rstrip(" .-,;—–(") or fallback


def job_title(job: Dict[str, Any]) -> str:
    """MAC often starts a brief with the job's own name ("sopapply — apply …"); don't say it twice."""
    title = job.get("title") or ""
    return re.sub(rf"^{re.escape(job['id'])}\s*[:—–-]\s*", "", title) or job["id"]


def yaml_value(value: Any) -> str:
    if value is None:
        return '""'
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(str(value), ensure_ascii=False)  # a JSON string is a valid YAML string


def front_matter(fields: Dict[str, Any], tags: List[str]) -> str:
    lines = ["---"]
    lines += [f"{key}: {yaml_value(value)}" for key, value in fields.items() if value not in (None, "", [])]
    lines.append("tags:")
    lines += [f"  - {tag}" for tag in tags]
    lines.append("---")
    return "\n".join(lines)


def safe_text(text: Optional[str]) -> str:
    """Generated text must not contain the marker or open an Obsidian comment."""
    return (text or "").replace("%%", "% %")


def callout(kind: str, title: str, text: Optional[str], folded: bool = False) -> str:
    head = f"> [!{kind}]{'-' if folded else ''} {title}"
    body = [f"> {line}" if line.strip() else ">" for line in safe_text(text).splitlines()] or [">"]
    return "\n".join([head, *body])


def local_time(stamp: Optional[str]) -> str:
    if not stamp:
        return ""
    try:
        return datetime.fromisoformat(stamp).astimezone().strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return stamp


def tag(value: str) -> str:
    return re.sub(r"[^a-z0-9/-]+", "-", value.lower()).strip("-")


def link(path: str, label: str) -> str:
    target = path[:-3] if path.endswith(".md") else path
    return f"[[{target}|{note_name(label, target)}]]"


def wo_key(entry: Dict[str, Any]) -> str:
    """Numbered work orders keep one note even if MAC retitles them; others are keyed by date and title."""
    return f"wo:#{entry['wo']}" if entry.get("wo") is not None else f"wo:{entry['id']}"


def signature(*parts: Any) -> str:
    return hashlib.sha1(json.dumps(parts, sort_keys=True, default=str).encode("utf-8")).hexdigest()


# ---------- exporter ----------


class VaultExporter:
    def __init__(self, vault: Path, protected: Iterable[Path], runs_dir: Path, cache: FileCache) -> None:
        self.vault = Path(check_vault(vault, protected))
        self.runs_dir = runs_dir
        self.cache = cache
        self.manifest: Dict[str, Dict[str, str]] = self._load_manifest()
        self.warned_owned: set = set()

    # ----- files -----

    def _load_manifest(self) -> Dict[str, Dict[str, str]]:
        try:
            data = json.loads((self.vault / MANIFEST).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _target(self, rel: str) -> Path:
        target = self.vault / rel
        parent = os.path.realpath(target.parent) if target.parent.exists() else None
        if parent is not None and not _is_within(parent, str(self.vault)):
            raise ValueError(f"refusing to write outside the vault: {rel}")
        if not _is_within(os.path.normpath(str(target)), str(self.vault)):
            raise ValueError(f"refusing to write outside the vault: {rel}")
        return target

    def _atomic_write(self, target: Path, text: str) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        if not _is_within(os.path.realpath(target.parent), str(self.vault)):
            raise ValueError(f"refusing to write outside the vault: {target}")
        tmp = target.with_name(f".{target.name}.brain-tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, target)

    def write_note(self, key: str, rel: str, generated: str, sig: str) -> str:
        """Write one note. Returns what happened: written, unchanged, moved+written, or user_owned."""
        target = self._target(rel)
        previous = self.manifest.get(key)
        outcome = "written"
        if previous and previous.get("path") != rel:
            old = self._target(previous["path"])
            if old.is_file() and not old.is_symlink() and not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                os.replace(old, target)  # a rename: Anthony's notes below the marker move with it
                outcome = "moved"
        if target.is_symlink():
            return "user_owned"
        user_part = "\n"
        current = None
        if target.exists():
            try:
                current = target.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                return "user_owned"
            cut = current.find(END_MARKER)
            if cut < 0:
                if rel not in self.warned_owned:
                    log.info("left alone (marker removed, so it's yours now): %s", rel)
                    self.warned_owned.add(rel)
                return "user_owned"
            user_part = current[cut + len(END_MARKER) :] or "\n"
        content = f"{generated.rstrip()}\n\n{END_MARKER}{user_part}"
        self.manifest[key] = {"path": rel, "sig": sig}
        if current == content:
            return "unchanged" if outcome == "written" else outcome
        self._atomic_write(target, content)
        return outcome

    def _unchanged(self, key: str, rel: str, sig: str) -> bool:
        previous = self.manifest.get(key)
        return (
            bool(previous)
            and previous.get("path") == rel
            and previous.get("sig") == sig
            and (self.vault / rel).exists()
        )

    # ----- naming -----

    def _assign_paths(self, items: List[Tuple[str, str, str]]) -> Dict[str, str]:
        """items: (key, folder, wanted name). Keeps names unique within a folder."""
        used: Dict[str, str] = {}
        paths: Dict[str, str] = {}
        for key, folder, name in items:
            rel = f"{folder}/{name}.md"
            if rel.lower() in used and used[rel.lower()] != key:
                rel = f"{folder}/{name} ({hashlib.sha1(key.encode()).hexdigest()[:6]}).md"
            used[rel.lower()] = key
            paths[key] = rel
        return paths

    # ----- export -----

    def export(self, snapshot: Dict[str, Any]) -> Dict[str, int]:
        stats: Dict[str, int] = {}
        inbox = snapshot.get("inbox", [])
        folders = snapshot.get("folders", [])
        oneshots = scan_flat_jobs(self.runs_dir, self.cache)  # every one-shot, not just the newest on the page

        names: List[Tuple[str, str, str]] = []
        for e in inbox:
            title = re.sub(r"^WO from MAC\s*#\s*\d+\s*[-—–:]\s*", "", e["title"])
            base = (
                f"WO {e['wo']:03d} - {title}" if e.get("wo") is not None else f"{e.get('date') or 'undated'} - {title}"
            )
            names.append((wo_key(e), "Work orders", note_name(base)))
        for j in folders:
            names.append((f"job:folder:{j['id']}", "Jobs", note_name(f"{j['id']} - {job_title(j)}")))
        for j in oneshots:
            names.append((f"job:oneshot:{j['id']}", "Jobs/One-shot", note_name(f"{j['id']} - {job_title(j)}")))
        paths = self._assign_paths(names)

        jobs_for_wo: Dict[int, List[Tuple[str, str]]] = {}
        wo_for_job: Dict[str, List[int]] = {}
        for kind, jobs in (("folder", folders), ("oneshot", oneshots)):
            for j in jobs:
                key = f"job:{kind}:{j['id']}"
                refs = {int(n) for n in WO_REF_RE.findall(f"{j.get('title', '')} {j.get('prompt_preview') or ''}")}
                wo_for_job[key] = sorted(refs)
                for n in refs:
                    jobs_for_wo.setdefault(n, []).append((paths[key], f"{j['id']} - {job_title(j)}"))
        wo_paths = {e["wo"]: (paths[wo_key(e)], e["title"]) for e in inbox if e.get("wo") is not None}

        def count(outcome: str) -> None:
            stats[outcome] = stats.get(outcome, 0) + 1

        for e in inbox:
            key = wo_key(e)
            related = jobs_for_wo.get(e.get("wo"), []) if e.get("wo") is not None else []
            sig = signature(e, related)
            if self._unchanged(key, paths[key], sig):
                count("unchanged")
                continue
            count(self.write_note(key, paths[key], render_work_order(e, related), sig))

        for kind, jobs in (("folder", folders), ("oneshot", oneshots)):
            for j in jobs:
                key = f"job:{kind}:{j['id']}"
                orders = [wo_paths[n] for n in wo_for_job.get(key, []) if n in wo_paths]
                sig = signature({k: v for k, v in j.items() if k not in ("activity",)}, orders, j.get("activity"))
                if self._unchanged(key, paths[key], sig):
                    count("unchanged")
                    continue
                detail = job_detail(self.runs_dir, kind, j["id"]) or {}
                count(self.write_note(key, paths[key], render_job(j, detail, orders), sig))

        index = render_index(snapshot, paths, oneshots)
        count(self.write_note("index", INDEX_NOTE, index, signature(index)))
        self._save_manifest_if_changed()
        return stats

    def _save_manifest_if_changed(self) -> None:
        current = json.dumps(self.manifest, indent=1, sort_keys=True)
        try:
            on_disk = (self.vault / MANIFEST).read_text(encoding="utf-8")
        except OSError:
            on_disk = None
        if on_disk != current:
            self._atomic_write(self.vault / MANIFEST, current)


# ---------- note templates ----------


def render_work_order(e: Dict[str, Any], related: List[Tuple[str, str]]) -> str:
    fm = front_matter(
        {
            "type": "work-order",
            "state": e["state"],
            "wo": e.get("wo"),
            "date": e.get("date"),
            "from": e.get("from"),
            "source": f"VADER/docs/CLAUDE INBOX.md, line {e['line']}",
        },
        ["claude-brain/work-order", f"claude-brain/state/{tag(e['state'])}"],
    )
    facts = [f"**State:** {e['state']}"]
    if e.get("date"):
        facts.append(f"**Date:** {e['date']}")
    if e.get("from"):
        facts.append(f"**From:** {e['from']}")
    parts = [fm, f"# {safe_text(e['title'])}", " · ".join(facts)]
    if e.get("status_text"):
        parts.append(f"**Status line:** {safe_text(e['status_text'])}")
    if e["replies"]:
        thread = []
        for r in e["replies"]:
            if r["direction"] == "from_mac":
                thread.append(callout("info", "MAC → Claude", r["text"]))
            elif r["blocked"]:
                thread.append(callout("danger", "Claude → MAC · BLOCKED", r["text"]))
            else:
                thread.append(callout("success", "Claude → MAC", r["text"]))
        parts.append("## Thread\n\n" + "\n\n".join(thread))
    if related:
        parts.append("## Jobs for this work order\n\n" + "\n".join(f"- {link(p, label)}" for p, label in related))
    if e.get("body"):
        cut = "\n\n*(Cut short here. The full entry is in CLAUDE INBOX.md.)*" if e.get("body_truncated") else ""
        parts.append("## Full entry\n\n" + safe_text(e["body"]) + cut)
    return "\n\n".join(parts)


def render_job(j: Dict[str, Any], detail: Dict[str, Any], orders: List[Tuple[str, str]]) -> str:
    folder = j["kind"] == "folder"
    state_word = STATE_WORDS.get(j["state"], j["state"])
    fm = front_matter(
        {
            "type": "job",
            "kind": "job-folder" if folder else "one-shot",
            "job": j["id"],
            "state": j["state"],
            "model": j.get("model") or ", ".join(j.get("models") or []),
            "effort": j.get("effort"),
            "iteration": j.get("iteration"),
            "started": j.get("started") or local_time(j.get("sent_at")),
            "updated": local_time(j.get("updated_at")),
            "turns": j.get("turns"),
            "cost_estimate_usd": j.get("cost_usd"),
            "session_id": j.get("session_id"),
        },
        ["claude-brain/job", f"claude-brain/state/{tag(j['state'])}"],
    )
    facts = [f"**State:** {state_word}"]
    model = " · ".join(x for x in (j.get("model"), j.get("effort")) if x) or ", ".join(j.get("models") or [])
    if model:
        facts.append(f"**Model:** {model}")
    if j.get("updated_at"):
        facts.append(f"**Updated:** {local_time(j['updated_at'])}")
    if isinstance(j.get("cost_usd"), (int, float)):
        facts.append(f"**Cost estimate:** ${j['cost_usd']:.2f} list price (not billed on the Max plan)")
    parts = [fm, f"# {safe_text(j['id'])}: {safe_text(job_title(j))}", " · ".join(facts)]
    if orders:
        parts.append("**Work orders:** " + ", ".join(link(p, label) for p, label in orders))
    if j["state"] in ("followed_up", "cleared") and j.get("followed_up_by"):
        lead = "Cleared" if j["state"] == "cleared" else "MAC acted after the report"
        parts.append(f"{lead} ({j['followed_up_by']}, {local_time(j.get('followed_up_at'))}).")

    if folder:
        if detail.get("report"):
            parts.append("## Report\n\n" + safe_text(clip(detail["report"], 20000)))
        elif detail.get("last_result") and detail["last_result"].get("text"):
            parts.append("## Final reply\n\n" + safe_text(detail["last_result"]["text"]))
        actions = (detail.get("activity") or j.get("activity") or [])[-25:]
        if actions:
            lines = [
                f"- `{a['name']}` {safe_text(a.get('summary') or '')}"
                if a["kind"] == "tool"
                else f"- Claude: {safe_text(a['text'])}"
                for a in actions
            ]
            parts.append("## Latest actions\n\n" + "\n".join(lines))
        if detail.get("brief"):
            parts.append(
                "## Brief from MAC\n\n" + callout("quote", "Brief (click to open)", clip(detail["brief"], 20000), True)
            )
        parts.append(f"## Files\n\n`~/.vader-mac-runs/{j['id']}/`")
    else:
        if detail.get("result"):
            parts.append("## Result\n\n" + safe_text(clip(detail["result"], 20000)))
        elif j["state"] in ("waiting", "stalled"):
            parts.append("## Result\n\nNo result yet.")
        if detail.get("prompt"):
            parts.append(
                "## MAC's order\n\n" + callout("quote", "Order (click to open)", clip(detail["prompt"], 20000), True)
            )
        if detail.get("errors") and detail["errors"].strip():
            parts.append("## Errors\n\n```\n" + detail["errors"].strip()[:4000].replace("```", "'''") + "\n```")
        parts.append(f"## Files\n\n`~/.vader-mac-runs/msg{j['id']}.txt`, `out{j['id']}.json`")
    return "\n\n".join(parts)


def render_index(snapshot: Dict[str, Any], paths: Dict[str, str], oneshots: List[Dict[str, Any]]) -> str:
    def job_link(kind: str, job: Dict[str, Any]) -> str:
        return link(paths[f"job:{kind}:{job['id']}"], f"{job['id']} - {job_title(job)}")

    parts = [
        front_matter({"type": "index"}, ["claude-brain/index"]),
        "# Claude Brain",
        "MAC's work orders and Claude's jobs, kept up to date by Claude Brain. Live page: http://localhost:8777",
    ]

    keys_by_entry = {e["id"]: wo_key(e) for e in snapshot.get("inbox", [])}
    attention = []
    for a in snapshot.get("attention", []):
        key = keys_by_entry.get(a["id"], "") if a["source"] == "work_order" else f"job:{a['kind']}:{a['id']}"
        target = paths.get(key)
        label = link(target, a["title"]) if target else safe_text(a["title"])
        attention.append(f"- **{a['state']}** {label}")
    parts.append("## Needs attention\n\n" + ("\n".join(attention) or "Nothing stuck."))

    running = [f"- {job_link('folder', j)}" for j in snapshot.get("folders", []) if j["state"] == "running"]
    running += [f"- {job_link('oneshot', j)}" for j in oneshots if j["state"] == "waiting"]
    parts.append("## Running now\n\n" + ("\n".join(running) or "No Claude job is running for MAC."))

    decisions = snapshot.get("status", {}).get("decisions", [])
    parts.append("## Waiting on Anthony\n\n" + ("\n".join(f"- {safe_text(d)}" for d in decisions) or "Nothing listed."))

    open_orders = [
        f"- **{e['state']}** {link(paths[wo_key(e)], e['title'])}"
        for e in snapshot.get("inbox", [])
        if e["state"] in ("OPEN", "BLOCKED", "RUNNING")
    ]
    parts.append("## Open work orders\n\n" + ("\n".join(open_orders) or "None."))

    latest = sorted(
        [("folder", j) for j in snapshot.get("folders", [])] + [("oneshot", j) for j in oneshots],
        key=lambda kj: kj[1].get("updated_at") or "",
        reverse=True,
    )[:25]
    lines = [
        f"- {STATE_WORDS.get(j['state'], j['state'])} · {local_time(j.get('updated_at'))} · {job_link(kind, j)}"
        for kind, j in latest
    ]
    parts.append("## Latest jobs\n\n" + ("\n".join(lines) or "None."))
    return "\n\n".join(parts)
