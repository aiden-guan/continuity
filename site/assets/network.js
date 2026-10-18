// The hero's background: a faint field of agents talking to each other.
//
// Agents are small outlined squares (Fig. 1's glyph) scattered round the copy, never under it.
// Neighbours are joined by dotted hairlines, the way Fig. 1 draws a thread's future. Every so
// often two of them strike up a conversation: a message runs along the link and draws it solid
// as it goes, the receiver blinks, then answers or hands the thread to a neighbour. A link is
// solid only while it is in use.
// Now and then the agent about to speak dies mid-conversation. A beat later a fresh one wakes
// in its place, marked once in signal, and sends the message anyway: the thread outlives it.
// Everything is drawn at a whisper; it sits behind the copy and should never pull the eye.

import { token } from './theme.js';
import { stillMotion } from './motion.js';

const SPEED = 150;          // px/s, a message in flight
const KEEP_OUT = 26;        // clearance round the copy
const DEATH_EVERY = 14000;  // ms, at the soonest

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v) => { v = clamp01(v); return v * v * (3 - 2 * v); };
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export function setupHeroNetwork(hero) {
  const wrap = hero.querySelector('.wrap');
  const canvas = document.createElement('canvas');
  canvas.className = 'hero-net';
  canvas.setAttribute('aria-hidden', 'true');
  hero.prepend(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); return; }
  const layer = document.createElement('canvas'); // the standing links, drawn once per layout
  const lctx = layer.getContext('2d');

  const read = () => ({ ink: token('--ink'), faint: token('--faint'), bg: token('--bg'), signal: token('--signal') });
  let colors = read();
  let w = 0, h = 0, dpr = 1;
  let agents = [];
  let edges = [];
  let convs = [];
  let sparks = [];
  let clock = 0;            // ms, only advances while drawn, so a hidden tab doesn't fast-forward
  let last = 0;
  let nextStart = 1800;
  let lastDeath = 4000 - DEATH_EVERY; // the first death waits a few seconds
  let laidOut = false;
  let frameId = 0;
  let inView = true;

  // ------------------------------------------------------------ layout
  // the copy's line boxes, so nothing sits or runs under the words themselves
  function copyBoxes(box) {
    const out = [];
    for (const el of hero.querySelectorAll('.hero-h, .lede, .cta-row')) {
      const range = document.createRange();
      range.selectNodeContents(el);
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        out.push({ l: r.left - box.left, t: r.top - box.top, r: r.right - box.left, b: r.bottom - box.top });
      }
    }
    return out;
  }

  function layout() {
    canvas.style.height = `${wrap.getBoundingClientRect().height}px`;
    const box = canvas.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    w = box.width;
    h = box.height;
    dpr = Math.min(2, devicePixelRatio || 1);
    for (const c of [canvas, layer]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }

    const copy = copyBoxes(box);
    const blocked = (x, y, pad) => copy.some((r) => x > r.l - pad && x < r.r + pad && y > r.t - pad && y < r.b + pad);
    const crosses = (a, b) => {
      const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8);
      for (let i = 1; i < n; i++) if (blocked(a.x + (b.x - a.x) * (i / n), a.y + (b.y - a.y) * (i / n), 8)) return true;
      return false;
    };

    // scattered, but never bunched: dart-throwing with a minimum gap
    const spacing = Math.max(96, Math.min(150, Math.sqrt((w * h) / 34)));
    const want = Math.round((w * h) / (spacing * spacing));
    const pts = [];
    for (let tries = 0; tries < want * 60 && pts.length < want; tries++) {
      const x = 28 + Math.random() * (w - 56);
      const y = 100 + Math.random() * (h - 160);
      if (blocked(x, y, KEEP_OUT)) continue;
      if (pts.some((p) => (p.x - x) ** 2 + (p.y - y) ** 2 < (spacing * 0.78) ** 2)) continue;
      pts.push({ x, y });
    }

    // each agent knows its three nearest, as long as the link doesn't run under the copy
    const found = [];
    const seen = new Set();
    pts.forEach((p, i) => {
      pts.map((q, j) => ({ j, d: Math.hypot(q.x - p.x, q.y - p.y) }))
        .filter((o) => o.j !== i && o.d < spacing * 1.8)
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .forEach(({ j, d }) => {
          const key = Math.min(i, j) * 1000 + Math.max(i, j);
          if (seen.has(key) || crosses(p, pts[j])) return;
          seen.add(key);
          found.push({ a: i, b: j, len: d });
        });
    });

    // an agent with nobody to talk to is left out
    const index = new Map();
    pts.forEach((p, i) => { if (found.some((e) => e.a === i || e.b === i)) index.set(i, index.size); });
    const born = laidOut ? () => -1e9 : () => 700 + Math.random() * 1400;
    agents = [...index.keys()].map((i) => ({ ...pts[i], nb: [], born: born(), died: null, wake: null, fill: 0, pulse: -1e9, busy: false }));
    edges = found.map((e) => ({ a: index.get(e.a), b: index.get(e.b), len: e.len, lit: -1e9 }));
    for (const e of edges) { agents[e.a].nb.push({ j: e.b, e }); agents[e.b].nb.push({ j: e.a, e }); }
    convs = [];
    sparks = [];
    laidOut = true;
    drawLayer();
  }

  function drawLayer() {
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    lctx.clearRect(0, 0, w, h);
    lctx.fillStyle = colors.faint;
    for (const e of edges) {
      const A = agents[e.a], B = agents[e.b];
      const n = Math.floor(e.len / 6);
      for (let i = 1; i < n; i++) {
        lctx.fillRect(Math.round(A.x + (B.x - A.x) * (i / n)), Math.round(A.y + (B.y - A.y) * (i / n)), 1, 1);
      }
    }
  }

  // ------------------------------------------------------------ conversations
  const edgeOf = (i, j) => agents[i].nb.find((n) => n.j === j)?.e;
  const free = (i) => !agents[i].busy;

  function startConversation() {
    const ready = agents.map((_, i) => i).filter((i) => free(i) && agents[i].nb.some((n) => free(n.j)));
    if (!ready.length) return;
    const from = pick(ready);
    const to = pick(agents[from].nb.filter((n) => free(n.j))).j;
    agents[from].busy = agents[to].busy = true;
    convs.push({ from, to, left: 2 + Math.floor(Math.random() * 4), phase: 'think', at: clock, wait: 400 + Math.random() * 600 });
  }

  function step(dt) {
    for (const a of agents) a.fill = Math.max(0, a.fill - dt / 420);
    const most = Math.max(1, Math.min(4, Math.round(agents.length / 7)));
    if (clock > nextStart && convs.length < most) {
      startConversation();
      nextStart = clock + 900 + Math.random() * 1700;
    }

    for (const c of convs) {
      const since = clock - c.at;
      if (c.phase === 'think') {
        // the speaker fills as it composes
        agents[c.from].fill = Math.max(agents[c.from].fill, Math.min(1, since / c.wait));
        if (since < c.wait) continue;
        if (clock - lastDeath > DEATH_EVERY && Math.random() < 0.15) {
          lastDeath = clock;
          agents[c.from].died = clock;
          burst(agents[c.from]);
          c.phase = 'gone';
          c.at = clock;
          continue;
        }
        c.phase = 'fly';
        c.at = clock;
        c.dur = Math.max(520, (edgeOf(c.from, c.to).len / SPEED) * 1000);
      } else if (c.phase === 'fly') {
        if (since < c.dur) continue;
        const to = agents[c.to];
        to.pulse = clock;
        edgeOf(c.from, c.to).lit = clock;
        if (--c.left <= 0) {
          agents[c.from].busy = to.busy = false;
          c.done = true;
          continue;
        }
        // answer, or pass the thread on to a neighbour
        const prev = c.from;
        let next = prev;
        const onward = to.nb.filter((n) => n.j !== prev && free(n.j));
        if (onward.length && Math.random() < 0.3) {
          next = pick(onward).j;
          agents[prev].busy = false;
          agents[next].busy = true;
        }
        c.from = c.to;
        c.to = next;
        c.phase = 'think';
        c.at = clock;
        c.wait = 300 + Math.random() * 700;
      } else if (c.phase === 'gone') {
        // a beat with nobody there; the other side keeps waiting
        if (since < 1400) continue;
        agents[c.from] = { ...agents[c.from], born: clock, died: null, wake: clock, fill: 0, pulse: -1e9 };
        c.phase = 'think';
        c.at = clock;
        c.wait = 900;
      }
    }
    convs = convs.filter((c) => !c.done);
  }

  function burst(a) {
    for (let k = 0; k < 7; k++) {
      const ang = Math.random() * Math.PI * 2;
      const v = 0.006 + Math.random() * 0.014;
      sparks.push({ x: a.x, y: a.y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, born: clock });
    }
  }

  // ------------------------------------------------------------ drawing
  function line(a, b) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  const square = (x, y, s) => [Math.round(x - s) + 0.5, Math.round(y - s) + 0.5, Math.round(s * 2), Math.round(s * 2)];

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = colors.ink;

    // standing links
    ctx.globalAlpha = 0.6 * smooth((clock - 300) / 1800);
    ctx.drawImage(layer, 0, 0, w, h);

    // a link firms up while in use, then lets go
    for (const e of edges) {
      const k = 1 - (clock - e.lit) / 2400;
      if (k <= 0) continue;
      ctx.globalAlpha = 0.12 * smooth(k);
      line(agents[e.a], agents[e.b]);
    }

    // messages draw their link as they go
    ctx.fillStyle = colors.ink;
    for (const c of convs) {
      if (c.phase !== 'fly') continue;
      const A = agents[c.from], B = agents[c.to];
      const k = easeInOut(clamp01((clock - c.at) / c.dur));
      const p = { x: A.x + (B.x - A.x) * k, y: A.y + (B.y - A.y) * k };
      ctx.globalAlpha = 0.12;
      line(A, p);
      ctx.globalAlpha = 0.5;
      ctx.fillRect(Math.round(p.x) - 1, Math.round(p.y) - 1, 3, 3);
    }

    // what's left of an agent that died
    for (const s of sparks) {
      const t = (clock - s.born) / 1000;
      ctx.globalAlpha = 0.35 * (1 - t);
      ctx.fillRect(Math.round(s.x + s.vx * (clock - s.born)), Math.round(s.y + s.vy * (clock - s.born)), 2, 2);
    }
    sparks = sparks.filter((s) => clock - s.born < 1000);

    for (const a of agents) {
      let alpha = smooth((clock - a.born) / 600);
      if (a.died != null) alpha *= 1 - smooth((clock - a.died) / 450);
      if (alpha <= 0.01) continue;

      // a message arrived: a square opens out from the receiver
      const p = (clock - a.pulse) / 800;
      if (p < 1) {
        ctx.globalAlpha = 0.2 * (1 - p) * alpha;
        ctx.strokeRect(...square(a.x, a.y, 3 + p * 9));
      }

      ctx.globalAlpha = alpha;
      ctx.fillStyle = colors.bg; // knock the dotted link out under the glyph
      ctx.fillRect(Math.round(a.x) - 3, Math.round(a.y) - 3, 6, 6);
      if (a.fill > 0.01) {
        ctx.globalAlpha = alpha * 0.4 * a.fill;
        ctx.fillStyle = colors.ink;
        ctx.fillRect(Math.round(a.x) - 2, Math.round(a.y) - 2, 5, 5);
      }
      ctx.globalAlpha = alpha * 0.3;
      ctx.strokeRect(...square(a.x, a.y, 2.5));

      // the one that woke to carry on, marked once in signal
      const woke = a.wake != null ? 1 - clamp01((clock - a.wake) / 2200) : 0;
      if (woke > 0) {
        ctx.strokeStyle = colors.signal;
        ctx.globalAlpha = 0.75 * woke;
        ctx.strokeRect(...square(a.x, a.y, 2.5));
        ctx.globalAlpha = 0.4 * woke * woke;
        ctx.strokeRect(...square(a.x, a.y, 3 + (1 - woke) * 12));
        ctx.strokeStyle = colors.ink;
      }
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    frameId = 0;
    const dt = last ? Math.min(50, now - last) : 16;
    last = now;
    clock += dt;
    step(dt);
    draw();
    if (inView) frameId = requestAnimationFrame(frame);
  }

  const kick = () => {
    if (stillMotion) { clock = 1e6; draw(); return; }
    if (!frameId && inView) { last = 0; frameId = requestAnimationFrame(frame); }
  };

  // ------------------------------------------------------------ wiring
  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (laidOut) { layout(); kick(); } }, 120);
  }).observe(wrap);
  new IntersectionObserver(([e]) => { inView = e.isIntersecting; kick(); }).observe(canvas);
  addEventListener('themechange', () => { colors = read(); drawLayer(); kick(); });

  // wait for the type, so the copy's boxes are where they'll stay
  (document.fonts?.ready ?? Promise.resolve()).then(() => { layout(); kick(); });
}
