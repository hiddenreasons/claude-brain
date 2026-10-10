"""Part 3, operations: usage and loops, restart storms, time in state, decision IDs, branch hygiene,
cross-machine conflicts, and the daily digest."""

import json
import os
import subprocess
import time
from datetime import datetime
from pathlib import Path

import pytest

from brain import gitread, ops
from brain.brainfiles import BrainFiles
from brain.effects import Recorder
from brain.readers import FileCache, iso
from brain.snapshot import build_snapshot

from conftest import write

HOUR = 3600
ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@t",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@t",
}


@pytest.fixture(autouse=True)
def fresh_git_cache():
    gitread.clear_cache()
    yield
    gitread.clear_cache()


def git(repo: Path, *args: str, when: float = None) -> str:
    env = dict(ENV)
    if when:
        env.update({"GIT_AUTHOR_DATE": f"@{int(when)} +0000", "GIT_COMMITTER_DATE": f"@{int(when)} +0000"})
    return subprocess.run(["git", "-C", str(repo), *args], check=True, env=env, capture_output=True, text=True).stdout


def repo_with_commit(path: Path, when: float, branch: str = "main") -> Path:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", "-b", branch, str(path)], check=True, capture_output=True)
    (path / "a.txt").write_text("a")
    git(path, "add", "-A")
    git(path, "commit", "-qm", "first", when=when)
    return path


def local(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


def running_job(runs: Path, name: str, started_ago: float) -> Path:
    job = runs / name
    start = time.time() - started_ago
    write(job / "brief.md", f"JOB: {name} (A-006, Opus high)\n", age_s=started_ago)
    write(
        job / "runs.log", f"start {local(start)} EDT iter 1 pid 1 prompt p model opus effort high\n", age_s=started_ago
    )
    write(job / "iter-1.jsonl", '{"type":"assistant","message":{"content":[]}}\n')  # log moving now
    return job


# ---------- 13. restart storm ----------


def test_three_restarts_in_an_hour_flag_a_storm_for_mac(tree):
    job = running_job(tree.runs_dir, "claudemd", 2 * HOUR)
    now = time.time()
    write(job / "starts.log", "".join(f"{int(now - m * 60)} 1 restart\n" for m in (50, 30, 10)))
    snapshot = build_snapshot(tree, FileCache())
    storms = snapshot["ops"]["storms"]
    assert [s["id"] for s in storms] == ["claudemd"] and storms[0]["count"] >= 3
    assert any(a["source"] == "restart" and a["up_next"] == "MAC" for a in snapshot["mac_attention"])
    job_row = next(j for j in snapshot["folders"] if j["id"] == "claudemd")
    assert job_row["flags"][0].startswith("RESTART STORM")
    assert not any(a["id"] == "claudemd" for a in snapshot["attention"])  # MAC's, not Anthony's


def test_refused_restarts_count_and_two_starts_are_not_a_storm(tree):
    job = running_job(tree.runs_dir, "calm", 2 * HOUR)
    now = time.time()
    write(job / "starts.log", f"{int(now - 600)} 1 legit first start\n")
    assert ops.restart_storms([{"id": "calm", "path": str(job)}], now) == []
    guard = "".join(
        f"restart-guard {local(now - m * 60)} EDT: RESTART-CAPPED present; refusing start\n" for m in (3, 2, 1)
    )
    write(job / "runs.log", guard)
    assert [s["id"] for s in ops.restart_storms([{"id": "calm", "path": str(job)}], now)] == ["calm"]


# ---------- 12. usage and possible loops ----------


def test_twenty_minutes_of_work_with_no_file_changes_is_a_possible_loop(tree):
    job = running_job(tree.runs_dir, "spinning", 45 * 60)
    wt = repo_with_commit(job / "wt", time.time() - 40 * 60)
    ts = time.time() - 40 * 60
    os.utime(wt / "a.txt", (ts, ts))
    snapshot = build_snapshot(tree, FileCache())
    assert [lp["id"] for lp in snapshot["ops"]["loops"]] == ["spinning"]
    assert any(a["source"] == "loop" for a in snapshot["mac_attention"])


def test_a_recent_file_change_is_not_a_loop(tree):
    job = running_job(tree.runs_dir, "working", 45 * 60)
    wt = repo_with_commit(job / "wt", time.time() - 40 * 60)
    (wt / "a.txt").write_text("changed just now")
    assert build_snapshot(tree, FileCache())["ops"]["loops"] == []


def test_usage_reads_its_file_or_says_there_is_none(tree):
    assert ops.read_usage(tree.runs_dir)["note"] == "no usage source yet (brain/usage.json)"
    write(tree.runs_dir / "brain" / "usage.json", json.dumps({"MAC": {"left_pct": 64}, "WINDOWS": {"left_pct": 12}}))
    assert ops.read_usage(tree.runs_dir)["machines"] == {
        "MAC": {"left_pct": 64, "note": None},
        "WINDOWS": {"left_pct": 12, "note": None},
    }


# ---------- 14. time in state; waiting on Anthony 30+ min goes to the top ----------


def test_items_waiting_on_anthony_for_30_minutes_are_overdue_longest_first():
    now = time.time()
    snapshot = {
        "folders": [
            {
                "id": "a",
                "kind": "folder",
                "lifecycle": "blocked",
                "up_next": "Anthony",
                "report_at": iso(now - 10 * 60),
                "title": "A",
            },
            {
                "id": "b",
                "kind": "folder",
                "lifecycle": "blocked",
                "up_next": "Anthony",
                "report_at": iso(now - 3 * HOUR),
                "title": "B",
            },
            {
                "id": "c",
                "kind": "folder",
                "lifecycle": "blocked",
                "up_next": "Anthony",
                "report_at": iso(now - 45 * 60),
                "title": "C",
            },
            {
                "id": "d",
                "kind": "folder",
                "lifecycle": "blocked",
                "up_next": "MAC",
                "report_at": iso(now - 5 * HOUR),
                "title": "D",
            },
        ],
        "oneshots": [],
        "inbox": [],
        "remote_jobs": [],
        "status": {},
    }
    result = ops.apply(snapshot, Path("/nonexistent"), Path("/nonexistent"), now, [])
    assert [o["id"] for o in result["overdue"]] == ["b", "c"]
    assert all(j["state_since"] for j in snapshot["folders"])


# ---------- 15. decision links ----------


def test_a_live_brief_without_a_decision_id_gets_a_warning(tree):
    status = tree.status_path.read_text() + "\n## Decision log (IDs)\n- A-001 2026-10-09 14:12: inbox cleanup.\n"
    write(tree.status_path, status)
    running_job(tree.runs_dir, "cites", 10 * 60)  # its brief says A-006
    nocite = tree.runs_dir / "nocite"
    write(nocite / "brief.md", "JOB: nocite (Opus high)\n")
    snapshot = build_snapshot(tree, FileCache())
    assert snapshot["ops"]["no_decision_id"] == ["nocite"]
    assert snapshot["status"]["decision_log"]["A-001"]["text"] == "inbox cleanup."


# ---------- 16. branch hygiene ----------


def test_merged_branches_and_old_uncommitted_work_are_listed_not_touched(tmp_path):
    repo = repo_with_commit(tmp_path / "VADER", time.time() - 3 * 86400)
    git(repo, "branch", "claude/merged-one")
    git(repo, "checkout", "-q", "-b", "claude/open-work")
    (repo / "b.txt").write_text("b")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "open work")
    git(repo, "checkout", "-q", "main")
    (repo / "a.txt").write_text("edited, never committed")
    old = time.time() - 2 * 86400
    os.utime(repo / "a.txt", (old, old))
    heads_before = git(repo, "for-each-ref", "--format=%(refname) %(objectname)")
    result = ops.branch_hygiene(repo, [], time.time())
    assert result["merged"] == ["claude/merged-one"]
    assert [(s["file"], s["where"]) for s in result["stale"]] == [("a.txt", "VADER")]
    assert git(repo, "for-each-ref", "--format=%(refname) %(objectname)") == heads_before  # nothing changed
    assert not (repo / ".git" / "index.lock").exists()


# ---------- 17. cross-machine conflicts ----------


def test_a_mac_job_and_a_windows_job_on_the_same_branch_conflict(tree):
    job = running_job(tree.runs_dir, "macjob", 5 * 60)
    wt = repo_with_commit(job / "wt", time.time() - 60, branch="claude/issues-tab")
    folders = [{"id": "macjob", "state": "running", "path": str(job)}]
    remote = [{"id": "winjob", "machine": "WINDOWS", "state": "running"}]
    messages = [{"ref": {"job": "winjob"}, "text": "winjob: finish tests on claude/issues-tab (Opus high)"}]
    found = ops.cross_machine_conflicts(folders, remote, messages)
    assert [(c["mac"], c["windows"], c["same"]) for c in found] == [("macjob", "winjob", ["claude/issues-tab"])]
    assert ops.cross_machine_conflicts(folders, remote, [{"ref": {"job": "winjob"}, "text": "other work"}]) == []
    assert wt.exists()


# ---------- 18. daily digest ----------


def test_the_daily_digest_is_a_dated_file_in_the_brains_folder(tree):
    files = BrainFiles(tree.brain_dir)
    Recorder(files).record(build_snapshot(tree, FileCache()))
    day = datetime.now().astimezone().date().isoformat()
    text = (tree.brain_dir / f"digest-{day}.md").read_text()
    for heading in ("## Done", "## Blocked or stalled", "## Waiting on Anthony", "## Lessons proposed"):
        assert heading in text
