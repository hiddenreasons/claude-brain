"""Anthony's "Mark done": recorded in the Brain's own folder, then verified (proof) or sent to MAC."""

import http.client
import json
import os
import subprocess

from test_server import get, server  # noqa: F401 (fixture)

from brain import gitread, marks
from brain.readers import FileCache
from brain.snapshot import build_snapshot

from conftest import write

HOUR = 3600
RUNLOG = (
    "start 2026-10-09 13:00:00 EDT iter 1 pid 1 prompt p model opus effort high\n"
    "end 2026-10-09 13:20:00 EDT iter 1 exit 0\n"
)


def stuck(runs, name, report):
    job = runs / name
    write(job / "brief.md", f"JOB: {name} (A-006, Opus high)\n", age_s=HOUR)
    write(job / "runs.log", RUNLOG, age_s=HOUR)
    write(job / "iter-1.jsonl", "{}\n", age_s=HOUR)
    write(job / "iter-1.done", "", age_s=HOUR)
    write(job / "REPORT.md", report, age_s=HOUR)


def mark(tree, kind, job_id, action="done"):
    """Record a mark the way the server does: with how the job looks right now."""
    record = {"at": "2026-10-10T01:00:00+00:00", "kind": kind, "id": job_id, "action": action}
    if action == "done":
        group = {"folder": "folders", "oneshot": "oneshots", "remote": "remote_jobs"}[kind]
        current = next(j for j in build_snapshot(tree, FileCache())[group] if j["id"] == job_id)
        record.update(marks.snapshot_of(kind, current))
    path = tree.brain_dir / marks.MARKS_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")


def commit_in(repo):
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@t",
    }
    repo.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", str(repo)], check=True, capture_output=True)
    (repo / "a.txt").write_text("a")
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True, capture_output=True, env=env)
    subprocess.run(["git", "-C", str(repo), "commit", "-qm", "work"], check=True, capture_output=True, env=env)
    gitread.clear_cache()
    return subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()


def job(snapshot, job_id):
    return next(j for j in snapshot["folders"] if j["id"] == job_id)


def test_a_mark_without_proof_is_unverified_and_goes_to_mac_not_anthony(tree):
    stuck(tree.runs_dir, "quiet", "TO MAC: BLOCKED waiting on something\n")
    assert any(a["id"] == "quiet" for a in build_snapshot(tree, FileCache())["attention"])
    mark(tree, "folder", "quiet")
    snap = build_snapshot(tree, FileCache())
    j = job(snap, "quiet")
    assert j["owner_mark"]["verified"] is False and j["lifecycle"] == "done" and j["action"] == "done"
    assert j["up_next"] == "MAC" and "unverified" in j["action_note"]
    assert not any(a["id"] == "quiet" for a in snap["attention"])
    assert any(a["id"] == "quiet" and a["source"] == "owner-mark" for a in snap["mac_attention"])


def test_a_mark_is_verified_by_a_commit_that_git_confirms(tree):
    sha = commit_in(tree.runs_dir / "shipped" / "wt")
    stuck(tree.runs_dir, "shipped", f"TO MAC: BLOCKED danger_guard; committed {sha[:10]} on claude/x\n")
    mark(tree, "folder", "shipped")
    snap = build_snapshot(tree, FileCache())
    j = job(snap, "shipped")
    assert j["owner_mark"]["verified"] is True and j["proof"]["text"].startswith(sha[:10]) and j["up_next"] is None
    assert not any(a["id"] == "shipped" for a in snap["mac_attention"])


def test_words_in_a_blocked_report_are_not_proof(tree):
    report = "TO MAC: BLOCKED sandbox refused writing docs/STATE.md; 40 passed; committed abc1234f (no such commit)\n"
    stuck(tree.runs_dir, "claims", report)
    mark(tree, "folder", "claims")
    j = job(build_snapshot(tree, FileCache()), "claims")
    assert j["owner_mark"]["verified"] is False and j["up_next"] == "MAC"


def test_a_mark_lapses_when_the_job_changes_after_it(tree):
    stuck(tree.runs_dir, "rerun", "TO MAC: BLOCKED waiting on something\n")
    mark(tree, "folder", "rerun")
    assert job(build_snapshot(tree, FileCache()), "rerun")["owner_mark"]
    write(tree.runs_dir / "rerun" / "REPORT.md", "TO MAC: BLOCKED again, a new problem\n")  # MAC re-ran it
    snap = build_snapshot(tree, FileCache())
    j = job(snap, "rerun")
    assert "owner_mark" not in j and j["owner_mark_lapsed"] and any(a["id"] == "rerun" for a in snap["attention"])


def test_the_waiting_on_anthony_count_drops_when_he_marks_a_job(tree):
    stuck(tree.runs_dir, "needsme", "TO MAC: BLOCKED needs the owner's approval (danger_guard)\n")
    before = build_snapshot(tree, FileCache())["foundation"]["mine"]
    mark(tree, "folder", "needsme")
    assert build_snapshot(tree, FileCache())["foundation"]["mine"] == before - 1


def test_a_mark_on_a_folder_never_hides_a_oneshot_with_the_same_id():
    snap = {
        "folders": [{"id": "7", "state": "blocked", "lifecycle": "blocked", "report_at": "r"}],
        "oneshots": [],
        "remote_jobs": [],
        "windows": {},
        "attention": [{"source": "job", "kind": "folder", "id": "7"}, {"source": "job", "kind": "oneshot", "id": "7"}],
    }
    marks.apply(snap, {"folder:7": {"action": "done", "state": "blocked", "seen": "r"}}, [])
    assert snap["attention"] == [{"source": "job", "kind": "oneshot", "id": "7"}]


def test_undo_puts_the_job_back_and_keeps_the_history(tree):
    stuck(tree.runs_dir, "quiet", "TO MAC: BLOCKED waiting on something\n")
    mark(tree, "folder", "quiet")
    mark(tree, "folder", "quiet", "undo")
    snap = build_snapshot(tree, FileCache())
    assert "owner_mark" not in job(snap, "quiet") and any(a["id"] == "quiet" for a in snap["attention"])
    assert len((tree.brain_dir / marks.MARKS_FILE).read_text().splitlines()) == 2  # nothing deleted


def test_a_windows_job_is_verified_by_its_done_report():
    snap = {
        "folders": [],
        "oneshots": [],
        "attention": [],
        "remote_jobs": [{"id": "sbatch01", "machine": "WINDOWS", "lifecycle": "running"}],
        "windows": {"recent": [{"job": "sbatch01", "first_line": "TO MAC: DONE"}]},
    }
    assert marks.apply(snap, {"remote:sbatch01": {"action": "done", "state": None, "seen": None}}, []) == []
    assert snap["remote_jobs"][0]["owner_mark"]["proof"]["kind"] == "report"


def post(port, body, origin=True, header=True, ctype="application/json"):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Host": f"127.0.0.1:{port}", "Content-Type": ctype}
    if origin:
        headers["Origin"] = origin if isinstance(origin, str) else f"http://127.0.0.1:{port}"
    if header:
        headers["X-Brain-Action"] = "mark"
    conn.request("POST", "/api/mark", body=json.dumps(body), headers=headers)
    res = conn.getresponse()
    data = res.read()
    conn.close()
    return res.status, data


def test_the_mark_endpoint_takes_only_the_pages_own_requests(server):  # noqa: F811
    cfg, port = server
    good = {"kind": "oneshot", "id": "7", "action": "done"}
    assert post(port, good, header=False)[0] == 403
    assert post(port, good, origin="http://evil.example")[0] == 403
    assert post(port, good, origin=False)[0] == 403
    assert post(port, good, ctype="text/plain")[0] == 403
    assert post(port, {**good, "id": "nope"})[0] == 409  # not a job the page shows as markable
    assert post(port, {**good, "action": "delete"})[0] == 404
    assert post(port, {**good, "action": "undo"})[0] == 404  # nothing to undo yet
    before = {p for p in cfg.runs_dir.rglob("*") if p.is_file()}
    status, data = post(port, good)
    assert status == 200 and json.loads(data)["mark"]["id"] == "7"
    new = {p for p in cfg.runs_dir.rglob("*") if p.is_file()} - before
    assert new and all(p.parent == cfg.brain_dir for p in new)
    snap = json.loads(get(port, "/api/snapshot")[1])
    assert next(o for o in snap["oneshots"] if o["id"] == "7")["owner_mark"]
    assert post(port, good)[0] == 409  # already marked
    assert post(port, {**good, "action": "undo"})[0] == 200
    snap = json.loads(get(port, "/api/snapshot")[1])
    assert "owner_mark" not in next(o for o in snap["oneshots"] if o["id"] == "7")


def test_a_cross_site_post_cannot_smuggle_a_mark_in_its_body(server):  # noqa: F811
    """A refused text/plain POST whose body is a complete valid POST must not run that inner request."""
    import socket

    cfg, port = server
    inner = json.dumps({"kind": "oneshot", "id": "7", "action": "done"})
    smuggled = (
        f"POST /api/mark HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\n"
        f"X-Brain-Action: mark\r\nContent-Type: application/json\r\nContent-Length: {len(inner)}\r\n\r\n{inner}"
    )
    outer = (
        f"POST /api/mark HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://evil.example\r\n"
        f"Content-Type: text/plain\r\nContent-Length: {len(smuggled)}\r\n\r\n{smuggled}"
    )
    with socket.create_connection(("127.0.0.1", port), timeout=5) as s:
        s.sendall(outer.encode())
        reply = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            reply += chunk
    assert reply.startswith(b"HTTP/1.1 403") and reply.count(b"HTTP/1.1 ") == 1
    assert not (cfg.brain_dir / marks.MARKS_FILE).exists()


def test_a_refused_or_oversized_post_closes_the_connection(server):  # noqa: F811
    _, port = server
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    big = json.dumps({"kind": "oneshot", "id": "7", "action": "done", "pad": "x" * 4000})
    headers = {
        "Host": f"127.0.0.1:{port}",
        "Content-Type": "application/json",
        "Origin": f"http://127.0.0.1:{port}",
        "X-Brain-Action": "mark",
    }
    conn.request("POST", "/api/mark", body=big, headers=headers)
    res = conn.getresponse()
    res.read()
    assert res.status == 400 and res.getheader("Connection", "").lower() == "close"
    conn.close()
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("POST", "/api/mark", body=big, headers={"Host": f"127.0.0.1:{port}"})
    res = conn.getresponse()
    res.read()
    assert res.status == 403 and res.getheader("Connection", "").lower() == "close"
    conn.close()
