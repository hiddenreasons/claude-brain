"use strict";

// Guardrails for drafted messages: never hand over a message with a blank field or an unfilled
// {{PLACEHOLDER}}. No page code here, so Node can test it (tests/js/rules.test.js). ask.js calls it.

(function (root) {
  const PLACEHOLDER = /\{\{\s*[A-Za-z][A-Za-z0-9_.-]*\s*\}\}/;
  const BLANK_FIELD = /^[ \t]*[A-Z][A-Za-z ]{1,30}:[ \t]*$/m; // "Status line:" with nothing after it

  // { ok, problem } for a draft { to, subject, body } (the body may be the edited text from the dialog).
  function checkDraft(draft) {
    if (!draft || !String(draft.to || "").trim()) return { ok: false, problem: "No recipient." };
    if (!String(draft.subject || "").trim()) return { ok: false, problem: "The subject is empty." };
    const body = String(draft.body || "");
    if (!body.trim()) return { ok: false, problem: "The message is empty." };
    const ph = body.match(PLACEHOLDER) || String(draft.subject).match(PLACEHOLDER);
    if (ph) return { ok: false, problem: `It still has an unfilled ${ph[0]}. Fill it in before copying.` };
    const blank = body.match(BLANK_FIELD);
    if (blank) return { ok: false, problem: `"${blank[0].trim()}" has nothing after it. Fill it in or remove the line.` };
    // "undefined"/"NaN" only come from a broken draft ("null" can be real text, e.g. "error null").
    if (/\b(undefined|NaN)\b/.test(body)) return { ok: false, problem: "It contains 'undefined' where text should be." };
    return { ok: true, problem: null };
  }

  const api = { checkDraft };
  root.Rules = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
