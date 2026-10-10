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

// claude.exec: the code stream and the 24-hour heat strip, driven only by the snapshot.
const node = (tag, props, ...kids) => ({ tag, props: props || {}, kids: kids.flat().filter((k) => k !== null && k !== undefined) });
const texts = (n) => (typeof n === "string" ? [n] : (n.kids || []).flatMap(texts));
const find = (n, test) => (typeof n === "string" ? [] : [...(test(n) ? [n] : []), ...(n.kids || []).flatMap((k) => find(k, test))]);
const execBox = (snap) => {
  const box = { snap, el: node, svg: node, tip: (t) => node("title", {}, t), plain: (t) => String(t || ""), openDetail: () => {}, ui: {}, store: { set() {} }, renderRunning() {}, document: {} };
  vm.runInNewContext("var streamNow = new Set(), streamSeen = new Set(), streamPrimed = false;" + pick("function streamLine(") + pick("function prompt(") + pick("function codeStream(") + pick("function heatStrip(")
    + "\nthis.codeStream = codeStream; this.heatStrip = heatStrip;", box);
  return box;
};
const job = (over) => ({ id: "WO-7", kind: "job", state: "running", model: "opus", effort: "high", activity: [], ...over });

test("the code stream shows only what a running job really did, and says so when idle", () => {
  const box = execBox({ windows: {}, timeline: null });
  const idle = texts(box.codeStream([job({ state: "done", lifecycle: "done", report_headline: "shipped" })])).join(" ");
  assert.match(idle, /last run/); // the last real outcome, not made-up work
  assert.doesNotMatch(idle, /sample|demo/i);
  const live = box.codeStream([job({ activity: [{ kind: "tool", name: "Edit", summary: "hud.js" }, { kind: "text", text: "adding a test" }] })]);
  const all = texts(live).join(" ");
  assert.match(all, /WO-7/);
  assert.match(all, /Edit/);
  assert.match(all, /# adding a test/);
});

test("the code stream adds Windows only while its heartbeat is fresh, and at most two Mac jobs", () => {
  const stale = execBox({ windows: { fresh: false, job: "WIN-1" } });
  assert.doesNotMatch(texts(stale.codeStream([job()])).join(" "), /WIN-1/);
  const fresh = execBox({ windows: { fresh: true, job: "WIN-1", last_log_line: "rendering" } });
  const jobs = [job({ id: "A" }), job({ id: "B" }), job({ id: "C" })];
  const tree = fresh.codeStream(jobs);
  const names = find(tree, (n) => n.props.class === "cs-job").map((n) => texts(n).join(""));
  assert.ok(names.includes("A") && names.includes("B") && names.includes("WIN-1"));
  assert.ok(!names.includes("C"), "the third running job is left out");
  assert.match(texts(tree).join(" "), /# rendering/);
});

test("lines are marked new only after the first draw, and only once", () => {
  const box = execBox({ windows: {} });
  const classes = (tree) => find(tree, (n) => String(n.props.class || "").startsWith("cs-line")).map((n) => n.props.class);
  const j = job({ activity: [{ kind: "tool", name: "Bash", summary: "pytest" }] });
  assert.ok(!classes(box.codeStream([j])).some((c) => c.includes("cs-new")), "first draw is not 'new'");
  assert.ok(!classes(box.codeStream([j])).some((c) => c.includes("cs-new")), "an unchanged redraw is not 'new'");
  const j2 = job({ activity: [...j.activity, { kind: "tool", name: "Edit", summary: "x.js" }] });
  assert.equal(classes(box.codeStream([j2])).filter((c) => c.includes("cs-new")).length, 1);
});

test("the heat strip has 24 hour cells per row, marks blocked jobs, and survives bad timeline data", () => {
  const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
  const lanes = {
    claude: [{ label: "WO-1", start: iso(now - 3600e3 * 2.5), end: iso(now - 3600e3 * 2.2), state: "blocked" }, { label: "WO-2", start: "nope", end: null }],
    windows: [{ label: "WIN-1", start: iso(now - 600e3), end: null, state: "running" }],
  };
  const strip = execBox({ timeline: { lanes } }).heatStrip();
  const cells = find(strip, (n) => n.tag === "rect");
  assert.equal(cells.length, 48);
  assert.equal(find(strip, (n) => n.tag === "circle").length, 1); // only the blocked job gets a red dot
  assert.equal(execBox({}).heatStrip(), null); // no timeline, no strip
  assert.doesNotThrow(() => execBox({ timeline: { lanes: { claude: [{}] } } }).heatStrip());
});
