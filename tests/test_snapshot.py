import hashlib
import os

from brain.mac_runs import job_detail
from brain.readers import FileCache
from brain.snapshot import build_attention, build_snapshot, fingerprint
from brain.status_files import parse_issues, parse_status

from conftest import result_json, write

HOUR = 3600


def tree_digest(*roots):
    """Content and mtime of every file under the roots: proves nothing was written or touched."""
    h = hashlib.sha256()
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            for name in sorted(filenames):
                path = os.path.join(dirpath, name)
                st = os.stat(path)
                h.update(f"{path}:{st.st_mtime_ns}:{st.st_size}:".encode())
                with open(path, "rb") as f:
                    h.update(f.read())
            h.update(f"{dirpath}:{sorted(dirnames)}".encode())
    return h.hexdigest()


def test_status_decisions_fold_sub_bullets_and_changelog_is_newest_first(tree):
    status = parse_status((tree.runs_dir / "STATUS.md").read_text())
    assert status["decisions"] == [
        "**Push/merge `claude/restyle-rework`**. Needs Proceed.",
        "**CLAUDE.md edits**: - line 29 model rule",
    ]
    assert status["changelog"][0].startswith("2026-10-09 10:44")
    assert status["running_note"] == "Nothing running."
    assert parse_status(None) == {"decisions": [], "changelog": [], "running_note": None}


def test_issues_read_table_rows_and_headings_newest_first(tree):
    issues = parse_issues((tree.runs_dir / "ISSUES-LOG.md").read_text())
    assert issues[0]["what"] == "Claude bypassed its sandbox (logged by VADER c3)"
    assert issues[1] == {"date": "2026-10-08", "job": "layoutcodex", "what": "The job ran 84 times.", "prevented": "no"}
    assert parse_issues("") == []


def test_snapshot_shape_and_attention(tree):
    write(tree.runs_dir / "msgx.txt", "Order")
    write(tree.runs_dir / "outx.json", result_json(is_error=True))
    snap = build_snapshot(tree, FileCache())
    assert snap["sources"]["inbox"]["exists"] is True
    assert snap["oneshot_total"] == 1
    states = sorted((a["source"], a["state"]) for a in snap["attention"])
    # The blocked work order from the inbox, and the errored one-shot job.
    assert states == [("job", "error"), ("work_order", "BLOCKED")]
    blocked = next(a for a in snap["attention"] if a["source"] == "work_order")
    assert blocked["detail"].startswith("BLOCKED needs a code look")


def test_old_problems_are_history_not_alerts(tree):
    write(tree.runs_dir / "msgold.txt", "Order", age_s=100 * HOUR)
    write(tree.runs_dir / "outold.json", result_json(is_error=True), age_s=100 * HOUR)
    snap = build_snapshot(tree, FileCache())
    assert not any(a.get("id") == "old" for a in snap["attention"])


def test_attention_ignores_finished_and_followed_up_jobs():
    folders = [
        {"id": "a", "state": "done", "updated_at": None, "title": "a", "report_headline": None},
        {"id": "b", "state": "followed_up", "updated_at": None, "title": "b", "report_headline": None},
    ]
    assert build_attention([], folders, [], now=0) == []


def test_fingerprint_changes_when_any_source_changes(tree):
    first = fingerprint(tree)
    assert fingerprint(tree) == first
    write(tree.runs_dir / "sop" / "iter-1.jsonl", "{}\n")
    second = fingerprint(tree)
    assert second != first
    with open(tree.inbox_path, "a", encoding="utf-8") as f:
        f.write("\n## OPEN — 2026-10-10 · New\n")
    assert fingerprint(tree) != second


def test_missing_sources_are_reported_not_fatal(tmp_path):
    from brain.config import Config

    cfg = Config(vader_dir=tmp_path / "no-vader", runs_dir=tmp_path / "no-runs")
    snap = build_snapshot(cfg, FileCache())
    assert snap["sources"]["inbox"]["exists"] is False
    assert snap["inbox"] == [] and snap["folders"] == [] and snap["attention"] == []


def test_reading_everything_changes_nothing_on_disk(tree):
    write(tree.runs_dir / "msg1.txt", "Order")
    write(tree.runs_dir / "out1.json", result_json())
    write(tree.runs_dir / "job" / "brief.md", "JOB: x")
    write(tree.runs_dir / "job" / "iter-1.jsonl", "{}\n")
    before = tree_digest(tree.vader_dir, tree.runs_dir)
    build_snapshot(tree, FileCache())
    fingerprint(tree)
    job_detail(tree.runs_dir, "oneshot", "1")
    job_detail(tree.runs_dir, "folder", "job")
    assert tree_digest(tree.vader_dir, tree.runs_dir) == before
