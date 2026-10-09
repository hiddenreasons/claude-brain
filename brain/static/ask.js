"use strict";

// "Copy a fix request": every issue on the page gets a button that drafts a message to the right AI.
// Anthony's rule (VADER CLAUDE.md, 2026-10-05): he talks only to MAC (Grok Bot), and MAC routes the work
// to Claude, Codex or VV2. So messages go to MAC with a suggested builder; problems with the Brain itself
// go to Claude. The draft is plain text built from the real data on the page; nothing is sent anywhere.
// Uses el(), snap and STATE_LABELS from app.js.

const RECIPIENTS = {
  mac: { name: "MAC (Grok Bot)", where: "Paste it into your chat with MAC (Grok Bot)." },
  claude: { name: "Claude (Claude Brain chat)", where: "Paste it into the Claude Code chat for the Claude Brain folder." },
};

function nowStamp() {
  return new Date().toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
const quote = (text, limit = 500) => {
  const t = clean(text);
  return t.length > limit ? `${t.slice(0, limit)}…` : t;
};

// Who should do the work, judged from what the issue is about.
function suggestedBuilder(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(codex|picture|pictures|image|images|thumbnail|png|mockup|visual bot)\b/.test(t)) return "Codex (Visual Bot), for the images";
  if (/\b(dashboard|ui|page|layout|css|restyle|look|orb|home|review page)\b/.test(t)) return "VV2 or Claude, for the dashboard UI";
  return "Claude, for the code";
}

// What to ask for depends on why it's stuck: some blocks wait on Anthony, not on a builder.
function nextStep(job) {
  // Resolved first: a cleared or followed-up job never asks for an approval, whatever its old report said.
  if (job.state === "cleared" || job.state === "followed_up") {
    return ["MAC already resolved this after the report. Nothing to approve: just confirm it's fully done."];
  }
  const said = `${job.report_headline || ""} ${job.note || ""}`.toLowerCase();
  if (/danger[_ ]?guard/.test(said)) {
    return [
      "This is held by VADER's danger guard, which waits on my review, not on a builder.",
      "Tell me exactly what I'm approving (files and why) and the command to run (python3 tools/danger_guard.py --review), or hold it if it shouldn't go in.",
    ];
  }
  if (/sandbox/.test(said)) {
    return [
      "Claude stopped at a sandbox limit. Tell me whether this needs a step run outside the sandbox, exactly what that step is, and whether it's safe; or change the brief so it isn't needed.",
    ];
  }
  return [
    "Please find the cause and fix it, or send it to the right builder.",
    `Suggested builder: ${suggestedBuilder(`${job.title} ${job.report_headline || ""}`)}.`,
  ];
}

function draftForJob(job) {
  const where = job.kind === "folder" ? `~/.vader-mac-runs/${job.id}/` : `~/.vader-mac-runs/msg${job.id}.txt and out${job.id}.json`;
  const state = (STATE_LABELS[job.state] || job.state).toUpperCase();
  const lines = [
    `MAC, an issue from Claude Brain (${nowStamp()}):`,
    "",
    `Job: ${job.id} (${job.kind === "folder" ? "job folder" : "one-shot"}): ${clean(job.title)}`,
    `State: ${state}`,
    `Files: ${where}`,
  ];
  if (job.report_headline) lines.push(`Claude's last word: "${quote(job.report_headline)}"`);
  if (job.note) lines.push(`Note: ${job.note}`);
  if (job.error_preview) lines.push(`Errors: "${quote(job.error_preview, 300)}"`);
  if (job.state === "stalled") lines.push(`Its live log stopped updating ${relTime(job.stream_updated_at) || "a while ago"} and the run never finished.`);
  if (job.state === "followed_up" || job.state === "cleared") lines.push(`You already acted after the report (${job.followed_up_by}, ${relTime(job.followed_up_at)}).`);
  const last = (job.activity || []).slice(-3).map((a) => (a.kind === "tool" ? `${a.name}: ${clean(a.summary)}` : `Claude: ${quote(a.text, 140)}`));
  if (last.length) lines.push(`Last actions: ${last.join(" | ")}`);
  lines.push("", ...nextStep(job));
  lines.push("Reply with DONE or BLOCKED, what changed, and the proof (commit, test run or file).");
  return { to: "mac", subject: `Job ${job.id}: ${state}`, body: lines.join("\n") };
}

function draftForOrder(entry) {
  const last = entry.replies.length ? entry.replies[entry.replies.length - 1] : null;
  const lines = [
    `MAC, about a work order (from Claude Brain, ${nowStamp()}):`,
    "",
    `${entry.wo !== null ? `WO #${String(entry.wo).padStart(3, "0")}: ` : ""}${clean(entry.title)}`,
    `State: ${entry.state}${entry.date ? ` (opened ${entry.date})` : ""}`,
    `Where: VADER docs/CLAUDE INBOX.md, line ${entry.line}`,
  ];
  if (entry.status_text) lines.push(`Status line: "${quote(entry.status_text, 300)}"`);
  if (last) lines.push(`Last reply (${last.direction === "to_mac" ? "Claude to MAC" : "MAC to Claude"}): "${quote(last.text)}"`);
  lines.push("");
  if (entry.state === "BLOCKED") {
    lines.push("Claude is blocked on this and waiting on you. Please unblock it (answer, fix or decision) or tell me what you need from me.");
  } else if (entry.state === "PARKED") {
    lines.push("This is parked. Should it stay parked? If it's time, please schedule it and tell me when it starts.");
  } else {
    lines.push("Where does this stand? Please give me its real status (planned, built, tested or verified) and the next step.");
  }
  lines.push(`Suggested builder: ${suggestedBuilder(entry.title)}.`, "Reply with the status and proof.");
  return { to: "mac", subject: `${entry.wo !== null ? `WO #${entry.wo}` : "Work order"}: ${entry.state}`, body: lines.join("\n") };
}

function draftForDecision(text) {
  return {
    to: "mac",
    subject: "My decision",
    body: [
      `MAC, my decision on an open item in STATUS.md ("Open decisions awaiting Anthony"), ${nowStamp()}:`,
      "",
      `Item: "${quote(text, 700)}"`,
      "",
      "My decision: ____________________",
      "",
      "Please apply it, update STATUS.md, and tell me when it's done.",
    ].join("\n"),
  };
}

function draftForIncident(issue) {
  const lines = [
    `MAC, about an incident in ISSUES-LOG.md (from Claude Brain, ${nowStamp()}):`,
    "",
    `${issue.date}${issue.job ? ` · ${issue.job}` : ""}: "${quote(issue.what, 600)}"`,
  ];
  if (issue.prevented) lines.push(`Mechanically prevented: ${issue.prevented}`);
  lines.push("", "Is this now prevented by a check, not just a rule? If not, what's the fix and when will it be in?");
  return { to: "mac", subject: `Incident: ${issue.job || issue.date}`, body: lines.join("\n") };
}

function draftForBrain(name, src) {
  return {
    to: "claude",
    subject: `Claude Brain: ${name} source`,
    body: [
      `Claude Brain can't read its "${name}" source (${src.path}).`,
      "",
      "Please check why it's missing, fix the Brain if it's a Brain problem, and tell me if the file moved.",
    ].join("\n"),
  };
}

// ---------- the dialog ----------

function openAsk(draft) {
  const dialog = document.getElementById("ask");
  const who = RECIPIENTS[draft.to];
  document.getElementById("ask-title").textContent = `Copy a message to ${who.name}`;
  document.getElementById("ask-where").textContent = `${who.where} You can edit it below first.`;
  const box = document.getElementById("ask-text");
  box.value = draft.body;
  const status = document.getElementById("ask-status");
  status.textContent = "";
  if (!dialog.open) dialog.showModal();
  box.focus();
  box.setSelectionRange(0, 0);
}

async function copyAsk() {
  const box = document.getElementById("ask-text");
  const status = document.getElementById("ask-status");
  try {
    await navigator.clipboard.writeText(box.value);
    status.textContent = "Copied. Paste it into the chat.";
  } catch (err) {
    box.focus();
    box.select(); // older copy route; if that fails too, the text stays selected for Cmd+C
    const copied = document.execCommand && document.execCommand("copy");
    status.textContent = copied ? "Copied. Paste it into the chat." : "Couldn't copy automatically. The text is selected: press Cmd+C.";
  }
}

// A small button that opens the draft for one issue. build() runs on click, so it uses the latest data.
function askButton(build, label = "Copy fix request") {
  return el("button", {
    type: "button", class: "ask-btn", title: "Draft a message about this to the right AI, ready to copy",
    onclick: (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      openAsk(build());
    },
  }, `⧉ ${label}`);
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("ask-copy").addEventListener("click", copyAsk);
  document.getElementById("ask-close").addEventListener("click", () => document.getElementById("ask").close());
});

window.askButton = askButton;
window.askDrafts = { draftForJob, draftForOrder, draftForDecision, draftForIncident, draftForBrain, suggestedBuilder };
