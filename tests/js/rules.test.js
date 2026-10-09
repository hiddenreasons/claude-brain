"use strict";

// Run with: node --test tests/js/rules.test.js   (pytest runs it too: tests/test_js.py)
const test = require("node:test");
const assert = require("node:assert/strict");
const { checkDraft } = require("../../brain/static/rules.js");

const good = { to: "mac", subject: "Job claudemd: blocked", body: "MAC, about job claudemd:\n\nState: blocked\nPlease unblock it." };

test("a complete draft is fine", () => {
  assert.deepEqual(checkDraft(good), { ok: true, problem: null });
});

test("an unfilled placeholder is blocked, in the body or the subject", () => {
  assert.equal(checkDraft({ ...good, body: "STATUS sha256={{STATUS_SHA12}}" }).ok, false);
  assert.match(checkDraft({ ...good, body: "x {{ JOB_ID }} y" }).problem, /\{\{ JOB_ID \}\}/);
  assert.equal(checkDraft({ ...good, subject: "Job {{JOB}}" }).ok, false);
});

test("a blank field, an empty subject or body, or no recipient is blocked", () => {
  assert.match(checkDraft({ ...good, body: "MAC, about it:\n\nStatus line:\nThanks" }).problem, /Status line:/);
  assert.equal(checkDraft({ ...good, subject: " " }).ok, false);
  assert.equal(checkDraft({ ...good, body: "\n  \n" }).ok, false);
  assert.equal(checkDraft({ ...good, to: "" }).ok, false);
  assert.equal(checkDraft(null).ok, false);
});

test("'undefined' from a broken draft is blocked, but real text saying null is not", () => {
  assert.equal(checkDraft({ ...good, body: "Job undefined is blocked" }).ok, false);
  assert.equal(checkDraft({ ...good, body: "manual tick wrote heartbeat.json, error null" }).ok, true);
});
