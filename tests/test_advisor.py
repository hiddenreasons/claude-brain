"""Part 4, flow monitor and advisor for MAC: findings, one recommendation each, MAC's status kept, and
whether applied ones helped."""

import time
from datetime import datetime, timedelta

from brain import flow
from brain.advisor import Advisor, judge, read_statuses, rec_id
from brain.brainfiles import BrainFiles
from brain.effects import Recorder
from brain.readers import FileCache, iso
from brain.snapshot import build_snapshot

from conftest import write

HOUR = 3600


def idle_mac_with_a_queue(tree) -> None:
    """The last job ended 30 min ago, nothing runs, and a brief sits ready."""
    job = tree.runs_dir / "finished"
    write(job / "brief.md", "JOB: finished (A-006)\n", age_s=2 * HOUR)
    write(
        job / "runs.log",
        "start 2026-10-09 13:00:00 EDT iter 1 pid 1 prompt p model opus effort high\n"
        "end 2026-10-09 13:20:00 EDT iter 1 exit 0\n",
        age_s=30 * 60,
    )
    write(job / "iter-1.jsonl", "{}\n", age_s=30 * 60)
    write(job / "iter-1.done", "", age_s=30 * 60)
    write(job / "REPORT.md", "TO MAC: DONE. Committed abc1234.\n", age_s=30 * 60)
    write(tree.runs_dir / "nextup" / "brief.md", "JOB: nextup (A-006, Opus high)\n", age_s=20 * 60)


def test_an_idle_machine_with_a_queue_creates_one_recommendation(tree):
    idle_mac_with_a_queue(tree)
    snapshot = build_snapshot(tree, FileCache())
    keys = [f["key"] for f in snapshot["flow"]["findings"]]
    assert "idle-with-queue:MAC" in keys
    files = BrainFiles(tree.brain_dir)
    for _ in range(3):  # three refreshes, one recommendation
        Recorder(files).record(build_snapshot(tree, FileCache()))
    recs = [r for r in files.records("recommendations.jsonl") if r["key"] == "idle-with-queue:MAC"]
    assert len(recs) == 1 and recs[0]["id"] == rec_id("idle-with-queue:MAC")
    page = (tree.brain_dir / "RECOMMENDATIONS.md").read_text()
    assert f"### {recs[0]['id']}" in page and "**Status:** open" in page
    assert "nothing here has been done" in page


def test_macs_status_edit_is_kept_and_recorded_once(tree):
    idle_mac_with_a_queue(tree)
    files = BrainFiles(tree.brain_dir)
    Recorder(files).record(build_snapshot(tree, FileCache()))
    rid = rec_id("idle-with-queue:MAC")
    page = (tree.brain_dir / "RECOMMENDATIONS.md").read_text()
    head = page.index(f"### {rid}")
    status_at = page.index("**Status:** open", head)
    edited = (
        page[:status_at]
        + "**Status:** applied 2026-10-01 launched by MAC"
        + page[status_at + len("**Status:** open") :]
    )
    (tree.brain_dir / "RECOMMENDATIONS.md").write_text(edited)
    Recorder(files).record(build_snapshot(tree, FileCache()))
    Recorder(files).record(build_snapshot(tree, FileCache()))
    assert read_statuses((tree.brain_dir / "RECOMMENDATIONS.md").read_text())[rid]["status"] == "applied"
    trail = [r for r in files.records("audit.jsonl") if r["event"] == "recommendation" and r["job"] == rid]
    assert len(trail) == 1 and trail[0]["who"] == "MAC"


def test_whether_an_applied_recommendation_helped():
    now = datetime.now().astimezone()
    applied = now - timedelta(days=4)
    samples = [
        {"at": (applied - timedelta(days=d)).isoformat(), "measures": {"idle_with_queue_min": 60}} for d in (1, 2, 3)
    ]
    samples += [{"at": (applied + timedelta(days=d)).isoformat(), "measures": {}} for d in (1, 2, 3)]
    assert judge({"metric": "idle_with_queue_min"}, applied, samples, now)["verdict"] == "helped"
    assert judge({"metric": "idle_with_queue_min"}, now - timedelta(hours=5), samples, now)["verdict"] == "too early"
    worse = [dict(s, measures={"idle_with_queue_min": 10 if s["at"] < applied.isoformat() else 50}) for s in samples]
    assert judge({"metric": "idle_with_queue_min"}, applied, worse, now)["verdict"] == "worse"


def snap(**parts):
    base = {"folders": [], "oneshots": [], "inbox": [], "remote_jobs": [], "windows": {}, "windows_box": {}}
    base.update(parts)
    return base


def test_the_same_failure_twice_is_one_finding():
    now = time.time()
    jobs = [
        {
            "id": n,
            "kind": "folder",
            "state": "blocked",
            "updated_at": iso(now - HOUR),
            "report_headline": "TO MAC: BLOCKED pre-commit hook failed in the sandbox",
        }
        for n in ("a", "b")
    ]
    s = snap(folders=jobs)
    found = flow.findings(s, flow.metrics(s, now), now)
    rep = [f for f in found if f["kind"] == "repeated-failure"]
    assert len(rep) == 1 and rep[0]["jobs"] == ["a", "b"] and rep[0]["signature"] == "pre-commit hook in the sandbox"
    s1 = snap(folders=jobs[:1])
    assert not [f for f in flow.findings(s1, flow.metrics(s1, now), now) if f["kind"] == "repeated-failure"]


def test_a_heavy_job_holding_up_light_ones():
    now = time.time()
    s = snap(
        folders=[
            {
                "id": "big",
                "kind": "folder",
                "lifecycle": "running",
                "state": "running",
                "state_since": iso(now - 2 * HOUR),
            }
        ],
        inbox=[
            {
                "id": "w1",
                "wo": 22,
                "action": "queued",
                "state": "OPEN",
                "title": "Small fix: one-line typo",
                "status_text": "OPEN",
            }
        ],
    )
    found = [f["key"] for f in flow.findings(s, flow.metrics(s, now), now)]
    assert "heavy-blocks-light:big" in found


def test_windows_idle_with_a_queue_unless_it_is_not_accepting_jobs():
    now = time.time()
    box = {
        "found": True,
        "offline": False,
        "jobs": [{"name": "04-wo001", "state": "READY"}],
        "accepting": {"known": True, "yes": True},
    }
    s = snap(windows={"found": True, "running_jobs": [], "recent": []}, windows_box=box)
    assert "idle-with-queue:WINDOWS" in [f["key"] for f in flow.findings(s, flow.metrics(s, now), now)]
    s["windows_box"] = {**box, "accepting": {"known": True, "yes": False}}
    assert "idle-with-queue:WINDOWS" not in [f["key"] for f in flow.findings(s, flow.metrics(s, now), now)]


def test_the_advisor_only_writes_its_own_files(tree):
    idle_mac_with_a_queue(tree)
    before = {p for p in tree.runs_dir.rglob("*") if p.is_file()}
    Recorder(BrainFiles(tree.brain_dir)).record(build_snapshot(tree, FileCache()))
    new = {p for p in tree.runs_dir.rglob("*") if p.is_file()} - before
    assert new and all(p.parent == tree.brain_dir for p in new)
    assert Advisor(BrainFiles(tree.brain_dir)).recommendations(datetime.now().astimezone())


def test_the_weekly_report_lists_applied_recommendations(tree):
    idle_mac_with_a_queue(tree)
    files = BrainFiles(tree.brain_dir)
    Recorder(files).record(build_snapshot(tree, FileCache()))
    year, week, _ = datetime.now().astimezone().isocalendar()
    text = (tree.brain_dir / f"weekly-{year}-W{week:02d}.md").read_text()
    assert "## Applied recommendations (0)" in text and "nothing was changed" in text
