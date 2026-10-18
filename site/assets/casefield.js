// Fig. 3: every held-out case, to scale.
// One square per case in the benchmark's held-out eval split: 650 frozen cases, the same Haiku agent
// with and without Continuity. On first view the squares fill in reading order as Primitive alone
// scored them (320 right) while its readout counts up, hold, then a playhead sweeps across and
// switches Continuity on: the 192 cases only it got right light in the signal colour, the 65 only
// Primitive alone got right go hollow, and the 255 both got right turn to ink (447 right).
// Counts are from bench/FINDINGS.md at d2b1386 (held-out run opt-final2-eval-all).

import { token } from './theme.js';
import { stillMotion } from './motion.js';

// the paired outcome of every case, laid out in this order
const BOTH = 255;    // right with and without Continuity
const GAINED = 192;  // right only with Continuity
const LOST = 65;     // right only without it
const NEITHER = 138; // right with neither
const CASES = BOTH + GAINED + LOST + NEITHER; // 650
const ALONE = ((BOTH + LOST) / CASES) * 100;  // 49.2%

const FILL_MS = 1600;
const HOLD_MS = 700;
const SWEEP_MS = 1500;
const POP_MS = 320;
const PAD = 6; // room for the playhead above and below the grid

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const kindOf = (i) => (i < BOTH ? 'both' : i < BOTH + GAINED ? 'gained' : i < BOTH + GAINED + LOST ? 'lost' : 'none');

export function setupCaseField(fig) {
  const canvas = fig.querySelector('canvas');
  const count = fig.querySelector('[data-count]');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let colours = read();
  let cells = [];
  let layout = { w: 0, h: 0, dpr: 1, size: 8, gridW: 0 };
  let started = 0;
  let frameId = 0;

  function read() {
    return { ink: token('--ink'), muted: token('--muted'), empty: token('--line-2'), signal: token('--signal') };
  }

  // 650 tiles cleanly as 65 × 10, 50 × 13 or 26 × 25: take the widest that keeps squares legible
  function measure() {
    const w = canvas.parentElement.clientWidth;
    const cols = [65, 50, 26].find((c) => w / c >= 9) ?? 26;
    const pitch = Math.max(4, Math.floor(w / cols));
    const gap = pitch >= 12 ? 3 : 2;
    const size = pitch - gap;
    const gridW = cols * pitch - gap;
    const h = Math.ceil(CASES / cols) * pitch - gap + PAD * 2;
    layout = { w, h, dpr: Math.min(2, devicePixelRatio || 1), size, gridW };
    canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * layout.dpr);
    canvas.height = Math.round(h * layout.dpr);

    cells = Array.from({ length: CASES }, (_, i) => {
      const x = (i % cols) * pitch;
      return {
        x,
        y: Math.floor(i / cols) * pitch + PAD,
        kind: kindOf(i),
        fillAt: (i / CASES) * FILL_MS * 0.85 + Math.random() * FILL_MS * 0.15,
        switchAt: ((x + size / 2) / gridW) * SWEEP_MS, // when the playhead crosses the square
      };
    });
  }

  function square(c, s, colour, alpha) {
    if (alpha <= 0) return;
    const o = (layout.size - s) / 2;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colour;
    ctx.fillRect(c.x + o, c.y + o, s, s);
  }

  function draw(now) {
    frameId = 0;
    const { w, h, dpr, size, gridW } = layout;
    const t = stillMotion ? Infinity : started ? now - started : 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const sweep = t - FILL_MS - HOLD_MS; // ms since the playhead set off
    const done = FILL_MS + HOLD_MS + SWEEP_MS + POP_MS;

    for (const c of cells) {
      const fill = clamp01((t - c.fillAt) / 220);
      if (fill <= 0) continue;
      const s = size * (0.4 + 0.6 * easeOut(fill));
      const on = clamp01((sweep - c.switchAt) / POP_MS); // 0 as Primitive alone scored it, 1 with Continuity

      if (c.kind === 'both') {
        square(c, s, colours.muted, fill);
        square(c, s, colours.ink, fill * on);
      } else if (c.kind === 'gained') {
        square(c, s, colours.empty, fill * (1 - on));
        square(c, s * (1 + 0.45 * Math.sin(Math.PI * on)), colours.signal, on);
      } else if (c.kind === 'lost') {
        square(c, s, colours.muted, fill * (1 - on));
        if (on > 0) {
          ctx.globalAlpha = on;
          ctx.strokeStyle = colours.muted;
          ctx.lineWidth = 1;
          ctx.strokeRect(c.x + 0.5, c.y + 0.5, size - 1, size - 1);
        }
      } else {
        square(c, s, colours.empty, fill);
      }
    }

    // the playhead: an ink rule with the signal square at its head, as on the hero thread
    if (sweep > 0 && sweep < SWEEP_MS) {
      const x = Math.round((sweep / SWEEP_MS) * gridW);
      ctx.globalAlpha = Math.min(1, sweep / 160, (SWEEP_MS - sweep) / 160);
      ctx.fillStyle = colours.ink;
      ctx.fillRect(x - 1, 0, 2, h);
      ctx.fillStyle = colours.signal;
      ctx.fillRect(x - 3, 0, 6, 6);
    }
    ctx.globalAlpha = 1;

    // Primitive alone's readout follows the fill; Continuity's lights once the playhead lands
    if (count) count.textContent = `${(ALONE * easeInOut(clamp01(t / FILL_MS))).toFixed(1)}%`;
    fig.classList.toggle('merged', sweep >= SWEEP_MS);

    if (started && t < done) frameId = requestAnimationFrame(draw);
  }

  const kick = () => { if (!frameId) frameId = requestAnimationFrame(draw); };

  new ResizeObserver(() => { measure(); kick(); }).observe(canvas.parentElement);
  addEventListener('themechange', () => { colours = read(); kick(); });
  fig.querySelector('[data-replay]')?.addEventListener('click', () => { started = performance.now(); kick(); });

  measure();
  if (stillMotion) { kick(); return; }
  if (count) count.textContent = '0.0%';
  const watch = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    watch.disconnect();
    started = performance.now();
    kick();
  }, { threshold: 0.6 });
  watch.observe(canvas);
  kick();
}
