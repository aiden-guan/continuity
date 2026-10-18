// Value benchmark, Fig 2 (event-driven): a fresh agent wakes on every inbound task email of a thread,
// and we measure what each condition spends per wake, for real. No grading here (intermediate wakes
// have no labels); accuracy comes from the final-decision runs (bench/value/run.ts).
//
//   node bench/value/wakes.ts --name <n> [--archetypes value_chain_d6] [--variants 11,12] [--conditions …]
//
// Accounting per wake:
//   continuity       extraction of the mail that arrived since the previous wake + the actor on the briefing
//   rolling-summary  one summary rewrite per new task email + the actor on the summary
//   primitive-native the tool loop (reads) + the actor on what it read
//   full-history     the actor on every task email so far
// Incremental ingestion is the difference between successive prefix replays (extraction and summary
// results are cached on disk, so a replay re-reports the original call's usage without a new call).
// Costs are reported as measured and as cold-cache (every input token at the full input price): wakes
// that are hours apart do not share a prompt cache.
import { parseArgs } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BenchCase, Checkpoint } from '../core/types.ts';
import { materialize } from '../core/mailbox.ts';
import { act } from '../core/actor.ts';
import { conditionById } from '../conditions/index.ts';
import { DEFAULT_MODEL, Llm, PRICING, estimateTokens, sumUsage } from '../core/llm.ts';
import { valueModule } from './index.ts';

process.env.CONTINUITY_EXTRACTOR_THINKING ??= 'off';
process.env.CONTINUITY_EXTRACT_ROUTE ??= 'skip-empty,outbound-plain-rules';

const { values: a } = parseArgs({
  options: {
    archetypes: { type: 'string', default: 'value_chain_d6' },
    variants: { type: 'string', default: '11,12,13,14,15,16' },
    conditions: { type: 'string', default: 'continuity,rolling-summary,primitive-native,full-history' },
    name: { type: 'string', default: 'wakes' },
    model: { type: 'string', default: process.env.BENCH_MODEL || DEFAULT_MODEL },
    concurrency: { type: 'string', default: '8' },
    'case-concurrency': { type: 'string', default: '4' },
  },
});
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const dir = join('bench/results', `value-${a.name}`);
mkdirSync(dir, { recursive: true });
const rowsFile = join(dir, 'wakes.jsonl');
const cacheDir = join('.scratch/bench-cache', a.model);
const llm = new Llm({ model: a.model, cacheDir, concurrency: Number(a.concurrency) });
const price = PRICING[a.model];
const cold = (u: { input_tokens: number; output_tokens: number }) => (u.input_tokens * price.in + u.output_tokens * price.out) / 1e6;
const git = (...args: string[]) => { try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return ''; } };

const cases: BenchCase[] = valueModule.archetypes.filter((x) => list(a.archetypes).includes(x.id)).flatMap((x) => list(a.variants).map((v) => x.generate(Number(v))));
const conds = list(a.conditions).map(conditionById);
writeFileSync(join(dir, 'meta.json'), JSON.stringify({ name: `value-${a.name}`, kind: 'wakes', model: a.model, cases: cases.map((c) => c.id), conditions: conds.map((c) => c.id), commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0, extractor: { thinking: process.env.CONTINUITY_EXTRACTOR_THINKING, route: process.env.CONTINUITY_EXTRACT_ROUTE }, price, started_at: new Date().toISOString() }, null, 1));
const done = new Set(existsSync(rowsFile) ? readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.case_id}|${r.condition}`; }) : []);

async function runCase(c: BenchCase) {
  const final = c.checkpoints.at(-1)!;
  // wake on every inbound task email from the quote onward (the RFQ is ours)
  const wakeKeys = c.events.filter((e) => !e.background && e.direction === 'inbound').map((e) => e.key);
  for (const cond of conds) {
    if (done.has(`${c.id}|${cond.id}`)) continue;
    let prevIngest = { input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 };
    const wakes = [];
    for (const [i, key] of wakeKeys.entries()) {
      const ev = c.events.find((e) => e.key === key)!;
      const cp: Checkpoint = { id: `wake_${i + 1}`, after: key, now: new Date(Date.parse(ev.at) + 5 * 60_000).toISOString().replace('.000', ''), state: final.state, action: final.action, judge_facts: final.judge_facts };
      const mb = materialize(c, cp);
      const prepared = await cond.prepare(mb, { llm, vertical: valueModule.vertical, trial: 1, cacheDir, mock: false });
      const actor = await act(llm, valueModule.vertical, mb, prepared.label, prepared.memory, 1);
      const ing = sumUsage(prepared.ingestion);
      const incr = { input_tokens: ing.input_tokens - prevIngest.input_tokens, output_tokens: ing.output_tokens - prevIngest.output_tokens, cost_usd: ing.cost_usd - prevIngest.cost_usd, calls: ing.calls - prevIngest.calls };
      prevIngest = ing;
      const ret = sumUsage(prepared.retrieval);
      const act_u = { input_tokens: actor.input_tokens, output_tokens: actor.output_tokens };
      const total = { input_tokens: incr.input_tokens + ret.input_tokens + act_u.input_tokens, output_tokens: incr.output_tokens + ret.output_tokens + act_u.output_tokens };
      wakes.push({
        wake: i + 1, key, task_messages_visible: mb.messages.filter((m) => m.task).length, memory_tokens_est: estimateTokens(prepared.memory),
        ingestion: incr, retrieval: ret, actor: { ...act_u, cost_usd: actor.record.cost_usd },
        cost_measured: incr.cost_usd + ret.cost_usd + actor.record.cost_usd, cost_cold: cold(total), tokens: total.input_tokens + total.output_tokens,
        decision: actor.output.decision.action,
      });
    }
    const row = { case_id: c.id, condition: cond.id, wakes, lifetime_cost_measured: wakes.reduce((s, w) => s + w.cost_measured, 0), lifetime_cost_cold: wakes.reduce((s, w) => s + w.cost_cold, 0), lifetime_tokens: wakes.reduce((s, w) => s + w.tokens, 0) };
    appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
    console.log(`${c.id} · ${cond.id}: ${wakes.length} wakes, $${row.lifetime_cost_cold.toFixed(4)} cold / $${row.lifetime_cost_measured.toFixed(4)} measured, ${row.lifetime_tokens.toLocaleString('en-US')} tokens`);
  }
}

let next = 0;
await Promise.all(Array.from({ length: Math.min(Number(a['case-concurrency']), cases.length) }, async () => {
  while (next < cases.length) {
    const c = cases[next++];
    try { await runCase(c); } catch (e) { console.error(`${c.id}: ${(e as Error).stack}`); }
  }
}));
console.log(`wrote ${rowsFile}`);
