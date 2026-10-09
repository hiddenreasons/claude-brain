"""The WINDOWS box from ~/.vader-mac-runs/brain/windows-status.json (read-only)."""

import json
import time

from brain.readers import FileCache, iso
from brain.snapshot import build_snapshot
from brain.windows_status import read_windows_status

from conftest import write


def status_file(tree, **data) -> None:
    write(tree.runs_dir / "brain" / "windows-status.json", json.dumps(data))


def test_nothing_running_or_queued_shows_no_jobs(tree):
    status_file(tree, updated_at=iso(time.time() - 120), jobs=[{"name": "topics15", "state": "done"}])
    box = read_windows_status(tree.runs_dir, time.time())
    assert (box["offline"], box["jobs"]) == (False, [])  # the page shows "no jobs"


def test_an_update_more_than_15_minutes_old_shows_offline(tree):
    status_file(tree, updated_at=iso(time.time() - 16 * 60), jobs=[{"name": "winslowtests", "state": "running"}])
    box = build_snapshot(tree, FileCache())["windows_box"]
    assert box["offline"] is True and box["reason"] == "last update 16 min ago"
    assert read_windows_status(tree.runs_dir / "nowhere", time.time())["offline"] is True  # no file: offline too


def test_the_list_reads_like_the_terminal_example(tree):
    status_file(
        tree,
        last_update=int(time.time() - 60),
        running=["winslowtests", {"job": "codex B08", "status": "running"}],
        ready=["04-wo001", "05-wo003"],
        done=["03-wo000"],
    )
    box = read_windows_status(tree.runs_dir, time.time())
    assert [(j["name"], j["state"]) for j in box["jobs"]] == [
        ("winslowtests", "RUNNING"),
        ("codex B08", "RUNNING"),
        ("04-wo001", "READY"),
        ("05-wo003", "READY"),
    ]
    assert box["offline"] is False


def test_macs_real_format_with_heartbeat_queue_and_codex(tree):
    write(
        tree.runs_dir / "brain" / "windows-status.json",
        json.dumps(
            {
                "copied_at": iso(time.time() - 300),
                "heartbeat": {
                    "at": "2026-10-09T17:43:07.4509137-04:00",
                    "job": "winslowtests",
                    "job_state": "running",
                    "running_jobs": ["winslowtests"],
                },
                "queue": ["04-wo001", {"job": "05-wo003"}],
                "recent": [
                    {
                        "job": "topics15",
                        "finished_at": "2026-10-09T15:03:37.5685251-04:00",
                        "first_line": "TO MAC: DONE",
                    }
                ],
            }
        ),
    )
    codex_running = [{"job": "B08-school-bus-crossing-arm", "machine": "WINDOWS"}, {"job": "M01", "machine": "MAC"}]
    box = read_windows_status(tree.runs_dir, time.time(), codex_running)
    assert box["offline"] is False
    assert [(j["name"], j["state"]) for j in box["jobs"]] == [
        ("winslowtests", "RUNNING"),
        ("codex B08", "RUNNING"),
        ("04-wo001", "READY"),
        ("05-wo003", "READY"),
    ]


def test_a_windows_job_windows_lists_as_finished_is_done_not_running(tree):
    from brain.machines import read_heartbeat, remote_jobs

    write(
        tree.runs_dir / "brain" / "windows-status.json",
        json.dumps(
            {
                "copied_at": iso(time.time() - 60),
                "heartbeat": {
                    "at": iso(time.time() - 60),
                    "job": "winslowtests",
                    "job_state": "running",
                    "running_jobs": ["winslowtests"],
                },
                "recent": [
                    {
                        "job": "topics15",
                        "finished_at": "2026-10-09T15:03:37.5685251-04:00",
                        "first_line": "TO MAC: DONE",
                    }
                ],
            }
        ),
    )
    beat = read_heartbeat(tree.runs_dir, time.time())
    assert beat["fresh"] and beat["path"].endswith("windows-status.json")
    started = {
        "ref": {"job": "topics15"},
        "at": "2026-10-09T18:42:52+00:00",
        "mac_kind": "job_started",
        "machine": "windows",
        "text": "topics15",
    }
    running = {
        "ref": {"job": "winslowtests"},
        "at": "2026-10-09T21:00:00+00:00",
        "mac_kind": "job_started",
        "machine": "windows",
        "text": "w",
    }
    jobs = {j["id"]: j for j in remote_jobs([started, running], [], beat, time.time())}
    assert jobs["topics15"]["state"] == "done" and "TO MAC: DONE" in jobs["topics15"]["source"]
    assert jobs["winslowtests"]["state"] == "running" and jobs["winslowtests"]["source"] == "Windows heartbeat"
    only_beat = {j["id"]: j for j in remote_jobs([started], [], beat, time.time())}
    assert only_beat["winslowtests"]["state"] == "running"  # running per the heartbeat, never in MAC's log
