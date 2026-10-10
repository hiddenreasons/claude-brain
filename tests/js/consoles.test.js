"use strict";

// Run with: node --test tests/js/consoles.test.js   (pytest runs it too: tests/test_js.py)
// The comms console: which link a message travels on, and what each feed filter keeps.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const hud = fs.readFileSync(path.join(__dirname, "../../brain/static/hud.js"), "utf8");
const pick = (start) => { const i = hud.indexOf(start); assert.ok(i >= 0, start); return hud.slice(i, hud.indexOf("\n}\n", i) + 3); };
const ctx = { ui: { commsFilter: "all" } };
vm.runInNewContext(pick("function linkOf(") + pick("function commsMatch(") + "\nthis.linkOf = linkOf; this.commsMatch = commsMatch;", ctx);

const toClaude = { direction: "to_claude", machine: "mac" };
const fromWindows = { direction: "to_mac", machine: "windows" };
const codex = { direction: "codex", machine: "windows" };
const blocked = { direction: "to_mac", machine: "mac", blocked: true, cleared: false };
const cleared = { direction: "to_mac", machine: "mac", blocked: true, cleared: true };

test("each message rides the link between MAC and the machine it is about", () => {
  assert.equal(ctx.linkOf(toClaude), "claude");
  assert.equal(ctx.linkOf(fromWindows), "windows");
  assert.equal(ctx.linkOf(codex), "codex"); // Codex on Windows still has its own link
});

test("the feed filters keep only their messages", () => {
  const all = [toClaude, fromWindows, codex, blocked, cleared];
  const keep = (f) => { ctx.ui.commsFilter = f; return all.filter((m) => ctx.commsMatch(m)); };
  assert.equal(keep("all").length, 5);
  assert.deepEqual(keep("windows"), [fromWindows]);
  assert.deepEqual(keep("codex"), [codex]);
  assert.deepEqual(keep("claude"), [toClaude, blocked, cleared]);
  assert.deepEqual(keep("blocked"), [blocked]); // a blocked report MAC has since cleared is history
});

test("every open order sits in exactly one column, so the columns add up", () => {
  const box = { plain: (t) => String(t || ""), revealOrder: () => {} };
  box.el = (tag, props, ...kids) => ({ tag, props: props || {}, kids: kids.flat().filter((k) => k !== null && k !== undefined) });
  vm.runInNewContext(pick("function orderColumns(") + "\nthis.orderColumns = orderColumns;", box);
  const orders = [
    { id: "a", wo: 1, title: "needs", state: "OPEN", action: "needs_anthony" },
    { id: "b", wo: 2, title: "parked but marked running", state: "PARKED", action: "in_progress" },
    { id: "c", wo: 3, title: "running and queued", state: "RUNNING", action: "queued" },
    { id: "d", wo: 4, title: "open, other action", state: "OPEN", action: "something_else" },
    { id: "e", wo: 5, title: "queued", state: "OPEN", action: "queued" },
  ];
  const cols = box.orderColumns(orders).kids;
  const count = (col) => Number(col.kids[0].kids[1].kids[0]); // h3 > span > text
  const byName = Object.fromEntries(cols.map((c) => [c.kids[0].kids[0], count(c)]));
  assert.deepEqual(byName, { "NEEDS YOU": 1, RUNNING: 1, QUEUED: 2, PARKED: 1 });
  assert.equal(Object.values(byName).reduce((a, b) => a + b, 0), orders.length);
});
