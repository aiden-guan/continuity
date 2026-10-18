// Structural validation of generated cases. Catches generator mistakes (an oracle citing an event that
// does not exist, a term outside the vocabulary, a value that does not normalise, a party that is not
// in the task) before anything is run. `npm run bench -- validate` runs it over every case.
import type { BenchCase, OracleState, VerticalSpec } from './types.ts';
import { normalize, termType } from './normalize.ts';
import { REASK_CLAUSE, STALE_CLAUSE } from './util.ts';

export function validateCase(c: BenchCase, vertical: VerticalSpec): string[] {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(`${c.id}: ${msg}`);
  const keys = new Set(c.events.map((e) => e.key));
  const taskKeys = new Set(c.events.filter((e) => !e.background).map((e) => e.key));
  const parties = new Set(c.task.parties.map((p) => p.address));
  const subjects = new Set([...vertical.terms.map((t) => t.key), ...vertical.loopSubjects.map((s) => s.key)]);
  const order = new Map(c.events.map((e, i) => [e.key, i]));

  if (new Set(c.events.map((e) => e.key)).size !== c.events.length) err('duplicate event keys');
  for (let i = 1; i < c.events.length; i++) if (c.events[i].at < c.events[i - 1].at) err(`events not chronological at ${c.events[i].key}`);
  for (const e of c.events) {
    if (e.replyTo && !keys.has(e.replyTo)) err(`${e.key} replies to unknown ${e.replyTo}`);
    if (e.replyTo && (order.get(e.replyTo) ?? 0) >= (order.get(e.key) ?? 0)) err(`${e.key} replies to a later message`);
    if (e.direction === 'outbound' && e.from !== c.task.self_address) err(`${e.key} outbound but not from us`);
    if (!e.background && e.direction === 'inbound' && !e.to.includes(c.task.self_address) && !(e.cc ?? []).includes(c.task.self_address)) err(`${e.key} inbound but not addressed to us`);
  }
  if (!taskKeys.has(c.trigger)) err(`trigger ${c.trigger} is not a task event`);
  const trig = order.get(c.trigger) ?? -1;
  for (const e of c.events) if (!e.background && (order.get(e.key) ?? 0) > trig) err(`task event ${e.key} comes after the trigger ${c.trigger} (the agent could never see it)`);
  if (!c.checkpoints.length) err('no checkpoints');
  const last = c.checkpoints.at(-1);
  if (last && !last.action) err('final checkpoint has no action policy');
  if (last && last.after !== c.trigger) err(`final checkpoint is after ${last.after} but the trigger is ${c.trigger}`);

  const checkEvidence = (where: string, ev: string[], cut: string) => {
    if (!ev.length) err(`${where}: no evidence`);
    for (const k of ev) {
      if (!taskKeys.has(k)) err(`${where}: evidence ${k} is not a task event`);
      else if ((order.get(k) ?? 0) > (order.get(cut) ?? 0)) err(`${where}: evidence ${k} is after the checkpoint`);
    }
  };
  const checkValue = (where: string, term: string, value: unknown) => {
    const t = termType(vertical, term);
    if (!t) return err(`${where}: term ${term} not in the ${vertical.id} vocabulary`);
    if (normalize(t.type, value, t.values) === null) err(`${where}: value ${JSON.stringify(value)} is not a valid ${t.type}`);
  };
  const checkParty = (where: string, p: string) => { if (!parties.has(p)) err(`${where}: ${p} is not a task party`); };

  for (const cp of c.checkpoints) {
    if (!keys.has(cp.after)) err(`checkpoint ${cp.id} after unknown ${cp.after}`);
    const s: OracleState = cp.state;
    const seen = new Set<string>();
    for (const t of s.terms) {
      const where = `${cp.id} term ${t.party}/${t.term}`;
      checkParty(where, t.party);
      if (seen.has(`${t.party}|${t.term}`)) err(`${where}: listed twice`);
      seen.add(`${t.party}|${t.term}`);
      if (t.status === 'current') { checkValue(where, t.term, t.value); checkEvidence(where, t.evidence, cp.after); }
      if (t.status === 'contested') {
        if (!t.contested || t.contested.length < 2) err(`${where}: contested needs ≥2 values`);
        for (const v of t.contested ?? []) { checkParty(where, v.party); checkValue(where, t.term, v.value); checkEvidence(where, v.evidence, cp.after); }
      }
      if (t.status === 'absent' && !termType(vertical, t.term)) err(`${where}: unknown term`);
    }
    for (const x of s.superseded) { checkParty(`${cp.id} superseded`, x.party); checkValue(`${cp.id} superseded ${x.term}`, x.term, x.value); checkEvidence(`${cp.id} superseded ${x.term}`, [...x.evidence, x.superseded_by], cp.after); }
    for (const l of [...s.open_loops, ...s.closed_loops]) {
      const where = `${cp.id} loop ${l.kind}/${l.subject}`;
      checkParty(where, l.debtor);
      for (const p of l.alt_debtors ?? []) checkParty(where, p);
      for (const sub of [l.subject, ...(l.alt_subjects ?? [])]) if (!subjects.has(sub)) err(`${where}: subject ${sub} unknown`);
      checkEvidence(where, l.evidence, cp.after);
    }
    for (const x of s.conflicts) if (!termType(vertical, x.term)) err(`${cp.id} conflict term ${x.term} unknown`);
    for (const d of s.documents) {
      if (!c.events.some((e) => (e.attachments ?? []).some((a) => a.filename === d.filename))) err(`${cp.id} document ${d.filename} not attached anywhere`);
      for (const k of [...d.stale_terms, ...(d.ambiguous_terms ?? [])]) if (!termType(vertical, k)) err(`${cp.id} document stale term ${k} unknown`);
      if (d.status === 'partially_stale' && !d.stale_terms.length) err(`${cp.id} ${d.filename}: partially_stale with no stale terms`);
      if (d.ambiguous_terms?.length && d.status !== 'partially_stale') err(`${cp.id} ${d.filename}: ambiguous_terms only make sense on a partially_stale document`);
      for (const k of d.ambiguous_terms ?? []) if (d.stale_terms.includes(k)) err(`${cp.id} ${d.filename}: ${k} is both stale and ambiguous`);
    }
    if (cp.action) {
      const ids = [...cp.action.required, ...cp.action.optional, ...cp.action.prohibited].map((x) => x.id);
      if (new Set(ids).size !== ids.length) err(`${cp.id}: duplicate action condition ids`);
      for (const cond of [...cp.action.required, ...cp.action.optional, ...cp.action.prohibited]) {
        const det = cond.det;
        if (det && 'party' in det && det.party) checkParty(`${cp.id} cond ${cond.id}`, det.party);
        if (det?.type === 'message_to_any') for (const p of det.parties) checkParty(`${cp.id} cond ${cond.id}`, p);
        if (det?.type === 'pattern') { try { new RegExp(det.pattern, det.flags); } catch { err(`${cp.id} cond ${cond.id}: bad regex`); } }
        // condition style guide (AUTHORING.md): the shared clauses keep the blind judge's policy the same everywhere
        if (cond.id.startsWith('reask') && !cond.text.includes(REASK_CLAUSE)) err(`${cp.id} cond ${cond.id}: a re-ask condition must use reaskText()`);
        if (cond.stale && !cond.text.includes(STALE_CLAUSE)) err(`${cp.id} cond ${cond.id}: a stale condition must use staleText()`);
      }
      for (const cond of [...cp.action.required, ...cp.action.optional]) if (cond.stale || cond.safety) err(`${cp.id} cond ${cond.id}: stale / safety only apply to prohibited conditions`);
      if (!cp.judge_facts) err(`${cp.id}: action checkpoint without judge_facts`);
    }
  }
  return errors;
}
