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
