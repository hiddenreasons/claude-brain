from brain.inbox import derive_state, parse_inbox

from conftest import INBOX


def by_title(entries, needle):
    return next(e for e in entries if needle in e["title"])


def test_headers_parse_status_date_title_and_work_order_number():
    entries = parse_inbox(INBOX)
    assert len(entries) == 5
    home = by_title(entries, "Home: Command look")
    assert (home["header_status"], home["date"], home["wo"], home["from"]) == ("OPEN", "2026-10-07", 22, "MAC")
    parked = by_title(entries, "learns from itself")
    assert parked["header_status"] == "PARKED (FIRST AFTER BUTTON-UP)"
    assert parked["state"] == "PARKED"
    note = by_title(entries, "Owner posts from Review")
    assert note["header_status"] is None and note["date"] == "2026-09-30"


def test_header_status_wins_over_running_status_line():
    home = by_title(parse_inbox(INBOX), "Home: Command look")
    assert home["status_text"].startswith("running")
    assert home["state"] == "OPEN"


def test_replies_keep_direction_order_and_blocked_flag():
    wo19 = by_title(parse_inbox(INBOX), "Schedule two Shorts")
    assert [r["direction"] for r in wo19["replies"]] == ["to_mac", "from_mac", "to_mac"]
    assert wo19["replies"][0]["blocked"] is True
    assert wo19["replies"][1]["text"].startswith("(9:41 AM ET): Both")
    # The last word from Claude is DONE, so the earlier BLOCKED no longer counts.
    assert wo19["state"] == "DONE" and wo19["needs_attention"] is False


def test_last_reply_blocked_means_needs_attention_even_when_header_says_open():
    stalled = by_title(parse_inbox(INBOX), "Final render stalls")
    assert stalled["from"] == "Claude (autopilot)"
    assert stalled["state"] == "BLOCKED" and stalled["needs_attention"] is True


def test_entry_without_any_status_is_a_note():
    assert by_title(parse_inbox(INBOX), "Owner posts")["state"] == "NOTE"


def test_ids_are_stable_when_status_changes_or_entries_are_added_above():
    before = {e["title"]: e["id"] for e in parse_inbox(INBOX)}
    changed = "## OPEN — 2026-10-09 · Brand new order\n\nNew.\n\n" + INBOX.replace(
        "## OPEN — 2026-10-07 · WO from MAC #022", "## DONE — 2026-10-07 · WO from MAC #022"
    )
    after = {e["title"]: e["id"] for e in parse_inbox(changed)}
    for title, entry_id in before.items():
        assert after[title] == entry_id


def test_duplicate_headers_get_distinct_ids():
    text = "## 2026-10-01 · Same\n\na\n\n## 2026-10-01 · Same\n\nb\n"
    ids = [e["id"] for e in parse_inbox(text)]
    assert len(set(ids)) == 2


def test_status_line_blocked_without_header():
    assert derive_state(None, "BLOCKED on owner", []) == "BLOCKED"
    assert derive_state(None, "UNBLOCKED by MAC", []) == "OPEN"
    assert derive_state("DONE", None, []) == "DONE"


def test_mid_line_mentions_of_to_mac_are_not_replies():
    text = "## OPEN — 2026-10-01 · X\n\nIf you're blocked, write `TO MAC: BLOCKED` and stop.\n"
    assert parse_inbox(text)[0]["replies"] == []


def test_long_body_is_clipped_and_flagged():
    text = "## OPEN — 2026-10-01 · Long\n\n" + ("word " * 2000)
    entry = parse_inbox(text)[0]
    assert entry["body_truncated"] is True and len(entry["body"]) < 4100


def test_empty_and_headerless_text():
    assert parse_inbox("") == []
    assert parse_inbox("just some text\nno headers") == []
