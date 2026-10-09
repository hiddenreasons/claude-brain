"""Part 5, self-learning: post-mortems, proposed lessons (drafts only until approved), weekly stats, and
history that is never deleted."""

import json
from datetime import datetime, timedelta

from brain import learning
from brain.brainfiles import BrainFiles
from brain.effects import Recorder
from brain.readers import FileCache
from brain.snapshot import build_snapshot

from conftest import write

HOUR = 3600
RUNLOG = (
    "start 2026-10-09 13:00:00 EDT iter 1 pid 1 prompt p model opus effort high\n"
    "end 2026-10-09 13:20:00 EDT iter 1 exit 0\n"
)


def finished_job(runs, name, report, age_s=HOUR):
    job = runs / name
    write(job / "brief.md", f"JOB: {name} (A-006, Opus high)\n", age_s=age_s)
    write(job / "runs.log", RUNLOG, age_s=age_s)
    write(job / "iter-1.jsonl", "{}\n", age_s=age_s)
    write(job / "iter-1.done", "", age_s=age_s)
    write(job / "REPORT.md", report, age_s=age_s)
    return job


def two_guard_blocks(tree):
    for name in ("alpha", "bravo"):
        finished_job(tree.runs_dir, name, "TO MAC: BLOCKED danger_guard, not committed\n")


def record(tree, files, times=1):
    snapshot = None
    for _ in range(times):
        snapshot = build_snapshot(tree, FileCache())
        Recorder(files).record(snapshot)
    return snapshot


def set_status(tree, lid, status):
    page = tree.brain_dir / "PROPOSED-LESSONS.md"
    text = page.read_text()
    head = text.index(f"### {lid}")
    at = text.index("**Status:** proposed", head)
    page.write_text(text[:at] + f"**Status:** {status} by MAC 2026-10-09" + text[at + len("**Status:** proposed") :])


def test_a_repeated_failure_creates_one_proposal(tree):
    two_guard_blocks(tree)
    files = BrainFiles(tree.brain_dir)
    record(tree, files, times=3)
    lessons = [r for r in files.records("lessons.jsonl") if r["kind"] == "failure"]
    assert len(lessons) == 1
    assert lessons[0]["id"] == learning.lesson_id("failure:danger_guard hold")
    assert "alpha" in lessons[0]["evidence"] and "bravo" in lessons[0]["evidence"]
    page = (tree.brain_dir / "PROPOSED-LESSONS.md").read_text()
    assert f"### {lessons[0]['id']}" in page and "**Status:** proposed" in page
    assert sum(1 for r in files.records("audit.jsonl") if r["event"] == "proposal") == 1


def test_one_failure_is_not_a_pattern(tree):
    finished_job(tree.runs_dir, "alpha", "TO MAC: BLOCKED danger_guard, not committed\n")
    files = BrainFiles(tree.brain_dir)
    record(tree, files)
    assert files.records("lessons.jsonl") == []


def test_an_unapproved_proposal_changes_nothing(tree):
    two_guard_blocks(tree)
    files = BrainFiles(tree.brain_dir)
    snapshot = record(tree, files, times=2)
    assert not any(j.get("known_issue") for j in snapshot["folders"])
    assert snapshot["learning"]["approved"] == [] and len(snapshot["learning"]["proposed"]) == 1
    lid = snapshot["learning"]["proposed"][0]["id"]
    set_status(tree, lid, "declined")
    snapshot = record(tree, files)
    assert not any(j.get("known_issue") for j in snapshot["folders"])
    set_status_text = (tree.brain_dir / "PROPOSED-LESSONS.md").read_text()
    assert "**Status:** declined by MAC 2026-10-09" in set_status_text  # MAC's edit is kept


def test_an_approved_known_issue_lesson_labels_matching_blocked_jobs(tree):
    two_guard_blocks(tree)
    files = BrainFiles(tree.brain_dir)
    record(tree, files)
    lid = learning.lesson_id("failure:danger_guard hold")
    set_status(tree, lid, "approved")
    snapshot = record(tree, files)
    blocked = [j for j in snapshot["folders"] if j["id"] in ("alpha", "bravo")]
    assert blocked and all(j.get("known_issue", "").startswith(lid) for j in blocked)
    trail = [r for r in files.records("audit.jsonl") if r["event"] == "lesson" and r["job"] == lid]
    assert len(trail) == 1 and trail[0]["change"].startswith("approved")
    record(tree, files)
    assert len([r for r in files.records("audit.jsonl") if r["event"] == "lesson"]) == 1


def grace_lesson(files, status):
    lid = learning.lesson_id("false-alert:danger_guard hold")
    files.append(
        "lessons.jsonl",
        {
            "id": lid,
            "key": "false-alert:danger_guard hold",
            "kind": "false-alert",
            "signature": "danger_guard hold",
            "title": "2 alerts on 'danger_guard hold' cleared within 15 min",
            "evidence": "jobs: x, y",
            "draft": "Brain: hold alerts on 'danger_guard hold' for 15 min and recheck before alerting.",
            "effect": "grace",
        },
    )
    files.write("PROPOSED-LESSONS.md", f"### {lid} · false-alert · t\n\n- **Status:** {status}\n")
    return lid


def alerts_for(files, job):
    return [r for r in files.records("alerts.jsonl") if r.get("job") == job]


def test_an_approved_grace_lesson_holds_a_fresh_alert_and_a_draft_does_not(tree):
    finished_job(tree.runs_dir, "fresh", "TO MAC: BLOCKED danger_guard, not committed\n", age_s=60)
    held_files = BrainFiles(tree.brain_dir / "held")
    lid = grace_lesson(held_files, "approved")
    snapshot = build_snapshot(tree, FileCache())
    Recorder(held_files).record(snapshot)
    assert alerts_for(held_files, "fresh") == []
    assert any(a.get("held_by") == lid for a in snapshot["attention"] if a["id"] == "fresh")

    draft_files = BrainFiles(tree.brain_dir / "draft")
    grace_lesson(draft_files, "proposed")
    Recorder(draft_files).record(build_snapshot(tree, FileCache()))
    assert len(alerts_for(draft_files, "fresh")) == 1


def test_the_grace_hold_ends_after_15_minutes(tree):
    finished_job(tree.runs_dir, "older", "TO MAC: BLOCKED danger_guard, not committed\n", age_s=20 * 60)
    files = BrainFiles(tree.brain_dir)
    grace_lesson(files, "approved")
    Recorder(files).record(build_snapshot(tree, FileCache()))
    assert len(alerts_for(files, "older")) == 1


def test_a_post_mortem_is_written_once_per_resolved_job(tree):
    finished_job(tree.runs_dir, "shipped", "TO MAC: DONE. Committed abc1234 on claude/x. Tests 12 passed.\n")
    files = BrainFiles(tree.brain_dir)
    record(tree, files, times=3)
    pms = [r for r in files.records("learning.jsonl") if r.get("job") == "shipped"]
    assert len(pms) == 1
    assert pms[0]["kind"] == "postmortem" and pms[0]["happened"] and pms[0]["slowed"] and pms[0]["fixed"]
    log = (tree.brain_dir / "LEARNING-LOG.md").read_text()
    assert "## shipped" in log and "**What slowed it:**" in log


def test_alerts_cleared_within_15_minutes_twice_become_a_false_alert_proposal():
    t0 = datetime(2026, 10, 9, 12, 0).astimezone()
    alerts = [
        {"at": (t0 + timedelta(hours=h)).isoformat(), "job": j, "state": "blocked", "title": "danger_guard"}
        for h, j in ((0, "a"), (2, "b"))
    ]
    audit = [
        {"at": (t0 + timedelta(hours=h, minutes=5)).isoformat(), "event": "clear", "job": j}
        for h, j in ((0, "a"), (2, "b"))
    ]
    out = learning.proposals([], alerts, audit)
    assert [(p["kind"], p["signature"], p["effect"]) for p in out] == [("false-alert", "danger_guard hold", "grace")]
    late = [dict(c, at=(t0 + timedelta(hours=i * 2, minutes=40)).isoformat()) for i, c in enumerate(audit)]
    assert learning.proposals([], alerts, late) == []


def test_weekly_stats_count_false_and_duplicate_alerts_and_time_to_clear():
    now = datetime(2026, 10, 9, 18, 0).astimezone()
    at = lambda h, m=0: (now - timedelta(hours=h) + timedelta(minutes=m)).isoformat()  # noqa: E731
    alerts = [
        {"at": at(10), "job": "a", "state": "blocked"},
        {"at": at(8), "job": "a", "state": "blocked"},  # duplicate state
        {"at": at(5), "job": "b", "state": "stalled"},
        {"at": at(24 * 9), "job": "old", "state": "blocked"},  # outside the week
    ]
    audit = [
        {"at": at(10, 5), "event": "clear", "job": "a"},  # 5 min: a false alert
        {"at": at(4), "event": "clear", "job": "b"},  # 60 min
    ]
    stats = learning.weekly_stats(alerts, audit, now)
    assert stats["alerts"] == 3 and stats["duplicates"] == 1 and stats["false_alerts"] == 1
    assert stats["median_clear_min"] is not None


def test_history_is_append_only_and_stays_in_the_brains_folder(tree):
    two_guard_blocks(tree)
    finished_job(tree.runs_dir, "shipped", "TO MAC: DONE. Committed abc1234.\n")
    files = BrainFiles(tree.brain_dir)
    before = {p for p in tree.runs_dir.rglob("*") if p.is_file()}
    record(tree, files)
    lines = {n: (tree.brain_dir / n).read_text().splitlines() for n in ("learning.jsonl", "lessons.jsonl")}
    (tree.runs_dir / "alpha" / "REPORT.md").unlink()  # the job's folder changes; history must not
    record(tree, files, times=2)
    for name, old in lines.items():
        now = (tree.brain_dir / name).read_text().splitlines()
        assert now[: len(old)] == old, name
        assert all(json.loads(line) for line in now)
    new = {p for p in tree.runs_dir.rglob("*") if p.is_file()} - before
    assert new and all(p.parent == tree.brain_dir for p in new)
