"use strict";

// The side HUD panels around the brains. Everything here is decoration made of real data:
// every ring, cell, blip and bar is computed from the live snapshot, and hovering shows what it is.
// Uses el(), relTime(), openDetail(), revealOrder(), allJobs() and STATE_LABELS from app.js.

const HUD_COLORS = {
  running: "#fff1a8", waiting: "#fff1a8", done: "#ffb15c", followed_up: "#50c8ff", cleared: "#5bd38a",
  blocked: "#ff4d5e", error: "#ff4d5e", gate_failed: "#ff4d5e", stalled: "#ff4d5e", no_report: "#ff4d5e",
  prepared: "#6b7280", no_result: "#6b7280",
  OPEN: "#50c8ff", RUNNING: "#fff1a8", BLOCKED: "#ff4d5e", PARKED: "#6b7280", DONE: "#46a758", NOTE: "#6b7280",
};
const HUD_GLYPHS = {
  running: "RUN", waiting: "WAIT", done: "DONE", followed_up: "F-UP", cleared: "CLRD", blocked: "BLKD", error: "ERR",
  gate_failed: "GATE", stalled: "STALL", no_report: "NORPT", prepared: "PREP", no_result: "NORES",
  OPEN: "OPEN", RUNNING: "RUN", BLOCKED: "BLKD", PARKED: "PARK", DONE: "DONE", NOTE: "NOTE",
};
const DAY_MS = 24 * 3600 * 1000;
const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag, attrs, ...kids) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const tip = (text) => svg("title", {}, text);
const ageMs = (iso) => (iso ? Date.now() - Date.parse(iso) : Infinity);
const shortAge = (iso) => relTime(iso).replace(" ago", "").replace("just now", "now");
const hudColor = (state) => HUD_COLORS[state] || "#9aa3ad";

// The page's security policy blocks style="" attributes, so colors are set through the style object instead.
function tinted(node, color) {
  node.style.setProperty("--c", color);
  return node;
}

function glyph(state) {
  return tinted(el("span", { class: "hud-glyph" }, HUD_GLYPHS[state] || state), hudColor(state));
}

function hudHead(title, sub) {
  return el("div", { class: "hud-head" },
    el("span", { class: "hud-blink", "aria-hidden": "true" }),
    el("span", { class: "hud-title" }, title),
    sub ? el("span", { class: "hud-sub" }, sub) : null,
  );
}

// ---------- graphics ----------

// A ring split into colored arcs. parts: [{value, color, label}]
function ring(parts, centerBig, centerSmall, label) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const r = 34;
  const c = 2 * Math.PI * r;
  const arcs = [];
  let offset = 0;
  for (const p of parts) {
    if (!p.value) continue;
    const len = (p.value / total) * c;
    arcs.push(svg("circle", {
      cx: 45, cy: 45, r, fill: "none", stroke: p.color, "stroke-width": 7,
      "stroke-dasharray": `${Math.max(0, len - 1.5)} ${c}`, "stroke-dashoffset": -offset, transform: "rotate(-90 45 45)",
      class: "hud-arc",
    }, tip(`${p.label}: ${p.value}`)));
    offset += len;
  }
  const ticks = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const r1 = i % 4 === 0 ? 40 : 42;
    ticks.push(svg("line", {
      x1: 45 + Math.cos(a) * r1, y1: 45 + Math.sin(a) * r1, x2: 45 + Math.cos(a) * 44, y2: 45 + Math.sin(a) * 44,
      class: "hud-tick",
    }));
  }
  const summary = parts.map((p) => `${p.label} ${p.value}`).join(", ");
  return el("figure", { class: "hud-ring" },
    svg("svg", { viewBox: "0 0 90 90", role: "img", "aria-label": `${label}: ${summary}` },
      svg("circle", { cx: 45, cy: 45, r, fill: "none", class: "hud-track", "stroke-width": 7 }),
      ...ticks,
      svg("g", { class: "hud-spin" }, svg("circle", { cx: 45, cy: 45, r: 26, fill: "none", class: "hud-dash" })),
      ...arcs,
      svg("text", { x: 45, y: 46, class: "hud-big", "text-anchor": "middle" }, centerBig),
      svg("text", { x: 45, y: 58, class: "hud-small", "text-anchor": "middle" }, centerSmall),
    ),
    el("figcaption", {}, label),
  );
}

// One hexagon per recent job, newest first, colored by state.
function hexGrid(jobs) {
  const size = 7;
  const w = Math.sqrt(3) * size;
  const cols = 15;
  const cells = jobs.slice(0, 60).map((job, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = 6 + col * w + (row % 2 ? w / 2 : 0);
    const cy = 8 + row * size * 1.5;
    const pts = Array.from({ length: 6 }, (_, k) => {
      const a = (Math.PI / 3) * k + Math.PI / 6;
      return `${(cx + Math.cos(a) * (size - 1)).toFixed(1)},${(cy + Math.sin(a) * (size - 1)).toFixed(1)}`;
    }).join(" ");
    const cell = svg("polygon", {
      points: pts, fill: hudColor(job.state), class: `hud-hex${job.state === "running" ? " hot" : ""}`,
    }, tip(`${HUD_GLYPHS[job.state] || job.state} · ${job.id}: ${job.title || ""}`));
    cell.style.animationDelay = `${(i * 37) % 900}ms`;
    return cell;
  });
  const height = 8 + Math.ceil(Math.max(cells.length, 1) / cols) * size * 1.5 + 4;
  return svg("svg", {
    viewBox: `0 0 ${6 + cols * w + w / 2} ${height}`, class: "hud-hexes", role: "img",
    "aria-label": `Last ${cells.length} jobs, one cell each, colored by status`,
  }, ...cells);
}

// Open work orders as radar blips: angle from the order, distance from its age (outer ring = 14 days).
function radar(orders) {
  const blips = orders.map((e, i) => {
    const days = e.date ? Math.max(0, (Date.now() - Date.parse(`${e.date}T12:00:00`)) / DAY_MS) : 14;
    const dist = 8 + Math.min(1, days / 14) * 50;
    const seed = e.wo !== null ? e.wo * 2.399 : i * 2.399; // golden-angle spread
    const a = seed % (Math.PI * 2);
    const x = 64 + Math.cos(a) * dist;
    const y = 64 + Math.sin(a) * dist;
    return svg("g", { class: "hud-blip", "data-id": e.id, tabindex: 0, role: "button",
      "aria-label": `${e.state} ${e.wo !== null ? `WO ${e.wo}` : ""} ${e.title}` },
      svg("circle", { cx: x, cy: y, r: e.state === "BLOCKED" ? 3.6 : 2.6, fill: hudColor(e.state) }),
      svg("circle", { cx: x, cy: y, r: 6, fill: "none", stroke: hudColor(e.state), class: "hud-ping" }),
      tip(`${e.state}${e.wo !== null ? ` · WO #${e.wo}` : ""} · ${e.title} · ${e.date || "undated"}`),
    );
  });
  for (const node of blips) {
    const open = () => revealOrder(node.getAttribute("data-id"));
    node.addEventListener("click", open);
    node.addEventListener("keydown", (ev) => (ev.key === "Enter" || ev.key === " ") && open());
  }
  const rings = [18, 31, 45, 58].map((r) => svg("circle", { cx: 64, cy: 64, r, class: "hud-radar-ring" }));
  return el("figure", { class: "hud-radar" },
    svg("svg", { viewBox: "0 0 128 128", role: "group", "aria-label": `${orders.length} open work orders by age` },
      ...rings,
      svg("line", { x1: 4, y1: 64, x2: 124, y2: 64, class: "hud-radar-ring" }),
      svg("line", { x1: 64, y1: 4, x2: 64, y2: 124, class: "hud-radar-ring" }),
      svg("g", { class: "hud-sweep" },
        svg("path", { d: "M64 64 L64 6 A58 58 0 0 1 105 23 Z", class: "hud-sweep-fill" }),
      ),
      ...blips,
    ),
    el("figcaption", {}, "Open orders · age radar · 14 d edge"),
  );
}

// Messages per hour, last 24 h: blue up for MAC to Claude, orange down for Claude to MAC.
function traffic(messages) {
  const now = Date.now();
  const toClaude = new Array(24).fill(0);
  const toMac = new Array(24).fill(0);
  for (const m of messages) {
    const age = ageMs(m.at);
    if (age < 0 || age >= DAY_MS) continue;
    const slot = 23 - Math.floor(age / 3600000);
    (m.direction === "to_claude" ? toClaude : toMac)[slot] += 1;
  }
  const peak = Math.max(1, ...toClaude, ...toMac);
  const bars = [];
  for (let i = 0; i < 24; i++) {
    const hour = new Date(now - (23 - i) * 3600000).getHours();
    const up = (toClaude[i] / peak) * 26;
    const down = (toMac[i] / peak) * 26;
    bars.push(svg("g", {},
      svg("rect", { x: 4 + i * 8, y: 30 - up, width: 5, height: Math.max(up, 0.6), class: "hud-bar-up" }),
      svg("rect", { x: 4 + i * 8, y: 31, width: 5, height: Math.max(down, 0.6), class: "hud-bar-down" }),
      tip(`${String(hour).padStart(2, "0")}:00 · MAC → Claude ${toClaude[i]} · Claude → MAC ${toMac[i]}`),
    ));
  }
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  return el("figure", { class: "hud-traffic" },
    svg("svg", { viewBox: "0 0 196 60", role: "img",
      "aria-label": `Last 24 hours: ${sum(toClaude)} messages MAC to Claude, ${sum(toMac)} Claude to MAC` },
      svg("line", { x1: 0, y1: 30.5, x2: 196, y2: 30.5, class: "hud-axis" }),
      ...bars,
    ),
    el("figcaption", {}, `Traffic 24 h · ▲ MAC→Claude ${sum(toClaude)} · ▼ Claude→MAC ${sum(toMac)}`),
  );
}

function stat(value, label, state) {
  return tinted(el("div", { class: "hud-stat" },
    el("span", { class: "hud-stat-v" }, String(value)),
    el("span", { class: "hud-stat-l" }, label),
  ), hudColor(state));
}

// ---------- tables ----------

function jobTable(jobs) {
  const rows = jobs.map((j) =>
    el("tr", { tabindex: 0, onclick: () => openDetail(j.kind, j.id, j.title),
      onkeydown: (ev) => ev.key === "Enter" && openDetail(j.kind, j.id, j.title) },
      el("td", {}, glyph(j.state)),
      el("td", { class: "hud-mono" }, j.id),
      el("td", { class: "hud-desc" }, md(j.report_headline && j.kind === "folder" ? `${j.title} — ${j.report_headline}` : j.title)),
      el("td", { class: "hud-mono hud-dim" }, shortAge(j.updated_at)),
    )
  );
  return el("table", { class: "hud-table" },
    el("caption", { class: "visually-hidden" }, "Claude's latest jobs: status, id, description, age"),
    el("thead", {}, el("tr", {}, el("th", {}, "ST"), el("th", {}, "ID"), el("th", {}, "TASK / RESULT"), el("th", {}, "AGE"))),
    el("tbody", {}, rows.length ? rows : el("tr", {}, el("td", { colspan: 4 }, "No jobs yet."))),
  );
}

function orderTable(orders) {
  const rows = orders.map((e) =>
    el("tr", { tabindex: 0, onclick: () => revealOrder(e.id), onkeydown: (ev) => ev.key === "Enter" && revealOrder(e.id) },
      el("td", {}, glyph(e.state)),
      el("td", { class: "hud-mono" }, e.wo !== null ? `#${String(e.wo).padStart(3, "0")}` : "·"),
      el("td", { class: "hud-desc" }, md(e.title.replace(/^WO from MAC\s*#\s*\d+\s*[-—–:]\s*/, "")),
        e.status_text ? el("span", { class: "hud-status" }, md(e.status_text)) : null),
      el("td", { class: "hud-mono hud-dim" }, e.replies.length ? `${e.replies.length}↔` : ""),
    )
  );
  return el("table", { class: "hud-table" },
    el("caption", { class: "visually-hidden" }, "MAC's open work orders: status, number, description, replies"),
    el("thead", {}, el("tr", {}, el("th", {}, "ST"), el("th", {}, "WO"), el("th", {}, "ORDER / STATUS"), el("th", {}, "RE"))),
    el("tbody", {}, rows.length ? rows : el("tr", {}, el("td", { colspan: 4 }, "No open orders."))),
  );
}

// ---------- panels ----------

function renderHud(s) {
  const jobs = allJobs();
  const day = jobs.filter((j) => ageMs(j.updated_at) < DAY_MS);
  const count = (states) => day.filter((j) => states.includes(j.state)).length;
  const finished = day.filter((j) => typeof j.duration_s === "number");
  const avgMin = finished.length ? Math.round(finished.reduce((a, j) => a + j.duration_s, 0) / finished.length / 60) : null;
  // One-shots carry cost_usd; job folders carry it in their final result.
  const jobCost = (j) => (typeof j.cost_usd === "number" ? j.cost_usd : j.last_result && typeof j.last_result.cost_usd === "number" ? j.last_result.cost_usd : 0);
  const cost = day.reduce((a, j) => a + jobCost(j), 0);

  document.getElementById("hud-claude").replaceChildren(
    hudHead("claude.exec", `${jobs.length} jobs on record`),
    el("div", { class: "hud-row" },
      ring([
        { value: count(["done", "followed_up", "cleared"]), color: HUD_COLORS.done, label: "Done or resolved" },
        { value: count(["running", "waiting"]), color: HUD_COLORS.running, label: "Running" },
        { value: count(["blocked", "error", "gate_failed", "stalled", "no_report"]), color: HUD_COLORS.blocked, label: "Stuck" },
      ], day.length, "24 H", "Outcomes · last 24 h"),
      ring([
        { value: Math.min(avgMin || 0, 60), color: "#ff9628", label: "Avg minutes per one-shot job" },
        { value: Math.max(0, 60 - Math.min(avgMin || 0, 60)), color: "rgba(255,150,40,0.12)", label: "Of a 60 min scale" },
      ], avgMin === null ? "—" : `${avgMin}m`, avgMin === null ? "NO DATA" : "AVG", "Avg one-shot run · 24 h"),
      el("div", { class: "hud-stats" },
        stat(`$${cost.toFixed(0)}`, "list-price est · 24 h", "done"),
        stat(count(["running", "waiting"]), "running now", "running"),
        stat(count(["blocked", "error", "gate_failed", "stalled", "no_report"]), "stuck · 24 h", "blocked"),
      ),
    ),
    el("div", { class: "hud-scroll" }, jobTable(jobs.slice(0, 9))),
    el("figure", { class: "hud-hexfig" }, hexGrid(jobs), el("figcaption", {}, "Last 60 jobs · one cell each · hover for detail")),
  );

  const open = s.inbox.filter((e) => ["OPEN", "BLOCKED", "RUNNING"].includes(e.state));
  const blocked = open.filter((e) => e.state === "BLOCKED").length;
  const comms = s.comms || { events: 0 };
  document.getElementById("hud-mac").replaceChildren(
    hudHead("mac.command", comms.events ? `grok bot · log ${comms.events} events` : "grok bot · log not started"),
    el("div", { class: "hud-row" },
      radar(open),
      el("div", { class: "hud-stats" },
        stat(s.status.decisions.length, "waiting on Anthony", "BLOCKED"),
        stat(open.length, "open orders", "OPEN"),
        stat(blocked, "blocked orders", "BLOCKED"),
      ),
    ),
    el("div", { class: "hud-scroll" }, orderTable(open.slice(0, 9))),
  );
  document.getElementById("comms-traffic").replaceChildren(traffic(s.messages || []));
}

window.renderHud = renderHud;
