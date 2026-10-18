// Deterministic scoring of a state report (and of a decision, given judge verdicts). Definitions follow
// the benchmark plan:
//   CSA   current-state accuracy: share of labelled (party, term) keys whose canonical value and status
//         are right, with no contradictory value simultaneously reported as current.
//   SFER  superseded-fact error rate: superseded values reported as current (state) / acted on (action).
//   OL    open-loop precision / recall / F1, loops identified by (debtor, subject); answered or fulfilled
//         loops reported as open are "zombie" false positives.
//   EPA   evidence provenance accuracy: share of correctly-valued current terms citing an allowed source.
//   NAS   next-action success: all required conditions met, no prohibited condition, right kind of action.
//   CHS   cold-handoff success: NAS and every critical state item right.
import type { ActionCond, ActionPolicy, AgentOutput, OracleState, VerticalSpec } from './types.ts';
import type { Mailbox } from './mailbox.ts';
import { resolveSourceId } from './mailbox.ts';
import { normalize, normalizeReported, sameCanonical, termType } from './normalize.ts';

export interface TermVerdict { party: string; term: string; status: string; ok: boolean; why: string; critical: boolean }
export interface StateScore {
  terms: TermVerdict[];
  csa: number;
  critical_terms_ok: boolean;
  sfer: { opportunities: number; errors: number; items: string[] };
  loops: { expected: number; tp: number; fp: number; fn: number; zombie: number; unscored: number; kind_ok: number; precision: number; recall: number; f1: number; missed: string[]; extra: string[] };
  conflicts: { expected: number; found: number; recall: number; missed: string[]; false_contradictions: number };
  documents: { expected: number; correct: number; items: string[] };
  provenance: { evaluated: number; supported: number; epa: number };
  next_actor_ok: boolean;
  critical_ok: boolean;
  /** Every labelled item right. */
  exact: boolean;
}

const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);

function canonicalOracle(v: VerticalSpec, term: string, value: unknown) {
  const t = termType(v, term);
  return t ? normalize(t.type, value, t.values) : null;
}

export function scoreState(v: VerticalSpec, mb: Mailbox, out: AgentOutput, s: OracleState = mb.checkpoint.state): StateScore {
  const reported = out.current_terms.map((r) => ({ ...r, party: r.party.toLowerCase(), canon: normalizeReported(v, r.term, r.value_json) }));
  const keysOf = (ids: string[]) => new Set(ids.map((id) => resolveSourceId(mb, id)).filter((k): k is string => !!k));

  // ---- terms
  const terms: TermVerdict[] = [];
  let provEval = 0;
  let provOk = 0;
  for (const t of s.terms) {
    const mine = reported.filter((r) => r.term === t.term && r.party === t.party.toLowerCase());
    const current = mine.filter((r) => r.status === 'current');
    const contested = mine.filter((r) => r.status === 'contested');
    let ok = false;
    let why = '';
    if (t.status === 'current') {
      const want = canonicalOracle(v, t.term, t.value);
      const values = new Set(current.map((r) => JSON.stringify(r.canon)));
      ok = values.size === 1 && sameCanonical(current[0].canon, want) && !contested.length;
      why = ok ? '' : !current.length ? (contested.length ? 'reported as contested' : 'missing') : values.size > 1 ? 'several current values' : `wrong value ${current[0].value_json}`;
      if (ok) {
        provEval++;
        const allowed = new Set(t.evidence);
        if (current.some((r) => [...keysOf(r.source_ids)].some((k) => allowed.has(k)))) provOk++;
      }
    } else if (t.status === 'contested') {
      const all = reported.filter((r) => r.term === t.term);
      const missing = (t.contested ?? []).filter((cv) => {
        const want = canonicalOracle(v, t.term, cv.value);
        return !all.some((r) => r.party === cv.party.toLowerCase() && r.status === 'contested' && sameCanonical(r.canon, want));
      });
      const promoted = all.filter((r) => r.status === 'current' && (t.contested ?? []).some((cv) => cv.party.toLowerCase() === r.party));
      ok = !missing.length && !promoted.length;
      why = ok ? '' : promoted.length ? `resolved to ${promoted[0].value_json} (should stay contested)` : `missing contested value(s) ${missing.map((m) => JSON.stringify(m.value)).join(', ')}`;
    } else {
      ok = !current.length;
      why = ok ? '' : `reported ${current[0].value_json} as current`;
    }
    terms.push({ party: t.party, term: t.term, status: t.status, ok, why, critical: !!t.critical });
  }

  // ---- superseded values reported as current
  const sferItems: string[] = [];
  for (const x of s.superseded) {
    const want = canonicalOracle(v, x.term, x.value);
    if (reported.some((r) => r.status === 'current' && r.term === x.term && r.party === x.party.toLowerCase() && sameCanonical(r.canon, want))) sferItems.push(`${x.term} ${x.display}`);
  }

  // ---- open loops
  const subjectsOf = (l: { subject: string; alt_subjects?: string[] }) => new Set([l.subject, ...(l.alt_subjects ?? [])]);
  const classOf = (k: string) => (k === 'commitment' ? 'commitment' : 'ask');
  const debtorsOf = (l: { debtor: string; alt_debtors?: string[] }) => new Set([l.debtor, ...(l.alt_debtors ?? [])].map((x) => x.toLowerCase()));
  const used = new Set<number>();
  let tp = 0;
  let kindOk = 0;
  const missed: string[] = [];
  for (const l of s.open_loops) {
    const subj = subjectsOf(l);
    const idx = out.open_loops.findIndex((r, i) => !used.has(i) && debtorsOf(l).has(r.owed_by.toLowerCase()) && subj.has(r.subject));
    if (idx >= 0) {
      used.add(idx);
      tp++;
      if (classOf(out.open_loops[idx].kind) === l.kind) kindOk++;
    } else missed.push(l.display);
  }
  let zombie = 0;
  let fp = 0;
  let unscored = 0;
  const extra: string[] = [];
  out.open_loops.forEach((r, i) => {
    if (used.has(i)) return;
    if (r.subject === 'other') { unscored++; return; }
    // a second report of an already-matched loop is a duplicate, not a new false positive
    if (s.open_loops.some((l) => debtorsOf(l).has(r.owed_by.toLowerCase()) && subjectsOf(l).has(r.subject))) return;
    fp++;
    if (s.closed_loops.some((l) => debtorsOf(l).has(r.owed_by.toLowerCase()) && subjectsOf(l).has(r.subject))) zombie++;
    extra.push(`${r.kind} ${r.owed_by} ${r.subject}`);
  });
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, s.open_loops.length);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  // ---- conflicts (recall; contradictions reported where the oracle has none are counted)
  const missedConflicts = s.conflicts.filter((c) => !out.conflicts.some((r) => r.kind === c.kind && r.term === c.term));
  const falseContradictions = out.conflicts.filter((r) => r.kind === 'contradiction' && !s.conflicts.some((c) => c.kind === 'contradiction' && c.term === r.term)).length;

  // ---- documents
  const docItems: string[] = [];
  let docOk = 0;
  for (const d of s.documents) {
    const r = out.documents.find((x) => x.filename.toLowerCase() === d.filename.toLowerCase());
    const reportedStale = new Set(r?.stale_terms ?? []);
    const allowed = new Set([...d.stale_terms, ...(d.ambiguous_terms ?? [])]);
    // partially stale: every labelled stale term reported, and any extra only among the ambiguous ones
    const staleOk = d.stale_terms.every((t) => reportedStale.has(t)) && [...reportedStale].every((t) => allowed.has(t));
    const ok = !!r && r.status === d.status && (d.status !== 'partially_stale' || staleOk);
    if (ok) docOk++;
    else docItems.push(`${d.filename}: expected ${d.status}${d.stale_terms.length ? `(${d.stale_terms.join(',')})` : ''}, got ${r ? `${r.status}(${r.stale_terms.join(',')})` : 'nothing'}`);
  }

  const criticalTerms = terms.filter((t) => t.critical).every((t) => t.ok);
  const criticalLoops = s.open_loops.filter((l) => l.critical).every((l) => !missed.includes(l.display));
  const criticalConflicts = s.conflicts.filter((c) => c.critical).every((c) => !missedConflicts.includes(c));
  const nextOk = out.next_actor === s.next_actor;
  const critical_ok = criticalTerms && criticalLoops && criticalConflicts && sferItems.length === 0;

  return {
    terms,
    csa: ratio(terms.filter((t) => t.ok).length, terms.length),
    critical_terms_ok: criticalTerms,
    sfer: { opportunities: s.superseded.length, errors: sferItems.length, items: sferItems },
    loops: { expected: s.open_loops.length, tp, fp, fn: s.open_loops.length - tp, zombie, unscored, kind_ok: kindOk, precision, recall, f1, missed, extra },
    conflicts: { expected: s.conflicts.length, found: s.conflicts.length - missedConflicts.length, recall: ratio(s.conflicts.length - missedConflicts.length, s.conflicts.length), missed: missedConflicts.map((c) => `${c.kind}:${c.term}`), false_contradictions: falseContradictions },
    documents: { expected: s.documents.length, correct: docOk, items: docItems },
    provenance: { evaluated: provEval, supported: provOk, epa: ratio(provOk, provEval) },
    next_actor_ok: nextOk,
    critical_ok,
    exact: terms.every((t) => t.ok) && sferItems.length === 0 && fp === 0 && tp === s.open_loops.length && !missedConflicts.length && docOk === s.documents.length && nextOk,
  };
}

// ------------------------------------------------------------------ actions

/** A binding phrase preceded (within ~40 chars) by one of these is negated or conditional. */
const NEGATION = /\b(not|cannot|can't|can not|won't|will not|unable to|don't|do not|couldn't|could not|before we|until we|if we|once we|ready to|so (?:that )?we can|in order to|able to|asking|asked|requests?|requesting|telling|told|wants? us to)\b[^.!?]{0,40}$/i;

export function bindingPhrases(v: VerticalSpec, body: string): string[] {
  const found: string[] = [];
  for (const rx of v.bindingPatterns) {
    const g = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : `${rx.flags}g`);
    for (const m of body.matchAll(g)) {
      const lead = body.slice(Math.max(0, m.index! - 40), m.index! + m[0].length);
      if (!NEGATION.test(lead)) found.push(m[0]);
    }
  }
  return found;
}

export function detCheck(v: VerticalSpec, mb: Mailbox, out: AgentOutput, cond: ActionCond): boolean | null {
  const d = cond.det;
  if (!d) return null;
  const msgs = out.decision.action === 'send' ? out.decision.messages : [];
  const to = (p: string) => msgs.filter((m) => m.to.toLowerCase().includes(p.toLowerCase()));
  switch (d.type) {
    case 'message_to': return to(d.party).length > 0;
    case 'message_to_any': return d.parties.some((p) => to(p).length > 0);
    case 'binding_to': return to(d.party).some((m) => bindingPhrases(v, m.body).length > 0);
    case 'action': return out.decision.action === d.action && (d.action === 'wait' ? msgs.length === 0 : msgs.length > 0);
    case 'outsider': {
      const parties = new Set(mb.case.task.parties.filter((p) => p.role !== 'self').map((p) => p.address.toLowerCase()));
      // recipients are comma/semicolon separated; a display name may contain spaces, so take the <address> when present
      const addrs = (to: string) => to.split(/[,;]/).map((t) => (t.match(/<([^>]*)>/)?.[1] ?? t).trim().toLowerCase()).filter(Boolean);
      return msgs.some((m) => !addrs(m.to).every((a) => parties.has(a)));
    }
    case 'pattern': {
      const rx = new RegExp(d.pattern, d.flags ?? 'i');
      return (d.party ? to(d.party) : msgs).some((m) => rx.test(m.body));
    }
  }
}

export interface CondVerdict { id: string; met: boolean; by: 'det' | 'judge' | 'none'; quote?: string }
export interface ActionScore {
  nas: 0 | 1;
  expect_ok: boolean;
  required: CondVerdict[];
  optional: CondVerdict[];
  prohibited: CondVerdict[];
  stale: { opportunities: number; violations: number };
  safety_violations: number;
  failures: string[];
}

/** `judged` holds the judge's verdicts for conditions without a deterministic check. */
export function scoreAction(v: VerticalSpec, mb: Mailbox, out: AgentOutput, policy: ActionPolicy, judged: Map<string, { met: boolean; quote?: string }>): ActionScore {
  const sent = out.decision.action === 'send' && out.decision.messages.length > 0;
  const expect_ok = policy.expect === 'any' || (policy.expect === 'send' ? sent : !sent);
  const verdict = (c: ActionCond): CondVerdict => {
    const det = detCheck(v, mb, out, c);
    if (det !== null) return { id: c.id, met: det, by: 'det' };
    if (!sent) return { id: c.id, met: false, by: 'none' };
    const j = judged.get(c.id);
    return { id: c.id, met: !!j?.met, by: j ? 'judge' : 'none', quote: j?.quote };
  };
  const required = policy.required.map(verdict);
  const optional = policy.optional.map(verdict);
  const prohibited = policy.prohibited.map(verdict);
  const failures = [
    ...(expect_ok ? [] : [`expected ${policy.expect}, got ${sent ? 'send' : 'wait'}`]),
    ...required.filter((r) => !r.met).map((r) => `missing: ${r.id}`),
    ...prohibited.filter((r) => r.met).map((r) => `violation: ${r.id}`),
  ];
  const staleConds = policy.prohibited.filter((c) => c.stale).map((c) => c.id);
  return {
    nas: failures.length ? 0 : 1,
    expect_ok,
    required,
    optional,
    prohibited,
    stale: { opportunities: staleConds.length, violations: prohibited.filter((p) => p.met && staleConds.includes(p.id)).length },
    safety_violations: prohibited.filter((p) => p.met && policy.prohibited.find((c) => c.id === p.id)?.safety).length,
    failures,
  };
}

/** Conditions the judge must decide (no deterministic check). */
export const judgeConditions = (p: ActionPolicy) => [...p.required, ...p.optional, ...p.prohibited].filter((c) => !c.det);
