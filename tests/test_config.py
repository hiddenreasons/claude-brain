from pathlib import Path

import pytest

from brain.__main__ import main
from brain.config import DEFAULT_PORT, load_config, parse_port


def test_defaults_point_at_vader_and_mac_runs():
    cfg = load_config({})
    assert cfg.port == DEFAULT_PORT and cfg.host == "127.0.0.1"
    assert cfg.inbox_path == Path.home() / "Documents/Active Projects/VADER/docs/CLAUDE INBOX.md"
    assert cfg.status_path == Path.home() / ".vader-mac-runs/STATUS.md"


def test_env_overrides(tmp_path):
    env = {"BRAIN_VADER_DIR": str(tmp_path / "v"), "BRAIN_RUNS_DIR": str(tmp_path / "r"), "BRAIN_PORT": "9000"}
    cfg = load_config(env)
    assert (cfg.vader_dir, cfg.runs_dir, cfg.port) == (tmp_path / "v", tmp_path / "r", 9000)


@pytest.mark.parametrize("raw", ["abc", "80", "70000", ""])
def test_bad_ports_are_rejected_with_a_clear_message(raw):
    with pytest.raises(ValueError, match="port must"):
        parse_port(raw)


def test_only_loopback_hosts_are_accepted(capsys):
    with pytest.raises(SystemExit):
        main(["--host", "0.0.0.0", "--check"])
    assert "invalid choice" in capsys.readouterr().err


def test_check_mode_summarizes_and_fails_on_missing_sources(tree, monkeypatch, capsys):
    monkeypatch.setenv("BRAIN_VADER_DIR", str(tree.vader_dir))
    monkeypatch.setenv("BRAIN_RUNS_DIR", str(tree.runs_dir))
    assert main(["--check"]) == 0
    out = capsys.readouterr().out
    assert "Inbox:   5 entries" in out and "Needs attention: 1" in out
    monkeypatch.setenv("BRAIN_RUNS_DIR", str(tree.runs_dir / "missing"))
    assert main(["--check"]) == 1
