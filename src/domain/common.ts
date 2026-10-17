// Pieces several packs share: requirement lookup, per-party claim access, the "missing information"
// default, and the standard next actions (a withdrawn offer, a missing internal approval, everything
// met so commit in writing).
import type { CheckResult, Claim, Participant, TaskSpec } from '../types.ts';
import type { ActionContext, SuggestedAction, TermDef } from './pack.ts';

export const requirementOf = (task: TaskSpec, key: string) => task.requirements.find((r) => r.key === key);

/** The speaker's active claim on a term. */
export const ownClaim = (active: Claim[], key: string, speaker: string) => active.find((c) => c.key === key && c.speaker === speaker);

/** Parties that may set a term (by authority prefix). */
export const partiesFor = (task: TaskSpec, key: string, role: Participant['role'] = 'counterparty') =>
  task.participants.filter((p) => p.role === role && p.authority.some((a) => key.startsWith(a)));

/** The counterparty's active withdrawal, as a failing check (nothing else is checked against a dead offer). */
export function withdrawalCheck(party: Participant, active: Claim[], lifecycleKey = 'offer.status'): CheckResult | null {
  const withdrawn = active.find((c) => c.key === lifecycleKey && c.speaker === party.address && c.value === 'withdrawn');
  if (!withdrawn) return null;
  return {
    id: `offer_available:${party.address}`, label: `Offer from ${party.label} available`, status: 'fail', party: party.address, evidence: [withdrawn.id],
    requirement_key: lifecycleKey, detail: `${party.label} withdrew its offer (${withdrawn.source_event_id}); earlier terms are no longer available`,
  };
}

/** A check over one claim: unknown without it, else pass/fail by `ok`. */
export function claimCheck(o: {
  id: string; label: string; party: Participant; requirementKey: string; claim: Claim | undefined; missing: string;
  ok: (c: Claim) => boolean; detail: (c: Claim, ok: boolean) => string; extraEvidence?: string[];
}): CheckResult {
  const { id, label, party, requirementKey, claim } = o;
  if (!claim) return { id, label, status: 'unknown', detail: o.missing, party: party.address, evidence: o.extraEvidence ?? [], requirement_key: requirementKey };
  const ok = o.ok(claim);
  return { id, label, status: ok ? 'pass' : 'fail', detail: o.detail(claim, ok), party: party.address, evidence: [claim.id, ...(o.extraEvidence ?? [])], requirement_key: requirementKey };
}

/** Which terms each counterparty is expected to supply: the ones it has authority over, minus those never chased. */
export function expectedFrom(terms: TermDef[], notChased: Set<string>) {
  return (task: TaskSpec) => task.participants
    .filter((p) => p.role === 'counterparty')
    .map((party) => ({
      party,
      keys: terms.map((t) => t.key).filter((k) => !notChased.has(k) && !terms.find((t) => t.key === k)?.lifecycle && party.authority.some((a) => k.startsWith(a))),
    }))
    .filter((x) => x.keys.length);
}

/**
 * The standard next actions: replace a withdrawn offer; ask the internal approver when no approval is on
 * record (and not already asked); commit in writing when every check passes and nothing is contested.
 */
export function standardActions(ctx: ActionContext, o: { approvalPrefix: string; approvalKey: string; decisionKey: string; approvalAsk: string; commit: (party: string) => string }): SuggestedAction[] {
  const { task, checks, live, contested, openDebtors } = ctx;
  const actions: SuggestedAction[] = [];
  const self = task.self_address.toLowerCase();

  for (const c of checks.filter((x) => x.id.startsWith('offer_available:') && x.status === 'fail')) {
    const party = task.participants.find((p) => p.address === c.party);
    actions.push({
      priority: 1, kind: 'offer_withdrawn', to: null, to_address: null, check_id: c.id,
      action: `${party?.label ?? c.party} withdrew its offer — do not accept or rely on its earlier terms; find another option or escalate`,
      why: c.detail,
      evidence: c.evidence.map((id) => live.find((l) => l.id === id)?.source_event_id).filter((x): x is string => !!x),
    });
  }

  // a change to a term from someone who may not make it (a spoofed domain, an outsider, a colleague
  // without authority): never applied; verify with the party who does speak for it, at its known address
  const seen = new Set<string>();
  for (const t of ctx.tentative ?? []) {
    if (!/not authoritative|authenticated sender/.test(t.supersede_reason ?? '') || seen.has(t.key)) continue;
    const current = live.find((c) => c.key === t.key && c.status === 'active');
    if (current && JSON.stringify(current.value) === JSON.stringify(t.value)) continue;
    const owner = task.participants.find((p) => p.address === current?.speaker)
      ?? task.participants.find((p) => p.role !== 'self' && p.address !== t.speaker && p.authority.some((a) => t.key.startsWith(a)));
    if (!owner) continue;
    seen.add(t.key);
    actions.push({
      priority: 1, kind: 'verify_change', to: owner.label, to_address: owner.address,
      action: `Unverified change to ${t.key} (${t.display}) from ${ctx.label(t.speaker)} — do not act on it or reply to that sender; confirm with ${owner.label} at their known address${current ? ` (current: ${current.display})` : ''}`,
      why: t.supersede_reason ?? 'not applied', evidence: [t.source_event_id],
    });
  }

  const approver = task.participants.find((p) => p.role === 'internal' && p.authority.some((a) => a.startsWith(o.approvalPrefix)));
  const approved = live.some((c) => c.key === o.approvalKey);
  if (approver && !approved) {
    const asked = openDebtors.some((d) => d.debtor === approver.address && d.topic_keys.includes(o.approvalKey));
    if (!asked) {
      actions.push({
        priority: 2, kind: 'request_approval', to: approver.label, to_address: approver.address, check_id: 'budget_approval',
        action: `Request ${o.approvalAsk} from ${approver.label}`, why: 'No approval recorded', evidence: [],
      });
    }
  }

  // our own decision, or the counterparty confirming the deal is done (a fully executed contract)
  const committed = live.some((c) => c.key === o.decisionKey && (c.speaker === self || /execut|countersign|booked/i.test(String(c.value))));
  const failingParties = new Set(checks.filter((c) => c.status !== 'pass').map((c) => c.party));
  const ready = task.participants.filter((p) => p.role === 'counterparty' && checks.some((c) => c.party === p.address) && !failingParties.has(p.address));
  // an approval still being asked for holds the commitment; one never asked for does not (the hard requirement already caps it)
  const awaitingApproval = !!approver && !approved && openDebtors.some((d) => d.debtor === approver.address);
  if (!committed && ready.length && !contested.length && !awaitingApproval && !checks.some((c) => c.party === null && c.status === 'fail')) {
    const party = ready[0];
    actions.push({
      priority: 1, kind: 'accept_offer', to: party.label, to_address: party.address,
      action: o.commit(party.label),
      why: checks.filter((c) => c.party === party.address).map((c) => c.detail).join('; '), evidence: [],
    });
  }
  return actions;
}
