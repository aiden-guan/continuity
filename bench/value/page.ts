// Builds the value-benchmark report page (one self-contained HTML file) from the analysis outputs.
//
//   node bench/value/page.ts --fig1 bench/results/value-fig1 [--rs bench/results/value-fig1-rs]
//        [--oracle bench/results/value-fig1-oracle] [--wakes bench/results/value-wakes]
//        [--history bench/results/value-history] --narrative bench/value/narrative.json --out <file.html>
//
// Charts are drawn in the browser from the embedded numbers (so they follow the viewer's theme), with
// a hover tooltip and a data table under each one. Prose comes from narrative.json, written after the
// numbers were read; every figure in the prose is checked against the data by hand.
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { values: a } = parseArgs({ options: { fig1: { type: 'string' }, wakes: { type: 'string', default: '' }, history: { type: 'string', default: '' }, narrative: { type: 'string' }, out: { type: 'string' } } });
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const analysis = read(join(a.fig1!, 'analysis.json'));
const economics = existsSync(join(a.fig1!, 'economics.json')) ? read(join(a.fig1!, 'economics.json')) : null;
const meta = read(join(a.fig1!, 'meta.json'));
const history = a.history && existsSync(join(a.history, 'history.jsonl'))
  ? readFileSync(join(a.history, 'history.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.error)
  : [];
const N = read(a.narrative!) as Record<string, string | string[] | Record<string, string>[]>;

const data = { analysis, economics, meta, history: summarizeHistory(history) };

function summarizeHistory(rows: { case_id: string; condition: string; score: { q1: boolean; q2: boolean; q3: boolean | null; all: boolean }; query: { cost_cold: number }; retrieval: { cost_cold: number }; memory_tokens_est: number }[]) {
  const conds = [...new Set(rows.map((r) => r.condition))];
  const boot = (xs: number[]) => {
    if (!xs.length) return null;
    let seed = 13;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const ms: number[] = [];
    for (let i = 0; i < 4000; i++) { let s = 0; for (let j = 0; j < xs.length; j++) s += xs[Math.floor(rnd() * xs.length)]; ms.push(s / xs.length); }
    ms.sort((x, y) => x - y);
    return { mean: xs.reduce((s, x) => s + x, 0) / xs.length, lo: ms[Math.floor(0.025 * ms.length)], hi: ms[Math.floor(0.975 * ms.length)] };
  };
  const perCase = (rs: typeof rows, f: (r: (typeof rows)[number]) => number | null) => {
    const m = new Map<string, number[]>();
    for (const r of rs) { const v = f(r); if (v !== null) m.set(r.case_id, [...(m.get(r.case_id) ?? []), v]); }
    return [...m.values()].map((xs) => xs.reduce((s, x) => s + x, 0) / xs.length);
  };
  return conds.map((c) => {
    const rs = rows.filter((r) => r.condition === c);
    return {
      condition: c, n_rows: rs.length, n_cases: new Set(rs.map((r) => r.case_id)).size,
      all: boot(perCase(rs, (r) => (r.score.all ? 1 : 0))), q1: boot(perCase(rs, (r) => (r.score.q1 ? 1 : 0))), q2: boot(perCase(rs, (r) => (r.score.q2 ? 1 : 0))), q3: boot(perCase(rs, (r) => (r.score.q3 === null ? null : r.score.q3 ? 1 : 0))),
      cost: rs.reduce((s, r) => s + r.query.cost_cold + r.retrieval.cost_cold, 0) / rs.length, memory: rs.reduce((s, r) => s + r.memory_tokens_est, 0) / rs.length,
    };
  });
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// narrative strings may carry inline <b>, <code>, <a>; they are written by hand, not from model output
const p = (k: string) => (Array.isArray(N[k]) ? (N[k] as string[]).map((x) => `<p>${x}</p>`).join('\n') : `<p>${N[k] ?? ''}</p>`);
const rowsOf = (k: string) => (N[k] as Record<string, string>[]) ?? [];

const html = `<title>Continuity Value Benchmark</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap">
<style>
/* Layout: one reading column of datasheet sections; figures sit on surface panels; Continuity is the one signal-orange series. Tokens follow site/assets/site.css. */
:root {
  --bg: #f3f2ee; --surface: #fbfaf8; --line: rgba(22,21,19,0.09); --grid: #e4e2dc; --axis: #c9c6be;
  --ink: #161513; --ink-2: #4a4843; --muted: #7b7871; --faint: #b5b2aa;
  --signal: #e2501d; --signal-ink: #b93c10; --signal-bg: rgba(226,80,29,0.08);
  --s-prim: #3d3b37; --s-full: #8f8b83; --s-sum: #2a78d6; --s-notes: #a9a59c; --s-oracle: #b5b2aa;
  --ok: #2c7a4b; --ok-bg: rgba(44,122,75,0.09);
  --sans: "Geist", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: "Geist Mono", ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
  --r: 10px; --measure: 68ch;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0f0f0e; --surface: #171716; --line: rgba(236,234,228,0.08); --grid: #262624; --axis: #3a3936;
  --ink: #eceae4; --ink-2: #c3c0b8; --muted: #838079; --faint: #4b4945;
  --signal: #ff6a3d; --signal-ink: #ff8a64; --signal-bg: rgba(255,106,61,0.1);
  --s-prim: #d9d6cf; --s-full: #8d8a83; --s-sum: #3987e5; --s-notes: #6d6a64; --s-oracle: #57554f;
  --ok: #5dc48a; --ok-bg: rgba(93,196,138,0.1); color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #0f0f0e; --surface: #171716; --line: rgba(236,234,228,0.08); --grid: #262624; --axis: #3a3936;
  --ink: #eceae4; --ink-2: #c3c0b8; --muted: #838079; --faint: #4b4945;
  --signal: #ff6a3d; --signal-ink: #ff8a64; --signal-bg: rgba(255,106,61,0.1);
  --s-prim: #d9d6cf; --s-full: #8d8a83; --s-sum: #3987e5; --s-notes: #6d6a64; --s-oracle: #57554f;
  --ok: #5dc48a; --ok-bg: rgba(93,196,138,0.1); color-scheme: dark }
* { box-sizing: border-box }
body { background: var(--bg); color: var(--ink); font: 15px/1.6 var(--sans); padding-block: 40px 80px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)) }
main { max-width: 920px; margin: 0 auto; display: grid; gap: 56px }
header { display: grid; gap: 14px }
.eyebrow { font: 500 11px/1 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted) }
h1 { font: 600 clamp(28px, 4.4vw, 40px)/1.12 var(--sans); letter-spacing: -0.02em; margin: 0; text-wrap: balance }
h2 { font: 600 22px/1.25 var(--sans); letter-spacing: -0.01em; margin: 0; text-wrap: balance }
h3 { font: 600 15px/1.35 var(--sans); margin: 0 }
p { margin: 0; max-width: var(--measure); color: var(--ink-2) }
p b { color: var(--ink); font-weight: 600 }
section { display: grid; gap: 16px }
.lede { font-size: 17px; color: var(--ink) }
code, .mono { font-family: var(--mono); font-size: 0.88em }
a { color: var(--signal-ink) }
.figno { font: 500 11px/1 var(--mono); letter-spacing: 0.06em; color: var(--signal-ink); text-transform: uppercase }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 20px; display: grid; gap: 14px; min-width: 0 }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 16px; display: grid; gap: 6px; align-content: start }
.tile .v { font: 600 30px/1.05 var(--sans); letter-spacing: -0.02em; color: var(--ink) }
.tile .v.sig { color: var(--signal-ink) }
.tile .l { font-size: 13px; color: var(--ink-2); line-height: 1.45 }
.tile .s { font: 400 11px/1.4 var(--mono); color: var(--muted) }
.chart { width: 100%; height: auto; display: block; overflow: visible }
.chart text { font: 400 11px var(--mono); fill: var(--muted) }
.chart .lab { font: 500 12px var(--sans); fill: var(--ink-2) }
.chart .lab.sig { fill: var(--signal-ink) }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 13px; color: var(--ink-2) }
.legend span { display: inline-flex; align-items: center; gap: 8px }
.legend i { width: 18px; height: 0; border-top: 2px solid; display: inline-block }
.cap { font-size: 13px; color: var(--muted); max-width: var(--measure) }
details { font-size: 13px }
summary { cursor: pointer; color: var(--muted); font: 500 12px var(--mono) }
summary:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px }
.tbl { overflow-x: auto }
table { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top }
th { font: 500 11px/1.3 var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em }
td.num { text-align: right; white-space: nowrap }
tr.sig td { background: var(--signal-bg) }
.concepts td:first-child { font-weight: 600; color: var(--ink); white-space: nowrap }
.pill { display: inline-block; font: 500 11px/1 var(--mono); padding: 4px 7px; border-radius: 99px; white-space: nowrap }
.pill.win { background: var(--ok-bg); color: var(--ok) }
.pill.tie { background: var(--line); color: var(--ink-2) }
.pill.loss { background: var(--signal-bg); color: var(--signal-ink) }
ul { margin: 0; padding-left: 20px; color: var(--ink-2); display: grid; gap: 6px; max-width: var(--measure) }
#tip { position: fixed; pointer-events: none; background: var(--ink); color: var(--bg); font: 12px/1.45 var(--sans); padding: 8px 10px; border-radius: 6px; max-width: 280px; z-index: 10; box-shadow: 0 6px 20px rgba(0,0,0,0.18) }
.hit { fill: transparent; cursor: default }
@media (max-width: 560px) { body { font-size: 14px } .panel { padding: 14px } }
</style>

<main>
<header>
  <div class="eyebrow">Continuity × Primitive · value benchmark · ${esc(String(meta.model))}</div>
  <h1>${N.title}</h1>
  ${p('lede')}
</header>

<section>
  <div class="tiles" id="tiles"></div>
  <p class="cap">${N.tiles_caption ?? ''}</p>
</section>

<section>
  <h2>What was tested</h2>
  ${p('concepts_intro')}
  <div class="tbl panel"><table class="concepts">
    <thead><tr><th>Concept</th><th>What in Continuity should help</th><th>Real-world case</th><th>Result</th></tr></thead>
    <tbody>${rowsOf('concepts').map((r) => `<tr><td>${r.concept}</td><td>${r.mechanism}</td><td>${r.case}</td><td>${r.result}</td></tr>`).join('')}</tbody>
  </table></div>
</section>

<section>
  <div class="figno">Figure 1</div>
  <h2>${N.fig1_title}</h2>
  ${p('fig1_text')}
  <div class="panel"><div class="legend" id="leg1"></div><svg class="chart" id="fig1" viewBox="0 0 760 360" role="img" aria-label="Handoff success by number of dependent changes"></svg>
  <p class="cap">${N.fig1_caption}</p><details><summary>Data and paired tests</summary><div class="tbl" id="tbl1"></div></details></div>
</section>

<section>
  <div class="figno">Figure 1b</div>
  <h2>${N.fig1b_title}</h2>
  ${p('fig1b_text')}
  <div class="panel"><div class="legend" id="leg1b"></div><svg class="chart" id="fig1b" viewBox="0 0 760 320" role="img" aria-label="Handoff success by number of threads"></svg>
  <p class="cap">${N.fig1b_caption}</p><details><summary>Data and paired tests</summary><div class="tbl" id="tbl1b"></div></details></div>
</section>

<section>
  <div class="figno">Figure 2</div>
  <h2>${N.fig2_title}</h2>
  ${p('fig2_text')}
  <div class="panel"><div class="legend" id="leg2"></div><svg class="chart" id="fig2" viewBox="0 0 760 340" role="img" aria-label="Cost per correct decision by number of wakes"></svg>
  <p class="cap">${N.fig2_caption}</p><details><summary>Data</summary><div class="tbl" id="tbl2"></div></details></div>
  <div class="panel"><h3>${N.fig2b_title}</h3><div class="legend" id="leg2b"></div><svg class="chart" id="fig2b" viewBox="0 0 760 320" role="img" aria-label="Cumulative cost over a thread with a wake on every inbound email"></svg>
  <p class="cap">${N.fig2b_caption}</p><details><summary>Data</summary><div class="tbl" id="tbl2b"></div></details></div>
</section>

<section>
  <div class="figno">Figure 2c</div>
  <h2>${N.fig2c_title ?? ''}</h2>
  ${p('fig2c_text')}
  <div class="panel"><h3>Context the agent reads per decision</h3><div class="legend" id="leg2c"></div><svg class="chart" id="fig2c" viewBox="0 0 760 320" role="img" aria-label="Memory tokens per decision by thread length"></svg>
  <h3>Handoff success at the same lengths</h3><div class="legend" id="leg2d"></div><svg class="chart" id="fig2d" viewBox="0 0 760 300" role="img" aria-label="Handoff success by thread length"></svg>
  <p class="cap">${N.fig2c_caption ?? ''}</p><details><summary>Data and paired tests</summary><div class="tbl" id="tbl2c"></div></details></div>
</section>

<section>
  <div class="figno">Figure 3</div>
  <h2>${N.fig3_title}</h2>
  ${p('fig3_text')}
  <div class="panel"><svg class="chart" id="fig3" viewBox="0 0 760 260" role="img" aria-label="History questions answered correctly by condition"></svg>
  <p class="cap">${N.fig3_caption}</p><details><summary>Data</summary><div class="tbl" id="tbl3"></div></details></div>
</section>

<section>
  <h2>Where Continuity loses</h2>
  ${p('losses_text')}
  <ul>${((N.losses as string[]) ?? []).map((x) => `<li>${x}</li>`).join('')}</ul>
</section>

<section>
  <h2>How the comparison was kept fair</h2>
  <ul>${((N.method as string[]) ?? []).map((x) => `<li>${x}</li>`).join('')}</ul>
</section>

<section>
  <h2>Demo recommendation</h2>
  ${p('demo_text')}
  <ul>${((N.demo_steps as string[]) ?? []).map((x) => `<li>${x}</li>`).join('')}</ul>
</section>

<section>
  <h2>Engine defects found, and next fixes</h2>
  <ul>${((N.defects as string[]) ?? []).map((x) => `<li>${x}</li>`).join('')}</ul>
</section>

<section>
  <h2>Reproduce</h2>
  ${p('reproduce_text')}
</section>
</main>
<div id="tip" hidden></div>

<script>
const D = ${JSON.stringify(data)};
const N = ${JSON.stringify({ tiles: N.tiles ?? [] })};
const SER = {
  'continuity': { label: 'Primitive + Continuity', color: 'var(--signal)', dash: '', sig: true },
  'primitive-native': { label: 'Primitive only (6 read tools)', color: 'var(--s-prim)', dash: '' },
  'full-history': { label: 'Full history in context', color: 'var(--s-full)', dash: '6 4' },
  'rolling-summary': { label: 'Rolling summary', color: 'var(--s-sum)', dash: '2 3' },
  'agent-notes': { label: 'Model-kept notes (latest state)', color: 'var(--s-notes)', dash: '8 3 2 3' },
  'continuity-briefing': { label: 'Continuity briefing', color: 'var(--signal)', dash: '4 3', sig: true },
  'continuity-history': { label: 'Continuity briefing + as-of replay', color: 'var(--signal)', dash: '', sig: true },
  'oracle': { label: 'True state given (bare list)', color: 'var(--s-oracle)', dash: '1 4' },
};
const pct = (x) => (x * 100).toFixed(0) + '%';
const pct1 = (x) => (x * 100).toFixed(1) + '%';
const usd = (x) => '$' + (x < 0.01 ? x.toFixed(4) : x.toFixed(3));
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent && parent.appendChild(e); return e; };
const tip = document.getElementById('tip');
function bindTip(node, html) {
  node.addEventListener('mouseenter', () => { tip.innerHTML = html; tip.hidden = false; });
  node.addEventListener('mousemove', (e) => { const w = tip.offsetWidth; tip.style.left = Math.min(e.clientX + 14, innerWidth - w - 8) + 'px'; tip.style.top = (e.clientY + 14) + 'px'; });
  node.addEventListener('mouseleave', () => { tip.hidden = true; });
}
function legend(id, keys) {
  const L = document.getElementById(id); if (!L) return;
  L.innerHTML = keys.map((k) => '<span><i style="border-top-color:' + SER[k].color + ';border-top-style:' + (SER[k].dash ? 'dashed' : 'solid') + '"></i>' + SER[k].label + '</span>').join('');
}

/** Line chart with 95% CI whiskers and end labels. series: [{key, pts:[{x,y,lo,hi,tip}]}] */
function lineChart(svg, o) {
  const W = 760, H = +svg.getAttribute('viewBox').split(' ')[3];
  const m = { l: 56, r: o.rightPad ?? 200, t: 16, b: 46 };
  const xs = o.xs, x0 = o.xmin ?? Math.min(...xs), x1 = o.xmax ?? Math.max(...xs);
  const fx = o.log ? (v) => m.l + (Math.log(v) - Math.log(x0)) / (Math.log(x1) - Math.log(x0)) * (W - m.l - m.r) : (v) => m.l + (v - x0) / (x1 - x0) * (W - m.l - m.r);
  const y0 = o.ymin ?? 0, y1 = o.ymax;
  const fy = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
  for (const t of o.yticks) { el('line', { x1: m.l, x2: W - m.r, y1: fy(t), y2: fy(t), stroke: 'var(--grid)', 'stroke-width': 1 }, svg); el('text', { x: m.l - 8, y: fy(t) + 4, 'text-anchor': 'end' }, svg).textContent = o.yfmt(t); }
  el('line', { x1: m.l, x2: W - m.r, y1: fy(y0), y2: fy(y0), stroke: 'var(--axis)', 'stroke-width': 1 }, svg);
  for (const t of xs) el('text', { x: fx(t), y: H - m.b + 18, 'text-anchor': 'middle' }, svg).textContent = String(t);
  el('text', { x: (m.l + W - m.r) / 2, y: H - 8, 'text-anchor': 'middle' }, svg).textContent = o.xlabel;
  const ends = [];
  // draw context series first, Continuity last (on top)
  const order = [...o.series].sort((a, b) => (SER[a.key].sig ? 1 : 0) - (SER[b.key].sig ? 1 : 0));
  for (const s of order) {
    const S = SER[s.key]; const pts = s.pts.filter((p) => p.y != null);
    if (!pts.length) continue;
    // whiskers dodge sideways per series so overlapping intervals stay readable
    const dodge = (o.series.findIndex((x) => x.key === s.key) - (o.series.length - 1) / 2) * 5;
    if (o.ci) for (const p of pts) if (p.lo != null) el('line', { x1: fx(p.x) + dodge, x2: fx(p.x) + dodge, y1: fy(p.lo), y2: fy(p.hi), stroke: S.color, 'stroke-width': 1.5, opacity: 0.5 }, svg);
    el('path', { d: pts.map((p, i) => (i ? 'L' : 'M') + fx(p.x).toFixed(1) + ' ' + fy(p.y).toFixed(1)).join(' '), fill: 'none', stroke: S.color, 'stroke-width': S.sig ? 2.5 : 2, 'stroke-dasharray': S.dash, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    for (const p of pts) {
      el('circle', { cx: fx(p.x), cy: fy(p.y), r: S.sig ? 5 : 4, fill: S.color, stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
      const hit = el('circle', { cx: fx(p.x), cy: fy(p.y), r: 12, class: 'hit' }, svg);
      bindTip(hit, '<b>' + S.label + '</b><br>' + p.tip);
    }
    const last = pts[pts.length - 1];
    ends.push({ key: s.key, y: fy(last.y), x: fx(last.x), text: S.label + ' · ' + o.yfmt(last.y) });
  }
  // end labels: keep at least 15px apart, with a leader line when nudged
  ends.sort((a, b) => a.y - b.y);
  if (ends[0]) ends[0].ly = ends[0].y;
  for (let i = 1; i < ends.length; i++) ends[i].ly = Math.max(ends[i].y, ends[i - 1].ly + 15);
  for (const e of ends) {
    if (Math.abs(e.ly - e.y) > 2) el('line', { x1: e.x + 6, x2: e.x + 14, y1: e.y, y2: e.ly, stroke: 'var(--faint)', 'stroke-width': 1 }, svg);
    el('text', { x: e.x + 16, y: e.ly + 4, class: 'lab' + (SER[e.key].sig ? ' sig' : '') }, svg).textContent = e.text;
  }
}

function table(id, head, rows, sigRow) {
  const T = document.getElementById(id); if (!T) return;
  T.innerHTML = '<table><thead><tr>' + head.map((h, i) => '<th' + (i ? ' class="num"' : '') + '>' + h + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr' + (sigRow && sigRow(r) ? ' class="sig"' : '') + '>' + r.map((c, i) => '<td' + (i ? ' class="num"' : '') + '>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
}

// ---------------- tiles
document.getElementById('tiles').innerHTML = (N.tiles || []).map((t) => '<div class="tile"><div class="v' + (t.sig ? ' sig' : '') + '">' + t.value + '</div><div class="l">' + t.label + '</div><div class="s">' + (t.sub || '') + '</div></div>').join('');

// ---------------- Figure 1 / 1b
function famChart(fam, svgId, legId, tblId, xlabel, exclude = []) {
  const F = D.analysis.families[fam]; if (!F) return;
  const levels = F.levels;
  const conds = Object.keys(levels[0].by_condition).filter((c) => SER[c] && !exclude.includes(c));
  legend(legId, conds);
  lineChart(document.getElementById(svgId), {
    xs: levels.map((l) => l.level), xlabel, ymax: 1, yticks: [0, 0.25, 0.5, 0.75, 1], yfmt: pct, ci: true,
    series: conds.map((c) => ({ key: c, pts: levels.map((l) => { const s = l.by_condition[c]; return s && s.chs ? { x: l.level, y: s.chs.mean, lo: s.chs.lo, hi: s.chs.hi, tip: xlabel.split(' (')[0] + ' ' + l.level + ': ' + pct1(s.chs.mean) + ' success (95% CI ' + pct(s.chs.lo) + '–' + pct(s.chs.hi) + ')<br>blockers caught ' + pct(s.blockers.mean) + ' · ' + s.n_cases + ' cases<br>cost/decision ' + usd(s.cost) } : { x: l.level, y: null }; }) })),
  });
  const rows = [];
  for (const l of levels) for (const c of conds) { const s = l.by_condition[c]; if (s && s.chs) rows.push([l.level + ' · ' + SER[c].label, pct1(s.chs.mean) + ' [' + pct(s.chs.lo) + '–' + pct(s.chs.hi) + ']', pct1(s.blockers.mean), pct1(s.stale.mean), pct1(s.unsafe.mean), usd(s.cost), Math.round(s.tokens).toLocaleString(), String(s.n_cases)]); }
  const paired = Object.entries(F).filter(([k]) => k.includes(':')).map(([k, v]) => [k.replace(':', ' vs '), (v.d_chs.diff >= 0 ? '+' : '') + (v.d_chs.diff * 100).toFixed(1) + ' pp [' + (v.d_chs.lo * 100).toFixed(1) + ', ' + (v.d_chs.hi * 100).toFixed(1) + ']', v.p_signflip < 0.001 ? '<0.001' : v.p_signflip.toFixed(3), v.wins + ' / ' + v.losses, v.n_cases, v.cost_ratio.toFixed(2)]);
  const T = document.getElementById(tblId);
  const a = document.createElement('div'); a.id = tblId + 'a'; const b = document.createElement('div'); b.id = tblId + 'b'; T.append(a, b);
  table(a.id, ['level · condition', 'success [95% CI]', 'blockers caught', 'used a dead fact', 'committed while blocked', 'cost / decision', 'tokens / decision', 'cases'], rows, (r) => r[0].includes('Continuity'));
  table(b.id, ['Continuity vs', 'Δ success [95% CI]', 'sign-flip p', 'case wins / losses', 'cases', 'cost ratio'], paired);
}
famChart('depth', 'fig1', 'leg1', 'tbl1', 'Interdependent changes in the history (total email count held at 16)');
famChart('threads', 'fig1b', 'leg1b', 'tbl1b', 'Threads the same six changes are spread over');
if (D.analysis.families.length) {
  famChart('length', 'fig2d', 'leg2d', 'tbl2c', 'Extra state-neutral emails in the thread (16 task emails before)', ['oracle']);
  const L = D.analysis.families.length.levels;
  const conds = Object.keys(L[0].by_condition).filter((c) => SER[c] && c !== 'oracle');
  legend('leg2c', conds);
  const ymax = Math.max(...L.flatMap((l) => conds.map((c) => l.by_condition[c] ? l.by_condition[c].memory : 0))) * 1.15;
  const step = ymax > 20000 ? 5000 : ymax > 8000 ? 2000 : 1000;
  lineChart(document.getElementById('fig2c'), {
    xs: L.map((l) => l.level), xlabel: 'Extra state-neutral emails in the thread', ymax, yticks: Array.from({ length: Math.floor(ymax / step) + 1 }, (_, i) => i * step), yfmt: (v) => v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'K' : String(Math.round(v)),
    series: conds.map((c) => ({ key: c, pts: L.map((l) => { const s = l.by_condition[c]; return s ? { x: l.level, y: s.memory, tip: '+' + l.level + ' emails: ' + Math.round(s.memory).toLocaleString() + ' memory tokens (est.)<br>' + Math.round(s.tokens).toLocaleString() + ' tokens/decision all-in · ' + usd(s.cost) } : { x: l.level, y: null }; }) })),
  });
} else { const sec = document.getElementById('fig2c').closest('section'); sec.hidden = true; }

// ---------------- Figure 2
if (D.economics) {
  const S = D.economics.static['all cases'];
  if (S) {
    const conds = Object.keys(S.econ).filter((c) => SER[c]);
    legend('leg2', conds);
    const ys = conds.flatMap((c) => S.cost_per_correct[c]);
    const ymax = Math.max(...ys) * 1.1;
    const step = ymax > 0.08 ? 0.02 : ymax > 0.04 ? 0.01 : 0.005;
    lineChart(document.getElementById('fig2'), {
      xs: S.W, log: true, xlabel: 'Wakes of the same agent identity on the same history (log scale)', ymax, yticks: Array.from({ length: Math.floor(ymax / step) + 1 }, (_, i) => +(i * step).toFixed(3)), yfmt: (v) => '$' + v.toFixed(3),
      series: conds.map((c) => ({ key: c, pts: S.W.map((w, i) => ({ x: w, y: S.cost_per_correct[c][i], tip: w + ' wake' + (w > 1 ? 's' : '') + ': ' + usd(S.cost_per_correct[c][i]) + ' per correct decision<br>one-time ' + usd(S.econ[c].I) + ' · per wake ' + usd(S.econ[c].A) + ' · success ' + pct(S.econ[c].p) })) })),
    });
    table('tbl2', ['condition', 'one-time cost', 'per-wake cost', 'success / wake', ...S.W.map((w) => 'W=' + w)], conds.map((c) => [SER[c].label, usd(S.econ[c].I), usd(S.econ[c].A), pct1(S.econ[c].p), ...S.cost_per_correct[c].map(usd)]), (r) => r[0].includes('Continuity'));
  }
  const E = D.economics.event_driven;
  if (E) {
    const conds = Object.keys(E).filter((c) => SER[c]);
    legend('leg2b', conds);
    const K = Math.min(...conds.map((c) => E[c].cumulative_cold.length));
    const ymax = Math.max(...conds.map((c) => E[c].cumulative_cold[K - 1])) * 1.1;
    const step = ymax > 0.2 ? 0.05 : ymax > 0.1 ? 0.025 : 0.01;
    lineChart(document.getElementById('fig2b'), {
      xs: Array.from({ length: K }, (_, i) => i + 1), xlabel: 'Inbound emails so far (one fresh wake per email)', ymax, yticks: Array.from({ length: Math.floor(ymax / step) + 1 }, (_, i) => +(i * step).toFixed(3)), yfmt: (v) => '$' + v.toFixed(3),
      series: conds.map((c) => ({ key: c, pts: E[c].cumulative_cold.slice(0, K).map((v, i) => ({ x: i + 1, y: v, tip: 'after ' + (i + 1) + ' wakes: ' + usd(v) + ' total<br>this wake: ' + usd(E[c].per_wake_cold[i]) })) })),
    });
    table('tbl2b', ['condition', 'lifetime cost / thread', '95% CI', 'memory tokens, first wake', 'memory tokens, last wake'], conds.map((c) => [SER[c].label, usd(E[c].lifetime.mean), usd(E[c].lifetime.lo) + '–' + usd(E[c].lifetime.hi), Math.round(E[c].memory_first).toLocaleString(), Math.round(E[c].memory_last).toLocaleString()]), (r) => r[0].includes('Continuity'));
  }
}

// ---------------- Figure 3: horizontal bars, all three right, with CI whiskers
(function () {
  const H = D.history; if (!H || !H.length) { document.getElementById('fig3').closest('.panel').hidden = true; return; }
  const svg = document.getElementById('fig3');
  const order = ['full-history', 'rolling-summary', 'agent-notes', 'continuity-briefing', 'continuity-history'].filter((c) => H.some((h) => h.condition === c));
  const rowsH = order.map((c) => H.find((h) => h.condition === c));
  const W = 760, m = { l: 250, r: 70, t: 10 }, bh = 22, gap = 18;
  svg.setAttribute('viewBox', '0 0 760 ' + (m.t + rowsH.length * (bh + gap) + 30));
  const fx = (v) => m.l + v * (W - m.l - m.r);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) { el('line', { x1: fx(t), x2: fx(t), y1: m.t, y2: m.t + rowsH.length * (bh + gap) - gap, stroke: 'var(--grid)' }, svg); el('text', { x: fx(t), y: m.t + rowsH.length * (bh + gap) + 8, 'text-anchor': 'middle' }, svg).textContent = pct(t); }
  rowsH.forEach((h, i) => {
    const y = m.t + i * (bh + gap); const S = SER[h.condition];
    el('text', { x: m.l - 12, y: y + bh / 2 + 4, 'text-anchor': 'end', class: 'lab' + (S.sig ? ' sig' : '') }, svg).textContent = S.label;
    const w = Math.max(0, fx(h.all.mean) - fx(0));
    el('path', { d: 'M' + fx(0) + ' ' + y + 'h' + Math.max(0, w - 4) + 'a4 4 0 0 1 4 4v' + (bh - 8) + 'a4 4 0 0 1 -4 4h' + -Math.max(0, w - 4) + 'z', fill: S.sig ? 'var(--signal)' : 'var(--s-full)' }, svg);
    el('line', { x1: fx(h.all.lo), x2: fx(h.all.hi), y1: y + bh / 2, y2: y + bh / 2, stroke: 'var(--ink-2)', 'stroke-width': 1.25 }, svg);
    el('text', { x: fx(1) + 8, y: y + bh / 2 + 4, class: 'lab' }, svg).textContent = pct(h.all.mean);
    const hit = el('rect', { x: m.l, y, width: W - m.l - m.r, height: bh, class: 'hit' }, svg);
    bindTip(hit, '<b>' + S.label + '</b><br>all three right ' + pct1(h.all.mean) + ' (95% CI ' + pct(h.all.lo) + '–' + pct(h.all.hi) + ')<br>Q1 ' + pct(h.q1.mean) + ' · Q2 ' + pct(h.q2.mean) + ' · Q3 ' + (h.q3 ? pct(h.q3.mean) : '—') + '<br>query cost ' + usd(h.cost) + ' · ' + h.n_cases + ' cases');
  });
  table('tbl3', ['condition', 'all three right', 'Q1 blockers as of X', 'Q2 price & cap as of X', 'Q3 which message replaced V', 'query cost', 'memory tokens', 'cases'], rowsH.map((h) => [SER[h.condition].label, pct1(h.all.mean) + ' [' + pct(h.all.lo) + '–' + pct(h.all.hi) + ']', pct1(h.q1.mean), pct1(h.q2.mean), h.q3 ? pct1(h.q3.mean) : '—', usd(h.cost), Math.round(h.memory).toLocaleString(), String(h.n_cases)]), (r) => r[0].includes('Continuity'));
})();
</script>`;

writeFileSync(a.out!, html);
console.log(`wrote ${a.out} (${(html.length / 1024).toFixed(0)} KB)`);
