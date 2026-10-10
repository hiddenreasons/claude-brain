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
