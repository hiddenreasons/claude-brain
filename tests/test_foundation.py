"""Part 2, foundation: one source of truth with DRIFT, one lifecycle, who's up next, proof on DONE,
the audit trail, and the self-check line."""

import json
import os
import time
from pathlib import Path

import pytest

from brain.brainfiles import BrainFiles
from brain.effects import Recorder
from brain.foundation import find_proof, job_foundation, order_foundation, remote_foundation
from brain.readers import FileCache, iso
from brain.selfcheck import _stale_locks
from brain.snapshot import build_snapshot

from conftest import write

HOUR = 3600


def done_job(runs: Path, name: str, report: str) -> None:
    job = runs / name
    write(job / "brief.md", f"JOB: {name} work (Opus high)\n", age_s=HOUR)
    write(
        job / "runs.log",
        "start 2026-10-09 13:00:00 EDT iter 1 pid 1 prompt p model opus effort high\n"
        "end 2026-10-09 13:20:00 EDT iter 1 exit 0\n",
        age_s=HOUR,
    )
    write(job / "iter-1.jsonl", "{}\n", age_s=HOUR)
    write(job / "iter-1.done", "", age_s=HOUR)
    write(job / "REPORT.md", report, age_s=HOUR)


def folder(snapshot, name):
    return next(j for j in snapshot["folders"] if j["id"] == name)


# ---------- 9. proof on every DONE ----------


def test_done_without_proof_shows_unverified_and_mac_is_up_next(tree):
    done_job(tree.runs_dir, "vague", "TO MAC: DONE. All good, everything works now.\n")
    snapshot = build_snapshot(tree, FileCache())
    job = folder(snapshot, "vague")
    assert (job["lifecycle"], job["proof"], job["verified"], job["up_next"]) == ("done", None, False, "MAC")
    assert "vague" in snapshot["foundation"]["unverified"]
    assert "report_head" not in job  # the report text was only used to look for proof


def test_done_with_a_commit_or_tests_or_a_file_is_verified(tree):
    done_job(tree.runs_dir, "withsha", "TO MAC: DONE. Committed f1d2a32 on claude/x.\n")
    done_job(tree.runs_dir, "withtests", "TO MAC: DONE. 1465 passed, 22 known sandbox fails.\n")
    done_job(tree.runs_dir, "withfile", "TO MAC: DONE. Wrote `docs/LANES INVENTORY.md` and `_shared/wo-sop.md`.\n")
    snapshot = build_snapshot(tree, FileCache())
    assert folder(snapshot, "withsha")["proof"] == {"kind": "commit", "text": "f1d2a32"}
    assert folder(snapshot, "withtests")["proof"]["kind"] == "tests"
    assert folder(snapshot, "withfile")["proof"] == {"kind": "file", "text": "_shared/wo-sop.md"}
    assert all(folder(snapshot, n)["verified"] is True for n in ("withsha", "withtests", "withfile"))
    assert find_proof(None, "") is None


# ---------- 7. same lifecycle everywhere; resolved only with proof ----------


@pytest.mark.parametrize(
    "state, lifecycle",
    [
        ("prepared", "queued"),
        ("running", "running"),
        ("waiting", "running"),
        ("done", "done"),
        ("blocked", "blocked"),
        ("gate_failed", "blocked"),
        ("stalled", "stalled"),
        ("followed_up", "blocked"),
    ],
)
def test_every_mac_job_state_maps_to_one_lifecycle(state, lifecycle):
    assert job_foundation({"state": state, "title": "x"})["lifecycle"] == lifecycle


def test_windows_jobs_use_the_same_lifecycle():
    assert remote_foundation({"state": "running", "machine": "WINDOWS"}, set())["lifecycle"] == "running"
    stopped = remote_foundation({"state": "stopped", "machine": "WINDOWS"}, set())
    assert stopped["lifecycle"] == "stalled" and stopped["drift"] and stopped["up_next"] == "Windows"


def test_resolved_needs_status_or_a_commit_not_just_macs_log():
    proven = job_foundation(
        {"state": "cleared", "followed_up_by": "STATUS.md: claudemd committed f1d2a32", "title": "x"}
    )
    assert proven["lifecycle"] == "resolved" and proven["verified"] is True
    by_git = job_foundation(
        {"state": "cleared", "followed_up_by": "git: abc1234 merged into main after the report", "title": "x"}
    )
    assert by_git["lifecycle"] == "resolved"
    log_only = job_foundation({"state": "cleared", "followed_up_by": "MAC (comms log): unblocked", "title": "x"})
    assert log_only["lifecycle"] == "blocked" and log_only["drift"]


# ---------- 8. who's up next ----------


def test_who_is_up_next():
    assert job_foundation({"state": "running", "title": "Draft mockups (pictures only, Codex)"})["up_next"] == "Codex"
    assert job_foundation({"state": "running", "title": "fix tests"})["up_next"] == "Claude"
    assert (
        job_foundation({"state": "blocked", "title": "x", "report_headline": "TO MAC: BLOCKED danger_guard area d"})[
            "up_next"
        ]
        == "Anthony"
    )
    assert (
        job_foundation({"state": "blocked", "title": "x", "report_headline": "TO MAC: BLOCKED pre-commit hook"})[
            "up_next"
        ]
        == "MAC"
    )
    parked = {
        "state": "PARKED",
        "title": "WO from MAC #020 - VADER learns",
        "status_text": "PARKED until after the button-up pass",
        "action": "queued",
        "replies": [],
    }
    assert order_foundation(parked)["up_next"] == "MAC"
    open_wo = {
        "state": "OPEN",
        "title": "WO from MAC #010 - Post button",
        "status_text": "OPEN — Claude Eng (API endpoints)",
        "action": "queued",
        "replies": [],
    }
    assert order_foundation(open_wo)["up_next"] == "Claude"
    assert order_foundation({**open_wo, "action": "needs_anthony"})["up_next"] == "Anthony"


def test_anthonys_view_counts_only_his_items(tree):
    snapshot = build_snapshot(tree, FileCache())
    mine = [d for d in snapshot["status"]["decision_items"] if d["up_next"] == "Anthony"]
    assert snapshot["foundation"]["mine"] >= len(mine) >= 1


# ---------- 6. one source of truth, DRIFT ----------


def test_a_folder_that_stopped_while_macs_log_says_running_is_drift(tree):
    done_job(tree.runs_dir, "brainhooks", "TO MAC: DONE. 220 passed.\n")
    write(
        tree.runs_dir / "brain" / "comms.jsonl",
        json.dumps(
            {
                "v": 1,
                "id": "s1",
                "at": "2026-10-09T12:00:00Z",
                "from": "mac",
                "to": "claude",
                "kind": "job_started",
                "job": "brainhooks",
                "text": "brainhooks started",
            }
        )
        + "\n",
    )
    snapshot = build_snapshot(tree, FileCache())
    assert folder(snapshot, "brainhooks")["drift"] == [
        "MAC's log still says it's running; the job folder here has stopped"
    ]
    assert {"id": "brainhooks", "kind": "folder", "why": folder(snapshot, "brainhooks")["drift"][0]} in snapshot[
        "foundation"
    ]["drift"]


def test_the_brains_own_files_never_change_what_it_shows(tree):
    done_job(tree.runs_dir, "vague", "TO MAC: DONE.\n")
    before = build_snapshot(tree, FileCache())
    files = BrainFiles(tree.brain_dir)
    Recorder(files).record(before)
    files.append("audit.jsonl", {"event": "clear", "job": "vague", "change": "pretend", "who": "test"})
    after = build_snapshot(tree, FileCache())
    keys = ("state", "lifecycle", "verified", "up_next", "drift")
    assert [{k: j.get(k) for k in keys} for j in before["folders"]] == [
        {k: j.get(k) for k in keys} for j in after["folders"]
    ]


# ---------- 10. audit trail ----------


def test_the_audit_trail_is_append_only_with_time_job_change_and_who(tree):
    done_job(tree.runs_dir, "vague", "TO MAC: BLOCKED tests fail\n")
    files = BrainFiles(tree.brain_dir)
    Recorder(files).record(build_snapshot(tree, FileCache()))
    first = (tree.brain_dir / "audit.jsonl").read_text()
    assert first
    Recorder(files).record(build_snapshot(tree, FileCache()))
    second = (tree.brain_dir / "audit.jsonl").read_text()
    assert second.startswith(first)  # only ever appended
    for r in files.records("audit.jsonl"):
        assert {"at", "event", "job", "change", "who"} <= set(r)


# ---------- 11. self-check ----------


def test_the_self_check_goes_red_on_a_stale_heartbeat(tree):
    write(
        tree.runs_dir / "_xfer" / "win" / "heartbeat.json", json.dumps({"at": iso(time.time() - 20 * 60), "job": None})
    )
    sc = build_snapshot(tree, FileCache())["selfcheck"]
    beat = next(c for c in sc["checks"] if c["name"].startswith("Windows heartbeat"))
    assert sc["ok"] is False and beat["ok"] is False and "20 min old" in beat["detail"]
    assert "Windows heartbeat under 3 min" in sc["line"]


def test_the_self_check_is_green_when_everything_is_in_order(tree):
    write(tree.runs_dir / "_xfer" / "win" / "heartbeat.json", json.dumps({"at": iso(time.time() - 30), "job": None}))
    sc = build_snapshot(tree, FileCache())["selfcheck"]
    assert sc["ok"] is True and sc["line"] == "All checks pass", sc["line"]


def test_stale_locks_are_only_ones_whose_holder_is_gone(tree):
    now = time.time()
    write(tree.runs_dir / "tools" / "download-sorter.lock", "", age_s=HOUR)  # flock file: never stale
    write(tree.runs_dir / "jobx" / "run.lock", "999999", age_s=HOUR)  # names a process that is gone
    write(tree.runs_dir / "joby" / "run.lock", str(os.getpid()), age_s=HOUR)  # holder alive
    assert _stale_locks(tree.runs_dir, now) == ["jobx/run.lock"]
