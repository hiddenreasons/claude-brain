"use strict";

// Readable reports: splits the markdown Claude and MAC write (reports, final replies, orders, briefs) into
// blocks the page can lay out as headings, paragraphs, lists, tables, code and quotes. It returns plain
// data, never HTML; app.js builds the elements (inline `code`, **bold** and ~~strike~~ via md()), so text
// from a report can't inject markup. No page code here, so Node can test it (tests/js/readable.test.js).

(function (root) {
  const FENCE = /^\s*(```|~~~)/;
  const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  const BULLET = /^(\s*)[-*+]\s+(.*)$/;
  const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
  const QUOTE = /^\s*>\s?(.*)$/;
  const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const TABLE_ROW = /^\s*\|.*\|\s*$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

  function parse(text) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let para = null;
    const endPara = () => { if (para) { blocks.push({ type: "p", text: para.join("\n") }); para = null; } };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (FENCE.test(line)) {
        endPara();
        const close = line.trim().slice(0, 3), body = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
        blocks.push({ type: "code", text: body.join("\n") });
        i += 1; // the closing fence (or the end of the text)
        continue;
      }
      if (!line.trim()) { endPara(); i += 1; continue; }
      const h = line.match(HEADING);
      if (h) { endPara(); blocks.push({ type: "h", level: h[1].length, text: h[2] }); i += 1; continue; }
      if (RULE.test(line)) { endPara(); blocks.push({ type: "hr" }); i += 1; continue; }
      if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        endPara();
        const head = cells(line), rows = [];
        i += 2;
        while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]));
        blocks.push({ type: "table", head, rows });
        continue;
      }
      const b = line.match(BULLET), n = b ? null : line.match(NUMBERED);
      if (b || n) {
        endPara();
        const ordered = !!n, items = [];
        while (i < lines.length) {
          const l = lines[i], bb = l.match(BULLET), nn = bb ? null : l.match(NUMBERED);
          if ((ordered ? nn : bb)) {
            const m = ordered ? nn : bb;
            items.push({ depth: Math.floor(m[1].replace(/\t/g, "  ").length / 2), text: ordered ? m[3] : m[2] });
            i += 1;
          } else if (l.trim() && /^\s{2,}\S/.test(l) && !(ordered ? bb : nn) && items.length) {
            items[items.length - 1].text += `\n${l.trim()}`; // a wrapped line of the same item
            i += 1;
          } else break;
        }
        blocks.push({ type: ordered ? "ol" : "ul", items });
        continue;
      }
      const q = line.match(QUOTE);
      if (q) {
        endPara();
        const body = [];
        while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].match(QUOTE)[1]);
        blocks.push({ type: "quote", text: body.join("\n") });
        continue;
      }
      (para = para || []).push(line.trimEnd());
      i += 1;
    }
    endPara();
    return blocks;
  }

  const api = { parse };
  root.Readable = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
