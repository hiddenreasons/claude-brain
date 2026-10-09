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

const ui = { query: "", openOrders: new Set(), doneOpen: { jobs: false, orders: false } };
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

// STATUS.md decisions: "~~Push/merge X~~ DONE 09:00 …" is settled; anything else still needs Anthony.
const SETTLED_RE = /^~~[\s\S]+?~~\s*(DONE|DECIDED|APPROVED|DROPPED|RESOLVED|MERGED|CANCELLED|CANCELED)\b/i;
function decisionState(text) {
  const m = SETTLED_RE.exec(text.trim());
  return m ? { settled: true, word: m[1].toUpperCase() } : { settled: false, word: "NEEDS YOU" };
}
const openDecisions = () => snap.status.decisions.filter((d) => !decisionState(d).settled);

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
  if (job.kind === "folder") {
    const lines = [];
    const resolved = job.state === "followed_up" || job.state === "cleared";
    if (resolved) {
      const where = String(job.followed_up_by || "").startsWith("STATUS.md") ? "MAC's change log"
        : String(job.followed_up_by || "").startsWith("MAC (comms") ? "MAC's message log" : job.followed_up_by;
      lines.push(el("p", { class: `resolution ${job.state}`, title: job.followed_up_by || "" },
        job.state === "cleared" ? "✔ Cleared by MAC" : "↻ MAC is handling it",
        ` · ${where}`, job.followed_up_at ? ` · ${relTime(job.followed_up_at)}` : ""));
    }
    if (job.report_headline) {
      const from = job.headline_source === "final reply" ? "Final reply: " : "";
      // Once resolved, the old report is history: one dim line.
      lines.push(el("p", { class: resolved ? "line was" : "line", title: resolved ? job.report_headline : null },
        resolved ? "was: " : from, md(job.report_headline)));
    }
    return lines;
  }
  if (job.note) return el("p", { class: "line" }, job.note);
  if (job.result_preview) return el("p", { class: "line muted" }, job.result_preview.slice(0, 260));
  return null;
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
  const jobs = allJobs().filter((j) => matches(j.title, j.id, j.report_headline, j.result_preview, j.prompt_preview));
  const groups = groupedList("jobs", jobs, jobCard, "jobs");
  const live = jobs.length - groups.done.length;
  document.getElementById("jobs-count").textContent = `${live} live · ${groups.done.length} done`;
  const total = snap.oneshot_total + snap.folders.length;
  document.getElementById("jobs-note").textContent =
    `${total} jobs on record; the newest ${snap.oneshots.length + snap.folders.length} are here.`;
}

function renderRunning() {
  const live = allJobs().filter((j) => j.state === "running" || j.state === "waiting");
  const elsewhere = (snap.comms && snap.comms.running) || [];
  document.getElementById("running-count").textContent = live.length + elsewhere.length || "";
  const box = document.getElementById("running");
  const elsewhereNote = elsewhere.length
    ? el("p", { class: "line" }, "Running off this Mac, per MAC's log: ", elsewhere.join(", "))
    : null;
  if (!live.length && elsewhere.length) {
    box.replaceChildren(elsewhereNote);
    return;
  }
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
  if (elsewhereNote) box.append(elsewhereNote);
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
    const older = [...allJobs(), ...snap.inbox].filter((i) => i.action === "needs_anthony").length;
    box.replaceChildren(empty(older
      ? `Nothing new in the last 3 days. ${older} older item${older === 1 ? "" : "s"} still marked ▲ NEEDS ANTHONY in the lists below.`
      : "Nothing stuck. No blocked work orders, failed gates, stalled or errored jobs in the last 3 days."));
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
  })));
}

function renderDecisions() {
  const items = snap.status.decisions.filter((d) => matches(d)).map((d) => ({ d, ...decisionState(d) }));
  items.sort((a, b) => Number(a.settled) - Number(b.settled));
  const open = items.filter((i) => !i.settled).length;
  document.getElementById("decisions-count").textContent = open ? String(open) : "";
  const list = document.getElementById("decisions");
  list.replaceChildren(...(items.length
    ? items.map((i) => el("li", { class: i.settled ? "decision settled" : "decision open", title: i.settled ? i.d : null },
      el("span", { class: `badge ${i.settled ? "fam-good" : "fam-open"}` }, i.word), " ",
      md(i.d),
      i.settled ? null : el("span", {}, " ", ask(() => window.askDrafts.draftForDecision(i.d), "Copy my decision"))))
    : [el("li", { class: "empty" }, "Nothing listed.")]));
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
  const entries = snap.inbox.filter((e) => matches(e.title, e.status_text, e.body, ...e.replies.map((r) => r.text)));
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
  // Oldest first, a beat apart, so a burst reads as separate messages.
  fresh.slice(0, MAX_BOLTS_PER_UPDATE).reverse().forEach((m, i) => setTimeout(() => brains && brains.fire(m), i * 350));
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
const TERM_LINES = 16;
const termSeen = new Set();
let termPrimed = false;

// comms.log: newest at the bottom, like tail -f. Lines that arrive while the page is open type themselves in.
function renderTerminal() {
  const timed = (snap.messages || []).filter((m) => m.at && matches(m.text, m.kind)).slice(0, TERM_LINES).reverse();
  const box = document.getElementById("messages");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  const lines = timed.map((m) => {
    const isNew = termPrimed && !termSeen.has(m.id);
    termSeen.add(m.id);
    const open = m.blocked && !m.cleared; // a blocked report MAC resolved since is history, not an alert
    const dirClass = open ? "blocked" : m.direction;
    const arrow = m.direction === "to_claude" ? "MAC ▸ CLAUDE" : "CLAUDE ▸ MAC";
    const kind = window.BrainsVisual ? window.BrainsVisual.kindLabel(m.kind) : m.kind;
    return el("li", {},
      el("button", {
        type: "button", class: `term-line${isNew ? " new" : ""}${m.cleared ? " cleared" : ""}`, "data-id": m.id,
        title: `${clock(m.at)} · ${arrow} · ${kind}${open ? " · BLOCKED" : m.cleared ? " · was BLOCKED, now cleared" : ""}\n${m.text}`,
        onclick: () => openMessage(m),
        onmouseenter: () => brains && brains.highlight(m.id),
        onmouseleave: () => brains && brains.highlight(null),
        onfocus: () => brains && brains.highlight(m.id),
        onblur: () => brains && brains.highlight(null),
      },
        el("span", { class: "term-time" }, clock(m.at)),
        el("span", { class: `term-dir ${dirClass}` }, open ? `${arrow} ✖` : m.cleared ? `${arrow} ✔` : arrow),
        el("span", { class: "term-txt" }, el("span", { class: "term-kind" }, `${kind.toLowerCase().replace(/ /g, "_")}:`), md(m.text)),
      )
    );
  });
  termPrimed = true;
  box.replaceChildren(
    ...(lines.length ? lines : [el("li", { class: "term-end" }, "no messages yet")]),
    el("li", { class: "term-end", "aria-hidden": "true" }, "listening"),
  );
  if (atBottom || !box.dataset.scrolled) {
    box.scrollTop = box.scrollHeight;
    box.dataset.scrolled = "1";
  }
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
  const runText = running.length
    ? running.map((j) => j.id).join(", ")
    : elsewhere.length ? `elsewhere: ${elsewhere.join(", ")}` : "nothing running";
  document.getElementById("statusbar").replaceChildren(
    statTile("running", running.length + elsewhere.length, runText, "var(--running)", "running-panel"),
    statTile("needs_you", openDecisions().length,
      `${openDecisions().length} open · ${snap.status.decisions.length - openDecisions().length} settled in MAC's STATUS.md`,
      openDecisions().length ? "var(--mac)" : "var(--done)", "decisions-panel"),
    statTile("stuck", stuck, stuck ? snap.attention[0].title : "nothing blocked or failing", stuck ? "var(--accent)" : "var(--done)", "attention-panel"),
    statTile("msgs_24h", day.length, `${toClaude} MAC→Claude · ${day.length - toClaude} Claude→MAC`, "var(--claude)", "messages"),
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
let pulsesPrimed = false;

function renderHero() {
  const running = snap.folders.filter((j) => j.state === "running");
  const job = running[0] || null;
  const lastAction = job && job.activity && job.activity.length ? job.activity[job.activity.length - 1] : null;
  const lastToClaude = (snap.messages || []).find((m) => m.at && m.direction === "to_claude");
  const macActive = lastToClaude && Date.now() - Date.parse(lastToClaude.at) < 30 * 60000;
  const open = snap.inbox.filter((e) => ["OPEN", "BLOCKED", "RUNNING"].includes(e.state)).length;
  document.getElementById("readout-claude").replaceChildren(
    readoutLine("claude.state", job ? "RUNNING" : "IDLE", job ? "hot" : ""),
    readoutLine("claude.job", job ? job.id : "—"),
    readoutLine("claude.doing", lastAction ? (lastAction.kind === "tool" ? `${lastAction.name} · ${lastAction.summary || ""}` : lastAction.text) : "—"),
    readoutLine("jobs.24h", String(allJobs().filter((j) => Date.now() - Date.parse(j.updated_at || 0) < 86400000).length)),
  );
  document.getElementById("readout-mac").replaceChildren(
    readoutLine("mac.state", macActive ? "SENDING" : "QUIET", macActive ? "hot" : ""),
    readoutLine("mac.last_sent", lastToClaude ? relTime(lastToClaude.at) : "—"),
    readoutLine("orders.open", String(open)),
    readoutLine("needs.anthony", String(openDecisions().length), openDecisions().length ? "bad" : "ok"),
  );

  if (!brains) return;
  // Orbiting labels: Claude's latest jobs, MAC's open orders. Colors are their real status.
  const jobColor = { running: "#ffd166", waiting: "#ffd166", done: "#ffb15c", followed_up: "#50c8ff", cleared: "#5bd38a" };
  brains.setOrbits({
    claude: allJobs().slice(0, 14).map((j) => ({ text: j.id, color: jobColor[j.state] || (/(blocked|error|stalled|gate|no_report)/.test(j.state) ? "#ff4d5e" : "#8d96a5") })),
    mac: snap.inbox.filter((e) => ["OPEN", "BLOCKED", "RUNNING"].includes(e.state)).slice(0, 14)
      .map((e) => ({ text: e.wo !== null ? `WO#${String(e.wo).padStart(3, "0")}` : (e.date || "note").slice(5), color: e.state === "BLOCKED" ? "#ff4d5e" : "#50c8ff" })),
  });
  // Packet flow between the brains: how busy the channel has been in the last hour.
  const hour = (snap.messages || []).filter((m) => m.at && Date.now() - Date.parse(m.at) < 3600000);
  brains.setTraffic({
    toClaude: hour.filter((m) => m.direction === "to_claude").length,
    toMac: hour.filter((m) => m.direction === "to_mac").length,
  });
  // Each new tool call in a running job pulses Claude's brain with its name.
  for (const j of running) {
    const actions = j.activity || [];
    const sig = actions.length ? JSON.stringify(actions[actions.length - 1]) + actions.length : "";
    const before = lastActionSig.get(j.id);
    lastActionSig.set(j.id, sig);
    if (!pulsesPrimed || before === undefined || before === sig) continue;
    const prevIndex = actions.findIndex((a) => JSON.stringify(a) + "" === before);
    const fresh = actions.slice(Math.max(prevIndex + 1, actions.length - 4));
    fresh.forEach((a, i) => setTimeout(() => brains.pulse(a.kind === "tool" ? a.name : "thinking"), i * 300));
  }
  pulsesPrimed = true;
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
  if (window.renderHud) window.renderHud(snap);
  renderStatus();
  renderHero();
  renderTerminal();
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
  document.getElementById("detail-close").addEventListener("click", () => document.getElementById("detail").close());
  if (window.BrainsVisual) {
    const motion = window.BrainsVisual.motion;
    const toggle = document.getElementById("motion-toggle");
    toggle.textContent = motion.calm ? "Motion: Calm" : "Motion: Full";
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
    if (demoMode) startDemo();
  }
  connect();
  load();
  setInterval(tick, 20_000);
});
