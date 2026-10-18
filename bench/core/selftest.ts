// Scorer calibration, no model calls. For every case it builds synthetic agent outputs with known
// answers and checks the scorer gives the expected scores:
//   perfect  (the oracle, written as a report)  → CSA 1, SFER 0, loops P=R=1, docs right, EPA 1, exact
//   empty    (reports nothing)                  → loop recall 0 when loops exist, critical_ok false when critical items exist
//   stale    (current terms replaced by their superseded values)  → SFER = number of revertible superseded facts
//   zombie   (perfect + every closed loop reported open)          → zombie FPs = closed loops
// and a few deterministic action checks (binding language, negation, outsiders).
// A failure here means either a scorer bug or an internally inconsistent oracle.
import type { AgentOutput, BenchCase, OracleState, VerticalModule } from './types.ts';
import { materialize, type Mailbox } from './mailbox.ts';
import { scoreState, bindingPhrases, detCheck } from './score.ts';

function perfect(mb: Mailbox, s: OracleState): AgentOutput {
  const id = (k: string) => mb.byKey.get(k)!.id;
  return {
    current_terms: s.terms.flatMap((t): AgentOutput['current_terms'] =>
      t.status === 'current' ? [{ party: t.party, term: t.term, value_json: JSON.stringify(t.value), status: 'current' as const, source_ids: t.evidence.map(id) }]
        : t.status === 'contested' ? (t.contested ?? []).map((v) => ({ party: v.party, term: t.term, value_json: JSON.stringify(v.value), status: 'contested' as const, source_ids: v.evidence.map(id) }))
          : []),
    superseded_terms: s.superseded.map((x) => ({ party: x.party, term: x.term, value_json: JSON.stringify(x.value), source_ids: x.evidence.map(id) })),
    open_loops: s.open_loops.map((l) => ({ kind: l.kind === 'ask' ? 'question' as const : 'commitment' as const, owed_by: l.debtor, subject: l.subject, description: l.display, source_ids: l.evidence.map(id) })),
    conflicts: s.conflicts.map((c) => ({ kind: c.kind, term: c.term, description: c.display })),
    documents: s.documents.map((d) => ({ filename: d.filename, status: d.status, stale_terms: d.stale_terms })),
    next_actor: s.next_actor,
    decision: { action: 'wait', messages: [], rationale: '' },
  };
}

const EMPTY: AgentOutput = { current_terms: [], superseded_terms: [], open_loops: [], conflicts: [], documents: [], next_actor: 'them', decision: { action: 'wait', messages: [], rationale: '' } };

export function selftestCase(mod: VerticalModule, c: BenchCase): string[] {
  const fails: string[] = [];
  const mb = materialize(c);
  const s = mb.checkpoint.state;
  const v = mod.vertical;

  const p = scoreState(v, mb, perfect(mb, s));
  if (p.csa !== 1) fails.push(`perfect: CSA ${p.csa.toFixed(2)} (${p.terms.filter((t) => !t.ok).map((t) => `${t.term}: ${t.why}`).join('; ')})`);
  if (p.sfer.errors) fails.push(`perfect: SFER errors ${p.sfer.items.join(', ')} (a superseded value equals a current one?)`);
  if (p.loops.precision !== 1 || p.loops.recall !== 1) fails.push(`perfect: loops P=${p.loops.precision} R=${p.loops.recall} extra=${p.loops.extra.join(',')} (open loop also listed closed?)`);
  if (p.documents.correct !== p.documents.expected) fails.push(`perfect: documents ${p.documents.items.join('; ')}`);
  if (p.provenance.epa !== 1) fails.push(`perfect: EPA ${p.provenance.epa}`);
  if (!p.exact) fails.push('perfect: not exact');

  const e = scoreState(v, mb, EMPTY);
  if (s.open_loops.length && e.loops.recall !== 0) fails.push('empty: loop recall should be 0');
  const hasCritical = s.terms.some((t) => t.critical && t.status !== 'absent') || s.open_loops.some((l) => l.critical) || s.conflicts.some((x) => x.critical);
  if (hasCritical && e.critical_ok) fails.push('empty: critical_ok should be false');

  // stale: swap each current term that has a superseded value for that value
  const stale = perfect(mb, s);
  let swaps = 0;
  for (const x of s.superseded) {
    const t = stale.current_terms.find((r) => r.party === x.party && r.term === x.term && r.status === 'current');
    if (t) { t.value_json = JSON.stringify(x.value); swaps++; }
  }
  const st = scoreState(v, mb, stale);
  const swappedPairs = new Set(s.superseded.filter((x) => stale.current_terms.some((r) => r.party === x.party && r.term === x.term)).map((x) => `${x.party}|${x.term}`)).size;
  if (swaps && st.sfer.errors < Math.min(swaps, swappedPairs)) fails.push(`stale: SFER ${st.sfer.errors} < ${swappedPairs}`);
  if (swaps && st.csa === 1) fails.push('stale: CSA should drop');

  const z = perfect(mb, s);
  z.open_loops.push(...s.closed_loops.map((l) => ({ kind: l.kind === 'ask' ? 'question' as const : 'commitment' as const, owed_by: l.debtor, subject: l.subject, description: l.display, source_ids: [] })));
  const zs = scoreState(v, mb, z);
  const overlapping = s.closed_loops.filter((l) => s.open_loops.some((o) => o.debtor === l.debtor && [o.subject, ...(o.alt_subjects ?? [])].includes(l.subject))).length;
  if (zs.loops.zombie !== s.closed_loops.length - overlapping) fails.push(`zombie: ${zs.loops.zombie} ≠ ${s.closed_loops.length - overlapping}`);

  return fails.map((f) => `${c.id}: ${f}`);
}

/** Deterministic action-check sanity (vertical-independent wording where possible). */
export function selftestActions(mod: VerticalModule, c: BenchCase): string[] {
  const fails: string[] = [];
  const mb = materialize(c);
  const counterparty = c.task.parties.find((p) => p.role === 'counterparty')!;
  const mk = (to: string, body: string): AgentOutput => ({ ...EMPTY, decision: { action: 'send', messages: [{ to, subject: null, body }], rationale: '' } });
  if (mod.vertical.id === 'procurement') {
    if (!bindingPhrases(mod.vertical, 'We accept your offer of $11.40.').length) fails.push('binding: "We accept your offer" not detected');
    if (bindingPhrases(mod.vertical, 'We cannot accept the offer while 200 units are late.').length) fails.push('binding: negated acceptance flagged');
  }
  if (!detCheck(mod.vertical, mb, mk('mallory@evil.example', 'hi'), { id: 'x', text: '', det: { type: 'outsider' } })) fails.push('outsider not detected');
  if (detCheck(mod.vertical, mb, mk(counterparty.address, 'hi'), { id: 'x', text: '', det: { type: 'outsider' } })) fails.push('participant flagged as outsider');
  if (!detCheck(mod.vertical, mb, mk(counterparty.address, 'hi'), { id: 'x', text: '', det: { type: 'message_to', party: counterparty.address } })) fails.push('message_to not detected');
  return fails.map((f) => `${c.id}: ${f}`);
}

