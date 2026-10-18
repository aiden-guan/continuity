// Aggregates a run (rows.jsonl) into the headline tables, paired comparisons against Continuity,
// breakdowns by vertical / archetype / backlog, the representation experiment, and the ship gates.
// Raw numerators and denominators are always shown next to percentages.
import type { Row } from './pipeline.ts';
import { bootstrapMean, mcnemar, mean, pairedBootstrap, quantile } from './stats.ts';

const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : '—');
const usd = (x: number) => (Number.isFinite(x) ? `$${x < 0.01 ? x.toFixed(5) : x.toFixed(4)}` : '—');
const median = (xs: number[]) => quantile([...xs].sort((a, b) => a - b), 0.5);

export interface Agg {
  condition: string;
  n: number;
  unsupported: number;
  errors: number;
  csa_micro: { ok: number; total: number };
  csa_macro: number;
  critical_exact: { ok: number; total: number };
  sfer_state: { errors: number; opp: number };
  sfer_action: { errors: number; opp: number };
  loops: { tp: number; fp: number; fn: number; zombie: number };
  epa: { ok: number; total: number };
  docs: { ok: number; total: number };
  conflicts: { found: number; total: number };
  next_actor: { ok: number; total: number };
  nas: { ok: number; total: number };
  chs: { ok: number; total: number; ci: { lo: number; hi: number } };
  safety: number;
  memory_tokens_median: number;
  actor_input_mean: number;
  cost_per_decision: number;
  ingestion_cost_mean: number;
}

/** Rows averaged over trials per (case, condition) are not used for counts: counts are per row. */
export function aggregate(rows: Row[], condition: string): Agg {
  const rs = rows.filter((r) => r.condition === condition);
  const ok = rs.filter((r) => r.state && r.action);
  const terms = ok.flatMap((r) => r.state!.terms);
  const byArch = new Map<string, number[]>();
  for (const r of ok) byArch.set(`${r.vertical}/${r.archetype}`, [...(byArch.get(`${r.vertical}/${r.archetype}`) ?? []), r.state!.csa]);
  const chs = ok.map((r) => r.chs ?? 0);
  const ci = chs.length ? bootstrapMean(chs) : { lo: NaN, hi: NaN };
  const sum = (f: (r: Row) => number) => ok.reduce((a, r) => a + f(r), 0);
  return {
    condition,
    n: ok.length,
    unsupported: rs.filter((r) => r.unsupported).length,
    errors: rs.filter((r) => r.error).length,
    csa_micro: { ok: terms.filter((t) => t.ok).length, total: terms.length },
    csa_macro: mean([...byArch.values()].map(mean)),
    critical_exact: { ok: ok.filter((r) => r.state!.critical_ok).length, total: ok.length },
    sfer_state: { errors: sum((r) => r.state!.sfer.errors), opp: sum((r) => r.state!.sfer.opportunities) },
    sfer_action: { errors: sum((r) => r.action!.stale.violations), opp: sum((r) => r.action!.stale.opportunities) },
    loops: { tp: sum((r) => r.state!.loops.tp), fp: sum((r) => r.state!.loops.fp), fn: sum((r) => r.state!.loops.fn), zombie: sum((r) => r.state!.loops.zombie) },
    epa: { ok: sum((r) => r.state!.provenance.supported), total: sum((r) => r.state!.provenance.evaluated) },
    docs: { ok: sum((r) => r.state!.documents.correct), total: sum((r) => r.state!.documents.expected) },
    conflicts: { found: sum((r) => r.state!.conflicts.found), total: sum((r) => r.state!.conflicts.expected) },
    next_actor: { ok: ok.filter((r) => r.state!.next_actor_ok).length, total: ok.length },
    nas: { ok: sum((r) => r.action!.nas), total: ok.length },
    chs: { ok: sum((r) => r.chs ?? 0), total: ok.length, ci },
    safety: sum((r) => r.action!.safety_violations),
    memory_tokens_median: median(ok.map((r) => r.usage.memory_context_tokens_est)),
    actor_input_mean: mean(ok.map((r) => r.usage.actor_input_tokens)),
    cost_per_decision: mean(ok.map((r) => r.usage.retrieval.cost_usd + r.usage.actor_cost_usd)),
    ingestion_cost_mean: mean(ok.map((r) => r.usage.ingestion.cost_usd)),
  };
}

const frac = (a: { ok: number; total: number }) => `${pct(a.ok / a.total)} (${a.ok}/${a.total})`;
const f1 = (l: Agg['loops']) => {
  const p = l.tp / (l.tp + l.fp || 1);
  const r = l.tp / (l.tp + l.fn || 1);
  return { p, r, f1: p + r ? (2 * p * r) / (p + r) : 0 };
};

/** Per-case values averaged over trials, aligned across two conditions (pairs only where both ran). */
function paired(rows: Row[], a: string, b: string, metric: (r: Row) => number): [number[], number[]] {
  const byCase = (cond: string) => {
    const m = new Map<string, number[]>();
    for (const r of rows.filter((x) => x.condition === cond && x.state && x.action)) m.set(r.case_id, [...(m.get(r.case_id) ?? []), metric(r)]);
    return new Map([...m].map(([k, v]) => [k, mean(v)]));
  };
  const A = byCase(a);
  const B = byCase(b);
  const keys = [...A.keys()].filter((k) => B.has(k)).sort();
  return [keys.map((k) => A.get(k)!), keys.map((k) => B.get(k)!)];
}

export function renderReport(rows: Row[], meta: Record<string, unknown>): { markdown: string; summary: Record<string, unknown> } {
  const conditions = [...new Set(rows.map((r) => r.condition))];
  const aggs = conditions.map((c) => aggregate(rows, c));
  const out: string[] = [];
  out.push(`# Continuity benchmark — ${meta.name ?? 'run'}`, '');
  out.push(`Model (every condition, actor and judge): \`${meta.model}\` · judge: \`${meta.judge_model}\` · trials: ${meta.trials} · cases: ${new Set(rows.map((r) => r.case_id)).size} · splits: ${meta.splits} · ${meta.mock ? '**MOCK RUN (no model calls; numbers are meaningless)**' : 'live model calls'}`, '');

  out.push('## Headline', '');
  out.push('| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of aggs) {
    if (!a.n) { out.push(`| ${a.condition} | ${a.unsupported ? `unsupported (${a.unsupported})` : `errors (${a.errors})`} |||||||||||`); continue; }
    const l = f1(a.loops);
    out.push(`| ${a.condition}${a.errors ? ` (${a.errors} errored, excluded)` : ''} | ${frac(a.chs)} [${pct(a.chs.ci.lo)}–${pct(a.chs.ci.hi)}] | ${frac(a.nas)} | ${frac(a.critical_exact)} | ${frac(a.csa_micro)} | ${a.sfer_state.errors}/${a.sfer_state.opp} · ${a.sfer_action.errors}/${a.sfer_action.opp} | ${pct(l.f1)} (${a.loops.zombie}) | ${frac(a.epa)} | ${a.safety} | ${Math.round(a.memory_tokens_median)} | ${usd(a.cost_per_decision)} | ${usd(a.ingestion_cost_mean)} |`);
  }
  out.push('', 'Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.', '');

  // ---- paired comparisons against Continuity
  const ref = conditions.includes('continuity') ? 'continuity' : null;
  const comparisons: Record<string, unknown>[] = [];
  if (ref) {
    out.push('## Paired comparison vs Continuity', '', '| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |', '|---|---|---|---|---|');
    for (const c of conditions.filter((x) => x !== ref && x !== 'oracle')) {
      const [a, b] = paired(rows, ref, c, (r) => r.chs ?? 0);
      if (!a.length) continue;
      const d = pairedBootstrap(a, b);
      const m = mcnemar(a.map((x) => (x >= 0.5 ? 1 : 0)), b.map((x) => (x >= 0.5 ? 1 : 0)));
      const [ca, cb] = paired(rows, ref, c, (r) => r.state!.csa);
      const dc = pairedBootstrap(ca, cb);
      const [ta, tb] = paired(rows, ref, c, (r) => r.usage.memory_context_tokens_est);
      const dt = pairedBootstrap(ta, tb);
      comparisons.push({ condition: c, n: a.length, chs: d, mcnemar: m, csa: dc, tokens: dt });
      out.push(`| ${c} (n=${a.length}) | ${d.diff >= 0 ? '+' : ''}${(100 * d.diff).toFixed(1)} pp [${(100 * d.lo).toFixed(1)}, ${(100 * d.hi).toFixed(1)}] | ${m.b} / ${m.c}, p=${m.p.toPrecision(2)} | ${(100 * dc.diff).toFixed(1)} pp [${(100 * dc.lo).toFixed(1)}, ${(100 * dc.hi).toFixed(1)}] | ${Math.round(dt.diff)} [${Math.round(dt.lo)}, ${Math.round(dt.hi)}] |`);
    }
    out.push('');
  }

  // ---- breakdowns
  const breakdown = (title: string, keyOf: (r: Row) => string) => {
    const keys = [...new Set(rows.map(keyOf))].sort();
    out.push(`## ${title} — cold-handoff success`, '', `| ${title} | ${conditions.join(' | ')} |`, `|---|${conditions.map(() => '---').join('|')}|`);
    for (const k of keys) {
      const cells = conditions.map((c) => {
        const rs = rows.filter((r) => keyOf(r) === k && r.condition === c && r.action);
        if (!rs.length) return rows.some((r) => keyOf(r) === k && r.condition === c && r.unsupported) ? 'n/a' : '—';
        return `${pct(mean(rs.map((r) => r.chs ?? 0)))} (${rs.length})`;
      });
      out.push(`| ${k} | ${cells.join(' | ')} |`);
    }
    out.push('');
  };
  breakdown('Vertical', (r) => r.vertical);
  // capability: a case counts toward every capability it exercises
  {
    const caps = [...new Set(rows.flatMap((r) => r.capabilities))].sort();
    out.push('## Capability — cold-handoff success', '', `| Capability | ${conditions.join(' | ')} |`, `|---|${conditions.map(() => '---').join('|')}|`);
    for (const cap of caps) {
      out.push(`| ${cap} | ${conditions.map((c) => { const rs = rows.filter((r) => r.capabilities.includes(cap) && r.condition === c && r.action); return rs.length ? `${pct(mean(rs.map((r) => r.chs ?? 0)))} (${rs.length})` : '—'; }).join(' | ')} |`);
    }
    out.push('');
  }
  breakdown('Archetype', (r) => r.archetype);
  if (new Set(rows.map((r) => r.backlog)).size > 1) {
    breakdown('Backlog', (r) => String(r.backlog).padStart(4, '0'));
    out.push('### Context size vs backlog (median memory tokens)', '', `| Backlog | ${conditions.join(' | ')} |`, `|---|${conditions.map(() => '---').join('|')}|`);
    for (const b of [...new Set(rows.map((r) => r.backlog))].sort((x, y) => x - y)) {
      out.push(`| ${b} | ${conditions.map((c) => { const rs = rows.filter((r) => r.backlog === b && r.condition === c && r.action); return rs.length ? String(Math.round(median(rs.map((r) => r.usage.memory_context_tokens_est)))) : '—'; }).join(' | ')} |`);
    }
    out.push('');
  }

  if (new Set(rows.map((r) => r.mess ?? 0)).size > 1) breakdown('Mess level', (r) => String(r.mess ?? 0));

  // ---- representation experiment
  const eng = rows.filter((r) => r.engine_state);
  if (eng.length) {
    const terms = eng.flatMap((r) => r.engine_state!.terms);
    const l = eng.reduce((a, r) => ({ tp: a.tp + r.engine_state!.loops.tp, fp: a.fp + r.engine_state!.loops.fp, fn: a.fn + r.engine_state!.loops.fn, zombie: a.zombie + r.engine_state!.loops.zombie }), { tp: 0, fp: 0, fn: 0, zombie: 0 });
    out.push('## Representation experiment (Continuity engine state, before any actor)', '');
    for (const c of [...new Set(eng.map((r) => r.condition))]) {
      const rs = eng.filter((r) => r.condition === c);
      const t = rs.flatMap((r) => r.engine_state!.terms);
      const ll = rs.reduce((a, r) => ({ tp: a.tp + r.engine_state!.loops.tp, fp: a.fp + r.engine_state!.loops.fp, fn: a.fn + r.engine_state!.loops.fn, zombie: a.zombie + r.engine_state!.loops.zombie }), { tp: 0, fp: 0, fn: 0, zombie: 0 });
      const docs = rs.reduce((a, r) => ({ ok: a.ok + r.engine_state!.documents.correct, total: a.total + r.engine_state!.documents.expected }), { ok: 0, total: 0 });
      out.push(`- **${c}**: current-state accuracy ${frac({ ok: t.filter((x) => x.ok).length, total: t.length })}; critical exact ${frac({ ok: rs.filter((r) => r.engine_state!.critical_ok).length, total: rs.length })}; superseded errors ${rs.reduce((a, r) => a + r.engine_state!.sfer.errors, 0)}; open-loop F1 ${pct(f1(ll).f1)} (zombies ${ll.zombie}); documents ${frac(docs)}.`);
    }
    void terms; void l;
    out.push('');
  }

  // ---- gates (engineering/demo thresholds from the plan; not academic standards)
  const c = aggs.find((a) => a.condition === 'continuity');
  const full = aggs.find((a) => a.condition === 'full-history');
  if (c?.n) {
    const l = f1(c.loops);
    const gates: [string, boolean, string][] = [
      ['Current-state accuracy ≥ 95%', c.csa_micro.ok / c.csa_micro.total >= 0.95, pct(c.csa_micro.ok / c.csa_micro.total)],
      ['Superseded-fact error rate ≤ 2%', c.sfer_state.errors / (c.sfer_state.opp || 1) <= 0.02, pct(c.sfer_state.errors / (c.sfer_state.opp || 1))],
      ['Open-loop precision ≥ 90%', l.p >= 0.9, pct(l.p)],
      ['Open-loop recall ≥ 90%', l.r >= 0.9, pct(l.r)],
      ['Provenance ≥ 95%', c.epa.ok / (c.epa.total || 1) >= 0.95, pct(c.epa.ok / (c.epa.total || 1))],
      ['Cold-handoff success ≥ 90%', c.chs.ok / c.chs.total >= 0.9, pct(c.chs.ok / c.chs.total)],
      ['Zero safety violations', c.safety === 0, String(c.safety)],
    ];
    if (full?.n) {
      gates.push(['Within 5 pp of full history on next-action success', full.nas.ok / full.nas.total - c.nas.ok / c.nas.total <= 0.05, `${(100 * (full.nas.ok / full.nas.total - c.nas.ok / c.nas.total)).toFixed(1)} pp behind`]);
      gates.push(['≥ 60% fewer memory tokens than full history', 1 - c.memory_tokens_median / full.memory_tokens_median >= 0.6, pct(1 - c.memory_tokens_median / full.memory_tokens_median)]);
    }
    out.push('## Ship gates (Continuity)', '', '| Gate | Pass | Value |', '|---|---|---|', ...gates.map(([g, p, v]) => `| ${g} | ${p ? '✅' : '❌'} | ${v} |`), '');
  }

  const errs = rows.filter((r) => r.error);
  if (errs.length) out.push('## Errors', '', ...errs.slice(0, 20).map((r) => `- ${r.key}: ${r.error!.split('\n')[0]}`), '');
  return { markdown: out.join('\n'), summary: { meta, aggregates: aggs, comparisons } };
}
