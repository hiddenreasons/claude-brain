from brain.messages import SEND_LIMIT, derive_messages, local_iso, stamp_and_sort
from brain.readers import FileCache
from brain.snapshot import build_snapshot

from conftest import result_json, write


def by_id(messages):
    return {m["id"]: m for m in messages}


def test_inbox_gives_order_and_reply_messages_with_direction_and_blocked(tree):
    msgs = derive_messages(build_snapshot(tree, FileCache()))
    kinds = [(m["direction"], m["kind"], m["blocked"]) for m in msgs if m["ref"]["source"] == "work_order"]
    # WO #022 from MAC, WO #019 from MAC with BLOCKED / FROM MAC / DONE replies, then Claude's own entry.
    assert ("to_claude", "work_order", False) in kinds
    assert ("to_mac", "to_mac", True) in kinds
    assert ("to_claude", "from_mac", False) in kinds
    autopilot = [m for m in msgs if m["text"] == "Final render stalls"]
    assert autopilot[0]["direction"] == "to_mac"


def test_oneshot_jobs_give_sent_and_result_messages_with_file_times(tree):
    write(tree.runs_dir / "msg5.txt", "Review the change")
    write(tree.runs_dir / "out5.json", result_json("TO MAC: BLOCKED tests fail"))
    write(tree.runs_dir / "msg6.txt", "Still going")
    msgs = by_id(derive_messages(build_snapshot(tree, FileCache())))
    assert msgs["oneshot:5:sent"]["direction"] == "to_claude" and msgs["oneshot:5:sent"]["at"]
    assert msgs["oneshot:5:result"]["blocked"] is True
    assert "oneshot:6:result" not in msgs


def test_folder_job_gives_sent_and_report_messages(tree):
    job = tree.runs_dir / "sop"
    write(job / "brief.md", "JOB: apply the pack")
    write(job / "runs.log", "start 2026-10-09 09:01:03 EDT iter 1 pid 1 prompt p model opus effort high\n")
    write(job / "iter-1.jsonl", "{}\n")
    write(job / "iter-1.done", "")
    write(job / "REPORT.md", "TO MAC: DONE\n")
    msgs = by_id(derive_messages(build_snapshot(tree, FileCache())))
    sent = msgs["folder:sop:i1:sent"]
    assert sent["at"].endswith("+00:00") and sent["at"].startswith("2026-10-09T")
    report = msgs["folder:sop:i1:report"]
    assert (report["direction"], report["text"], report["blocked"]) == ("to_mac", "TO MAC: DONE", False)


def test_messages_present_at_startup_get_no_time_and_new_ones_get_first_seen():
    first_seen = {}
    old = [{"id": "a", "at": None}, {"id": "b", "at": "2026-10-09T10:00:00+00:00"}]
    out = stamp_and_sort(old, first_seen, "2026-10-09T12:00:00+00:00", initial=True)
    assert {m["id"]: m["at"] for m in out} == {"a": None, "b": "2026-10-09T10:00:00+00:00"}
    later = [{"id": "a", "at": None}, {"id": "c", "at": None}]
    out = stamp_and_sort(later, first_seen, "2026-10-09T12:05:00+00:00", initial=False)
    assert [m["id"] for m in out] == ["c", "a"]
    assert out[0]["at"] == "2026-10-09T12:05:00+00:00" and out[1]["at"] is None


def test_newest_first_and_capped():
    msgs = [{"id": str(i), "at": f"2026-10-09T10:{i % 60:02d}:{i // 60:02d}+00:00"} for i in range(SEND_LIMIT + 50)]
    out = stamp_and_sort(msgs, {}, "x", initial=True)
    assert len(out) == SEND_LIMIT
    assert out == sorted(out, key=lambda m: m["at"], reverse=True)


def test_local_iso_handles_bad_input():
    assert local_iso(None) is None
    assert local_iso("not a time") is None


def test_blocked_messages_about_a_resolved_job_show_as_cleared():
    from brain.messages import mark_cleared

    folders = [{"id": "claudemd", "state": "cleared"}, {"id": "other", "state": "blocked"}]
    msgs = [
        {"id": "a", "blocked": True, "ref": {"source": "comms", "job": "claudemd"}},
        {"id": "b", "blocked": True, "ref": {"source": "job", "kind": "folder", "id": "claudemd"}},
        {"id": "c", "blocked": True, "ref": {"source": "comms", "job": "other"}},
        {"id": "d", "blocked": False, "ref": {"source": "comms", "job": "claudemd"}},
    ]
    assert [m["cleared"] for m in mark_cleared(msgs, folders)] == [True, True, False, False]
