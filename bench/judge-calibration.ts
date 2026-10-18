// Judge calibration: hand-labelled drafts with known verdicts, so the judge's agreement with a human
// is measured instead of assumed. Run before trusting judged conditions in a report.
//
//   node --env-file=.env bench/judge-calibration.ts [--model claude-haiku-5-5] [--verticals procurement,hotel]
//
// Fixtures live in bench/judge-fixtures/<vertical>.ts (each exports `FIXTURES: Fixture[]`). Each one is
// a set of drafts for a real case (golden variant) with the expected truth of every judged condition.
// The labels were written by hand from the condition text and the case facts, including deliberate
// edge cases: disclaimers ("the earlier date no longer holds" is not relying on it), negated
// acceptance, vague drafts, quote-status questions and soft re-asks.
//
// The report gives agreement overall, per vertical and per condition, plus a confusion summary:
// false-met (label false, judge said true) and false-unmet (label true, judge said false).
import { readdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadVerticals, enumerate } from './verticals/index.ts';
import { materialize } from './core/mailbox.ts';
import { judge } from './core/judge.ts';
import { judgeConditions } from './core/score.ts';
import { DEFAULT_MODEL, Llm } from './core/llm.ts';
import type { AgentOutput } from './core/types.ts';
import type { Fixture } from './judge-fixtures/types.ts';

export type { Fixture } from './judge-fixtures/types.ts';

const FIXTURE_DIR = new URL('./judge-fixtures/', import.meta.url);

/** Every fixture file in bench/judge-fixtures, keyed by vertical (the file name). */
export async function loadFixtures(only?: string[]): Promise<Map<string, Fixture[]>> {
  const out = new Map<string, Fixture[]>();
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.ts') && f !== 'types.ts').sort();
  for (const file of files) {
    const vertical = file.replace(/\.ts$/, '');
    if (only?.length && !only.includes(vertical)) continue;
    const mod = (await import(new URL(file, FIXTURE_DIR).href)) as { FIXTURES: Fixture[] };
    out.set(vertical, mod.FIXTURES);
  }
  return out;
}

interface Tally { agree: number; total: number; falseMet: number; falseUnmet: number }
const tally = (): Tally => ({ agree: 0, total: 0, falseMet: 0, falseUnmet: 0 });
const pct = (t: Tally) => `${((100 * t.agree) / Math.max(1, t.total)).toFixed(1)}%`;
const line = (label: string, t: Tally, width = 44) => `  ${label.padEnd(width)} ${`${t.agree}/${t.total}`.padStart(7)} ${pct(t).padStart(6)}  false-met ${t.falseMet}  false-unmet ${t.falseUnmet}`;

/** Runs every fixture through the judge and prints the agreement report. */
export async function calibrate(llm: Llm, model: string, only?: string[]) {
  const fixtures = await loadFixtures(only);
  const mods = await loadVerticals([...fixtures.keys()]);
  const cases = enumerate(mods, { splits: ['golden'] });

  const overall = tally();
  const perVertical = new Map<string, Tally>();
  const perCond = new Map<string, Tally>();
  const perKind = new Map<string, Tally>();
  const bump = (m: Map<string, Tally>, k: string, ok: boolean, expected: boolean) => {
    const t = m.get(k) ?? tally();
    t.total++;
    if (ok) t.agree++;
    else if (expected) t.falseUnmet++;
    else t.falseMet++;
    m.set(k, t);
  };

  for (const [vertical, list] of fixtures) {
    console.log(`\n# ${vertical} (${list.length} fixtures)`);
    for (const f of list) {
      const hit = cases.find((x) => x.case.id === f.case_id);
      if (!hit) { console.log(`skip ${f.case_id} (case not found)`); continue; }
      const mb = materialize(hit.case);
      const conds = judgeConditions(mb.checkpoint.action!).filter((c) => c.id in f.expected);
      const out: AgentOutput = { current_terms: [], superseded_terms: [], open_loops: [], conflicts: [], documents: [], next_actor: 'us', decision: { action: 'send', messages: f.drafts.map((d) => ({ ...d, subject: null })), rationale: '' } };
      const { verdicts } = await judge(llm, mb, out, conds);
      const wrong: string[] = [];
      for (const c of conds) {
        const want = f.expected[c.id];
        const got = verdicts.get(c.id)?.met ?? false;
        const ok = got === want;
        overall.total++;
        if (ok) overall.agree++;
        else if (want) overall.falseUnmet++;
        else overall.falseMet++;
        bump(perVertical, vertical, ok, want);
        bump(perCond, `${f.case_id.replace(/\/0$/, '')}:${c.id}`, ok, want);
        bump(perKind, f.kind, ok, want);
        if (!ok) wrong.push(`${c.id}: expected ${want}, judge said ${got} (${want ? 'false-unmet' : 'false-met'})${verdicts.get(c.id)?.quote ? ` — "${verdicts.get(c.id)!.quote}"` : ''}`);
      }
      console.log(`${wrong.length ? '✗' : '✓'} ${f.case_id} [${f.kind}] — ${f.note}${wrong.length ? `\n    ${wrong.join('\n    ')}` : ''}`);
    }
  }

  console.log(`\nJudge agreement with hand labels: ${overall.agree}/${overall.total} (${pct(overall)}) on ${model}`);
  console.log(`Confusion: false-met ${overall.falseMet} (judge said met, label unmet), false-unmet ${overall.falseUnmet} (judge said unmet, label met)`);
  console.log('\nPer vertical:');
  for (const [v, t] of perVertical) console.log(line(v, t));
  console.log('\nPer fixture kind:');
  for (const [k, t] of perKind) console.log(line(k, t));
  console.log('\nPer condition:');
  const width = Math.max(24, ...[...perCond.keys()].map((k) => k.length));
  for (const [id, t] of [...perCond].sort(([a], [b]) => a.localeCompare(b))) console.log(`${line(id, t, width)}${t.agree < t.total ? '  ◀' : ''}`);
}

async function main() {
  const { values } = parseArgs({ options: { model: { type: 'string', default: DEFAULT_MODEL }, verticals: { type: 'string' } } });
  const only = values.verticals?.split(',').map((s) => s.trim()).filter(Boolean);
  await calibrate(new Llm({ model: values.model, cacheDir: `.scratch/bench-cache/${values.model}` }), values.model!, only);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
