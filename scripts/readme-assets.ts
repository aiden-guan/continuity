// Rebuild the README's presentation graphics from checked-in evidence. No API calls or dependencies.
// npm run readme:assets            write SVGs
// npm run readme:assets -- --check fail if evidence or generated files have drifted
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const metrics = JSON.parse(read('assets/readme/metrics.json')) as {
  recordedDate: string; source: string; cases: number; casesPerDomain: number;
  domains: { name: string; primitive: number; continuity: number }[];
};
const scale = JSON.parse(read('eval/results/scale.json')) as {
  messages: number; transcript: number; briefing: number;
}[];
const report = read(metrics.source);
// The curated snapshot must agree with the source report, including the raw domain numerators.
for (const d of metrics.domains) {
  assert.ok(report.includes(`${d.name.toLowerCase()} ${d.continuity} vs ${d.primitive}`), `Source mismatch: ${d.name}`);
  assert.ok(d.continuity <= metrics.casesPerDomain && d.primitive <= metrics.casesPerDomain);
}
assert.equal(metrics.domains.length * metrics.casesPerDomain, metrics.cases);
const totals = {
  primitive: metrics.domains.reduce((n, d) => n + d.primitive, 0),
  continuity: metrics.domains.reduce((n, d) => n + d.continuity, 0),
};
const pct = (n: number, total: number) => (100 * n / total).toFixed(1);
const headline = report.split('\n').find(line => line.startsWith('| **Held-out eval split, final**'));
assert.ok(headline?.includes(`${pct(totals.continuity, metrics.cases)}%`));
assert.ok(headline?.includes(`${pct(totals.primitive, metrics.cases)}%`));
assert.equal(scale.length, 6);
for (const row of scale) assert.ok(row.messages > 0 && row.transcript > 0 && row.briefing > 0);

const c = { bg: '#f3f2ee', card: '#fbfaf7', ink: '#161513', muted: '#6c665f', line: '#d9d5cc', orange: '#d74718', gray: '#8a847b' };
const esc = (s: string | number) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const text = (x: number, y: number, s: string | number, size = 24, color = c.ink, extra = '') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${extra}>${esc(s)}</text>`;
const rect = (x: number, y: number, w: number, h: number, fill = c.card, r = 16, extra = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" ${extra}/>`;
const line = (x1: number, y1: number, x2: number, y2: number, color = c.line, extra = '') =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" ${extra}/>`;
const svg = (height: number, title: string, desc: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="${height}" viewBox="0 0 1280 ${height}" role="img" aria-labelledby="title desc">
<title id="title">${esc(title)}</title><desc id="desc">${esc(desc)}</desc>
<g font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif">
${rect(0, 0, 1280, height, c.bg, 24)}
${body}
</g></svg>\n`;
const dot = (x: number, y: number, color: string, radius = 5) => `<circle cx="${x}" cy="${y}" r="${radius}" fill="${color}"/>`;
const label = (x: number, y: number, s: string) => text(x, y, s, 18, c.muted, 'letter-spacing="2" font-weight="600"');

// Preserve the mark and warm paper / orange visual language used by site/index.html.
const mark = `<g transform="translate(54 45) scale(30)"><path fill="${c.ink}" d="M.975.975L.025.975A.95.95 0 0 1 .975.025ZM1.025.593L1.025.025A.568.568 0 0 1 1.593.593ZM1.2611.643L1.593.643A.332.332 0 0 1 1.2611.975ZM1.2111.7889L1.2111.975A.1861.1861 0 0 1 1.025.7889Z"/><path fill="${c.orange}" d="M1.1209.7389L1.025.7389A.0959.0959 0 0 1 1.1209.643Z"/></g>`;
let hero = mark + text(116, 72, 'Continuity', 30, c.ink, 'font-weight="600"') + label(982, 70, 'OPEN SOURCE / MIT');
hero += text(54, 163, 'Agents forget.', 70, c.ink, 'font-weight="600" letter-spacing="-3"');
hero += text(54, 241, 'The thread doesn’t.', 70, c.ink, 'font-weight="600" letter-spacing="-3"');
hero += text(57, 293, 'Evidence, terms and open loops — ready for the next agent.', 27, c.muted);
hero += line(55, 343, 1225, 343);
const nodes = [
  { x: 55, w: 235, title: 'Agent A', sub: 'Sends the RFQ', active: false },
  { x: 339, w: 258, title: 'Mail keeps arriving', sub: 'Corrections · approvals', active: false },
  { x: 646, w: 282, title: 'State keeps evolving', sub: 'Terms · evidence · obligations', active: true },
  { x: 977, w: 248, title: 'Fresh Agent B', sub: 'Reads one briefing', active: false },
];
nodes.forEach((n, i) => {
  hero += rect(n.x, 387, n.w, 106, n.active ? c.ink : c.card, 12);
  hero += text(n.x + 18, 426, n.title, 23, n.active ? c.bg : c.ink, 'font-weight="600"');
  hero += text(n.x + 18, 460, n.sub, 18, n.active ? '#c9c3b9' : c.muted);
  if (i < nodes.length - 1) hero += line(n.x + n.w + 6, 439, nodes[i + 1].x - 8, 439, c.orange, 'stroke-width="2" marker-end="url(#arrow)"');
});
hero += dot(69, 535, c.orange) + text(85, 542, 'The conversation owns the state. The agent can be replaced.', 22, c.muted);
hero = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5L0 10" fill="none" stroke="${c.orange}" stroke-width="1.5"/></marker></defs>` + hero;

// Paired horizontal bars, with a zero baseline and raw numerators beside percentages.
let handoff = label(50, 48, '01 / COLD HANDOFF') + text(50, 99, 'Can the next agent pick up correctly?', 39, c.ink, 'font-weight="600" letter-spacing="-1"');
handoff += text(50, 139, 'Same model. Same 650 synthetic cases. One trial per condition.', 24, c.muted);
handoff += rect(50, 176, 1180, 194);
handoff += text(76, 213, 'Correct action + every critical fact correct', 23, c.muted);
const barX = 339, barW = 630;
for (const [i, key] of (['primitive', 'continuity'] as const).entries()) {
  const y = 234 + i * 62;
  const rate = totals[key] / metrics.cases;
  handoff += text(76, y + 28, key === 'continuity' ? '+ Continuity' : 'Primitive alone', 25, c.ink, 'font-weight="500"');
  handoff += rect(barX, y, barW, 36, '#e9e6de', 4) + rect(barX, y, barW * rate, 36, key === 'continuity' ? c.orange : c.gray, 4);
  handoff += text(996, y + 28, `${pct(totals[key], metrics.cases)}%`, 31, key === 'continuity' ? c.orange : c.ink, 'font-weight="600"');
  handoff += text(1101, y + 26, `${totals[key]}/${metrics.cases}`, 20, c.muted);
}
handoff += label(50, 419, 'BY DOMAIN / 130 CASES EACH');
handoff += dot(816, 412, c.gray, 6) + text(831, 419, 'Primitive alone', 19, c.muted);
handoff += dot(1040, 412, c.orange, 6) + text(1055, 419, '+ Continuity', 19, c.muted);
const dx = 258, dw = 787, top = 465;
for (const tick of [0, 25, 50, 75, 100]) {
  const x = dx + dw * tick / 100;
  handoff += line(x, top - 17, x, top + 438);
  handoff += text(x, top + 471, `${tick}%`, 19, c.muted, 'text-anchor="middle"');
}
metrics.domains.forEach((d, i) => {
  const y = top + i * 89;
  handoff += text(50, y + 30, d.name, 25, c.ink, 'font-weight="500"');
  for (const [j, key] of (['primitive', 'continuity'] as const).entries()) {
    handoff += rect(dx, y + j * 29, dw * d[key] / metrics.casesPerDomain, 20, key === 'continuity' ? c.orange : c.gray, 3);
    handoff += text(1072, y + 17 + j * 29, `${pct(d[key], metrics.casesPerDomain)}%`, 21, key === 'continuity' ? c.orange : c.muted);
    handoff += text(1160, y + 17 + j * 29, `${d[key]}/130`, 18, c.muted);
  }
});
handoff += line(50, 961, 1230, 961);
handoff += text(50, 998, 'Reported snapshot · 2026-10-18 · claude-haiku-5-5 · bench/FINDINGS.md', 21, c.muted);
handoff += text(50, 1034, 'Raw runs are not checked in. Synthetic results; see README for caveats.', 21, c.muted);

// A log axis keeps both series readable over three orders of magnitude; no broken / truncated axis.
let growth = label(50, 48, '02 / CONTEXT GROWTH') + text(50, 99, 'More history. A smaller handoff.', 41, c.ink, 'font-weight="600" letter-spacing="-1"');
growth += text(50, 139, 'Deterministic synthetic email histories with nested reply quoting.', 24, c.muted);
growth += dot(56, 191, c.gray, 6) + text(72, 199, 'Full transcript', 23, c.muted);
growth += dot(285, 191, c.orange, 6) + text(301, 199, 'Compiled briefing', 23, c.muted);
growth += text(969, 199, 'LOG SCALE / ≈ TOKENS', 18, c.muted);
const plot = { x: 140, y: 250, w: 866, h: 330 };
const minLog = Math.log10(500), maxLog = Math.log10(5000000);
const sx = (n: number) => plot.x + (n - scale[0].messages) / (scale.at(-1)!.messages - scale[0].messages) * plot.w;
const sy = (n: number) => plot.y + plot.h * (1 - (Math.log10(n) - minLog) / (maxLog - minLog));
for (const [n, label] of [[1000, '1K'], [10000, '10K'], [100000, '100K'], [1000000, '1M']] as const) {
  const y = sy(n);
  growth += line(plot.x, y, plot.x + plot.w, y) + text(112, y + 7, label, 21, c.muted, 'text-anchor="end"');
}
for (const n of [10, 50, 100, 150, 200, 267]) {
  const x = sx(n);
  growth += line(x, plot.y, x, plot.y + plot.h, '#e6e2d9');
  growth += text(x, plot.y + plot.h + 37, n, 21, c.muted, 'text-anchor="middle"');
}
growth += text(plot.x + plot.w / 2, plot.y + plot.h + 77, 'Messages in the conversation', 22, c.muted, 'text-anchor="middle"');
for (const key of ['transcript', 'briefing'] as const) {
  const color = key === 'briefing' ? c.orange : c.gray;
  growth += `<polyline points="${scale.map(r => `${sx(r.messages)},${sy(r[key])}`).join(' ')}" fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round"/>`;
  scale.forEach(row => { growth += dot(sx(row.messages), sy(row[key]), color, 5); });
}
const last = scale.at(-1)!;
growth += text(1032, sy(last.transcript) + 9, `${(last.transcript / 1000000).toFixed(2)}M`, 30, c.ink, 'font-weight="600"');
growth += text(1032, sy(last.briefing) + 9, last.briefing.toLocaleString('en-US'), 30, c.orange, 'font-weight="600"');
growth += line(50, 691, 1230, 691);
growth += text(50, 731, '2026-10-18 rerun · eval/scale.ts · chars / 4 estimates, not tokenizer counts.', 21, c.muted);
growth += text(50, 768, 'Includes repeated quoted mail. Small, unquoted threads can favor the transcript.', 21, c.muted);

const assets = {
  'hero.svg': svg(580, 'Continuity — Agents forget. The thread doesn’t.', 'Conceptual workflow: Agent A sends an RFQ. Mail continues arriving, Continuity updates task state, and a fresh Agent B reads a briefing. This is an architecture illustration, not a product screenshot.', hero),
  'handoff.svg': svg(1070, 'Cold-handoff success: Continuity 68.8%, Primitive alone 49.2%', 'Reported 650-case synthetic benchmark, one trial per cell. Overall and five domain comparisons with raw counts. Source: bench/FINDINGS.md. Full values and caveats appear in the README and metrics.json.', handoff),
  'context-growth.svg': svg(804, 'Context growth: quoted transcript versus compiled briefing', 'Logarithmic token-estimate chart over six deterministic histories. At 267 messages the quoted transcript is about 2.77 million tokens and the briefing is about 1,596. Source: eval/results/scale.json; numeric values also appear in the README.', growth),
};
mkdirSync(resolve(root, 'assets/readme'), { recursive: true });
for (const [name, content] of Object.entries(assets)) {
  const path = `assets/readme/${name}`;
  if (process.argv.includes('--check')) assert.equal(read(path), content, `${path} is stale; run npm run readme:assets`);
  else writeFileSync(resolve(root, path), content);
}
console.log(`${process.argv.includes('--check') ? 'Verified' : 'Generated'} ${Object.keys(assets).length} README SVGs; benchmark counts agree with ${metrics.source}.`);
