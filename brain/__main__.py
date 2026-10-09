"""Run Claude Brain: `python3 -m brain` (live page) or `python3 -m brain --check` (one-shot summary)."""

from __future__ import annotations

import argparse
import dataclasses
import logging
import sys
from collections import Counter

from .config import LOOPBACK_HOSTS, load_config, parse_port
from .readers import FileCache
from .snapshot import build_snapshot


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="brain", description="Live, read-only view of MAC and Claude work.")
    parser.add_argument("--port", help="port to listen on (default 8777, or BRAIN_PORT)")
    parser.add_argument("--host", default="127.0.0.1", choices=LOOPBACK_HOSTS, help="loopback only")
    parser.add_argument("--check", action="store_true", help="print a summary of what the Brain can see, then exit")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(message)s")

    try:
        cfg = load_config()
        if args.port:
            cfg = dataclasses.replace(cfg, port=parse_port(args.port))
    except ValueError as exc:
        print(f"brain: {exc}", file=sys.stderr)
        return 2
    cfg = dataclasses.replace(cfg, host=args.host)

    if args.check:
        return check(cfg)

    from .server import serve  # imported here so --check works without the server

    try:
        serve(cfg)
    except PermissionError:
        print(
            f"brain: not allowed to listen on port {cfg.port}. If this runs inside Claude's sandbox, "
            "start it from your own Terminal instead.",
            file=sys.stderr,
        )
        return 1
    except OSError as exc:
        print(f"brain: can't listen on port {cfg.port}: {exc}. Try --port 8778.", file=sys.stderr)
        return 1
    return 0


def check(cfg) -> int:
    snap = build_snapshot(cfg, FileCache())
    missing = [name for name, src in snap["sources"].items() if not src["exists"]]

    def states(items):
        return dict(Counter(i["state"] for i in items))

    status = snap["status"]
    print(f"Inbox:   {len(snap['inbox'])} entries  {states(snap['inbox'])}")
    print(f"Folders: {len(snap['folders'])} MAC job folders  {states(snap['folders'])}")
    shown = len(snap["oneshots"])
    print(f"One-shot:{snap['oneshot_total']:>4} MAC orders  {states(snap['oneshots'])} (newest {shown})")
    print(
        f"Waiting on Anthony: {len(status['decisions'])}   Change log: {len(status['changelog'])}"
        f"   Incidents: {len(snap['issues'])}"
    )
    print(f"Needs attention: {len(snap['attention'])}")
    for item in snap["attention"]:
        print(f"  - [{item['state']}] {item['title'][:100]}")
    if missing:
        print(f"Missing sources: {', '.join(missing)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
