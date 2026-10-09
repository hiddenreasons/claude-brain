"use strict";

// Claude (orange, left) and MAC / Grok Bot (blue, right), and the lightning between them.
// Everything is drawn here with <canvas>: no images, no network.
// A bolt fires only when the page reports a real message (see fire()); a faint arc shows while a job runs.

(function () {
  const PALETTE = {
    claude: { core: [255, 224, 160], mid: [255, 150, 40], edge: [255, 104, 16] },
    mac: { core: [214, 246, 255], mid: [80, 200, 255], edge: [36, 124, 255] },
    blocked: { core: [255, 214, 210], mid: [255, 72, 72], edge: [214, 24, 36] },
  };
  const KIND_LABELS = {
    work_order: "New work order",
    from_mac: "MAC reply",
    job_sent: "Job sent",
    to_mac: "Claude reply",
    report: "Report written",
    job_result: "Job result",
  };
  const BURST_S = 1.2; // the violent part: strobing, re-striking on new paths
  const DECAY_S = 2.2;
  const MAX_SPARKS = 700;
  const TRACE_S = 45;
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

  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

  // Seeded random numbers, so the brains look the same on every load.
  function seeded(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function offscreen(size, dpr) {
    const c = document.createElement("canvas");
    c.width = Math.ceil(size * dpr);
    c.height = Math.ceil(size * dpr);
    const ctx = c.getContext("2d");
    ctx.scale(dpr, dpr);
    return { canvas: c, ctx, size };
  }

  // ---------- Claude: a ring of broken light around a swirling core ----------

  function buildClaude(r, dpr) {
    const rand = seeded(7);
    const P = PALETTE.claude;
    const ring = offscreen(r * 2.6, dpr);
    const frame = offscreen(r * 2.9, dpr);
    let ctx = ring.ctx;
    const c = ring.size / 2;
    ctx.globalCompositeOperation = "lighter";

    const disc = ctx.createRadialGradient(c, c, r * 0.2, c, c, r * 1.05);
    disc.addColorStop(0, rgba(P.edge, 0.1));
    disc.addColorStop(1, rgba(P.edge, 0));
    ctx.fillStyle = disc;
    ctx.fillRect(0, 0, ring.size, ring.size);

    const arcs = (count, rMin, rMax, alphaMax) => {
      for (let i = 0; i < count; i++) {
        const rad = r * (rMin + rand() * (rMax - rMin));
        const a0 = rand() * Math.PI * 2;
        ctx.strokeStyle = rgba(rand() < 0.5 ? P.mid : P.edge, 0.2 + rand() * alphaMax);
        ctx.lineWidth = 0.6 + rand() * 1.8;
        ctx.beginPath();
        ctx.arc(c, c, rad, a0, a0 + 0.02 + rand() * 0.2);
        ctx.stroke();
      }
    };
    ctx.shadowColor = rgba(P.mid, 0.9);
    ctx.shadowBlur = 6;
    arcs(170, 0.8, 1.0, 0.75);
    arcs(80, 0.45, 0.78, 0.45);

    // Ladder ticks down one side, like the reference.
    for (let i = 0; i < 70; i++) {
      const a = Math.PI * 0.55 + (i / 70) * Math.PI * 0.9;
      const len = r * (0.03 + rand() * 0.06);
      ctx.strokeStyle = rgba(P.mid, 0.25 + rand() * 0.4);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * r * 0.97, c + Math.sin(a) * r * 0.97);
      ctx.lineTo(c + Math.cos(a) * (r * 0.97 + len), c + Math.sin(a) * (r * 0.97 + len));
      ctx.stroke();
    }

    // The big sweeping arc through the middle.
    ctx.shadowBlur = 10;
    ctx.strokeStyle = rgba(P.mid, 0.65);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c, c, r * 0.56, 2.3, 5.5);
    ctx.stroke();

    // Frame: dashed rings and HUD corner brackets that don't turn.
    ctx = frame.ctx;
    const f = frame.size / 2;
    ctx.strokeStyle = rgba(P.mid, 0.35);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 7]);
    ctx.beginPath();
    ctx.arc(f, f, r * 1.07, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([1, 4]);
    ctx.strokeStyle = rgba(P.mid, 0.18);
    ctx.beginPath();
    ctx.arc(f, f, r * 0.64, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = rgba(P.mid, 0.3);
    const b = r * 1.28;
    const k = r * 0.22;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(f + sx * b, f + sy * (b - k));
      ctx.lineTo(f + sx * b, f + sy * b);
      ctx.lineTo(f + sx * (b - k), f + sy * b);
      ctx.stroke();
    }

    const sparks = Array.from({ length: 320 }, () => {
      const outer = rand() < 0.7;
      return {
        a: rand() * Math.PI * 2,
        rad: r * (outer ? 0.78 + rand() * 0.24 : 0.3 + rand() * 0.5),
        len: 1 + rand() * (outer ? 5 : 3),
        w: rand() < 0.2 ? 2 : 1,
        phase: rand() * Math.PI * 2,
        speed: 0.5 + rand() * 2.5,
        color: rand() < 0.15 ? P.core : rand() < 0.6 ? P.mid : P.edge,
      };
    });
    return { ring, frame, sparks };
  }

  function drawClaude(ctx, art, x, y, r, t, flash) {
    const P = PALETTE.claude;
    const rot = t * 0.05;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.drawImage(art.ring.canvas, -art.ring.size / 2, -art.ring.size / 2, art.ring.size, art.ring.size);
    ctx.restore();
    ctx.drawImage(art.frame.canvas, x - art.frame.size / 2, y - art.frame.size / 2, art.frame.size, art.frame.size);

    for (const s of art.sparks) {
      const a = s.a + rot;
      const alpha = 0.35 + 0.65 * Math.max(0, Math.sin(t * s.speed + s.phase));
      const px = x + Math.cos(a) * s.rad;
      const py = y + Math.sin(a) * s.rad;
      ctx.strokeStyle = rgba(s.color, alpha);
      ctx.lineWidth = s.w;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px - Math.sin(a) * s.len, py + Math.cos(a) * s.len);
      ctx.stroke();
    }

    const pulse = 1 + 0.08 * Math.sin(t * 2.1) + flash * 0.5;
    const core = ctx.createRadialGradient(x, y, 0, x, y, r * 0.34 * pulse);
    core.addColorStop(0, rgba([255, 250, 230], 0.95));
    core.addColorStop(0.25, rgba(P.core, 0.7 + flash * 0.3));
    core.addColorStop(0.6, rgba(P.mid, 0.25));
    core.addColorStop(1, rgba(P.edge, 0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.34 * pulse, 0, Math.PI * 2);
    ctx.fill();

    // Swirl of light at the core.
    ctx.lineWidth = 1.3;
    for (let i = 0; i < 6; i++) {
      ctx.strokeStyle = rgba(i % 2 ? P.core : P.mid, 0.55 + flash * 0.4);
      ctx.beginPath();
      ctx.ellipse(x, y, r * (0.14 + i * 0.03), r * (0.06 + i * 0.012), t * 0.7 + i * 0.9, 0, Math.PI * 1.6);
      ctx.stroke();
    }
  }

  // ---------- MAC: a faceted crystal shell around glowing filaments ----------

  function buildMac(r, dpr) {
    const rand = seeded(11);
    const P = PALETTE.mac;
    const shell = offscreen(r * 2.4, dpr);
    const ctx = shell.ctx;
    const c = shell.size / 2;
    ctx.globalCompositeOperation = "lighter";

    const glow = ctx.createRadialGradient(c, c, r * 0.1, c, c, r * 1.0);
    glow.addColorStop(0, rgba(P.mid, 0.16));
    glow.addColorStop(1, rgba(P.edge, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, shell.size, shell.size);

    const s1 = rand() * 6;
    const s2 = rand() * 6;
    const s3 = rand() * 6;
    const outline = (scale, n, jitter) =>
      Array.from({ length: n }, (_, i) => {
        const th = (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.08;
        const rad = r * scale * (0.86 + 0.07 * Math.sin(3 * th + s1) + 0.05 * Math.sin(5 * th + s2)
          + 0.03 * Math.sin(7 * th + s3) + (rand() - 0.5) * jitter);
        return [c + Math.cos(th) * rad, c + Math.sin(th) * rad];
      });
    const poly = (pts, stroke, width, fill) => {
      ctx.beginPath();
      pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();
    };

    // Filaments from the center outward.
    ctx.shadowColor = rgba(P.mid, 0.8);
    ctx.shadowBlur = 4;
    for (let i = 0; i < 100; i++) {
      const th = rand() * Math.PI * 2;
      const len = r * (0.25 + rand() * 0.62);
      let px = c + (rand() - 0.5) * r * 0.1;
      let py = c + (rand() - 0.5) * r * 0.1;
      ctx.strokeStyle = rgba(rand() < 0.3 ? P.core : P.mid, 0.12 + rand() * 0.4);
      ctx.lineWidth = 0.5 + rand() * 0.9;
      ctx.beginPath();
      ctx.moveTo(px, py);
      for (let s = 1; s <= 5; s++) {
        const d = (len * s) / 5;
        px = c + Math.cos(th + (rand() - 0.5) * 0.35) * d;
        py = c + Math.sin(th + (rand() - 0.5) * 0.35) * d;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // Crystal shell: three jagged outlines, glassy plates and facet edges.
    const outer = outline(1, 26, 0.06);
    const facets = [];
    for (let i = 0; i < 12; i++) {
      const a = outer[Math.floor(rand() * outer.length)];
      const bIdx = Math.floor(rand() * outer.length);
      const b = outer[bIdx];
      const m = [c + (rand() - 0.5) * r * 0.9, c + (rand() - 0.5) * r * 0.9];
      facets.push([a, b, m]);
    }
    ctx.shadowBlur = 8;
    for (const f of facets) poly(f, rgba(P.mid, 0.18), 0.8, rgba(P.mid, 0.035));
    poly(outline(0.72, 18, 0.1), rgba(P.mid, 0.35), 1, null);
    poly(outline(0.93, 22, 0.08), rgba(P.mid, 0.45), 1, null);
    poly(outer, rgba(P.core, 0.75), 1.4, rgba(P.edge, 0.04));
    for (let i = 0; i < 40; i++) {
      const [ax, ay] = outer[Math.floor(rand() * outer.length)];
      const th = rand() * Math.PI * 2;
      const d = r * (0.3 + rand() * 0.45);
      ctx.strokeStyle = rgba(P.mid, 0.12 + rand() * 0.25);
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(c + Math.cos(th) * d, c + Math.sin(th) * d);
      ctx.stroke();
    }

    const specks = Array.from({ length: 280 }, () => ({
      a: rand() * Math.PI * 2,
      rad: r * (0.85 + Math.pow(rand(), 0.7) * 0.6),
      size: rand() < 0.15 ? 2 : 1,
      phase: rand() * Math.PI * 2,
      speed: 0.4 + rand() * 2,
      color: rand() < 0.25 ? P.core : P.mid,
    }));
    return { shell, specks };
  }

  function drawMac(ctx, art, x, y, r, t, flash) {
    const P = PALETTE.mac;
    const breathe = 1 + 0.012 * Math.sin(t * 1.3);
    const size = art.shell.size * breathe;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(0.04 * Math.sin(t * 0.35));
    ctx.drawImage(art.shell.canvas, -size / 2, -size / 2, size, size);
    ctx.restore();

    const drift = -t * 0.03;
    for (const s of art.specks) {
      const a = s.a + drift;
      ctx.fillStyle = rgba(s.color, 0.25 + 0.6 * Math.max(0, Math.sin(t * s.speed + s.phase)));
      ctx.fillRect(x + Math.cos(a) * s.rad, y + Math.sin(a) * s.rad * 0.92, s.size, s.size);
    }

    const pulse = 1 + 0.07 * Math.sin(t * 1.7 + 1) + flash * 0.5;
    const core = ctx.createRadialGradient(x, y, 0, x, y, r * 0.3 * pulse);
    core.addColorStop(0, rgba([245, 252, 255], 0.95));
    core.addColorStop(0.3, rgba(P.core, 0.6 + flash * 0.4));
    core.addColorStop(0.7, rgba(P.mid, 0.18));
    core.addColorStop(1, rgba(P.edge, 0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.3 * pulse, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---------- artwork from files (Codex stills, Runway loops) ----------

  // Looks for /media/<who>-loop.mp4 first, then /media/<who>-brain.png. Calls back when one is ready.
  // Both have black backgrounds; drawn with additive blending, black adds nothing, so only the brain shows.
  function loadArt(who, onReady) {
    let haveVideo = false;
    const img = new Image();
    img.onload = () => {
      if (!haveVideo) onReady({ el: img, kind: "image" });
    };
    img.src = `/media/${who}-brain.png`;
    if (reduceMotion) return; // the still is enough when the viewer asked for less motion
    // Two copies of the clip, so the end can crossfade into the start: no visible jump at the loop.
    const make = () => {
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.src = `/media/${who}-loop.mp4`;
      return v;
    };
    const a = make();
    const b = make();
    const art = { kind: "video", a, b, active: a };
    // If the page was in the background (no animation frames), the crossfade never ran: just hand over.
    for (const [mine, next] of [[a, b], [b, a]]) {
      mine.addEventListener("ended", () => {
        if (art.active !== mine) return;
        art.active = next;
        if (next.paused) {
          next.currentTime = 0;
          next.play().catch(() => {});
        }
      });
    }
    a.addEventListener("canplay", () => {
      haveVideo = true;
      a.play().catch(() => {});
      onReady(art);
    }, { once: true });
  }

  const CROSSFADE_S = 0.9;

  // Runway clips come out widescreen with the brain centered; use the center square.
  function blitFrame(ctx, el, x, y, size, alpha) {
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    const w = el.videoWidth || el.naturalWidth || el.width;
    const h = el.videoHeight || el.naturalHeight || el.height;
    const side = Math.min(w, h);
    ctx.drawImage(el, (w - side) / 2, (h - side) / 2, side, side, x - size / 2, y - size / 2, size, size);
  }

  function drawArt(ctx, art, x, y, r, t, flash) {
    // The brain fills about 70% of the artwork, so 3r makes it about as wide as the drawn brains.
    if (art.kind === "image") {
      const breathe = reduceMotion ? 1 : 1 + 0.012 * Math.sin(t * 1.3);
      const size = r * 3 * breathe;
      blitFrame(ctx, art.el, x, y, size, reduceMotion ? 1 : 0.92 + 0.08 * Math.sin(t * 1.7));
      if (flash > 0.01) blitFrame(ctx, art.el, x, y, size, Math.min(1, flash * 0.7)); // adds light: a flare
    } else {
      const size = r * 3;
      const v = art.active;
      const other = v === art.a ? art.b : art.a;
      // Browsers refuse to start video in a hidden page; drawing means it's visible now, so start it.
      if (v.paused && !v.ended) v.play().catch(() => {});
      const left = v.duration - v.currentTime;
      let mix = 0;
      if (Number.isFinite(left) && v.duration > CROSSFADE_S * 3 && left < CROSSFADE_S) {
        if (other.paused) {
          other.currentTime = 0;
          other.play().catch(() => {});
        }
        mix = 1 - Math.max(0, left) / CROSSFADE_S;
      }
      if (v.readyState >= 2) blitFrame(ctx, v, x, y, size, 1 - mix);
      if (mix > 0 && other.readyState >= 2) blitFrame(ctx, other, x, y, size, mix);
      if (v.ended || (mix >= 1)) {
        v.pause();
        art.active = other;
      }
      if (flash > 0.01 && art.active.readyState >= 2) blitFrame(ctx, art.active, x, y, size, Math.min(1, flash * 0.7));
    }
    ctx.globalAlpha = 1;
  }

  // ---------- lightning ----------

  function boltPath(ax, ay, bx, by, rand, rough, depth = 6) {
    let pts = [[ax, ay], [bx, by]];
    let disp = Math.hypot(bx - ax, by - ay) * rough;
    for (let d = 0; d < depth; d++) {
      const next = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[i + 1];
        const len = Math.hypot(x2 - x1, y2 - y1) || 1;
        const off = (rand() * 2 - 1) * disp;
        next.push([(x1 + x2) / 2 - ((y2 - y1) / len) * off, (y1 + y2) / 2 + ((x2 - x1) / len) * off], [x2, y2]);
      }
      pts = next;
      disp *= 0.55;
    }
    return pts;
  }

  function strokePath(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }

  function distanceToPath(pts, x, y) {
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)));
    }
    return best;
  }

  // Brightness over a bolt's life: a strobing burst, a fade, then a faint trace you can still hover.
  function boltAlpha(age) {
    if (age < BURST_S) return 1;
    if (age < DECAY_S) return 1 - ((age - BURST_S) / (DECAY_S - BURST_S)) * 0.85;
    return Math.max(0, 0.15 * (1 - (age - DECAY_S) / (TRACE_S - DECAY_S)));
  }

  class BrainsVisual {
    constructor(canvas, tooltip, onHover) {
      this.canvas = canvas;
      this.tooltip = tooltip;
      this.onHover = onHover || (() => {});
      this.ctx = canvas.getContext("2d");
      this.bolts = [];
      this.waves = [];
      this.sparks = [];
      this.packets = [];
      this.pulses = [];
      this.orbits = { claude: [], mac: [] };
      this.traffic = { toClaude: 0, toMac: 0 };
      this.packetDebt = { toClaude: 0, toMac: 0 };
      this.running = 0;
      this.highlightId = null;
      this.hoverBolt = null;
      this.flash = { claude: 0, mac: 0 };
      this.flareColor = { claude: PALETTE.claude, mac: PALETTE.mac };
      this.screenFlash = { amount: 0, color: [255, 255, 255] };
      this.rand = seeded(Date.now());
      this.arc = null;
      this.arcAt = 0;
      this.start = performance.now();
      this.art = { claude: null, mac: null };
      loadArt("claude", (art) => (this.art.claude = art));
      loadArt("mac", (art) => (this.art.mac = art));
      new ResizeObserver(() => this.layout()).observe(canvas);
      canvas.addEventListener("pointermove", (e) => this.pointer(e));
      canvas.addEventListener("pointerdown", (e) => this.pointer(e));
      canvas.addEventListener("pointerleave", () => this.setHover(null));
      this.layout();
      requestAnimationFrame((now) => this.frame(now));
    }

    layout() {
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w;
      this.h = h;
      // Big brains: each fills most of its half, with room in the middle for the lightning.
      this.r = Math.max(34, Math.min(h * 0.33, w * (w < 760 ? 0.14 : 0.12)));
      this.claudeAt = [w * 0.25, h * 0.52];
      this.macAt = [w * 0.75, h * 0.52];
      this.claudeArt = buildClaude(this.r, dpr);
      this.macArt = buildMac(this.r, dpr);
      for (const bolt of this.bolts) bolt.strands = this.strands(bolt);
    }

    // ----- what the page calls -----

    // Labels that orbit each brain: [{text, color}].
    setOrbits(orbits) {
      this.orbits = { claude: orbits.claude || [], mac: orbits.mac || [] };
    }

    // Messages in the last hour, by direction. Packets flow along the channel in proportion.
    setTraffic(traffic) {
      this.traffic = { toClaude: traffic.toClaude || 0, toMac: traffic.toMac || 0 };
    }

    // A tool call in a running job: a ring pulse on Claude's brain with the tool's name.
    pulse(name) {
      const now = performance.now() / 1000;
      this.pulses.push({ name, born: now, angle: -Math.PI / 2 + (this.rand() - 0.5) * 2.4 });
      if (this.pulses.length > 12) this.pulses.shift();
      this.flash.claude = Math.max(this.flash.claude, 0.35);
    }

    setRunning(count) {
      this.running = count;
    }

    fire(message) {
      const born = performance.now() / 1000;
      const bolt = { message, born, nextStrike: born + 0.06, strikes: 1 };
      bolt.strands = this.strands(bolt);
      this.bolts.push(bolt);
      if (this.bolts.length > 24) this.bolts.shift();
      this.impact(bolt, true);
    }

    highlight(id) {
      this.highlightId = id;
    }

    // ----- strikes -----

    ends(message) {
      const toClaude = message.direction === "to_claude";
      return {
        from: toClaude ? this.macAt : this.claudeAt,
        to: toClaude ? this.claudeAt : this.macAt,
        sender: toClaude ? "mac" : "claude",
        receiver: toClaude ? "claude" : "mac",
      };
    }

    // One solid color per direction, so they can't be confused: blue = MAC to Claude, orange = Claude to MAC,
    // red with a white-hot core = BLOCKED.
    boltColors(message) {
      if (message.blocked && !message.cleared) return { ...PALETTE.blocked, core: [255, 250, 246] };
      return message.direction === "to_claude" ? PALETTE.mac : PALETTE.claude;
    }

    // Every strike: both brains flash, the receiver flares and throws sparks and embers.
    impact(bolt, first) {
      const { to, sender, receiver } = this.ends(bolt.message);
      const colors = this.boltColors(bolt.message);
      this.flash[receiver] = 1;
      this.flash[sender] = Math.max(this.flash[sender], 0.6);
      this.flareColor[receiver] = colors;
      this.flareColor[sender] = colors;
      if (first || bolt.strikes % 3 === 0) this.waves.push({ x: to[0], y: to[1], born: performance.now() / 1000, colors });
      if (reduceMotion) return;
      this.screenFlash = { amount: Math.max(this.screenFlash.amount, first ? (bolt.message.blocked && !bolt.message.cleared ? 0.3 : 0.2) : 0.07), color: colors.mid };
      this.spawnSparks(to, colors, first ? 46 : 18);
    }

    spawnSparks([x, y], colors, count) {
      const now = performance.now() / 1000;
      for (let i = 0; i < count; i++) {
        const ember = this.rand() < 0.3;
        const a = this.rand() * Math.PI * 2;
        const speed = ember ? 20 + this.rand() * 50 : 90 + this.rand() * 260;
        const from = this.r * (0.15 + this.rand() * 0.35);
        this.sparks.push({
          x: x + Math.cos(a) * from, y: y + Math.sin(a) * from,
          vx: Math.cos(a) * speed, vy: Math.sin(a) * speed - (ember ? 15 : 0),
          born: now, life: ember ? 1.2 + this.rand() * 0.9 : 0.35 + this.rand() * 0.6,
          ember, color: this.rand() < 0.35 ? [255, 255, 255] : this.rand() < 0.5 ? colors.core : colors.mid,
        });
      }
      if (this.sparks.length > MAX_SPARKS) this.sparks.splice(0, this.sparks.length - MAX_SPARKS);
    }

    drawSparks(ctx, now, dt) {
      this.sparks = this.sparks.filter((p) => now - p.born < p.life);
      for (const p of this.sparks) {
        const k = 1 - (now - p.born) / p.life;
        p.vy += (p.ember ? 18 : 160) * dt;
        p.vx *= 1 - 1.5 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.ember) {
          ctx.fillStyle = rgba(p.color, 0.85 * k);
          ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
        } else {
          ctx.strokeStyle = rgba(p.color, k);
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.025, p.y - p.vy * 0.025);
          ctx.stroke();
        }
      }
    }

    // 5 to 8 primary bolts core to core, each with forks, sub-forks and fine hair-forks.
    strands(bolt) {
      const { from, to } = this.ends(bolt.message);
      const [sx, sy] = from;
      const [tx, ty] = to;
      const r = this.r;
      const rand = this.rand;
      const out = [];
      const primaries = 5 + Math.floor(rand() * 4);
      for (let i = 0; i < primaries; i++) {
        const lane = primaries === 1 ? 0 : i / (primaries - 1) - 0.5;
        const startY = sy + lane * r * 0.5 + (rand() - 0.5) * r * 0.2;
        const endY = ty + lane * r * 0.7 + (rand() - 0.5) * r * 0.25;
        const weight = i === Math.floor(primaries / 2) ? 1 : 0.5 + rand() * 0.4;
        out.push({ pts: boltPath(sx, startY, tx, endY, rand, 0.13 + rand() * 0.07), weight });
      }
      const heading = Math.atan2(ty - sy, tx - sx);
      const fork = (pts, count, scale, weight, depth) => {
        for (let i = 0; i < count; i++) {
          const at = pts[2 + Math.floor(rand() * (pts.length - 4))];
          const len = r * scale * (0.4 + rand() * 0.9);
          const ang = heading + (rand() < 0.5 ? -1 : 1) * (0.3 + rand() * 1.1);
          const pts2 = boltPath(at[0], at[1], at[0] + Math.cos(ang) * len, at[1] + Math.sin(ang) * len, rand, 0.32, depth);
          out.push({ pts: pts2, weight });
          if (weight > 0.2 && rand() < 0.55) fork(pts2, 1 + Math.floor(rand() * 2), scale * 0.5, weight * 0.55, Math.max(3, depth - 1));
        }
      };
      for (let i = 0; i < primaries; i++) {
        fork(out[i].pts, 4 + Math.floor(rand() * 4), 0.9, 0.42 * out[i].weight + 0.08, 4);
        fork(out[i].pts, 10 + Math.floor(rand() * 8), 0.25, 0.14, 3); // fine hair-forks
      }
      return out;
    }

    // Glow in the direction's color, a white-hot core on the thick channels.
    drawBolt(ctx, bolt, alpha) {
      const c = this.boltColors(bolt.message);
      for (const { pts, weight } of bolt.strands) {
        if (weight > 0.3) {
          ctx.strokeStyle = rgba(c.edge, 0.16 * alpha * weight);
          ctx.lineWidth = 22 * weight;
          strokePath(ctx, pts);
        }
        ctx.strokeStyle = rgba(c.mid, 0.65 * alpha * Math.max(weight, 0.35));
        ctx.lineWidth = Math.max(0.8, 7 * weight);
        strokePath(ctx, pts);
        ctx.strokeStyle = rgba(weight >= 0.5 ? [255, 255, 255] : c.core, Math.min(1, 1.15 * alpha * Math.max(weight, 0.4)));
        ctx.lineWidth = Math.max(0.6, 2.8 * weight);
        strokePath(ctx, pts);
      }
    }

    // The air between the brains lit by the strike.
    drawHaze(ctx, bolt, amount) {
      const c = this.boltColors(bolt.message);
      const mx = (this.claudeAt[0] + this.macAt[0]) / 2;
      const my = (this.claudeAt[1] + this.macAt[1]) / 2;
      const rx = (this.macAt[0] - this.claudeAt[0]) * 0.65;
      ctx.save();
      ctx.translate(mx, my);
      ctx.scale(1, 0.45);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, rgba(c.mid, 0.16 * amount));
      g.addColorStop(1, rgba(c.edge, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    drawWaves(ctx, now) {
      this.waves = this.waves.filter((w) => now - w.born < 0.7);
      for (const w of this.waves) {
        const k = (now - w.born) / 0.7;
        ctx.strokeStyle = rgba(w.colors.mid, 0.8 * (1 - k));
        ctx.lineWidth = 3 * (1 - k) + 0.5;
        ctx.beginPath();
        ctx.arc(w.x, w.y, this.r * (0.4 + k * 1.3), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    drawFlare(ctx, key, at) {
      const f = this.flash[key];
      if (f <= 0.01) return;
      const colors = this.flareColor[key];
      const g = ctx.createRadialGradient(at[0], at[1], 0, at[0], at[1], this.r * 1.7);
      g.addColorStop(0, rgba([255, 255, 255], 0.6 * f));
      g.addColorStop(0.25, rgba(colors.mid, 0.45 * f));
      g.addColorStop(1, rgba(colors.edge, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(at[0], at[1], this.r * 1.7, 0, Math.PI * 2);
      ctx.fill();
    }

    drawRunningArc(ctx, now) {
      if (!this.arc || now - this.arcAt > (reduceMotion ? 5 : 0.11)) {
        const [ax, ay] = this.claudeAt;
        const [bx, by] = this.macAt;
        this.arc = [boltPath(ax, ay, bx, by, this.rand, 0.05), boltPath(ax, ay + this.r * 0.1, bx, by - this.r * 0.1, this.rand, 0.04)];
        this.arcAt = now;
      }
      const g = ctx.createLinearGradient(this.claudeAt[0], 0, this.macAt[0], 0);
      const a = 0.22 + 0.08 * Math.sin(now * 5);
      g.addColorStop(0, rgba(PALETTE.claude.mid, a));
      g.addColorStop(0.5, rgba([230, 235, 255], a * 0.8));
      g.addColorStop(1, rgba(PALETTE.mac.mid, a));
      ctx.strokeStyle = g;
      ctx.lineWidth = 1;
      for (const pts of this.arc) strokePath(ctx, pts);
    }

    drawBackground(ctx) {
      ctx.fillStyle = "#020306";
      ctx.fillRect(0, 0, this.w, this.h);
      const glowAt = (x, y, color) => {
        const g = ctx.createRadialGradient(x, y, 0, x, y, this.r * 3.2);
        g.addColorStop(0, rgba(color, 0.14));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, this.w, this.h);
      };
      glowAt(...this.claudeAt, PALETTE.claude.edge);
      glowAt(...this.macAt, PALETTE.mac.edge);
      // A faint engineering grid, with crosshairs through each brain.
      ctx.strokeStyle = "rgba(80,200,255,0.05)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0.5; x < this.w; x += 32) { ctx.moveTo(x, 0); ctx.lineTo(x, this.h); }
      for (let y = 0.5; y < this.h; y += 32) { ctx.moveTo(0, y); ctx.lineTo(this.w, y); }
      ctx.stroke();
      for (const [[x, y], c] of [[this.claudeAt, PALETTE.claude.mid], [this.macAt, PALETTE.mac.mid]]) {
        ctx.strokeStyle = rgba(c, 0.12);
        ctx.setLineDash([2, 6]);
        ctx.beginPath();
        ctx.moveTo(x - this.r * 1.9, y); ctx.lineTo(x + this.r * 1.9, y);
        ctx.moveTo(x, y - this.r * 1.6); ctx.lineTo(x, y + this.r * 1.6);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = rgba(c, 0.22);
        ctx.beginPath();
        ctx.arc(x, y, this.r * 1.52, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(255,255,255,0.02)";
      for (let y = 0; y < this.h; y += 3) ctx.fillRect(0, y, this.w, 1);
    }

    // The channel between the brains: two faint lanes, and packets riding them (real traffic).
    channelPoint(dir, lane, k) {
      const toClaude = dir === "to_claude";
      const [sx, sy] = toClaude ? this.macAt : this.claudeAt;
      const [tx, ty] = toClaude ? this.claudeAt : this.macAt;
      const x0 = sx + (toClaude ? -1 : 1) * this.r * 1.1;
      const x1 = tx + (toClaude ? 1 : -1) * this.r * 1.1;
      const bend = (toClaude ? 1 : -1) * this.r * 0.42 + lane;
      const cx = (x0 + x1) / 2;
      const cy = (sy + ty) / 2 + bend;
      const u = 1 - k;
      return [u * u * x0 + 2 * u * k * cx + k * k * x1, u * u * sy + 2 * u * k * cy + k * k * ty];
    }

    drawChannel(ctx, now, dt) {
      ctx.setLineDash([3, 7]);
      for (const dir of ["to_claude", "to_mac"]) {
        const c = dir === "to_claude" ? PALETTE.mac : PALETTE.claude;
        ctx.strokeStyle = rgba(c.mid, 0.16);
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i <= 24; i++) {
          const [x, y] = this.channelPoint(dir, 0, i / 24);
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (!reduceMotion) {
        for (const [key, dir] of [["toClaude", "to_claude"], ["toMac", "to_mac"]]) {
          // 1 message in the last hour -> a packet every ~12 s; 10 -> about one a second.
          const rate = Math.min(3, this.traffic[key] * 0.085);
          this.packetDebt[key] += rate * dt;
          while (this.packetDebt[key] >= 1) {
            this.packetDebt[key] -= 1;
            this.packets.push({ dir, born: now, dur: 1.4 + this.rand() * 0.9, lane: (this.rand() - 0.5) * this.r * 0.35 });
          }
        }
      }
      this.packets = this.packets.filter((p) => now - p.born < p.dur);
      for (const p of this.packets) {
        const k = (now - p.born) / p.dur;
        const c = p.dir === "to_claude" ? PALETTE.mac : PALETTE.claude;
        for (let i = 0; i < 6; i++) {
          const kk = Math.max(0, k - i * 0.018);
          const [x, y] = this.channelPoint(p.dir, p.lane * Math.sin(Math.PI * kk), kk);
          ctx.fillStyle = rgba(i === 0 ? [255, 255, 255] : c.mid, (i === 0 ? 0.95 : 0.5) * (1 - i / 6));
          const sz = i === 0 ? 2.6 : 2;
          ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
        }
      }
    }

    drawPulses(ctx, now) {
      this.pulses = this.pulses.filter((p) => now - p.born < 1.8);
      const [x, y] = this.claudeAt;
      for (const p of this.pulses) {
        const k = (now - p.born) / 1.8;
        ctx.strokeStyle = rgba(PALETTE.claude.core, 0.7 * (1 - k));
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, this.r * (1.05 + k * 0.7), 0, Math.PI * 2);
        ctx.stroke();
        const d = this.r * (1.2 + k * 0.5);
        ctx.fillStyle = rgba([255, 209, 102], 1 - k);
        ctx.font = `700 ${Math.round(Math.max(11, this.r * 0.08))}px ui-monospace, Menlo, monospace`;
        ctx.textAlign = "center";
        ctx.fillText(`▸ ${p.name}`, x + Math.cos(p.angle) * d, y + Math.sin(p.angle) * d);
      }
    }

    // Labels riding a ring around a brain, readable on both halves of the circle.
    drawOrbit(ctx, at, items, t, spinDir) {
      if (!items.length) return;
      const [cx, cy] = at;
      const R = this.r * 1.32;
      const size = Math.round(Math.max(9, Math.min(12, this.r * 0.065)));
      ctx.font = `600 ${size}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const cw = ctx.measureText("M").width;
      const spin = reduceMotion ? 0 : t * 0.05 * spinDir;
      items.forEach((item, i) => {
        const mid = spin + (i / items.length) * Math.PI * 2 - Math.PI / 2;
        const bottom = Math.sin(mid) > 0;
        const chars = [...item.text];
        const span = (chars.length * cw) / R;
        ctx.fillStyle = item.color;
        ctx.globalAlpha = 0.85;
        chars.forEach((ch, k) => {
          const offset = (k + 0.5) * (cw / R) - span / 2;
          const a = bottom ? mid - offset : mid + offset;
          ctx.save();
          ctx.translate(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
          ctx.rotate(bottom ? a - Math.PI / 2 : a + Math.PI / 2);
          ctx.fillText(ch, 0, 0);
          ctx.restore();
        });
        const dotA = mid - (span / 2 + cw / R) * (bottom ? -1 : 1);
        ctx.fillRect(cx + Math.cos(dotA) * R - 1.5, cy + Math.sin(dotA) * R - 1.5, 3, 3);
      });
      ctx.globalAlpha = 1;
      ctx.textBaseline = "alphabetic";
    }

    drawLabels(ctx) {
      const size = Math.round(Math.max(11, Math.min(15, this.r * 0.085)));
      ctx.font = `700 ${size}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = "center";
      const y = Math.min(this.h - 10, this.claudeAt[1] + this.r * 1.62);
      ctx.fillStyle = rgba(PALETTE.claude.mid, 0.95);
      ctx.fillText("[ CLAUDE ]", this.claudeAt[0], y);
      ctx.fillStyle = rgba(PALETTE.mac.mid, 0.95);
      ctx.fillText("[ MAC · GROK BOT ]", this.macAt[0], y);
    }

    frame(nowMs) {
      requestAnimationFrame((n) => this.frame(n));
      if (!this.w) return;
      const now = nowMs / 1000;
      const t = reduceMotion ? 0 : (nowMs - this.start) / 1000;
      const ctx = this.ctx;
      ctx.globalCompositeOperation = "source-over";
      this.drawBackground(ctx);
      ctx.globalCompositeOperation = "lighter";

      this.bolts = this.bolts.filter((b) => now - b.born < TRACE_S || b === this.hoverBolt);
      for (const key of ["claude", "mac"]) this.flash[key] = Math.max(0, this.flash[key] - 0.03);

      if (this.art.claude) drawArt(ctx, this.art.claude, ...this.claudeAt, this.r, t, this.flash.claude);
      else drawClaude(ctx, this.claudeArt, ...this.claudeAt, this.r, t, this.flash.claude);
      if (this.art.mac) drawArt(ctx, this.art.mac, ...this.macAt, this.r, t, this.flash.mac);
      else drawMac(ctx, this.macArt, ...this.macAt, this.r, t, this.flash.mac);
      this.drawFlare(ctx, "claude", this.claudeAt);
      this.drawFlare(ctx, "mac", this.macAt);
      if (this.running > 0) this.drawRunningArc(ctx, now);

      const dt = Math.min(0.05, now - (this.lastFrame || now));
      this.lastFrame = now;
      this.drawChannel(ctx, now, dt);
      this.drawPulses(ctx, now);
      for (const bolt of this.bolts) {
        const age = now - bolt.born;
        const bursting = age < BURST_S && !reduceMotion;
        if (bursting && now >= bolt.nextStrike) {
          // Re-strike on a fresh jagged path, at an erratic beat.
          bolt.strands = this.strands(bolt);
          bolt.strikes += 1;
          bolt.nextStrike = now + 0.055 + this.rand() * 0.055;
          this.impact(bolt, false);
        }
        const lit = bolt === this.hoverBolt || bolt.message.id === this.highlightId;
        let alpha = boltAlpha(age);
        if (bursting) {
          alpha = 0.45 + 0.55 * this.rand(); // strobe, never fully dark
          this.drawHaze(ctx, bolt, alpha);
        }
        this.drawBolt(ctx, bolt, lit ? Math.max(alpha, 0.6) : alpha);
      }
      this.drawSparks(ctx, now, dt);
      this.drawWaves(ctx, now);

      if (this.screenFlash.amount > 0.005) {
        ctx.fillStyle = rgba(this.screenFlash.color, this.screenFlash.amount);
        ctx.fillRect(0, 0, this.w, this.h);
        this.screenFlash.amount *= 0.8;
      }
      ctx.globalCompositeOperation = "source-over";
      this.drawOrbit(ctx, this.claudeAt, this.orbits.claude, t, 1);
      this.drawOrbit(ctx, this.macAt, this.orbits.mac, t, -1);
      this.drawLabels(ctx);
    }

    // ----- hover -----

    pointer(event) {
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const now = performance.now() / 1000;
      let found = null;
      for (let i = this.bolts.length - 1; i >= 0 && !found; i--) {
        const bolt = this.bolts[i];
        if (boltAlpha(now - bolt.born) < 0.02) continue;
        if (bolt.strands.slice(0, 3).some((s) => distanceToPath(s.pts, x, y) < 10)) found = bolt;
      }
      this.setHover(found, x, y);
    }

    setHover(bolt, x, y) {
      this.hoverBolt = bolt;
      this.canvas.style.cursor = bolt ? "pointer" : "default";
      this.onHover(bolt ? bolt.message.id : null);
      if (!bolt) {
        this.tooltip.hidden = true;
        return;
      }
      showTooltip(this.tooltip, bolt.message);
      const tw = this.tooltip.offsetWidth;
      this.tooltip.style.left = `${Math.max(8, Math.min(this.w - tw - 8, x + 14))}px`;
      this.tooltip.style.top = `${Math.max(8, Math.min(this.h - this.tooltip.offsetHeight - 8, y + 14))}px`;
    }
  }

  function directionLabel(message) {
    return message.direction === "to_claude" ? "MAC → Claude" : "Claude → MAC";
  }

  function showTooltip(node, message) {
    const head = document.createElement("strong");
    head.textContent = `${directionLabel(message)} · ${KIND_LABELS[message.kind] || message.kind}${message.blocked && !message.cleared ? " · BLOCKED" : message.cleared ? " · cleared" : ""}`;
    const body = document.createElement("span");
    body.textContent = message.text || "";
    node.replaceChildren(head, body);
    node.className = `bolt-tip ${message.blocked && !message.cleared ? "blocked" : message.direction}`;
    node.hidden = false;
  }

  window.BrainsVisual = BrainsVisual;
  window.BrainsVisual.motion = { calm: reduceMotion, choice: motionChoice, systemCalm };
  window.BrainsVisual.setMotion = (choice) => {
    try {
      localStorage.setItem(MOTION_KEY, choice);
    } catch (e) {
      // can't remember it; the reload below still applies nothing new, so tell the caller
      return false;
    }
    location.reload(); // artwork and animation loops are set up at load
    return true;
  };
  window.BrainsVisual.kindLabel = (kind) => KIND_LABELS[kind] || kind;
  window.BrainsVisual.directionLabel = directionLabel;
})();
