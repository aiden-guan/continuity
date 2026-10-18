// The hero's first line, "Agents forget.", drawn as ink particles.
//
// The line is sampled from the real DOM text (same font, size and position), one particle
// per grid cell, so at rest it reads as a halftone print of the heading. Every particle has
// one number, t, between home (0) and the thread (1):
//   · on load the letters rise out of the Fig. 1 thread (t falls from 1 to 0)
//   · scrolling dissolves the line back into the thread, right to left, swirling like ink in water
//   · a few particles of "forget." keep drifting off and coming back
//   · the pointer pushes particles aside; they spring home
// Position is a pure function of t and the clock, so scrolling back up reassembles the line.
// The DOM text stays in place (transparent) for selection, find-in-page and screen readers.

import { token } from './theme.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const INTRO_MS = 1500;   // one particle's trip from the thread to its letter
const INTRO_SPREAD = 900; // first to last particle leaving the thread
const PUSH_RADIUS = 90;

export function setupHeroParticles({ hero, line, thread }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'hero-px';
  canvas.setAttribute('aria-hidden', 'true');
  hero.prepend(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return fail();

  let ink = token('--ink');
  let parts = [];
  let dot = 2;
  let view = { w: 0, h: 0, dpr: 1, lineY: 0 };
  let pointer = null;
  let introAt = 0;
  let shown = 0;   // the dissolve as drawn: it eases after the scroll, so a fast flick still plays out
  let lastNow = 0;
  let frameId = 0;
  let inView = true;
  let ready = false; // set once the webfont is in, so the samples match the real type

  function fail() {
    document.documentElement.classList.remove('px');
    canvas.remove();
  }

  // ------------------------------------------------------------ sampling
  function sample() {
    const box = hero.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) { parts = []; return; }
    view.dpr = Math.min(2, devicePixelRatio || 1);
    view.w = box.width;
    view.h = box.height;
    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);

    const style = getComputedStyle(line);
    const size = parseFloat(style.fontSize);
    const font = `${style.fontWeight} ${size}px ${style.fontFamily}`;
    const spacing = parseFloat(style.letterSpacing) || 0;

    const off = document.createElement('canvas');
    off.width = Math.ceil(view.w);
    off.height = Math.ceil(view.h);
    const g = off.getContext('2d', { willReadFrequently: true });
    g.font = font;
    if ('letterSpacing' in g) g.letterSpacing = `${spacing}px`;
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#000';

    // each word separately, so a wrapped line still lands on the right spot
    for (const word of line.querySelectorAll('.pw')) {
      const r = word.getBoundingClientRect();
      const m = g.measureText(word.textContent);
      const asc = m.fontBoundingBoxAscent ?? size * 0.92;
      const desc = m.fontBoundingBoxDescent ?? size * 0.24;
      const baseline = r.top - box.top + (r.height - (asc + desc)) / 2 + asc;
      g.save();
      g.translate(r.left - box.left, baseline);
      g.scale(r.width / Math.max(1, m.width), 1);
      g.fillText(word.textContent, 0, 0);
      g.restore();
    }

    // the thread line in Fig. 1 (landing.js draws it at 60% of the canvas height)
    const tb = thread.getBoundingClientRect();
    const margin = Math.max(20, Math.min(tb.width * 0.05, 64));
    const lineY = tb.top - box.top + Math.round(tb.height * 0.6);
    const lineA = tb.left - box.left + margin;
    const lineB = tb.right - box.left - margin;
    view.lineY = lineY;

    const step = Math.max(2, Math.round(size / 42));
    dot = Math.max(1.3, step * 0.74);
    const data = g.getImageData(0, 0, off.width, off.height).data;
    const lineBox = line.getBoundingClientRect();
    const left = lineBox.left - box.left;
    const span = Math.max(1, lineBox.width);
    const forgetFrom = line.querySelector('.pw:last-child').getBoundingClientRect().left - box.left;

    const next = [];
    for (let y = Math.floor(step / 2); y < off.height; y += step) {
      for (let x = Math.floor(step / 2); x < off.width; x += step) {
        if (data[(y * off.width + x) * 4 + 3] < 110) continue;
        const across = clamp01((x - left) / span);
        // letters land in order along the thread: the left of the line to its left end
        const tx = lineA + across * (lineB - lineA) + (Math.random() - 0.5) * 8;
        next.push({
          hx: x, hy: y,
          tx, ty: lineY,
          // assembly runs left to right; dissolving starts at the end of "forget."
          inDelay: across * 0.55 + Math.random() * 0.45,
          outDelay: (1 - across) * 0.7 + Math.random() * 0.3,
          swirl: 6 + Math.random() * 22,
          angle: Math.random() * Math.PI * 2,
          spin: (Math.random() - 0.5) * 3.5,
          flake: x > forgetFrom && Math.random() < 0.07,
          phase: Math.random() * Math.PI * 2,
          period: 5200 + Math.random() * 5200,
          ox: 0, oy: 0,
        });
      }
    }
    parts = next;
  }

  // ------------------------------------------------------------ frame
  function frame(now) {
    frameId = 0;
    const { w, h, dpr } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // done by the time the thread has risen to 30% of the screen, so the landing is always in view
    const heroTop = hero.getBoundingClientRect().top;
    const scrolled = clamp01(-heroTop / Math.max(260, view.lineY - innerHeight * 0.3));
    const dt = lastNow ? Math.min(64, now - lastNow) : 16;
    lastNow = now;
    shown += (scrolled - shown) * (1 - Math.exp(-dt / 420));
    if (Math.abs(scrolled - shown) < 0.0005) shown = scrolled;
    const since = now - introAt;

    ctx.fillStyle = ink;
    ctx.beginPath(); // every fully opaque particle goes into one path
    let moving = shown !== scrolled;

    for (const p of parts) {
      const intro = 1 - easeOut(clamp01((since - p.inDelay * INTRO_SPREAD) / INTRO_MS));
      const out = clamp01((shown - p.outDelay * 0.4) / 0.6);
      let flake = 0;
      if (p.flake) {
        const s = Math.max(0, Math.sin(now / p.period * Math.PI * 2 + p.phase));
        flake = 0.24 * s * s * s;
      }
      const t = Math.max(intro, out, flake);
      if (t > 0) moving = true;

      const e = easeInOut(t);
      const arc = Math.sin(Math.PI * t) * p.swirl;
      const ang = p.angle + t * p.spin + now * 0.00035;
      let x = p.hx + (p.tx - p.hx) * e + Math.cos(ang) * arc;
      let y = p.hy + (p.ty - p.hy) * e + Math.sin(ang) * arc * 0.55;

      // the pointer pushes letters aside; they spring back
      let pushX = 0;
      let pushY = 0;
      if (pointer && t < 0.4) {
        const dx = x - pointer.x;
        const dy = y - pointer.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < PUSH_RADIUS * PUSH_RADIUS) {
          const d = Math.sqrt(d2) || 1;
          const f = Math.pow(1 - d / PUSH_RADIUS, 2) * 28;
          pushX = (dx / d) * f;
          pushY = (dy / d) * f;
        }
      }
      p.ox += (pushX - p.ox) * 0.14;
      p.oy += (pushY - p.oy) * 0.14;
      if (Math.abs(p.ox) + Math.abs(p.oy) > 0.05) moving = true;
      x += p.ox;
      y += p.oy;

      // fully visible all the way down; they only fade once they are on the thread
      const alpha = 1 - smooth(0.95, 1, t);
      if (alpha <= 0.01) continue;
      const s = dot * (1 - 0.3 * t);
      if (alpha > 0.99) {
        ctx.rect(x - s / 2, y - s / 2, s, s);
      } else {
        ctx.globalAlpha = alpha;
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
        ctx.globalAlpha = 1;
      }
    }
    ctx.fill();

    // flakes keep the line alive, so it only sleeps offscreen
    if (inView && (moving || parts.some((p) => p.flake))) frameId = requestAnimationFrame(frame);
  }

  const kick = () => {
    if (frameId || !inView) return;
    lastNow = 0;
    frameId = requestAnimationFrame(frame);
  };

  // ------------------------------------------------------------ wiring
  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (ready) { sample(); kick(); } }, 80);
  }).observe(hero);

  new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    kick();
  }).observe(hero);

  addEventListener('scroll', kick, { passive: true });
  addEventListener('themechange', () => { ink = token('--ink'); kick(); });
  hero.addEventListener('pointermove', (ev) => {
    if (ev.pointerType !== 'mouse') return;
    const box = hero.getBoundingClientRect();
    pointer = { x: ev.clientX - box.left, y: ev.clientY - box.top };
    kick();
  });
  hero.addEventListener('pointerleave', () => { pointer = null; kick(); });

  (document.fonts?.ready ?? Promise.resolve()).then(() => {
    ready = true;
    sample();
    if (!parts.length) return fail();
    introAt = performance.now();
    kick();
  });
}
