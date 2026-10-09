"""Flow monitor for MAC: how work moves on both machines, and where it's wasted.

Metrics per machine: idle time, queue length, time per job, wait time on Anthony, cost per finished job.
Waste: a machine idle with queued work; a heavy job holding up light ones; the same failure repeating;
a job run on a bigger model than its brief asked for; low memory while work waits.
Pure: reads the snapshot, returns findings. advisor.py turns findings into recommendations; nothing acts.
"""

from __future__ import annotations

import re
import subprocess
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

IDLE_FINDING_MIN = 15
HEAVY_MIN = 60
DAY_S = 86400
LIGHT_RE = re.compile(r"\b(small|quick|light|tiny|one[- ]line|trivial|short)\b", re.I)
SONNET_RE = re.compile(r"\(\s*sonnet\b", re.I)
SIGNATURES = (
    ("pre-commit hook in the sandbox", re.compile(r"pre-commit|hooks? (?:fail|blocked)|sandbox-only", re.I)),
    ("danger_guard hold", re.compile(r"danger_guard", re.I)),
    ("startup gate", re.compile(r"\bgate\b", re.I)),
    ("tests failing", re.compile(r"tests? (?:fail|failing)|failures?", re.I)),
    ("permission denied", re.compile(r"permission|denied|not allowed|refused", re.I)),
    ("timeout or hang", re.compile(r"timed? ?out|hang|hung|30 min limit", re.I)),
)


def _ts(iso_ts: Optional[str]) -> Optional[float]:
    if not iso_ts:
        return None
    try:
        return datetime.fromisoformat(str(iso_ts)).timestamp()
    except ValueError:
        return None


def _label(item: Dict[str, Any]) -> str:
    """WO #013 for a work order, the job id for a job."""
    if item.get("wo") is not None:
        return f"WO #{int(item['wo']):03d}"
    if "wo" in item:
        return str(item.get("title") or item["id"])[:40]
    return str(item["id"])


def failure_signature(text: Optional[str]) -> Optional[str]:
    for name, rx in SIGNATURES:
        if rx.search(text or ""):
            return name
    return None


_mem_cache: Dict[str, Any] = {}


def mac_free_memory_pct() -> Optional[float]:
    """Free + inactive pages as a share of all, from vm_stat (read-only), cached for a minute."""
    hit = _mem_cache.get("v")
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    try:
        out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=3, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        out = ""
    pages = {m.group(1): int(m.group(2)) for m in re.finditer(r"Pages (\w[\w ]*?):\s+(\d+)\.", out)}
    total = sum(pages.get(k, 0) for k in ("free", "active", "inactive", "speculative", "wired down"))
    pct = round(100 * (pages.get("free", 0) + pages.get("inactive", 0)) / total, 1) if total else None
    _mem_cache["v"] = (time.time(), pct)
    return pct


def metrics(snapshot: Dict[str, Any], now: float, mac_free_pct: Optional[float] = None) -> Dict[str, Dict[str, Any]]:
    folders, oneshots = snapshot.get("folders", []), snapshot.get("oneshots", [])
    remote = snapshot.get("remote_jobs", [])
    beat = snapshot.get("windows") or {}
    box = snapshot.get("windows_box") or {}
    inbox = snapshot.get("inbox", [])

    mac_running = [j for j in folders + oneshots if j.get("lifecycle") == "running"] + [
        j for j in remote if j.get("machine") == "MAC" and j.get("state") == "running"
    ]
    mac_ended = [
        _ts(j.get("report_at") or j.get("stream_updated_at") or j.get("finished_at"))
        for j in folders + oneshots
        if j.get("lifecycle") in ("done", "resolved", "blocked", "stalled")
    ]
    mac_ended = [t for t in mac_ended if t]
    ready_orders = [
        e for e in inbox if e.get("action") == "queued" and e.get("state") == "OPEN" and not e.get("action_note")
    ]
    mac_queue = [j for j in folders if j.get("lifecycle") == "queued"] + ready_orders
    day = [j for j in folders if (j.get("duration_s") or 0) > 0 and (_ts(j.get("updated_at")) or 0) > now - DAY_S]
    costs = [c for c in ((j.get("last_result") or {}).get("cost_usd") for j in day) if isinstance(c, (int, float))]
    anthony = [
        now - t for t in (_ts(i.get("state_since")) for i in folders + inbox if i.get("up_next") == "Anthony") if t
    ]

    win_running = [j for j in beat.get("running_jobs") or []] or [
        j["name"] for j in box.get("jobs", []) if j["state"] == "RUNNING"
    ]
    win_queue = [j["name"] for j in box.get("jobs", []) if j["state"] != "RUNNING"]
    win_ended = [_ts(r.get("finished_at")) for r in beat.get("recent") or []]
    win_ended = [t for t in win_ended if t]
    return {
        "MAC": {
            "running": len(mac_running),
            "queue": len(mac_queue),
            "queue_ids": [_label(i) for i in mac_queue][:8],
            "idle_min": 0 if mac_running else (int((now - max(mac_ended)) // 60) if mac_ended else None),
            "avg_job_min": round(sum(j["duration_s"] for j in day) / len(day) / 60) if day else None,
            "jobs_24h": len(day),
            "wait_on_anthony_min": int(sum(anthony) / len(anthony) // 60) if anthony else 0,
            "cost_per_job": round(sum(costs) / len(costs), 2) if costs else None,
            "free_memory_pct": mac_free_pct,
        },
        "WINDOWS": {
            "running": len(win_running),
            "queue": len(win_queue),
            "queue_ids": win_queue[:8],
            "idle_min": 0 if win_running else (int((now - max(win_ended)) // 60) if win_ended else None),
            "known": bool(beat.get("found") or box.get("found")),
            "offline": bool(box.get("offline", True)),
            "accepting": (box.get("accepting") or {}).get("yes"),
        },
    }


def findings(snapshot: Dict[str, Any], m: Dict[str, Dict[str, Any]], now: float) -> List[Dict[str, Any]]:
    """Waste worth telling MAC about. Each has a stable key, so the same finding is one recommendation."""
    out: List[Dict[str, Any]] = []
    mac, win = m["MAC"], m["WINDOWS"]
    if mac["running"] == 0 and mac["queue"] and (mac["idle_min"] or 0) >= IDLE_FINDING_MIN:
        out.append(
            {
                "key": "idle-with-queue:MAC",
                "kind": "idle-with-queue",
                "machine": "MAC",
                "what": f"MAC has been idle {mac['idle_min']} min with {mac['queue']} item(s) ready: "
                f"{', '.join(mac['queue_ids'][:4])}",
                "why": "Ready work is waiting while the Mac runs nothing.",
                "gain": f"about {mac['idle_min']} min of Mac time back per idle stretch",
                "option": f"Launch the next ready item ({mac['queue_ids'][0]}), or park what isn't really ready.",
                "impact": min(100, mac["idle_min"] // 3 + 10 * mac["queue"]),
                "metric": "idle_with_queue_min",
            }
        )
    if win["known"] and not win["offline"] and win["running"] == 0 and win["queue"] and win["accepting"] is not False:
        out.append(
            {
                "key": "idle-with-queue:WINDOWS",
                "kind": "idle-with-queue",
                "machine": "WINDOWS",
                "what": f"Windows is running nothing with {win['queue']} job(s) queued: "
                f"{', '.join(win['queue_ids'][:4])}",
                "why": "Queued work on Windows isn't being picked up.",
                "gain": "Windows throughput back",
                "option": "Check Windows' job runner picked up the queue (submit-job.ps1).",
                "impact": 40 + 5 * win["queue"],
                "metric": "idle_with_queue_min",
            }
        )
    for job in snapshot.get("folders", []):
        if job.get("lifecycle") != "running" or not job.get("state_since"):
            continue
        ran = (now - (_ts(job["state_since"]) or now)) / 60
        light = [
            e["id"]
            for e in snapshot.get("inbox", [])
            if e.get("action") == "queued" and LIGHT_RE.search(f"{e.get('title') or ''} {e.get('status_text') or ''}")
        ]
        if ran >= HEAVY_MIN and light:
            out.append(
                {
                    "key": f"heavy-blocks-light:{job['id']}",
                    "kind": "heavy-blocks-light",
                    "machine": "MAC",
                    "what": f"{job['id']} has run {int(ran)} min while {len(light)} light item(s) wait",
                    "why": "Small jobs queue behind one long job on one Mac lane.",
                    "gain": "light items done in minutes instead of after the long job",
                    "option": "Run light items on Windows, or between iterations of the long job.",
                    "impact": min(80, 20 + 10 * len(light)),
                    "metric": "heavy_blocks_light",
                }
            )
    seen: Dict[str, List[str]] = {}
    for job in snapshot.get("folders", []) + snapshot.get("oneshots", []):
        if job.get("state") not in ("blocked", "error", "gate_failed", "followed_up", "cleared"):
            continue
        if (_ts(job.get("updated_at")) or 0) < now - 7 * DAY_S:
            continue
        sig = failure_signature(
            " ".join(str(t) for t in (job.get("report_headline"), job.get("note"), job.get("result_preview")) if t)
        )
        if sig:
            seen.setdefault(sig, []).append(job["id"])
    for sig, jobs in seen.items():
        if len(jobs) >= 2:
            out.append(
                {
                    "key": f"repeated-failure:{sig}",
                    "kind": "repeated-failure",
                    "machine": "MAC",
                    "signature": sig,
                    "what": f"The same failure ({sig}) stopped {len(jobs)} jobs this week: {', '.join(jobs[:5])}",
                    "why": "A repeated failure on the same step costs a round trip every time.",
                    "gain": f"{len(jobs)} fewer blocked runs a week if fixed once",
                    "option": f"Fix the cause in the harness once ({sig}); see Proposed lessons.",
                    "impact": min(95, 30 + 15 * len(jobs)),
                    "metric": f"failures:{sig}",
                    "jobs": jobs,
                }
            )
    for job in snapshot.get("folders", []):
        if str(job.get("model") or "").lower() == "opus" and SONNET_RE.search(job.get("title") or ""):
            out.append(
                {
                    "key": f"model-mismatch:{job['id']}",
                    "kind": "model",
                    "machine": "MAC",
                    "what": f"{job['id']}'s brief names Sonnet but it ran on Opus",
                    "why": "The brief and the launch disagree on the model "
                    "(owner rule: Opus high unless the job names Sonnet).",
                    "gain": "the usage the brief planned for",
                    "option": "Launch it on the model its brief names.",
                    "impact": 15,
                    "metric": "model_mismatch",
                }
            )
    free = mac.get("free_memory_pct")
    if free is not None and free < 10 and mac["queue"]:
        out.append(
            {
                "key": "low-memory:MAC",
                "kind": "memory",
                "machine": "MAC",
                "what": f"The Mac has {free}% memory free with {mac['queue']} item(s) waiting",
                "why": "Low memory slows or stalls jobs, and holds back new ones.",
                "gain": "steadier runs",
                "option": "Close idle apps or run the next job on Windows.",
                "impact": 35,
                "metric": "low_memory",
            }
        )
    out.sort(key=lambda f: -f["impact"])
    return out
