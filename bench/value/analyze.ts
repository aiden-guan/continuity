// Value benchmark analysis: outcome per family level (dependency depth, thread count) and condition,
// with paired comparisons against Continuity.
//
//   node bench/value/analyze.ts <results-dir> [<results-dir> …]   → <first dir>/analysis.{md,json}
//
// Trials of one case are not independent, so every interval and test works on per-case means:
//  - 95% CIs: bootstrap over cases;
//  - paired p-values: sign-flip permutation test on per-case differences (exact when ≤ 16 cases differ);
//  - McNemar over (case, trial) pairs is also printed, for comparison with bench/run.ts reports.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Row } from '../core/pipeline.ts';
import { bootstrapMean, mcnemar, mean, pairedBootstrap } from '../core/stats.ts';
import { rng } from '../core/util.ts';

const dirs = process.argv.slice(2);
if (!dirs.length) throw new Error('usage: node bench/value/analyze.ts <results-dir> …');

// one row per case|condition|trial across every directory (a later directory wins), last good row first
const by = new Map<string, Row>();
for (const dir of dirs) {
  const file = join(dir, 'rows.jsonl');
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as Row;
    const prev = by.get(r.key);
    if (!r.error || !prev || prev.error) by.set(r.key, r);
  }
}
const rows = [...by.values()].filter((r) => !r.error && !r.unsupported);
const errors = [...by.values()].filter((r) => r.error).length;

// ---- per-row metrics
const DECISION_SKIP = new Set(['to_finance', 'to_supplier']);
interface M { chs: number; nas: number; critical: number; blockers: number; stale: number; unsafe: number; falseBlock: number | null; cost: number; tokens: number; memory: number; actorIn: number }
function metrics(r: Row): M {
  const req = (r.action?.required ?? []).filter((c) => !DECISION_SKIP.has(c.id));
  const met = req.filter((c) => c.met).length;
  const proh = new Map((r.action?.prohibited ?? []).map((c) => [c.id, c.met]));
  const u = r.usage;
  return {
    chs: r.chs ?? 0,
    nas: r.action?.nas ?? 0,
    critical: r.state?.critical_ok ? 1 : 0,
    blockers: req.length ? met / req.length : 1,
    stale: (r.action?.stale.violations ?? 0) > 0 || (r.state?.sfer.errors ?? 0) > 0 ? 1 : 0,
    unsafe: proh.get('premature_go') || proh.get('binding_accept') ? 1 : 0,
    falseBlock: proh.has('false_block') ? (proh.get('false_block') ? 1 : 0) : null,
    cost: u.system_cost_usd,
    tokens: u.ingestion.input_tokens + u.ingestion.output_tokens + u.retrieval.input_tokens + u.retrieval.output_tokens + u.actor_input_tokens + u.actor_output_tokens,
    memory: u.memory_context_tokens_est,
    actorIn: u.actor_input_tokens,
  };
}

// a row belongs to one or more families: its archetype's family (base cases only), and the thread-length
// family when its archetype is the one run with --backlog (level = extra state-neutral emails)
const LENGTH_ARCH = process.env.VALUE_LENGTH_ARCH ?? 'value_chain_d4';
const hasBacklogRuns = rows.some((r) => (r.backlog ?? 0) > 0);
function membership(r: Row): { family: string; level: number }[] {
  const out: { family: string; level: number }[] = [];
  const d = r.archetype.match(/^value_chain_d(\d+)$/);
  const t = r.archetype.match(/^value_fanout_t(\d+)$/);
  if (!(r.backlog ?? 0)) {
    if (d) out.push({ family: 'depth', level: Number(d[1]) });
    else if (t) out.push({ family: 'threads', level: Number(t[1]) });
  }
  if (hasBacklogRuns && r.archetype === LENGTH_ARCH) out.push({ family: 'length', level: r.backlog ?? 0 });
  return out;
}
const inFam = (r: Row, fam: string) => membership(r).some((m) => m.family === fam);
const levelIn = (r: Row, fam: string) => membership(r).find((m) => m.family === fam)!.level;

// per case × condition: mean over trials
type CaseMeans = Map<string, Map<string, M & { n: number }>>; // case -> condition -> means
function caseMeans(rs: Row[]): CaseMeans {
  const acc = new Map<string, Map<string, { n: number; sum: Record<string, number>; fb: number[] }>>();
  for (const r of rs) {
    const m = metrics(r);
    const byCond = acc.get(r.case_id) ?? new Map();
    acc.set(r.case_id, byCond);
    const cell = byCond.get(r.condition) ?? { n: 0, sum: {}, fb: [] };
    byCond.set(r.condition, cell);
    cell.n++;
    for (const [k, v] of Object.entries(m)) if (k !== 'falseBlock') cell.sum[k] = (cell.sum[k] ?? 0) + (v as number);
    if (m.falseBlock !== null) cell.fb.push(m.falseBlock);
  }
  const out: CaseMeans = new Map();
  for (const [cid, byCond] of acc) {
    const o = new Map<string, M & { n: number }>();
    for (const [cond, cell] of byCond) {
      const avg = Object.fromEntries(Object.entries(cell.sum).map(([k, v]) => [k, v / cell.n])) as unknown as M;
      o.set(cond, { ...avg, falseBlock: cell.fb.length ? mean(cell.fb) : null, n: cell.n });
    }
    out.set(cid, o);
  }
  return out;
}

/** Sign-flip permutation test on paired per-case differences (two-sided). Exact up to 2^16 sign patterns. */
function signFlip(d: number[], iterations = 20_000, seed = 5): number {
  const nz = d.filter((x) => Math.abs(x) > 1e-12);
  if (!nz.length) return 1;
  const obs = Math.abs(nz.reduce((a, b) => a + b, 0));
  let extreme = 0;
  let total = 0;
  if (nz.length <= 16) {
    for (let mask = 0; mask < 1 << nz.length; mask++) {
      let s = 0;
      for (let i = 0; i < nz.length; i++) s += mask & (1 << i) ? -nz[i] : nz[i];
      if (Math.abs(s) >= obs - 1e-12) extreme++;
      total++;
    }
  } else {
    const r = rng(seed);
    for (let it = 0; it < iterations; it++) {
      let s = 0;
      for (const x of nz) s += r() < 0.5 ? -x : x;
      if (Math.abs(s) >= obs - 1e-12) extreme++;
      total++;
    }
  }
  return extreme / total;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pp = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} pp`;
const usd = (x: number) => `$${x.toFixed(5)}`;
const fmtP = (p: number) => (p < 0.001 ? 'p<0.001' : `p=${p.toFixed(3)}`);

const conditions = [...new Set(rows.map((r) => r.condition))];
const order = ['continuity', 'primitive-native', 'full-history', 'rolling-summary', 'agent-notes', 'retrieval', 'oracle'];
conditions.sort((a, b) => order.indexOf(a) - order.indexOf(b));
const baselines = conditions.filter((c) => c !== 'continuity' && c !== 'oracle');

const families = [...new Set(rows.flatMap((r) => membership(r).map((m) => m.family)))];
const out: Record<string, unknown> = { dirs, rows: rows.length, errored_rows: errors, conditions, families: {} };
const md: string[] = [`# Value benchmark analysis`, '', `Results: ${dirs.map((d) => `\`${d}\``).join(', ')} · ${rows.length} scored rows${errors ? ` · ${errors} errored rows excluded` : ''}`, ''];
const metas = dirs.filter((d) => existsSync(join(d, 'meta.json'))).map((d) => JSON.parse(readFileSync(join(d, 'meta.json'), 'utf8')));
for (const m of metas) md.push(`- \`${m.name}\`: model ${m.model}, trials ${m.trials}, commit ${String(m.commit).slice(0, 7)}${m.dirty ? ' (dirty)' : ''}, extractor ${JSON.stringify(m.extractor)}`);
md.push('');

for (const fam of families) {
  const famRows = rows.filter((r) => inFam(r, fam));
  const levels = [...new Set(famRows.map((r) => levelIn(r, fam)))].sort((a, b) => a - b);
  const famOut: Record<string, unknown> = {};
  md.push(`## ${fam === 'depth' ? 'Dependency depth (number of interdependent changes)' : fam === 'threads' ? 'Thread fan-out (six changes spread over N threads)' : fam === 'length' ? `Thread length (${LENGTH_ARCH} with N extra state-neutral emails)` : fam}`, '');
  const metricDefs: [keyof M, string][] = [['chs', 'Handoff success'], ['blockers', 'Blockers caught'], ['critical', 'Critical state right'], ['stale', 'Used a dead fact'], ['unsafe', 'Committed while blocked'], ['cost', 'Cost / decision (all-in)'], ['tokens', 'Tokens / decision (all-in)']];
  for (const [key, label] of metricDefs) {
    md.push(`### ${label}`, '', `| ${fam} | ${conditions.map((c) => c).join(' | ')} | cases × trials |`, `|---|${conditions.map(() => '---').join('|')}|---|`);
    for (const lv of levels) {
      const cm = caseMeans(famRows.filter((r) => levelIn(r, fam) === lv));
      const cells = conditions.map((c) => {
        const xs = [...cm.values()].map((m) => m.get(c)?.[key]).filter((x): x is number => typeof x === 'number');
        if (!xs.length) return '—';
        if (key === 'cost') return usd(mean(xs));
        if (key === 'tokens') return Math.round(mean(xs)).toLocaleString('en-US');
        const b = bootstrapMean(xs);
        return `${pct(b.mean)} [${pct(b.lo)}–${pct(b.hi)}]`;
      });
      const n = [...cm.values()].length;
      const t = Math.max(...[...cm.values()].flatMap((m) => [...m.values()].map((x) => x.n)));
      md.push(`| ${lv} | ${cells.join(' | ')} | ${n} × ${t} |`);
    }
    md.push('');
  }

  // paired: Continuity vs each baseline, per level and pooled
  md.push('### Paired: Continuity minus baseline (handoff success)', '', '| level | baseline | Δ success (95% CI) | sign-flip p | case wins / losses | McNemar over trials (C-only / B-only, p) | Δ blockers caught | cost ratio C/B |', '|---|---|---|---|---|---|---|---|');
  const levelGroups: [string, Row[]][] = [...levels.map((lv) => [String(lv), famRows.filter((r) => levelIn(r, fam) === lv)] as [string, Row[]]), ['all', famRows]];
  for (const [lv, rs] of levelGroups) {
    const cm = caseMeans(rs);
    for (const b of baselines) {
      const pairs = [...cm.values()].filter((m) => m.get('continuity') && m.get(b));
      if (!pairs.length) continue;
      const c = pairs.map((m) => m.get('continuity')!.chs);
      const x = pairs.map((m) => m.get(b)!.chs);
      const diff = pairedBootstrap(c, x);
      const p = signFlip(c.map((v, i) => v - x[i]));
      const wins = c.filter((v, i) => v > x[i]).length;
      const losses = c.filter((v, i) => v < x[i]).length;
      const trialPairs = rs.filter((r) => r.condition === 'continuity').map((r) => [r, rs.find((y) => y.condition === b && y.case_id === r.case_id && y.trial === r.trial)] as const).filter(([, y]) => y);
      const mc = mcnemar(trialPairs.map(([r]) => r.chs ?? 0), trialPairs.map(([, y]) => y!.chs ?? 0));
      const bl = pairedBootstrap(pairs.map((m) => m.get('continuity')!.blockers), pairs.map((m) => m.get(b)!.blockers));
      const costRatio = mean(pairs.map((m) => m.get('continuity')!.cost)) / mean(pairs.map((m) => m.get(b)!.cost));
      md.push(`| ${lv} | ${b} | ${pp(diff.diff)} [${pp(diff.lo)}, ${pp(diff.hi)}] | ${fmtP(p)} | ${wins} / ${losses} | ${mc.b} / ${mc.c}, ${fmtP(mc.p)} | ${pp(bl.diff)} [${pp(bl.lo)}, ${pp(bl.hi)}] | ${costRatio.toFixed(2)} |`);
      (famOut[`${lv}:${b}`] = { n_cases: pairs.length, d_chs: diff, p_signflip: p, wins, losses, mcnemar: mc, d_blockers: bl, cost_ratio: costRatio });
    }
  }
  md.push('');

  // level summaries for charts
  famOut.levels = levels.map((lv) => {
    const cm = caseMeans(famRows.filter((r) => levelIn(r, fam) === lv));
    return {
      level: lv,
      by_condition: Object.fromEntries(conditions.map((c) => {
        const ms = [...cm.values()].map((m) => m.get(c)).filter((x): x is M & { n: number } => !!x);
        const summary = (k: keyof M) => { const xs = ms.map((m) => m[k]).filter((x): x is number => typeof x === 'number'); return xs.length ? bootstrapMean(xs) : null; };
        return [c, { n_cases: ms.length, chs: summary('chs'), blockers: summary('blockers'), critical: summary('critical'), stale: summary('stale'), unsafe: summary('unsafe'), cost: mean(ms.map((m) => m.cost)), tokens: mean(ms.map((m) => m.tokens)), memory: mean(ms.map((m) => m.memory)) }];
      })),
    };
  });
  (out.families as Record<string, unknown>)[fam] = famOut;
}

writeFileSync(join(dirs[0], 'analysis.json'), JSON.stringify(out, null, 1));
writeFileSync(join(dirs[0], 'analysis.md'), md.join('\n'));
console.log(md.join('\n'));
console.log(`\nwrote ${join(dirs[0], 'analysis.md')}`);
