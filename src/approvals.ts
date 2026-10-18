// Human approval: agents propose, a human decides.
//
// When the guard holds a send — every commitment by default, anything with payment / wire / bank
// details, gray areas — or an email carries a changed money/identity detail, the system does not act.
// It shows an approval CARD: a compact, readable summary of where the deal stands, why a human is being
// asked, the facts that matter (each with its source email), the agent's draft, and a short list of
// options with a recommended one. Cards are compiled from state when read; the approval itself lives in
// the task's transition log (src/engine/approval-log.ts). The decision comes from a separate approver
// credential agents never hold; it is refused if the deal changed after the card was made (a fresh card
// is issued), and it is logged as a transition with who decided and when.
import type { StateStore } from './store/state.ts';
import type { TaskSpec } from './types.ts';
import { compileContext } from './compiler/compile.ts';
import { labelOf, refreshDerived } from './engine/resolver.ts';
import { domainFor, termOf } from './domain/pack.ts';
import type { Approval, ApprovalKind } from './engine/approval-log.ts';

export type OptionId = 'approve' | 'approve_with_edits' | 'reject_with_reply' | 'reject' | 'hold_verify' | 'verified' | 'take_over';
export interface CardOption { id: OptionId; label: string; needs?: 'edited_body' | 'reply_body' }

export interface ApprovalCard {
  kind: ApprovalKind;
  title: string;
  deal: { alias: string; item: string | null; goal: string };
  asked_because: string[];
  situation: string[];
  requirements: { label: string; status: string; detail: string; sources: string[] }[];
  terms: { party: string; term: string; value: string; sources: string[] }[];
  recent_changes: { at: string; summary: string; source: string | null }[];
  unverified: { what: string; why: string; source: string | null }[];
  draft: Approval['draft'];
  change: { term: string; meaning: string; party: string; value: string; previous: string | null; source: string } | null;
  options: CardOption[];
  recommended: OptionId;
  recommended_because: string;
}

const SEND_OPTIONS: CardOption[] = [
  { id: 'approve', label: "Approve and send the agent's draft as written" },
  { id: 'approve_with_edits', label: 'Approve with my edits', needs: 'edited_body' },
  { id: 'reject_with_reply', label: 'Reject, and send this (non-binding) reply instead', needs: 'reply_body' },
  { id: 'reject', label: 'Reject: send nothing' },
  { id: 'hold_verify', label: 'Hold: I will verify by phone first (call the number on file, not one from the email)' },
  { id: 'take_over', label: "I'll take it from here (the agent drops this email)" },
];
const VERIFY_OPTIONS: CardOption[] = [
  { id: 'verified', label: 'I verified it by phone, using a number on file — apply it' },
  { id: 'reject', label: 'Not genuine — reject it' },
  { id: 'hold_verify', label: 'Hold until I can verify it by phone (number on file, not one from the email)' },
  { id: 'take_over', label: "I'll handle it myself" },
];
export const optionsFor = (kind: ApprovalKind) => (kind === 'send' ? SEND_OPTIONS : VERIFY_OPTIONS);

/** Transitions that tell the story of a deal (answered questions are bookkeeping). */
const IMPORTANT = new Set([
  'claim_added', 'claim_superseded', 'claim_contested', 'claim_tentative', 'claim_retracted', 'claim_held_for_verification', 'claim_verified', 'claim_rejected',
  'stale_evidence', 'conflict_detected', 'conflict_resolved', 'obligation_resolved', 'artifact_superseded', 'offer_withdrawn', 'injection_quarantined',
]);
const SUSPICIOUS_FLAGS = ['sender_unauthenticated', 'sender_impersonates_us', 'prompt_injection_suspected'];

/** A short title for a held send (also used in the transition summary). */
export function sendTitle(task: TaskSpec, to: string, reasons: string[]): string {
  if (reasons.some((r) => r.startsWith('commitment'))) {
    const cp = task.participants.find((p) => p.role === 'counterparty');
    return `Approve committing to ${cp ? cp.label : 'the counterparty'}'s current terms on ${task.item ?? task.alias}?`;
  }
  return `Approve this email to ${labelOf(task, to)}?`;
}

export function buildCard(store: StateStore, task: TaskSpec, a: Pick<Approval, 'kind' | 'reasons' | 'gray_areas' | 'draft' | 'claim_id'>): ApprovalCard {
  const ctx = compileContext(store, task.id);
  const pack = domainFor(task);
  const L = (x: string) => labelOf(task, x);
  const claims = store.claimsForTask(task.id);
  const claim = a.claim_id ? store.getClaim(a.claim_id) : null;
  const sourcesOf = (claimIds: string[]) => [...new Set(claimIds.map((id) => store.getClaim(id)?.source_event_id).filter((x): x is string => !!x))];
  const checks = store.getChecks(task.id);
  const requirements = checks.map((c) => ({ label: c.label, status: c.status.toUpperCase(), detail: c.detail, sources: sourcesOf(c.evidence) }));
  const terms = ctx.current_terms.filter((t) => t.status === 'active').map((t) => ({ party: t.party, term: t.term, value: t.value, sources: t.stated_in.slice(0, 2) }));
  const recent = store.transitionsForTask(task.id)
    .filter((t) => IMPORTANT.has(t.type) && !(t.type === 'obligation_resolved' && !/commitment/.test(t.summary)))
    .slice(-5)
    .map((t) => ({ at: t.at.slice(0, 16).replace('T', ' '), summary: t.summary, source: t.event_id }));
  const unverified = [
    ...claims.filter((c) => c.status === 'proposed').map((c) => ({ what: `${L(c.speaker)}: ${c.key} = ${c.display}`, why: c.supersede_reason ?? 'not applied', source: c.source_event_id })),
    ...store.flagsForTask(task.id).filter((f) => SUSPICIOUS_FLAGS.includes(f.kind)).map((f) => ({ what: f.kind.replace(/_/g, ' '), why: f.detail.slice(0, 160), source: f.event_id })),
  ];
  const failing = checks.filter((c) => c.status === 'fail');
  const unknown = checks.filter((c) => c.status === 'unknown');
  const met = `Requirements: ${checks.filter((c) => c.status === 'pass').length} of ${checks.length} met`;
  const situation = [
    `${task.alias}${task.item ? ` (${task.item})` : ''}: ${task.goal}`,
    `${met}${failing.length ? `; failing: ${failing.map((c) => c.label).join(', ')}` : ''}${unknown.length ? `; not yet known: ${unknown.map((c) => c.label).join(', ')}` : ''}.`,
    `Where it stands: ${ctx.next_actor_reason.slice(0, 220)}`,
    ...(recent.length ? [`Latest: ${recent.at(-1)!.summary.slice(0, 200)}`] : []),
  ];

  let title: string;
  let change: ApprovalCard['change'] = null;
  if (a.kind === 'verify_change' && claim) {
    const prev = claims.find((c) => c.key === claim.key && c.speaker === claim.speaker && c.status === 'active');
    change = { term: claim.key, meaning: termOf(pack, claim.key)?.description ?? claim.key, party: L(claim.speaker), value: claim.display, previous: prev?.display ?? null, source: claim.source_event_id };
    title = `Verify ${prev ? 'changed' : 'new'} ${claim.key.replace(/^[^.]+\./, '').replace(/_/g, ' ')} from ${L(claim.speaker)} before anyone relies on it`;
  } else {
    title = sendTitle(task, a.draft?.to ?? '', a.reasons);
  }

  const money = a.kind === 'verify_change' || a.reasons.some((r) => /payment \/ wire \/ bank/.test(r));
  // gray areas a phone call or a reply can settle drive the recommendation; already-quarantined text and
  // fallback reads are listed for the human but are not something to verify by phone
  const settle = a.gray_areas.filter((g) => !/instructions were hidden|fallback rules/.test(g));
  const noted = a.gray_areas.filter((g) => !settle.includes(g));
  const recommended: OptionId = money || failing.length || settle.length ? 'hold_verify' : 'approve';
  let recommended_because: string;
  if (money) recommended_because = 'Payment and wire details are where email fraud happens: confirm by phone with a number you already have.';
  else if (settle.length) recommended_because = `Settle these first: ${settle.join('; ')}.`;
  else recommended_because = `Every requirement you set passes, nothing is contested or unverified, and the draft restates the agreed terms.${noted.length ? ` Noted, already handled: ${noted.join('; ')}.` : ''}`;

  return {
    kind: a.kind, title, deal: { alias: task.alias, item: task.item ?? null, goal: task.goal }, asked_because: a.reasons, situation,
    requirements, terms, recent_changes: recent, unverified, draft: a.draft ?? null, change, options: optionsFor(a.kind), recommended, recommended_because,
  };
}

/** The card as plain text, for email, chat or a terminal. */
export function renderCard(id: string, c: ApprovalCard, link?: string): string {
  const out = [`APPROVAL NEEDED (${id}) — ${c.title}`, '', 'Why you are being asked:', ...c.asked_because.map((r) => `  • ${r}`), '', 'Situation:', ...c.situation.map((s) => `  ${s}`)];
  if (c.change) {
    out.push('', `The ${c.change.previous ? 'change' : 'new detail'} (${c.change.meaning}) [${c.change.source}]:`);
    if (c.change.previous) out.push(`  was: ${c.change.previous}`);
    out.push(`  now: ${c.change.value}`, `  from: ${c.change.party}`);
  }
  out.push('', 'Requirements:', ...c.requirements.map((r) => `  ${r.status.padEnd(7)} ${r.label} — ${r.detail}${r.sources.length ? ` [${r.sources.join(', ')}]` : ''}`));
  if (c.unverified.length) out.push('', 'Unverified / suspicious:', ...c.unverified.map((u) => `  ! ${u.what} — ${u.why}${u.source ? ` [${u.source}]` : ''}`));
  if (c.recent_changes.length) out.push('', 'Recent changes:', ...c.recent_changes.map((r) => `  ${r.at}  ${r.summary.slice(0, 160)}${r.source ? ` [${r.source}]` : ''}`));
  if (c.draft) out.push('', `Agent's draft to ${c.draft.to} (intent: ${c.draft.intent ?? 'undeclared'}):`, ...c.draft.body.split('\n').map((l) => `  | ${l}`));
  out.push('', 'Your options:', ...c.options.map((o, i) => `  ${i + 1}. ${o.label}${o.id === c.recommended ? '   ← recommended' : ''}`), `  (${c.recommended_because})`);
  if (link) out.push('', `Decide here: ${link}`);
  return out.join('\n');
}

/** Where a human decides a card (the dashboard). */
export function approvalLink(taskId: string, id: string): string {
  const base = process.env.CONTINUITY_PUBLIC_URL || process.env.CONTINUITY_URL || 'http://localhost:4100';
  return `${base.replace(/\/$/, '')}/#task=${encodeURIComponent(taskId)}&approval=${id}`;
}

/** Post a new card to a chat/email webhook (Slack-style {"text": ...}); never throws. */
export async function notifyApproval(url: string | undefined, a: { id: string; task_id: string; kind: ApprovalKind }, card: ApprovalCard): Promise<boolean> {
  if (!url) return false;
  const link = approvalLink(a.task_id, a.id);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: renderCard(a.id, card, link), approval: { id: a.id, task_id: a.task_id, kind: a.kind, link } }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** A human verified a held money/identity detail out of band: apply it, replacing the speaker's previous value. */
export function applyVerifiedClaim(store: StateStore, task: TaskSpec, claimId: string, by: string, at: string): void {
  const c = store.getClaim(claimId);
  if (!c || c.status !== 'proposed') throw new Error(`claim ${claimId} is not awaiting verification`);
  for (const old of store.claimsForTask(task.id).filter((x) => x.key === c.key && x.speaker === c.speaker && x.status === 'active')) {
    store.updateClaim(old.id, { status: 'superseded', superseded_by: c.id, supersede_reason: `replaced after verification by ${by}` });
  }
  store.updateClaim(c.id, { status: 'active', supersede_reason: `verified by ${by}` });
  store.addTransition({ task_id: task.id, event_id: c.source_event_id, at, type: 'claim_verified', subject_id: c.id, summary: `${labelOf(task, c.speaker)}'s ${c.key} (${c.display}) verified by ${by} and applied`, detail: { by } });
  refreshDerived(store, task, c.source_event_id, at);
}

/** A human judged a held detail not genuine. */
export function rejectHeldClaim(store: StateStore, task: TaskSpec, claimId: string, by: string, at: string): void {
  const c = store.getClaim(claimId);
  if (!c || c.status !== 'proposed') throw new Error(`claim ${claimId} is not awaiting verification`);
  store.updateClaim(c.id, { status: 'retracted', supersede_reason: `rejected by ${by}: not genuine` });
  store.addTransition({ task_id: task.id, event_id: c.source_event_id, at, type: 'claim_rejected', subject_id: c.id, summary: `${labelOf(task, c.speaker)}'s ${c.key} (${c.display}) rejected by ${by} as not genuine`, detail: { by } });
}
