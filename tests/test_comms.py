import json
from datetime import datetime, timezone

from brain.comms import merge, parse_comms, read_comms, running_from_comms

from conftest import write


def line(**fields):
    base = {"v": 1, "at": "2026-10-09T15:16:57Z", "from": "mac", "to": "claude", "kind": "job_sent", "text": "x"}
    base.update(fields)
    return json.dumps(base)


def test_valid_lines_become_messages_in_the_brains_shape():
    text = "\n".join(
        [
            line(id="a", kind="work_order", wo=23, text="WO #023 Channel layout"),
            line(
                id="b", **{"from": "claude", "to": "mac"}, kind="report", status="ok", job="wofix", text="TO MAC: DONE"
            ),
            line(id="c", **{"from": "claude", "to": "mac"}, kind="blocked", job="wofix", text="TO MAC: BLOCKED tests"),
            line(id="d", kind="unblocked", text="FROM MAC: fixed, go ahead", machine="grok"),
        ]
    )
    messages, skipped = parse_comms(text)
    assert skipped == 0
    got = {m["id"]: (m["direction"], m["kind"], m["blocked"]) for m in messages}
    assert got == {
        "comms:a": ("to_claude", "work_order", False),
        "comms:b": ("to_mac", "report", False),
        "comms:c": ("to_mac", "to_mac", True),
        "comms:d": ("to_claude", "from_mac", False),
    }
    assert messages[0]["at"] == "2026-10-09T15:16:57+00:00" and messages[0]["ref"]["wo"] == 23
    assert messages[3]["machine"] == "grok"


def test_bad_lines_are_skipped_and_counted_never_fatal():
    text = "\n".join(
        [
            "not json",
            "[1, 2]",
            line(**{"from": "mac", "to": "mac"}),  # talking to itself
            line(**{"from": "codex"}),  # unknown party
            line(at="2026-10-09 15:16:57"),  # no time zone
            line(at="yesterday"),
            line(kind="dance"),
            line(id="ok"),
        ]
    )
    messages, skipped = parse_comms(text)
    assert [m["id"] for m in messages] == ["comms:ok"] and skipped == 7


def test_unsafe_job_names_are_dropped_and_text_is_one_short_line():
    messages, _ = parse_comms(line(job="../../etc", text="a\nb" + "c" * 400))
    assert messages[0]["ref"]["job"] is None
    assert "\n" not in messages[0]["text"] and len(messages[0]["text"]) < 300


def test_repeated_lines_count_once_and_missing_ids_are_stable():
    once = line(text="no id here")
    a, _ = parse_comms("\n".join([once, once]))
    b, _ = parse_comms(once)
    assert len(a) == 1 and a[0]["id"] == b[0]["id"]


def test_running_elsewhere_until_finished():
    now = datetime(2026, 10, 9, 16, 0, tzinfo=timezone.utc)
    started, _ = parse_comms(
        "\n".join(
            [
                line(id="1", kind="job_started", job="winjob", machine="windows", at="2026-10-09T15:00:00Z"),
                line(id="2", kind="job_started", job="donejob", at="2026-10-09T15:00:00Z"),
                line(
                    id="3",
                    **{"from": "claude", "to": "mac"},
                    kind="job_finished",
                    job="donejob",
                    at="2026-10-09T15:30:00Z",
                ),
                line(id="4", kind="job_started", job="ancient", at="2026-10-08T01:00:00Z"),
            ]
        )
    )
    assert running_from_comms(started, now) == ["winjob"]


def test_merge_drops_file_derived_duplicates_of_logged_messages():
    derived = [
        {
            "id": "folder:wofix:i1:sent",
            "direction": "to_claude",
            "kind": "job_sent",
            "text": "wofix",
            "at": "2026-10-09T15:17:00+00:00",
            "ref": {"source": "job", "kind": "folder", "id": "wofix"},
        },
        {
            "id": "folder:other:i1:sent",
            "direction": "to_claude",
            "kind": "job_sent",
            "text": "other",
            "at": "2026-10-09T15:17:00+00:00",
            "ref": {"source": "job", "kind": "folder", "id": "other"},
        },
        {
            "id": "wo-x:r0",
            "direction": "to_mac",
            "kind": "to_mac",
            "text": "DONE (2026-10-07). Both scheduled.",
            "at": None,
            "ref": {"source": "work_order", "id": "wo-x"},
        },
    ]
    comms, _ = parse_comms(
        "\n".join(
            [
                line(id="s", kind="job_sent", job="wofix", at="2026-10-09T15:16:57Z"),
                line(
                    id="r",
                    **{"from": "claude", "to": "mac"},
                    kind="reply",
                    text="TO MAC: DONE (2026-10-07). Both scheduled.",
                ),
            ]
        )
    )
    ids = [m["id"] for m in merge(derived, comms)]
    assert ids == ["folder:other:i1:sent", "comms:s", "comms:r"]


def test_no_log_means_nothing_changes(tree):
    assert read_comms(tree.runs_dir) == ([], 0)
    assert merge([{"id": "x"}], []) == [{"id": "x"}]


def test_reads_the_log_file_from_the_runs_folder(tree):
    write(tree.runs_dir / "brain" / "comms.jsonl", line(id="z") + "\n")
    messages, skipped = read_comms(tree.runs_dir)
    assert [m["id"] for m in messages] == ["comms:z"] and skipped == 0
