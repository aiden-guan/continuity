// Typed timeline: a task's history as one ordered list of typed events (offer_made, counter_offer,
// appraisal_received, commitment_made, conflict_detected, ...), each with its source email. It is derived
// from the resolver's transition log in a task's working set, so it is exactly what the engine decided,
// in the order it decided it. (The service's `timeline()` is the raw per-email view; this is the typed one.)
//
// Event types get small stable integer ids: generic ones below 100, a pack's own from 100 up. The terms at
// any moment are a step function over the timeline: each (term, party) keeps its last applied value until
// a later event changes or withdraws it.
// Ported from samrocksnature's b615ab7.
import type { MemoryStore } from '../store/state.ts';
import type { Claim, TaskSpec, Transition } from '../types.ts';
import { approvalId } from './approval-log.ts';
import { domainFor, termOf } from '../domain/index.ts';
import type { DomainPack } from '../domain/pack.ts';
import { labelOf, partyOf } from './resolver.ts';

export interface TimelineEvent {
  seq: number;
  at: string;
  type: string;
  type_id: number;
  party: string | null;
  term?: string;
  value?: unknown;
  display?: string;
  /** false: recorded but not applied to state (tentative or stale evidence) */
  applied: boolean;
  /** what this event replaced, for changes ("Fri Nov 20" → "Fri Dec 4") */
  replaces?: string;
  source_event: string | null;
  /** the claim, obligation, artifact or check the event is about */
  ref: string | null;
  summary: string;
}

/**
 * Generic event types, in id order. Append only: ids are positions, so existing ones never move.
 */
const GENERIC = [
  'message_received', 'message_sent', 'term_withdrawn', 'statement_not_applied', 'stale_evidence', 'question_asked', 'request_made',
  'commitment_made', 'question_answered', 'request_answered', 'commitment_fulfilled', 'obligation_declined', 'obligation_cancelled',
  'document_received', 'document_superseded', 'conflict_detected', 'conflict_resolved', 'injection_quarantined', 'send_blocked', 'terms_contested',
  'commitment_partially_fulfilled', 'commitment_overdue', 'offer_reinstated', 'interpretation_failed', 'send_failed',
  // human approval
  'held_for_verification', 'detail_verified', 'detail_rejected', 'approval_requested', 'approval_granted', 'approval_rejected', 'approval_held',
  'approval_expired', 'human_took_over', 'approval_stale',
];

/** Stable ids: generic types 1..99 in GENERIC order, the pack's own types from 100 in vocabulary order. */
export function eventTypeIds(pack: DomainPack): Map<string, number> {
  const ids = new Map(GENERIC.map((t, i) => [t, i + 1]));
  let next = 100;
  for (const t of pack.terms) {
    for (const name of new Set(Object.values(t.events ?? {}))) if (name && !ids.has(name)) ids.set(name, next++);
  }
  return ids;
}

function termEventType(pack: DomainPack, task: TaskSpec, c: Claim): string {
  const names = termOf(pack, c.key)?.events ?? {};
  const role = partyOf(task, c.speaker)?.role;
  return (role && names[role]) ?? names.default ?? `${c.key.replace(/\./g, '_')}_stated`;
}

export function deriveTimeline(store: MemoryStore, taskId: string): TimelineEvent[] {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`unknown task ${taskId}`);
  const pack = domainFor(task);
  const ids = eventTypeIds(pack);
  const label = (a: string | null | undefined) => (a ? labelOf(task, a) : null);
  const out: TimelineEvent[] = [];
  const push = (t: Transition, type: string, e: Omit<TimelineEvent, 'seq' | 'at' | 'type' | 'type_id' | 'source_event' | 'summary'> & { summary?: string }) =>
    out.push({ seq: t.seq, at: t.at, type, type_id: ids.get(type) ?? 0, source_event: t.event_id, summary: e.summary ?? t.summary, ...e });
  const termEvent = (t: Transition, c: Claim, extra: Partial<TimelineEvent> = {}) =>
    push(t, termEventType(pack, task, c), { party: label(c.speaker), term: c.key, value: c.value, display: c.display, applied: true, ref: c.id, ...extra });

  for (const t of store.transitionsForTask(task.id)) {
    const claim = t.subject_id?.startsWith('cl_') ? store.getClaim(t.subject_id) : null;
    const obligation = t.subject_id?.startsWith('ob_') ? store.getObligation(t.subject_id) : null;
    const d = (t.detail ?? {}) as Record<string, unknown>;
    switch (t.type) {
      case 'event_ingested':
        push(t, d.direction === 'outbound' ? 'message_sent' : 'message_received', { party: null, applied: true, ref: t.event_id });
        break;
      case 'claim_added':
      case 'claim_superseded':
      case 'claim_contested':
        if (!claim) break;
        termEvent(t, claim, t.type === 'claim_superseded' && typeof d.from_display === 'string' ? { replaces: d.from_display } : {});
        if (t.type === 'claim_contested') push(t, 'terms_contested', { party: label(claim.speaker), term: claim.key, applied: true, ref: claim.id });
        break;
      case 'offer_withdrawn': {
        if (!claim) break;
        termEvent(t, claim);
        // the speaker's offer terms this withdrawal retracted
        const retracted = store.claimsForTask(task.id).filter((c) => c.speaker === claim.speaker && c.status === 'retracted'
          && c.supersede_reason?.startsWith('offer withdrawn') && c.supersede_reason.endsWith(`in ${t.event_id}`));
        for (const c of retracted) push(t, 'term_withdrawn', { party: label(c.speaker), term: c.key, display: c.display, applied: true, ref: c.id });
        break;
      }
      case 'offer_reinstated':
        push(t, 'offer_reinstated', { party: label(claim?.speaker), applied: true, ref: t.subject_id });
        break;
      case 'claim_retracted':
        if (claim) push(t, 'term_withdrawn', { party: label(claim.speaker), term: claim.key, display: claim.display, applied: true, ref: claim.id });
        break;
      case 'claim_tentative':
        if (claim) push(t, 'statement_not_applied', { party: label(claim.speaker), term: claim.key, value: claim.value, display: claim.display, applied: false, ref: claim.id });
        break;
      case 'claim_held_for_verification':
        if (claim) push(t, 'held_for_verification', { party: label(claim.speaker), term: claim.key, value: claim.value, display: claim.display, applied: false, ref: claim.id, ...(typeof d.previous === 'string' ? { replaces: d.previous } : {}) });
        break;
      case 'claim_verified':
        if (!claim) break;
        push(t, 'detail_verified', { party: String(d.by ?? 'a human'), term: claim.key, display: claim.display, applied: true, ref: claim.id });
        termEvent(t, claim);
        break;
      case 'claim_rejected':
        if (claim) push(t, 'detail_rejected', { party: String(d.by ?? 'a human'), term: claim.key, display: claim.display, applied: true, ref: claim.id });
        break;
      case 'approval_requested':
        push(t, 'approval_requested', { party: null, display: String(d.title ?? t.summary).slice(0, 160), applied: true, ref: approvalId(t.seq) });
        break;
      case 'approval_decided': {
        const status = String(d.status ?? '');
        let type = 'approval_granted';
        if (status === 'held') type = 'approval_held';
        else if (status === 'taken_over') type = 'human_took_over';
        else if (status === 'rejected' || status === 'replied') type = 'approval_rejected';
        else if (status === 'stale') type = 'approval_stale'; // refused by the system: the deal changed under the card
        push(t, type, { party: String(d.by ?? 'a human'), display: String(d.option ?? ''), applied: true, ref: t.subject_id });
        break;
      }
      case 'approval_expired':
        push(t, 'approval_expired', { party: null, applied: true, ref: t.subject_id });
        break;
      case 'stale_evidence':
        if (claim) push(t, 'stale_evidence', { party: label(claim.speaker), term: claim.key, value: claim.value, display: claim.display, applied: false, ref: claim.id });
        break;
      case 'obligation_opened': {
        const kind = String(d.kind ?? obligation?.kind ?? '');
        const type = kind === 'commitment' ? 'commitment_made' : kind === 'question' ? 'question_asked' : 'request_made';
        const who = kind === 'commitment' ? String(d.debtor ?? obligation?.debtor ?? '') : String(d.creditor ?? obligation?.creditor ?? '');
        push(t, type, { party: label(who || null), display: obligation?.text, applied: true, ref: t.subject_id });
        break;
      }
      case 'obligation_resolved': {
        const status = String(d.status ?? obligation?.status ?? '');
        const type = status === 'declined' ? 'obligation_declined' : status === 'cancelled' ? 'obligation_cancelled'
          : obligation?.kind === 'commitment' ? 'commitment_fulfilled' : obligation?.kind === 'question' ? 'question_answered' : 'request_answered';
        push(t, type, { party: label(obligation?.debtor), display: obligation?.text, applied: true, ref: t.subject_id });
        break;
      }
      case 'obligation_partially_fulfilled':
        push(t, 'commitment_partially_fulfilled', { party: label(obligation?.debtor), display: obligation?.text, applied: true, ref: t.subject_id });
        break;
      case 'obligation_overdue':
        push(t, 'commitment_overdue', { party: label(obligation?.debtor), display: obligation?.text, applied: true, ref: t.subject_id });
        break;
      case 'artifact_added': {
        const a = t.subject_id ? store.getArtifact(t.subject_id) : null;
        push(t, 'document_received', { party: label(a?.owner), display: a ? `${a.filename} (${a.kind})` : undefined, applied: true, ref: t.subject_id });
        break;
      }
      case 'artifact_superseded':
        push(t, 'document_superseded', { party: null, applied: true, ref: t.subject_id });
        break;
      case 'conflict_detected':
      case 'conflict_resolved': {
        const check = (d.check ?? {}) as { label?: string; party?: string | null };
        push(t, t.type, { party: label(check.party ?? null), display: check.label ?? t.summary, applied: true, ref: t.subject_id });
        break;
      }
      case 'injection_quarantined':
      case 'send_blocked':
      case 'interpretation_failed':
      case 'send_failed':
        push(t, t.type, { party: null, applied: true, ref: t.subject_id });
        break;
      default:
        break; // task setup, corroboration, check passes and bookkeeping carry no new fact
    }
  }
  return out;
}

export interface TermAt { term: string; party: string; value: unknown; display: string; since: string; source_event: string | null }

/**
 * The task's terms at a moment (an ISO time, or a timeline seq): for each (term, party), the last applied
 * value at or before it. Superseded values are replaced by the event that changed them; withdrawn terms
 * drop out; tentative and stale statements never apply.
 */
export function stateAt(store: MemoryStore, taskId: string, at: string | number): { as_of: string | number; terms: TermAt[] } {
  const limit = typeof at === 'number' ? at : Date.parse(at);
  if (Number.isNaN(limit)) throw new Error(`at must be an ISO time or a timeline seq, not "${at}"`);
  const upto = (e: TimelineEvent) => (typeof at === 'number' ? e.seq <= limit : Date.parse(e.at) <= limit);
  const terms = new Map<string, TermAt>();
  for (const e of deriveTimeline(store, taskId)) {
    if (!upto(e) || !e.applied || !e.term || !e.party) continue;
    // a human's verdict on a held detail is not itself a term value (a verified one gets its own term event)
    if (e.type === 'detail_verified' || e.type === 'detail_rejected') continue;
    const key = `${e.term}|${e.party}`;
    if (e.type === 'term_withdrawn') terms.delete(key);
    else if (e.type !== 'terms_contested') terms.set(key, { term: e.term, party: e.party, value: e.value, display: e.display ?? String(e.value), since: e.at, source_event: e.source_event });
  }
  return { as_of: at, terms: [...terms.values()] };
}
