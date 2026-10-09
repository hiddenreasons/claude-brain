"""Runs the page's JavaScript tests (tests/js, Node's built-in test runner) as part of pytest."""

import shutil
import subprocess
from pathlib import Path

import pytest

JS_TESTS = Path(__file__).parent / "js"


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is not installed")
def test_javascript_suite_passes():
    result = subprocess.run(
        ["node", "--test", *sorted(str(p) for p in JS_TESTS.glob("*.test.js"))],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
