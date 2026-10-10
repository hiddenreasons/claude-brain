"""Codex activity from ~/.vader-mac-runs/brain/codex-status.jsonl (read-only)."""

import json
import time
from datetime import datetime, timedelta, timezone

import pytest

from brain.brainfiles import BrainFiles, WriteRefusedError
from brain.codex import codex_messages, parse_codex, pictures, read_codex
from brain.effects import Recorder
from brain.readers import FileCache
from brain.snapshot import build_snapshot

from conftest import write


def at(minutes_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).astimezone().isoformat(timespec="seconds")


def event(job: str, kind: str, minutes_ago: float, result=None, machine="WINDOWS") -> dict:
    return {
        "at": at(minutes_ago),
        "machine": machine,
        "sender": "codex",
        "job": job,
        "event": kind,
        "result": result,
        "output_dir": f"C:\\VADER-WIN\\codex-pictures\\{job}",
    }


def codex_file(tree, *events, repeat_last=False) -> None:
    lines = [json.dumps(e) for e in events]
    if repeat_last:
        lines.append(lines[-1])  # the same line twice is one event
    write(tree.runs_dir / "brain" / "codex-status.jsonl", "\n".join(lines) + "\n")


def test_a_finished_event_shows_once_with_its_result(tree):
    codex_file(
        tree,
        event("B02-steel-bridges", "started", 30),
        event("B02-steel-bridges", "finished", 14, "exit 0, 8 pngs"),
        repeat_last=True,
    )
    codex = read_codex(tree.runs_dir, time.time())
    assert codex["events"] == 2
    job = codex["jobs"][0]
    assert (job["job"], job["state"], job["result"], job["machine"]) == (
        "B02-steel-bridges",
        "done",
        "exit 0, 8 pngs",
        "WINDOWS",
    )
    finished = [m for m in codex_messages(codex["_events"]) if m["mac_kind"] == "finished"]
    assert len(finished) == 1 and finished[0]["text"] == "B02-steel-bridges finished: exit 0, 8 pngs"
    assert finished[0]["direction"] == "codex" and finished[0]["at"].endswith("+00:00")  # one clock with MAC's log
    assert codex["today"]["done"] == 1 and codex["today"]["pictures"] == 8


def test_a_failed_job_shows_in_macs_attention_list_not_anthonys(tree, tmp_path):
    codex_file(tree, event("B05-rail-joints", "started", 40), event("B05-rail-joints", "failed", 5, "exit 1, 0 pngs"))
    snapshot = build_snapshot(tree, FileCache())
    assert [(a["id"], a["state"], a["up_next"]) for a in snapshot["mac_attention"]] == [
        ("B05-rail-joints", "failed", "MAC")
    ]
    assert not any(a["id"] == "B05-rail-joints" for a in snapshot["attention"])  # Anthony's list
    files = BrainFiles(tmp_path / "b")
    Recorder(files).record(snapshot)
    Recorder(files).record(snapshot)
    mac_alerts = [r for r in files.records("alerts.jsonl") if r.get("for") == "MAC"]
    assert len(mac_alerts) == 1  # once, even across refreshes


def test_a_started_job_without_a_finish_shows_as_running(tree):
    codex_file(tree, event("B06-spring-brakes", "started", 3))
    codex = build_snapshot(tree, FileCache())["codex"]
    assert [(j["job"], j["state"]) for j in codex["running"]] == [("B06-spring-brakes", "running")]
    assert codex["today"]["done"] == 0


def test_a_restarted_job_is_running_again_and_bad_lines_are_skipped(tree):
    lines = [event("B07", "started", 50), event("B07", "failed", 40, "exit 1"), event("B07", "started", 2)]
    text = (
        "\n".join(json.dumps(e) for e in lines) + "\nnot json\n" + json.dumps({"job": "x", "event": "exploded"}) + "\n"
    )
    events = parse_codex(text)
    assert len(events) == 3
    write(tree.runs_dir / "brain" / "codex-status.jsonl", text)
    assert read_codex(tree.runs_dir, time.time())["running"][0]["job"] == "B07"
    assert pictures("exit 0, 18 pngs") == 18 and pictures(None) == 0


def test_no_codex_file_is_simply_empty(tree):
    codex = read_codex(tree.runs_dir, time.time())
    assert (codex["found"], codex["jobs"], codex["today"]) == (False, [], {"done": 0, "pictures": 0})


@pytest.mark.parametrize("name", ["codex-status.jsonl", "windows-status.json"])
def test_the_brain_never_writes_macs_status_files(tmp_path, name):
    with pytest.raises(WriteRefusedError):
        BrainFiles(tmp_path / "brain").path(name)
