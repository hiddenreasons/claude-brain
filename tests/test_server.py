"""End-to-end over a real loopback socket. Skipped where the sandbox forbids listening on a port."""

import dataclasses
import http.client
import json
import socket
import threading
import time
from http.server import ThreadingHTTPServer

import pytest

from brain.server import BrainState, make_handler

from conftest import result_json, write


def _can_bind():
    try:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
        return True
    except OSError:
        return False


pytestmark = pytest.mark.skipif(not _can_bind(), reason="this environment does not allow local ports")


@pytest.fixture
def server(tree):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    cfg = dataclasses.replace(tree, port=port)
    write(cfg.runs_dir / "msg7.txt", "Order seven")
    write(cfg.runs_dir / "out7.json", result_json("Result seven"))
    state = BrainState(cfg)
    state.refresh(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(state))
    httpd.daemon_threads = True
    threads = [
        threading.Thread(target=httpd.serve_forever, daemon=True),
        threading.Thread(target=state.watch, daemon=True),
    ]
    for t in threads:
        t.start()
    yield cfg, port
    state.stop()
    httpd.shutdown()
    httpd.server_close()


def get(port, path, host=None, method="GET"):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request(method, path, headers={"Host": host or f"127.0.0.1:{port}"})
    res = conn.getresponse()
    body = res.read()
    conn.close()
    return res, body


def test_page_and_assets_are_served_with_a_strict_policy(server):
    _, port = server
    res, body = get(port, "/")
    assert res.status == 200 and b"Claude Brain" in body
    assert "script-src 'self'" in res.getheader("Content-Security-Policy")
    assert res.getheader("X-Content-Type-Options") == "nosniff"
    for asset in ("/app.js", "/style.css"):
        assert get(port, asset)[0].status == 200


def test_snapshot_is_json(server):
    _, port = server
    res, body = get(port, "/api/snapshot")
    data = json.loads(body)
    assert res.status == 200 and data["oneshots"][0]["id"] == "7"


def test_job_detail_known_unknown_and_traversal(server):
    _, port = server
    res, body = get(port, "/api/job?kind=oneshot&id=7")
    assert res.status == 200 and json.loads(body)["result"] == "Result seven"
    for bad in (
        "/api/job?kind=oneshot&id=nope",
        "/api/job?kind=folder&id=..",
        "/api/job?kind=folder&id=..%2FVADER",
        "/api/job?kind=evil&id=7",
        "/api/job",
    ):
        assert get(port, bad)[0].status == 404


def test_wrong_host_header_is_refused(server):
    _, port = server
    assert get(port, "/api/snapshot", host="evil.example:80")[0].status == 421
    assert get(port, "/api/snapshot", host=f"localhost:{port}")[0].status == 200


def test_only_get_is_allowed(server):
    _, port = server
    for method in ("POST", "PUT", "DELETE"):
        assert get(port, "/api/snapshot", method=method)[0].status == 405


def test_unknown_path_is_404(server):
    _, port = server
    assert get(port, "/../../etc/passwd")[0].status == 404


def test_a_line_in_macs_message_log_reaches_the_page(server):
    cfg, port = server
    line = (
        '{"v":1,"id":"t1","at":"2026-10-09T15:16:57Z","from":"mac","to":"claude",'
        '"kind":"reply","text":"Test from MAC"}\n'
    )
    write(cfg.runs_dir / "brain" / "comms.jsonl", line)
    deadline = time.time() + 5
    while time.time() < deadline:
        data = json.loads(get(port, "/api/snapshot")[1])
        if any(m["id"] == "comms:t1" for m in data["messages"]):
            break
        time.sleep(0.1)
    assert data["comms"]["events"] == 1
    assert next(m for m in data["messages"] if m["id"] == "comms:t1")["direction"] == "to_claude"


def test_live_stream_announces_a_change_within_seconds(server):
    cfg, port = server
    sock = socket.create_connection(("127.0.0.1", port), timeout=5)
    sock.sendall(f"GET /events HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n".encode())
    buf = b""
    while buf.count(b"event: update") < 1:
        buf += sock.recv(4096)
    with open(cfg.inbox_path, "a", encoding="utf-8") as f:
        f.write("\n## OPEN — 2026-10-10 · Brand new work order\n")
    deadline = time.time() + 5
    while buf.count(b"event: update") < 2 and time.time() < deadline:
        buf += sock.recv(4096)
    sock.close()
    assert buf.count(b"event: update") >= 2
    _, body = get(port, "/api/snapshot")
    assert any(e["title"] == "Brand new work order" for e in json.loads(body)["inbox"])
