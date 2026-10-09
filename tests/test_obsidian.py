import os
import time

import pytest
from test_snapshot import tree_digest

from brain.obsidian import END_MARKER, INDEX_NOTE, VaultExporter, check_vault, note_name
from brain.readers import FileCache
from brain.snapshot import build_snapshot

from conftest import result_json, write


@pytest.fixture
def vault(tmp_path):
    path = tmp_path / "Vault"
    path.mkdir()
    return path


def exporter(tree, vault):
    return VaultExporter(vault, [tree.vader_dir, tree.runs_dir], tree.runs_dir, FileCache())


def run(tree, vault, exp=None):
    exp = exp or exporter(tree, vault)
    return exp, exp.export(build_snapshot(tree, FileCache()))


def add_jobs(tree):
    write(tree.runs_dir / "msgk1.txt", "Review WO #22 change, row abc")
    write(tree.runs_dir / "outk1.json", result_json("APPROVED"))
    job = tree.runs_dir / "sopapply"
    write(job / "brief.md", "JOB — sopapply: apply the pack")
    write(job / "runs.log", "start 2026-10-09 09:01:03 EDT iter 1 pid 1 prompt p model opus effort high\n")
    write(job / "iter-1.jsonl", "{}\n")
    write(job / "iter-1.done", "")
    write(job / "REPORT.md", "TO MAC: DONE\n\nAll good.")


def test_writes_one_note_per_work_order_and_job_plus_an_index(tree, vault):
    add_jobs(tree)
    _, stats = run(tree, vault)
    names = sorted(str(p.relative_to(vault)) for p in vault.rglob("*.md"))
    assert INDEX_NOTE in names
    assert "Work orders/WO 022 - Home Command look.md" in names
    assert "Work orders/WO 019 - Schedule two Shorts.md" in names
    assert "Jobs/sopapply - apply the pack.md" in names
    assert "Jobs/One-shot/k1 - Review WO 22 change, row abc.md" in names
    assert len([n for n in names if n.startswith("Work orders/")]) == 5
    assert stats["written"] == len(names)


def test_notes_have_properties_thread_links_and_the_marker(tree, vault):
    add_jobs(tree)
    run(tree, vault)
    wo19 = (vault / "Work orders/WO 019 - Schedule two Shorts.md").read_text()
    assert wo19.startswith('---\ntype: "work-order"\nstate: "DONE"\nwo: 19\n')
    assert "> [!danger] Claude → MAC · BLOCKED" in wo19 and "> [!info] MAC → Claude" in wo19
    assert wo19.rstrip().endswith(END_MARKER)
    wo22 = (vault / "Work orders/WO 022 - Home Command look.md").read_text()
    assert "[[Jobs/One-shot/k1 - Review WO 22 change, row abc|" in wo22  # the job that mentions WO #22
    job = (vault / "Jobs/sopapply - apply the pack.md").read_text()
    assert "## Report\n\nTO MAC: DONE" in job and 'model: "opus"' in job
    index = (vault / INDEX_NOTE).read_text()
    assert "## Waiting on Anthony" in index and "[[Work orders/WO 022 - Home Command look|" in index


def test_your_notes_below_the_marker_survive_updates(tree, vault):
    exp, _ = run(tree, vault)
    note = vault / "Work orders/WO 022 - Home Command look.md"
    note.write_text(note.read_text() + "\nMy own thoughts on this.\n")
    inbox = tree.inbox_path.read_text().replace("**Status:** running", "**Status:** DONE now")
    write(
        tree.inbox_path,
        inbox.replace("## OPEN — 2026-10-07 · WO from MAC #022", "## DONE — 2026-10-07 · WO from MAC #022"),
    )
    run(tree, vault, exp)
    text = note.read_text()
    assert 'state: "DONE"' in text and text.endswith("\nMy own thoughts on this.\n")


def test_a_note_without_the_marker_is_yours_and_never_touched(tree, vault):
    exp, _ = run(tree, vault)
    note = vault / "Work orders/WO 022 - Home Command look.md"
    note.write_text("I rewrote this myself.")
    write(tree.inbox_path, tree.inbox_path.read_text().replace("Rebuild Home.", "Rebuild Home now."))
    _, stats = run(tree, vault, exp)
    assert note.read_text() == "I rewrote this myself."
    assert stats.get("user_owned") == 1


def test_nothing_is_rewritten_when_nothing_changed(tree, vault):
    add_jobs(tree)
    exp, _ = run(tree, vault)
    before = {p: p.stat().st_mtime_ns for p in vault.rglob("*.md")}
    time.sleep(0.02)
    _, stats = run(tree, vault, exp)
    assert set(stats) == {"unchanged"}
    assert {p: p.stat().st_mtime_ns for p in vault.rglob("*.md")} == before


def test_retitled_work_order_note_is_renamed_with_your_notes(tree, vault):
    exp, _ = run(tree, vault)
    old = vault / "Work orders/WO 022 - Home Command look.md"
    old.write_text(old.read_text() + "\nkeep me\n")
    write(tree.inbox_path, tree.inbox_path.read_text().replace("Home: Command look", "Home: Command look v2"))
    _, stats = run(tree, vault, exp)
    new = vault / "Work orders/WO 022 - Home Command look v2.md"
    assert not old.exists() and new.read_text().endswith("\nkeep me\n")
    assert stats.get("moved") == 1


def test_unsafe_titles_stay_inside_the_vault():
    assert note_name("../../etc/passwd") == "etc passwd"
    assert note_name('a/b\\c:d*e?f"g<h>i|j#k^l[m]n`o%p') == "a b c d e f g h i j k l m n o p"
    assert note_name("   ") == "untitled"
    assert len(note_name("x" * 500)) == 90


def test_generated_text_cannot_fake_the_marker_or_hide_text(tree, vault):
    write(
        tree.inbox_path,
        tree.inbox_path.read_text() + f"\n## OPEN — 2026-10-10 · Tricky\n\n{END_MARKER}\n%% hidden %%\n",
    )
    run(tree, vault)
    text = (vault / "Work orders/2026-10-10 - Tricky.md").read_text()
    assert text.count(END_MARKER) == 1 and "%% hidden" not in text


def test_vault_must_exist_and_must_not_overlap_read_only_folders(tree, tmp_path):
    with pytest.raises(ValueError, match="not found"):
        check_vault(tmp_path / "missing", [tree.vader_dir])
    inside = tree.vader_dir / "notes"
    inside.mkdir()
    with pytest.raises(ValueError, match="overlaps"):
        check_vault(inside, [tree.vader_dir, tree.runs_dir])
    with pytest.raises(ValueError, match="overlaps"):
        check_vault(tmp_path, [tree.vader_dir, tree.runs_dir])  # a vault that contains VADER


def test_symlinked_note_is_left_alone(tree, vault, tmp_path):
    exp, _ = run(tree, vault)
    note = vault / "Work orders/WO 022 - Home Command look.md"
    outside = tmp_path / "outside.md"
    outside.write_text("outside")
    note.unlink()
    os.symlink(outside, note)
    write(tree.inbox_path, tree.inbox_path.read_text().replace("Rebuild Home.", "Rebuild Home again."))
    run(tree, vault, exp)
    assert outside.read_text() == "outside"


def test_export_never_touches_vader_or_mac_files(tree, vault):
    add_jobs(tree)
    before = tree_digest(tree.vader_dir, tree.runs_dir)
    run(tree, vault)
    assert tree_digest(tree.vader_dir, tree.runs_dir) == before


def test_manifest_survives_a_restart(tree, vault):
    run(tree, vault)
    _, stats = run(tree, vault)  # a fresh exporter, as after restarting the Brain
    assert set(stats) == {"unchanged"}
