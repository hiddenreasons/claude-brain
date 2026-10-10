"use strict";

// The three consoles under the Death Stars, one layout each: key numbers, one big live graphic, a short list.
// claude.exec: a live code stream of what Claude is doing now, a 24-hour heat strip, the latest outcomes.
// comms: an animated wire between Claude, MAC, Windows and Codex (each message travels as a packet); click a
// station or a filter to narrow the feed. mac.command: the age radar and the orders as columns.
// Everything is real data from the snapshot; everything opens what it shows. Uses el(), md(), relTime(),
// clock(), openDetail(), revealOrder(), allJobs(), openDecisions(), ui, snap and brains from app.js.

const HUD_COLORS = {
  running: "#f4f7fa", waiting: "#f4f7fa", done: "#9fe8c4", followed_up: "#7ff3e4", cleared: "#7ff3c4",
  blocked: "#ff7b80", error: "#ff7b80", gate_failed: "#ff7b80", stalled: "#ff7b80", no_report: "#ff7b80",
  prepared: "#80808b",
  OPEN: "#6fd7ff", RUNNING: "#f4f7fa", BLOCKED: "#ff7b80", PARKED: "#80808b", DONE: "#9fe8c4", NOTE: "#80808b",
};
const DAY_MS = 24 * 3600 * 1000;
const SVG_NS = "http://www.w3.org/2000/svg";
const STUCK = ["blocked", "error", "gate_failed", "stalled", "no_report"];
const calmMotion = () => document.documentElement.classList.contains("calm");

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
const hudColor = (state) => HUD_COLORS[state] || "#9aa3ad";

function hudHead(title, sub) {
  return el("div", { class: "hud-head" },
    el("span", { class: "hud-title" }, title),
    sub ? el("span", { class: "hud-sub" }, sub) : null,
  );
}

// A row of key numbers: [value, label, tone]. tone: ok / bad / warn / hot / info / dim.
function kpis(items) {
  return el("div", { class: "kpis" }, items.map(([v, label, tone, title]) =>
    el("span", { class: `kpi kpi-${tone || "info"}`, title: title || label }, el("b", {}, String(v)), el("i", {}, label))));
}

// ---------- claude.exec: the live code stream ----------

const streamSeen = new Set();
let streamPrimed = false;

function streamLine(key, cls, ...parts) {
  const fresh = streamPrimed && !streamSeen.has(key);
  streamSeen.add(key);
  return el("div", { class: `cs-line ${cls}${fresh ? " cs-new" : ""}` }, ...parts);
}

function prompt(who, job, extra) {
  return [el("span", { class: "cs-user" }, who), el("span", { class: "cs-dim" }, " ~/"),
    el("span", { class: "cs-job" }, job), el("span", { class: "cs-dim" }, " $ "), extra ? el("span", { class: "cs-cmd" }, extra) : null];
}

// What Claude is doing now, as a terminal: each running job's prompt and its latest tool calls and words.
function codeStream(jobs) {
  const blocks = [];
  const running = jobs.filter((j) => j.state === "running" || j.state === "waiting");
  for (const j of running.slice(0, 2)) {
    const lines = [streamLine(`p:${j.id}`, "cs-prompt", ...prompt("claude@mac", j.id, [j.model, j.effort].filter(Boolean).join(" ") || (j.kind === "oneshot" ? "one-shot" : "")))];
    for (const a of (j.activity || []).slice(-5)) {
      const k = `${j.id}:${a.kind}:${a.name || ""}:${a.summary || a.text || ""}`;
      lines.push(a.kind === "tool"
        ? streamLine(k, "cs-tool", el("span", { class: "cs-fn" }, a.name), el("span", { class: "cs-arg" }, ` ${a.summary || ""}`))
        : streamLine(k, "cs-said", el("span", { class: "cs-comment" }, `# ${a.text || ""}`)));
    }
    if (!(j.activity || []).length) lines.push(streamLine(`w:${j.id}`, "cs-said", el("span", { class: "cs-comment" }, j.kind === "oneshot" ? "# waiting for the result" : "# starting…")));
    blocks.push(el("button", { type: "button", class: "cs-block", title: `${j.id}: open the job`, onclick: () => openDetail(j.kind, j.id, j.title) }, ...lines));
  }
  const beat = snap.windows || {};
  if (beat.fresh && beat.job) {
    blocks.push(el("div", { class: "cs-block cs-win" },
      streamLine(`p:win:${beat.job}`, "cs-prompt", ...prompt("claude@windows", beat.job)),
      streamLine(`win:${beat.job}:${beat.last_log_line || ""}`, "cs-said", el("span", { class: "cs-comment" }, `# ${plain(beat.last_log_line || "working")}`))));
  }
  if (!blocks.length) {
    const last = jobs.find((j) => ["done", "resolved", "blocked", "stalled"].includes(j.lifecycle));
    if (last) {
      blocks.push(el("button", { type: "button", class: "cs-block cs-past", onclick: () => openDetail(last.kind, last.id, last.title) },
        streamLine(`last:${last.id}`, "cs-prompt", ...prompt("claude@mac", last.id, "last run")),
        streamLine(`lastr:${last.id}:${last.updated_at}`, last.lifecycle === "blocked" ? "cs-err" : "cs-ok",
          `${last.lifecycle === "blocked" || last.lifecycle === "stalled" ? "✖" : "✔"} ${plain(last.report_headline || last.result_preview || last.lifecycle || "")}`)));
    }
  }
  streamPrimed = true;
  const idle = el("div", { class: "cs-line cs-prompt cs-idle" }, ...prompt("claude@mac", running.length ? "…" : "idle"), el("span", { class: "cs-cursor", "aria-hidden": "true" }));
  return el("div", { class: "cs", role: "log", "aria-label": "What Claude is doing now" }, ...blocks, idle);
}

// ---------- claude.exec: the 24-hour heat strip ----------

// One cell per hour for Claude (this Mac) and Windows: brighter = more jobs running that hour; red dot = a job
// ended blocked. From the same data as the Active now timeline; a click opens that timeline at 24 h.
function heatStrip() {
  const t = snap.timeline;
  if (!t) return null;
  const now = Date.now(), from = now - DAY_MS, hour = 3600000;
  const rows = [["claude", "CLAUDE", [255, 150, 40]], ["windows", "WINDOWS", [167, 139, 250]]];
  const W = 24 * 9, cells = [];
  rows.forEach(([key, name, rgb], r) => {
    const bars = (t.lanes[key] || []).map((b) => ({ ...b, s: b.start ? Date.parse(b.start) : Date.parse(b.end), e: b.end ? Date.parse(b.end) : now }));
    cells.push(svg("text", { x: 0, y: 9 + r * 14, class: "hs-name" }, name));
    for (let i = 0; i < 24; i++) {
      const h0 = from + i * hour, h1 = h0 + hour;
      const on = bars.filter((b) => b.s < h1 && b.e >= h0);
      const blocked = bars.filter((b) => b.state === "blocked" && b.end && b.e >= h0 && b.e < h1);
      const a = on.length ? 0.22 + Math.min(1, on.length / 3) * 0.7 : 0.06;
      const label = `${new Date(h0).toLocaleTimeString([], { hour: "numeric" })}: ${on.length ? on.map((b) => b.label).slice(0, 6).join(", ") : "nothing running"}${blocked.length ? ` · blocked: ${blocked.map((b) => b.label).join(", ")}` : ""}`;
      cells.push(svg("rect", { x: 56 + i * 9, y: r * 14, width: 8, height: 11, rx: 2, fill: `rgba(${rgb.join(",")},${a.toFixed(2)})`, class: "hs-cell" }, tip(label)));
      if (blocked.length) cells.push(svg("circle", { cx: 60 + i * 9, cy: r * 14 + 5.5, r: 2, fill: "#ff5a52" }, tip(label)));
    }
  });
  const fig = el("button", {
    type: "button", class: "hs", "aria-label": "Jobs per hour over the last 24 hours. Open the timeline.",
    onclick: () => { ui.activeView = "timeline"; ui.tlHours = 24; renderRunning(); document.getElementById("running-panel").scrollIntoView({ behavior: "smooth", block: "start" }); },
  }, svg("svg", { viewBox: `0 0 ${56 + W} 28`, role: "img", "aria-hidden": "true" }, ...cells),
  el("span", { class: "hs-cap" }, "last 24 h · brighter = busier · red = ended blocked · click for the timeline"));
  return fig;
}

// The latest finished or stuck jobs, one line each.
function outcomes(jobs) {
  const list = jobs.filter((j) => ["done", "resolved", "blocked", "stalled"].includes(j.lifecycle)).slice(0, 4);
  if (!list.length) return null;
  return el("ol", { class: "oc" }, list.map((j) => {
    const bad = j.lifecycle === "blocked" || j.lifecycle === "stalled";
    return el("li", {}, el("button", { type: "button", class: "oc-row", onclick: () => openDetail(j.kind, j.id, j.title) },
      el("span", { class: `oc-mark ${bad ? "bad" : "ok"}` }, bad ? "✖" : "✔"),
      el("span", { class: "oc-id" }, j.id),
      el("span", { class: "oc-txt" }, plain(j.owner_mark ? j.action_note : j.report_headline || j.title || "")),
      el("span", { class: "oc-age" }, relTime(j.updated_at).replace(" ago", ""))));
  }));
}

// ---------- comms: the wire ----------

const WIRE = {
  nodes: { claude: [80, 58, "CLAUDE", "#ff9628"], mac: [320, 58, "MAC", "#6fd7ff"], windows: [560, 58, "WINDOWS", "#a78bfa"], codex: [445, 134, "CODEX", "#3fe0a8"] },
  links: { claude: ["claude", "mac", "M 112 58 Q 200 28 288 58"], windows: ["mac", "windows", "M 352 58 Q 440 28 528 58"], codex: ["codex", "mac", "M 426 120 Q 378 108 346 82"] },
};
let wireSvg = null;
const wirePaths = {};

function linkOf(m) {
  if (m.direction === "codex") return "codex";
  return m.machine === "windows" ? "windows" : "claude";
}

function buildWire() {
  const g = [];
  for (const [key, [, , d]] of Object.entries(WIRE.links)) {
    const path = svg("path", { id: `wire-${key}`, d, class: "wr-link" });
    wirePaths[key] = path;
    g.push(svg("g", { class: `wr-l wr-l-${key}`, "data-link": key, tabindex: 0, role: "button" },
      svg("path", { d, class: "wr-hit" }), path, svg("path", { d, class: "wr-flow" }),
      svg("text", { class: "wr-count", "data-count": key, "text-anchor": "middle" })));
  }
  for (const [key, [x, y, name, color]] of Object.entries(WIRE.nodes)) {
    const r = key === "codex" ? 15 : 27;
    g.push(svg("g", { class: `wr-n wr-n-${key}`, "data-node": key, tabindex: 0, role: "button", "aria-label": `${name}: show its messages` },
      svg("circle", { cx: x, cy: y, r: r + 6, class: "wr-halo", stroke: color }),
      svg("circle", { cx: x, cy: y, r, class: "wr-core", stroke: color }),
      svg("text", { x, y: y + 4, class: "wr-name", fill: color, "text-anchor": "middle" }, name),
      svg("text", { x, y: y + r + 16, class: "wr-sub", "data-sub": key, "text-anchor": "middle" })));
  }
  wireSvg = svg("svg", { viewBox: "0 0 640 168", class: "wire", role: "group", "aria-label": "Messages between Claude, MAC, Windows and Codex" }, ...g);
  const pick = (target) => {
    const n = target.closest("[data-node], [data-link]");
    if (!n) return;
    const key = n.getAttribute("data-node") || n.getAttribute("data-link");
    setCommsFilter(key === "mac" ? "all" : key);
  };
  wireSvg.addEventListener("click", (ev) => pick(ev.target));
  wireSvg.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(ev.target); } });
  return wireSvg;
}

function updateWire(messages) {
  if (!wireSvg) return;
  const day = messages.filter((m) => ageMs(m.at) < DAY_MS);
  const hour = day.filter((m) => ageMs(m.at) < 3600000);
  for (const key of Object.keys(WIRE.links)) {
    const ms = day.filter((m) => linkOf(m) === key);
    const out = ms.filter((m) => m.direction === "to_claude").length, back = ms.length - out;
    const busy = hour.some((m) => linkOf(m) === key);
    const label = key === "codex" ? `${ms.length} today` : `▶ ${out}  ◀ ${back}`;
    const text = wireSvg.querySelector(`[data-count="${key}"]`);
    // Codex's count sits beside its node, clear of MAC's label; the others ride above the middle of their link.
    const p = wirePaths[key].getPointAtLength(wirePaths[key].getTotalLength() * (key === "codex" ? 0.15 : 0.5));
    text.setAttribute("x", (p.x + (key === "codex" ? 52 : 0)).toFixed(0));
    text.setAttribute("y", (p.y + (key === "codex" ? 4 : -9)).toFixed(0));
    text.textContent = label;
    wireSvg.querySelector(`.wr-l-${key}`).classList.toggle("busy", busy);
    wireSvg.querySelector(`.wr-l-${key}`).classList.toggle("on", ui.commsFilter === key);
  }
  const counts = { claude: 0, mac: 0, windows: 0, codex: 0 };
  for (const m of hour) {
    const link = linkOf(m);
    counts.mac += 1;
    counts[link === "claude" ? "claude" : link] += 1;
  }
  for (const key of Object.keys(WIRE.nodes)) {
    wireSvg.querySelector(`[data-sub="${key}"]`).textContent = `${counts[key]} · last hour`;
    wireSvg.querySelector(`.wr-n-${key}`).classList.toggle("on", ui.commsFilter === key || (key === "mac" && ui.commsFilter === "all"));
  }
}

// A message travels along its link as a packet in its job's colour; with Calm on, the receiving station glows.
function firePacket(m) {
  if (!wireSvg || !m) return;
  const link = linkOf(m);
  const far = link === "codex" ? "codex" : link;              // the station at the other end from MAC
  const sender = m.direction === "to_claude" ? "mac" : far;   // codex and replies come in to MAC
  const receiver = sender === "mac" ? far : "mac";
  const forward = WIRE.links[link][0] === sender;             // each path is drawn from links[key][0] to [1]
  const node = wireSvg.querySelector(`.wr-n-${receiver}`);
  if (node) { node.classList.remove("hit"); void node.getBoundingClientRect(); node.classList.add("hit"); }
  if (calmMotion()) return;
  const key = window.BrainsVisual && brains ? brains.keyOf(m) : null;
  const color = (key && window.Volley.jobColor(key)) || "#e8f6ff";
  const anim = svg("animateMotion", { dur: "1.1s", begin: "indefinite", fill: "freeze", calcMode: "linear", keyPoints: forward ? "0;1" : "1;0", keyTimes: "0;1" },
    svg("mpath", { href: `#wire-${link}` }));
  const packet = svg("g", { class: "wr-packet" }, svg("circle", { r: 9, fill: color, class: "wr-glow" }), svg("circle", { r: 3.2, fill: "#fff" }), anim);
  wireSvg.append(packet);
  anim.beginElement();
  setTimeout(() => packet.remove(), 1300);
}

function setCommsFilter(key) {
  ui.commsFilter = ui.commsFilter === key ? "all" : key;
  renderCommsFilters();
  updateWire(snap.messages || []);
  if (typeof renderTerminal === "function") renderTerminal();
}

const COMMS_FILTERS = [["all", "All"], ["claude", "Claude"], ["windows", "Windows"], ["codex", "Codex"], ["blocked", "Needs a look"]];

// The feed filter, shared with renderTerminal in app.js.
function commsMatch(m) {
  const f = ui.commsFilter || "all";
  if (f === "all") return true;
  if (f === "blocked") return m.blocked && !m.cleared;
  return linkOf(m) === f;
}

function renderCommsFilters() {
  const box = document.getElementById("comms-filters");
  if (!box) return;
  const ms = snap.messages || [];
  box.replaceChildren(...COMMS_FILTERS.map(([key, label]) => {
    const n = key === "all" ? ms.length : ms.filter((m) => (key === "blocked" ? m.blocked && !m.cleared : linkOf(m) === key)).length;
    return el("button", { type: "button", class: `cf${(ui.commsFilter || "all") === key ? " on" : ""}`, "aria-pressed": String((ui.commsFilter || "all") === key), onclick: () => setCommsFilter(key) },
      label, el("span", { class: "cf-n" }, String(n)));
  }));
}

// ---------- mac.command ----------

// Open work orders as radar blips: angle from the order, distance from its age (outer ring = 14 days).
function radar(orders) {
  const blips = orders.map((e, i) => {
    const days = e.date ? Math.max(0, (Date.now() - Date.parse(`${e.date}T12:00:00`)) / DAY_MS) : 14;
    const dist = 8 + Math.min(1, days / 14) * 50;
    const seed = e.wo !== null ? e.wo * 2.399 : i * 2.399; // golden-angle spread
    const a = seed % (Math.PI * 2);
    const x = 64 + Math.cos(a) * dist;
    const y = 64 + Math.sin(a) * dist;
    const color = e.action === "needs_anthony" ? "#ff5a52" : hudColor(e.state);
    return svg("g", { class: "hud-blip", "data-id": e.id, tabindex: 0, role: "button",
      "aria-label": `${e.state} ${e.wo !== null ? `WO ${e.wo}` : ""} ${e.title}` },
      svg("circle", { cx: x, cy: y, r: e.action === "needs_anthony" ? 3.8 : 2.6, fill: color }),
      svg("circle", { cx: x, cy: y, r: 6, fill: "none", stroke: color, class: "hud-ping" }),
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
      svg("g", { class: "hud-sweep" }, svg("path", { d: "M64 64 L64 6 A58 58 0 0 1 105 23 Z", class: "hud-sweep-fill" })),
      ...blips,
    ),
    el("figcaption", {}, "age radar · 14 d edge"),
  );
}

// The orders as four columns: what needs Anthony, what runs, what waits, what is parked.
function orderColumns(orders) {
  const cols = [
    ["needs", "NEEDS YOU", orders.filter((e) => e.action === "needs_anthony")],
    ["run", "RUNNING", orders.filter((e) => e.action !== "needs_anthony" && (e.state === "RUNNING" || e.action === "in_progress"))],
    ["queue", "QUEUED", orders.filter((e) => e.action === "queued" && e.state !== "PARKED")],
    ["park", "PARKED", orders.filter((e) => e.state === "PARKED" && e.action !== "needs_anthony")],
  ];
  const label = (e) => (e.wo !== null ? `#${String(e.wo).padStart(3, "0")}` : plain(e.title).slice(0, 14));
  return el("div", { class: "kb" }, cols.map(([cls, name, list]) => el("section", { class: `kb-col kb-${cls}` },
    el("h3", {}, name, el("span", {}, String(list.length))),
    list.length ? el("ul", {}, list.slice(0, 5).map((e) => el("li", {}, el("button", {
      type: "button", class: "kb-chip", title: `${plain(e.title)}${e.action_note ? ` · ${e.action_note}` : ""}`,
      onclick: () => revealOrder(e.id),
    }, el("b", {}, label(e)), el("span", {}, plain(e.title).replace(/^WO from MAC\s*#?\s*\d*\s*[-—–:]\s*/, "")))))) : el("p", { class: "kb-none" }, "none"),
    list.length > 5 ? el("p", { class: "kb-more" }, `+${list.length - 5} more`) : null)));
}

// ---------- panels ----------

function renderHud(s) {
  const jobs = allJobs();
  const day = jobs.filter((j) => ageMs(j.updated_at) < DAY_MS);
  const finished = day.filter((j) => typeof j.duration_s === "number");
  const avgMin = finished.length ? Math.round(finished.reduce((a, j) => a + j.duration_s, 0) / finished.length / 60) : null;
  const jobCost = (j) => (typeof j.cost_usd === "number" ? j.cost_usd : j.last_result && typeof j.last_result.cost_usd === "number" ? j.last_result.cost_usd : 0);
  const cost = day.reduce((a, j) => a + jobCost(j), 0);
  const running = jobs.filter((j) => j.state === "running" || j.state === "waiting").length;
  const stuck = day.filter((j) => STUCK.includes(j.state) && !j.owner_mark).length;

  document.getElementById("hud-claude").replaceChildren(
    hudHead("claude.exec", `${jobs.length} jobs on record`),
    kpis([
      [day.length, "jobs · 24 h", "info"],
      [avgMin === null ? "—" : `${avgMin}m`, "avg run", "info", `${finished.length} finished in 24 h`],
      [`$${cost.toFixed(0)}`, "list price · 24 h", "dim"],
      [running, "running", running ? "hot" : "dim"],
      [stuck, "stuck · 24 h", stuck ? "bad" : "ok"],
    ]),
    codeStream(jobs),
    heatStrip(),
    outcomes(jobs),
  );

  const open = s.inbox.filter((e) => e.action !== "done" && e.state !== "NOTE");
  const comms = s.comms || { events: 0 };
  const needs = openDecisions().length + open.filter((e) => e.action === "needs_anthony").length;
  document.getElementById("hud-mac").replaceChildren(
    hudHead("mac.command", comms.events ? `grok bot · log ${comms.events} events` : "grok bot · log not started"),
    kpis([
      [needs, "waiting on you", needs ? "bad" : "ok"],
      [open.length, "open orders", "info"],
      [open.filter((e) => e.state === "BLOCKED").length, "blocked", open.some((e) => e.state === "BLOCKED") ? "bad" : "ok"],
    ]),
    el("div", { class: "hud-row mc-row" }, radar(open.filter((e) => ["OPEN", "BLOCKED", "RUNNING"].includes(e.state))), orderColumns(open)),
  );

  const wireBox = document.getElementById("comms-wire");
  if (wireBox && !wireSvg) wireBox.replaceChildren(buildWire());
  updateWire(s.messages || []);
  renderCommsFilters();
}

window.renderHud = renderHud;
window.commsWire = { fire: firePacket, match: commsMatch };
