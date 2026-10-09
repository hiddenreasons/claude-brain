import time

from brain.mac_runs import (
    brief_title,
    is_safe_id,
    job_detail,
    parse_activity,
    parse_runs_log,
    scan_flat_jobs,
    scan_job_folders,
)
from brain.readers import FileCache

from conftest import result_event, result_json, said, stream, tool_use, write

HOUR = 3600


def folder(jobs, job_id):
    return next(j for j in jobs if j["id"] == job_id)


# ---------- one-shot jobs ----------


def test_oneshot_done_reads_cost_turns_model_and_result(tree):
    write(tree.runs_dir / "msgk38b.txt", "You are the code reviewer for one VADER change.\nDetails…")
    write(tree.runs_dir / "outk38b.json", result_json("Reviewed: APPROVED."))
    write(tree.runs_dir / "errk38b.txt", "")
    job = scan_flat_jobs(tree.runs_dir, FileCache())[0]
    assert job["state"] == "done"
    assert job["title"] == "You are the code reviewer for one VADER change."
    assert (job["cost_usd"], job["duration_s"], job["turns"], job["denials"]) == (2.5, 125, 12, 1)
    assert job["models"] == ["claude-opus-5-5"]
    assert job["result_preview"] == "Reviewed: APPROVED."
    assert job["error_preview"] is None


def test_oneshot_error_result(tree):
    write(tree.runs_dir / "msg1.txt", "Do a thing")
    write(tree.runs_dir / "out1.json", result_json("Failed", is_error=True))
    assert scan_flat_jobs(tree.runs_dir, FileCache())[0]["state"] == "error"


def test_oneshot_unreadable_result_is_an_error_with_a_note(tree):
    write(tree.runs_dir / "msg2.txt", "Do a thing")
    write(tree.runs_dir / "out2.json", "{not json")
    job = scan_flat_jobs(tree.runs_dir, FileCache())[0]
    assert job["state"] == "error" and job["note"] == "result file is unreadable"


def test_oneshot_without_result_is_waiting_when_recent_and_no_result_when_old(tree):
    write(tree.runs_dir / "msgnew.txt", "Fresh order")
    write(tree.runs_dir / "msgold.txt", "Old order", age_s=10 * HOUR)
    jobs = {j["id"]: j for j in scan_flat_jobs(tree.runs_dir, FileCache())}
    assert jobs["new"]["state"] == "waiting"
    assert jobs["old"]["state"] == "no_result"


def test_oneshot_error_text_is_surfaced(tree):
    write(tree.runs_dir / "msg3.txt", "Do a thing")
    write(tree.runs_dir / "out3.json", result_json())
    write(tree.runs_dir / "err3.txt", "Traceback: boom\n")
    assert scan_flat_jobs(tree.runs_dir, FileCache())[0]["error_preview"] == "Traceback: boom"


def test_oneshots_sorted_newest_first(tree):
    write(tree.runs_dir / "msga.txt", "A", age_s=2 * HOUR)
    write(tree.runs_dir / "outa.json", result_json(), age_s=2 * HOUR)
    write(tree.runs_dir / "msgb.txt", "B", age_s=HOUR)
    write(tree.runs_dir / "outb.json", result_json(), age_s=HOUR)
    assert [j["id"] for j in scan_flat_jobs(tree.runs_dir, FileCache())] == ["b", "a"]


# ---------- live stream ----------


def test_activity_keeps_tool_calls_and_words_and_skips_thinking():
    text = stream(
        {"type": "system", "subtype": "init", "session_id": "sess-1"},
        {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "secret"}]}},
        tool_use("Bash", command="pytest -q", description="Run the tests"),
        tool_use("Edit", file_path="/a/b/vader/web/preview.html", old_string="x"),
        said("Tests pass."),
        result_event("TO MAC: DONE"),
    )
    activity = parse_activity(text)
    assert activity["session_id"] == "sess-1"
    assert activity["actions"] == [
        {"kind": "tool", "name": "Bash", "summary": "Run the tests"},
        {"kind": "tool", "name": "Edit", "summary": "preview.html"},
        {"kind": "text", "text": "Tests pass."},
    ]
    assert activity["result"]["ok"] is True and activity["result"]["text"] == "TO MAC: DONE"


def test_activity_survives_a_cut_first_line_and_junk():
    text = '"half a line}\nnot json\n' + stream(tool_use("Read", file_path="/x/STATUS.md"))
    assert parse_activity(text)["actions"] == [{"kind": "tool", "name": "Read", "summary": "STATUS.md"}]


def test_activity_limit_keeps_the_newest():
    text = stream(*[tool_use("Bash", description=f"step {i}") for i in range(30)])
    actions = parse_activity(text, limit=5)["actions"]
    assert [a["summary"] for a in actions] == [f"step {i}" for i in range(25, 30)]


# ---------- job folders ----------

BRIEF = """YOUR RESPONSE MUST BEGIN with this exact line:
HANDOFF READ: VADER handoff

<handoff file="x">
# VADER handoff
## MANDATORY STARTUP GATE
</handoff>

JOB — sopapply: apply the WO SOP review pack (Opus high)

Steps…
"""

RUNS_LOG = """start 2026-10-09 09:01:03 EDT iter 1 pid 38591 prompt /x/brief.md model opus effort high
end 2026-10-09 09:19:55 EDT iter 1 exit 0
"""


def make_job(runs, name, *, brief=BRIEF, done=True, report=None, stream_age=0.0, extra=None, gate=None):
    job = runs / name
    write(job / "brief.md", brief, age_s=stream_age)
    write(job / "runs.log", RUNS_LOG if done else RUNS_LOG.splitlines()[0] + "\n", age_s=stream_age)
    write(job / "iter-1.jsonl", stream(tool_use("Bash", description="Run tests"), said("Working.")), age_s=stream_age)
    if done:
        write(job / "iter-1.done", "", age_s=stream_age)
    if report is not None:
        write(job / "REPORT.md", report, age_s=stream_age)
    if gate:
        write(job / gate, "gate")
    for fname, age in (extra or {}).items():
        write(job / fname, "x", age_s=age)
    return job


def test_brief_title_skips_handoff_boilerplate_and_job_prefix():
    assert brief_title(BRIEF, "fallback") == "sopapply: apply the WO SOP review pack (Opus high)"
    assert brief_title("JOB (pictures only, from c3): Draft 3 mockups", "f") == "Draft 3 mockups"
    research = "# VADER Research Job — Why views stop\n## STARTUP GATE"
    assert brief_title(research, "f") == "VADER Research Job — Why views stop"
    assert brief_title(None, "fallback") == "fallback"
    assert brief_title("STARTUP GATE only", "fallback") == "fallback"


def test_runs_log_keeps_the_latest_iteration():
    log = RUNS_LOG + "start 2026-10-09 10:00:00 EDT iter 2 pid 1 prompt p model sonnet effort medium\n"
    info = parse_runs_log(log)
    assert (info["model"], info["effort"], info["ended"], info["exit_code"]) == ("sonnet", "medium", None, None)
    assert parse_runs_log(RUNS_LOG)["exit_code"] == 0


def test_folder_running_when_stream_is_fresh_and_not_done(tree):
    make_job(tree.runs_dir, "live", done=False)
    job = folder(scan_job_folders(tree.runs_dir, FileCache()), "live")
    assert job["state"] == "running"
    assert job["activity"][-1] == {"kind": "text", "text": "Working."}
    assert (job["model"], job["effort"], job["iteration"]) == ("opus", "high", 1)


def test_folder_stalled_when_stream_is_old_and_no_live_process(tree):
    make_job(tree.runs_dir, "dead", done=False, stream_age=2 * HOUR)
    write(tree.runs_dir / "dead" / "claude.pid", "999999")  # no such process
    assert folder(scan_job_folders(tree.runs_dir, FileCache()), "dead")["state"] == "stalled"


def test_folder_done_with_report(tree):
    make_job(tree.runs_dir, "ok", report="TO MAC: DONE\n\nDetails")
    job = folder(scan_job_folders(tree.runs_dir, FileCache()), "ok")
    assert job["state"] == "done" and job["report_headline"] == "TO MAC: DONE"
    assert job["headline_source"] == "report" and job["exit_code"] == 0


def test_folder_blocked_report_is_open_until_mac_acts(tree):
    make_job(tree.runs_dir, "stuck", report="TO MAC: BLOCKED commit hook fails", stream_age=HOUR)
    assert folder(scan_job_folders(tree.runs_dir, FileCache()), "stuck")["state"] == "blocked"


def test_folder_blocked_report_then_mac_follow_up(tree):
    make_job(
        tree.runs_dir,
        "handled",
        report="TO MAC: BLOCKED commit hook fails",
        stream_age=HOUR,
        extra={"commit-final.log": 10 * 60},
    )
    job = folder(scan_job_folders(tree.runs_dir, FileCache()), "handled")
    assert job["state"] == "followed_up" and job["followed_up_by"] == "commit-final.log"


def test_harness_end_of_run_files_do_not_count_as_follow_up(tree):
    make_job(
        tree.runs_dir,
        "stuck2",
        report="TO MAC: BLOCKED x",
        stream_age=HOUR,
        extra={"runs.log": 0, "iter-1.done": 0, "claude.pid": 0},
    )
    assert folder(scan_job_folders(tree.runs_dir, FileCache()), "stuck2")["state"] == "blocked"


def test_folder_report_elsewhere_falls_back_to_final_reply(tree):
    job_dir = make_job(tree.runs_dir, "elsewhere")
    final = "I read HANDOFF-to-new-VADER-bot.md first.\nREPORT.md is in _shared/next/. DONE."
    write(job_dir / "iter-1.jsonl", stream(result_event(final)))
    job = folder(scan_job_folders(tree.runs_dir, FileCache()), "elsewhere")
    assert job["state"] == "done"
    assert job["headline_source"] == "final reply"
    assert job["report_headline"] == "REPORT.md is in _shared/next/. DONE."


def test_folder_failed_final_reply_without_report_is_an_error(tree):
    job_dir = make_job(tree.runs_dir, "crashed")
    write(job_dir / "iter-1.jsonl", stream(result_event("API error", ok=False)))
    assert folder(scan_job_folders(tree.runs_dir, FileCache()), "crashed")["state"] == "error"


def test_folder_without_report_or_reply_is_no_report(tree):
    make_job(tree.runs_dir, "silent")
    assert folder(scan_job_folders(tree.runs_dir, FileCache()), "silent")["state"] == "no_report"


def test_folder_gate_failed_wins(tree):
    make_job(tree.runs_dir, "gate", done=False, gate="GATE-FAILED")
    job = folder(scan_job_folders(tree.runs_dir, FileCache()), "gate")
    assert job["state"] == "gate_failed" and job["gate"] == "failed"


def test_folder_with_only_a_brief_is_prepared(tree):
    write(tree.runs_dir / "codexjob" / "brief.md", "JOB: draw mockups")
    assert folder(scan_job_folders(tree.runs_dir, FileCache()), "codexjob")["state"] == "prepared"


def test_non_job_and_underscore_folders_are_ignored(tree):
    write(tree.runs_dir / "_shared" / "brief.md", "harness")
    write(tree.runs_dir / "backups" / "something.txt", "x")
    assert scan_job_folders(tree.runs_dir, FileCache()) == []


def test_missing_runs_dir_gives_empty_lists(tmp_path):
    assert scan_job_folders(tmp_path / "nope", FileCache()) == []
    assert scan_flat_jobs(tmp_path / "nope", FileCache()) == []


# ---------- detail and id safety ----------


def test_safe_ids():
    assert is_safe_id("k38b") and is_safe_id("sopapply") and is_safe_id("s70g-2")
    for bad in ("", ".", "..", "../etc", "a/b", "a b", "x\x00"):
        assert not is_safe_id(bad)


def test_detail_for_folder_strips_handoff_and_includes_activity(tree):
    make_job(tree.runs_dir, "sop", report="TO MAC: DONE")
    detail = job_detail(tree.runs_dir, "folder", "sop")
    assert detail["brief"].startswith("JOB — sopapply")
    assert detail["report"].startswith("TO MAC: DONE")
    assert detail["activity"][0]["name"] == "Bash"


def test_detail_for_oneshot_and_unknown_or_unsafe_ids(tree):
    write(tree.runs_dir / "msg9.txt", "Order text")
    write(tree.runs_dir / "out9.json", result_json("Result text"))
    detail = job_detail(tree.runs_dir, "oneshot", "9")
    assert (detail["prompt"], detail["result"]) == ("Order text", "Result text")
    assert job_detail(tree.runs_dir, "oneshot", "missing") is None
    assert job_detail(tree.runs_dir, "folder", "..") is None
    assert job_detail(tree.runs_dir, "folder", "../VADER") is None
    assert job_detail(tree.runs_dir, "other", "9") is None


def test_cache_reparses_only_when_file_changes(tree):
    calls = []
    cache = FileCache()
    path = write(tree.runs_dir / "f.txt", "one")

    def parse(p):
        calls.append(1)
        return p.read_text()

    assert cache.get(path, "t", parse) == "one"
    assert cache.get(path, "t", parse) == "one"
    assert len(calls) == 1
    time.sleep(0.01)
    write(path, "two!")
    assert cache.get(path, "t", parse) == "two!"
    assert len(calls) == 2
