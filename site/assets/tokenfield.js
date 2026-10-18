// Fig. 3: the context bill, to scale.
// Every square is one Continuity briefing (2,442 tokens after 267 messages). The transcript
// a fresh agent would otherwise reread is 2,769,083 tokens: 1,134 of those squares.
// On first view the squares fill in reading order while the counter runs up, hold, then all
// converge into the first square, the one Continuity actually hands over. The transcript readout
// counts up with the fill; the briefing readout lights when the merge lands.
// Numbers are from eval/results/scale.json.

import { token } from './theme.js';
import { stillMotion } from './motion.js';

const TRANSCRIPT = 2769083;
const BRIEFING = 2442;
const CELLS = Math.round(TRANSCRIPT / BRIEFING); // 1,134

const FILL_MS = 1700;
const HOLD_MS = 700;
const MERGE_MS = 1500;
const ECHO_MS = 500;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const fmt = (n) => Math.round(n).toLocaleString('en-US');

export function setupTokenField(fig) {
  const canvas = fig.querySelector('canvas');
  const count = fig.querySelector('[data-count]');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let colours = read();
  let cells = [];
  let layout = { w: 0, h: 0, dpr: 1, size: 8, pitch: 10, cols: 1 };
  let started = 0;
  let frameId = 0;

  function read() {
    return { ink: token('--ink'), muted: token('--muted'), faint: token('--line-2'), signal: token('--signal') };
  }

  function measure() {
    const w = canvas.parentElement.clientWidth;
    const pitch = w > 640 ? 10 : 7;
    const size = pitch - 2;
    const cols = Math.max(10, Math.floor((w + 2) / pitch));
    const rows = Math.ceil(CELLS / cols);
    const h = rows * pitch - 2;
    layout = { w, h, dpr: Math.min(2, devicePixelRatio || 1), size, pitch, cols };
    canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * layout.dpr);
    canvas.height = Math.round(h * layout.dpr);

    const far = Math.hypot(cols, rows);
    cells = Array.from({ length: CELLS }, (_, i) => {
      const cx = i % cols;
      const cy = Math.floor(i / cols);
      return {
        x: cx * pitch,
        y: cy * pitch,
        fillAt: (i / CELLS) * FILL_MS * 0.85 + Math.random() * FILL_MS * 0.15,
        mergeAt: (1 - Math.hypot(cx, cy) / far) * MERGE_MS * 0.45 + Math.random() * 120,
      };
    });
  }

  function draw(now) {
    frameId = 0;
    const { w, h, dpr, size } = layout;
    const t = stillMotion ? Infinity : started ? now - started : 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const mergeStart = FILL_MS + HOLD_MS;
    const echoStart = mergeStart + MERGE_MS;
    const home = cells[0];

    // the empty grid comes back once everything has merged, so the ratio stays readable
    const echo = clamp01((t - echoStart) / ECHO_MS);
    if (echo > 0) {
      ctx.globalAlpha = echo;
      ctx.fillStyle = colours.faint;
      ctx.beginPath();
      for (let i = 1; i < cells.length; i++) ctx.rect(cells[i].x, cells[i].y, size, size);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = colours.muted;
    for (let i = 1; i < cells.length; i++) {
      const c = cells[i];
      const fill = clamp01((t - c.fillAt) / 220);
      if (fill <= 0) continue;
      const m = easeInOut(clamp01((t - mergeStart - c.mergeAt) / (MERGE_MS * 0.55)));
      if (m >= 1) continue;
      const s = size * (0.4 + 0.6 * fill) * (1 - 0.5 * m);
      const x = c.x + (home.x - c.x) * m + (size - s) / 2;
      const y = c.y + (home.y - c.y) * m + (size - s) / 2;
      ctx.globalAlpha = fill * (1 - m * m);
      ctx.fillRect(x, y, s, s);
    }
    ctx.globalAlpha = 1;

    // the one square that remains
    const won = clamp01((t - mergeStart) / 500);
    ctx.fillStyle = won > 0 ? colours.ink : colours.muted;
    if (t > home.fillAt) ctx.fillRect(home.x, home.y, size, size);
    const ring = (t - echoStart) / 1100;
    if (ring > 0 && ring < 1) {
      ctx.strokeStyle = colours.signal;
      ctx.globalAlpha = 1 - ring;
      ctx.lineWidth = 1.5;
      const r = size / 2 + ring * 16;
      ctx.strokeRect(home.x + size / 2 - r, home.y + size / 2 - r, r * 2, r * 2);
      ctx.globalAlpha = 1;
    }

    // the transcript readout follows the fill; the briefing readout lights once the squares merge
    if (count) count.textContent = fmt(TRANSCRIPT * easeInOut(clamp01(t / FILL_MS)));
    fig.classList.toggle('merged', t >= echoStart);

    if (t < echoStart + 1200) frameId = requestAnimationFrame(draw);
  }

  const kick = () => { if (!frameId) frameId = requestAnimationFrame(draw); };

  new ResizeObserver(() => { measure(); kick(); }).observe(canvas.parentElement);
  addEventListener('themechange', () => { colours = read(); kick(); });
  fig.querySelector('[data-replay]')?.addEventListener('click', () => { started = performance.now(); kick(); });

  measure();
  if (stillMotion) { kick(); return; }
  if (count) count.textContent = '0';
  const watch = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    watch.disconnect();
    started = performance.now();
    kick();
  }, { threshold: 0.6 });
  watch.observe(canvas);
  kick();
}
