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
    assert parse_status(None) == {
        "decisions": [],
        "decision_items": [],
        "decision_log": {},
        "changelog": [],
        "entries": [],
        "running_note": None,
    }


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


def _stuck_job(tree, name, report_age_s):
    job = tree.runs_dir / name
    write(job / "brief.md", f"JOB: {name} task", age_s=report_age_s)
    write(
        job / "runs.log",
        "start 2026-10-09 09:01:03 EDT iter 1 pid 1 prompt p model opus effort high\n",
        age_s=report_age_s,
    )
    write(job / "iter-1.jsonl", "{}\n", age_s=report_age_s)
    write(job / "iter-1.done", "", age_s=report_age_s)
    write(job / "REPORT.md", "TO MAC: BLOCKED danger_guard, not committed\n", age_s=report_age_s)


def _status_with(tree, *entries):
    body = "# STATUS\n\n## 5. Open decisions awaiting Anthony\n\n- One.\n\n## 6. Change log\n\n"
    write(tree.status_path, body + "".join(f"- {e}\n" for e in entries))


def _local(minutes_ago):
    from datetime import datetime, timedelta

    return (datetime.now() - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%d %H:%M")


def test_dated_lines_mac_appends_below_a_later_heading_still_count_as_change_log():
    text = (
        "## 5. Open decisions awaiting Anthony\n\n- One.\n\n"
        "## 6. Change log\n\n- 2026-10-09 14:40 VADER c3: first.\n\n"
        "## Decision log (IDs)\n- A-001 2026-10-09 14:12: a decision, not a log line.\n"
        "- 2026-10-09 14:57 VADER c3: k38r cleared.\n"
    )
    status = parse_status(text)
    assert [e["text"] for e in status["entries"]] == [
        "2026-10-09 14:40 VADER c3: first.",
        "2026-10-09 14:57 VADER c3: k38r cleared.",
    ]
    assert status["changelog"][0] == "2026-10-09 14:57 VADER c3: k38r cleared."
    assert status["decisions"] == ["One."]


def test_a_stuck_job_clears_when_macs_change_log_says_it_was_fixed(tree):
    _stuck_job(tree, "claudemd", report_age_s=3600)
    _status_with(
        tree,
        f"{_local(50)} VADER c3: claudemd iter 2 ended, TO MAC: BLOCKED danger_guard. Awaiting Anthony.",
        f"{_local(10)} VADER c3: claudemd step 2 committed f1d2a32 (Anthony approved danger_guard).",
    )
    snap = build_snapshot(tree, FileCache())
    job = next(j for j in snap["folders"] if j["id"] == "claudemd")
    assert job["state"] == "cleared" and job["followed_up_by"].startswith("STATUS.md: ")
    assert not any(a.get("id") == "claudemd" for a in snap["attention"])
    assert "entries" not in snap["status"]  # internal only


def test_a_later_still_blocked_entry_keeps_it_stuck(tree):
    _stuck_job(tree, "claudemd", report_age_s=3600)
    _status_with(
        tree,
        f"{_local(40)} VADER c3: claudemd committed part 1.",
        f"{_local(5)} VADER c3: claudemd still BLOCKED, awaiting Anthony --approve.",
    )
    job = next(j for j in build_snapshot(tree, FileCache())["folders"] if j["id"] == "claudemd")
    assert job["state"] == "blocked"


def test_change_log_entries_before_the_report_do_not_clear_it(tree):
    _stuck_job(tree, "claudemd", report_age_s=600)
    _status_with(tree, f"{_local(60)} VADER c3: claudemd step 1 committed abc.")
    job = next(j for j in build_snapshot(tree, FileCache())["folders"] if j["id"] == "claudemd")
    assert job["state"] == "blocked"


def test_job_names_must_match_whole_words(tree):
    _stuck_job(tree, "fix", report_age_s=3600)
    _status_with(tree, f"{_local(5)} VADER c3: safetyfixes committed abc.")
    job = next(j for j in build_snapshot(tree, FileCache())["folders"] if j["id"] == "fix")
    assert job["state"] == "blocked"


def _comms(tree, *lines):
    import json as _json

    rows = []
    for i, (minutes_ago, kind, extra) in enumerate(lines):
        from datetime import datetime, timedelta, timezone

        at = (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
        row = {
            "v": 1,
            "id": f"c{i}",
            "at": at,
            "from": "mac",
            "to": "claude",
            "kind": kind,
            "text": "t",
            "job": "claudemd",
        }
        row.update(extra)
        rows.append(_json.dumps(row))
    write(tree.runs_dir / "brain" / "comms.jsonl", "\n".join(rows) + "\n")


def _job_state(tree):
    snap = build_snapshot(tree, FileCache())
    return next(j for j in snap["folders"] if j["id"] == "claudemd"), snap


def test_a_comms_unblocked_line_after_the_report_clears_it(tree):
    _stuck_job(tree, "claudemd", report_age_s=3600)
    _comms(tree, (5, "unblocked", {"text": "danger_guard approved, committed f1d2a32"}))
    job, snap = _job_state(tree)
    assert job["state"] == "cleared" and job["followed_up_by"].startswith("MAC (comms log): ")
    assert not any(a.get("id") == "claudemd" for a in snap["attention"])


def test_a_comms_unblocked_line_before_the_report_does_not_clear_it(tree):
    _stuck_job(tree, "claudemd", report_age_s=600)
    _comms(tree, (60, "unblocked", {}))
    assert _job_state(tree)[0]["state"] == "blocked"


def test_newest_word_wins_a_later_blocked_line_reopens(tree):
    _stuck_job(tree, "claudemd", report_age_s=3600)
    _comms(
        tree,
        (30, "unblocked", {}),
        (5, "blocked", {"from": "claude", "to": "mac", "text": "TO MAC: BLOCKED again"}),
    )
    assert _job_state(tree)[0]["state"] == "blocked"


def test_still_open_wording_does_not_clear(tree):
    for wording in ("still BLOCKED", "awaiting Anthony --approve", "commit pending review"):
        _stuck_job(tree, "claudemd", report_age_s=3600)
        _status_with(tree, f"{_local(5)} VADER c3: claudemd {wording}.")
        assert _job_state(tree)[0]["state"] == "blocked", wording


def test_resolved_jobs_never_raise_an_alert(tree):
    # MAC acted in the job folder after the BLOCKED report: followed up, so no alert.
    _stuck_job(tree, "claudemd", report_age_s=3600)
    write(tree.runs_dir / "claudemd" / "commit-final.log", "ok", age_s=600)
    job, snap = _job_state(tree)
    assert job["state"] == "followed_up"
    assert not any(a.get("id") == "claudemd" for a in snap["attention"])


def test_a_cleared_jobs_blocked_report_stays_in_history_marked_cleared(tree):
    from brain.messages import derive_messages

    _stuck_job(tree, "claudemd", report_age_s=3600)
    _status_with(tree, f"{_local(5)} VADER c3: claudemd step 2 committed f1d2a32.")
    snap = build_snapshot(tree, FileCache())
    report = next(m for m in derive_messages(snap) if m["id"] == "folder:claudemd:i1:report")
    assert report["blocked"] is True and report["cleared"] is True


def test_a_bare_mention_does_not_reopen_and_every_mention_counts(tree):
    # MAC's real 13:59 entry: the first mention has no status word, the second says resolved.
    _stuck_job(tree, "claudemd", report_age_s=3600)
    _status_with(
        tree,
        f"{_local(30)} VADER c3: claudemd step 2 committed f1d2a32.",
        f"{_local(5)} VADER c3: Queued brainclear. Also: claudemd alert at 13:55 was stale; "
        "claudemd step 2 committed f1d2a32 and merged fc34dcd, resolved.",
        f"{_local(2)} VADER c3: looked at claudemd notes again.",
    )
    assert _job_state(tree)[0]["state"] == "cleared"


# ---------- only real problems alert (Anthony, 2026-10-09) ----------


def _live_job(tree, name):
    job = tree.runs_dir / name
    write(job / "brief.md", f"JOB: {name} task")
    write(job / "runs.log", "start 2026-10-09 09:01:03 EDT iter 1 pid 1 prompt p model opus effort high\n")
    write(job / "iter-1.jsonl", '{"type":"assistant","message":{"content":[]}}\n')  # fresh log, not done


def test_a_running_job_with_a_fresh_log_never_alerts_or_gets_a_button(tree):
    _live_job(tree, "issuestab")
    snap = build_snapshot(tree, FileCache())
    job = next(j for j in snap["folders"] if j["id"] == "issuestab")
    assert job["state"] == "running"
    assert job["alertable"] is False
    assert not any(a.get("id") == "issuestab" for a in snap["attention"])


def test_a_waiting_oneshot_never_alerts_but_stalls_after_6h(tree):
    write(tree.runs_dir / "msgnew.txt", "Fresh order")
    write(tree.runs_dir / "msgold.txt", "Old order", age_s=7 * 3600)
    snap = build_snapshot(tree, FileCache())
    jobs = {j["id"]: j for j in snap["oneshots"]}
    assert (jobs["new"]["state"], jobs["new"]["alertable"]) == ("waiting", False)
    assert (jobs["old"]["state"], jobs["old"]["alertable"]) == ("stalled", True)
    alerts = {a["id"]: a for a in snap["attention"] if a["source"] == "job"}
    assert "new" not in alerts and alerts["old"]["state"] == "stalled"
    assert alerts["old"]["detail"] == "no result 6 h after MAC sent it"


def test_a_stalled_oneshot_clears_when_macs_change_log_says_so(tree):
    write(tree.runs_dir / "msgk38r.txt", "Review this change", age_s=4 * 86400)
    write(tree.runs_dir / "msgs82g.txt", "Grade this script", age_s=5 * 86400)
    _status_with(tree, f"{_local(5)} VADER c3: k38r cleared (no result; superseded). s82g cleared (WO #011 covers it).")
    snap = build_snapshot(tree, FileCache())
    jobs = {j["id"]: j for j in snap["oneshots"]}
    for name in ("k38r", "s82g"):
        assert (jobs[name]["state"], jobs[name]["action"], jobs[name]["alertable"]) == ("cleared", "done", False)
        assert jobs[name]["followed_up_by"].startswith("STATUS.md: ")
    assert not any(a.get("id") in ("k38r", "s82g") for a in snap["attention"])


def test_a_change_log_entry_from_before_a_oneshot_was_sent_does_not_clear_it(tree):
    write(tree.runs_dir / "msgk38r.txt", "Review this change", age_s=7 * 3600)
    _status_with(tree, f"{_local(8 * 60)} VADER c3: k38r cleared.")
    job = next(j for j in build_snapshot(tree, FileCache())["oneshots"] if j["id"] == "k38r")
    assert job["state"] == "stalled"


def test_only_blocked_work_orders_can_alert(tree):
    snap = build_snapshot(tree, FileCache())
    by_state = {}
    for e in snap["inbox"]:
        by_state.setdefault(e["state"], set()).add(e["alertable"])
    assert by_state["BLOCKED"] == {True}
    for state in ("OPEN", "DONE", "PARKED", "NOTE"):
        assert by_state.get(state, {False}) == {False}, state
    running_order = "## RUNNING — 2026-10-09 · Being built\\n\\nWork in progress.\\n"
    write(tree.inbox_path, tree.inbox_path.read_text() + running_order.replace("\\n", "\n"))
    entry = next(e for e in build_snapshot(tree, FileCache())["inbox"] if e["title"] == "Being built")
    assert (entry["state"], entry["alertable"]) == ("RUNNING", False)


def test_every_alertable_state_and_nothing_else(tree):
    from brain.snapshot import ALERT_STATES

    assert ALERT_STATES == {"blocked", "stalled", "gate_failed", "no_report", "error"}
