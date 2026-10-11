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

const orderBox = () => {
  const box = { plain: (t) => String(t || ""), revealOrder: () => {} };
  box.el = (tag, props, ...kids) => ({ tag, props: props || {}, kids: kids.flat().filter((k) => k !== null && k !== undefined) });
  vm.runInNewContext("const DAY_MS = 86400000;" + pick("function recentDone(") + pick("function needsYouOrders(") + pick("function orderColumns(") + "\nthis.orderColumns = orderColumns; this.recentDone = recentDone; this.needsYouOrders = needsYouOrders;", box);
  return box;
};
// h3 > [name span, count span]
const colCounts = (cols) => Object.fromEntries(cols.map((c) => [c.kids[0].kids[0].kids[0], Number(c.kids[0].kids[1].kids[0])]));
// The actions here are the ones brain/labels.py order_action really gives (tests/test_labels.py pins them):
// a BLOCKED order always carries needs_anthony; DONE and NOTE carry done; RUNNING carries in_progress or needs_anthony.
test("every open order sits in exactly one column, so the open columns add up", () => {
  const box = orderBox();
  const orders = [
    { id: "a", wo: 1, title: "waits on Anthony", state: "OPEN", action: "needs_anthony" },
    { id: "b", wo: 2, title: "parked", state: "PARKED", action: "queued" },
    { id: "c", wo: 3, title: "running", state: "RUNNING", action: "in_progress" },
    { id: "d", wo: 4, title: "running but waiting on Anthony", state: "RUNNING", action: "needs_anthony" },
    { id: "e", wo: 5, title: "queued", state: "OPEN", action: "queued" },
    { id: "f", wo: 6, title: "stuck", state: "BLOCKED", action: "needs_anthony" },
    { id: "g", wo: 7, title: "stuck too", state: "BLOCKED", action: "needs_anthony" },
    { id: "h", wo: 8, title: "parked, waiting on Anthony", state: "PARKED", action: "needs_anthony" },
  ];
  const byName = colCounts(box.orderColumns(orders).kids);
  assert.deepEqual(byName, { "NEEDS YOU": 3, BLOCKED: 2, RUNNING: 1, QUEUED: 1, PARKED: 1, DONE: 0 });
  const open = Object.entries(byName).filter(([k]) => !k.startsWith("DONE")).reduce((a, [, n]) => a + n, 0);
  assert.equal(open, orders.length);
});

test("blocked orders land in BLOCKED, not NEEDS YOU, even though the backend marks them needs_anthony", () => {
  const box = orderBox();
  const cols = box.orderColumns([{ id: "x", wo: 9, title: "stuck", state: "BLOCKED", action: "needs_anthony" }]).kids;
  const byName = colCounts(cols);
  assert.equal(byName.BLOCKED, 1);
  assert.equal(byName["NEEDS YOU"], 0);
});

test("the Done column keeps done orders dated today or in the last two days, newest first", () => {
  const box = orderBox();
  const now = new Date(2026, 9, 10, 0, 5); // five past midnight: the window is by calendar day, and `now` is passed in
  const done = (id, date) => ({ id, state: "DONE", action: "done", date, title: id });
  const inbox = [
    done("three-days", "2026-10-07"), done("today", "2026-10-10"), done("two", "2026-10-08"), done("yesterday", "2026-10-09"),
    done("future", "2026-10-11"), done("undated", null), done("garbage", "soon"),
    { id: "open", state: "OPEN", action: "queued", date: "2026-10-10", title: "still open" },
    { id: "note", state: "NOTE", action: "done", date: "2026-10-10", title: "a note" },
  ];
  assert.deepEqual(box.recentDone(inbox, now).map((e) => e.id), ["today", "yesterday", "two"]);
  const cols = box.orderColumns([], box.recentDone(inbox, now)).kids;
  assert.equal(colCounts(cols).DONE, 3);
  assert.equal(cols[5].props.class, "kb-col kb-done");
  // The column says what its date is: opened, not finished.
  const note = cols[5].kids.find((k) => k.props && k.props.class === "kb-note");
  assert.match(note.kids[0], /opened in the last 3 days/);
  assert.equal(colCounts(box.orderColumns([], []).kids).DONE, 0); // nothing recent: an empty column, no made-up rows
  assert.equal(cols[0].kids.find((k) => k.props && k.props.class === "kb-note"), undefined); // only Done carries the note
});

test("the 'waiting on you' orders leave out blocked ones, so the number matches the NEEDS YOU column", () => {
  const box = orderBox();
  const open = [
    { id: "a", state: "OPEN", action: "needs_anthony" }, { id: "b", state: "BLOCKED", action: "needs_anthony" },
    { id: "c", state: "BLOCKED", action: "needs_anthony" }, { id: "d", state: "RUNNING", action: "needs_anthony" },
    { id: "e", state: "OPEN", action: "queued" },
  ];
  assert.deepEqual(box.needsYouOrders(open).map((e) => e.id), ["a", "d"]);
  const byName = colCounts(box.orderColumns(open).kids);
  assert.equal(byName["NEEDS YOU"], box.needsYouOrders(open).length);
  assert.equal(byName.BLOCKED, 2);
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
