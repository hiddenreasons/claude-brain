"""Anthony's "Mark done": recorded in the Brain's own folder, then verified (proof) or sent to MAC."""

import http.client
import json

from test_server import get, server  # noqa: F401 (fixture)

from brain import marks
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
    path = tree.brain_dir / marks.MARKS_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"at": "2026-10-10T01:00:00+00:00", "kind": kind, "id": job_id, "action": action}) + "\n")


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


def test_a_mark_with_proof_in_the_report_is_verified(tree):
    stuck(tree.runs_dir, "shipped", "TO MAC: BLOCKED danger_guard; committed abc1234f on claude/x, 40 passed\n")
    mark(tree, "folder", "shipped")
    snap = build_snapshot(tree, FileCache())
    j = job(snap, "shipped")
    assert j["owner_mark"]["verified"] is True and j["proof"]["kind"] == "commit" and j["up_next"] is None
    assert not any(a["id"] == "shipped" for a in snap["mac_attention"])


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
    assert marks.apply(snap, {"remote:sbatch01": {"action": "done"}}) == []
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
    assert post(port, {**good, "id": "nope"})[0] == 404
    assert post(port, {**good, "action": "delete"})[0] == 404
    before = {p for p in cfg.runs_dir.rglob("*") if p.is_file()}
    status, data = post(port, good)
    assert status == 200 and json.loads(data)["mark"]["id"] == "7"
    new = {p for p in cfg.runs_dir.rglob("*") if p.is_file()} - before
    assert new and all(p.parent == cfg.brain_dir for p in new)
    snap = json.loads(get(port, "/api/snapshot")[1])
    assert next(o for o in snap["oneshots"] if o["id"] == "7")["owner_mark"]
