import pytest

from brain.labels import job_action, order_action
from brain.readers import FileCache
from brain.snapshot import build_snapshot

from conftest import write


def order(state, title="Some work", status=None, body="", replies=None):
    return {"state": state, "title": title, "status_text": status, "body": body, "replies": replies or []}


# ---------- jobs ----------


@pytest.mark.parametrize("state", ["blocked", "stalled", "gate_failed", "no_report", "error"])
def test_problem_jobs_need_anthony(state):
    result = job_action({"state": state, "kind": "folder", "report_headline": "TO MAC: BLOCKED x"})
    assert result["action"] == "needs_anthony" and result["action_note"]


def test_running_job_is_in_progress_with_who_and_when():
    job = {
        "state": "running",
        "kind": "folder",
        "model": "opus",
        "effort": "high",
        "stream_updated_at": "2026-10-09T18:00:00+00:00",
    }
    assert job_action(job) == {
        "action": "in_progress",
        "action_note": None,
        "action_who": "Claude · opus high",
        "action_at": "2026-10-09T18:00:00+00:00",
    }


def test_waiting_oneshot_is_in_progress_never_needs_anthony():
    result = job_action({"state": "waiting", "kind": "oneshot", "sent_at": "2026-10-09T17:00:00+00:00"})
    assert (result["action"], result["action_at"]) == ("in_progress", "2026-10-09T17:00:00+00:00")


def test_prepared_job_is_queued():
    assert job_action({"state": "prepared", "kind": "folder"})["action"] == "queued"


@pytest.mark.parametrize("state", ["done", "cleared", "followed_up"])
def test_finished_or_resolved_jobs_are_done(state):
    assert job_action({"state": state, "kind": "folder"})["action"] == "done"


# ---------- work orders ----------


def test_blocked_work_order_needs_anthony_with_the_last_reply():
    entry = order("BLOCKED", replies=[{"direction": "to_mac", "text": "BLOCKED can't read files", "blocked": True}])
    assert order_action(entry) == {
        "action": "needs_anthony",
        "action_note": "BLOCKED can't read files",
        "action_who": None,
        "action_at": None,
    }


@pytest.mark.parametrize(
    "status",
    [
        "OPEN (owner judges on Review)",
        "OPEN - Claude Eng (inventory) with MAC. Read only until Anthony approves the list.",
        "OPEN, waiting on the owner's OK",
    ],
)
def test_work_order_waiting_on_an_owner_decision_needs_anthony(status):
    result = order_action(order("OPEN", status=status))
    assert result["action"] == "needs_anthony" and result["action_note"].startswith("waiting on Anthony")


def test_an_owner_sign_off_at_the_end_of_a_queued_order_is_not_a_wait_now():
    # WO #016: queued after #014; Anthony approves the list only once the inventory exists.
    status = "OPEN - Claude Eng (inventory) with MAC. Read only until Anthony approves the list."
    body = "**From MAC.** Owner-approved 2026-10-05. Queue order: after #014 (#006 → #011 → #014 → **#016**).\n"
    result = order_action(order("OPEN", status=status, body=body))
    assert (result["action"], result["action_note"]) == ("queued", "after #014")


def test_a_status_line_waiting_on_anthony_wins_over_an_old_queue_place():
    body = "**From MAC.** Queue order: after #014.\n"
    result = order_action(order("OPEN", status="OPEN - inventory written, waiting on Anthony's OK.", body=body))
    assert result["action"] == "needs_anthony"


def test_owner_wording_in_the_title_counts():
    assert order_action(order("OPEN", title="Short 22 re-render waits on two owner OKs"))["action"] == "needs_anthony"


def test_running_work_order_is_in_progress_with_who():
    result = order_action(order("RUNNING", status="running (started by MAC, Oct 7). Claude Eng on it."))
    assert (result["action"], result["action_who"]) == ("in_progress", "MAC")


def test_open_work_order_is_queued_with_what_its_behind():
    result = order_action(order("OPEN", status="OPEN — Claude Eng (API endpoints). Runs after #009. Phase A now."))
    assert (result["action"], result["action_note"]) == ("queued", "after #009")


def test_queue_order_line_in_the_body_is_used_when_the_status_has_none():
    body = "**From MAC.** Queue order: small; runs right after #005 and #004, before #006.\n"
    result = order_action(order("OPEN", status="OPEN - Claude Eng.", body=body))
    assert (result["action"], result["action_note"]) == ("queued", "after #005 and #004")


def test_parked_work_order_is_queued_even_when_anthony_is_one_of_the_things_its_behind():
    status = "PARKED - until after the current dashboard finish, Anthony's full review, and the button-up pass."
    result = order_action(order("PARKED", status=status))
    assert result["action"] == "queued" and result["action_note"].startswith("after the current dashboard finish")


def test_someone_else_waiting_on_this_item_is_not_what_its_behind():
    result = order_action(order("OPEN", status="OPEN — Claude Eng (backend); VV2 waits on UI wire until this is done."))
    assert (result["action"], result["action_note"]) == ("queued", None)


def test_other_sentences_in_the_body_are_not_mistaken_for_the_queue():
    body = "The render restarts after it was killed at 30 minutes."
    assert order_action(order("OPEN", status="OPEN.", body=body))["action_note"] is None


@pytest.mark.parametrize("state", ["DONE", "NOTE"])
def test_done_and_note_work_orders_are_done(state):
    assert order_action(order(state))["action"] == "done"


# ---------- the snapshot wires it up ----------


def test_only_needs_anthony_items_are_alertable(tree):
    write(tree.runs_dir / "msgfresh.txt", "Fresh order")
    snap = build_snapshot(tree, FileCache())
    for item in snap["folders"] + snap["oneshots"] + snap["inbox"]:
        assert item["alertable"] == (item["action"] == "needs_anthony"), item.get("id")
    assert {e["state"]: e["action"] for e in snap["inbox"]}["PARKED"] == "queued"


# brain/static/hud.js orderColumns relies on these pairs (it checks BLOCKED before needs_anthony; its tests use them).
@pytest.mark.parametrize(
    "state, action",
    [("BLOCKED", "needs_anthony"), ("DONE", "done"), ("NOTE", "done"), ("PARKED", "queued"), ("OPEN", "queued"), ("RUNNING", "in_progress")],
)
def test_the_actions_the_order_columns_rely_on(state, action):
    assert order_action(order(state))["action"] == action
