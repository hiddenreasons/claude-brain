"""The 3-lane timeline (Claude, MAC, Windows) built for the Active now panel."""

from datetime import datetime, timezone

from brain import timeline

NOW = datetime(2026, 10, 10, 1, 0, tzinfo=timezone.utc).timestamp()


def snap():
    return {
        "folders": [
            {
                "id": "flaredfix",
                "lifecycle": "done",
                "started": "2026-10-09 18:05:00 EDT",
                "report_at": "2026-10-09T22:43:00+00:00",
                "title": "flared_end fix",
            },
            {"id": "antidrift", "lifecycle": "running", "started": "2026-10-09 20:19:48 EDT", "title": "antidrift"},
            {
                "id": "ancient",
                "lifecycle": "done",
                "started": "2026-10-05 10:00:00 EDT",
                "report_at": "2026-10-05T15:00:00+00:00",
            },
            {"id": "queuedonly", "lifecycle": "queued"},
        ],
        "oneshots": [],
        "remote_jobs": [
            {
                "id": "sbatch02",
                "machine": "WINDOWS",
                "state": "running",
                "started_at": None,
                "state_since": "2026-10-10T00:40:00+00:00",
                "last_text": "calling Bash",
            },
        ],
        "windows": {
            "recent": [
                {
                    "job": "review01",
                    "finished_at": "2026-10-09T20:51:32-04:00",
                    "first_line": "TO MAC: BLOCKED permission",
                },
                {"job": "sbatch01", "finished_at": "2026-10-09T20:35:43-04:00", "first_line": "TO MAC: DONE"},
            ]
        },
        "codex": {
            "jobs": [
                {
                    "job": "B13-door",
                    "machine": "WINDOWS",
                    "state": "done",
                    "started_at": "2026-10-09T22:03:51+00:00",
                    "ended_at": "2026-10-09T22:12:34+00:00",
                    "result": "exit 0, 9 pngs",
                },
            ]
        },
    }


MESSAGES = [
    {
        "at": "2026-10-10T00:19:48+00:00",
        "direction": "to_claude",
        "text": "antidrift iter 1 started",
        "ref": {"job": "antidrift"},
        "machine": "mac",
    },
    {
        "at": "2026-10-09T23:30:00+00:00",
        "direction": "to_claude",
        "text": "sbatch01 started",
        "ref": {"job": "sbatch01"},
        "machine": "windows",
    },
    {"at": "2026-10-09T23:40:00+00:00", "direction": "to_mac", "text": "a reply", "ref": {"job": "x"}},
]


def bars(lane):
    return {b["label"]: b for b in lane}


def test_claude_jobs_run_from_their_start_to_their_report_and_running_ones_to_now():
    t = timeline.build(snap(), MESSAGES, NOW)
    claude = bars(t["lanes"]["claude"])
    assert claude["flaredfix"]["start"] == "2026-10-09T22:05:00+00:00"  # 18:05 EDT
    assert claude["flaredfix"]["end"] == "2026-10-09T22:43:00+00:00" and claude["flaredfix"]["state"] == "done"
    assert claude["antidrift"]["end"] is None and claude["antidrift"]["state"] == "running"
    assert claude["antidrift"]["open"] == {"type": "job", "kind": "folder", "id": "antidrift"}
    assert "ancient" not in claude and "queuedonly" not in claude  # older than a day, never started


def test_windows_jobs_take_their_start_from_mac_messages_or_show_the_finish_only():
    t = timeline.build(snap(), MESSAGES, NOW)
    win = bars(t["lanes"]["windows"])
    assert win["sbatch01"]["start"] == "2026-10-09T23:30:00+00:00" and win["sbatch01"]["state"] == "done"
    assert win["review01"]["start"] is None and win["review01"]["state"] == "blocked"  # finish only
    assert win["sbatch02"]["state"] == "running" and win["sbatch02"]["start"] == "2026-10-10T00:40:00+00:00"
    assert win["Codex B13"]["end"] == "2026-10-09T22:12:34+00:00"
    assert win["review01"]["open"] == {"type": "node", "id": "win:review01"}


def test_macs_lane_marks_each_job_mac_sent():
    t = timeline.build(snap(), MESSAGES, NOW)
    assert [(k["label"], k["machine"]) for k in t["ticks"]] == [("antidrift", "mac"), ("sbatch01", "windows")]
    assert t["lanes"]["mac"] == []  # no Codex jobs on the Mac in this sample


def test_windows_status_start_and_end_times_draw_a_full_bar():
    s = snap()
    s["windows"]["recent"].append(
        {
            "job": "review02",
            "started_at": "2026-10-09T20:30:00-04:00",
            "ended_at": "2026-10-09T20:47:22-04:00",
            "first_line": "TO MAC: DONE",
        }
    )
    win = bars(timeline.build(s, MESSAGES, NOW)["lanes"]["windows"])
    assert win["review02"]["start"] == "2026-10-10T00:30:00+00:00"
    assert win["review02"]["end"] == "2026-10-10T00:47:22+00:00" and win["review02"]["state"] == "done"
