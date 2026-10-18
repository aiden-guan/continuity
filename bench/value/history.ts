// Value benchmark, Fig 3: event-history reasoning. On the dependency-chain cases, ask what an auditor
// asks after the fact, with answers taken from the generator's own trace (never from Continuity):
//   Q1  right after message X, which problems blocked the order?        (state as of an event)
//   Q2  right after message X, what were the unit price and the approved cap?
//   Q3  which message made <old value> no longer valid?                    (causal link, by message id)
//
// Conditions (same model, same prompt, same answer schema; only the material differs):
//   full-history          every task email so far
//   rolling-summary       the ≤700-word running summary
//   agent-notes           the model's own structured notes: a latest-state snapshot
//   continuity-briefing   Continuity's compiled briefing (current state, superseded values with sources)
//   continuity-history    the briefing plus Continuity's as-of replay as a tool: state_at(message id)
//                         rebuilds the state from the event log up to that message (what the API's
//                         as_of does), at most 3 calls
//
//   node bench/value/history.ts --name <n> [--archetypes value_chain_d4,value_chain_d6] [--variants …] [--trials 3]
import { parseArgs } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BenchCase } from '../core/types.ts';
import { materialize, taskHeader, type Mailbox } from '../core/mailbox.ts';
import { conditionById } from '../conditions/index.ts';
import { continuity } from '../conditions/continuity.ts';
import { DEFAULT_MODEL, Llm, PRICING, estimateTokens, sumUsage, type CallRecord } from '../core/llm.ts';
import { bootstrapMean, mean } from '../core/stats.ts';
import { moneyShort, sayDate } from '../core/util.ts';
import { valueModule } from './index.ts';

process.env.CONTINUITY_EXTRACTOR_THINKING ??= 'off';
process.env.CONTINUITY_EXTRACT_ROUTE ??= 'skip-empty,outbound-plain-rules';

const { values: a } = parseArgs({
  options: {
    archetypes: { type: 'string', default: 'value_chain_d4,value_chain_d6' },
    variants: { type: 'string', default: '11,12,13,14,15,16,17,18,19,20,21,22' },
    conditions: { type: 'string', default: 'full-history,rolling-summary,agent-notes,continuity-briefing,continuity-history' },
    trials: { type: 'string', default: '3' },
    name: { type: 'string', default: 'history' },
    model: { type: 'string', default: process.env.BENCH_MODEL || DEFAULT_MODEL },
    concurrency: { type: 'string', default: '8' },
    'cell-concurrency': { type: 'string', default: '6' },
  },
});
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const dir = join('bench/results', `value-${a.name}`);
mkdirSync(dir, { recursive: true });
const rowsFile = join(dir, 'history.jsonl');
const cacheDir = join('.scratch/bench-cache', a.model);
const llm = new Llm({ model: a.model, cacheDir, concurrency: Number(a.concurrency) });
const price = PRICING[a.model];
const cold = (u: { input_tokens: number; output_tokens: number }) => (u.input_tokens * price.in + u.output_tokens * price.out) / 1e6;
const git = (...args: string[]) => { try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return ''; } };

// ------------------------------------------------------------------ questions from the generator trace

type Blocker = 'over_budget' | 'late_units' | 'disputed_date' | 'quote_owed';
const BLOCKER_OF: Record<string, Blocker> = { over: 'over_budget', late: 'late_units', contested: 'disputed_date', quoteOwed: 'quote_owed' };
interface TraceStep { step: number; type: string; events: string[]; price: number; budget: number; lots: { qty: number; date: string }[]; quoteOwed: boolean; contested: boolean; blockers: string[] }
interface Questions { at_id: string; at_desc: string; q1: Blocker[]; q2: { price: number; budget: number }; q3: { term: string; label: string; value: string; answer_id: string } | null; text: string; differs_from_final: boolean }

function questionsOf(c: BenchCase, mb: Mailbox): Questions {
  const trace = c.params.trace as TraceStep[];
  const id = (k: string) => mb.byKey.get(k)!.id;
  // the moment asked about: the change nearest the middle whose state differs from the final state, so
  // knowing only the current state cannot answer it
  const sig = (s: TraceStep) => JSON.stringify([[...s.blockers].sort(), s.price, s.budget]);
  const last = trace.at(-1)!;
  const middle = (trace.length - 1) / 2;
  const differing = trace.slice(0, -1).filter((s) => sig(s) !== sig(last)).sort((x, y) => Math.abs(x.step - 1 - middle) - Math.abs(y.step - 1 - middle) || x.step - y.step);
  const mid = differing[0] ?? trace[Math.floor(middle)];
  const atKey = mid.events.at(-1)!;
  const atMsg = mb.byKey.get(atKey)!;
  const party = c.task.parties.find((p) => p.address === atMsg.event.from)?.label ?? 'us';
  const at_desc = `message ${atMsg.id} (from ${party}, ${sayDate(atMsg.event.at.slice(0, 10), 'weekday_short_date')})`;
  // a value that was valid once, was replaced exactly once and never came back: its replacing message is unambiguous
  const ev = c.params.events_of as { quote: string; approval: string };
  const series: Record<string, { value: string; label: string; key: string }[]> = { price: [{ value: moneyShort(c.params.price0 as number), label: 'unit price', key: ev.quote }], budget: [{ value: moneyShort(c.params.budget0 as number), label: "finance's approved cap", key: ev.approval }] };
  for (const s of trace) {
    const last = s.events.at(-1)!;
    const pv = moneyShort(s.price);
    if (series.price.at(-1)!.value !== pv) series.price.push({ value: pv, label: 'unit price', key: last });
    const bv = moneyShort(s.budget);
    if (series.budget.at(-1)!.value !== bv) series.budget.push({ value: bv, label: "finance's approved cap", key: last });
  }
  const cands: Questions['q3'][] = [];
  for (const [term, xs] of Object.entries(series)) {
    xs.forEach((x, i) => {
      if (i === xs.length - 1) return;
      if (xs.filter((y) => y.value === x.value).length !== 1) return;
      cands.push({ term, label: x.label, value: x.value, answer_id: id(xs[i + 1].key) });
    });
  }
  const q3 = cands.length ? cands[c.variant % cands.length] : null;
  const q1 = mid.blockers.map((b) => BLOCKER_OF[b]).sort();
  const text = [
    `Q1. Right after ${at_desc} arrived, which problems blocked placing the order at that moment? Choose every one that applied then: over_budget (the supplier's unit price at that time was above finance's approved cap at that time), late_units (some units were due after the deadline), disputed_date (the supplier and its freight forwarder disagreed on the delivery date), quote_owed (the supplier had promised a revised or updated quote that had not arrived yet). Answer ["none"] if nothing blocked the order then.`,
    `Q2. At that same moment (right after ${atMsg.id}), what was the supplier's unit price, and what was finance's approved cap per unit?`,
    q3 ? `Q3. Which message made ${q3.term === 'price' ? "the supplier's unit price" : "finance's approved cap"} of ${q3.value} no longer valid? Give its message id.` : 'Q3. (no question; answer null)',
  ].join('\n');
  return { at_id: atMsg.id, at_desc, q1, q2: { price: mid.price, budget: mid.budget }, q3, text, differs_from_final: sig(mid) !== sig(last) };
}

// ------------------------------------------------------------------ answering

const SYSTEM = `You answer an auditor's questions about the history of an email-based procurement task (Acme buying from a supplier, with an internal finance approver). Use only the material you are given${''} and, if you have tools, what they return. Message ids look like m07. Answer as JSON. Be exact about timing: "right after message X" means taking into account everything up to and including message X, and nothing that came later.`;
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['q1_blockers', 'q2_unit_price', 'q2_budget_cap', 'q3_message_id', 'explanation'],
  properties: {
    q1_blockers: { type: 'array', items: { type: 'string', enum: ['over_budget', 'late_units', 'disputed_date', 'quote_owed', 'none'] } },
    q2_unit_price: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    q2_budget_cap: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    q3_message_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    explanation: { type: 'string' },
  },
};
const STATE_AT = { name: 'state_at', description: "Continuity's state of this task rebuilt from its event log up to and including one message: what was known right after that message (terms, conflicts, open loops, checks). Same format as the briefing.", input_schema: { type: 'object', additionalProperties: false, properties: { message_id: { type: 'string', description: 'a message id such as m07' } }, required: ['message_id'] } };
const TOOL_BUDGET = 3;

interface Answer { q1_blockers: string[]; q2_unit_price: number | null; q2_budget_cap: number | null; q3_message_id: string | null; explanation: string }

async function answer(c: BenchCase, mb: Mailbox, label: string, memory: string, q: Questions, trial: number, withTools: boolean) {
  const header = taskHeader(mb).replace(/Current time:.*$/m, '');
  const user = `${header}\n\n<${label}>\n${memory}\n</${label}>\n\n${q.text}\n\n${withTools ? `You may call state_at up to ${TOOL_BUDGET} times before answering. ` : ''}Answer as JSON.`;
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = [{ role: 'user', content: user }];
  const calls: CallRecord[] = [];
  const toolsUsed: string[] = [];
  let used = 0;
  for (let turn = 0; turn < TOOL_BUDGET + 2; turn++) {
    const res = await llm.complete({ purpose: 'history', system: SYSTEM, messages, ...(withTools ? { tools: [STATE_AT] } : {}), schema: SCHEMA, effort: 'medium', trial, maxTokens: 8000 });
    calls.push(res.record);
    const uses = res.content.filter((b) => b.type === 'tool_use') as unknown as { id: string; name: string; input: { message_id?: string } }[];
    if (!uses.length) return { out: Llm.json<Answer>(res), calls, toolsUsed };
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const u of uses) {
      if (used >= TOOL_BUDGET) { results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Tool budget exhausted. Answer now.' }); continue; }
      used++;
      toolsUsed.push(String(u.input.message_id));
      results.push({ type: 'tool_result', tool_use_id: u.id, content: await stateAt(c, mb, String(u.input.message_id ?? ''), trial) });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new Error('no answer after the tool budget');
}

/** As-of replay: the same engine and extraction cache, over the mail up to and including that message.
 *  The API's as_of re-runs the resolver over stored proposals, so it costs no model calls; neither does this. */
async function stateAt(c: BenchCase, mb: Mailbox, messageId: string, trial: number): Promise<string> {
  const m = mb.byId.get(messageId);
  if (!m) return `no message ${messageId}`;
  const final = c.checkpoints.at(-1)!;
  const prefix = materialize(c, { ...final, after: m.key, now: new Date(Date.parse(m.event.at) + 60_000).toISOString().replace('.000', '') });
  const p = await continuity.prepare(prefix, { llm, vertical: valueModule.vertical, trial, cacheDir, mock: false });
  if (p.ingestion.some((x) => !x.cached)) console.warn(`state_at ${c.id} ${messageId}: ${p.ingestion.filter((x) => !x.cached).length} extraction(s) were not cached`);
  return p.memory;
}

// ------------------------------------------------------------------ scoring

const near = (x: number | null, y: number) => x !== null && Math.abs(x - y) < 0.005;
function score(out: Answer, q: Questions) {
  const got = [...new Set(out.q1_blockers.filter((b) => b !== 'none'))].sort();
  const q1 = got.length === q.q1.length && got.every((b, i) => b === q.q1[i]);
  const q2 = near(out.q2_unit_price, q.q2.price) && near(out.q2_budget_cap, q.q2.budget);
  const q3 = q.q3 ? (out.q3_message_id ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '') === q.q3.answer_id : null;
  return { q1, q2, q3, all: q1 && q2 && (q3 ?? true) };
}

// ------------------------------------------------------------------ run

const cases: BenchCase[] = valueModule.archetypes.filter((x) => list(a.archetypes).includes(x.id)).flatMap((x) => list(a.variants).map((v) => x.generate(Number(v))));
const condIds = list(a.conditions);
const trials = Number(a.trials);
writeFileSync(join(dir, 'meta.json'), JSON.stringify({ name: `value-${a.name}`, kind: 'history', model: a.model, trials, cases: cases.map((c) => c.id), conditions: condIds, commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0, extractor: { thinking: process.env.CONTINUITY_EXTRACTOR_THINKING, route: process.env.CONTINUITY_EXTRACT_ROUTE }, started_at: new Date().toISOString() }, null, 1));
const done = new Set(existsSync(rowsFile) ? readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return r.error ? '' : `${r.case_id}|${r.condition}|${r.trial}`; }) : []);
const cells = cases.flatMap((c) => condIds.flatMap((cond) => Array.from({ length: trials }, (_, t) => ({ c, cond, trial: t + 1 })))).filter((x) => !done.has(`${x.c.id}|${x.cond}|${x.trial}`));
console.log(`${cases.length} cases × ${condIds.length} conditions × ${trials} trials = ${cells.length} cells to run → ${rowsFile}`);

let next = 0;
let finished = 0;
await Promise.all(Array.from({ length: Math.min(Number(a['cell-concurrency']), cells.length) }, async () => {
  while (next < cells.length) {
    const { c, cond, trial } = cells[next++];
    const mb = materialize(c);
    const q = questionsOf(c, mb);
    try {
      const base = cond.startsWith('continuity') ? continuity : conditionById(cond);
      const prepared = await base.prepare(mb, { llm, vertical: valueModule.vertical, trial, cacheDir, mock: false });
      const { out, calls, toolsUsed } = await answer(c, mb, prepared.label, prepared.memory, q, trial, cond === 'continuity-history');
      const s = score(out, q);
      const query = sumUsage(calls);
      const ing = sumUsage(prepared.ingestion);
      const ret = sumUsage(prepared.retrieval);
      const row = {
        case_id: c.id, archetype: c.archetype, condition: cond, trial, gold: { q1: q.q1, q2: q.q2, q3: q.q3?.answer_id ?? null, at: q.at_id, differs_from_final: q.differs_from_final }, out, score: s, tools: toolsUsed,
        memory_tokens_est: estimateTokens(prepared.memory),
        query: { ...query, cost_cold: cold(query) }, ingestion: { ...ing, cost_cold: cold(ing) }, retrieval: { ...ret, cost_cold: cold(ret) },
      };
      appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
      console.log(`[${++finished}/${cells.length}] ${s.all ? 'PASS' : 'fail'} ${c.id} · ${cond} · t${trial}  q1 ${s.q1 ? '✓' : '✗'} q2 ${s.q2 ? '✓' : '✗'} q3 ${s.q3 === null ? '-' : s.q3 ? '✓' : '✗'}`);
    } catch (e) {
      appendFileSync(rowsFile, `${JSON.stringify({ case_id: c.id, condition: cond, trial, error: (e as Error).stack })}\n`);
      console.log(`[${++finished}/${cells.length}] ERR ${c.id} · ${cond} — ${(e as Error).message}`);
    }
  }
}));

// ------------------------------------------------------------------ summary
const rows = readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.error);
const md = ['# History questions', '', `${rows.length} answers · model ${a.model} · commit ${git('rev-parse', '--short', 'HEAD')}`, '', '| condition | all three right | Q1 blockers as of X | Q2 price & cap as of X | Q3 which message replaced V | query cost (cold) | memory tokens |', '|---|---|---|---|---|---|---|'];
for (const cond of condIds) {
  const rs = rows.filter((r) => r.condition === cond);
  if (!rs.length) continue;
  const byCase = (f: (r: { score: { q1: boolean; q2: boolean; q3: boolean | null; all: boolean } }) => number | null) => {
    const m = new Map<string, number[]>();
    for (const r of rs) { const v = f(r); if (v !== null) m.set(r.case_id, [...(m.get(r.case_id) ?? []), v]); }
    return bootstrapMean([...m.values()].map((xs) => mean(xs)));
  };
  const fmt = (b: { mean: number; lo: number; hi: number }) => `${(b.mean * 100).toFixed(1)}% [${(b.lo * 100).toFixed(0)}–${(b.hi * 100).toFixed(0)}]`;
  md.push(`| ${cond} | ${fmt(byCase((r) => (r.score.all ? 1 : 0)))} | ${fmt(byCase((r) => (r.score.q1 ? 1 : 0)))} | ${fmt(byCase((r) => (r.score.q2 ? 1 : 0)))} | ${fmt(byCase((r) => (r.score.q3 === null ? null : r.score.q3 ? 1 : 0)))} | $${mean(rs.map((r) => r.query.cost_cold + r.retrieval.cost_cold)).toFixed(5)} | ${Math.round(mean(rs.map((r) => r.memory_tokens_est)))} |`);
}
writeFileSync(join(dir, 'history.md'), md.join('\n'));
console.log(`\n${md.join('\n')}`);
