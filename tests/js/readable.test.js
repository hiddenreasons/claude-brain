"use strict";

// Run with: node --test tests/js/readable.test.js   (pytest runs it too: tests/test_js.py)
const test = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("../../brain/static/readable.js");

const types = (blocks) => blocks.map((b) => b.type);

test("a report splits into its heading, paragraphs, list and table", () => {
  const report = [
    "TO MAC: BLOCKED danger_guard (step 2: 5 files staged)",
    "",
    "# claudemd step 2 REPORT (2026-10-09, Opus high)",
    "",
    "Worktree: ~/.vader-mac-runs/claudemd/wt",
    "The step-1 report is still at `../REPORT-iter1.md`.",
    "",
    "**Commit:** none.",
    "- `git commit` exited 1 at the danger guard.",
    "- I did not run `--hold`.",
    "",
    "## Edit → source map",
    "",
    "| # | File:line | Change |",
    "|---|---|---|",
    "| A1 | STATE.md:99 | Applied |",
    "| A2 | STATE.md:203 | Applied |",
  ].join("\n");
  const blocks = parse(report);
  assert.deepEqual(types(blocks), ["p", "h", "p", "p", "ul", "h", "table"]);
  assert.deepEqual([blocks[1].level, blocks[1].text], [1, "claudemd step 2 REPORT (2026-10-09, Opus high)"]);
  assert.equal(blocks[2].text, "Worktree: ~/.vader-mac-runs/claudemd/wt\nThe step-1 report is still at `../REPORT-iter1.md`.");
  assert.deepEqual(blocks[4].items.map((it) => it.text), ["`git commit` exited 1 at the danger guard.", "I did not run `--hold`."]);
  assert.deepEqual(blocks[6].head, ["#", "File:line", "Change"]);
  assert.deepEqual(blocks[6].rows, [["A1", "STATE.md:99", "Applied"], ["A2", "STATE.md:203", "Applied"]]);
});

test("nested and numbered lists keep their depth; a wrapped line stays with its item", () => {
  const blocks = parse("- **STATE.md:**\n  - three lines went in\n    cleanly\n  - plan now reads Pro\n\n1. first\n2. second");
  assert.deepEqual(types(blocks), ["ul", "ol"]);
  assert.deepEqual(blocks[0].items.map((it) => [it.depth, it.text]), [
    [0, "**STATE.md:**"], [1, "three lines went in\ncleanly"], [1, "plan now reads Pro"],
  ]);
  assert.deepEqual(blocks[1].items.map((it) => it.text), ["first", "second"]);
});

test("code fences keep their text exactly, markdown inside them included", () => {
  const blocks = parse("Run this:\n```bash\ncd ~/x && git commit -F ../MSG.txt\n# not a heading\n```\nDone.");
  assert.deepEqual(types(blocks), ["p", "code", "p"]);
  assert.equal(blocks[1].text, "cd ~/x && git commit -F ../MSG.txt\n# not a heading");
});

test("quotes and rules", () => {
  const blocks = parse("> MAC said\n> two lines\n\n---\n\nafter");
  assert.deepEqual(types(blocks), ["quote", "hr", "p"]);
  assert.equal(blocks[0].text, "MAC said\ntwo lines");
});

test("it returns data, never markup: tags in a report stay plain text", () => {
  const blocks = parse('<img src=x onerror="alert(1)"> and <handoff file="x">');
  assert.deepEqual(blocks, [{ type: "p", text: '<img src=x onerror="alert(1)"> and <handoff file="x">' }]);
});

test("empty or missing text gives no blocks; an unclosed fence runs to the end", () => {
  assert.deepEqual(parse(""), []);
  assert.deepEqual(parse(null), []);
  assert.deepEqual(parse("```\nline"), [{ type: "code", text: "line" }]);
});
