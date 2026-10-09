"""Part 1, guardrails: recheck before alerting, one alert per state, no placeholders, know the machine,
only ask Anthony when needed, and the Brain writes only in its own folder."""

import json
import os
import subprocess
import time
from pathlib import Path

import pytest

from brain import gitread
from brain.brainfiles import BrainFiles, WriteRefusedError
from brain.effects import Recorder
from brain.guard import decision_item, placeholders
from brain.labels import order_action
from brain.machines import read_heartbeat, remote_jobs
from brain.readers import FileCache, iso
from brain.server import BrainState
from brain.snapshot import build_snapshot

from conftest import write

HOUR = 3600
BRIEF = "JOB: claudemd step 2 (Opus high)\n\nSteps...\n"


def stuck_job(runs: Path, name: str = "claudemd", report_age_s: float = HOUR) -> Path:
    job = runs / name
    write(job / "brief.md", BRIEF, age_s=report_age_s)
    write(
        job / "runs.log",
        "start 2026-10-09 13:00:00 EDT iter 1 pid 1 prompt p model opus effort high\n"
        "end 2026-10-09 13:20:00 EDT iter 1 exit 0\n",
        age_s=report_age_s,
    )
    write(job / "iter-1.jsonl", "{}\n", age_s=report_age_s)
    write(job / "iter-1.done", "", age_s=report_age_s)
    write(job / "REPORT.md", "TO MAC: BLOCKED danger_guard, not committed\n", age_s=report_age_s)
    return job


def git_commit(repo: Path, when: float, message: str = "work") -> str:
    env = {
        **os.environ,
        "GIT_AUTHOR_DATE": f"@{int(when)} +0000",
        "GIT_COMMITTER_DATE": f"@{int(when)} +0000",
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@t",
    }
    (repo / f"f{when}.txt").write_text(message)
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True, env=env, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-qm", message], check=True, env=env, capture_output=True)
    return subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True
    ).stdout.strip()


def make_worktree(job: Path) -> Path:
    wt = job / "wt"
    wt.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main", str(wt)], check=True, capture_output=True)
    return wt


def backdate(path: Path, age_s: float = 2 * HOUR) -> None:
    """The worktree existed before the report (a new folder entry would read as MAC following up)."""
    ts = time.time() - age_s
    os.utime(path, (ts, ts))


@pytest.fixture(autouse=True)
def fresh_git_cache():
    gitread.clear_cache()
    yield
    gitread.clear_cache()


def snap_and_record(tree, files: BrainFiles):
    snapshot = build_snapshot(tree, FileCache())
    counts = Recorder(files).record(snapshot)
    return snapshot, counts


# ---------- 1. recheck before alerting ----------


def test_a_job_committed_in_its_worktree_after_the_report_is_resolved_silently(tree, tmp_path):
    job = stuck_job(tree.runs_dir)
    wt = make_worktree(job)
    git_commit(wt, time.time() - 2 * HOUR, "before the report")
    sha = git_commit(wt, time.time() - 60, "step 2 after Anthony's approval")
    backdate(wt)
    files = BrainFiles(tmp_path / "brainfolder")
    snapshot, counts = snap_and_record(tree, files)
    claudemd = next(j for j in snapshot["folders"] if j["id"] == "claudemd")
    assert claudemd["state"] == "cleared"
    assert claudemd["followed_up_by"].startswith(f"git: {sha[:7]} merged into main")
    assert not any(a["id"] == "claudemd" for a in snapshot["attention"])
    assert counts["clears"] == 1
    assert "claudemd" not in [r["job"] for r in files.records("alerts.jsonl")]


def test_a_commit_from_before_the_report_is_not_proof(tree, tmp_path):
    job = stuck_job(tree.runs_dir)
    wt = make_worktree(job)
    git_commit(wt, time.time() - 2 * HOUR)
    backdate(wt)
    files = BrainFiles(tmp_path / "b")
    snapshot, _ = snap_and_record(tree, files)
    assert next(j for j in snapshot["folders"] if j["id"] == "claudemd")["state"] == "blocked"
    assert [r["job"] for r in files.records("alerts.jsonl")].count("claudemd") == 1


def test_a_settled_decision_naming_the_job_resolves_it(tree, tmp_path):
    stuck_job(tree.runs_dir)
    status = tree.status_path.read_text().replace(
        "- **Push/merge `claude/restyle-rework`**. Needs Proceed.",
        "- ~~claudemd step 2 commit~~ DONE 14:00 Oct 9: committed f1d2a32 (A-003).",
    )
    write(tree.status_path, status)  # written now, after the report
    snapshot, _ = snap_and_record(tree, BrainFiles(tmp_path / "b"))
    job = next(j for j in snapshot["folders"] if j["id"] == "claudemd")
    assert job["state"] == "cleared" and job["followed_up_by"].startswith("STATUS.md decision:")


# ---------- 2. one alert per job state ----------


def test_the_same_state_alerts_once_and_a_new_report_alerts_again(tree, tmp_path):
    stuck_job(tree.runs_dir)
    files = BrainFiles(tmp_path / "b")

    def alerts_for_job():
        return [r for r in files.records("alerts.jsonl") if r["job"] == "claudemd"]

    snap_and_record(tree, files)
    _, second = snap_and_record(tree, files)
    assert len(alerts_for_job()) == 1 and second["alerts"] == 0
    # Each call builds a new Recorder, like a restart: it still remembers.
    write(tree.runs_dir / "claudemd" / "REPORT.md", "TO MAC: BLOCKED tests fail now\n", age_s=60)
    _, third = snap_and_record(tree, files)
    assert third["alerts"] == 1 and len(alerts_for_job()) == 2
    audit = [r for r in files.records("audit.jsonl") if r["event"] == "alert" and r["job"] == "claudemd"]
    assert len(audit) == 2


# ---------- 3. no empty templates ----------


def test_a_placeholder_never_becomes_a_title_and_the_bug_is_logged_once(tree, tmp_path):
    job = tree.runs_dir / "deathstarmotion"
    write(
        job / "brief.md",
        "HANDOFF READ: VADER deathstar-motion | STATUS sha256={{STATUS_SHA12}}\n"
        "<handoff>x</handoff>\n{{STATUS_MD}}\n\nJOB: Death Star motion pass (Opus high)\n",
    )
    files = BrainFiles(tmp_path / "b")
    snapshot, counts = snap_and_record(tree, files)
    found = next(j for j in snapshot["folders"] if j["id"] == "deathstarmotion")
    assert "{{" not in found["title"] and found["title"] == "deathstarmotion: Death Star motion pass (Opus high)"
    assert found["placeholders"] == ["STATUS_SHA12", "STATUS_MD"]
    assert counts["bugs"] == 1
    _, again = snap_and_record(tree, files)
    assert again["bugs"] == 0
    assert placeholders("plain text") == []


def test_a_placeholder_brief_with_no_task_line_uses_its_own_heading(tree):
    brief = "LINE {{STATUS_SHA12}}\n<handoff>\n# VADER deathstar-motion\n</handoff>\n{{STATUS_MD}}\n"
    write(tree.runs_dir / "dsm" / "brief.md", brief)
    found = next(j for j in build_snapshot(tree, FileCache())["folders"] if j["id"] == "dsm")
    assert found["title"] == "dsm: VADER deathstar-motion"


def test_a_brief_that_is_only_placeholders_falls_back_to_the_folder_name(tree):
    write(tree.runs_dir / "emptybrief" / "brief.md", "{{STATUS_MD}}\n")
    found = next(j for j in build_snapshot(tree, FileCache())["folders"] if j["id"] == "emptybrief")
    assert found["title"] == "emptybrief"


# ---------- 4. know the machine ----------


def beat(runs: Path, **fields) -> None:
    write(runs / "_xfer" / "win" / "heartbeat.json", json.dumps(fields))


def started(job: str, machine: str, at: str = "2026-10-09T18:42:52+00:00") -> dict:
    return {"ref": {"job": job}, "at": at, "mac_kind": "job_started", "machine": machine, "text": f"{job} (Opus high)"}


def test_a_windows_job_takes_its_state_from_the_heartbeat(tree):
    now = time.time()
    beat(tree.runs_dir, at=iso(now - 30), job="topics15", job_state="running", last_log_line="writing topic 9")
    hb = read_heartbeat(tree.runs_dir, now)
    assert hb["fresh"] and hb["job"] == "topics15"
    jobs = {
        j["id"]: j for j in remote_jobs([started("topics15", "windows"), started("sopverify", "windows")], [], hb, now)
    }
    assert (jobs["topics15"]["machine"], jobs["topics15"]["state"], jobs["topics15"]["source"]) == (
        "WINDOWS",
        "running",
        "Windows heartbeat",
    )
    assert jobs["sopverify"]["state"] == "stopped"  # Windows is busy with another job


def test_without_a_fresh_heartbeat_a_windows_job_says_so(tree):
    now = time.time()
    beat(tree.runs_dir, at=iso(now - 3 * HOUR), job="topics15", job_state="running")
    jobs = remote_jobs([started("topics15", "windows")], [], read_heartbeat(tree.runs_dir, now), now)
    assert jobs[0]["state"] == "running" and "no fresh Windows heartbeat" in jobs[0]["source"]
    assert read_heartbeat(tree.runs_dir / "nowhere", now)["found"] is False


def test_mac_jobs_are_labelled_mac_and_a_stopped_folder_beats_the_log(tree):
    stuck_job(tree.runs_dir, "brainhooks")
    snapshot = build_snapshot(tree, FileCache())
    assert {j["machine"] for j in snapshot["folders"] + snapshot["oneshots"]} == {"MAC"}
    jobs = remote_jobs([started("brainhooks", "mac")], snapshot["folders"], {"found": False}, time.time())
    assert jobs == []  # MAC never logged the finish, but the folder here has stopped


# ---------- 5. only ask Anthony when needed ----------


def test_a_confirm_done_item_never_reaches_anthony():
    item = decision_item("**Confirm wofix is done**: CodeRabbit findings fixed on claude/wofix")
    assert (item["route"], item["via"]) == ("mac", "MAC (VADER c3)")
    order = {
        "state": "OPEN",
        "title": "WO #019 - wofix",
        "status_text": "OPEN, waiting on Anthony to confirm the fix is done",
        "body": "",
        "replies": [],
    }
    result = order_action(order)
    assert result["action"] != "needs_anthony" and result["action_who"] == "MAC"


def test_approvals_point_to_vader_approvals_and_keep_their_ids():
    item = decision_item("**SOP pack approval** (Q10 SOP, Q11 trial WO #023), see A-002")
    assert (item["route"], item["via"], item["ids"]) == ("anthony", "VADER Approvals", ["A-002"])
    assert decision_item("~~Push/merge x~~ DONE 09:00 Oct 9")["settled"] is True


# ---------- the Brain writes only in its own folder ----------


@pytest.mark.parametrize(
    "name", ["../escape.jsonl", "/etc/passwd", "comms.jsonl", "STATUS.md", ".hidden.jsonl", "notes.txt"]
)
def test_the_brain_refuses_any_file_but_its_own(tmp_path, name):
    files = BrainFiles(tmp_path / "brain")
    with pytest.raises(WriteRefusedError):
        files.path(name)


def test_the_brain_never_writes_through_a_symlink(tmp_path):
    folder = tmp_path / "brain"
    folder.mkdir()
    (folder / "audit.jsonl").symlink_to(tmp_path / "elsewhere.jsonl")
    with pytest.raises(WriteRefusedError):
        BrainFiles(folder).append("audit.jsonl", {"x": 1})
    assert not (tmp_path / "elsewhere.jsonl").exists()


def test_a_refresh_writes_only_inside_the_brains_folder(tree):
    stuck_job(tree.runs_dir)
    root = tree.runs_dir.parent

    def tree_state():
        return {p: p.stat().st_mtime_ns for p in root.rglob("*") if p.is_file()}

    before = tree_state()
    state = BrainState(tree)
    state.refresh(force=True)
    state.refresh(force=True)
    after = tree_state()
    changed = {p for p in after if before.get(p) != after[p]}
    assert changed, "the refresh should have recorded something"
    assert all(p.parent == tree.brain_dir for p in changed), sorted(map(str, changed))
    assert not (tree.brain_dir / "comms.jsonl").exists()
    assert all(before[p] == after[p] for p in before)  # nothing that existed was touched
