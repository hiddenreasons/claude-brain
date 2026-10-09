"use strict";

// Run with: node --test tests/js/synapse.test.js   (pytest runs it too: tests/test_js.py)
const test = require("node:test");
const assert = require("node:assert/strict");
const { route, target, arc, Sparks, SPARK_MS, RED_EVERY_MS } = require("../../brain/static/synapse.js");

const node = (id, ll, action = "queued", key = id) => ({ id, key, ll, action });

test("a spark follows the grid: along its latitude, then down a meridian, from source to target", () => {
  const pts = route([20, 10], [-30, 70]);
  assert.deepEqual(pts[0], [20, 10]);
  assert.deepEqual(pts[pts.length - 1], [-30, 70]);
  const turn = pts.findIndex((p) => p[1] === 70);
  assert.ok(pts.slice(0, turn + 1).every((p) => p[0] === 20), "first leg stays on the latitude");
  assert.ok(pts.slice(turn).every((p) => p[1] === 70), "second leg stays on the meridian");
});

test("it goes the short way round the station", () => {
  const pts = route([0, 170], [0, -170]);
  assert.ok(pts.every((p) => p[1] >= 170 && p[1] <= 190), "crosses the 180° line instead of going 340° round");
});

test("the target is the nearest other live node, never a finished one or the job's own twin", () => {
  const a = node("a", [10, 0]);
  const near = node("near", [12, 5], "done");
  const twin = node("twin", [10, 1], "queued", "a");
  const live = node("live", [30, 20], "in_progress");
  const far = node("far", [-60, 150]);
  assert.equal(target(a, [a, near, twin, live, far]), live);
  assert.equal(target(a, [a, near]), null);
  // a live node right next door is skipped for one far enough away to see, but used when it's the only one
  const nextDoor = node("next", [12, 3], "queued");
  assert.equal(target(a, [a, nextDoor, live]), live);
  assert.equal(target(a, [a, nextDoor]), nextDoor);
  assert.ok(arc([0, 0], [0, 90]) > 89.9 && arc([0, 0], [0, 90]) < 90.1);
});

test("a running job's event fires one spark in its colour key; it ends after its run", () => {
  const s = new Sparks();
  const a = node("a", [10, 0], "in_progress"), b = node("b", [30, 40]);
  const spark = s.fire("claude", a, [a, b], 0);
  assert.deepEqual([spark.from, spark.to, spark.key, spark.red], ["a", "b", "a", false]);
  assert.equal(s.step(SPARK_MS - 1).length, 1);
  assert.equal(s.step(SPARK_MS).length, 0);
});

test("no more than four sparks at once on a station", () => {
  const s = new Sparks();
  const a = node("a", [10, 0], "in_progress"), b = node("b", [30, 40]);
  for (let i = 0; i < 6; i++) s.fire("claude", a, [a, b], 0);
  assert.equal(s.active.length, 4);
  s.fire("mac", a, [a, b], 0); // the other station has its own room
  assert.equal(s.active.length, 5);
});

test("a job that needs Anthony sends a red spark every few seconds, staggered from the start", () => {
  const s = new Sparks();
  const need = node("need", [10, 0], "needs_anthony"), other = node("o", [30, 40]);
  assert.equal(s.redPulse("mac", [need, other], 0).length, 0); // first look only sets the stagger
  const at = s.lastRed.get("need") + RED_EVERY_MS;
  const fired = s.redPulse("mac", [need, other], at);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].red, true);
  assert.equal(s.redPulse("mac", [need, other], at + 100).length, 0); // not again until the next beat
});

test("reduced motion: no sparks at all", () => {
  const s = new Sparks({ calm: true });
  const a = node("a", [10, 0], "needs_anthony"), b = node("b", [30, 40]);
  assert.equal(s.fire("claude", a, [a, b], 0), null);
  assert.deepEqual(s.redPulse("claude", [a, b], 1e9), []);
  assert.equal(s.active.length, 0);
});
