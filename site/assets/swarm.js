// The announcement line, printed by a flock.
//
// The text is sampled from the real DOM line into halftone dots, like the hero's "Agents forget."
// A ribbon of birds flies one shared path; each bird is that path a little in the past, swung
// off it sideways, so the flock reads as one murmuration with a signal square at its head.
//   · on load every dot of the line rides in inside the flock, and drops out onto its letter
//     as the head passes it, so the line is printed left to right
//   · at rest the flock loops through the line, above and below the rules; letters it crosses
//     churn in its wake and knit back
//   · hovering the link sends the flock back across the line, harder
//   · the pointer pushes letters aside; they spring home
// The DOM text stays (transparent) for selection and screen readers.

import { token } from './theme.js';
import { stillMotion } from './motion.js';

const PAD = 44;       // the flock may swoop this far above and below the bar
const INTRO = 2.1;    // s, the first pass that prints the line
const PASS = 1.15;    // s, a hover pass
const BIRDS = 96;
const WAKE = 26;
const PUSH = 40;
const K = 0.045;      // letter spring
const DAMP = 0.84;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v) => { v = clamp01(v); return v * v * (3 - 2 * v); };
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function setupSwarm(bar) {
  const canvas = bar.querySelector('canvas');
  const ctx = canvas?.getContext('2d');
  const off = () => { bar.classList.add('off'); canvas?.remove(); };
  if (stillMotion || !ctx) return off();
  const link = bar.querySelector('.ann-link');
  const text = bar.querySelector('.ann-t');

  // each word in its own box, so a wrapped line samples where it really sits
  const words = text.textContent.trim().split(/\s+/);
  text.textContent = '';
  words.forEach((word, i) => {
    if (i) text.append(' ');
    const span = document.createElement('span');
    span.textContent = word;
    text.append(span);
  });

  let ink = token('--ink');
  let signal = token('--signal');
  let w = 0, h = 0, dpr = 1;
  let left = 0, right = 0;  // the line's extent
  let dot = 1.4;
  let letters = [];
  let t0 = 0;
  let passAt = -1e9;
  let pointer = null;
  let inView = true;
  let frameId = 0;
  let last = 0;

  const birds = Array.from({ length: BIRDS }, (_, i) => ({
    lag: i === 0 ? 0 : 0.03 + Math.pow(Math.random(), 0.8) * 0.9,
    wob: i === 0 ? 0 : 4 + Math.random() * 22,
    f: 1.2 + Math.random() * 2.2,
    ph: Math.random() * Math.PI * 2,
    r: 0.6 + Math.random() * 0.9,
    a: 0.35 + Math.random() * 0.55,
  }));

  // ------------------------------------------------------------ the path
  // at rest: a slow figure that crosses the whole bar and loops out past both rules
  // (only just past the top one, which sits under the nav)
  function rest(s) {
    const ax = w / 2 - 24;
    return {
      x: w / 2 + ax * 0.82 * Math.sin(s * 0.33 + 4.2) + ax * 0.16 * Math.sin(s * 0.91),
      y: h / 2 + (Math.sin(s * 1.07) < 0 ? h / 2 + 6 : h / 2 + PAD * 0.6) * Math.sin(s * 1.07) * (0.65 + 0.35 * Math.sin(s * 0.21)),
    };
  }
  // along the line, from before the first word to past the last
  const sweep = (k) => ({
    x: left - 40 + (right - left + 90) * k,
    y: h / 2 + Math.sin(k * Math.PI * 3) * h * 0.14,
  });
  const mix = (a, b, e) => ({ x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e });

  function path(s) {
    let p = rest(s);
    const ie = 1 - smooth((s - INTRO) / 0.9);
    if (ie > 0) p = mix(p, sweep(easeInOut(clamp01(s / INTRO))), ie);
    const ps = s - passAt;
    if (ps > 0 && ps < PASS + 0.9) {
      const pe = smooth(ps / 0.35) * (1 - smooth((ps - PASS) / 0.9));
      p = mix(p, sweep(easeInOut(clamp01((ps - 0.15) / PASS))), pe);
    }
    return p;
  }
  // a point on the path, swung sideways off it
  function along(s, swing) {
    const a = path(s - 0.012), b = path(s + 0.012), p = path(s);
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    return { x: p.x - (dy / d) * swing, y: p.y + (dx / d) * swing };
  }

  // ------------------------------------------------------------ sampling
  function sample(carried) {
    const box = bar.getBoundingClientRect();
    if (box.width < 1) return false;
    w = box.width;
    h = box.height;
    dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round((h + PAD * 2) * dpr);

    const style = getComputedStyle(text);
    const size = parseFloat(style.fontSize);
    const S = 3; // oversampled, so thin strokes survive
    const g = Object.assign(document.createElement('canvas'), { width: Math.ceil(w * S), height: Math.ceil(h * S) })
      .getContext('2d', { willReadFrequently: true });
    g.scale(S, S);
    g.font = `${style.fontWeight} ${size}px ${style.fontFamily}`;
    if ('letterSpacing' in g) g.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
    g.fillStyle = '#000';
    left = Infinity;
    right = 0;
    for (const span of text.children) {
      const r = span.getBoundingClientRect();
      const m = g.measureText(span.textContent);
      const asc = m.fontBoundingBoxAscent ?? size * 0.92;
      const desc = m.fontBoundingBoxDescent ?? size * 0.24;
      const x = r.left - box.left;
      g.save();
      g.translate(x, r.top - box.top + (r.height - (asc + desc)) / 2 + asc);
      g.scale(r.width / Math.max(1, m.width), 1);
      g.fillText(span.textContent, 0, 0);
      g.restore();
      left = Math.min(left, x);
      right = Math.max(right, x + r.width);
    }

    // fine grain: about a device pixel and a half per dot, so at rest the line reads as type
    const step = Math.max(0.8, 1.6 / dpr);
    dot = step * 0.9;
    const data = g.getImageData(0, 0, g.canvas.width, g.canvas.height).data;
    const W = g.canvas.width;
    const next = [];
    for (let y = step / 2; y < h; y += step) {
      for (let x = step / 2; x < w; x += step) {
        if (!(data[(Math.round(y * S) * W + Math.round(x * S)) * 4 + 3] >= 100)) continue; // past the edge reads undefined
        const p = {
          hx: x, hy: y, x, y, vx: 0, vy: 0,
          carried,
          lag: 0.02 + Math.random() * 0.5,
          wob: (Math.random() - 0.5) * 2 * (4 + Math.random() * 14),
          f: 1 + Math.random() * 2.5,
          ph: Math.random() * Math.PI * 2,
          drop: -12 + Math.random() * 70, // how far past this dot the head is when it lets go
        };
        if (carried) Object.assign(p, along(-p.lag, p.wob));
        next.push(p);
      }
    }
    letters = next;
    return letters.length > 0;
  }

  // ------------------------------------------------------------ frame
  function frame(now) {
    frameId = 0;
    const dt = last ? Math.min(2.5, (now - last) / 16.67) : 1;
    last = now;
    const s = (now - t0) / 1000;
    const head = path(s);
    const busy = s < INTRO + 0.6 || s - passAt < PASS + 0.6;
    const wake = busy ? 0.62 : 0.2;
    // the ribbon, sampled: where the flock was over the last half second
    const ribbon = [0, 0.07, 0.15, 0.24, 0.35, 0.48].map((l) => path(s - l));
    const damp = Math.pow(DAMP, dt);
    // the pointer stirs while it moves; a resting cursor lets the letters close up again
    const stir = pointer ? Math.max(0, 1 - (now - pointer.at) / 450) : 0;

    ctx.setTransform(dpr, 0, 0, dpr, 0, PAD * dpr);
    ctx.clearRect(0, -PAD, w, h + PAD * 2);

    // ---- the line
    ctx.fillStyle = ink;
    ctx.beginPath();
    for (const p of letters) {
      if (p.carried) {
        const q = along(s - p.lag, p.wob * (0.7 + 0.3 * Math.sin(s * p.f + p.ph)));
        p.vx = (q.x - p.x) / dt;
        p.vy = (q.y - p.y) / dt;
        p.x = q.x;
        p.y = q.y;
        if (head.x > p.hx + p.drop || s > INTRO + 0.3) p.carried = false;
      } else {
        let fx = (p.hx - p.x) * K;
        let fy = (p.hy - p.y) * K;
        for (const q of ribbon) {
          const dx = p.x - q.x, dy = p.y - q.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > WAKE * WAKE || d2 < 0.01) continue;
          const d = Math.sqrt(d2);
          const f = (1 - d / WAKE) ** 2 * wake;
          // outward and round: a swirl, so letters churn rather than just part
          fx += (dx * 0.55 - dy) / d * f;
          fy += (dy * 0.55 + dx) / d * f;
        }
        if (stir > 0.01) {
          const dx = p.x - pointer.x, dy = p.y - pointer.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < PUSH * PUSH && d2 > 0.01) {
            const d = Math.sqrt(d2);
            const f = (1 - d / PUSH) ** 2 * 1.6 * stir;
            fx += dx / d * f;
            fy += dy / d * f;
          }
        }
        p.vx = (p.vx + fx * dt) * damp;
        p.vy = (p.vy + fy * dt) * damp;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      ctx.rect(p.x - dot / 2, p.y - dot / 2, dot, dot);
    }
    ctx.fill();

    // ---- the flock: each bird with a short stalk of where it just was
    ctx.lineCap = 'round';
    for (let i = birds.length - 1; i >= 0; i--) {
      const b = birds[i];
      const swing = (u) => b.wob * Math.sin(u * b.f + b.ph);
      const p = along(s - b.lag, swing(s));
      const q = along(s - b.lag - 0.04, swing(s - 0.04));
      const color = i === 0 ? signal : ink;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.globalAlpha = (i === 0 ? 1 : b.a) * 0.45;
      ctx.lineWidth = i === 0 ? 1.4 : b.r;
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.globalAlpha = i === 0 ? 1 : b.a;
      if (i === 0) ctx.fillRect(p.x - 2.5, p.y - 2.5, 5, 5);
      else { ctx.beginPath(); ctx.arc(p.x, p.y, b.r, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.globalAlpha = 1;

    if (inView) frameId = requestAnimationFrame(frame);
  }

  const kick = () => { if (!frameId && inView && t0) { last = 0; frameId = requestAnimationFrame(frame); } };

  // ------------------------------------------------------------ wiring
  bar.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const box = bar.getBoundingClientRect();
    pointer = { x: e.clientX - box.left, y: e.clientY - box.top, at: performance.now() };
  });
  bar.addEventListener('pointerleave', () => { pointer = null; });
  const pass = () => {
    const s = (performance.now() - t0) / 1000;
    if (s > INTRO + 0.9 && s - passAt > PASS + 0.9) passAt = s;
  };
  link.addEventListener('pointerenter', pass);
  link.addEventListener('focus', pass);

  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (t0) sample(false); }, 80);
  }).observe(bar);
  new IntersectionObserver(([e]) => { inView = e.isIntersecting; kick(); }).observe(bar);
  addEventListener('themechange', () => { ink = token('--ink'); signal = token('--signal'); });

  (document.fonts?.ready ?? Promise.resolve()).then(() => {
    if (!sample(true)) return off();
    t0 = performance.now();
    kick();
  });
}
