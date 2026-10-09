"use strict";

// Every piece of text on this page comes from files MAC and Claude wrote. It is always inserted as
// text (textContent), never as HTML.

const STATE_LABELS = {
  running: "Running", waiting: "Waiting", done: "Done", blocked: "Blocked", error: "Error",
  gate_failed: "Gate failed", stalled: "Stalled", no_report: "No report", followed_up: "MAC followed up",
  prepared: "No Claude run", no_result: "No result",
  OPEN: "Open", BLOCKED: "Blocked", PARKED: "Parked", DONE: "Done", RUNNING: "Running", NOTE: "Note",
};
const PROBLEM_STATES = new Set(["blocked", "error", "gate_failed", "stalled", "no_report"]);
const JOB_FILTERS = [["all", "All"], ["live", "Running"], ["problems", "Problems"], ["done", "Done"]];
const ORDER_FILTERS = [["active", "Open + blocked"], ["PARKED", "Parked"], ["DONE", "Done"], ["all", "All"]];
const JOB_LIST_LIMIT = 80;
const FRESH_MS = 90_000;

const ui = { jobFilter: "all", orderFilter: "active", query: "", openOrders: new Set() };
const demoMode = new URLSearchParams(location.search).has("demo");
let snap = null;
let firstLoad = true;
let connected = false;
const seen = new Map();
const freshUntil = new Map();

// ---------- helpers ----------

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false || kid === "") continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function relTime(iso) {
  const ms = Date.parse(iso);
  if (!iso || Number.isNaN(ms)) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function timeEl(iso) {
  if (!iso) return null;
  return el("time", { datetime: iso, title: new Date(iso).toLocaleString(), "data-rel": "" }, relTime(iso));
}

// MAC and Claude write Markdown. Show **bold** and `code` as such, built as DOM nodes (never innerHTML).
function md(text) {
  if (!text) return [];
  const out = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const m of String(text).matchAll(pattern)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] !== undefined ? el("code", {}, m[1]) : el("strong", {}, md(m[2])));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const badge = (state) => el("span", { class: `badge s-${state}` }, STATE_LABELS[state] || state);
const money = (usd) => (typeof usd === "number" ? `$${usd.toFixed(2)} list-price est.` : null);
const minutes = (s) => (typeof s === "number" ? (s < 90 ? `${s}s` : `${Math.round(s / 60)} min`) : null);

function matches(...texts) {
  if (!ui.query) return true;
  const q = ui.query.toLowerCase();
  return texts.some((t) => t && String(t).toLowerCase().includes(q));
}

function markChange(key, signature) {
  const previous = seen.get(key);
  seen.set(key, signature);
  if (!firstLoad && previous !== signature) freshUntil.set(key, Date.now() + FRESH_MS);
}

const isFresh = (key) => (freshUntil.get(key) || 0) > Date.now();

function trackChanges(s) {
  for (const j of s.folders) markChange(`folder:${j.id}`, [j.state, j.stream_updated_at, j.report_headline].join("|"));
  for (const j of s.oneshots) markChange(`oneshot:${j.id}`, [j.state, j.finished_at].join("|"));
  for (const e of s.inbox) markChange(`wo:${e.id}`, [e.state, e.status_text, e.replies.length].join("|"));
  firstLoad = false;
}

function empty(text) {
  return el("p", { class: "empty" }, text);
}

function filterChips(container, options, current, onPick) {
  container.replaceChildren(
    ...options.map(([value, label]) =>
      el("button", {
        type: "button", class: "chip", "aria-pressed": String(value === current),
        onclick: () => onPick(value),
      }, label)
    )
  );
}

// ---------- jobs ----------

function jobKey(job) { return `${job.kind}:${job.id}`; }

function jobMeta(job) {
  const model = job.kind === "folder"
    ? [job.model, job.effort].filter(Boolean).join(" · ")
    : (job.models || []).map((m) => m.replace(/^claude-/, "")).join(", ");
  return el("div", { class: "meta" },
    el("span", {}, job.kind === "folder" ? `Job folder · ${job.id}` : `One-shot · ${job.id}`),
    model && el("span", {}, model),
    job.iteration && el("span", {}, `iteration ${job.iteration}`),
    job.turns && el("span", {}, `${job.turns} turns`),
    minutes(job.duration_s) && el("span", {}, minutes(job.duration_s)),
    money(job.cost_usd) && el("span", {}, money(job.cost_usd)),
    job.denials ? el("span", {}, `${job.denials} permission denials`) : null,
    timeEl(job.updated_at),
  );
}

function jobLine(job) {
  if (job.kind === "folder") {
    const lines = [];
    if (job.report_headline) {
      const from = job.headline_source === "final reply" ? "Final reply: " : "";
      lines.push(el("p", { class: "line" }, from, md(job.report_headline)));
    }
    if (job.state === "followed_up") {
      lines.push(el("p", { class: "line muted" },
        `MAC acted after the report (${job.followed_up_by}`, job.followed_up_at ? `, ${relTime(job.followed_up_at)}` : "", ")"));
    }
    return lines;
  }
  if (job.note) return el("p", { class: "line" }, job.note);
  if (job.result_preview) return el("p", { class: "line muted" }, job.result_preview.slice(0, 260));
  return null;
}

function jobCard(job) {
  return el("li", {},
    el("button", {
      type: "button", class: `card${isFresh(jobKey(job)) ? " fresh" : ""}`, "data-key": jobKey(job),
      onclick: () => openDetail(job.kind, job.id, job.title),
    },
      el("div", { class: "card-top" }, badge(job.state), el("span", { class: "card-title" }, md(job.title || job.id))),
      jobMeta(job),
      jobLine(job),
    )
  );
}

function activityList(actions, limit) {
  const items = actions.slice(-limit).map((a) =>
    a.kind === "tool"
      ? el("li", {}, el("span", { class: "tool" }, a.name), a.summary || "")
      : el("li", {}, el("span", { class: "said" }, `Claude: ${a.text}`))
  );
  return items.length ? el("ol", { class: "activity", "aria-label": "Latest actions" }, items) : null;
}

function allJobs() {
  return [...snap.folders, ...snap.oneshots].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
}

function jobPassesFilter(job) {
  if (ui.jobFilter === "live") return job.state === "running" || job.state === "waiting";
  if (ui.jobFilter === "problems") return PROBLEM_STATES.has(job.state);
  if (ui.jobFilter === "done") return job.state === "done" || job.state === "followed_up";
  return true;
}

function renderJobs() {
  filterChips(document.getElementById("job-filters"), JOB_FILTERS, ui.jobFilter, (v) => { ui.jobFilter = v; renderJobs(); });
  const jobs = allJobs().filter(jobPassesFilter).filter((j) => matches(j.title, j.id, j.report_headline, j.result_preview, j.prompt_preview));
  const shown = jobs.slice(0, JOB_LIST_LIMIT);
  const total = snap.oneshot_total + snap.folders.length;
  document.getElementById("jobs-count").textContent =
    jobs.length > shown.length ? `showing ${shown.length} of ${jobs.length}` : String(jobs.length);
  document.getElementById("jobs-note").textContent =
    `${total} jobs on record. The newest ${JOB_LIST_LIMIT} are listed; search covers the newest ${snap.oneshots.length + snap.folders.length}.`;
  const list = document.getElementById("jobs");
  list.replaceChildren(...(shown.length ? shown.map(jobCard) : [el("li", {}, empty("No jobs match."))]));
}

function renderRunning() {
  const live = allJobs().filter((j) => j.state === "running" || j.state === "waiting");
  document.getElementById("running-count").textContent = live.length || "";
  const box = document.getElementById("running");
  if (!live.length) {
    const latest = allJobs()[0];
    box.replaceChildren(
      empty("No Claude job is running for MAC right now."),
      latest ? el("p", { class: "line muted" }, "Last activity: ", latest.title || latest.id, " · ", relTime(latest.updated_at)) : null,
      snap.status.running_note ? el("p", { class: "line muted" }, "MAC's STATUS.md: ", md(snap.status.running_note)) : null,
    );
    return;
  }
  box.replaceChildren(el("ol", { class: "list" }, live.map((job) =>
    el("li", {},
      el("button", {
        type: "button", class: `card${isFresh(jobKey(job)) ? " fresh" : ""}`, "data-key": jobKey(job),
        onclick: () => openDetail(job.kind, job.id, job.title),
      },
        el("div", { class: "card-top" }, badge(job.state), el("span", { class: "card-title" }, md(job.title || job.id))),
        jobMeta(job),
        job.stream_updated_at ? el("p", { class: "line muted" }, "Last action ", relTime(job.stream_updated_at)) : null,
        job.kind === "folder" ? activityList(job.activity || [], 8) : el("p", { class: "line muted" }, job.prompt_preview || ""),
      )
    )
  )));
}

// ---------- attention, decisions, orders, logs ----------

function renderAttention() {
  const items = snap.attention.filter((a) => matches(a.title, a.detail));
  const panel = document.getElementById("attention-panel");
  panel.classList.toggle("has-items", items.length > 0);
  document.getElementById("attention-count").textContent = items.length || "";
  document.title = items.length ? `(${items.length}) Claude Brain` : "Claude Brain";
  const box = document.getElementById("attention");
  if (!items.length) {
    box.replaceChildren(empty("Nothing stuck. No blocked work orders, failed gates, stalled or errored jobs in the last 3 days."));
    return;
  }
  box.replaceChildren(el("ol", { class: "list" }, items.map((a) =>
    el("li", {},
      el("button", {
        type: "button", class: "card",
        onclick: () => (a.source === "job" ? openDetail(a.kind, a.id, a.title) : revealOrder(a.id)),
      },
        el("div", { class: "card-top" }, badge(a.state), el("span", { class: "card-title" }, md(a.title))),
        a.detail ? el("p", { class: "line" }, md(a.detail)) : null,
      )
    )
  )));
}

function renderDecisions() {
  const items = snap.status.decisions.filter((d) => matches(d));
  document.getElementById("decisions-count").textContent = items.length || "";
  const list = document.getElementById("decisions");
  list.replaceChildren(...(items.length ? items.map((d) => el("li", {}, md(d))) : [el("li", { class: "empty" }, "Nothing listed.")]));
}

function orderPassesFilter(entry) {
  if (ui.orderFilter === "active") return ["OPEN", "BLOCKED", "RUNNING"].includes(entry.state);
  if (ui.orderFilter === "all") return true;
  return entry.state === ui.orderFilter;
}

function orderCard(entry) {
  const key = `wo:${entry.id}`;
  const details = el("details", {
    class: `card${isFresh(key) ? " fresh" : ""}`, "data-key": key, id: `order-${entry.id}`,
    open: ui.openOrders.has(entry.id),
    ontoggle: (ev) => (ev.target.open ? ui.openOrders.add(entry.id) : ui.openOrders.delete(entry.id)),
  },
    el("summary", {},
      el("div", { class: "card-top" }, badge(entry.state), el("span", { class: "card-title" }, md(entry.title))),
      el("div", { class: "meta" },
        entry.date && el("span", {}, entry.date),
        entry.wo !== null && el("span", {}, `WO #${entry.wo}`),
        entry.from && el("span", {}, `from ${entry.from}`),
        entry.replies.length ? el("span", {}, `${entry.replies.length} replies`) : null,
      ),
      entry.status_text ? el("p", { class: "line muted" }, md(entry.status_text)) : null,
    ),
  );
  if (entry.replies.length) {
    details.append(el("ol", { class: "thread", "aria-label": "Replies" }, entry.replies.map((r) =>
      el("li", { class: `msg ${r.direction}${r.blocked ? " blocked" : ""}` },
        el("span", { class: "who" }, r.direction === "to_mac" ? "CLAUDE → MAC" : "MAC → CLAUDE"),
        md(r.text),
      )
    )));
  }
  if (entry.body) {
    details.append(el("div", { class: "body" }, md(entry.body), entry.body_truncated ? "\n\n(cut short; see CLAUDE INBOX.md)" : ""));
  }
  return el("li", {}, details);
}

function renderOrders() {
  filterChips(document.getElementById("order-filters"), ORDER_FILTERS, ui.orderFilter, (v) => { ui.orderFilter = v; renderOrders(); });
  const entries = snap.inbox.filter(orderPassesFilter).filter((e) =>
    matches(e.title, e.status_text, e.body, ...e.replies.map((r) => r.text))
  );
  const list = document.getElementById("orders");
  list.replaceChildren(...(entries.length ? entries.map(orderCard) : [el("li", {}, empty("No work orders match."))]));
}

function revealOrder(id) {
  ui.orderFilter = "all";
  ui.openOrders.add(id);
  renderOrders();
  const node = document.getElementById(`order-${id}`);
  if (node) {
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.querySelector("summary").focus();
  }
}

function renderLogs() {
  const changes = snap.status.changelog.filter((c) => matches(c));
  document.getElementById("changelog").replaceChildren(
    ...(changes.length ? changes.map((c) => el("li", {}, md(c))) : [el("li", { class: "empty" }, "Nothing logged.")])
  );
  const incidents = snap.issues.filter((i) => matches(i.what, i.job));
  document.getElementById("incidents").replaceChildren(
    ...(incidents.length
      ? incidents.map((i) => el("li", {}, `${i.date}${i.job ? ` · ${i.job}` : ""}: `, md(i.what)))
      : [el("li", { class: "empty" }, "No incidents logged.")])
  );
  document.getElementById("sources").replaceChildren(
    "Reading: ",
    ...Object.entries(snap.sources).flatMap(([name, src], i) => [
      i ? " · " : "",
      `${name} `, src.exists ? el("span", {}, "(", relTime(src.updated_at) || "ok", ")") : el("strong", {}, "(missing)"),
    ]),
    `. Nothing here can change those files.`
  );
}

// ---------- brains and lightning ----------

let brains = null;
let messagesPrimed = false;
const seenMessages = new Set();
const MAX_BOLTS_PER_UPDATE = 6;

function handleMessages(s) {
  const messages = s.messages || [];
  const fresh = messages.filter((m) => !seenMessages.has(m.id));
  for (const m of messages) seenMessages.add(m.id);
  if (brains) brains.setRunning(s.running_count || 0);
  if (!messagesPrimed) {
    messagesPrimed = true; // messages already there when the page opened don't fire
    return;
  }
  // Oldest first, a beat apart, so a burst reads as separate messages.
  fresh.slice(0, MAX_BOLTS_PER_UPDATE).reverse().forEach((m, i) => setTimeout(() => brains && brains.fire(m), i * 350));
}

function messageItem(m) {
  const dir = window.BrainsVisual ? window.BrainsVisual.directionLabel(m) : m.direction;
  const kind = window.BrainsVisual ? window.BrainsVisual.kindLabel(m.kind) : m.kind;
  const open = () => (m.ref.source === "job" ? openDetail(m.ref.kind, m.ref.id, m.text) : revealOrder(m.ref.id));
  return el("li", {},
    el("button", {
      type: "button", class: `msg-item ${m.blocked ? "blocked" : m.direction}`, "data-id": m.id,
      onclick: open,
      onmouseenter: () => brains && brains.highlight(m.id),
      onmouseleave: () => brains && brains.highlight(null),
      onfocus: () => brains && brains.highlight(m.id),
      onblur: () => brains && brains.highlight(null),
    },
      el("span", { class: "dir" }, `${dir} · ${kind}${m.blocked ? " · BLOCKED" : ""} · `, timeEl(m.at)),
      el("span", { class: "txt" }, m.text),
    )
  );
}

function renderMessages() {
  const timed = (snap.messages || []).filter((m) => m.at).slice(0, 6);
  document.getElementById("messages").replaceChildren(
    ...(timed.length ? timed.map(messageItem) : [el("li", {}, empty("No messages yet."))])
  );
}

function startDemo() {
  // ?demo shows sample bolts so the look can be checked. They are labeled and are not real messages.
  document.querySelector(".brains-stage").append(el("span", { class: "preview-badge" }, "PREVIEW · SAMPLE BOLTS, NOT REAL MESSAGES"));
  const samples = [
    { direction: "to_claude", kind: "work_order", text: "Sample: WO #023 from MAC, rebuild the Channel page layout" },
    { direction: "to_mac", kind: "report", text: "Sample: TO MAC: DONE. Commit 1a2b3c4 on claude/channel-layout" },
    { direction: "to_mac", kind: "to_mac", text: "Sample: TO MAC: BLOCKED pre-commit tests fail in the sandbox", blocked: true },
  ];
  brains.setRunning(1);
  let i = 0;
  const next = () => {
    brains.fire({ ...samples[i % samples.length], id: `demo-${i}` });
    i += 1;
  };
  next();
  setInterval(next, 2600);
}

function renderAll() {
  if (!snap) return;
  renderMessages();
  renderAttention();
  renderRunning();
  renderJobs();
  renderDecisions();
  renderOrders();
  renderLogs();
  updateLiveText();
}

// ---------- job detail ----------

function section(title, text) {
  return text ? [el("h3", {}, title), el("pre", {}, text)] : [];
}

async function openDetail(kind, id, title) {
  const dialog = document.getElementById("detail");
  const body = document.getElementById("detail-body");
  document.getElementById("detail-title").textContent = title || id;
  body.replaceChildren(empty("Loading…"));
  if (!dialog.open) dialog.showModal();
  try {
    const res = await fetch(`/api/job?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const d = await res.json();
    if (kind === "oneshot") {
      body.replaceChildren(
        ...section("MAC's order to Claude", d.prompt),
        ...section("Claude's result", d.result || "(no result yet)"),
        ...section("Errors", d.errors && d.errors.trim()),
      );
    } else {
      const log = d.activity && d.activity.length
        ? [el("h3", {}, `Live activity (last ${d.activity.length})`), activityList(d.activity, 200)]
        : [];
      body.replaceChildren(
        ...section("Report", d.report),
        ...section("Final reply", d.last_result && d.last_result.text),
        ...log,
        ...section("Brief from MAC", d.brief),
        ...section("Run log", d.runs_log),
      );
    }
  } catch (err) {
    body.replaceChildren(empty(`Couldn't load this job: ${err.message}`));
  }
}

// ---------- live connection ----------

let loadTimer = null;
function scheduleLoad() {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(load, 250);
}

async function load() {
  try {
    const res = await fetch("/api/snapshot", { cache: "no-store" });
    if (!res.ok) throw new Error(res.statusText);
    snap = await res.json();
    trackChanges(snap);
    if (!demoMode) handleMessages(snap);
    renderAll();
  } catch (err) {
    document.getElementById("live-text").textContent = `Can't load data: ${err.message}`;
  }
}

function updateLiveText() {
  const dot = document.getElementById("live-dot");
  dot.className = `dot ${connected ? "on" : "off"}`;
  const when = snap ? relTime(snap.generated_at) : "";
  document.getElementById("live-text").textContent = connected
    ? `Live · last change ${when}`
    : "Reconnecting… (is Claude Brain still running?)";
}

function connect() {
  const events = new EventSource("/events");
  events.addEventListener("update", scheduleLoad);
  events.addEventListener("open", () => { connected = true; updateLiveText(); });
  events.addEventListener("error", () => { connected = false; updateLiveText(); });
}

function tick() {
  for (const node of document.querySelectorAll("time[data-rel]")) node.textContent = relTime(node.getAttribute("datetime"));
  for (const node of document.querySelectorAll(".card.fresh")) {
    if (!isFresh(node.getAttribute("data-key"))) node.classList.remove("fresh");
  }
  updateLiveText();
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("search").addEventListener("input", (ev) => { ui.query = ev.target.value.trim(); renderAll(); });
  document.getElementById("detail-close").addEventListener("click", () => document.getElementById("detail").close());
  if (window.BrainsVisual) {
    brains = new window.BrainsVisual(
      document.getElementById("brains-canvas"),
      document.getElementById("bolt-tip"),
      // Hovering a bolt lights its line in "Latest messages".
      (id) => {
        for (const node of document.querySelectorAll(".msg-item")) {
          node.classList.toggle("lit", id !== null && node.getAttribute("data-id") === id);
        }
      },
    );
    if (demoMode) startDemo();
  }
  connect();
  load();
  setInterval(tick, 20_000);
});
