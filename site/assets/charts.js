// Results line charts (under the leaderboard) and the competitor boards.
// Every number is copied from a checked-in result; the source sits beside each chart's data.
// Lines draw left to right when a chart scrolls in (Primitive alone first, then Continuity in signal);
// hovering or dragging across a chart reads both values at that point.
import { countUp, stillMotion } from './motion.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.append(n);
  return n;
};

const WAKES = Array.from({ length: 50 }, (_, i) => i + 1);
const tokens = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : `${Math.round(v)}`);
const tokenTick = (v) => (v === 0 ? '0' : v >= 1e6 ? `${v / 1e6}M` : `${v / 1e3}k`);
const pct = (v) => `${Math.round(v)}%`;
const usd = (v) => `$${v.toFixed(4)}`;

const CHARTS = {
  // eval/results/scale.json (node eval/scale.ts): estimated context tokens as one deal's thread grows
  context: {
    x: [10, 17, 37, 73, 137, 267], unit: 'messages', ticks: [0, 1e6, 2e6, 3e6], max: 3e6, fmt: tokens, tick: tokenTick,
    series: [
      { name: 'Full thread', v: [1569, 3908, 19375, 84609, 448626, 2769089] },
      { name: 'Continuity', me: true, v: [989, 1058, 1165, 1375, 1481, 1596] },
    ],
  },
  // bench/value/RESULTS.md, final engine: cold-handoff success by dependency depth (84 cases × 3 trials)
  depth: {
    x: [1, 2, 4, 6], unit: 'depth', ticks: [0, 50, 100], max: 100, fmt: pct, tick: pct,
    series: [
      { name: 'Primitive alone', v: [64, 42, 47, 36] },
      { name: 'Continuity', me: true, v: [86, 83, 78, 81] },
    ],
  },
  // bench/results/value-fig1-merged/economics.md: (one-time + W × per-wake) / (W × success)
  cost: {
    x: WAKES, unit: 'wakes', ticks: [0, 0.005, 0.01], max: 0.014, fmt: usd, tick: (v) => (v === 0 ? '0' : `$${v}`),
    series: [
      { name: 'Primitive alone', v: WAKES.map(() => 0.00503 / 0.417) },
      { name: 'Continuity', me: true, v: WAKES.map((w) => (0.00732 + 0.00229 * w) / (0.742 * w)) },
    ],
  },
  // same table: Continuity 60,066 tokens once, then 9,518 a wake; Primitive alone 25,559 a wake
  tokens: {
    x: WAKES, unit: 'wakes', ticks: [0, 5e5, 1e6], max: 1.4e6, fmt: tokens, tick: tokenTick,
    series: [
      { name: 'Primitive alone', v: WAKES.map((w) => 25559 * w) },
      { name: 'Continuity', me: true, v: WAKES.map((w) => 60066 + 9518 * w) },
    ],
  },
};

const M = { top: 12, right: 100, bottom: 24, left: 44 };

function drawChart(fig) {
  const spec = CHARTS[fig.dataset.chart];
  const plot = fig.querySelector('.lc-plot');
  if (!spec || !plot) return;
  const W = Math.max(240, plot.clientWidth);
  const H = plot.clientHeight || 210;
  const x0 = spec.x[0];
  const x1 = spec.x.at(-1);
  const X = (x) => M.left + ((x - x0) / (x1 - x0)) * (W - M.left - M.right);
  const Y = (y) => H - M.bottom - (Math.min(y, spec.max) / spec.max) * (H - M.top - M.bottom);

  plot.replaceChildren();
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': fig.querySelector('figcaption b')?.textContent ?? '' }, plot);

  const grid = svg('g', { class: 'grid' }, root);
  for (const t of spec.ticks) {
    svg('line', { x1: M.left, x2: W - M.right, y1: Y(t), y2: Y(t), class: t === 0 ? 'axis' : '' }, grid);
    svg('text', { x: M.left - 8, y: Y(t) + 3.5, 'text-anchor': 'end', class: 'tick' }, grid).textContent = spec.tick(t);
  }
  // x ticks at the data points: first and last always, the rest only where they clear their neighbours
  const cand = spec.x.length > 8 ? [1, 10, 25, 50] : spec.x;
  const xt = [];
  for (const t of [cand.at(-1), cand[0], ...cand.slice(1, -1)]) if (xt.every((k) => Math.abs(X(k) - X(t)) >= 30)) xt.push(t);
  for (const t of xt) svg('text', { x: X(t), y: H - 6, 'text-anchor': 'middle', class: 'tick' }, grid).textContent = t;
  svg('text', { x: W - 2, y: H - 6, 'text-anchor': 'end', class: 'tick unit' }, grid).textContent = spec.unit;

  // the end labels: value over name, nudged apart when two lines finish close together
  const ends = spec.series.map((s) => ({ s, y: Y(s.v.at(-1)) }));
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 30) ends[i].y = ends[i - 1].y + 30;
  // keep the lowest label clear of the axis row
  const floor = H - M.bottom - 18;
  for (let i = ends.length - 1; i >= 0; i--) ends[i].y = Math.min(ends[i].y, i === ends.length - 1 ? floor : ends[i + 1].y - 30);

  for (const s of spec.series) {
    const d = s.v.map((v, i) => `${i ? 'L' : 'M'}${X(spec.x[i]).toFixed(1)},${Y(v).toFixed(1)}`).join('');
    svg('path', { d, pathLength: 1, class: `s${s.me ? ' me' : ''}` }, root);
    if (spec.x.length <= 8) for (let i = 0; i < s.v.length; i++) svg('circle', { cx: X(spec.x[i]), cy: Y(s.v[i]), r: 3, class: `pt${s.me ? ' me' : ''}` }, root);
  }
  for (const { s, y } of ends) {
    const ex = X(x1) + 10;
    svg('text', { x: ex, y: y + 2, class: `end${s.me ? ' me' : ''}` }, root).textContent = spec.fmt(s.v.at(-1));
    svg('text', { x: ex, y: y + 15, class: `end-n${s.me ? ' me' : ''}` }, root).textContent = s.name;
  }

  // read both values under the pointer
  const hover = svg('g', { class: 'hover' }, root);
  const rule = svg('line', { y1: M.top, y2: H - M.bottom }, hover);
  const marks = spec.series.map((s) => ({
    s,
    dot: svg('circle', { r: 4, class: s.me ? 'me' : '' }, hover),
    label: svg('text', { class: `hv${s.me ? ' me' : ''}` }, hover),
  }));
  const xLabel = svg('text', { y: H - 6, 'text-anchor': 'middle', class: 'tick hv-x' }, hover);
  const show = (clientX) => {
    const r = root.getBoundingClientRect();
    const px = ((clientX - r.left) / r.width) * W;
    let i = 0;
    for (let k = 1; k < spec.x.length; k++) if (Math.abs(X(spec.x[k]) - px) < Math.abs(X(spec.x[i]) - px)) i = k;
    const hx = X(spec.x[i]);
    rule.setAttribute('x1', hx);
    rule.setAttribute('x2', hx);
    const left = hx > (W - M.right) * 0.62;
    const placed = marks.map((m) => ({ m, y: Y(m.s.v[i]) })).sort((a, b) => a.y - b.y);
    for (let k = 1; k < placed.length; k++) if (placed[k].y - placed[k - 1].y < 16) placed[k].y = placed[k - 1].y + 16;
    for (const { m, y } of placed) {
      m.dot.setAttribute('cx', hx);
      m.dot.setAttribute('cy', Y(m.s.v[i]));
      m.label.setAttribute('x', left ? hx - 9 : hx + 9);
      m.label.setAttribute('y', y - 7);
      m.label.setAttribute('text-anchor', left ? 'end' : 'start');
      m.label.textContent = spec.fmt(m.s.v[i]);
    }
    xLabel.setAttribute('x', hx);
    xLabel.textContent = spec.x[i];
    hover.classList.add('show');
    fig.classList.add('reading');
  };
  const hide = () => { hover.classList.remove('show'); fig.classList.remove('reading'); };
  plot.onpointermove = (e) => show(e.clientX);
  plot.onpointerdown = (e) => show(e.clientX);
  plot.onpointerleave = hide;
  plot.onpointercancel = hide;
}

function setupLineCharts() {
  const figs = [...document.querySelectorAll('.lc[data-chart]')];
  if (!figs.length) return;
  figs.forEach(drawChart);
  let width = innerWidth;
  addEventListener('resize', () => {
    if (innerWidth === width) return;
    width = innerWidth;
    figs.forEach((f) => { drawChart(f); if (f.classList.contains('on')) f.classList.add('on'); });
  });
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      requestAnimationFrame(() => e.target.classList.add('on'));
      e.target.querySelectorAll('.end').forEach((t, i) => countUp(t, { delay: 1300 + i * 120, duration: 1100 }));
    }
  }, { rootMargin: '0px 0px -12% 0px' });
  figs.forEach((f) => (stillMotion ? f.classList.add('on') : io.observe(f)));
}

function setupBoards() {
  const boards = [...document.querySelectorAll('.rk')];
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      e.target.querySelectorAll('.v').forEach((v, i) => countUp(v, { delay: 250 + i * 110, duration: 1200 }));
    }
  }, { rootMargin: '0px 0px -8% 0px' });
  boards.forEach((b) => io.observe(b));
}

// Hovering the summary row widens it and slams in the memory-cost multiples one at a time, each followed by
// a jolt of the row that grows with the number. Touch screens play it once when the row scrolls in.
function setupCheaper() {
  const row = document.querySelector('.stats-more');
  if (!row) return;
  const slams = [...row.querySelectorAll('.slam')];
  let timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  const jolt = (amp) => {
    row.style.setProperty('--amp', amp);
    row.classList.remove('jolt');
    void row.offsetWidth; // restart the animation
    row.classList.add('jolt');
  };
  let isOpen = false;
  const open = () => {
    if (isOpen) return; // already open: re-entering must not restart the slams
    isOpen = true;
    timers.forEach(clearTimeout);
    timers = [];
    // opening shrinks the four numbers; hold the row's height so it never slides out from under the pointer
    row.style.minHeight = `${row.offsetHeight}px`;
    row.classList.add('open');
    if (stillMotion) { row.classList.add('still'); return; }
    slams.forEach((s, i) => later(420 + i * 680, () => {
      s.classList.add('hit');
      later(290, () => jolt(i ? 10 : 5)); // the moment the number lands
    }));
  };
  const close = () => {
    if (!isOpen) return;
    isOpen = false;
    timers.forEach(clearTimeout);
    timers = [];
    row.classList.remove('open', 'jolt', 'still');
    row.style.minHeight = '';
    slams.forEach((s) => s.classList.remove('hit'));
  };
  if (matchMedia('(hover: none)').matches) {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); setTimeout(open, 900); } }, { rootMargin: '0px 0px -25% 0px' });
    io.observe(row);
    return;
  }
  // close only once the pointer is clearly away: the row widens and jolts while open, so its own edge moves,
  // and a plain mouseleave there would close and reopen it over and over
  const MARGIN = 28;
  const away = (e) => {
    const r = row.getBoundingClientRect();
    if (e.clientX < r.left - MARGIN || e.clientX > r.right + MARGIN || e.clientY < r.top - MARGIN || e.clientY > r.bottom + MARGIN) {
      document.removeEventListener('pointermove', away);
      close();
    }
  };
  row.addEventListener('pointerenter', () => {
    document.removeEventListener('pointermove', away);
    open();
  });
  row.addEventListener('pointerleave', () => document.addEventListener('pointermove', away));
  document.documentElement.addEventListener('pointerleave', () => {
    document.removeEventListener('pointermove', away);
    close();
  });
  row.addEventListener('focus', open);
  row.addEventListener('blur', close);
}

setupLineCharts();
setupBoards();
setupCheaper();
