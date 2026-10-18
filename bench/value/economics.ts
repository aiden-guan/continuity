// Value benchmark, Fig 2: lifetime economics of a persistent agent identity.
//
//   node bench/value/economics.ts <fig1-results-dir> [<wakes-results-dir>]  → <fig1 dir>/economics.{md,json}
//
// (a) Re-waking on the same state (no new mail), from the decision runs: each trial is one measured wake.
//     A condition pays a one-time cost I (Continuity's extraction, the rolling summary's rewrites) and a
//     per-wake cost A (tool reads + the actor). Lifetime(W) = I + W·A; cost per correct decision =
//     Lifetime(W) / (W · success rate). Break-even W* = (I_c − I_x) / (A_x − A_c).
// (b) Event-driven (a wake on every inbound email), from bench/value/wakes.ts: measured per wake, summed.
// Costs are cold-cache: every input token at the full input price (wakes hours apart share no prompt
// cache). Measured (cache-discounted) costs are printed alongside.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Row } from '../core/pipeline.ts';
import { PRICING } from '../core/llm.ts';
import { bootstrapMean, mean } from '../core/stats.ts';

const [fig1, wakesDir] = process.argv.slice(2);
if (!fig1) throw new Error('usage: node bench/value/economics.ts <fig1-dir> [<wakes-dir>]');
const meta = JSON.parse(readFileSync(join(fig1, 'meta.json'), 'utf8'));
const price = PRICING[meta.model];
const cold = (input: number, output: number) => (input * price.in + output * price.out) / 1e6;

const by = new Map<string, Row>();
for (const l of readFileSync(join(fig1, 'rows.jsonl'), 'utf8').split('\n').filter(Boolean)) {
  const r = JSON.parse(l) as Row;
  const prev = by.get(r.key);
  if (!r.error || !prev || prev.error) by.set(r.key, r);
}
const rows = [...by.values()].filter((r) => !r.error && !r.unsupported);
const conds = ['continuity', 'rolling-summary', 'primitive-native', 'full-history'].filter((c) => rows.some((r) => r.condition === c));
const families: [string, (a: string) => boolean][] = [['all cases', () => true], ['depth 6', (a) => a === 'value_chain_d6'], ['fan-out 8 threads', (a) => a === 'value_fanout_t8']];

interface Econ { I: number; A: number; I_measured: number; A_measured: number; p: number; tokensI: number; tokensA: number; n_cases: number }
function econ(rs: Row[]): Econ {
  // per case first (trials are repeated wakes of one case), then over cases
  const cases = new Map<string, Row[]>();
  for (const r of rs) cases.set(r.case_id, [...(cases.get(r.case_id) ?? []), r]);
  const per = [...cases.values()].map((xs) => ({
    I: mean(xs.map((r) => cold(r.usage.ingestion.input_tokens, r.usage.ingestion.output_tokens))),
    A: mean(xs.map((r) => cold(r.usage.retrieval.input_tokens + r.usage.actor_input_tokens, r.usage.retrieval.output_tokens + r.usage.actor_output_tokens))),
    Im: mean(xs.map((r) => r.usage.ingestion.cost_usd)),
    Am: mean(xs.map((r) => r.usage.retrieval.cost_usd + r.usage.actor_cost_usd)),
    p: mean(xs.map((r) => r.chs ?? 0)),
    tI: mean(xs.map((r) => r.usage.ingestion.input_tokens + r.usage.ingestion.output_tokens)),
    tA: mean(xs.map((r) => r.usage.retrieval.input_tokens + r.usage.retrieval.output_tokens + r.usage.actor_input_tokens + r.usage.actor_output_tokens)),
  }));
  return { I: mean(per.map((x) => x.I)), A: mean(per.map((x) => x.A)), I_measured: mean(per.map((x) => x.Im)), A_measured: mean(per.map((x) => x.Am)), p: mean(per.map((x) => x.p)), tokensI: mean(per.map((x) => x.tI)), tokensA: mean(per.map((x) => x.tA)), n_cases: per.length };
}

const W = [1, 5, 10, 25, 50];
const out: Record<string, unknown> = { fig1, wakes: wakesDir ?? null, price, static: {} };
const md: string[] = ['# Lifetime economics', '', `Decision runs: \`${fig1}\` (${meta.model}, ${meta.trials} trials, commit ${String(meta.commit).slice(0, 7)}). Prices: $${price.in}/$${price.out} per MTok in/out, as of ${price.asOf}; cold-cache unless noted.`, ''];

for (const [fam, pick] of families) {
  const e = Object.fromEntries(conds.map((c) => [c, econ(rows.filter((r) => r.condition === c && pick(r.archetype)))]));
  if (!e.continuity?.n_cases) continue;
  md.push(`## (a) Re-waking on the same state — ${fam}`, '', '| condition | one-time cost | per-wake cost | per-wake cost (measured, cached) | success / wake | tokens one-time | tokens / wake |', '|---|---|---|---|---|---|---|');
  for (const c of conds) md.push(`| ${c} | $${e[c].I.toFixed(5)} | $${e[c].A.toFixed(5)} | $${e[c].A_measured.toFixed(5)} | ${(e[c].p * 100).toFixed(1)}% | ${Math.round(e[c].tokensI).toLocaleString('en-US')} | ${Math.round(e[c].tokensA).toLocaleString('en-US')} |`);
  md.push('', `Cost per correct decision after W wakes = (one-time + W × per-wake) / (W × success):`, '', `| condition | ${W.map((w) => `W=${w}`).join(' | ')} | break-even vs Continuity |`, `|---|${W.map(() => '---').join('|')}|---|`);
  const curves: Record<string, number[]> = {};
  for (const c of conds) {
    curves[c] = W.map((w) => (e[c].I + w * e[c].A) / (w * e[c].p));
    const be = c === 'continuity' ? '—' : e[c].A > e.continuity.A ? (() => { const w = (e.continuity.I - e[c].I) / (e[c].A - e.continuity.A); return w <= 1 ? 'Continuity cheaper from the 1st wake' : `${w.toFixed(1)} wakes`; })() : 'never (Continuity costs more per wake)';
    md.push(`| ${c} | ${curves[c].map((x) => `$${x.toFixed(4)}`).join(' | ')} | ${be} |`);
  }
  md.push('');
  (out.static as Record<string, unknown>)[fam] = { econ: e, W, cost_per_correct: curves };
}

// ---- (b) event-driven wakes
if (wakesDir && existsSync(join(wakesDir, 'wakes.jsonl'))) {
  const wrows = readFileSync(join(wakesDir, 'wakes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) as { case_id: string; condition: string; wakes: { wake: number; task_messages_visible: number; cost_cold: number; cost_measured: number; tokens: number; memory_tokens_est: number }[]; lifetime_cost_cold: number; lifetime_cost_measured: number; lifetime_tokens: number }[];
  const allRows = wrows.splice(0);
  const wconds = [...new Set(allRows.map((r) => r.condition))];
  // paired: only threads every condition has finished
  const complete = [...new Set(allRows.map((r) => r.case_id))].filter((id) => wconds.every((c) => allRows.some((r) => r.case_id === id && r.condition === c)));
  wrows.push(...allRows.filter((r) => complete.includes(r.case_id)));
  const nCases = complete.length;
  md.push(`## (b) Event-driven: a fresh wake on every inbound email`, '', `${nCases} threads (${[...new Set(wrows.map((r) => r.case_id.split('/')[1]))].join(', ')}), ${mean(wrows.map((r) => r.wakes.length)).toFixed(1)} wakes per thread on average. Measured per wake, summed over the thread.`, '', '| condition | lifetime cost / thread (cold) | 95% CI | lifetime cost (measured) | lifetime tokens / thread | per-wake memory tokens (first → last wake) |', '|---|---|---|---|---|---|');
  const life: Record<string, unknown> = {};
  for (const c of wconds) {
    const rs = wrows.filter((r) => r.condition === c);
    const b = bootstrapMean(rs.map((r) => r.lifetime_cost_cold));
    const first = mean(rs.map((r) => r.wakes[0].memory_tokens_est));
    const last = mean(rs.map((r) => r.wakes.at(-1)!.memory_tokens_est));
    md.push(`| ${c} | $${b.mean.toFixed(4)} | [$${b.lo.toFixed(4)}–$${b.hi.toFixed(4)}] | $${mean(rs.map((r) => r.lifetime_cost_measured)).toFixed(4)} | ${Math.round(mean(rs.map((r) => r.lifetime_tokens))).toLocaleString('en-US')} | ${Math.round(first)} → ${Math.round(last)} |`);
    // cumulative cost after k wakes (mean over threads, aligned by wake index)
    const maxK = Math.min(...rs.map((r) => r.wakes.length));
    const cum = Array.from({ length: maxK }, (_, k) => mean(rs.map((r) => r.wakes.slice(0, k + 1).reduce((s, w) => s + w.cost_cold, 0))));
    const perWake = Array.from({ length: maxK }, (_, k) => mean(rs.map((r) => r.wakes[k].cost_cold)));
    life[c] = { lifetime: b, cumulative_cold: cum, per_wake_cold: perWake, memory_first: first, memory_last: last };
  }
  md.push('');
  out.event_driven = life;
}

writeFileSync(join(fig1, 'economics.json'), JSON.stringify(out, null, 1));
writeFileSync(join(fig1, 'economics.md'), md.join('\n'));
console.log(md.join('\n'));
