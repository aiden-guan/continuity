// Continuity benchmark CLI.
//
//   node bench/run.ts list                                   # cases per vertical / archetype / split
//   node bench/run.ts validate                               # structural validation of every case
//   node bench/run.ts selftest                               # scorer calibration (no model calls)
//   node bench/run.ts show <case-id> [--condition full-history]   # exactly what an actor would receive
//   node bench/run.ts estimate [filters]                     # token + cost estimate, no model calls
//   node bench/run.ts freeze                                 # hash the eval split into bench/manifest.json
//   node bench/run.ts run [filters] [--mock]                 # run the benchmark (writes bench/results/<name>/)
//   node bench/run.ts report <results-dir>                   # re-render the report from rows.jsonl
//
// Filters: --verticals procurement,freight  --split golden,dev,eval  --archetypes correction,…  --variants 0,3
//          --priority P0  --conditions primitive-native,retrieval,…  --backlog 0,40,160  --mess 0,1,2,3  --trials 3
// Model:   --model claude-haiku-5-5 (every condition)  --judge-model <id> (default: same)  --effort low|medium|high (actor; default medium)
// Run:     --name <dir>  --concurrency 6 (provider requests)  --cell-concurrency 4  --refresh (ignore cache)
//          --mock (no provider calls anywhere; Continuity uses the rule extractor)  --allow-unfrozen
//          Reusing --name resumes: finished cells are skipped, cells that errored are retried.
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadVerticals, enumerate, type CaseFilter } from './verticals/index.ts';
import type { BenchCase, Split, VerticalModule, AgentOutput } from './core/types.ts';
import { validateCase } from './core/validate.ts';
import { selftestActions, selftestCase } from './core/selftest.ts';
import { withBacklog } from './core/scale.ts';
import { withMess, type MessLevel } from './core/perturb.ts';
import { materialize } from './core/mailbox.ts';
import { actorInput, actorSystem } from './core/actor.ts';
import { CONDITIONS, conditionById } from './conditions/index.ts';
import { DEFAULT_MODEL, Llm, PRICING, estimateTokens } from './core/llm.ts';
import { runCell, type Row } from './core/pipeline.ts';
import { renderReport } from './core/report.ts';

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    verticals: { type: 'string', default: '' },
    split: { type: 'string', default: '' },
    archetypes: { type: 'string', default: '' },
    variants: { type: 'string', default: '' },
    priority: { type: 'string', default: '' },
    conditions: { type: 'string', default: '' },
    condition: { type: 'string', default: '' },
    backlog: { type: 'string', default: '0' },
    mess: { type: 'string', default: '0' },
    trials: { type: 'string', default: '1' },
    model: { type: 'string', default: process.env.BENCH_MODEL || DEFAULT_MODEL },
    'judge-model': { type: 'string', default: '' },
    effort: { type: 'string', default: 'medium' },
    name: { type: 'string', default: '' },
    concurrency: { type: 'string', default: '6' },
    'cell-concurrency': { type: 'string', default: '4' },
    refresh: { type: 'boolean', default: false },
    mock: { type: 'boolean', default: false },
    'allow-unfrozen': { type: 'boolean', default: false },
  },
});
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const [command, ...rest] = positionals;
const MANIFEST = 'bench/manifest.json';

async function selected(): Promise<{ mod: VerticalModule; case: BenchCase; base: BenchCase }[]> {
  const mods = await loadVerticals(list(a.verticals));
  const filter: CaseFilter = {
    splits: (list(a.split) as Split[]).length ? (list(a.split) as Split[]) : undefined,
    archetypes: list(a.archetypes),
    variants: a.variants ? list(a.variants).map(Number) : undefined,
    priority: (a.priority || undefined) as CaseFilter['priority'],
  };
  const base = enumerate(mods, filter);
  const backlogs = list(a.backlog).map(Number);
  const messes = list(a.mess).map(Number);
  return base.flatMap((x) => backlogs.flatMap((n) => messes.map((lvl) => {
    const b = withBacklog(x.case, n, x.mod);
    return { mod: x.mod, case: lvl ? withMess(b, lvl as MessLevel) : b, base: x.case };
  })));
}

/** rows.jsonl is append-only: a retried cell appends a new row. One row per key: the last non-error row, else the last error. */
function latestRows(rows: Row[]): Row[] {
  const by = new Map<string, Row>();
  for (const r of rows) {
    const prev = by.get(r.key);
    if (!r.error || !prev || prev.error) by.set(r.key, r);
  }
  return [...by.values()];
}
const readRows = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row) : []);

const caseHash = (c: BenchCase) => createHash('sha256').update(JSON.stringify(c)).digest('hex');

/** Backlog and mess variants are transforms of a frozen base case: the base (id before `@`) is what gets checked. */
function checkFrozen(cases: { case: BenchCase; base: BenchCase }[]) {
  const evalCases = [...new Map(cases.filter((x) => x.base.split === 'eval').map((x) => [x.base.id, x.base])).values()];
  if (!evalCases.length || a['allow-unfrozen']) return;
  if (!existsSync(MANIFEST)) throw new Error('eval split is not frozen: run `node bench/run.ts freeze` first (or pass --allow-unfrozen)');
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { cases: Record<string, string> };
  const changed = evalCases.filter((c) => manifest.cases[c.id] !== caseHash(c)).map((c) => c.id);
  if (changed.length) throw new Error(`eval cases changed since freeze (${changed.length}): ${changed.slice(0, 5).join(', ')}… — re-freezing after looking at results invalidates the held-out split`);
}

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }));
}

async function main() {
  switch (command) {
    case 'list': {
      const cases = await selected();
      const by = new Map<string, Record<string, number>>();
      for (const { case: c } of cases) {
        const k = `${c.vertical}/${c.archetype}`;
        const row = by.get(k) ?? {};
        row[c.split] = (row[c.split] ?? 0) + 1;
        by.set(k, row);
      }
      for (const [k, v] of [...by].sort()) console.log(`${k.padEnd(40)} golden ${v.golden ?? 0}  dev ${v.dev ?? 0}  eval ${v.eval ?? 0}`);
      console.log(`\n${cases.length} cases`);
      return;
    }
    case 'validate': {
      const cases = await selected();
      const errors = cases.flatMap(({ mod, case: c }) => validateCase(c, mod.vertical));
      errors.slice(0, 50).forEach((e) => console.log(`✗ ${e}`));
      console.log(errors.length ? `\n${errors.length} problem(s) in ${cases.length} cases` : `all ${cases.length} cases valid`);
      process.exitCode = errors.length ? 1 : 0;
      return;
    }
    case 'selftest': {
      const cases = await selected();
      const fails = cases.flatMap(({ mod, case: c }) => [...selftestCase(mod, c), ...selftestActions(mod, c)]);
      fails.slice(0, 60).forEach((f) => console.log(`✗ ${f}`));
      console.log(fails.length ? `\n${fails.length} scorer/oracle problem(s) over ${cases.length} cases` : `scorer calibration passed on ${cases.length} cases (perfect=1, stale→SFER, zombie loops, empty, action checks)`);
      process.exitCode = fails.length ? 1 : 0;
      return;
    }
    case 'show': {
      const id = rest[0];
      const cases = await selected();
      const hit = cases.find((x) => x.case.id === id) ?? (await (async () => {
        const [v] = id.split('/');
        const mods = await loadVerticals([v]);
        const [, arch, variant] = id.split('@')[0].split('/');
        const found = enumerate(mods, { archetypes: [arch], variants: [Number(variant)] })[0];
        const n = Number(id.match(/@backlog(\d+)/)?.[1] ?? 0);
        const lvl = Number(id.match(/@mess(\d)/)?.[1] ?? 0);
        if (!found) return undefined;
        const b = withBacklog(found.case, n, found.mod);
        return { mod: found.mod, case: lvl ? withMess(b, lvl as MessLevel) : b };
      })());
      if (!hit) throw new Error(`no case ${id}`);
      const mb = materialize(hit.case);
      if (!a.condition) {
        console.log(JSON.stringify({ ...hit.case, events: hit.case.events.map((e) => ({ ...e, attachments: e.attachments?.map((x) => x.filename) })) }, null, 1));
        return;
      }
      const cond = conditionById(a.condition);
      if (cond.usesModel) throw new Error(`${cond.id} needs model calls to build its memory; show supports: ${CONDITIONS.filter((c) => !c.usesModel).map((c) => c.id).join(', ')}`);
      const llm = new Llm({ mock: () => ({ text: '{}' }) });
      const p = await cond.prepare(mb, { llm, vertical: hit.mod.vertical, trial: 1, cacheDir: '.scratch/bench-cache', mock: true });
      if (p.unsupported) return console.log(`unsupported: ${p.unsupported}`);
      console.log(`=== SYSTEM ===\n${actorSystem(hit.mod.vertical)}\n\n=== USER ===\n${actorInput(mb, p.label, p.memory)}\n\n=== diag ===\n${JSON.stringify(p.diag ?? {}, null, 1)}`);
      return;
    }
    case 'estimate': {
      const cases = await selected();
      const conds = (list(a.conditions).length ? list(a.conditions) : CONDITIONS.map((c) => c.id)).map(conditionById);
      const trials = Number(a.trials);
      const price = PRICING[a.model] ?? PRICING[DEFAULT_MODEL];
      // Haiku's tokenizer counts ~30% more tokens than chars/4 suggests for this kind of text; estimates use chars/3.
      const tok = (chars: number) => Math.ceil(chars / 3);
      const ACTOR_OUT = 2500; // state report + emails + adaptive thinking at medium effort
      const per: Record<string, { in: number; out: number; calls: number }> = {};
      for (const { mod, case: c } of cases) {
        const mb = materialize(c);
        const sys = actorSystem(mod.vertical).length;
        const taskMsgs = mb.messages.filter((m) => m.task && m.id !== mb.trigger.id);
        const linked = mb.messages.length;
        for (const cond of conds) {
          const e = (per[cond.id] ??= { in: 0, out: 0, calls: 0 });
          let memChars = 0;
          if (!cond.usesModel || cond.id === 'continuity') {
            if (cond.id !== 'continuity') {
              const p = await cond.prepare(mb, { llm: new Llm({ mock: () => ({ text: '{}' }) }), vertical: mod.vertical, trial: 1, cacheDir: '.scratch/bench-cache', mock: true });
              if (p.unsupported) continue;
              memChars = p.memory.length;
            } else {
              const p = await conditionById('continuity-rules').prepare(mb, { llm: new Llm({ mock: () => ({ text: '{}' }) }), vertical: mod.vertical, trial: 1, cacheDir: '.scratch/bench-cache', mock: true });
              if (p.unsupported) continue;
              memChars = p.memory.length;
              e.in += linked * tok(6000 + 1500); e.out += linked * 1200; e.calls += linked; // extractor per event
            }
          }
          if (cond.id === 'rolling-summary') { memChars = 4000; e.in += taskMsgs.reduce((s, m) => s + tok(2500 + 4000 + m.body.length), 0); e.out += taskMsgs.length * 1200; e.calls += taskMsgs.length; }
          if (cond.id === 'agent-notes') { memChars = 5000; e.in += taskMsgs.reduce((s, m) => s + tok(4000 + 5000 + m.body.length), 0); e.out += taskMsgs.length * 2000; e.calls += taskMsgs.length; }
          if (cond.id === 'primitive-native') { memChars = 9000; e.in += 7 * tok(4000 + 4500); e.out += 7 * 400; e.calls += 7; }
          e.in += tok(sys + 1500 + memChars); e.out += ACTOR_OUT; e.calls += 1; // actor
          e.in += tok(3000); e.out += 700; e.calls += 1; // judge
        }
      }
      let total = 0;
      console.log(`Estimate for ${cases.length} cases × ${trials} trial(s) on ${a.model} ($${price.in}/$${price.out} per MTok, as of ${price.asOf}); no model calls made.\n`);
      for (const [id, e] of Object.entries(per)) {
        const cost = ((e.in * price.in + e.out * price.out) / 1e6) * trials;
        total += cost;
        console.log(`${id.padEnd(18)} calls ${String(e.calls * trials).padStart(6)}  in ${(e.in * trials / 1e6).toFixed(2)}M  out ${(e.out * trials / 1e6).toFixed(2)}M  ≈ $${cost.toFixed(2)}`);
      }
      console.log(`\nTotal ≈ $${total.toFixed(2)} (rough; thinking length dominates the uncertainty — treat as ±50%)`);
      return;
    }
    case 'freeze': {
      const mods = await loadVerticals();
      const cases = enumerate(mods, { splits: ['eval'] });
      const manifest = { frozen_at: new Date().toISOString(), note: 'sha256 of every eval case; runs on the eval split refuse to start if a case changed', cases: Object.fromEntries(cases.map((x) => [x.case.id, caseHash(x.case)])) };
      writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 1)}\n`);
      console.log(`froze ${cases.length} eval cases → ${MANIFEST}`);
      return;
    }
    case 'run': {
      const cases = await selected();
      checkFrozen(cases);
      const conds = (list(a.conditions).length ? list(a.conditions) : CONDITIONS.map((c) => c.id)).map(conditionById);
      const trials = Number(a.trials);
      const name = a.name || `${new Date().toISOString().replace(/[:.]/g, '-')}${a.mock ? '-mock' : ''}`;
      const dir = join('bench/results', name);
      mkdirSync(dir, { recursive: true });
      const cacheDir = join('.scratch/bench-cache', a.model);
      const effort = a.effort as 'low' | 'medium' | 'high';
      if (!['low', 'medium', 'high'].includes(effort)) throw new Error(`--effort must be low, medium or high (got "${a.effort}")`);
      const llm = new Llm({ model: a.model, cacheDir, concurrency: Number(a.concurrency), refresh: a.refresh, mock: a.mock ? mockAnswer : undefined });
      const judgeLlm = a['judge-model'] && a['judge-model'] !== a.model ? new Llm({ model: a['judge-model'], cacheDir: join('.scratch/bench-cache', a['judge-model']), concurrency: Number(a.concurrency), refresh: a.refresh, mock: a.mock ? mockAnswer : undefined }) : llm;
      const rowsFile = join(dir, 'rows.jsonl');
      const metaFile = join(dir, 'meta.json');
      // resume keys are case|condition|trial: resuming under a different model/effort would mix runs in one report
      if (existsSync(metaFile)) {
        const prev = JSON.parse(readFileSync(metaFile, 'utf8')) as { model?: string; judge_model?: string; effort?: string; mock?: boolean };
        const diff = ([['model', prev.model, a.model], ['judge model', prev.judge_model, judgeLlm.model], ['effort', prev.effort ?? 'medium', effort], ['mock', Boolean(prev.mock), a.mock]] as const).filter(([, x, y]) => x !== y);
        if (diff.length) throw new Error(`${dir} was run with ${diff.map(([k, x, y]) => `${k} ${x} (now ${y})`).join(', ')}; pick a new --name`);
      }
      const done = new Set(latestRows(readRows(rowsFile)).filter((r) => !r.error).map((r) => r.key));
      const meta = { name, model: a.model, judge_model: judgeLlm.model, effort, trials, splits: a.split || 'golden,dev,eval', conditions: conds.map((c) => c.id), backlog: a.backlog, mess: a.mess, mock: a.mock, started_at: new Date().toISOString(), cases: cases.length };
      writeFileSync(metaFile, JSON.stringify(meta, null, 1));
      const cells = cases.flatMap(({ mod, case: c }) => conds.flatMap((condition) => Array.from({ length: trials }, (_, t) => ({ mod, c, condition, trial: t + 1 }))))
        .filter((x) => !done.has(`${x.c.id}|${x.condition.id}|${x.trial}`));
      console.log(`${cases.length} cases × ${conds.length} conditions × ${trials} trial(s) = ${cells.length} cells to run (${done.size} already done; errored cells are retried) → ${dir}${a.mock ? '  [MOCK]' : ''}`);
      let finished = 0;
      await pool(cells, Number(a['cell-concurrency']), async (cell) => {
        const row = await runCell({ ...cell, llm, judgeLlm, cacheDir, mock: a.mock, refresh: a.refresh, effort });
        appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
        finished++;
        const mark = row.unsupported ? 'n/a' : row.error ? 'ERR' : row.chs ? 'PASS' : 'fail';
        console.log(`[${finished}/${cells.length}] ${mark.padEnd(4)} ${row.case_id} · ${row.condition}${trials > 1 ? ` · t${row.trial}` : ''}${row.error ? ` — ${row.error.split('\n')[0]}` : ''}`);
      });
      writeReport(dir);
      return;
    }
    case 'report': {
      writeReport(rest[0]);
      return;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  }
}

function writeReport(dir: string) {
  const rows = latestRows(readRows(join(dir, 'rows.jsonl')));
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const { markdown, summary } = renderReport(rows, meta);
  writeFileSync(join(dir, 'report.md'), markdown);
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
  console.log(`\n${markdown.split('\n## Paired')[0]}\nwrote ${join(dir, 'report.md')}`);
}

/** Mock answers: structurally valid, content-free. Exercises every code path without a provider. */
function mockAnswer(req: { purpose: string }) {
  const empty: AgentOutput = { current_terms: [], superseded_terms: [], open_loops: [], conflicts: [], documents: [], next_actor: 'us', decision: { action: 'wait', messages: [], rationale: 'mock' } };
  switch (req.purpose) {
    case 'actor': case 'notes': return { text: JSON.stringify(empty) };
    case 'judge': return { text: JSON.stringify({ verdicts: [] }) };
    case 'summary': return { text: 'mock summary' };
    default: return { text: 'DONE' };
  }
}

void estimateTokens;
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
