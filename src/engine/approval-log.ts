// Decisions held for a human, as task state.
//
// Approvals are not a table of their own: every request and every decision is already a transition
// (the requirement "every request/decision is logged"), and transitions are persisted by every backend
// in the same version-checked commit as the rest of the task's state. So an approval is folded from
// the task's transition log:
//   approval_requested            a held send (detail: draft, reasons, gray areas, state fingerprint, expiry)
//   claim_held_for_verification   the resolver held a payment/identity detail from email: a verification card
//   approval_decided              a human's decision (detail: approval_id, option, status, by, ...)
//   approval_expired              recorded when an expired card is touched
// An approval's id is "ap_<seq>" of the transition that opened it, unique within the organization.
// Concurrency comes for free: a decision commits against the task's state version, so two people
// deciding the same card at once cannot both win.
import { createHash } from 'node:crypto';
import type { StateStore } from '../store/state.ts';
import type { Transition } from '../types.ts';
import { nowIso } from '../clock.ts';

export const APPROVAL_REQUESTED = 'approval_requested';
export const APPROVAL_DECIDED = 'approval_decided';
export const APPROVAL_EXPIRED = 'approval_expired';
export const HELD_FOR_VERIFICATION = 'claim_held_for_verification';

/** How long a card stays decidable (CONTINUITY_APPROVAL_TTL_H, default 48 hours). */
export const approvalTtlHours = () => Number(process.env.CONTINUITY_APPROVAL_TTL_H || 48);
export const expiresAfter = (at: string) => new Date(Date.parse(at) + approvalTtlHours() * 3_600_000).toISOString();

export type ApprovalKind = 'send' | 'verify_change';
export type ApprovalStatus = 'pending' | 'held' | 'approved' | 'edited' | 'rejected' | 'replied' | 'verified' | 'taken_over' | 'expired' | 'stale';

export interface ApprovalDraft {
  agent_id: string;
  to: string;
  subject: string | null;
  body: string;
  intent: string | null;
  reply_to_event: string | null;
}

export interface ApprovalRequestDetail {
  kind: ApprovalKind;
  /** what the human is asked, in one line */
  title: string;
  reasons: string[];
  gray_areas: string[];
  draft: ApprovalDraft | null;
  claim_id: string | null;
  /** what the state looked like when the card was made; a decision on a different state is refused */
  fingerprint: string | null;
  expires_at: string;
  /** the stale card this one re-issues */
  replaces?: string | null;
}

export interface ApprovalDecisionDetail {
  approval_id: string;
  status: ApprovalStatus;
  option: string;
  by: string;
  note?: string;
  edited_body?: string;
  reply_body?: string;
  /** the outbound action created by an approving decision */
  action_id?: string | null;
  new_approval_id?: string | null;
}

export interface Approval extends ApprovalRequestDetail {
  id: string;
  task_id: string;
  status: ApprovalStatus;
  requested_seq: number;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision: Omit<ApprovalDecisionDetail, 'approval_id' | 'status'> | null;
  action_id: string | null;
}

export const OPEN_STATUSES: ApprovalStatus[] = ['pending', 'held'];
export const approvalId = (seq: number) => `ap_${seq}`;

function opened(t: Transition): Approval | null {
  if (t.type === APPROVAL_REQUESTED) {
    const d = t.detail as unknown as ApprovalRequestDetail;
    return {
      ...d, id: approvalId(t.seq), task_id: t.task_id, status: 'pending', requested_seq: t.seq, created_at: t.at,
      decided_at: null, decided_by: null, decision: null, action_id: null,
    };
  }
  if (t.type === HELD_FOR_VERIFICATION && t.subject_id) {
    return {
      kind: 'verify_change', title: `Verify before anyone relies on it: ${t.summary.replace(/ is held until a human verifies it$/, '')}`,
      reasons: [`${t.summary} — payment and identity details are never applied from email alone`], gray_areas: [], draft: null,
      claim_id: t.subject_id, fingerprint: null, expires_at: expiresAfter(t.at),
      id: approvalId(t.seq), task_id: t.task_id, status: 'pending', requested_seq: t.seq, created_at: t.at,
      decided_at: null, decided_by: null, decision: null, action_id: null,
    };
  }
  return null;
}

/**
 * Every approval of a task, oldest first. Status is as recorded, except that an open card past its
 * deadline reads "expired", and a verification card whose detail is no longer awaiting verification
 * (decided some other way) reads "stale".
 */
export function approvalsForTask(store: StateStore, taskId: string, now = nowIso()): Approval[] {
  const byId = new Map<string, Approval>();
  for (const t of store.transitionsForTask(taskId)) {
    const a = opened(t);
    if (a) {
      byId.set(a.id, a);
      continue;
    }
    if (t.type !== APPROVAL_DECIDED && t.type !== APPROVAL_EXPIRED) continue;
    const id = String((t.detail as { approval_id?: string }).approval_id ?? t.subject_id ?? '');
    const target = byId.get(id);
    if (!target) continue;
    if (t.type === APPROVAL_EXPIRED) {
      Object.assign(target, { status: 'expired', decided_at: t.at, decided_by: 'system: expired' });
      continue;
    }
    const { approval_id: _id, status, ...decision } = t.detail as unknown as ApprovalDecisionDetail;
    Object.assign(target, { status, decided_at: t.at, decided_by: decision.by, decision, action_id: decision.action_id ?? target.action_id });
  }
  const list = [...byId.values()];
  for (const a of list) {
    if (!OPEN_STATUSES.includes(a.status)) continue;
    if (Date.parse(a.expires_at) < Date.parse(now)) a.status = 'expired';
    else if (a.kind === 'verify_change' && a.claim_id && store.getClaim(a.claim_id)?.status !== 'proposed') a.status = 'stale';
  }
  return list;
}

/** Cards a human still has to decide (pending, or held while someone verifies). */
export function openApprovals(store: StateStore, taskId: string, now = nowIso()): Approval[] {
  return approvalsForTask(store, taskId, now).filter((a) => OPEN_STATUSES.includes(a.status));
}

/** What a send decision depends on: checks, claims and obligations (not approval bookkeeping). */
export function stateFingerprint(store: StateStore, taskId: string): string {
  const state = {
    checks: store.getChecks(taskId).map((c) => [c.id, c.status, c.detail]),
    claims: store.claimsForTask(taskId).map((c) => [c.id, c.status]),
    obligations: store.obligationsForTask(taskId).map((o) => [o.id, o.status]),
  };
  return createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);
}

/** Record a held send. Returns the new approval id. */
export function requestApproval(store: StateStore, taskId: string, at: string, d: Omit<ApprovalRequestDetail, 'fingerprint' | 'expires_at'>): string {
  const detail: ApprovalRequestDetail = { ...d, fingerprint: stateFingerprint(store, taskId), expires_at: expiresAfter(at) };
  const seq = store.addTransition({
    task_id: taskId, event_id: null, at, type: APPROVAL_REQUESTED, subject_id: d.claim_id ?? null,
    summary: `Held for a human: ${d.title} (${d.reasons.join('; ').slice(0, 200)})`, detail: detail as unknown as Record<string, unknown>,
  });
  return approvalId(seq);
}

/** Record open cards past their deadline as expired (whoever touches them first writes it). */
export function recordExpired(store: StateStore, taskId: string, at: string): string[] {
  const expired = approvalsForTask(store, taskId, at).filter((a) => a.status === 'expired' && !a.decided_at);
  for (const a of expired) {
    store.addTransition({ task_id: taskId, event_id: null, at, type: APPROVAL_EXPIRED, subject_id: a.id, summary: `Approval ${a.id} expired undecided: ${a.title.slice(0, 160)}`, detail: { approval_id: a.id } });
  }
  return expired.map((a) => a.id);
}

/** Record a human's decision. */
export function recordDecision(store: StateStore, taskId: string, at: string, d: ApprovalDecisionDetail, summary: string): void {
  store.addTransition({ task_id: taskId, event_id: null, at, type: APPROVAL_DECIDED, subject_id: d.approval_id, summary, detail: d as unknown as Record<string, unknown> });
}
