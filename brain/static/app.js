"use strict";

// Every piece of text on this page comes from files MAC and Claude wrote. It is always inserted as
// text (textContent), never as HTML.

const STATE_LABELS = {
  running: "Running", waiting: "Waiting", done: "Done", blocked: "Blocked", error: "Error",
  gate_failed: "Gate failed", stalled: "Stalled", no_report: "No report", followed_up: "MAC handling", cleared: "Cleared",
  prepared: "No Claude run",
  OPEN: "Open", BLOCKED: "Blocked", PARKED: "Parked", DONE: "Done", RUNNING: "Running", NOTE: "Note",
};
// One action label per card, set by the server (brain/labels.py). Lists group by it, in this order.
const ACTIONS = [
  ["needs_anthony", "▲ NEEDS ANTHONY"],
  ["in_progress", "▶ IN PROGRESS"],
  ["queued", "… QUEUED"],
  ["done", "✔ DONE"],
];
const ACTION_LABEL = Object.fromEntries(ACTIONS);
const ACTION_RANK = Object.fromEntries(ACTIONS.map(([a], i) => [a, i]));
// Stable sort: NEEDS ANTHONY first, newest-first order kept inside each group.
const byAction = (items) => [...items].sort((a, b) => (ACTION_RANK[a.action] ?? 9) - (ACTION_RANK[b.action] ?? 9));
const actionBadge = (action) => el("span", { class: `act act-${action}` }, ACTION_LABEL[action] || action);
const JOB_LIST_LIMIT = 80;
const FRESH_MS = 90_000;

const ui = { query: "", openOrders: new Set(), doneOpen: { jobs: false, orders: false }, openNode: null, mine: false };

// "Only mine": Anthony's view shows only items where he is up next (brain/foundation.py).
const mineOnly = (item) => !ui.mine || (item && item.up_next === "Anthony");

// Next / proof / drift for one job or work order: who acts next, the proof behind a DONE, and any
// disagreement between STATUS.md, REPORT.md and git.
function foundationLine(item) {
  const bits = [];
  if (item.up_next) bits.push(el("span", { class: `nx nx-${item.up_next.toLowerCase()}`, title: "Who's up next" }, `Next: ${item.up_next}`));
  if (item.proof) bits.push(el("span", { class: "proof", title: "Proof behind DONE" }, `✔ ${item.proof.kind} ${item.proof.text}`));
  else if (item.verified === false) bits.push(el("span", { class: "unverified", title: "DONE without a commit, test result or file path" }, "UNVERIFIED"));
  for (const why of item.drift || []) bits.push(el("span", { class: "drift", title: why }, "DRIFT"), el("span", { class: "drift-why" }, why));
  if (item.lifecycle_why && item.lifecycle !== "running") bits.push(el("span", { class: "life-why" }, item.lifecycle_why));
  if (item.state_since && item.lifecycle && item.lifecycle !== "done" && item.lifecycle !== "resolved") {
    bits.push(el("span", { class: "since", title: `${item.lifecycle} since ${item.state_since}` }, `${item.lifecycle} ${elapsed(item.state_since)}`));
  }
  for (const flag of item.flags || []) bits.push(el("span", { class: "flag-red", title: flag }, flag.split(":")[0]));
  if (item.known_issue) {
    bits.push(el("span", { class: "known", title: `Approved lesson ${item.known_issue.id}: handled by MAC, not alerted` }, `KNOWN ISSUE ${item.known_issue.id}`),
      el("span", { class: "life-why" }, `Fix: ${item.known_issue.fix}`));
  }
  if (item.no_decision_id) bits.push(el("span", { class: "unverified", title: "Briefs written since the decision log started must cite the A-xxx IDs they follow" }, "NO A-ID"));
  return bits.length ? el("div", { class: "fnd" }, bits) : null;
}
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
  text = String(text);
  const out = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|~~([^~]+)~~/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push(...lightWords(text.slice(last, m.index)));
    if (m[1] !== undefined) out.push(el("code", {}, m[1]));
    else if (m[2] !== undefined) out.push(el("strong", {}, md(m[2])));
    else out.push(el("s", {}, md(m[3])));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...lightWords(text.slice(last)));
  return out;
}

// Status words light up like syntax highlighting: resolved green, blocked red, waiting amber.
const WORD_TONES = [
  [/\b(DONE|APPROVED|DECIDED|RESOLVED|CLEARED|MERGED|COMMITTED|PASS(?:ED)?|VERIFIED|UNBLOCKED|DROPPED|committed|merged|approved|resolved|cleared|unblocked)\b/g, "good"],
  [/\b(BLOCKED|FAILED|FAIL|ERROR|STALLED)\b/g, "bad"],
  [/\b(PENDING|AWAITING|WAITING|HELD|PARKED|awaiting|pending)\b/g, "warn"],
];

function lightWords(text) {
  const hits = [];
  for (const [re, tone] of WORD_TONES) {
    for (const m of text.matchAll(re)) hits.push({ i: m.index, len: m[0].length, tone });
  }
  if (!hits.length) return [text];
  hits.sort((a, b) => a.i - b.i);
  const out = [];
  let last = 0;
  for (const h of hits) {
    if (h.i < last) continue;
    if (h.i > last) out.push(text.slice(last, h.i));
    out.push(el("span", { class: `word-${h.tone}` }, text.slice(h.i, h.i + h.len)));
    last = h.i + h.len;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Every state belongs to one family; the family sets its badge and the card's tint.
const FAMILY = {
  done: "good", DONE: "good", cleared: "good",
  followed_up: "handled",
  running: "run", waiting: "run", RUNNING: "run",
  OPEN: "open",
  blocked: "bad", error: "bad", gate_failed: "bad", stalled: "bad", no_report: "bad", BLOCKED: "bad",
  prepared: "idle", PARKED: "idle", NOTE: "idle",
};
const family = (state) => FAMILY[state] || "idle";

// STATUS.md decisions, judged by the server (brain/guard.py): "~~Push/merge X~~ DONE 09:00 …" is settled;
// "confirm it's done" checks go to MAC; everything else open is Anthony's.
const decisionItems = () => (snap.status.decision_items || []);
const openDecisions = () => decisionItems().filter((i) => !i.settled && i.route === "anthony").map((i) => i.text);
const decisionIds = (ids) => (ids || []).map((id) => {
  const known = (snap.status.decision_log || {})[id];
  return el("span", { class: "dec-id", title: known ? `${id} · ${known.when || ""} · ${known.text}` : `${id} (not in the decision log)` }, id);
});

const badge = (state) => el("span", { class: `badge s-${state} fam-${family(state)}` }, STATE_LABELS[state] || state);
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
  const lines = [];
  const resolved = job.state === "followed_up" || job.state === "cleared";
  if (resolved) {
    const where = String(job.followed_up_by || "").startsWith("STATUS.md") ? "MAC's change log"
      : String(job.followed_up_by || "").startsWith("MAC (comms") ? "MAC's message log" : job.followed_up_by;
    lines.push(el("p", { class: `resolution ${job.state}`, title: job.followed_up_by || "" },
      job.state === "cleared" ? "✔ Cleared by MAC" : "↻ MAC is handling it",
      ` · ${where}`, job.followed_up_at ? ` · ${relTime(job.followed_up_at)}` : ""));
  }
  // Once resolved, the old problem is history: one dim "was:" line.
  const was = (text, cls, prefix = "") => el("p", { class: resolved ? "line was" : cls, title: resolved ? text : null },
    resolved ? "was: " : prefix, md(text));
  if (job.kind === "folder") {
    if (job.report_headline) {
      lines.push(was(job.report_headline, "line", job.headline_source === "final reply" ? "Final reply: " : ""));
    }
  } else if (job.note) {
    lines.push(was(job.note, "line"));
  } else if (job.result_preview) {
    lines.push(el("p", { class: "line muted" }, job.result_preview.slice(0, 260)));
  }
  return lines;
}

// ---------- copy-a-fix-request buttons (ask.js) ----------

// Only real problems get a fix-request button: the server marks them "alertable" (blocked, stalled,
// gate_failed, no_report, error; BLOCKED work orders). Running, waiting, OPEN and resolved never do.
const findJob = (kind, id) => (kind === "folder" ? snap.folders : snap.oneshots).find((j) => j.id === id);
const findOrder = (id) => snap.inbox.find((e) => e.id === id);

function ask(build, label) {
  return window.askButton ? window.askButton(build, label) : null;
}

// A card plus, under it, its copy button. Buttons can't sit inside the card (itself a button).
function withAsk(card, askBtn) {
  return askBtn ? el("div", { class: "card-wrap" }, card, askBtn) : card;
}

function jobCard(job) {
  const card = el("button", {
    type: "button", class: `card tone-${family(job.state)}${isFresh(jobKey(job)) ? " fresh" : ""}`, "data-key": jobKey(job),
    onclick: () => openDetail(job.kind, job.id, job.title),
  },
    el("div", { class: "card-top" }, actionBadge(job.action), el("span", { class: "card-title" }, md(job.title || job.id))),
    jobMeta(job),
    foundationLine(job),
    actionLine(job),
    jobLine(job),
  );
  const askBtn = job.alertable
    ? ask(() => window.askDrafts.draftForJob(findJob(job.kind, job.id) || job))
    : null;
  return el("li", {}, withAsk(card, askBtn));
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

// The short "what's happening" line under each card's title: why it needs Anthony, who is on it and
// when its log last moved, or what it's queued behind.
function actionLine(item) {
  // A job's own line below already shows its note or report headline; don't say it twice.
  const shownBelow = item.kind && [item.note, item.report_headline].includes(item.action_note);
  if (item.action === "needs_anthony" && item.action_note && !shownBelow) {
    return el("p", { class: "action-line needs" }, md(item.action_note));
  }
  if (item.action === "in_progress") {
    return el("p", { class: "action-line progress" },
      item.action_who ? `${item.action_who}` : "on it",
      item.action_at ? ` · log moved ${relTime(item.action_at)}` : "",
      item.action_note && item.action_who !== "Claude (one-shot)" && !item.kind ? ` · ${item.action_note}` : "");
  }
  if (item.action === "queued" && item.action_note) {
    return el("p", { class: "action-line queued" }, "waiting: ", md(item.action_note));
  }
  return null;
}

// Live groups first (NEEDS ANTHONY on top), then a collapsed Done section.
function groupedList(listId, items, cardFn, which) {
  const groups = Object.fromEntries(ACTIONS.map(([a]) => [a, []]));
  for (const item of items) (groups[item.action] || groups.queued).push(item);
  // What has waited on Anthony longest goes first.
  groups.needs_anthony.sort((a, b) => (a.state_since || "~").localeCompare(b.state_since || "~"));
  const nodes = [];
  for (const [action, title] of ACTIONS.slice(0, 3)) {
    if (!groups[action].length) continue;
    nodes.push(el("li", { class: `group-h act-${action}` }, el("span", {}, title), el("span", { class: "group-n" }, String(groups[action].length))));
    nodes.push(...groups[action].map(cardFn));
  }
  if (!nodes.length) nodes.push(el("li", { class: "group-h" }, empty("Nothing live right now.")));
  const done = groups.done;
  if (done.length) {
    const shown = done.slice(0, JOB_LIST_LIMIT);
    const box = el("details", {
      class: "done-group", open: ui.doneOpen[which],
      ontoggle: (ev) => { ui.doneOpen[which] = ev.target.open; },
    },
      el("summary", {}, el("span", { class: "act act-done" }, "✔ DONE"), ` ${done.length}`,
        done.length > shown.length ? ` · newest ${shown.length} listed` : "", el("span", { class: "group-hint" }, " · click to open")),
      el("ol", { class: "list" }, shown.map(cardFn)),
    );
    nodes.push(el("li", { class: "group-done" }, box));
  }
  document.getElementById(listId).replaceChildren(...nodes);
  return groups;
}

function renderJobs() {
  const jobs = allJobs().filter((j) => mineOnly(j) && matches(j.title, j.id, j.report_headline, j.result_preview, j.prompt_preview));
  const groups = groupedList("jobs", jobs, jobCard, "jobs");
  const live = jobs.length - groups.done.length;
  document.getElementById("jobs-count").textContent = `${live} live · ${groups.done.length} done`;
  const total = snap.oneshot_total + snap.folders.length;
  document.getElementById("jobs-note").textContent =
    `${total} jobs on record; the newest ${snap.oneshots.length + snap.folders.length} are here.`;
}

// Everything actually being worked on, as one table. A job MAC's log still calls running but whose folder
// here has stopped is left out (MAC didn't log the finish).
const MACHINES = { windows: "Windows", grok: "Grok Bot's computer", mac: "This Mac" };
const localTime = (text) => { // "2026-10-09 16:12:48 EDT" from runs.log, in this Mac's time
  const m = String(text || "").match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);
  return m ? new Date(`${m[1]}T${m[2]}`).toISOString() : null;
};
const lastAction = (acts) => {
  const a = (acts || [])[acts ? acts.length - 1 : 0];
  return !a ? "" : a.kind === "tool" ? `${a.name}: ${a.summary || ""}` : a.text || "";
};

function activeRows() {
  const rows = [];
  const stopped = new Set();
  for (const j of allJobs()) {
    if (j.state !== "running" && j.state !== "waiting") { stopped.add(j.id); continue; }
    const folder = j.kind === "folder";
    rows.push({
      id: jobKey(j), job: j.id, title: j.title || j.id, where: "MAC", machine: "MAC",
      who: folder ? `Claude · ${[j.model, j.effort].filter(Boolean).join(" ")}`.replace(/ · $/, "") : "Claude (one-shot)",
      doing: folder ? lastAction(j.activity) || "starting" : "waiting for its result",
      started: folder ? localTime(j.started) : j.sent_at, moved: folder ? j.stream_updated_at : j.sent_at,
      open: () => openDetail(j.kind, j.id, j.title),
    });
  }
  const beat = snap.windows || {};
  for (const rj of snap.remote_jobs || []) {
    if (rj.state !== "running" || stopped.has(rj.id) || rows.some((r) => r.job === rj.id)) continue;
    const name = rj.id;
    const ms = (snap.messages || []).filter((m) => m.ref && m.ref.job === name && m.at); // newest first
    const last = ms[0], start = ms.find((m) => m.mac_kind === "job_started") || ms[ms.length - 1];
    const how = last && last.text.match(/\((opus|sonnet|haiku|fable)[^)]*\)/i);
    const onBeat = rj.machine === "WINDOWS" && beat.fresh && beat.job === name;
    rows.push({
      id: `comms:${name}`, job: name, title: start ? plain(start.text) : name, machine: rj.machine,
      where: rj.machine === "WINDOWS" ? "WINDOWS" : "MAC",
      who: how ? `Claude · ${how[0].slice(1, -1).toLowerCase()}` : "Claude",
      // MAC logs a job's start and finish, not its steps; a fresh Windows heartbeat has its last log line
      doing: onBeat && beat.last_log_line ? plain(beat.last_log_line)
        : last && last !== start ? plain(last.text) : "Started; MAC has logged nothing since",
      source: rj.source, started: rj.started_at, moved: onBeat ? beat.at : rj.last_at,
      open: () => { const n = brains && brains.findNode(`mac:${name}`); if (n) { document.querySelector(".hero").scrollIntoView({ behavior: "smooth" }); openNodePopup(n); } },
    });
  }
  for (const e of snap.inbox) {
    if (e.state !== "RUNNING") continue;
    rows.push({
      id: `wo:${e.id}`, job: e.wo !== null ? window.Volley.woKey(e.wo) : "Work order", title: plain(e.title),
      where: "—", who: e.action_who || "—", doing: plain(e.status_text || ""), started: null, moved: null,
      open: () => revealOrder(e.id),
    });
  }
  for (const c of (snap.codex && snap.codex.running) || []) {
    rows.push({
      id: `codex:${c.job}`, job: c.job, title: "Codex picture job", where: c.machine, machine: c.machine,
      who: "Codex", doing: `making pictures${c.output_dir ? ` → ${c.output_dir}` : ""}`,
      started: c.started_at, moved: c.started_at, source: "codex-status.jsonl",
      open: () => document.getElementById("messages").scrollIntoView({ behavior: "smooth", block: "center" }),
    });
  }
  return rows.sort((a, b) => (b.moved || "").localeCompare(a.moved || ""));
}

const elapsed = (iso) => {
  if (!iso) return "—";
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 60 ? `${min} m` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} m`;
};

// Active now: a 3-lane timeline (Claude, MAC, Windows) by default, or the table. The choice and the time
// range are remembered in this browser only.
const TL_RANGES = [3, 6, 12, 24];
const store = {
  get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked: keep it for this visit */ } },
};
ui.activeView = store.get("brain-active-view", "timeline");
ui.tlHours = Number(store.get("brain-tl-hours", "6")) || 6;

function renderRunning() {
  const rows = ui.mine ? [] : activeRows().filter((r) => matches(r.job, r.title, r.doing));
  document.getElementById("running-count").textContent = rows.length || "";
  const box = document.getElementById("running");
  const tab = (view, label) => el("button", {
    type: "button", class: `tl-tab${ui.activeView === view ? " on" : ""}`, "aria-pressed": String(ui.activeView === view),
    onclick: () => { ui.activeView = view; store.set("brain-active-view", view); renderRunning(); },
  }, label);
  const ranges = ui.activeView === "timeline" ? el("span", { class: "tl-ranges", role: "group", "aria-label": "Time range" },
    TL_RANGES.map((h) => el("button", {
      type: "button", class: `tl-range${ui.tlHours === h ? " on" : ""}`, "aria-pressed": String(ui.tlHours === h),
      onclick: () => { ui.tlHours = h; store.set("brain-tl-hours", String(h)); renderRunning(); },
    }, `${h} h`))) : null;
  const controls = el("div", { class: "tl-controls" }, tab("timeline", "Timeline"), tab("table", "Table"), ranges);
  if (ui.activeView === "timeline") { box.replaceChildren(controls, renderTimeline()); return; }
  if (!rows.length) {
    const next = snap.inbox.find((e) => e.action === "queued");
    box.replaceChildren(controls,
      empty("Nothing is being worked on right now."),
      next ? el("p", { class: "line muted" }, "Next in the queue: ", md(next.title), next.action_note ? ` (${next.action_note})` : "") : null,
    );
    return;
  }
  const head = ["Status", "Job", "Where", "Who", "Doing now", "Started", "Running for", "Log moved"];
  box.replaceChildren(controls, el("div", { class: "active-wrap" }, el("table", { class: "active-table" },
    el("caption", { class: "visually-hidden" }, "Jobs being worked on right now"),
    el("thead", {}, el("tr", {}, head.map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, rows.map((r) => el("tr", {
      tabindex: 0, class: isFresh(r.id) ? "fresh" : "", onclick: r.open,
      onkeydown: (ev) => { if (ev.key === "Enter") r.open(); },
    },
      el("td", {}, el("span", { class: "act act-in_progress" }, "▶ IN PROGRESS")),
      el("td", { class: "active-job" }, el("b", {}, r.job), el("span", {}, clipText(r.title, 90))),
      el("td", {}, el("span", { class: `machine m-${r.where.toLowerCase()}`, title: r.source || "" }, r.where)),
      el("td", {}, r.who),
      el("td", { class: "active-doing" }, clipText(r.doing, 140)),
      el("td", { class: "active-num" }, r.started ? clock(r.started) : "—"),
      el("td", { class: "active-num" }, elapsed(r.started)),
      el("td", { class: "active-num" }, r.moved ? relTime(r.moved) : "—"),
    ))),
  )));
}

// Greedy packing: bars that overlap in time go on separate rows of their lane.
function packRows(bars) {
  const rows = [];
  for (const b of bars.sort((x, y) => x.s - y.s)) {
    let r = rows.findIndex((end) => end <= b.s - 0.004);
    if (r < 0) { r = rows.length; rows.push(0); }
    rows[r] = b.e;
    b.row = r;
  }
  return Math.max(1, rows.length);
}

function openTimelineBar(open) {
  if (!open) return;
  if (open.type === "job") openDetail(open.kind, open.id, open.id);
  else if (open.type === "node") openStationNode(open.id);
}

function renderTimeline() {
  const t = snap.timeline;
  if (!t) return empty("No timeline yet.");
  const now = Date.now(), from = now - ui.tlHours * 3600000, span = now - from;
  const x = (ms) => Math.max(0, Math.min(1, (ms - from) / span));
  const pct = (u) => `${(u * 100).toFixed(2)}%`;
  const tip = el("div", { class: "tl-tip", hidden: true, role: "tooltip" });
  const showTip = (ev, head, body) => {
    tip.replaceChildren(el("strong", {}, head), el("span", {}, body || ""));
    tip.hidden = false;
    const wrap = ev.currentTarget.closest(".tl").getBoundingClientRect(), r = ev.currentTarget.getBoundingClientRect();
    tip.style.setProperty("left", `${Math.min(wrap.width - 300, Math.max(0, r.left - wrap.left))}px`);
    tip.style.setProperty("top", `${r.bottom - wrap.top + 6}px`);
  };
  const hideTip = () => { tip.hidden = true; };
  const STATE_TEXT = { running: "running", done: "done", blocked: "blocked" };
  const lanes = [["claude", "CLAUDE", "this Mac"], ["mac", "MAC", "Grok Bot"], ["windows", "WINDOWS", "Windows PC"]].map(([key, name, sub]) => {
    const bars = [];
    for (const b of t.lanes[key] || []) {
      const end = b.end ? Date.parse(b.end) : now, start = b.start ? Date.parse(b.start) : null;
      if (end < from || (start !== null && start > now)) continue;
      bars.push({ ...b, s: start === null ? x(end) : x(start), e: x(end), mark: start === null });
    }
    const rowsN = packRows(bars);
    const track = el("div", { class: "tl-track" });
    track.style.setProperty("--rows", String(rowsN));
    for (const b of bars) {
      const when = b.mark ? `finished ${clock(b.end)} (start not logged)`
        : `${clock(b.start)} – ${b.end ? clock(b.end) : "now"} · ${fmtMin(Math.round(((b.end ? Date.parse(b.end) : now) - Date.parse(b.start)) / 60000))}`;
      const node = el("button", {
        type: "button", class: `tl-bar st-${b.state}${b.mark ? " mark" : ""}`,
        "aria-label": `${b.label}, ${STATE_TEXT[b.state] || b.state}, ${when}`,
        onclick: () => openTimelineBar(b.open),
        onmouseenter: (ev) => showTip(ev, `${b.label} · ${(STATE_TEXT[b.state] || b.state).toUpperCase()}`, `${when}\n${b.title}`),
        onmouseleave: hideTip, onfocus: (ev) => showTip(ev, b.label, when), onblur: hideTip,
      }, b.mark ? "" : el("span", { class: "tl-label" }, b.label));
      node.style.setProperty("left", pct(b.s));
      if (!b.mark) node.style.setProperty("width", `max(6px, ${pct(Math.max(0, b.e - b.s))})`);
      node.style.setProperty("--row", String(b.row));
      track.append(node);
    }
    if (key === "mac") {
      for (const tk of t.ticks || []) {
        const at = Date.parse(tk.at);
        if (at < from) continue;
        const mark = el("button", {
          type: "button", class: `tl-tick${tk.machine === "windows" ? " to-win" : ""}`,
          "aria-label": `MAC sent: ${tk.title}`,
          onmouseenter: (ev) => showTip(ev, `MAC → ${tk.machine === "windows" ? "Windows" : "Claude"} · ${clock(tk.at)}`, tk.title),
          onmouseleave: hideTip, onfocus: (ev) => showTip(ev, "MAC sent", tk.title), onblur: hideTip,
          onclick: () => openStationNode(`mac:${tk.label}`),
        });
        mark.style.setProperty("left", pct(x(at)));
        track.append(mark);
      }
    }
    if (!bars.length && !(key === "mac" && (t.ticks || []).length)) track.append(el("span", { class: "tl-none" }, "nothing in this range"));
    return el("div", { class: `tl-lane lane-${key}` }, el("div", { class: "tl-name" }, el("b", {}, name), el("span", {}, sub)), track);
  });
  // hour marks along the top
  const axis = el("div", { class: "tl-axis" });
  const step = ui.tlHours <= 6 ? 3600000 : ui.tlHours <= 12 ? 2 * 3600000 : 4 * 3600000;
  for (let ms = Math.ceil(from / step) * step; ms < now; ms += step) {
    const lab = el("span", { class: "tl-hour" }, new Date(ms).toLocaleTimeString([], { hour: "numeric" }));
    lab.style.setProperty("left", pct(x(ms)));
    axis.append(lab);
  }
  const nowLab = el("span", { class: "tl-hour tl-now-lab" }, "now");
  nowLab.style.setProperty("left", "100%");
  axis.append(nowLab);
  const legend = el("p", { class: "tl-legend" },
    el("span", { class: "lg run" }, "running"), el("span", { class: "lg done" }, "done"), el("span", { class: "lg blocked" }, "blocked"),
    el("span", { class: "lg mark" }, "finish only"), el("span", { class: "lg tick" }, "MAC sent a job"), " · hover for detail, click to open");
  return el("div", { class: "tl" }, el("div", { class: "tl-lane tl-axis-row" }, el("div", { class: "tl-name" }), axis), ...lanes, legend, tip);
}

// ---------- attention, decisions, orders, logs ----------

function renderAttention() {
  const items = snap.attention.filter((a) => matches(a.title, a.detail)
    && mineOnly(a.source === "job" ? findJob(a.kind, a.id) : findOrder(a.id)));
  const panel = document.getElementById("attention-panel");
  panel.classList.toggle("has-items", items.length > 0);
  document.getElementById("attention-count").textContent = items.length || "";
  const base = document.body.classList.contains("demo-mode") ? "SAMPLE MODE · Claude Brain" : "Claude Brain";
  document.title = items.length ? `(${items.length}) ${base}` : base;
  const box = document.getElementById("attention");
  const forMac = (snap.mac_attention || []).filter((a) => !ui.mine && matches(a.title, a.detail));
  const macList = forMac.length ? el("div", { class: "for-mac" },
    el("p", { class: "for-mac-h" }, `For MAC, not you (${forMac.length})`),
    el("ul", { class: "bullets" }, forMac.map((a) => el("li", {},
      el("span", { class: "badge fam-bad" }, "FAILED"), " ", el("b", {}, a.title), ` · ${a.detail}`,
      a.at ? ` · ${relTime(a.at)}` : "", el("span", { class: "via" }, " → MAC")))),
  ) : null;
  if (!items.length) {
    const older = [...allJobs(), ...snap.inbox].filter((i) => i.action === "needs_anthony").length;
    box.replaceChildren(empty(older
      ? `Nothing new in the last 3 days. ${older} older item${older === 1 ? "" : "s"} still marked ▲ NEEDS ANTHONY in the lists below.`
      : "Nothing stuck. No blocked work orders, failed gates, stalled or errored jobs in the last 3 days."), macList || "");
    return;
  }
  box.replaceChildren(el("ol", { class: "list" }, items.map((a) => {
    const card = el("button", {
      type: "button", class: `card tone-${family(a.state)}`,
      onclick: () => (a.source === "job" ? openDetail(a.kind, a.id, a.title) : revealOrder(a.id)),
    },
      el("div", { class: "card-top" }, badge(a.state), el("span", { class: "card-title" }, md(a.title))),
      a.detail ? el("p", { class: "line" }, md(a.detail)) : null,
    );
    const build = () => {
      if (a.source === "job") return window.askDrafts.draftForJob(findJob(a.kind, a.id) || { ...a, kind: a.kind, activity: [] });
      return window.askDrafts.draftForOrder(findOrder(a.id));
    };
    return el("li", {}, withAsk(card, ask(build)));
  })), macList || "");
}

function renderDecisions() {
  const items = decisionItems().filter((i) => mineOnly(i) && matches(i.text));
  const rank = (i) => (i.settled ? 2 : i.route === "anthony" ? 0 : 1);
  items.sort((a, b) => rank(a) - rank(b));
  const open = items.filter((i) => !i.settled && i.route === "anthony").length;
  document.getElementById("decisions-count").textContent = open ? String(open) : "";
  const list = document.getElementById("decisions");
  const row = (i) => {
    const cls = i.settled ? "decision settled" : i.route === "mac" ? "decision mac" : "decision open";
    const fam = i.settled ? "fam-good" : i.route === "mac" ? "fam-handled" : "fam-open";
    const action = i.settled ? null
      : i.route === "mac" ? ask(() => window.askDrafts.draftForConfirm(i.text), "Ask MAC to confirm")
      : ask(() => window.askDrafts.draftForDecision(i.text), "Copy my decision");
    return el("li", { class: cls, title: i.settled ? i.text : null },
      el("span", { class: `badge ${fam}` }, i.word), " ",
      ...decisionIds(i.ids), " ",
      md(i.text),
      i.via ? el("span", { class: "via" }, ` → ${i.via}`) : null,
      action ? el("span", {}, " ", action) : null);
  };
  list.replaceChildren(...(items.length ? items.map(row) : [el("li", { class: "empty" }, "Nothing listed.")]));
}

function orderCard(entry) {
  const key = `wo:${entry.id}`;
  const details = el("details", {
    class: `card tone-${family(entry.state)}${isFresh(key) ? " fresh" : ""}`, "data-key": key, id: `order-${entry.id}`,
    open: ui.openOrders.has(entry.id),
    ontoggle: (ev) => (ev.target.open ? ui.openOrders.add(entry.id) : ui.openOrders.delete(entry.id)),
  },
    el("summary", {},
      el("div", { class: "card-top" }, actionBadge(entry.action), el("span", { class: "card-title" }, md(entry.title))),
      el("div", { class: "meta" },
        el("span", {}, `state: ${entry.state.toLowerCase()}`),
        entry.date && el("span", {}, entry.date),
        entry.wo !== null && el("span", {}, `WO #${entry.wo}`),
        entry.from && el("span", {}, `from ${entry.from}`),
        entry.replies.length ? el("span", {}, `${entry.replies.length} replies`) : null,
      ),
      foundationLine(entry),
      actionLine(entry),
      entry.status_text && entry.action !== "in_progress" ? el("p", { class: "line muted" }, md(entry.status_text)) : null,
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
  const askBtn = entry.alertable ? ask(() => window.askDrafts.draftForOrder(findOrder(entry.id) || entry)) : null;
  return el("li", {}, withAsk(details, askBtn));
}

function renderOrders() {
  const entries = snap.inbox.filter((e) => mineOnly(e) && matches(e.title, e.status_text, e.body, ...e.replies.map((r) => r.text)));
  const groups = groupedList("orders", entries, orderCard, "orders");
  document.getElementById("orders-count").textContent = `${entries.length - groups.done.length} live · ${groups.done.length} done`;
}

function revealOrder(id) {
  const entry = findOrder(id);
  if (entry && entry.action === "done") ui.doneOpen.orders = true;
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
      // Incidents are MAC's own history log: no fix-request buttons (only blocked/stalled/failed jobs get them).
      ? incidents.map((i) => el("li", {}, `${i.date}${i.job ? ` · ${i.job}` : ""}: `, md(i.what)))
      : [el("li", { class: "empty" }, "No incidents logged.")])
  );
  document.getElementById("sources").replaceChildren(
    "Reading: ",
    ...Object.entries(snap.sources).flatMap(([name, src], i) => [
      i ? " · " : "",
      `${name} `,
      src.exists
        ? el("span", {}, "(", relTime(src.updated_at) || "ok", ")")
        : src.optional ? el("span", {}, "(not started yet)")
          : el("strong", {}, "(missing) ", ask(() => window.askDrafts.draftForBrain(name, src), "Ask Claude")),
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
  // Oldest first; volley.js keeps at most three bolts in flight and queues the rest.
  fresh.slice(0, MAX_BOLTS_PER_UPDATE).reverse().forEach((m) => {
    if (!brains) return;
    // Codex reports to MAC: a spark on the station of the machine it runs on, not a bolt
    if (m.direction === "codex") brains.spark(m.machine === "windows" ? "windows" : "mac", `codex:${m.ref.job}`);
    else brains.fire(m);
  });
}

function openMessage(m) {
  if (m.ref.source === "job") return openDetail(m.ref.kind, m.ref.id, m.text);
  if (m.ref.source === "work_order") return revealOrder(m.ref.id);
  // From MAC's log: go to the job or work order it names, if the Brain knows it.
  if (m.ref.job && snap.folders.some((j) => j.id === m.ref.job)) return openDetail("folder", m.ref.job, m.text);
  const order = m.ref.wo !== null && snap.inbox.find((e) => e.wo === m.ref.wo);
  if (order) revealOrder(order.id);
}

// Today's lines show the time; older lines show the date too, so the log reads in order.
function clock(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString()
    ? `${time}:${pad(d.getSeconds())}`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}
const TERM_LINES = 40;
const termSeen = new Set();
let termPrimed = false;

// What happened, as one small badge. Display only: read from fields the server already sends.
function messageStatus(m) {
  if (m.direction === "codex") {
    return m.mac_kind === "failed" ? ["FAILED", "bad"] : m.mac_kind === "finished" ? ["DONE", "good"] : ["STARTED", "run"];
  }
  if (m.blocked && !m.cleared) return ["BLOCKED", "bad"];
  if (m.cleared) return ["CLEARED", "good"];
  if (m.mac_kind === "job_started") return ["STARTED", "run"];
  if (m.mac_kind === "resolve" || m.mac_kind === "unblocked") return ["RESOLVED", "good"];
  if (m.kind === "job_sent") return ["SENT", "open"];
  if (m.kind === "report") return /\bDONE\b/.test(m.text) ? ["DONE", "good"] : ["REPORT", "open"];
  if (m.kind === "work_order") return ["NEW WO", "open"];
  if (m.kind === "job_result") return ["RESULT", "idle"];
  return ["REPLY", "idle"];
}

const tag = (who) => el("span", { class: `tag tag-${who.toLowerCase()}` }, who);

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

// comms feed: newest first, grouped by day. Lines that arrive while the page is open slide in at the top.
function renderTerminal() {
  const timed = (snap.messages || []).filter((m) => m.at && matches(m.text, m.kind)).slice(0, TERM_LINES);
  const box = document.getElementById("messages");
  const atTop = box.scrollTop < 24;
  const perDay = {};
  for (const m of timed) perDay[dayLabel(m.at)] = (perDay[dayLabel(m.at)] || 0) + 1;
  const rows = [el("li", { class: "term-live", "aria-hidden": "true" }, "LIVE · LISTENING")];
  let day = null;
  for (const m of timed) {
    const label = dayLabel(m.at);
    if (label !== day) {
      day = label;
      rows.push(el("li", { class: "term-day" }, label, el("i", {}, `${perDay[label]} message${perDay[label] === 1 ? "" : "s"}`)));
    }
    const isNew = termPrimed && !termSeen.has(m.id);
    termSeen.add(m.id);
    const open = m.blocked && !m.cleared; // a blocked report MAC resolved since is history, not an alert
    const [from, to] = m.direction === "codex" ? ["CODEX", "MAC"] : m.direction === "to_claude" ? ["MAC", "CLAUDE"] : ["CLAUDE", "MAC"];
    const kind = window.BrainsVisual ? window.BrainsVisual.kindLabel(m.kind) : m.kind;
    const [word, fam] = messageStatus(m);
    const onWindows = m.machine === "windows";
    rows.push(el("li", {},
      el("button", {
        type: "button", class: `term-line${isNew ? " new" : ""}${m.cleared ? " cleared" : ""}${open ? " open" : ""}`, "data-id": m.id,
        title: `${clock(m.at)} · ${from} → ${to}${onWindows ? " (on Windows)" : ""} · ${kind} · ${word}\n${m.text}`,
        onclick: () => openMessage(m),
        onmouseenter: () => brains && brains.highlight(m.id),
        onmouseleave: () => brains && brains.highlight(null),
        onfocus: () => brains && brains.highlight(m.id),
        onblur: () => brains && brains.highlight(null),
      },
        el("span", { class: "term-time" }, clock(m.at)),
        el("span", { class: "term-who" }, tag(from), el("span", { class: "arr", "aria-label": "to" }, "▸"), tag(to), onWindows ? tag("WINDOWS") : null),
        el("span", { class: "term-txt" }, el("span", { class: "term-kind" }, kind), md(m.text)),
        el("span", { class: "term-st" }, el("span", { class: `badge fam-${fam}` }, word)),
      )
    ));
  }
  termPrimed = true;
  if (!timed.length) rows.push(el("li", { class: "term-end" }, "No messages yet."));
  box.replaceChildren(...rows);
  if (atTop) box.scrollTop = 0;
}

// ---------- at a glance ----------

function statTile(key, value, detail, color, target) {
  const tile = el("button", {
    type: "button", class: "stat-tile",
    onclick: () => target && document.getElementById(target).scrollIntoView({ behavior: "smooth", block: "start" }),
  },
    el("span", { class: "stat-k" }, key),
    el("span", { class: "stat-v" }, String(value)),
    el("span", { class: "stat-d", title: detail }, detail),
  );
  tile.style.setProperty("--c", color); // CSP blocks style="" attributes; the style object is allowed
  return tile;
}

function renderStatus() {
  const running = allJobs().filter((j) => j.state === "running" || j.state === "waiting");
  const elsewhere = (snap.comms && snap.comms.running) || [];
  const stuck = snap.attention.length;
  const day = (snap.messages || []).filter((m) => m.at && Date.now() - Date.parse(m.at) < 86400000);
  const toClaude = day.filter((m) => m.direction === "to_claude").length;
  const last = (snap.messages || []).find((m) => m.at);
  const active = activeRows();
  const runText = active.length ? active.map((r) => r.job).join(", ") : "nothing running";
  document.getElementById("statusbar").replaceChildren(
    statTile("running", active.length, runText, "var(--running)", "running-panel"),
    statTile("needs_you", openDecisions().length,
      `${openDecisions().length} open · ${snap.status.decisions.length - openDecisions().length} settled in MAC's STATUS.md`,
      openDecisions().length ? "var(--mac)" : "var(--done)", "decisions-panel"),
    statTile("stuck", stuck, stuck ? snap.attention[0].title : "nothing blocked or failing", stuck ? "var(--accent)" : "var(--done)", "attention-panel"),
    statTile("msgs_24h", day.length, `${toClaude} MAC→Claude · ${day.length - toClaude} Claude→MAC`, "var(--claude)", "messages"),
    statTile("codex_today", ((snap.codex || {}).today || {}).done || 0,
      `${((snap.codex || {}).today || {}).pictures || 0} pictures · ${((snap.codex || {}).running || []).length} running`,
      "#10a37f", "messages"),
    statTile("last_msg", last ? relTime(last.at).replace(" ago", "") : "—",
      last ? `${last.direction === "to_claude" ? "MAC→Claude" : "Claude→MAC"}: ${last.text}` : "none yet",
      last && last.blocked && !last.cleared ? "var(--accent)" : "var(--text)", "messages"),
  );
}

// ---------- hero readouts and brain feeds ----------

function readoutLine(key, value, tone) {
  return el("div", { class: "ro-line" }, el("span", { class: "ro-k" }, key), el("span", { class: `ro-v${tone ? ` ${tone}` : ""}` }, value));
}

const lastActionSig = new Map();
const lastLogMove = new Map();
let lastBeat = null;
let pulsesPrimed = false;

function renderHero() {
  // Both readouts use the same list as the Active now table, so they never disagree with it.
  const active = activeRows();
  const running = snap.folders.filter((j) => j.state === "running"); // their tool calls spark below
  const here = active.filter((r) => r.where === "MAC").length;
  const lastToClaude = (snap.messages || []).find((m) => m.at && m.direction === "to_claude");
  const macActive = lastToClaude && Date.now() - Date.parse(lastToClaude.at) < 30 * 60000;
  const out = active.filter((r) => !r.id.startsWith("wo:")).length; // jobs MAC has out with Claude
  const open = snap.inbox.filter((e) => ["OPEN", "BLOCKED", "RUNNING"].includes(e.state)).length;
  const names = active.map((r) => r.job);
  document.getElementById("readout-claude").replaceChildren(
    readoutLine("claude.state",
      active.length ? `WORKING · ${active.length}${here === active.length ? "" : here ? ` (${active.length - here} off this Mac)` : " off this Mac"}` : "IDLE",
      active.length ? "hot" : ""),
    readoutLine("claude.job", names.length ? names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : "") : "—"),
    readoutLine("claude.doing", active.length ? clipText(active[0].doing || "—", 60) : "—"),
    readoutLine("jobs.24h", String(allJobs().filter((j) => Date.now() - Date.parse(j.updated_at || 0) < 86400000).length)),
  );
  document.getElementById("readout-mac").replaceChildren(
    readoutLine("mac.state", macActive ? "SENDING" : out ? `WAITING · ${out} job${out === 1 ? "" : "s"} out` : "QUIET", macActive || out ? "hot" : ""),
    readoutLine("mac.last_sent", lastToClaude ? relTime(lastToClaude.at) : "—"),
    readoutLine("orders.open", String(open)),
    readoutLine("needs.anthony", String(openDecisions().length), openDecisions().length ? "bad" : "ok"),
  );

  if (!brains) return;
  // The two Death Stars: live items as nodes, coloured by their action label.
  brains.setNodes(stationNodes());
  brains.setMessages(snap.messages);
  if (ui.openNode) openNodePopup(brains.findNode(ui.openNode), true);
  // Packet flow between the brains: how busy the channel has been in the last hour.
  const hour = (snap.messages || []).filter((m) => m.at && Date.now() - Date.parse(m.at) < 3600000);
  brains.setTraffic({
    toClaude: hour.filter((m) => m.direction === "to_claude").length,
    toMac: hour.filter((m) => m.direction === "to_mac").length,
  });
  // Real activity makes the stations spark: each new tool call or reply in a running job (with its name),
  // or, when there's no new action, its log moving at all. A fresh Windows heartbeat tick sparks Windows'.
  for (const j of running) {
    const actions = j.activity || [];
    const lastKey = actions.length ? JSON.stringify(actions[actions.length - 1]) : "";
    const before = lastActionSig.get(j.id);
    const movedBefore = lastLogMove.get(j.id);
    lastActionSig.set(j.id, lastKey);
    lastLogMove.set(j.id, j.stream_updated_at);
    if (!pulsesPrimed || before === undefined) continue;
    let fresh = [];
    if (lastKey !== before) {
      const prev = actions.findIndex((a) => JSON.stringify(a) === before); // -1 when it scrolled out
      fresh = actions.slice(prev >= 0 ? prev + 1 : Math.max(0, actions.length - 1)).slice(-4);
    }
    if (fresh.length) {
      fresh.forEach((a, i) => setTimeout(() => {
        brains.pulse(a.kind === "tool" ? a.name : "thinking");
        brains.spark("claude", j.id); // synapse: the job's node sparks on Claude's station
      }, i * 300));
    } else if (j.stream_updated_at && j.stream_updated_at !== movedBefore) {
      brains.spark("claude", j.id); // its log moved: Claude is working, even without a new tool call
    }
  }
  const beat = snap.windows || {};
  if (pulsesPrimed && beat.fresh && beat.job && beat.at && beat.at !== lastBeat) brains.spark("windows", beat.job);
  lastBeat = beat.at;
  pulsesPrimed = true;
}

// ---------- Death Star nodes and their popup ----------

const DAY = 864e5;
const plain = (text) => String(text || "").replace(/[*`~]/g, "").replace(/\s+/g, " ").trim();
const clipText = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// The key a job goes by on both stations: its id, or "WO #016" for a work order (volley.js).
const orderNumber = (id) => { const e = findOrder(id); return e ? e.wo : null; };
const messageKey = (m) => window.Volley.jobKey(m, orderNumber);
const orderKey = (e) => (e.wo !== null ? window.Volley.woKey(e.wo) : `wo:${e.id}`);

// Claude's station (orange): Claude's jobs and the work orders. MAC's station (blue): every job and work
// order MAC has talked about in the last day (its own, Windows ones, and the twins of Claude's), plus
// approvals waiting on Anthony. A job has the same key, place and colour on both, so twins line up.
// Finished items show faint for a day, then drop off.
function stationNodes() {
  const claude = [];
  let doneJobs = 0;
  for (const j of allJobs()) {
    if (j.action === "done" && (doneJobs >= 18 || !(Date.now() - Date.parse(j.updated_at) < DAY))) continue;
    if (j.action === "done") doneJobs += 1;
    const who = j.action_who ? `${j.action_who}${j.action_at ? ` · ${relTime(j.action_at)}` : ""}` : "";
    claude.push({
      id: `job:${j.kind}:${j.id}`, key: j.id, label: j.id, title: plain(j.title || j.id), action: j.action, since: j.state_since,
      kindLabel: j.kind === "folder" ? "Claude job" : "Claude one-shot",
      sub: plain(j.action === "in_progress" ? who : j.action_note || ""), ref: { type: "job", kind: j.kind, id: j.id },
    });
  }
  for (const e of snap.inbox) {
    if (e.action === "done") continue;
    claude.push({
      id: `wo:${e.id}`, key: orderKey(e), label: e.wo !== null ? orderKey(e) : clipText(plain(e.title), 22),
      title: plain(e.title), action: e.action, kindLabel: "Work order", since: e.state_since, sub: plain(e.action_note || ""), ref: { type: "order", id: e.id },
    });
  }

  const mac = [];
  const claudeAction = new Map(claude.map((n) => [n.key, n.action]));
  const running = new Set((snap.comms && snap.comms.running) || []);
  const byKey = new Map();
  for (const m of snap.messages || []) { // newest first
    const key = m.at && messageKey(m);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(m);
  }
  for (const [key, ms] of byKey) {
    const last = ms[0];
    const own = last.blocked && !last.cleared ? "needs_anthony" : running.has(key) ? "in_progress" : "done";
    const action = claudeAction.has(key) && own !== "needs_anthony" ? claudeAction.get(key) : own;
    if (action === "done" && Date.now() - Date.parse(last.at) > DAY) continue;
    const onWindows = ms.some((m) => m.machine === "windows");
    const begun = ms.find((m) => m.mac_kind === "job_started") || ms[ms.length - 1];
    mac.push({
      id: `mac:${key}`, key, label: key, title: plain(last.text), action, since: action === "in_progress" ? begun.at : last.at,
      kindLabel: onWindows ? "Windows job" : key.startsWith("WO #") ? "MAC work order" : "MAC job",
      sub: `${onWindows ? "on Windows · " : ""}${relTime(last.at)}`, ref: { type: "comms", key },
    });
  }
  // MAC issued the work orders, so every live one sits on its station too, even when its messages are old.
  const onMac = new Set(mac.map((n) => n.key));
  for (const e of snap.inbox) {
    const key = orderKey(e);
    if (e.action === "done" || onMac.has(key) || !(e.wo !== null || e.from === "MAC")) continue;
    mac.push({
      id: `mac:${key}`, key, label: e.wo !== null ? key : clipText(plain(e.title), 22), title: plain(e.title), action: e.action,
      kindLabel: "MAC work order", sub: plain(e.action_note || ""), ref: { type: "order", id: e.id },
    });
  }
  openDecisions().forEach((d) => {
    const text = plain(d);
    mac.push({
      id: `decision:${text.slice(0, 60)}`, key: null, label: "Approval", title: text, action: "needs_anthony",
      kindLabel: "Waiting on Anthony", sub: clipText(text, 40), ref: { type: "decision", text: d },
    });
  });
  // Codex picture jobs sit on the station of the machine they run on.
  const windows = [];
  for (const c of (snap.codex && snap.codex.running) || []) {
    (c.machine === "WINDOWS" ? windows : mac).push({
      id: `codex:${c.job}`, key: `codex:${c.job}`, codex: true, label: `CODEX ${c.job.split("-")[0]}`, title: c.job,
      action: "in_progress", kindLabel: `Codex picture job · ${c.machine}`, sub: `started ${relTime(c.started_at)}`, since: c.started_at,
      ref: { type: "codex", job: c.job },
    });
  }
  windows.push(...windowsNodes(byKey));
  return { claude, mac, windows };
}

// Windows' Death Star: its jobs (running and queued from windows-status.json, finished in the last day) and
// every job MAC talks to on Windows. A job MAC sent keeps its twin on MAC's station, so the bolt has both ends.
function windowsNodes(byKey) {
  const out = [], seen = new Set();
  const add = (key, node) => { if (!key || seen.has(key)) return; seen.add(key); out.push({ id: `win:${key}`, key, label: key, ...node }); };
  for (const r of snap.remote_jobs || []) {
    if (r.machine !== "WINDOWS") continue;
    const ended = r.lifecycle === "done" || r.lifecycle === "resolved";
    const when = r.last_at || r.started_at;
    if (ended && !(when && Date.now() - Date.parse(when) < DAY)) continue;
    add(r.id, {
      since: r.state_since || when,
      title: plain(r.last_text && !r.last_text.startsWith("{") ? r.last_text : r.id), kindLabel: "Windows job",
      action: ended ? "done" : r.lifecycle === "blocked" ? "needs_anthony" : r.lifecycle === "running" ? "in_progress" : "queued",
      sub: ended ? `finished · ${plain(r.lifecycle_why || "")}` : `${r.lifecycle} · ${relTime(r.state_since || when)}`,
      ref: { type: "comms", key: r.id },
    });
  }
  for (const j of (snap.windows_box && snap.windows_box.jobs) || []) {
    if (j.name.startsWith("codex ")) continue; // shown as its Codex node
    add(j.name, {
      title: j.name, kindLabel: "Windows job", action: j.state === "RUNNING" ? "in_progress" : "queued",
      sub: j.state.toLowerCase(), ref: { type: "comms", key: j.name },
    });
  }
  for (const [key, ms] of byKey) {
    if (!ms.some((m) => m.machine === "windows") || ms[0].direction === "codex") continue;
    const last = ms[0];
    if (Date.now() - Date.parse(last.at) > DAY) continue;
    add(key, {
      title: plain(last.text), kindLabel: "Windows job", sub: relTime(last.at), ref: { type: "comms", key },
      action: last.blocked && !last.cleared ? "needs_anthony" : "done",
    });
  }
  return out;
}

function closeNodePopup() {
  const old = document.getElementById("ds-term");
  if (old) old.remove();
  ui.openNode = null;
  if (brains) brains.select(null);
}

const logLine = (tag, ...text) => el("div", { class: "ds-ln" }, el("span", { class: `ds-tg ${tag}` }, tag), ...text);

// What the popup shows for each kind of node: status, the last log line, the report, and the actions.
function nodeView(node) {
  const r = node.ref;
  if (r.type === "job") {
    const j = findJob(r.kind, r.id);
    if (!j) return null;
    const lines = [logLine("ST", `${STATE_LABELS[j.state] || j.state}${j.action_who ? ` · ${j.action_who}` : ""}${j.action_at ? ` · log moved ${relTime(j.action_at)}` : ""}`)];
    const acts = j.activity || [];
    const lastAct = acts[acts.length - 1];
    if (lastAct) lines.push(logLine("LOG", lastAct.kind === "tool" ? `${lastAct.name}: ${lastAct.summary || ""}` : lastAct.text || ""));
    else if (j.note || j.result_preview) lines.push(logLine("LOG", clipText(plain(j.note || j.result_preview), 220)));
    if (j.report_headline) lines.push(logLine("RPT", md(j.report_headline)));
    if (j.followed_up_by) lines.push(logLine("FIX", `${j.state === "cleared" ? "Cleared by MAC" : "MAC is handling it"} · ${clipText(plain(j.followed_up_by), 160)}`));
    if (j.action_note && j.action !== "in_progress") lines.push(logLine("WHY", md(j.action_note)));
    return {
      src: j.kind === "folder" ? `~/.vader-mac-runs/${j.id}/` : `~/.vader-mac-runs/msg${j.id}.txt`, lines,
      fix: j.alertable ? ask(() => window.askDrafts.draftForJob(findJob(r.kind, r.id) || j)) : null,
      more: ["Full details ▸", () => openDetail(r.kind, r.id, j.title)],
    };
  }
  if (r.type === "order") {
    const e = findOrder(r.id);
    if (!e) return null;
    const lines = [logLine("ST", STATE_LABELS[e.state] || e.state)];
    if (e.status_text) lines.push(logLine("LOG", md(e.status_text)));
    if (e.action_note) lines.push(logLine(e.action === "queued" ? "WAIT" : "WHY", md(e.action_note)));
    const last = e.replies[e.replies.length - 1];
    if (last) lines.push(logLine("RPT", `${last.direction === "to_mac" ? "Claude → MAC" : "MAC → Claude"}: `, md(clipText(last.text, 220))));
    return {
      src: `VADER docs/CLAUDE INBOX.md · line ${e.line}`, lines,
      fix: e.alertable ? ask(() => window.askDrafts.draftForOrder(findOrder(r.id) || e)) : null,
      more: ["Show in list ▸", () => { closeNodePopup(); revealOrder(r.id); }],
    };
  }
  if (r.type === "comms") {
    const ms = (snap.messages || []).filter((m) => messageKey(m) === r.key);
    if (!ms.length) return node.id.startsWith("win:") ? windowsView(node) : null;
    const lines = ms.slice(0, 5).map((m) => logLine("LOG", `${clock(m.at)} ${m.direction === "to_claude" ? "MAC → Claude" : "Claude → MAC"}${m.machine ? ` (${m.machine})` : ""}: `, md(clipText(m.text, 200))));
    return {
      src: "~/.vader-mac-runs/brain/comms.jsonl", lines,
      fix: node.action === "needs_anthony" ? ask(() => window.askDrafts.draftForCommsJob(r.key, ms)) : null,
      more: ["Show in comms ▸", () => { closeNodePopup(); document.getElementById("messages").scrollIntoView({ behavior: "smooth", block: "center" }); }],
    };
  }
  if (r.type === "decision") {
    return {
      src: "MAC's STATUS.md · Open decisions awaiting Anthony", lines: [logLine("ASK", md(r.text))],
      fix: ask(() => window.askDrafts.draftForDecision(r.text), "Copy my decision"),
      more: ["Show in list ▸", () => { closeNodePopup(); document.getElementById("decisions-panel").scrollIntoView({ behavior: "smooth", block: "start" }); }],
    };
  }
  return null;
}

// A Windows job MAC never messaged about: what windows-status.json and the heartbeat say about it.
function windowsView(node) {
  const key = node.ref.key, beat = snap.windows || {}, box = snap.windows_box || {};
  const queued = (box.jobs || []).find((j) => j.name === key);
  const remote = (snap.remote_jobs || []).find((j) => j.id === key);
  const done = (beat.recent || []).find((j) => j.job === key);
  const lines = [logLine("ST", queued ? queued.state : remote ? remote.lifecycle || remote.state : done ? "finished" : "seen on Windows")];
  if (beat.job === key && beat.last_log_line) lines.push(logLine("LOG", `${beat.at ? `${clock(beat.at)} ` : ""}${plain(beat.last_log_line)}`));
  else if (remote && remote.last_text) lines.push(logLine("LOG", plain(remote.last_text)));
  if (done) lines.push(logLine("RPT", `${clock(done.finished_at)} `, md(clipText(done.first_line || "", 220))));
  return {
    src: "~/.vader-mac-runs/brain/windows-status.json", lines, fix: null,
    more: ["Show on the timeline ▸", () => { closeNodePopup(); document.getElementById("running-panel").scrollIntoView({ behavior: "smooth", block: "start" }); }],
  };
}

// Anything waiting on Anthony links to VADER, where he acts on it. VADER can't open a given page from a link
// yet (it reopens the last page), so the button says which tab to go to.
const VADER_URL = "http://localhost:8765/";
function vaderWhere(text) {
  if (/\b(review|judge|watch|re-?render|final|teaser|short|video)\b/i.test(text)) return "Produce → Review";
  if (/\b(danger_guard|protected|--review|approv)/i.test(text)) return "System · protected changes";
  if (/\btopic/i.test(text)) return "Topics";
  return "Home · Needs you";
}
function vaderLink(text) {
  return el("a", { class: "ds-more ds-vader", href: VADER_URL, target: "vader", rel: "noopener" }, `Open VADER ↗ · ${vaderWhere(text)}`);
}

// VADER's node terminal: a small macOS-style window next to the node. Only NEEDS ANTHONY gets a fix request.
function openNodePopup(node, refresh) {
  const stage = document.querySelector(".brains-stage");
  const old = document.getElementById("ds-term");
  const view = node && nodeView(node);
  if (!view) { if (!refresh || old) closeNodePopup(); return; }
  const live = node.action === "in_progress";
  const close = el("button", { type: "button", class: "ds-tl r", "aria-label": "Close", onclick: closeNodePopup });
  const win = el("div", {
    class: `ds-term${node.action === "needs_anthony" ? " you" : ""}`, id: "ds-term", role: "dialog", "aria-label": `${node.kindLabel}: ${node.title}`,
  },
    el("div", { class: "ds-tbar" },
      el("span", { class: "ds-tls" }, close, el("i", { class: "ds-tl y" }), el("i", { class: "ds-tl g" })),
      el("span", { class: "ds-ttl" }, el("b", {}, node.label), ` — ${node.kindLabel}`),
      live ? el("em", { class: "ds-live" }, "● LIVE") : null,
    ),
    el("div", { class: "ds-thead" },
      el("div", { class: "ds-tl1" }, el("span", { class: `act act-${node.action}` }, ACTION_LABEL[node.action] || node.action), el("span", { class: "ds-tsum" }, node.title)),
      el("div", { class: "ds-tl2" }, el("code", {}, view.src)),
    ),
    el("div", { class: "ds-stream" }, ...view.lines),
    el("div", { class: "ds-acts" },
      view.fix,
      node.action === "needs_anthony" ? vaderLink(`${node.title || ""} ${view.lines.map((l) => l.textContent).join(" ")}`) : null,
      view.more ? el("button", { type: "button", class: "ds-more", onclick: view.more[1] }, view.more[0]) : null,
    ),
    el("div", { class: "ds-foot" }, el("span", {}, "SRC · read-only"), el("span", {}, node.id.split(":")[0].toUpperCase())),
  );
  if (old) old.replaceWith(win); else stage.append(win);
  ui.openNode = node.id;
  brains.select(node.id);
  // Park it beside the node, on the side away from the other station, inside the stage.
  if (!refresh || !old) {
    const p = brains.nodePoint(node.id) || { x: stage.clientWidth / 2, y: 60, station: "claude" };
    const w = win.offsetWidth, h = win.offsetHeight, W = stage.clientWidth, H = stage.clientHeight;
    let x = p.station === "claude" ? p.x + 28 : p.x - 28 - w;
    if (x + w > W - 8 || x < 8) x = Math.max(8, Math.min(W - w - 8, p.x - w / 2));
    win.style.left = `${x}px`;
    win.style.top = `${Math.max(8, Math.min(H - h - 8, p.y - 40))}px`;
  } else {
    win.style.left = old.style.left;
    win.style.top = old.style.top;
  }
}

document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && ui.openNode) closeNodePopup(); });

function startDemo() {
  // ?demo shows the look with made-up bolts and sparks. They only ever fire from jobs that are really in
  // progress right now, and nothing fires when none are, so it never shows activity that couldn't happen.
  // Everything else on the page stays live.
  document.body.classList.add("demo-mode");
  document.title = "SAMPLE MODE · Claude Brain";
  document.querySelector(".topbar").append(
    el("a", { class: "demo-flag", href: "/", title: "Leave sample mode" }, "SAMPLE MODE · NOT LIVE · exit"),
  );
  document.querySelector(".brains-stage").append(el("div", { class: "demo-banner", role: "note" },
    el("strong", {}, "SAMPLE MODE"),
    " The bolts and sparks on the Death Stars are made up to show the look. The rest of the page is live. ",
    el("a", { href: "/" }, "Exit sample mode"),
  ));
  const inProgress = () => {
    const out = [];
    for (const st of Object.values(brains.stations)) {
      for (const n of st.nodes) if (n.key && n.action === "in_progress") out.push({ station: st.key, key: n.key });
    }
    return out;
  };
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  let i = 0;
  const shot = (key, direction, text, machine) => brains.fire({ id: `demo-${i++}`, direction, machine, kind: direction === "to_claude" ? "job_sent" : "report", text, ref: { source: "comms", job: key, wo: null } });
  let turn = 0;
  const volley = () => {
    const live = inProgress();
    if (!live.length) return; // nothing in progress: nothing fires
    // take turns across the stations that have work in progress, so every link gets sample bolts
    const stations = [...new Set(live.map((n) => n.station))];
    const here = stations[turn++ % stations.length];
    const { station, key } = pick(live.filter((n) => n.station === here));
    // the volley starts from the station where the job is in progress, then the reply comes back
    const out = station === "mac" ? "to_claude" : "to_mac", back = out === "to_claude" ? "to_mac" : "to_claude";
    const machine = station === "windows" ? "windows" : "mac";
    shot(key, out, `Sample (not real): message on ${key}`, machine);
    setTimeout(() => shot(key, back, `Sample (not real): reply on ${key}`, machine), 650);
    setTimeout(() => shot(key, out, `Sample (not real): answer on ${key}`, machine), 1300);
  };
  setTimeout(volley, 1500);
  setInterval(volley, 3200);
  // sample sparks, as if an in-progress job were making tool calls
  setInterval(() => {
    const live = inProgress();
    if (live.length) { const { station, key } = pick(live); brains.spark(station, key); }
  }, 650);
}

// One green or red line: STATUS.md readable, Windows heartbeat fresh, no stale locks, no placeholders.
function renderSelfcheck() {
  const sc = snap.selfcheck;
  const box = document.getElementById("selfcheck");
  if (!sc) { box.hidden = true; return; }
  box.hidden = false;
  box.className = `selfcheck ${sc.ok ? "ok" : "bad"}`;
  box.title = sc.checks.map((c) => `${c.ok ? "✔" : "✖"} ${c.name}: ${c.detail}`).join("\n");
  box.replaceChildren(el("b", {}, sc.ok ? "✔ SELF-CHECK" : "✖ SELF-CHECK"), " ", sc.line);
  const mine = document.getElementById("mine-toggle");
  mine.textContent = ui.mine ? "Showing only mine · show all" : `Only mine (${(snap.foundation && snap.foundation.mine) || 0})`;
  mine.setAttribute("aria-pressed", String(ui.mine));
}

// The audit trail: every alert, clear, decision and bug the Brain recorded (append-only).
function renderAudit() {
  const rows = (snap.audit || []).filter((a) => matches(a.job, a.change, a.event));
  document.getElementById("audit").replaceChildren(...(rows.length ? rows.map((a) => el("li", {},
    el("span", { class: "a-time" }, a.at ? clock(a.at) : "—"),
    el("span", { class: `a-ev a-${a.event}` }, a.event),
    el("span", { class: "a-job" }, a.job || "—"),
    el("span", { class: "a-change" }, clipText(a.change || "", 160)),
    el("span", { class: "a-who" }, a.who || ""),
  )) : [el("li", { class: "empty" }, "Nothing recorded yet.")]));
}

// The WINDOWS box between the Death Stars: a short terminal list from windows-status.json.
// Under each Death Star: cards for what is running or needs Anthony (status, name, a bar for how long it
// has been in that state), the waiting queue as dots, then one summary line. Everything opens its job.
const BOX_CARDS = 3;
const QUEUE_DOTS = 12;
const BAR_FULL_MIN = 90; // a full bar is 90 minutes

function openStationNode(id) {
  const node = brains && brains.findNode(id);
  if (!node) return;
  document.querySelector(".hero").scrollIntoView({ behavior: "smooth", block: "start" });
  openNodePopup(node);
}

function minutesSince(iso) {
  const t = Date.parse(iso || "");
  return Number.isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / 60000));
}
const fmtMin = (m) => (m === null ? "" : m < 60 ? `${m} m` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} m`);

function stationCard(n) {
  const needs = n.action === "needs_anthony";
  const min = minutesSince(n.since);
  const bar = el("span", { class: "jc-bar", "aria-hidden": "true" }, el("span", { class: "jc-fill" }));
  bar.firstChild.style.setProperty("width", `${Math.round(100 * Math.min(1, (min || 0) / BAR_FULL_MIN))}%`);
  const time = min === null ? "" : needs ? `waiting ${fmtMin(min)}` : fmtMin(min);
  return el("button", {
    type: "button", class: `jc ${needs ? "jc-needs" : "jc-run"}`, title: `${n.label} · ${n.title || ""}`,
    "aria-label": `${n.label}: ${needs ? "needs you" : "running"}${time ? `, ${time}` : ""}. Open it.`,
    onclick: () => openStationNode(n.id),
  },
  el("span", { class: "jc-top" }, el("span", { class: `jc-pill ${needs ? "needs" : "run"}` }, needs ? "NEEDS YOU" : "RUNNING"),
    el("span", { class: "jc-name" }, n.label)),
  el("span", { class: "jc-bottom" }, bar, el("span", { class: "jc-time" }, time)));
}

function queueRow(nodes, word) {
  if (!nodes.length) return el("div", { class: "jq jq-empty" }, `nothing ${word}`);
  const dots = nodes.slice(0, QUEUE_DOTS).map((n) => el("button", {
    type: "button", class: "jq-dot", title: `${n.label} · ${word}${n.title && n.title !== n.label ? ` · ${n.title}` : ""}`,
    "aria-label": `${n.label}, ${word}. Open it.`, onclick: () => openStationNode(n.id),
  }));
  const more = nodes.length > QUEUE_DOTS ? el("span", { class: "jq-more" }, `+${nodes.length - QUEUE_DOTS}`) : null;
  return el("div", { class: "jq" }, el("span", { class: "jq-k" }, `${nodes.length} ${word}`), el("span", { class: "jq-dots" }, dots, more));
}

function stationBox(id, name, nodes, queueWord, footer, extra) {
  const seen = new Set();
  const live = nodes.filter((n) => {
    if (seen.has(n.label) || !["needs_anthony", "in_progress", "queued"].includes(n.action)) return false;
    seen.add(n.label);
    return true;
  });
  const hot = live.filter((n) => n.action !== "queued").sort((a, b) => (a.action === "needs_anthony" ? -1 : 0) - (b.action === "needs_anthony" ? -1 : 0));
  const queued = live.filter((n) => n.action === "queued");
  const running = hot.filter((n) => n.action === "in_progress").length, needs = hot.length - running;
  const head = [running && `${running} running`, needs && `${needs} need${needs === 1 ? "s" : ""} you`].filter(Boolean).join(" · ") || "idle";
  const cards = hot.slice(0, BOX_CARDS).map((n) => stationCard(n));
  const moreHot = hot.length > BOX_CARDS
    ? el("button", { type: "button", class: "jc-more", onclick: () => document.getElementById("running-panel").scrollIntoView({ behavior: "smooth" }) }, `+${hot.length - BOX_CARDS} more running · see the timeline`)
    : null;
  document.getElementById(id).replaceChildren(...[
    el("div", { class: "wb-head" }, el("b", {}, name), ` · ${head}`),
    ...(cards.length ? cards : [el("div", { class: "jq jq-empty" }, "nothing running")]), moreHot,
    queueRow(queued, queueWord), footer, ...(extra || []),
  ].filter(Boolean));
}

function renderStationBoxes() {
  const nodes = stationNodes();
  const done24 = allJobs().filter((j) => j.action === "done" && Date.now() - Date.parse(j.updated_at) < DAY).length;
  const blocked = nodes.claude.filter((n) => n.action === "needs_anthony").length;
  stationBox("claude-box", "CLAUDE", nodes.claude, "queued", el("div", { class: "wb-acc sb-sum" }, `TODAY: ${done24} done · ${blocked} waiting on you`));
  const orders = snap.inbox.filter((e) => e.action !== "done");
  stationBox("mac-box", "GROK BOT · MAC", nodes.mac, "queued",
    el("div", { class: "wb-acc sb-sum" }, `WORK ORDERS: ${orders.length} open · ${orders.filter((e) => e.action === "needs_anthony").length} waiting on you`));
  renderWinBox(nodes.windows);
}

function renderWinBox(nodes) {
  const w = snap.windows_box || {};
  const box = document.getElementById("win-box");
  const when = w.updated_at ? new Date(w.updated_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "never";
  const acc = w.accepting || {};
  const accepting = el("div", { class: `wb-acc ${acc.known ? (acc.yes ? "yes" : "no") : "unknown"}` },
    "ACCEPTING JOBS: ", acc.known ? (acc.yes ? "yes" : `no${acc.reason ? ` — ${acc.reason}` : ""}`) : "unknown (not in windows-status.json yet)");
  // The rules fold away so the box stays short; one click opens them.
  const wasOpen = !!box.querySelector("details[open]");
  const rules = (w.rules || []).length
    ? el("details", { class: "wb-rules-fold", open: wasOpen }, el("summary", {}, `rules (${w.rules.length})`),
      el("ul", { class: "wb-rules" }, w.rules.map((r) => el("li", {}, r))))
    : null;
  box.className = `win-box${w.offline ? " is-offline" : ""}`;
  if (w.offline) {
    box.replaceChildren(el("div", { class: "wb-head" }, el("b", {}, "WINDOWS"), ` · last update ${when}`),
      el("div", { class: "wb-line wb-offline" }, "offline", el("span", { class: "wb-why" }, ` · ${w.reason}`)), accepting, rules || "");
  } else {
    stationBox("win-box", "WINDOWS", nodes || [], "ready", accepting, rules ? [rules] : []);
    box.querySelector(".wb-head").append(` · ${when}`);
  }
  placeWinBox();
}

// Each box sits under its Death Star (wide screens; brains.js places them as it lays out); below the canvas
// when the stations stack.
function placeWinBox() {
  if (brains) brains.layout();
}

// Anything waiting on Anthony for 30+ minutes, at the top of the page.
function renderOverdue() {
  const list = ((snap.ops || {}).overdue || []);
  const box = document.getElementById("overdue");
  box.hidden = !list.length;
  box.replaceChildren(el("b", {}, "WAITING ON YOU"), ...list.slice(0, 4).map((o) =>
    el("span", { class: "od" }, ` ${o.id}${o.title ? ` · ${clipText(o.title, 60)}` : ""} · ${o.minutes >= 60 ? `${Math.floor(o.minutes / 60)} h ${o.minutes % 60} m` : `${o.minutes} m`}`)));
}

// Operations: usage, loops, restart storms, conflicts, branch hygiene and decision IDs (shown only).
function renderOps() {
  const o = snap.ops || {};
  const rows = [];
  const row = (label, tone, ...content) => rows.push(el("li", { class: `op op-${tone}` }, el("span", { class: "op-k" }, label), el("span", { class: "op-v" }, ...content)));
  const usage = o.usage || {};
  row("usage", usage.found ? "ok" : "dim", usage.found
    ? Object.entries(usage.machines).map(([m, u]) => `${m} ${u.left_pct === null ? "?" : `${u.left_pct}% left`}`).join(" · ") || "no machines reported"
    : usage.note);
  row("restart storms", (o.storms || []).length ? "bad" : "ok", (o.storms || []).length ? o.storms.map((x) => `${x.id}: ${x.why}`).join(" · ") : "none in the last hour");
  row("possible loops", (o.loops || []).length ? "warn" : "ok", (o.loops || []).length ? o.loops.map((x) => `${x.id}: ${x.why}`).join(" · ") : "none");
  row("mac ⇄ windows", (o.conflicts || []).length ? "warn" : "ok", (o.conflicts || []).length ? o.conflicts.map((x) => x.why).join(" · ") : "no shared branch or file");
  row("decision IDs", (o.no_decision_id || []).length ? "warn" : "ok", (o.no_decision_id || []).length ? `briefs with no A-xxx: ${o.no_decision_id.join(", ")}` : "every live brief cites one");
  const h = o.hygiene || { merged: [], stale: [], stale_total: 0 };
  row("merged branches", h.merged.length ? "info" : "ok", h.merged.length ? `${h.merged.length} could be cleaned up: ${h.merged.slice(0, 8).join(", ")}${h.merged.length > 8 ? " …" : ""}` : "none");
  row("work 24 h+ uncommitted", h.stale_total ? "warn" : "ok", h.stale_total
    ? `${h.stale_total} files: ${h.stale.slice(0, 5).map((x) => `${x.where} ${x.file} (${x.days} d)`).join(", ")}` : "none");
  document.getElementById("ops").replaceChildren(...rows);
}

// Flow on both machines, and the advisor's recommendations for MAC (it recommends, never acts).
function renderFlow() {
  const f = snap.flow || { machines: {}, findings: [] };
  const m = (x) => (x === null || x === undefined ? "—" : x);
  const mac = f.machines.MAC || {}, win = f.machines.WINDOWS || {};
  const row = (label, ...vals) => el("tr", {}, el("th", { scope: "row" }, label), ...vals.map((v) => el("td", {}, String(v))));
  const table = el("table", { class: "flow-table" },
    el("thead", {}, el("tr", {}, el("th", {}, ""), el("th", { scope: "col" }, "MAC"), el("th", { scope: "col" }, "WINDOWS"))),
    el("tbody", {},
      row("running", m(mac.running), win.known ? m(win.running) : "?"),
      row("queue", m(mac.queue), win.known ? m(win.queue) : "?"),
      row("idle", mac.idle_min ? `${mac.idle_min} min` : mac.idle_min === 0 ? "busy" : "—", win.idle_min ? `${win.idle_min} min` : win.idle_min === 0 ? "busy" : "—"),
      row("avg job (24 h)", mac.avg_job_min ? `${mac.avg_job_min} min (${mac.jobs_24h})` : "—", "—"),
      row("wait on Anthony", `${m(mac.wait_on_anthony_min)} min`, "—"),
      row("cost per job", mac.cost_per_job ? `$${mac.cost_per_job}` : "—", "—"),
      row("free memory", mac.free_memory_pct !== null && mac.free_memory_pct !== undefined ? `${mac.free_memory_pct}%` : "—", "—"),
    ));
  const recs = (snap.recommendations || []);
  const recList = recs.length ? el("ol", { class: "recs" }, recs.slice(0, 8).map((r) => el("li", { class: `rec rec-${r.status}` },
    el("span", { class: "rec-id" }, r.id), el("span", { class: `rec-st st-${r.status}` }, r.status.toUpperCase()),
    el("span", { class: "rec-what" }, r.what), el("span", { class: "rec-opt" }, `→ ${r.option}`),
    r.result ? el("span", { class: "rec-res" }, `Did it help? ${r.result.verdict}`) : null,
  ))) : empty("No recommendations: nothing wasteful spotted.");
  document.getElementById("flow").replaceChildren(table, el("p", { class: "for-mac-h" }, "Recommendations for MAC · ~/.vader-mac-runs/brain/RECOMMENDATIONS.md"), recList);
}

// Self-learning: post-mortems, proposed lessons (drafts until Anthony or MAC approves) and weekly stats.
function renderLearning() {
  const l = snap.learning || { proposed: [], approved: [], weekly: {}, recent_postmortems: [] };
  const w = l.weekly || {};
  const stat = (k, v) => el("span", { class: "ls" }, el("b", {}, v === null || v === undefined ? "—" : String(v)), ` ${k}`);
  const stats = el("p", { class: "learn-stats" }, "This week: ", stat("alerts", w.alerts), " · ", stat("false", w.false_alerts),
    " · ", stat("duplicates", w.duplicates), " · ", stat("min median to clear", w.median_clear_min));
  const lessonRow = (x) => el("li", { class: `rec rec-${x.status}` },
    el("span", { class: "rec-id" }, x.id), el("span", { class: `rec-st st-${x.status === "approved" ? "applied" : x.status === "proposed" ? "open" : "declined"}` }, x.status.toUpperCase()),
    el("span", { class: "rec-what" }, x.title), el("span", { class: "rec-opt" }, `Draft: ${x.draft}`));
  const lessons = [...(l.proposed || []), ...(l.approved || [])];
  const lessonList = lessons.length ? el("ol", { class: "recs" }, lessons.slice(0, 8).map(lessonRow)) : empty("No lessons proposed: nothing has repeated yet.");
  const pms = (l.recent_postmortems || []);
  const pmList = pms.length ? el("ol", { class: "pms" }, pms.map((p) => el("li", {},
    el("span", { class: "a-job" }, p.job), el("span", { class: "pm-life" }, p.lifecycle),
    el("span", { class: "pm-text" }, `${clipText(p.happened || "", 120)} · slowed: ${p.slowed} · fixed: ${clipText(p.fixed || "", 80)}`)))) : empty("No post-mortems yet.");
  document.getElementById("learning").replaceChildren(stats,
    el("p", { class: "for-mac-h" }, "Proposed lessons · ~/.vader-mac-runs/brain/PROPOSED-LESSONS.md"), lessonList,
    el("p", { class: "for-mac-h" }, "Recent post-mortems · LEARNING-LOG.md"), pmList);
}

function renderAll() {
  if (!snap) return;
  if (window.renderHud) window.renderHud(snap);
  renderStatus();
  renderHero();
  renderTerminal();
  renderSelfcheck();
  renderOverdue();
  renderOps();
  renderFlow();
  renderLearning();
  renderAudit();
  renderStationBoxes();
  renderAttention();
  renderRunning();
  renderJobs();
  renderDecisions();
  renderOrders();
  renderLogs();
  updateLiveText();
}

// ---------- job detail ----------

// Raw text (run logs, errors) stays monospace. Reports, replies, orders and briefs are laid out as
// formatted text: readable.js splits the markdown into blocks, built here with el() and md().
function section(title, text) {
  return text ? [el("h3", {}, title), el("pre", {}, text)] : [];
}

function readableSection(title, text) {
  return text ? [el("h3", {}, title), readable(text)] : [];
}

function readable(text) {
  const block = (b) => {
    if (b.type === "h") return el(`h${Math.min(6, b.level + 3)}`, { class: `rd-h rd-h${Math.min(3, b.level)}` }, md(b.text));
    if (b.type === "p") return el("p", { class: "rd-p" }, md(b.text));
    if (b.type === "code") return el("pre", { class: "rd-code" }, b.text);
    if (b.type === "quote") return el("blockquote", { class: "rd-quote" }, md(b.text));
    if (b.type === "hr") return el("hr", { class: "rd-hr" });
    if (b.type === "table") {
      return el("div", { class: "rd-table" }, el("table", {},
        el("thead", {}, el("tr", {}, b.head.map((c) => el("th", {}, md(c))))),
        el("tbody", {}, b.rows.map((row) => el("tr", {}, row.map((c) => el("td", {}, md(c)))))),
      ));
    }
    return el(b.type, { class: "rd-list" }, b.items.map((it) => el("li", { class: `rd-d${Math.min(3, it.depth)}` }, md(it.text))));
  };
  return el("div", { class: "rd" }, window.Readable.parse(text).map(block));
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
        ...readableSection("MAC's order to Claude", d.prompt),
        ...readableSection("Claude's result", d.result || "(no result yet)"),
        ...section("Errors", d.errors && d.errors.trim()),
      );
    } else {
      const log = d.activity && d.activity.length
        ? [el("h3", {}, `Live activity (last ${d.activity.length})`), activityList(d.activity, 200)]
        : [];
      body.replaceChildren(
        ...readableSection("Report", d.report),
        ...readableSection("Final reply", d.last_result && d.last_result.text),
        ...log,
        ...readableSection("Brief from MAC", d.brief),
        ...section("Run log", d.runs_log),
      );
    }
    const job = findJob(kind, id);
    if (job) body.prepend(el("p", { class: "line" }, ask(() => window.askDrafts.draftForJob(findJob(kind, id) || job), "Copy a message to MAC about this job")));
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

async function load(url = "/api/snapshot") {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(res.statusText);
    snap = await res.json();
    trackChanges(snap);
    if (!demoMode) handleMessages(snap);
    renderAll();
    return true;
  } catch (err) {
    document.getElementById("live-text").textContent = `Can't load data: ${err.message}`;
    return false;
  }
}

// The Update button: the server re-reads every source right now, then the page redraws.
async function updateNow() {
  const btn = document.getElementById("update-btn");
  if (btn.getAttribute("aria-busy") === "true") return;
  btn.setAttribute("aria-busy", "true");
  btn.textContent = "⟳ Checking…";
  const ok = await load("/api/refresh");
  const stamp = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  btn.textContent = ok ? `✓ Checked ${stamp}` : "✖ Couldn't check";
  btn.removeAttribute("aria-busy");
  setTimeout(() => { btn.textContent = "⟳ Update"; }, 4000);
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
  document.getElementById("update-btn").addEventListener("click", updateNow);
  document.getElementById("mine-toggle").addEventListener("click", () => { ui.mine = !ui.mine; renderAll(); });
  window.addEventListener("resize", () => setTimeout(placeWinBox, 50));
  document.getElementById("detail-close").addEventListener("click", () => document.getElementById("detail").close());
  if (window.BrainsVisual) {
    const motion = window.BrainsVisual.motion;
    const toggle = document.getElementById("motion-toggle");
    toggle.textContent = motion.calm ? (motion.systemCalm && !motion.choice ? "Motion: Calm (Mac setting)" : "Motion: Calm") : "Motion: Full";
    if (motion.calm) {
      // Say why the stations are still: with Reduce Motion on, Safari and Chrome both ask for calm motion.
      document.querySelector(".brains-stage").append(el("p", { class: "calm-note" },
        motion.systemCalm && !motion.choice
          ? "Calm motion: this Mac's Reduce Motion setting is on, so messages show as a brief glow on both jobs instead of bolts. "
          : "Calm motion is on, so messages show as a brief glow on both jobs instead of bolts. ",
        el("button", { type: "button", onclick: () => window.BrainsVisual.setMotion("full") }, "Show bolts and sparks")));
    }
    toggle.setAttribute("aria-pressed", String(!motion.calm));
    toggle.title = motion.systemCalm
      ? "Your system has Reduce Motion on. Choose Full to see the live animation here anyway."
      : "Switch between full animation and calm, still brains.";
    toggle.addEventListener("click", () => window.BrainsVisual.setMotion(motion.calm ? "full" : "calm"));
    brains = new window.BrainsVisual(
      document.getElementById("brains-canvas"),
      document.getElementById("bolt-tip"),
      // Hovering a bolt lights its line in "Latest messages".
      (id) => {
        for (const node of document.querySelectorAll(".term-line")) {
          node.classList.toggle("lit", id !== null && node.getAttribute("data-id") === id);
        }
      },
    );
    brains.onNodeClick = (node) => (node ? openNodePopup(node) : closeNodePopup());
    brains.keyOf = messageKey;
    if (demoMode) startDemo();
  }
  connect();
  load();
  setInterval(tick, 20_000);
});
