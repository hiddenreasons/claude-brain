"use strict";

// Run with: node --test tests/js/vaderlink.test.js   (pytest runs it too: tests/test_js.py)
// The Open VADER link carries ?page= for the tab its label names, so VADER opens on that tab.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// app.js is a page script, not a module: run just the link helpers from it.
const app = fs.readFileSync(path.join(__dirname, "../../brain/static/app.js"), "utf8");
const start = app.indexOf("const VADER_URL = ");
const end = app.indexOf("function vaderLink(");
assert.ok(start > 0 && end > start, "the VADER link helpers are in app.js");
const ctx = {};
vm.runInNewContext(app.slice(start, end) + "\nthis.vaderHref = vaderHref; this.vaderWhere = vaderWhere;", ctx);
const { vaderHref, vaderWhere } = ctx;

test("each label's tab is the ?page= on the link", () => {
  const cases = [
    ["Short 34 waits for the owner to review it", "Produce → Review", "http://localhost:8765/?page=review"],
    ["danger_guard holds docs/AGENT WORKFLOW.md", "System · protected changes", "http://localhost:8765/?page=system"],
    ["15 new topic candidates", "Topics", "http://localhost:8765/?page=topics"],
    ["Answer the Windows RAM question", "Home · Needs you", "http://localhost:8765/?page=home"],
  ];
  for (const [text, label, href] of cases) {
    assert.equal(vaderWhere(text), label, text);
    assert.equal(vaderHref(text), href, text);
  }
});

test("a tab with no VADER page name gets plain VADER", () => {
  const other = {};
  vm.runInNewContext(app.slice(start, end) + '\nvaderWhere = () => "Channel · stats";\nthis.href = vaderHref("x");', other);
  assert.equal(other.href, "http://localhost:8765/");
});

test("the link still says which tab it opens", () => {
  assert.match(app, /href: vaderHref\(text\)[^\n]*`Open VADER ↗ · \$\{vaderWhere\(text\)\}`/);
});
