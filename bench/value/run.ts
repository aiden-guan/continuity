// Value benchmark CLI: the same pipeline, conditions, actor, judge and scorer as bench/run.ts, on
// the value case families (bench/value/*.ts). Results go to bench/results/value-<name>/.
//
//   node bench/value/run.ts list   [filters]
//   node bench/value/run.ts validate [filters]             # structure + scorer self-test on every case
//   node bench/value/run.ts show <case-id> [--condition full-history]
//   node bench/value/run.ts freeze                         # hash the eval split into bench/value/manifest.json
//   node bench/value/run.ts run --name <n> [filters] [--conditions a,b] [--trials 3] [--mock]
//   node bench/value/run.ts report <results-dir>
//
// Filters: --archetypes value_chain_d1,…  --split dev,eval  --variants 11,12
// Extractor config defaults to the optimization track's current setting (2026-10-18):
//   CONTINUITY_EXTRACTOR_THINKING=off  CONTINUITY_EXTRACT_ROUTE=skip-empty,outbound-plain-rules
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchCase, AgentOutput, Split } from '../core/types.ts';
import { validateCase } from '../core/validate.ts';
import { selftestActions, selftestCase } from '../core/selftest.ts';
import { materialize } from '../core/mailbox.ts';
import { actorInput, actorSystem } from '../core/actor.ts';
import { CONDITIONS, conditionById } from '../conditions/index.ts';
import { DEFAULT_MODEL, Llm } from '../core/llm.ts';
import { runCell, type Row } from '../core/pipeline.ts';
import { renderReport } from '../core/report.ts';
import { SPLIT_VARIANTS } from '../verticals/index.ts';
import { withBacklog } from '../core/scale.ts';
import { valueModule } from './index.ts';

process.env.CONTINUITY_EXTRACTOR_THINKING ??= 'off';
process.env.CONTINUITY_EXTRACT_ROUTE ??= 'skip-empty,outbound-plain-rules';

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    archetypes: { type: 'string', default: '' },
    split: { type: 'string', default: '' },
    variants: { type: 'string', default: '' },
    backlog: { type: 'string', default: '0' },
    conditions: { type: 'string', default: 'primitive-native,full-history,continuity,oracle' },
    condition: { type: 'string', default: '' },
    trials: { type: 'string', default: '1' },
    model: { type: 'string', default: process.env.BENCH_MODEL || DEFAULT_MODEL },
    effort: { type: 'string', default: 'medium' },
    name: { type: 'string', default: '' },
    concurrency: { type: 'string', default: '8' },
    'cell-concurrency': { type: 'string', default: '6' },
    refresh: { type: 'boolean', default: false },
    mock: { type: 'boolean', default: false },
    'allow-unfrozen': { type: 'boolean', default: false },
  },
});
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const [command, ...rest] = positionals;
const MANIFEST = 'bench/value/manifest.json';
// eval variants for the value suite: 12 per family (11–22)
const VALUE_SPLITS: Record<Split, number[]> = { ...SPLIT_VARIANTS, eval: Array.from({ length: 12 }, (_, i) => 11 + i) };

/** Base cases (as frozen) and, with --backlog, the same cases with N state-neutral emails appended (labels unchanged). */
function selectedWithBase(): { c: BenchCase; base: BenchCase }[] {
  const archs = valueModule.archetypes.filter((x) => !list(a.archetypes).length || list(a.archetypes).includes(x.id));
  const variants = a.variants ? list(a.variants).map(Number) : (list(a.split).length ? list(a.split) : ['golden', 'dev', 'eval']).flatMap((s) => VALUE_SPLITS[s as Split]);
  const bases = archs.flatMap((x) => variants.map((v) => x.generate(v)));
  return bases.flatMap((base) => list(a.backlog).map(Number).map((n) => ({ c: withBacklog(base, n, valueModule), base })));
}
const selected = () => selectedWithBase().map((x) => x.c);

const caseHash = (c: BenchCase) => createHash('sha256').update(JSON.stringify(c)).digest('hex');
const git = (...args: string[]) => { try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return ''; } };

function latestRows(rows: Row[]): Row[] {
  const by = new Map<string, Row>();
  for (const r of rows) {
    const prev = by.get(r.key);
    if (!r.error || !prev || prev.error) by.set(r.key, r);
  }
  return [...by.values()];
}
const readRows = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row) : []);

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

function mockAnswer(req: { purpose: string }) {
  const empty: AgentOutput = { current_terms: [], superseded_terms: [], open_loops: [], conflicts: [], documents: [], next_actor: 'us', decision: { action: 'wait', messages: [], rationale: 'mock' } };
  switch (req.purpose) {
    case 'actor': case 'notes': return { text: JSON.stringify(empty) };
    case 'judge': return { text: JSON.stringify({ verdicts: [] }) };
    case 'summary': return { text: 'mock summary' };
    default: return { text: 'DONE' };
  }
}

function writeReport(dir: string) {
  const rows = latestRows(readRows(join(dir, 'rows.jsonl')));
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const { markdown, summary } = renderReport(rows, meta);
  writeFileSync(join(dir, 'report.md'), markdown);
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
  console.log(`${markdown.split('\n## Paired')[0]}\nwrote ${join(dir, 'report.md')}`);
}

async function main() {
  switch (command) {
    case 'list': {
      const cases = selected();
      for (const c of cases) console.log(`${c.id.padEnd(36)} ${c.split.padEnd(6)} task ${String(c.params.n_task).padStart(2)}  threads ${c.params.state_threads}  ${(c.params.steps as string[]).join(' → ')}  ⇒ ${c.params.all_clear ? 'clear' : (c.params.blockers as string[]).join('+')}`);
      console.log(`\n${cases.length} cases`);
      return;
    }
    case 'validate': {
      const cases = selected();
      const errors = cases.flatMap((c) => [...validateCase(c, valueModule.vertical), ...selftestCase(valueModule, c), ...selftestActions(valueModule, c)]);
      errors.slice(0, 60).forEach((e) => console.log(`✗ ${e}`));
      console.log(errors.length ? `\n${errors.length} problem(s) in ${cases.length} cases` : `all ${cases.length} cases valid; scorer self-test passed`);
      process.exitCode = errors.length ? 1 : 0;
      return;
    }
    case 'show': {
      const id = rest[0];
      const [, arch, variant] = id.split('/');
      const archetype = valueModule.archetypes.find((x) => x.id === arch);
      if (!archetype) throw new Error(`no archetype ${arch}`);
      const c = archetype.generate(Number(variant));
      if (!a.condition) {
        console.log(JSON.stringify({ ...c, events: c.events.map((e) => ({ ...e, attachments: e.attachments?.map((x) => x.filename) })) }, null, 1));
        return;
      }
      const cond = conditionById(a.condition);
      if (cond.usesModel) throw new Error(`${cond.id} needs model calls; show supports ${CONDITIONS.filter((x) => !x.usesModel).map((x) => x.id).join(', ')}`);
      const mb = materialize(c);
      const p = await cond.prepare(mb, { llm: new Llm({ mock: () => ({ text: '{}' }) }), vertical: valueModule.vertical, trial: 1, cacheDir: '.scratch/bench-cache', mock: true });
      console.log(`=== SYSTEM ===\n${actorSystem(valueModule.vertical)}\n\n=== USER ===\n${actorInput(mb, p.label, p.memory)}`);
      return;
    }
    case 'freeze': {
      const cases = selectedWithBase().map((x) => x.base).filter((c, i, all) => c.split === 'eval' && all.findIndex((y) => y.id === c.id) === i);
      writeFileSync(MANIFEST, `${JSON.stringify({ frozen_at: new Date().toISOString(), commit: git('rev-parse', 'HEAD'), cases: Object.fromEntries(cases.map((c) => [c.id, caseHash(c)])) }, null, 1)}\n`);
      console.log(`froze ${cases.length} eval cases → ${MANIFEST}`);
      return;
    }
    case 'run': {
      const withBase = selectedWithBase();
      const cases = withBase.map((x) => x.c);
      const evalCases = [...new Map(withBase.filter((x) => x.base.split === 'eval').map((x) => [x.base.id, x.base])).values()];
      if (evalCases.length && !a['allow-unfrozen']) {
        if (!existsSync(MANIFEST)) throw new Error('value eval split is not frozen: run `node bench/value/run.ts freeze` first');
        const m = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { cases: Record<string, string> };
        const changed = evalCases.filter((c) => m.cases[c.id] !== caseHash(c)).map((c) => c.id);
        if (changed.length) throw new Error(`eval cases changed since freeze: ${changed.slice(0, 5).join(', ')}`);
      }
      const conds = list(a.conditions).map(conditionById);
      const trials = Number(a.trials);
      const name = `value-${a.name || new Date().toISOString().replace(/[:.]/g, '-')}${a.mock ? '-mock' : ''}`;
      const dir = join('bench/results', name);
      mkdirSync(dir, { recursive: true });
      const cacheDir = join('.scratch/bench-cache', a.model);
      const effort = a.effort as 'low' | 'medium' | 'high';
      const llm = new Llm({ model: a.model, cacheDir, concurrency: Number(a.concurrency), refresh: a.refresh, mock: a.mock ? mockAnswer : undefined });
      const rowsFile = join(dir, 'rows.jsonl');
      const done = new Set(latestRows(readRows(rowsFile)).filter((r) => !r.error).map((r) => r.key));
      const meta = {
        name, suite: 'value', model: a.model, judge_model: a.model, effort, trials, conditions: conds.map((c) => c.id), mock: a.mock, cases: cases.length, backlog: a.backlog,
        archetypes: [...new Set(cases.map((c) => c.archetype))], variants: [...new Set(cases.map((c) => c.variant))],
        commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0,
        extractor: { thinking: process.env.CONTINUITY_EXTRACTOR_THINKING, route: process.env.CONTINUITY_EXTRACT_ROUTE },
        started_at: new Date().toISOString(),
      };
      writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
      const cells = cases.flatMap((c) => conds.flatMap((condition) => Array.from({ length: trials }, (_, t) => ({ c, condition, trial: t + 1 }))))
        .filter((x) => !done.has(`${x.c.id}|${x.condition.id}|${x.trial}`));
      console.log(`${cases.length} cases × ${conds.length} conditions × ${trials} trial(s) = ${cells.length} cells to run (${done.size} done) → ${dir}${a.mock ? '  [MOCK]' : ''}`);
      let finished = 0;
      await pool(cells, Number(a['cell-concurrency']), async (cell) => {
        const row = await runCell({ mod: valueModule, c: cell.c, condition: cell.condition, trial: cell.trial, llm, judgeLlm: llm, cacheDir, mock: a.mock, refresh: a.refresh, effort });
        appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
        finished++;
        const mark = row.unsupported ? 'n/a' : row.error ? 'ERR' : row.chs ? 'PASS' : 'fail';
        console.log(`[${finished}/${cells.length}] ${mark.padEnd(4)} ${row.case_id} · ${row.condition}${trials > 1 ? ` · t${row.trial}` : ''}${row.error ? ` — ${row.error.split('\n')[0]}` : ''}`);
      });
      writeReport(dir);
      return;
    }
    case 'report':
      writeReport(rest[0]);
      return;
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
