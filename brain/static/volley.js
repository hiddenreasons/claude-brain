"use strict";

// Volley: which job a message is about, that job's colour, and which way its bolt flies.
// No page code here, so Node can test it (tests/js/volley.test.js). brains.js draws what this decides.
// Layout: Claude on the left, MAC in the middle, Windows on the right. A message from a job on the Windows
// machine (machine: "windows") flies between MAC and Windows; every other one between MAC and Claude.

(function (root) {
  // Clearly different colours, kept away from the stations' blue (#6fd7ff), orange (#ff9628) and purple (#a78bfa)
  // and from the alert red, so a job reads as itself on either station. No pinks: at node size they
  // read as the red NEEDS ANTHONY ring.
  const PALETTE = ["#fff07a", "#00e0a0", "#b6f04a", "#3fe58f", "#2f80ff", "#e8e8ff"];
  const BOLT_MS = 800; // one shot: 0.6 to 1 s
  const LAND_MS = 450; // glow on the receiving node
  const FLASH_MS = 1600; // reduced motion: both nodes glow, nothing moves (long enough to notice)
  const MAX_BOLTS = 3;
  const GAP_MS = 160; // a beat between shots so a burst reads as a volley

  function hash(text) {
    let h = 2166136261;
    for (const c of String(text)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return h >>> 0;
  }

  // Same name, same colour, on both stations.
  function jobColor(key) {
    return key ? PALETTE[hash(key) % PALETTE.length] : null;
  }

  const woKey = (n) => `WO #${String(n).padStart(3, "0")}`;

  // The key both stations use for a job: its id, or "WO #016" for a work order.
  // orderNumber(id) maps an inbox entry id to its WO number (or null).
  function jobKey(message, orderNumber) {
    const ref = (message && message.ref) || {};
    if (ref.source === "comms") {
      if (ref.job) return ref.job;
      if (ref.wo !== null && ref.wo !== undefined) return woKey(ref.wo);
      return null;
    }
    if (ref.source === "job") return ref.id || null;
    if (ref.source === "work_order") {
      const n = orderNumber ? orderNumber(ref.id) : null;
      return n !== null && n !== undefined ? woKey(n) : `wo:${ref.id}`;
    }
    return null;
  }

  // Which station sends and which receives, and which way the bolt flies on screen.
  function shot(message) {
    const toClaude = message.direction === "to_claude";
    const far = message.machine === "windows" ? "windows" : "claude";
    const from = toClaude ? "mac" : far, to = toClaude ? far : "mac";
    const x = { claude: 0, mac: 1, windows: 2 };
    return { from, to, dir: x[to] > x[from] ? "ltr" : "rtl" };
  }

  class Volley {
    constructor(options = {}) {
      this.calm = !!options.calm;
      this.max = options.max || MAX_BOLTS;
      this.gap = options.gap === undefined ? GAP_MS : options.gap;
      this.duration = options.duration || BOLT_MS;
      this.queue = [];
      this.active = [];
      this.flashes = [];
      this.landings = [];
      this.seen = new Set();
      this.lastStart = -Infinity;
    }

    // A message was logged. Each message fires once: a bolt (queued), or with reduced motion a flash.
    push(message, key, now) {
      if (!message || (message.id && this.seen.has(message.id))) return null;
      if (message.id) this.seen.add(message.id);
      const s = shot(message);
      const color = jobColor(key);
      if (this.calm) {
        const flash = { type: "flash", key, color, from: s.from, to: s.to, t0: now };
        this.flashes.push(flash);
        return flash;
      }
      const bolt = { type: "bolt", message, key, color, ...s, t0: null };
      this.queue.push(bolt);
      return bolt;
    }

    // Advance to `now`: finished bolts land, queued ones start while fewer than `max` are in flight.
    step(now) {
      const still = [];
      for (const b of this.active) {
        if (now - b.t0 >= this.duration) this.landings.push({ key: b.key, color: b.color, station: b.to, t0: now });
        else still.push(b);
      }
      this.active = still;
      while (this.queue.length && this.active.length < this.max && now - this.lastStart >= this.gap) {
        const b = this.queue.shift();
        b.t0 = now;
        this.lastStart = now;
        this.active.push(b);
      }
      this.landings = this.landings.filter((l) => now - l.t0 < LAND_MS);
      this.flashes = this.flashes.filter((f) => now - f.t0 < FLASH_MS);
      return this.active;
    }
  }

  const api = { PALETTE, BOLT_MS, LAND_MS, FLASH_MS, MAX_BOLTS, jobColor, jobKey, shot, woKey, Volley };
  root.Volley = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
