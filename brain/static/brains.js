"use strict";

// The main view: two Death Stars on one canvas, built like VADER's Issues-tab hologram
// (vader/web/v5/issues-brain.js, theme B), adapted here rather than imported.
// Left: Claude, in the Brain's orange. Right: Grok Bot / MAC, in the Brain's blue.
// Each station: lat/long grid, a double equatorial trench, a dish, a dotted halo, scanlines.
// Nodes are live items (setNodes); their marker shows the action label and their colour is the job's own
// colour (volley.js), the same on both stations. Each message fires one bolt from the sending job's node to
// its twin on the other station (fire); volley.js decides colour, direction and the queue. No libraries.

(function () {
  const KIND_LABELS = {
    work_order: "New work order",
    from_mac: "MAC reply",
    job_sent: "Job sent",
    to_mac: "Claude reply",
    report: "Report written",
    job_result: "Job result",
  };

  // Motion follows the system's Reduce Motion setting unless the viewer picked Full or Calm on the page.
  const MOTION_KEY = "claude-brain-motion";
  let motionChoice = null;
  try {
    motionChoice = localStorage.getItem(MOTION_KEY);
  } catch (e) {
    motionChoice = null; // storage can be blocked; fall back to the system setting
  }
  const systemCalm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const reduceMotion = motionChoice === "calm" || (motionChoice !== "full" && systemCalm);
  document.documentElement.classList.toggle("calm", reduceMotion);

  const DEG = Math.PI / 180;
  const PD = 5; // camera distance in sphere radii (mild perspective), as in VADER
  const LIMB = PD / Math.sqrt(PD * PD - 1);
  const SPIN = (2 * Math.PI) / 60000; // one turn a minute
  const LINK = [205, 240, 255]; // cyan-white
  const RED = [255, 40, 24];
  const UI_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif';
  const MONO = '"SF Mono", SFMono-Regular, ui-monospace, Menlo, monospace';

  const STARS = {
    claude: {
      name: "CLAUDE", wire: [255, 150, 40], node: [255, 230, 206], core: [255, 170, 90],
      label: "rgba(255,238,224,.96)", sub: "rgba(255,186,130,.9)", dir: 1, dish: [34, -50, 17],
    },
    mac: {
      name: "GROK BOT · MAC", wire: [110, 215, 255], node: [226, 246, 255], core: [150, 225, 255],
      label: "rgba(226,244,255,.96)", sub: "rgba(150,205,235,.9)", dir: 1, dish: [34, -50, 17],
    },
  };

  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const hexRgb = (h) => (h ? [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) : null);
  const easeOut = (u) => 1 - Math.pow(1 - u, 3);
  const V = window.Volley;
  const SY = window.Synapse;
  const sstep = (a, b, x) => { const u = Math.max(0, Math.min(1, (x - a) / (b - a))); return u * u * (3 - 2 * u); };

  // ---- 3D orientation (quaternion [w,x,y,z]); world: x right, y up, z toward the viewer ----
  const qMul = (a, b) => [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
  const qAx = (ax, ang) => { const s = Math.sin(ang / 2), l = Math.hypot(ax[0], ax[1], ax[2]) || 1; return [Math.cos(ang / 2), (ax[0] / l) * s, (ax[1] / l) * s, (ax[2] / l) * s]; };
  const qNorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]); return q.map((v) => v / l); };
  function qMat(q) {
    const [w, x, y, z] = q;
    return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
  }

  // Stable 0..1 numbers from a string, so a node keeps its place on the station between updates.
  function hashes(s) {
    let h = 2166136261;
    for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return () => {
      h = Math.imul(h ^ (h >>> 15), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
  }

  // Where a node sits: off the trench and off the dish.
  function placeNode(id, dish) {
    const r = hashes(id);
    let lat = (r() * 2 - 1) * 62;
    if (Math.abs(lat) < 8) lat += lat < 0 ? -9 : 9;
    let lon = r() * 360 - 180;
    const dLat = lat - dish[0], dLon = ((lon - dish[1] + 540) % 360) - 180;
    if (Math.hypot(dLat, dLon * Math.cos(lat * DEG)) < dish[2] + 6) lon += 42;
    return [lat, lon];
  }

  function haloDots(seed) {
    let s = seed;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const out = [];
    for (let i = 0; i < 420; i++) {
      const band = i % 3;
      out.push({ a: rnd() * Math.PI * 2, r: 1.12 + band * 0.045 + (rnd() - 0.5) * 0.022, s: 0.6 + rnd() * 0.55 });
    }
    return out;
  }

  class Station {
    constructor(key) {
      this.key = key;
      this.th = STARS[key];
      // Home view: dish upper side, seen slightly from above. Both stations turn in step, so a job and its
      // twin (same place on each) face the viewer together.
      this.q0 = qMul(qAx([1, 0, 0], 0.16), qAx([0, 1, 0], 0.35));
      this.q = this.q0.slice();
      this.mx = qMat(this.q);
      this.nodes = [];
      this.halo = haloDots(key === "claude" ? 7 : 13);
      this.cx = 0; this.cy = 0; this.R = 1;
      this.hold = false; // spin pauses while one of its nodes is open
      this.spinW = 1;
      this.drag = null;
    }

    project(lat, lon, scale = 1) {
      const M = this.mx, la = lat * DEG, lo = lon * DEG;
      const x = Math.cos(la) * Math.sin(lo) * scale, y = Math.sin(la) * scale, z = Math.cos(la) * Math.cos(lo) * scale;
      const X = M[0] * x + M[1] * y + M[2] * z, Y = M[3] * x + M[4] * y + M[5] * z, Z = M[6] * x + M[7] * y + M[8] * z;
      const s = PD / (PD - Z);
      return [this.cx + this.R * X * s, this.cy - this.R * Y * s, Z, s];
    }

    step(dt, calm) {
      const want = !calm && !this.hold && !this.drag ? 1 : 0;
      this.spinW += (want - this.spinW) * (1 - Math.exp(-dt / (want ? 900 : 180)));
      if (this.spinW > 1e-3) this.q = qNorm(qMul(this.q, qAx([0, 1, 0], SPIN * dt * this.spinW * this.th.dir)));
      this.mx = qMat(this.q);
    }

    rotateBy(dx, dy) {
      const k = 1 / this.R;
      this.q = qNorm(qMul(qMul(qAx([1, 0, 0], dy * k), qAx([0, 1, 0], dx * k)), this.q));
      this.mx = qMat(this.q);
    }
  }

  class BrainsVisual {
    constructor(canvas, tooltip, onHover) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.tooltip = tooltip;
      this.onHover = onHover || (() => {});
      this.onNodeClick = null;
      this.calm = reduceMotion;
      this.stations = { claude: new Station("claude"), mac: new Station("mac") };
      this.volley = new V.Volley({ calm: reduceMotion });
      this.sparks = new SY.Sparks({ calm: reduceMotion });
      this.keyOf = (m) => V.jobKey(m); // the page swaps in one that knows work-order numbers
      this.boltHeads = [];
      this.messages = new Map();
      this.lit = null;
      this.running = 0;
      this.traffic = { toClaude: 0, toMac: 0 };
      this.selected = null;
      this.toolPings = [];
      this.hover = null;
      this.w = 0; this.h = 0; this.dpr = 1;
      this.last = null;
      this.visible = true;
      this.resize();
      // Light on CPU: nothing is drawn while the stations are scrolled out of view.
      new IntersectionObserver((entries) => { this.visible = entries.some((e) => e.isIntersecting); }).observe(canvas);
      // The readout boxes (and the sample-mode banner) sit over the canvas: watch them too, so the stations
      // always start below them, however long their text gets.
      const watcher = new ResizeObserver(() => this.resize());
      watcher.observe(canvas);
      for (const box of canvas.parentElement.querySelectorAll(".hero-readout")) watcher.observe(box);
      new MutationObserver(() => {
        for (const box of canvas.parentElement.querySelectorAll(".demo-banner")) watcher.observe(box);
        this.resize();
      }).observe(canvas.parentElement, { childList: true });
      // A new screen density (window moved to another display) re-sizes the backing store, so lines stay sharp.
      const watchDpr = () => {
        const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        mq.addEventListener("change", () => { this.resize(); watchDpr(); }, { once: true });
      };
      watchDpr();
      this.bindPointer();
      requestAnimationFrame((t) => this.frame(t));
    }

    // ---------- page API (same calls the old brains took, plus nodes) ----------

    setNodes(groups) {
      for (const key of ["claude", "mac"]) {
        const st = this.stations[key];
        // A job sits at the same place on both stations, so twins are easy to spot.
        st.nodes = (groups[key] || []).map((n) => ({ ...n, ll: placeNode(n.key || n.id, st.th.dish), rgb: hexRgb(V.jobColor(n.key)) }));
      }
      if (this.selected && !this.findNode(this.selected)) this.selected = null;
    }

    setMessages(list) {
      for (const m of list || []) if (m.id) this.messages.set(m.id, m);
    }

    setTraffic(t) { this.traffic = t || { toClaude: 0, toMac: 0 }; }

    setRunning(n) { this.running = n || 0; }

    // A message was logged: one bolt from the sending job's node to its twin (queued, at most 3 in flight).
    // With reduced motion there is no bolt, only a short flash on both nodes.
    fire(message) {
      if (!message) return null;
      if (message.id) this.messages.set(message.id, message);
      const key = this.keyOf(message), shot = this.volley.push(message, key, performance.now());
      if (shot && shot.type === "bolt") this.spark(shot.from, key); // the sender's station sparks as it fires
      return shot;
    }

    // Synapse: something happened in a job (a tool call, a log line, a message sent). A short spark runs
    // along that station's grid from the job's node to its nearest live neighbour. Nothing with reduced motion.
    spark(stationKey, key, red = false) {
      const st = this.stations[stationKey];
      if (!st || !key) return null;
      const source = st.nodes.find((n) => n.key === key);
      return source ? this.sparks.fire(stationKey, source, st.nodes, performance.now(), red) : null;
    }

    // A tool call in a running Claude job: a small ping on Claude's station.
    pulse(name) {
      this.toolPings.push({ name: String(name || "").slice(0, 24), t0: performance.now() });
      if (this.toolPings.length > 4) this.toolPings.shift();
    }

    // Hovering a line in the comms feed lights the link and shows which way that message went.
    highlight(id) { this.lit = id; }

    select(nodeId) {
      this.selected = nodeId;
      for (const st of Object.values(this.stations)) st.hold = !!nodeId; // both pause, so they stay in step
    }

    // Screen position of a node right now (for placing its popup).
    nodePoint(nodeId) {
      for (const st of Object.values(this.stations)) {
        const n = st.nodes.find((x) => x.id === nodeId);
        if (n) { const p = st.project(n.ll[0], n.ll[1]); return { x: p[0], y: p[1], station: st.key }; }
      }
      return null;
    }

    findNode(id) {
      for (const st of Object.values(this.stations)) { const n = st.nodes.find((x) => x.id === id); if (n) return n; }
      return null;
    }

    // ---------- layout and loop ----------

    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = window.devicePixelRatio || 1;
      this.w = Math.max(1, r.width);
      this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      this.layout();
    }

    layout() {
      // MAC on the left, Claude on the right: MAC → Claude flies left to right.
      const { w, h } = this, a = this.stations.mac, b = this.stations.claude;
      if (w < 640) {
        // Phone width: MAC on top, Claude below.
        const R = Math.min(w * 0.26, h * 0.14);
        a.cx = w / 2; a.cy = h * 0.26; b.cx = w / 2; b.cy = h * 0.7;
        a.R = R; b.R = R;
        return;
      }
      // Keep clear of the readout boxes: the spin-axis label sits about 1.3 R above the centre, and the name
      // plates about 1.45 R + 48 px below it.
      const top = this.overlayBottom() + 14;
      const R = Math.max(40, Math.min(w * 0.12, (h - top - 56) / 2.75));
      const cy = top + R * 1.3;
      a.cx = w * 0.27; a.cy = cy; a.R = R;
      b.cx = w * 0.73; b.cy = cy; b.R = R;
    }

    // The lowest edge of anything drawn over the top of the canvas (readouts, sample banner), in canvas px.
    overlayBottom() {
      const top = this.canvas.getBoundingClientRect().top;
      let bottom = 0;
      for (const box of this.canvas.parentElement.querySelectorAll(".hero-readout, .demo-banner")) {
        const r = box.getBoundingClientRect();
        if (r.height) bottom = Math.max(bottom, r.bottom - top);
      }
      return bottom;
    }

    frame(t) {
      const dt = this.last == null ? 16 : Math.min(64, t - this.last);
      this.last = t;
      for (const st of Object.values(this.stations)) st.step(dt, this.calm);
      const now = performance.now();
      this.volley.step(now);
      this.sparks.step(now);
      for (const st of Object.values(this.stations)) this.sparks.redPulse(st.key, st.nodes, now);
      if (this.visible) this.draw(t);
      requestAnimationFrame((tt) => this.frame(tt));
    }

    draw(t) {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      const flick = this.calm ? 0.95 : 0.9 + 0.06 * Math.sin(t / 97) + 0.04 * Math.sin(t / 31.7 + 1.3);
      this.drawLink(t);
      for (const st of Object.values(this.stations)) { this.drawStation(st, t, flick); this.drawSparks(st); }
      const focus = this.focusKey();
      for (const st of Object.values(this.stations)) this.drawNodes(st, t, focus);
      this.drawTwinLink(focus);
      this.drawBolts();
      this.drawToolPings(t);
    }

    // ---------- a station ----------

    drawStation(st, t, flick) {
      const ctx = this.ctx, { cx, cy, R } = st, W0 = st.th.wire, RL = R * LIMB;
      // disc tint and a soft core (brighter while Claude has a job running)
      const dg = ctx.createRadialGradient(cx - R * 0.2, cy - R * 0.25, R * 0.1, cx, cy, RL);
      dg.addColorStop(0, rgba(W0, 0.07)); dg.addColorStop(1, rgba(W0, 0.015));
      ctx.fillStyle = dg; ctx.beginPath(); ctx.arc(cx, cy, RL, 0, 7); ctx.fill();
      const hot = st.key === "claude" ? this.running > 0 : this.traffic.toClaude > 0;
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.55);
      cg.addColorStop(0, rgba(st.th.core, hot ? 0.16 : 0.08)); cg.addColorStop(1, rgba(st.th.core, 0));
      ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cx, cy, R * 0.55, 0, 7); ctx.fill();

      // grid, trench, dish as polylines: a dim back pass, then the front pass
      const lines = [];
      const L = (pts, a, w) => lines.push({ pts, a, w });
      for (const lat of [-66, -44, -22, 22, 44, 66]) { const p = []; for (let lo = -180; lo <= 180; lo += 6) p.push(st.project(lat, lo)); L(p, 0.3, 0.9); }
      for (let lo = -180; lo < 180; lo += 20) { const p = []; for (let la = -90; la <= 90; la += 6) p.push(st.project(la, lo)); L(p, 0.3, 0.9); }
      for (const lat of [-2.2, 2.2]) { const p = []; for (let lo = -180; lo <= 180; lo += 4) p.push(st.project(lat, lo)); L(p, 0.7, 1.5); }
      const [dl, dlo, dr] = st.th.dish;
      const c0 = [Math.cos(dl * DEG) * Math.sin(dlo * DEG), Math.sin(dl * DEG), Math.cos(dl * DEG) * Math.cos(dlo * DEG)];
      let e1 = [c0[2], 0, -c0[0]]; const l1 = Math.hypot(...e1); e1 = e1.map((v) => v / l1);
      const e2 = [c0[1] * e1[2] - c0[2] * e1[1], c0[2] * e1[0] - c0[0] * e1[2], c0[0] * e1[1] - c0[1] * e1[0]];
      const cap = (rad, inset) => {
        const p = [];
        for (let k = 0; k <= 48; k++) {
          const a = (k / 48) * 2 * Math.PI, r = Math.sin(rad * DEG), hh = Math.cos(rad * DEG) - inset;
          const v = [0, 1, 2].map((j) => c0[j] * hh + r * (Math.cos(a) * e1[j] + Math.sin(a) * e2[j]));
          const len = Math.hypot(...v);
          p.push(st.project(Math.asin(v[1] / len) / DEG, Math.atan2(v[0], v[2]) / DEG, len));
        }
        return p;
      };
      const rim = cap(dr, 0), inner = cap(dr * 0.18, 0.07);
      L(rim, 0.75, 1.3);
      for (const [rr, ins] of [[dr * 0.7, 0.03], [dr * 0.42, 0.055]]) L(cap(rr, ins), 0.45, 0.8);
      L(inner, 0.45, 0.8);
      for (let k = 0; k < 8; k++) L([rim[k * 6], inner[k * 6]], 0.3, 0.8);
      const dishZ = rim.reduce((s, p) => s + p[2], 0) / rim.length;
      const pass = (front) => {
        for (const ln of lines) {
          ctx.lineWidth = ln.w; ctx.strokeStyle = rgba(W0, (front ? ln.a : ln.a * 0.22) * flick); ctx.beginPath();
          let open = false;
          for (let i = 1; i < ln.pts.length; i++) {
            const a = ln.pts[i - 1], b = ln.pts[i];
            if ((a[2] + b[2] > 0) !== front) { open = false; continue; }
            if (!open) { ctx.moveTo(a[0], a[1]); open = true; }
            ctx.lineTo(b[0], b[1]);
          }
          ctx.stroke();
        }
        if (front === dishZ > 0) {
          ctx.fillStyle = rgba(W0, (front ? 0.1 : 0.03) * flick); ctx.beginPath();
          rim.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.fill();
        }
      };
      pass(false);
      pass(true);

      // spin-axis stubs and the limb
      for (const la of [90, -90]) {
        const a = st.project(la, 0, 1), b = st.project(la, 0, 1.18), al = (b[2] > -0.2 ? 0.65 : 0.3) * flick;
        ctx.strokeStyle = rgba(W0, al); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(b[0], b[1], 1.8, 0, 7); ctx.fillStyle = rgba(W0, al); ctx.fill();
        ctx.font = `500 8.5px ${MONO}`; ctx.textAlign = "left"; ctx.fillStyle = rgba(W0, al * 0.95);
        ctx.fillText(la > 0 ? "+Y · SPIN AXIS" : "−Y", b[0] + 6, b[1] + 3);
      }
      ctx.lineWidth = 1.4; ctx.strokeStyle = rgba(W0, 0.55 * flick); ctx.beginPath(); ctx.arc(cx, cy, RL, 0, 7); ctx.stroke();

      // dotted halo, drifting slowly
      const spin = this.calm ? 0 : (t / 90000) * st.th.dir;
      ctx.fillStyle = rgba(W0, 0.45 * flick); ctx.beginPath();
      for (const d of st.halo) {
        const a = d.a + spin, x = cx + Math.cos(a) * RL * d.r, y = cy + Math.sin(a) * RL * d.r * 0.98;
        ctx.moveTo(x + d.s, y); ctx.arc(x, y, d.s, 0, 7);
      }
      ctx.fill();

      // hologram scanlines and a slow sweep band, inside the station only
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, RL, 0, 7); ctx.clip();
      ctx.fillStyle = rgba(W0, 0.03);
      for (let yy = Math.floor(cy - RL); yy < cy + RL; yy += 3) ctx.fillRect(cx - RL, yy, RL * 2, 1);
      if (!this.calm) {
        const sweep = cy - RL + (((t / 9000) + (st.key === "mac" ? 0.5 : 0)) % 1) * RL * 2;
        const sg = ctx.createLinearGradient(0, sweep - 30, 0, sweep + 30);
        sg.addColorStop(0, rgba(W0, 0)); sg.addColorStop(0.5, rgba(W0, 0.06)); sg.addColorStop(1, rgba(W0, 0));
        ctx.fillStyle = sg; ctx.fillRect(cx - RL, sweep - 30, RL * 2, 60);
      }
      ctx.restore();

      // name plate under the station
      const counts = { needs: 0, live: 0 };
      for (const n of st.nodes) { if (n.action === "needs_anthony") counts.needs++; if (n.action === "in_progress") counts.live++; }
      // Stacked on a phone, the top station's plate (MAC's) goes above it so the link below stays clear.
      const above = this.w < 640 && st.key === "mac";
      const ny = above ? Math.max(18, cy - R * 1.42 - 24) : Math.min(cy + R * 1.42 + 16, this.h - 26);
      ctx.textAlign = "center";
      ctx.font = `600 11px ${MONO}`; ctx.letterSpacing = "2.4px";
      ctx.fillStyle = rgba(W0, 0.95); ctx.fillText(`[ ${st.th.name} ]`, cx, ny);
      ctx.letterSpacing = "0px";
      ctx.font = `500 10px ${MONO}`;
      ctx.fillStyle = counts.needs ? "#ff6a5e" : rgba(W0, 0.6);
      ctx.fillText(`${counts.live} in progress · ${counts.needs} need${counts.needs === 1 ? "s" : ""} Anthony`, cx, ny + 15);
      const M = st.mx, lat = Math.asin(Math.max(-1, Math.min(1, M[7]))) / DEG, lon = Math.atan2(M[6], M[8]) / DEG;
      const sg = (v, w) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1).padStart(w, "0");
      ctx.font = `500 8.5px ${MONO}`; ctx.letterSpacing = "0.6px"; ctx.fillStyle = rgba(W0, 0.5);
      ctx.fillText(`VIEW ${sg(lat, 4)}° ${sg(lon, 5)}° · NODES ${st.nodes.length}`, cx, ny + 28);
      ctx.letterSpacing = "0px";
    }

    // Sparks run on the surface, just above the grid; the part round the back is hidden.
    drawSparks(st) {
      const ctx = this.ctx, now = performance.now();
      for (const sp of this.sparks.active) {
        if (sp.station !== st.key) continue;
        const u = Math.min(1, (now - sp.t0) / this.sparks.duration), n = sp.path.length - 1;
        const col = sp.red ? RED : hexRgb(V.jobColor(sp.key)) || st.th.node;
        const head = u * n, tail = Math.max(0, head - n * 0.45);
        const at = (k) => {
          const i = Math.min(n - 1, Math.floor(k)), f = k - i, a = sp.path[i], b = sp.path[i + 1];
          return st.project(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, 1.004);
        };
        const steps = 10;
        let prev = at(tail);
        for (let j = 1; j <= steps; j++) {
          const cur = at(tail + ((head - tail) * j) / steps);
          if (prev[2] > 0 && cur[2] > 0) {
            ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(cur[0], cur[1]);
            ctx.strokeStyle = rgba(col, 0.15 + (0.85 * j) / steps); ctx.lineWidth = 0.8 + (1.4 * j) / steps; ctx.stroke();
          }
          prev = cur;
        }
        const h = at(head);
        if (h[2] > 0) {
          const g = ctx.createRadialGradient(h[0], h[1], 0, h[0], h[1], 6);
          g.addColorStop(0, rgba(col, 0.6)); g.addColorStop(1, rgba(col, 0));
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(h[0], h[1], 6, 0, 7); ctx.fill();
          ctx.beginPath(); ctx.arc(h[0], h[1], 1.3, 0, 7); ctx.fillStyle = "rgba(255,255,255,.95)"; ctx.fill();
        }
      }
    }

    // ---------- nodes ----------

    drawNodes(st, t, focus) {
      const ctx = this.ctx, W0 = st.th.wire, labels = [], now = performance.now();
      const order = st.nodes.map((n) => ({ n, p: st.project(n.ll[0], n.ll[1]) })).sort((a, b) => a.p[2] - b.p[2]);
      for (const { n, p } of order) {
        const [x, y, z, s] = p, fz = sstep(-0.25, 0.3, z), sc = (0.5 + 0.5 * fz) * s;
        const sel = this.selected === n.id, hov = this.hover && this.hover.node === n;
        const twin = !!focus && n.key === focus && !sel && !hov; // the same job, picked on the other station
        const act = n.action;
        const base = act === "done" ? (twin ? 0.8 : 0.3) : act === "queued" ? 0.62 : 1;
        ctx.globalAlpha = base * (0.16 + 0.84 * fz);
        const jc = n.rgb || (act === "needs_anthony" ? RED : st.th.node);
        const c = jc;
        const halo = (rr, w, a) => { ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.strokeStyle = rgba(c, a); ctx.lineWidth = w; ctx.stroke(); };
        const dot = (rr, col) => { ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.fillStyle = col; ctx.fill(); };
        if (sel || hov) {
          const pr = 13 * sc + (this.calm ? 0 : 1.5 * Math.sin(t / 260)), sc2 = sel ? 0.95 : 0.6;
          ctx.strokeStyle = rgba(act === "needs_anthony" ? RED : [255, 255, 255], sc2); ctx.lineWidth = 1.2;
          for (let q = 0; q < 4; q++) { const a0 = t / 1400 + (q * Math.PI) / 2; ctx.beginPath(); ctx.arc(x, y, pr, a0, a0 + 0.9); ctx.stroke(); }
          if (sel) { ctx.strokeStyle = rgba(W0, 0.9); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, pr + 5, 0, 7); ctx.stroke(); }
        }
        if (twin) {
          ctx.globalAlpha = 1;
          const pr = 12 * sc;
          ctx.strokeStyle = rgba(jc, 0.95); ctx.lineWidth = 1.2;
          for (let q = 0; q < 4; q++) { const a0 = (q * Math.PI) / 2 + 0.35; ctx.beginPath(); ctx.arc(x, y, pr, a0, a0 + 0.9); ctx.stroke(); }
          ctx.globalAlpha = base * (0.16 + 0.84 * fz);
        }
        if (act === "needs_anthony") {
          // VADER's "needs you" marker: a diamond in the job's colour, then the red alert on top
          // (rotating dashed ring and a thin pulse), so the status still reads first.
          const d = 6.4 * sc;
          ctx.beginPath(); ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.closePath();
          ctx.fillStyle = rgba(jc, 0.3); ctx.fill(); ctx.strokeStyle = rgba(jc, 1); ctx.lineWidth = 1.5; ctx.stroke();
          dot(1.6 * sc, "#fff");
          ctx.beginPath(); ctx.arc(x, y, d + 4.5 * sc, 0, 7); ctx.strokeStyle = rgba(RED, 0.95); ctx.lineWidth = 1.2;
          ctx.setLineDash([3, 3]); ctx.lineDashOffset = this.calm ? 0 : -t / 40; ctx.stroke(); ctx.setLineDash([]);
          ctx.beginPath(); ctx.arc(x, y, d + 4.5 * sc, 0, 7); ctx.strokeStyle = rgba(RED, 0.14 * fz); ctx.lineWidth = 3; ctx.stroke();
          if (!this.calm && fz > 0.3) { const u = (t % 1800) / 1800; ctx.beginPath(); ctx.arc(x, y, d + 6 + u * 16, 0, 7); ctx.strokeStyle = rgba(RED, 0.55 * (1 - u)); ctx.lineWidth = 1; ctx.stroke(); }
        } else if (act === "in_progress") {
          // working: thin ring, centre dot, a short arc running round it
          const rr = 4.2 * sc;
          halo(rr, 3, 0.12 * fz); halo(rr, 1.2, 0.95); dot(1.35 * sc, "rgba(255,255,255,.97)");
          if (fz > 0.3) { const a0 = this.calm ? 0 : t / 500; ctx.beginPath(); ctx.arc(x, y, rr + 2.8 * sc, a0, a0 + 1.3); ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 1; ctx.stroke(); }
        } else if (act === "queued") {
          const rr = 3.2 * sc;
          halo(rr, 1, 0.8); dot(0.9 * sc, rgba(c, 0.9));
        } else {
          dot(1.3 * sc, rgba(c, 0.7));
        }
        ctx.globalAlpha = 1;
        // a bolt just landed here: a short glow in the job's colour
        for (const l of this.volley.landings) {
          if (l.station !== st.key || l.key !== n.key) continue;
          const u = Math.min(1, (now - l.t0) / V.LAND_MS), lc = hexRgb(l.color) || LINK;
          const g = ctx.createRadialGradient(x, y, 0, x, y, 16 * sc);
          g.addColorStop(0, rgba(lc, 0.55 * (1 - u))); g.addColorStop(1, rgba(lc, 0));
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 16 * sc, 0, 7); ctx.fill();
          ctx.beginPath(); ctx.arc(x, y, (6 + u * 10) * sc, 0, 7); ctx.strokeStyle = rgba(lc, 0.85 * (1 - u)); ctx.lineWidth = 1.2; ctx.stroke();
        }
        // reduced motion: the message shows as a still flash on both nodes, nothing moves
        for (const f of this.volley.flashes) {
          if (f.key !== n.key || (f.from !== st.key && f.to !== st.key)) continue;
          // a still glow in the job's colour: a soft disc and two rings, no movement
          const fc = hexRgb(f.color) || LINK;
          const g = ctx.createRadialGradient(x, y, 0, x, y, 20 * sc);
          g.addColorStop(0, rgba(fc, 0.55)); g.addColorStop(1, rgba(fc, 0));
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 20 * sc, 0, 7); ctx.fill();
          ctx.beginPath(); ctx.arc(x, y, 9 * sc, 0, 7); ctx.strokeStyle = rgba(fc, 1); ctx.lineWidth = 2.2; ctx.stroke();
          ctx.beginPath(); ctx.arc(x, y, 14 * sc, 0, 7); ctx.strokeStyle = rgba(fc, 0.6); ctx.lineWidth = 1; ctx.stroke();
        }
        const la = sstep(0.1, 0.32, z) || (sel || twin ? 1 : 0);
        if (la > 0 && (act !== "done" || twin)) labels.push({ n, x, y, z, r: 7 * sc, a: twin ? 1 : la * base, sel: sel || twin });
      }
      // labels: what needs Anthony first; a label that would overlap one already placed tries the other side, else it waits
      const placed = [];
      const hit = (b) => placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
      const rank = { needs_anthony: 0, in_progress: 1, queued: 2 };
      labels.sort((A, B) => (B.sel - A.sel) || (rank[A.n.action] - rank[B.n.action]) || (B.z - A.z));
      for (const L1 of labels) {
        const n = L1.n, { x, y, r } = L1, prob = n.action === "needs_anthony";
        const showSub = (prob || n.action === "in_progress" || L1.sel) && n.sub;
        const title = (L1.sel && n.key ? n.key : n.label).toUpperCase();
        const sub = showSub ? (n.sub.length > 40 ? `${n.sub.slice(0, 39)}…` : n.sub) : "";
        const f1 = `${prob ? 600 : 500} ${prob ? 9.5 : 8.5}px ${UI_FONT}`, f2 = `400 9px ${UI_FONT}`;
        ctx.font = f1; ctx.letterSpacing = "1.1px"; let w = ctx.measureText(title).width; ctx.letterSpacing = "0px";
        if (sub) { ctx.font = f2; w = Math.max(w, ctx.measureText(sub).width); }
        const hgt = sub ? 21 : 10;
        let box = null, ly = 0;
        for (const up of [L1.n.ll[0] > 0, L1.n.ll[0] <= 0]) {
          ly = up ? y - r - 5 - (sub ? 11 : 0) : y + r + 10;
          const b = { x0: x - w / 2 - 3, x1: x + w / 2 + 3, y0: ly - 10, y1: ly - 10 + hgt + 2 };
          if (!hit(b) || L1.sel) { box = b; break; }
        }
        if (!box) continue;
        placed.push(box);
        ctx.globalAlpha = Math.min(1, L1.a); ctx.textAlign = "center"; ctx.lineWidth = 2.6; ctx.strokeStyle = "rgba(0,0,0,.82)";
        ctx.font = f1; ctx.letterSpacing = "1.1px"; ctx.strokeText(title, x, ly);
        ctx.fillStyle = prob ? "#fff" : L1.sel && n.rgb ? rgba(n.rgb, 1) : st.th.label; ctx.fillText(title, x, ly); ctx.letterSpacing = "0px";
        if (sub) { ctx.font = f2; ctx.strokeText(sub, x, ly + 11); ctx.fillStyle = prob ? "#ff6a5e" : st.th.sub; ctx.fillText(sub, x, ly + 11); }
        ctx.globalAlpha = 1;
      }
    }

    // ---------- the link, the bolts and the twins ----------

    linkPoints() {
      const a = this.stations.claude, b = this.stations.mac;
      const dx = b.cx - a.cx, dy = b.cy - a.cy, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
      const p0 = [a.cx + ux * a.R * LIMB * 1.24, a.cy + uy * a.R * LIMB * 1.24];
      const p1 = [b.cx - ux * b.R * LIMB * 1.24, b.cy - uy * b.R * LIMB * 1.24];
      const bow = Math.min(40, Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) * 0.12);
      const c = [(p0[0] + p1[0]) / 2 + uy * bow, (p0[1] + p1[1]) / 2 - ux * bow];
      return { p0, c, p1 };
    }

    linkAt(u) {
      const { p0, c, p1 } = this.linkPoints(), v = 1 - u;
      return [v * v * p0[0] + 2 * v * u * c[0] + u * u * p1[0], v * v * p0[1] + 2 * v * u * c[1] + u * u * p1[1]];
    }

    drawLink(t) {
      const ctx = this.ctx, { p0, c, p1 } = this.linkPoints();
      if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 30) return;
      const litMsg = this.lit ? this.messages.get(this.lit) : null;
      const path = () => { ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.quadraticCurveTo(c[0], c[1], p1[0], p1[1]); };
      path(); ctx.strokeStyle = rgba(LINK, litMsg ? 0.1 : 0.03); ctx.lineWidth = 4; ctx.stroke();
      path(); ctx.strokeStyle = rgba(LINK, litMsg ? 0.5 : 0.14); ctx.lineWidth = 1; ctx.setLineDash([2, 5]); ctx.stroke(); ctx.setLineDash([]);
      for (const p of [p0, p1]) { ctx.beginPath(); ctx.arc(p[0], p[1], 2, 0, 7); ctx.fillStyle = rgba(LINK, 0.7); ctx.fill(); }
      ctx.font = `600 8.5px ${MONO}`; ctx.letterSpacing = "1.6px"; ctx.textAlign = "center"; ctx.fillStyle = rgba(LINK, 0.5);
      const mid = this.linkAt(0.5); ctx.fillText("COMMS", mid[0] + (this.w < 640 ? 34 : 0), mid[1] - (this.w < 640 ? -3 : 10)); ctx.letterSpacing = "0px";
      if (litMsg) {
        const toClaude = litMsg.direction === "to_claude";
        // the link runs from Claude (0) to MAC (1): point toward the receiver
        const p = this.linkAt(0.5), q = this.linkAt(toClaude ? 0.53 : 0.47);
        const ang = Math.atan2(p[1] - q[1], p[0] - q[0]);
        ctx.save(); ctx.translate(p[0], p[1]); ctx.rotate(ang);
        ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4); ctx.closePath();
        ctx.fillStyle = rgba(LINK, 0.95); ctx.fill(); ctx.restore();
      }
    }

    // The job being looked at: hovered or opened node, or the message hovered in the comms feed.
    focusKey() {
      if (this.hover && this.hover.node.key) return this.hover.node.key;
      const sel = this.selected && this.findNode(this.selected);
      if (sel && sel.key) return sel.key;
      const lit = this.lit && this.messages.get(this.lit);
      return lit ? this.keyOf(lit) : null;
    }

    // Where a job's node sits on a station right now; front-most if it is there twice. Without a node,
    // the station's limb facing the other station.
    anchor(stationKey, key) {
      const st = this.stations[stationKey], other = this.stations[stationKey === "mac" ? "claude" : "mac"];
      let best = null;
      for (const n of st.nodes) {
        if (!key || n.key !== key) continue;
        const p = st.project(n.ll[0], n.ll[1]);
        if (!best || p[2] > best[2]) best = p;
      }
      if (best && best[2] > -0.15) return [best[0], best[1]]; // a node round the back fires from the limb
      const dx = other.cx - st.cx, dy = other.cy - st.cy, d = Math.hypot(dx, dy) || 1;
      return [st.cx + (dx / d) * st.R * LIMB, st.cy + (dy / d) * st.R * LIMB];
    }

    boltPath(b) {
      const p0 = this.anchor(b.from, b.key), p1 = this.anchor(b.to, b.key);
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1], d = Math.hypot(dx, dy) || 1;
      // MAC → Claude arcs over, Claude → MAC arcs under, so a volley reads as two lanes.
      const bow = Math.min(90, d * 0.16) * (b.dir === "ltr" ? 1 : -1);
      const c = [(p0[0] + p1[0]) / 2 + (dy / d) * bow, (p0[1] + p1[1]) / 2 - (dx / d) * bow];
      return (u) => { const v = 1 - u; return [v * v * p0[0] + 2 * v * u * c[0] + u * u * p1[0], v * v * p0[1] + 2 * v * u * c[1] + u * u * p1[1]]; };
    }

    drawBolts() {
      const ctx = this.ctx, now = performance.now();
      this.boltHeads = [];
      for (const b of this.volley.active) {
        const at = this.boltPath(b), raw = Math.min(1, (now - b.t0) / this.volley.duration), u = easeOut(raw);
        const col = hexRgb(b.color) || LINK, open = b.message.blocked && !b.message.cleared;
        // faint trace of the way travelled, then a crisp bright tail behind the head
        ctx.beginPath();
        for (let i = 0; i <= 24; i++) { const q = at((u * i) / 24); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }
        ctx.strokeStyle = rgba(col, 0.22 * (1 - raw * 0.6)); ctx.lineWidth = 1; ctx.stroke();
        const tail = 0.16;
        for (let i = 0; i < 6; i++) {
          const k0 = Math.max(0, u - tail * (1 - i / 6)), k1 = Math.max(0, u - tail * (1 - (i + 1) / 6));
          const a = at(k0), c = at(k1);
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]);
          ctx.strokeStyle = rgba(col, 0.15 + (0.8 * (i + 1)) / 6); ctx.lineWidth = 1 + (i + 1) * 0.25; ctx.lineCap = "round"; ctx.stroke();
        }
        ctx.lineCap = "butt";
        const h = at(u), g = ctx.createRadialGradient(h[0], h[1], 0, h[0], h[1], 10);
        g.addColorStop(0, rgba(col, 0.5)); g.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(h[0], h[1], 10, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(h[0], h[1], 2.2, 0, 7); ctx.fillStyle = open ? "#ff6a5e" : "rgba(255,255,255,.95)"; ctx.fill();
        // a small kick at the sending node as it fires
        if (raw < 0.25) { const s0 = at(0); ctx.beginPath(); ctx.arc(s0[0], s0[1], 5 + raw * 24, 0, 7); ctx.strokeStyle = rgba(col, 0.7 * (1 - raw * 4)); ctx.lineWidth = 1; ctx.stroke(); }
        this.boltHeads.push({ at: h, m: b.message });
      }
    }

    // Hovering a job: a faint dashed line to its twin on the other station.
    drawTwinLink(focus) {
      if (!focus) return;
      const a = this.stations.mac.nodes.some((n) => n.key === focus), b = this.stations.claude.nodes.some((n) => n.key === focus);
      if (!a || !b) return;
      const p0 = this.anchor("mac", focus), p1 = this.anchor("claude", focus), col = hexRgb(V.jobColor(focus)) || LINK, ctx = this.ctx;
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]);
      ctx.strokeStyle = rgba(col, 0.45); ctx.lineWidth = 1; ctx.setLineDash([2, 6]); ctx.stroke(); ctx.setLineDash([]);
    }

    drawToolPings(t) {
      const ctx = this.ctx, st = this.stations.claude, now = performance.now();
      this.toolPings = this.toolPings.filter((p) => now - p.t0 < 1600);
      this.toolPings.forEach((p, i) => {
        const u = (now - p.t0) / 1600;
        ctx.beginPath(); ctx.arc(st.cx, st.cy, st.R * (0.15 + u * 0.4), 0, 7);
        ctx.strokeStyle = rgba(st.th.wire, 0.4 * (1 - u)); ctx.lineWidth = 1; ctx.stroke();
        ctx.font = `500 9.5px ${MONO}`; ctx.textAlign = "center"; ctx.fillStyle = rgba(st.th.node, 0.85 * (1 - u));
        ctx.fillText(`› ${p.name}`, st.cx, st.cy - st.R * 0.18 - u * 14 - i * 12);
      });
    }

    // ---------- pointer: hover, click, drag to turn a station ----------

    pointAt(ev) {
      const r = this.canvas.getBoundingClientRect();
      return [ev.clientX - r.left, ev.clientY - r.top];
    }

    hitNode(mx, my) {
      let best = null, bz = -9;
      for (const st of Object.values(this.stations)) {
        for (const n of st.nodes) {
          if (n.action === "done") continue;
          const [x, y, z] = st.project(n.ll[0], n.ll[1]);
          if (z < -0.1) continue;
          if (Math.hypot(mx - x, my - y) < 11 && z > bz) { best = { node: n, station: st, x, y }; bz = z; }
        }
      }
      return best;
    }

    hitBolt(mx, my) {
      for (const b of this.boltHeads) if (Math.hypot(mx - b.at[0], my - b.at[1]) < 12) return b.m;
      return null;
    }

    stationAt(mx, my) {
      for (const st of Object.values(this.stations)) if (Math.hypot(mx - st.cx, my - st.cy) < st.R * LIMB * 1.1) return st;
      return null;
    }

    bindPointer() {
      const cv = this.canvas;
      let press = null;
      cv.addEventListener("pointerdown", (ev) => {
        const [mx, my] = this.pointAt(ev);
        press = { x: ev.clientX, y: ev.clientY, lx: ev.clientX, ly: ev.clientY, moved: false, st: this.stationAt(mx, my) };
        try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* not supported */ }
      });
      cv.addEventListener("pointermove", (ev) => {
        const [mx, my] = this.pointAt(ev);
        if (press) {
          if (!press.moved && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 5) {
            press.moved = true;
            if (press.st) { for (const st of Object.values(this.stations)) st.drag = true; cv.style.cursor = "grabbing"; }
          }
          // dragging either station turns both, so twins stay lined up
          if (press.moved && press.st) for (const st of Object.values(this.stations)) st.rotateBy(ev.clientX - press.lx, ev.clientY - press.ly);
          press.lx = ev.clientX; press.ly = ev.clientY;
          return;
        }
        const node = this.hitNode(mx, my);
        const msg = node ? null : this.hitBolt(mx, my);
        this.hover = node;
        this.onHover(msg ? msg.id : null);
        cv.style.cursor = node || msg ? "pointer" : this.stationAt(mx, my) ? "grab" : "default";
        if (node) this.showTip(mx, my, `${node.node.key || node.node.label} · ${ACTION_TEXT[node.node.action] || ""} · ${node.node.kindLabel || ""}`, node.node.title || node.node.label, node.node.action === "needs_anthony" ? "blocked" : node.station.key === "claude" ? "to_mac" : "to_claude");
        else if (msg) this.showTip(mx, my, `${directionLabel(msg)} · ${KIND_LABELS[msg.kind] || msg.kind}`, msg.text, msg.blocked && !msg.cleared ? "blocked" : msg.direction);
        else this.tooltip.hidden = true;
      });
      const end = (ev, cancel) => {
        if (!press) return;
        const p = press; press = null;
        if (p.moved) { for (const st of Object.values(this.stations)) st.drag = false; cv.style.cursor = "grab"; return; }
        if (cancel) return;
        const [mx, my] = this.pointAt(ev);
        const hit = this.hitNode(mx, my);
        this.select(hit ? hit.node.id : null);
        this.tooltip.hidden = true;
        if (this.onNodeClick) this.onNodeClick(hit ? hit.node : null);
      };
      cv.addEventListener("pointerup", (ev) => end(ev, false));
      cv.addEventListener("pointercancel", (ev) => end(ev, true));
      cv.addEventListener("pointerleave", () => { if (!press) { this.hover = null; this.tooltip.hidden = true; this.onHover(null); } });
    }

    showTip(x, y, head, body, tone) {
      const strong = document.createElement("strong");
      strong.textContent = head;
      const span = document.createElement("span");
      span.textContent = body || "";
      this.tooltip.replaceChildren(strong, span);
      this.tooltip.className = `bolt-tip ${tone}`;
      this.tooltip.hidden = false;
      const tw = this.tooltip.offsetWidth;
      this.tooltip.style.left = `${Math.max(8, Math.min(this.w - tw - 8, x + 14))}px`;
      this.tooltip.style.top = `${Math.max(8, Math.min(this.h - this.tooltip.offsetHeight - 8, y + 14))}px`;
    }
  }

  const ACTION_TEXT = { needs_anthony: "NEEDS ANTHONY", in_progress: "IN PROGRESS", queued: "QUEUED", done: "DONE" };

  function directionLabel(message) {
    return message.direction === "to_claude" ? "MAC → Claude" : "Claude → MAC";
  }

  window.BrainsVisual = BrainsVisual;
  window.BrainsVisual.motion = { calm: reduceMotion, choice: motionChoice, systemCalm };
  window.BrainsVisual.setMotion = (choice) => {
    try {
      localStorage.setItem(MOTION_KEY, choice);
    } catch (e) {
      return false; // can't remember it, so there is nothing new to apply
    }
    location.reload(); // motion is set up at load
    return true;
  };
  window.BrainsVisual.kindLabel = (kind) => KIND_LABELS[kind] || kind;
  window.BrainsVisual.directionLabel = directionLabel;
})();
