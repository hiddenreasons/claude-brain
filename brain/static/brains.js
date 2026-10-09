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
  const STRIKE1_END = 0.09;
  const STRIKE2_AT = 0.15;
  const STRIKE2_END = 0.26;
  const DECAY_S = 1.4;
  const TRACE_S = 45;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

  // ---------- lightning ----------

  function boltPath(ax, ay, bx, by, rand, rough) {
    let pts = [[ax, ay], [bx, by]];
    let disp = Math.hypot(bx - ax, by - ay) * rough;
    for (let depth = 0; depth < 6; depth++) {
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

  // Brightness over a bolt's life: strike, a short dip, a second strike, then a fading trace.
  function boltAlpha(age) {
    if (age < STRIKE1_END) return 1;
    if (age < STRIKE2_AT) return reduceMotion ? 1 : 0.25;
    if (age < STRIKE2_END) return 1;
    if (age < DECAY_S) return 1 - ((age - STRIKE2_END) / (DECAY_S - STRIKE2_END)) * 0.85;
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
      this.r = Math.max(30, Math.min(h * 0.36, w * 0.13));
      this.claudeAt = [Math.max(this.r * 1.45, w * 0.17), h * 0.5];
      this.macAt = [Math.min(w - this.r * 1.45, w * 0.83), h * 0.5];
      this.claudeArt = buildClaude(this.r, dpr);
      this.macArt = buildMac(this.r, dpr);
      for (const bolt of this.bolts) bolt.strands = this.strands(bolt);
    }

    // ----- what the page calls -----

    setRunning(count) {
      this.running = count;
    }

    fire(message) {
      const bolt = { message, born: performance.now() / 1000, secondDone: false };
      bolt.strands = this.strands(bolt);
      this.bolts.push(bolt);
      if (this.bolts.length > 24) this.bolts.shift();
      this.impact(bolt);
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
      if (message.blocked) return { ...PALETTE.blocked, core: [255, 250, 246] };
      return message.direction === "to_claude" ? PALETTE.mac : PALETTE.claude;
    }

    impact(bolt) {
      const { to, sender, receiver } = this.ends(bolt.message);
      const colors = this.boltColors(bolt.message);
      this.flash[receiver] = 1;
      this.flash[sender] = Math.max(this.flash[sender], 0.6);
      this.flareColor[receiver] = colors;
      this.flareColor[sender] = colors;
      this.waves.push({ x: to[0], y: to[1], born: performance.now() / 1000, colors });
      if (!reduceMotion) this.screenFlash = { amount: bolt.message.blocked ? 0.3 : 0.18, color: colors.mid };
    }

    strands(bolt) {
      const { from, to } = this.ends(bolt.message);
      const [sx, sy] = from;
      const [tx, ty] = to;
      const r = this.r;
      const out = [];
      // A main channel and two side channels, from core to core.
      for (let i = 0; i < 3; i++) {
        const spread = (i === 0 ? 0 : i === 1 ? -1 : 1) * r * 0.3 + (this.rand() - 0.5) * r * 0.12;
        out.push({ pts: boltPath(sx, sy + spread * 0.5, tx, ty + spread, this.rand, i === 0 ? 0.16 : 0.12), weight: i === 0 ? 1 : 0.6 });
      }
      // Forks off the main channel, some with their own forks.
      const forkFrom = (pts, count, scale, weight) => {
        for (let i = 0; i < count; i++) {
          const at = pts[6 + Math.floor(this.rand() * (pts.length - 12))];
          const len = r * scale * (0.5 + this.rand() * 0.9);
          const ang = Math.atan2(ty - sy, tx - sx) + (this.rand() < 0.5 ? -1 : 1) * (0.35 + this.rand() * 0.9);
          const fork = boltPath(at[0], at[1], at[0] + Math.cos(ang) * len, at[1] + Math.sin(ang) * len, this.rand, 0.3);
          out.push({ pts: fork, weight });
          if (weight > 0.3 && this.rand() < 0.6) forkFrom(fork, 1, scale * 0.5, weight * 0.55);
        }
      };
      forkFrom(out[0].pts, 5, 1, 0.5);
      return out;
    }

    drawBolt(ctx, bolt, alpha) {
      const c = this.boltColors(bolt.message);
      for (const { pts, weight } of bolt.strands) {
        ctx.strokeStyle = rgba(c.edge, 0.18 * alpha * weight);
        ctx.lineWidth = 18 * weight;
        strokePath(ctx, pts);
        ctx.strokeStyle = rgba(c.mid, 0.6 * alpha * weight);
        ctx.lineWidth = 6 * weight;
        strokePath(ctx, pts);
        ctx.strokeStyle = rgba(c.core, Math.min(1, 1.1 * alpha * weight));
        ctx.lineWidth = Math.max(1, 2.6 * weight);
        strokePath(ctx, pts);
      }
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
      ctx.fillStyle = "#06070a";
      ctx.fillRect(0, 0, this.w, this.h);
      const glowAt = (x, y, color) => {
        const g = ctx.createRadialGradient(x, y, 0, x, y, this.r * 3);
        g.addColorStop(0, rgba(color, 0.12));
        g.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, this.w, this.h);
      };
      glowAt(...this.claudeAt, PALETTE.claude.edge);
      glowAt(...this.macAt, PALETTE.mac.edge);
      ctx.fillStyle = "rgba(255,255,255,0.025)";
      for (let y = 0; y < this.h; y += 3) ctx.fillRect(0, y, this.w, 1);
    }

    drawLabels(ctx) {
      ctx.font = "600 11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = rgba(PALETTE.claude.mid, 0.9);
      ctx.fillText("CLAUDE", this.claudeAt[0], this.h - 10);
      ctx.fillStyle = rgba(PALETTE.mac.mid, 0.9);
      ctx.fillText("MAC · GROK BOT", this.macAt[0], this.h - 10);
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

      drawClaude(ctx, this.claudeArt, ...this.claudeAt, this.r, t, this.flash.claude);
      drawMac(ctx, this.macArt, ...this.macAt, this.r, t, this.flash.mac);
      this.drawFlare(ctx, "claude", this.claudeAt);
      this.drawFlare(ctx, "mac", this.macAt);
      if (this.running > 0) this.drawRunningArc(ctx, now);

      for (const bolt of this.bolts) {
        const age = now - bolt.born;
        if (!reduceMotion && !bolt.secondDone && age >= STRIKE2_AT) {
          bolt.secondDone = true; // the second strike takes a fresh path, like real lightning
          bolt.strands = this.strands(bolt);
          this.impact(bolt);
        }
        const lit = bolt === this.hoverBolt || bolt.message.id === this.highlightId;
        const alpha = boltAlpha(age);
        this.drawBolt(ctx, bolt, lit ? Math.max(alpha, 0.6) : alpha);
      }
      this.drawWaves(ctx, now);

      if (this.screenFlash.amount > 0.005) {
        ctx.fillStyle = rgba(this.screenFlash.color, this.screenFlash.amount);
        ctx.fillRect(0, 0, this.w, this.h);
        this.screenFlash.amount *= 0.8;
      }
      ctx.globalCompositeOperation = "source-over";
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
    head.textContent = `${directionLabel(message)} · ${KIND_LABELS[message.kind] || message.kind}${message.blocked ? " · BLOCKED" : ""}`;
    const body = document.createElement("span");
    body.textContent = message.text || "";
    node.replaceChildren(head, body);
    node.className = `bolt-tip ${message.blocked ? "blocked" : message.direction}`;
    node.hidden = false;
  }

  window.BrainsVisual = BrainsVisual;
  window.BrainsVisual.kindLabel = (kind) => KIND_LABELS[kind] || kind;
  window.BrainsVisual.directionLabel = directionLabel;
})();
