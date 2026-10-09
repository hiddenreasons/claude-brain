"use strict";

// Synapse sparks inside a Death Star: a short signal running along the grid from one job's node to the
// nearest other live node on the same station. They fire only on real events (a running job's tool call
// or log line, a message sent; a job that needs Anthony sends a red one every few seconds) and never with
// reduced motion. No page code here, so Node can test it (tests/js/synapse.test.js). brains.js draws them.

(function (root) {
  const SPARK_MS = 900;
  const MIN_REACH = 25; // degrees: a spark to a node right next door is too short to see
  const MAX_SPARKS = 4; // per station
  const RED_EVERY_MS = 6000; // a job that needs Anthony sparks red this often

  // Angular distance between two [lat, lon] points, in degrees.
  function arc(a, b) {
    const r = Math.PI / 180, [la1, lo1] = a.map((v) => v * r), [la2, lo2] = b.map((v) => v * r);
    const c = Math.sin(la1) * Math.sin(la2) + Math.cos(la1) * Math.cos(la2) * Math.cos(lo1 - lo2);
    return Math.acos(Math.max(-1, Math.min(1, c))) / r;
  }

  // Along the source's latitude to the target's longitude (the short way round), then along that
  // meridian to the target: the path follows the station's own grid lines, like VADER's links.
  function route(a, b, step = 4) {
    const dlo = ((b[1] - a[1] + 540) % 360) - 180;
    const n1 = Math.max(2, Math.ceil(Math.abs(dlo) / step)), n2 = Math.max(2, Math.ceil(Math.abs(b[0] - a[0]) / step));
    const pts = [];
    for (let i = 0; i <= n1; i++) pts.push([a[0], a[1] + (dlo * i) / n1]);
    const lon = a[1] + dlo; // b's meridian, kept continuous with the first leg (190° rather than -170°)
    for (let i = 1; i <= n2; i++) pts.push([a[0] + ((b[0] - a[0]) * i) / n2, lon]);
    return pts;
  }

  // The nearest other live (not done) node at least MIN_REACH away, else simply the nearest one;
  // null when the job is alone on its station.
  function target(source, nodes) {
    let best = null, bd = Infinity, far = null, fd = Infinity;
    for (const n of nodes) {
      if (n === source || n.action === "done" || (n.key && n.key === source.key)) continue;
      const d = arc(source.ll, n.ll);
      if (d < bd) { bd = d; best = n; }
      if (d >= MIN_REACH && d < fd) { fd = d; far = n; }
    }
    return far || best;
  }

  class Sparks {
    constructor(options = {}) {
      this.calm = !!options.calm;
      this.max = options.max || MAX_SPARKS;
      this.duration = options.duration || SPARK_MS;
      this.active = [];
      this.lastRed = new Map();
    }

    // One spark from `source` on `station` to its nearest live neighbour. Returns it, or null.
    fire(station, source, nodes, now, red = false) {
      if (this.calm || !source || !source.ll) return null;
      const to = target(source, nodes);
      if (!to) return null;
      if (this.active.filter((s) => s.station === station).length >= this.max) return null;
      const spark = { station, key: source.key || null, from: source.id, to: to.id, red, path: route(source.ll, to.ll), t0: now };
      this.active.push(spark);
      return spark;
    }

    // Jobs that need Anthony: one red spark each, every RED_EVERY_MS, staggered so they don't fire together.
    redPulse(station, nodes, now) {
      if (this.calm) return [];
      const fired = [];
      for (const n of nodes) {
        if (n.action !== "needs_anthony") continue;
        const last = this.lastRed.get(n.id);
        if (last !== undefined && now - last < RED_EVERY_MS) continue;
        this.lastRed.set(n.id, last === undefined ? now - Math.random() * RED_EVERY_MS : now);
        if (last === undefined) continue; // the first visit only sets the stagger
        const s = this.fire(station, n, nodes, now, true);
        if (s) fired.push(s);
      }
      return fired;
    }

    step(now) {
      this.active = this.active.filter((s) => now - s.t0 < this.duration);
      return this.active;
    }
  }

  const api = { SPARK_MS, MIN_REACH, MAX_SPARKS, RED_EVERY_MS, arc, route, target, Sparks };
  root.Synapse = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
