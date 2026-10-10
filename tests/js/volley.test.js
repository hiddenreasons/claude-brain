"use strict";

// Run with: node --test tests/js/volley.test.js   (pytest runs it too: tests/test_js.py)
const test = require("node:test");
const assert = require("node:assert/strict");
const { PALETTE, jobColor, jobKey, shot, Volley, BOLT_MS } = require("../../brain/static/volley.js");

const toClaude = (id, job) => ({ id, direction: "to_claude", ref: { source: "comms", job, wo: null } });
const toMac = (id, job) => ({ id, direction: "to_mac", ref: { source: "comms", job, wo: null } });

test("the same job gets the same colour on both Death Stars", () => {
  // MAC's side keys the job from its message log; Claude's side from its own job folder.
  const macSide = jobKey(toClaude("m1", "issuestab"));
  const claudeSide = jobKey({ id: "c1", direction: "to_mac", ref: { source: "job", kind: "folder", id: "issuestab" } });
  assert.equal(macSide, "issuestab");
  assert.equal(claudeSide, macSide);
  assert.equal(jobColor(macSide), jobColor(claudeSide));
  assert.ok(PALETTE.includes(jobColor(macSide)));
  // Work orders match too: MAC's "wo: 16" and Claude's inbox entry for #016.
  const fromLog = jobKey({ ref: { source: "comms", job: null, wo: 16 } });
  const fromInbox = jobKey({ ref: { source: "work_order", id: "wo-abc" } }, () => 16);
  assert.equal(fromLog, "WO #016");
  assert.equal(fromInbox, fromLog);
});

test("the palette stays clear of the blue, orange and purple bases and of alert red", () => {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
  for (const c of PALETTE) {
    for (const base of ["#6fd7ff", "#ff9628", "#a78bfa", "#e10600"]) assert.ok(dist(rgb(c), rgb(base)) > 90, `${c} too close to ${base}`);
  }
  // and clear of each other
  PALETTE.forEach((a, i) => PALETTE.slice(i + 1).forEach((b) => assert.ok(dist(rgb(a), rgb(b)) > 60, `${a} too close to ${b}`)));
});

test("no job colour is a shade of the alert red (no pinks or magentas)", () => {
  const hue = (h) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return null; // grey or white: no hue
    const x = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (x * 60 + 360) % 360;
  };
  for (const c of PALETTE) {
    const hh = hue(c);
    if (hh === null) continue;
    const fromRed = Math.min(hh, 360 - hh);
    assert.ok(fromRed >= 50, `${c} (hue ${Math.round(hh)}°) reads as the alert red`);
  }
});

test("one comms entry fires exactly one bolt, MAC to Claude flying right to left", () => {
  const v = new Volley();
  const m = toClaude("m1", "issuestab");
  v.push(m, jobKey(m), 0);
  v.push(m, jobKey(m), 5); // the same entry seen again does not fire twice
  const active = v.step(10);
  assert.equal(active.length, 1);
  assert.equal(v.queue.length, 0);
  assert.deepEqual([active[0].from, active[0].to, active[0].dir], ["mac", "claude", "rtl"]);
  assert.equal(active[0].color, jobColor("issuestab"));
});

test("a reply flies back the other way, Claude to MAC left to right", () => {
  const v = new Volley({ gap: 0 });
  v.push(toClaude("m1", "issuestab"), "issuestab", 0);
  v.push(toMac("m2", "issuestab"), "issuestab", 0);
  const [first, second] = v.step(0);
  assert.equal(first.dir, "rtl");
  assert.deepEqual([second.from, second.to, second.dir], ["claude", "mac", "ltr"]);
});

test("a job on the Windows machine fires between MAC and Windows, never Claude's station", () => {
  const onWindows = (m) => ({ ...m, machine: "windows" });
  const v = new Volley({ gap: 0 });
  v.push(onWindows(toClaude("w1", "tbatch01")), "tbatch01", 0);
  v.push(onWindows(toMac("w2", "tbatch01")), "tbatch01", 0);
  const [out, back] = v.step(0);
  assert.deepEqual([out.from, out.to, out.dir], ["mac", "windows", "ltr"]);
  assert.deepEqual([back.from, back.to, back.dir], ["windows", "mac", "rtl"]);
  v.step(BOLT_MS + 1);
  assert.ok(v.landings.every((l) => l.station !== "claude"));
  // a message from MAC's own machine still goes to Claude
  assert.equal(shot({ direction: "to_claude", machine: "mac" }).to, "claude");
});

test("no more than three bolts fly at once; the rest wait and then fire", () => {
  const v = new Volley({ gap: 0 });
  for (let i = 0; i < 5; i++) v.push(toClaude(`m${i}`, `job${i}`), `job${i}`, 0);
  assert.equal(v.step(0).length, 3);
  assert.equal(v.queue.length, 2);
  const later = v.step(BOLT_MS + 1); // the first three land, the last two start
  assert.equal(later.length, 2);
  assert.equal(v.queue.length, 0);
  assert.equal(v.landings.length, 3);
  assert.ok(v.landings.every((l) => l.station === "claude"));
});

test("reduced motion: no bolts at all, only a short flash on both nodes", () => {
  const v = new Volley({ calm: true });
  const result = v.push(toMac("m1", "issuestab"), "issuestab", 0);
  assert.equal(result.type, "flash");
  assert.deepEqual([result.from, result.to], ["claude", "mac"]);
  assert.equal(v.step(0).length, 0);
  assert.equal(v.queue.length, 0);
  assert.equal(v.flashes.length, 1);
  v.step(10_000);
  assert.equal(v.flashes.length, 0); // the flash ends; nothing moves
});
