// Resolver: turns (event, proposal) into deterministic state changes.
//
// The extractor reads language; this module is the only thing that writes task state. Each rule
// below is explicit, and every change it makes lands in the `transitions` log tied to its event.
//
// Rules in brief
//  - When a party revises one of its *own* terms, the newer claim supersedes the older one
//    (provided the new evidence is actually newer).
//  - When two different parties disagree on a term, both claims become "contested"; neither wins.
//  - Hedged, low-confidence, or non-authoritative claims are kept as "proposed" and change nothing.
//  - Evidence older than the current claim is recorded but never overwrites it.
//  - Withdrawing an offer keeps its history but retracts its terms (so checks fail).
//  - A compound question becomes one obligation per issue; each closes only when its debtor
//    actually answers that issue's term.
//  - A promise to deliver a quantity closes only on delivered quantities (partials are explicit);
//    a promise to send a document closes only when a *matching* document arrives.
//  - Conditional promises ("pay on invoice") are tracked but not due until the condition is met.
//  - Whether an artifact is current is derived per term from the claims it supports.
//  - Conflicts are recomputed from active claims by pure domain checks; nothing is remembered.
import type { StateStore } from '../store/state.ts';
import type { Artifact, ArtifactMatch, Claim, Obligation, ObligationCondition, Participant, StoredEvent, TaskSpec } from '../types.ts';
import { isOpenStatus } from '../types.ts';
import type { Proposal } from '../extract/types.ts';
import { domainFor, sameValue, termKeys, termOf, type DomainPack } from '../domain/pack.ts';
import '../domain/index.ts';
import { findDates } from '../extract/dates.ts';

export const MIN_CONFIDENCE = 0.6;

/** Deadline phrases ("by tomorrow", "before Oct 22") yield a date; a bare date mention is not a deadline. */
export function dueFromText(text: string, refIso: string): string | null {
  const phrase = text.match(/\b(?:by|before|no later than|until|within)\s+(.{1,40})/i);
  if (!phrase) return null;
  const first = findDates(phrase[1], refIso)[0];
  return first?.iso ?? null;
}

/** Wording that makes a promise wait for some later event. */
const CONDITIONAL = /\b(?:on|upon|after|once|when|following)\b[^.]{0,30}\b(invoice|invoic|deliver|receipt|receiv|arriv|shipment|ship|approv)\w*/i;

export function conditionOf(text: string): ObligationCondition | null {
  const hit = text.match(CONDITIONAL);
  if (!hit) return null;
  const waitsForInvoice = /^invoic/i.test(hit[1]);
  return {
    text: hit[0],
    kind: waitsForInvoice ? 'artifact' : 'other',
    artifact_kind: waitsForInvoice ? 'invoice' : null,
  };
}

export function partyOf(task: TaskSpec, address: string): Participant | null {
  const wanted = address.toLowerCase();
  return task.participants.find((p) => p.address.toLowerCase() === wanted) ?? null;
}

export function labelOf(task: TaskSpec, address: string): string {
  return partyOf(task, address)?.label ?? address;
}

function groupOf(task: TaskSpec, address: string): string {
  return partyOf(task, address)?.group ?? address.toLowerCase();
}

export const isOpen = (o: Obligation) => isOpenStatus(o.status);

/** Primitive's sender analysis (or, failing that, DMARC) vouches for the From address. */
export const senderAuthenticated = (event: Pick<StoredEvent, 'auth_verdict'>) => event.auth_verdict === 'authenticated' || event.auth_verdict === 'pass';

/** Overlap of significant words (longer than two chars), relative to the smaller text. */
function wordOverlap(a: string, b: string): number {
  const words = (s: string) => new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2),
  );
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const w of left) if (right.has(w)) shared++;
  return shared / Math.min(left.size, right.size);
}

/** The issues a question/request really puts to its debtor: topics inside the debtor's authority,
 *  with a quantity folded into the schedule when both are asked ("can you deliver all 500 by Friday?"). */
export function issuesFor(pack: DomainPack, task: TaskSpec, debtor: string, topics: string[]): string[] {
  let keys = [...new Set(topics)];
  const party = partyOf(task, debtor);
  const inAuthority = party ? keys.filter((k) => party.authority.some((prefix) => k.startsWith(prefix))) : [];
  if (inAuthority.length) keys = inAuthority;
  const asksSchedule = keys.some((k) => termOf(pack, k)?.type === 'schedule');
  if (asksSchedule) keys = keys.filter((k) => !(termOf(pack, k)?.type === 'number' && /quantity/.test(k)));
  return keys.filter((k) => !termOf(pack, k)?.lifecycle);
}

/** Does a received document satisfy a promise to send one? Matching kind is necessary, not sufficient. */
export function artifactMatches(o: Pick<Obligation, 'expects_artifact' | 'artifact_match'>, a: Artifact): { ok: boolean; why: string } {
  if (a.kind !== o.expects_artifact) return { ok: false, why: `${a.filename} is a ${a.kind}, not a ${o.expects_artifact}` };
  const spec = o.artifact_match;
  if (!spec) return { ok: true, why: `${a.filename} received` };
  if (spec.exclude_sha256.includes(a.sha256)) return { ok: false, why: `${a.filename} is a copy of a ${a.kind} we already had` };
  const searchable = `${a.filename}\n${a.text.slice(0, 3000)}`;
  if (spec.reference && !searchable.toLowerCase().includes(spec.reference.toLowerCase())) {
    return { ok: false, why: `${a.filename} does not reference ${spec.reference}` };
  }
  if (spec.revision && !a.version_label && !/\b(revis\w*|updated|amended|corrected|rev\.?\s*\d+)\b/i.test(searchable)) {
    return { ok: false, why: `${a.filename} is not marked as a revision` };
  }
  return { ok: true, why: `${a.filename} received` };
}

export interface ApplyInput {
  store: StateStore;
  task: TaskSpec;
  event: StoredEvent;
  proposal: Proposal;
  extractor: string;
  artifacts: Artifact[]; // artifacts created from this event's attachments
}

export function applyProposal(inp: ApplyInput) {
  const { store, task, event, proposal, extractor } = inp;
  const pack = domainFor(task);
  const vocabulary = termKeys(pack);
  const at = event.received_at;
  const log = (type: string, summary: string, subject_id: string | null = null, detail: Record<string, unknown> = {}) =>
    store.addTransition({ task_id: task.id, event_id: event.id, at, type, subject_id, summary, detail });
  const speaker = event.from.toLowerCase();
  const who = labelOf(task, speaker);
  const whoParty = partyOf(task, speaker);
  const nameOf = (address: string) => labelOf(task, address);

  // ---- 0. instruction-like content is quarantined as data
  for (const flag of proposal.injection_flags) {
    store.addFlag(task.id, event.id, 'prompt_injection_suspected', flag.evidence, at);
    log('injection_quarantined', `Instruction-like text from ${who} quarantined (treated as data, not state)`, null, { evidence: flag.evidence });
  }

  // ---- 1. artifacts: a newer doc of the same kind from the same owner replaces the older one
  for (const incoming of inp.artifacts) {
    log('artifact_added', `${who} sent ${incoming.filename} (${incoming.kind}${incoming.version_label ? ` ${incoming.version_label}` : ''})`, incoming.id);
    for (const earlier of store.artifactsForTask(task.id)) {
      if (earlier.id === incoming.id) continue;
      if (earlier.kind !== incoming.kind || earlier.owner !== incoming.owner) continue;
      if (earlier.status === 'superseded') continue;
      if (earlier.sha256 === incoming.sha256) continue;
      if (incoming.kind === 'document') continue; // generic documents never supersede; only versioned business docs do
      if (earlier.event_id === incoming.event_id) continue; // documents sent together are a set, not versions
      if (pack.documents?.find((d) => d.kind === incoming.kind)?.multipart) continue;
      store.updateArtifact(earlier.id, 'superseded', incoming.id);
      log('artifact_superseded', `${earlier.filename} superseded by ${incoming.filename}`, earlier.id, { by: incoming.id });
    }
  }
  const artifactNamed = new Map(inp.artifacts.map((a) => [a.filename, a]));

  // ---- 2. claims
  const answeredKeys = new Set<string>(); // keys this message actually answered with a claim (used for answer linking)
  const liveClaims = () => store.claimsForTask(task.id).filter((c) => c.status === 'active' || c.status === 'contested');
  // body claims go first, so a correction in the body beats a stale attachment in the same message
  const claimsInOrder = [...proposal.claims].sort((a, b) => Number(!!a.from_attachment) - Number(!!b.from_attachment));
  const lifecycleKeys = new Set(pack.terms.filter((t) => t.lifecycle).map((t) => t.key));
  let speakerMadeOffer = false;

  for (const pc of claimsInOrder) {
    if (!vocabulary.has(pc.key)) continue;

    let value = pack.normalizeValue(pc.key, pc.value);
    if (value !== null && pc.partial && pack.mergePartial) {
      const existing = liveClaims().find((c) => c.key === pc.key && c.speaker === speaker);
      const merged = existing ? pack.mergePartial(pc.key, existing.value, value) : null;
      if (merged === null) {
        store.addFlag(task.id, event.id, 'unreconciled_partial_update', `partial ${pc.key} update ${JSON.stringify(value)} could not be matched to the current value`, at);
        pc.confidence = Math.min(pc.confidence, 0.4);
      } else {
        value = merged;
      }
    }
    if (value === null) {
      store.addFlag(task.id, event.id, 'invalid_extraction', `${pc.key}=${JSON.stringify(pc.value)}`, at);
      continue;
    }

    const artifact = pc.from_attachment ? artifactNamed.get(pc.from_attachment) ?? null : null;
    const artifactId = artifact?.id ?? null;
    const display = pack.displayValue(pc.key, value);
    const base = {
      task_id: task.id, key: pc.key, value, display, kind: pc.kind, speaker, source_event_id: event.id,
      source_artifact_id: artifactId, evidence: pc.evidence, superseded_by: null, supersede_reason: null,
      learned_at: at, confidence: pc.confidence, extractor,
    };
    const attachEvidence = (claimId: string) => store.addClaimEvidence(claimId, event.id, artifactId, pc.evidence);
    const isLifecycle = lifecycleKeys.has(pc.key);

    let authoritative = false;
    if (whoParty) {
      // our own decisions count, except on a term an internal approver decides (a ceiling we quote is not
      // finance's approval); a counterparty deciding the same deal from its side does not take ours away
      if (whoParty.role === 'self') {
        authoritative = pc.kind === 'decision'
          && !task.participants.some((p) => p.role === 'internal' && p.authority.some((prefix) => pc.key.startsWith(prefix)));
      }
      else if (isLifecycle) authoritative = whoParty.role === 'counterparty'; // any counterparty may withdraw its own offer
      else authoritative = whoParty.authority.some((prefix) => pc.key.startsWith(prefix));
    }
    // payment and bank details count only from a participant whose mail passed sender authentication
    const unverified = authoritative && event.direction === 'inbound' && !senderAuthenticated(event)
      && !!pack.verifiedSenderOnly?.some((prefix) => pc.key.startsWith(prefix));
    if (unverified) authoritative = false;

    // 2a. tentative: hedged, low confidence, or not this speaker's term to set
    if (pc.hedged || pc.confidence < MIN_CONFIDENCE || !authoritative) {
      let reason: string;
      if (unverified) reason = `${pc.key} changes need an authenticated sender (${event.auth_verdict ?? 'no authentication result'})`;
      else if (!authoritative) reason = `${who} is not authoritative for ${pc.key}`;
      else if (pc.hedged) reason = 'hedged language';
      else reason = `low confidence (${pc.confidence})`;
      const tentative = store.insertClaim({ ...base, status: 'proposed', supersede_reason: reason });
      attachEvidence(tentative.id);
      log('claim_tentative', `Tentative: ${who} ${pc.key} = ${display} (${reason}; not applied)`, tentative.id);
      continue;
    }

    // 2a'. offer lifecycle: a withdrawal retracts the speaker's offer terms (their history stays)
    if (isLifecycle) {
      const repeat = liveClaims().find((c) => c.key === pc.key && c.speaker === speaker && sameValue(c.value, value));
      if (repeat) {
        attachEvidence(repeat.id);
        answeredKeys.add(pc.key);
        continue;
      }
      const withdrawal = store.insertClaim({ ...base, status: 'active' });
      attachEvidence(withdrawal.id);
      const retracted: string[] = [];
      const withdrawable = (key: string) => !pack.withdrawable || pack.withdrawable.some((prefix) => key.startsWith(prefix));
      const offerTerms = liveClaims().filter((x) => x.speaker === speaker && x.kind === 'offer' && !lifecycleKeys.has(x.key) && withdrawable(x.key));
      for (const term of offerTerms) {
        store.updateClaim(term.id, { status: 'retracted', supersede_reason: `offer withdrawn by ${who} in ${event.id}` });
        retracted.push(`${term.key} (${term.display})`);
      }
      const promises = store.obligationsForTask(task.id).filter((x) => isOpen(x) && x.debtor === speaker && x.kind === 'commitment');
      for (const ob of promises) {
        store.updateObligation(ob.id, { status: 'cancelled', resolved_by_event_id: event.id, resolved_at: at, resolution_note: `${who} withdrew its offer` });
        log('obligation_resolved', `${who}'s commitment "${ob.text}" → cancelled (offer withdrawn)`, ob.id, { status: 'cancelled' });
      }
      const lost = retracted.length ? `: ${retracted.join(', ')} no longer available` : '';
      log('offer_withdrawn', `${who} withdrew its offer${lost} (history kept)`, withdrawal.id, { retracted });
      answeredKeys.add(pc.key);
      continue;
    }

    if (pc.kind === 'offer') speakerMadeOffer = true;

    const onKey = liveClaims().filter((c) => c.key === pc.key);
    const own = onKey.filter((c) => c.speaker === speaker);
    const peers = onKey.filter((c) => c.speaker !== speaker && groupOf(task, c.speaker) === groupOf(task, speaker));

    if (pc.mode === 'retraction') {
      for (const old of own) {
        store.updateClaim(old.id, { status: 'retracted', supersede_reason: `retracted by ${who} in ${event.id}` });
        log('claim_retracted', `${who} withdrew ${pc.key} (${old.display})`, old.id);
      }
      answeredKeys.add(pc.key);
      continue;
    }

    // 2b. same speaker: corroborate, supersede, or set aside late evidence
    const identical = own.find((c) => sameValue(c.value, value));
    if (identical) {
      attachEvidence(identical.id);
      log('claim_corroborated', `${who} ${pc.key} = ${display} also supported by ${artifact ? artifact.filename : event.id}`, identical.id);
      answeredKeys.add(pc.key);
      continue;
    }
    if (own.length) {
      const latest = own[own.length - 1];
      const latestEvent = store.getEvent(latest.source_event_id)!;
      if (event.occurred_at < latestEvent.occurred_at) {
        const late = store.insertClaim({ ...base, status: 'superseded', superseded_by: latest.id, supersede_reason: `older than current claim ${latest.id} (evidence arrived late)` });
        attachEvidence(late.id);
        log('stale_evidence', `Older ${pc.key} from ${who} (${display}) arrived late; current value ${latest.display} kept`, late.id);
        continue;
      }
      // a live dispute inside the group is not settled by one side restating a new value
      const disputing = peers.filter((c) => c.status === 'contested' && !sameValue(c.value, value));
      const revised = store.insertClaim({ ...base, status: disputing.length ? 'contested' : 'active' });
      attachEvidence(revised.id);
      const why = pc.mode === 'correction' ? `explicit correction by ${who}` : `revised by ${who}`;
      for (const old of own) {
        store.updateClaim(old.id, { status: 'superseded', superseded_by: revised.id, supersede_reason: `${why} in ${event.id}` });
      }
      log('claim_superseded', `${who} changed ${pc.key}: ${latest.display} → ${display} (${why})`, revised.id,
        { from: latest.id, to: revised.id, from_display: latest.display, to_display: display, mode: pc.mode });
      answeredKeys.add(pc.key);
      continue;
    }

    // 2c. another party in the same group says something different: keep both, contested
    const conflicting = peers.filter((c) => !sameValue(c.value, value));
    const added = store.insertClaim({ ...base, status: conflicting.length ? 'contested' : 'active' });
    attachEvidence(added.id);
    answeredKeys.add(pc.key);
    if (conflicting.length) {
      for (const other of conflicting) {
        store.updateClaim(other.id, { status: 'contested', supersede_reason: `contradicted by ${who} (${added.id})` });
      }
      const theirs = conflicting.map((d) => `${nameOf(d.speaker)} says ${d.display}`).join('; ');
      log('claim_contested', `Conflicting ${pc.key}: ${theirs} vs ${who} says ${display} — unresolved`, added.id,
        { claims: [...conflicting.map((d) => d.id), added.id] });
    } else {
      const agreeing = peers.find((d) => sameValue(d.value, value));
      log('claim_added', `${who}: ${pc.key} = ${display}${artifact ? ` (from ${artifact.filename})` : ''}`, added.id,
        { key: pc.key, corroborates: agreeing?.id ?? null });
    }
  }

  // a fresh offer after a withdrawal makes the speaker available again (the withdrawal stays in history)
  if (speakerMadeOffer) {
    const priorWithdrawals = liveClaims().filter((c) => c.speaker === speaker && lifecycleKeys.has(c.key) && c.source_event_id !== event.id);
    for (const w of priorWithdrawals) {
      store.updateClaim(w.id, { status: 'superseded', supersede_reason: `new offer from ${who} in ${event.id}` });
      log('offer_reinstated', `${who} made a new offer after withdrawing (${w.source_event_id}); only the new terms are current`, w.id);
    }
  }

  // ---- 3. obligations this message opens
  const recipient = (event.to[0] ?? '').toLowerCase();
  const openNow = () => store.obligationsForTask(task.id).filter(isOpen);
  const openedHere = new Set<string>();

  for (const po of proposal.obligations) {
    if (po.confidence < MIN_CONFIDENCE) continue;
    const senderOwes = po.debtor === 'sender';
    const debtor = senderOwes ? speaker : recipient;
    const creditor = senderOwes ? recipient : speaker;
    if (!debtor) continue;
    // someone outside the task cannot put us on the hook (a spoofer's "reply to confirm" is not owed)
    if (!senderOwes && !whoParty) continue;
    const topics = po.topic_keys.filter((k) => vocabulary.has(k));
    // a compound question becomes one obligation per issue, each closable independently
    const issues = po.kind !== 'commitment' && !po.expects_artifact ? issuesFor(pack, task, debtor, topics) : [];
    const pieces: { issue: string | null; keys: string[] }[] = issues.length > 1
      ? issues.map((k) => ({ issue: k, keys: [k] }))
      : [{ issue: null, keys: issues.length === 1 ? issues : topics }];
    let groupId: string | null = null;

    for (const piece of pieces) {
      const duplicate = openNow().find((o) =>
        o.debtor === debtor && o.kind === po.kind && (o.issue_key ?? null) === piece.issue && wordOverlap(o.text, po.text) >= 0.6);
      if (duplicate) {
        store.updateObligation(duplicate.id, { notes: [...duplicate.notes, `reiterated in ${event.id}`] });
        log('obligation_reiterated', `${nameOf(creditor)} reiterated: ${duplicate.text}${piece.issue ? ` [${piece.issue}]` : ''}`, duplicate.id);
        continue;
      }

      const condition = po.kind === 'commitment' ? conditionOf(po.text) : null;
      const expects = po.expects_artifact;
      let match: ArtifactMatch | null = null;
      if (expects) {
        match = {
          revision: /\b(revised|updated|new|corrected|amended|revision)\b/i.test(po.text),
          reference: po.text.match(/\b[A-Z]{1,5}-\d{2,}\b/)?.[0] ?? null,
          exclude_sha256: store.artifactsForTask(task.id).filter((a) => a.owner === debtor && a.kind === expects).map((a) => a.sha256),
        };
      }
      const quantity = po.kind === 'commitment' && pack.quantityOf ? pack.quantityOf(po.text) : null;
      // a question's "by Friday" is about its subject matter, not a deadline for replying
      let dueAt: string | null = null;
      if (po.kind !== 'question') {
        dueAt = po.due
          ?? dueFromText(po.text, event.occurred_at)
          ?? (po.kind === 'commitment' && pack.dueOf ? pack.dueOf(po.text, event.occurred_at) : null);
      }
      const ob = store.insertObligation({
        task_id: task.id, kind: po.kind, debtor, creditor, text: po.text, topic_keys: piece.keys,
        expects_artifact: expects, status: 'open', source_event_id: event.id, evidence: po.evidence, resolved_by_event_id: null,
        resolution_note: null, created_at: at, resolved_at: null, confidence: po.confidence, notes: [],
        due_at: dueAt,
        issue_key: piece.issue, group_id: groupId, quantity, fulfilled_quantity: quantity != null ? 0 : null,
        artifact_match: match, condition, condition_met_at: null,
      });
      if (piece.issue && !groupId) {
        groupId = ob.id;
        store.updateObligation(ob.id, { group_id: ob.id });
      }
      openedHere.add(ob.id);

      const isCommitment = po.kind === 'commitment';
      const verb = isCommitment ? 'committed to' : po.kind === 'question' ? 'asked' : 'requested';
      const actor = isCommitment ? nameOf(debtor) : nameOf(creditor);
      const target = isCommitment ? '' : ` ${nameOf(debtor)}`;
      const issueNote = piece.issue ? ` [issue: ${piece.issue}]` : '';
      const whenNote = condition ? ` (when: ${condition.text})` : '';
      log('obligation_opened', `${actor} ${verb}${target}: ${po.text}${issueNote}${whenNote}`, ob.id,
        { kind: po.kind, debtor, creditor, issue: piece.issue, group: groupId });
    }
  }

  // ---- 4. resolutions
  const close = (o: Obligation, status: Obligation['status'], note: string) => {
    store.updateObligation(o.id, { status, resolved_by_event_id: event.id, resolution_note: note, resolved_at: at });
    const owner = o.kind === 'commitment' ? `${nameOf(o.debtor)}'s commitment` : `${nameOf(o.creditor)}'s ${o.kind}`;
    log('obligation_resolved', `${owner} "${o.text}"${o.issue_key ? ` [${o.issue_key}]` : ''} → ${status} (${note})`, o.id,
      { status, issue: o.issue_key ?? null });
  };
  const findMatchingArtifact = (o: Obligation): { artifact: Artifact | null; why: string | null } => {
    let lastMiss: string | null = null;
    for (const a of inp.artifacts) {
      const verdict = artifactMatches(o, a);
      if (verdict.ok) return { artifact: a, why: verdict.why };
      if (a.kind === o.expects_artifact) lastMiss = verdict.why;
    }
    return { artifact: null, why: lastMiss };
  };
  const doneStatus = (o: Obligation): Obligation['status'] => (o.kind === 'commitment' ? 'fulfilled' : 'answered');

  // 4a. conditions: "pay on invoice" becomes due once the creditor's invoice arrives
  for (const o of openNow()) {
    if (!o.condition || o.condition_met_at || o.condition.kind !== 'artifact') continue;
    const wantedKind = o.condition.artifact_kind;
    const trigger = inp.artifacts.find((x) => x.kind === wantedKind && x.owner.toLowerCase() === o.creditor);
    if (!trigger) continue;
    store.updateObligation(o.id, { condition_met_at: at, notes: [...o.notes, `${event.id}: condition met (${trigger.filename})`] });
    log('obligation_condition_met', `Condition met for ${nameOf(o.debtor)}'s commitment "${o.text}": ${trigger.filename} received — now due`, o.id);
  }

  // 4b. delivered quantities: partial or full fulfilment of quantity-bearing commitments
  for (const f of proposal.fulfillments ?? []) {
    if (f.confidence < MIN_CONFIDENCE || !f.quantity || f.quantity <= 0) continue;
    const named = f.obligation_id ? store.getObligation(f.obligation_id) : null;
    const namedUsable = named && named.task_id === task.id && isOpen(named) && named.debtor === speaker && named.quantity != null ? named : null;
    const target = namedUsable ?? openNow().find((o) =>
      o.kind === 'commitment' && o.debtor === speaker && o.quantity != null && !openedHere.has(o.id)
      && (!f.term_key || o.topic_keys.includes(f.term_key) || !o.topic_keys.length));
    if (!target) {
      log('delivery_reported', `${who} reports ${f.quantity} delivered (no matching open commitment)`, null, { quantity: f.quantity, evidence: f.evidence });
      continue;
    }
    const total = target.quantity!;
    const delivered = Math.min(total, (target.fulfilled_quantity ?? 0) + f.quantity);
    const remaining = total - delivered;
    if (remaining <= 0) {
      store.updateObligation(target.id, { fulfilled_quantity: delivered });
      close({ ...target, fulfilled_quantity: delivered }, 'fulfilled', `${delivered} of ${target.quantity} delivered`);
      continue;
    }
    store.updateObligation(target.id, {
      status: 'partially_fulfilled', fulfilled_quantity: delivered,
      notes: [...target.notes, `${event.id}: ${f.quantity} delivered (${delivered}/${target.quantity}); ${remaining} outstanding`],
    });
    log('obligation_partially_fulfilled', `${who} delivered ${delivered} of ${target.quantity} ("${target.text}"); ${remaining} still outstanding${target.due_at ? ` (was due ${target.due_at})` : ''}`, target.id,
      { fulfilled: delivered, outstanding: remaining, due_at: target.due_at });
  }

  // 4c. questions/requests close on claims about their issue; document promises on a matching document
  for (const o of openNow()) {
    if (openedHere.has(o.id)) continue;
    if (o.debtor !== speaker) continue;
    if (o.expects_artifact && o.quantity != null) {
      // "I'll send all 3 BEOs": each matching document counts toward the promise
      const matching = inp.artifacts.filter((a) => artifactMatches(o, a).ok).length;
      if (!matching) continue;
      const delivered = Math.min(o.quantity, (o.fulfilled_quantity ?? 0) + matching);
      if (delivered >= o.quantity) {
        store.updateObligation(o.id, { fulfilled_quantity: delivered });
        close({ ...o, fulfilled_quantity: delivered }, doneStatus(o), `${delivered} of ${o.quantity} ${o.expects_artifact} documents received`);
      } else {
        store.updateObligation(o.id, {
          status: 'partially_fulfilled', fulfilled_quantity: delivered,
          notes: [...o.notes, `${event.id}: ${matching} ${o.expects_artifact} received (${delivered}/${o.quantity}); ${o.quantity - delivered} outstanding`],
        });
        log('obligation_partially_fulfilled', `${who} sent ${delivered} of ${o.quantity} ${o.expects_artifact} documents ("${o.text}"); ${o.quantity - delivered} still outstanding`, o.id,
          { fulfilled: delivered, outstanding: o.quantity - delivered });
      }
      continue;
    }
    if (o.expects_artifact) {
      const found = findMatchingArtifact(o);
      if (found.artifact) {
        close(o, doneStatus(o), found.why!);
      } else if (found.why) {
        store.updateObligation(o.id, { notes: [...o.notes, `${event.id}: ${found.why} — still open`] });
        log('obligation_unverified', `${nameOf(o.debtor)} sent a ${o.expects_artifact}, but it does not fulfil "${o.text}" (${found.why}) — kept open`, o.id);
      }
      continue; // words alone never deliver a promised document
    }
    if (o.quantity != null) continue; // quantity promises close on deliveries, not on talk about them
    const covered = o.topic_keys.filter((k) => answeredKeys.has(k));
    if (covered.length && covered.length === o.topic_keys.length) {
      close(o, doneStatus(o), `${who} addressed ${covered.join(', ')}`);
    }
  }

  for (const r of proposal.resolutions) {
    const o = store.getObligation(r.obligation_id);
    if (!o || o.task_id !== task.id || !isOpen(o) || r.confidence < 0.7) continue;
    if (r.resolution === 'cancelled' && o.creditor === speaker) {
      close(o, 'cancelled', `creditor withdrew: "${r.evidence}"`);
      continue;
    }
    if (o.debtor !== speaker) continue;
    if (r.resolution === 'declined') {
      close(o, 'declined', `"${r.evidence}"`);
      continue;
    }
    if (o.expects_artifact && !findMatchingArtifact(o).artifact) {
      store.updateObligation(o.id, { notes: [...o.notes, `${event.id}: debtor says done but no ${o.expects_artifact} attached — still open`] });
      log('obligation_unverified', `${nameOf(o.debtor)} claims "${o.text}" is done, but no matching ${o.expects_artifact} arrived — kept open`, o.id);
      continue;
    }
    if (o.quantity != null && r.resolution === 'fulfilled' && (o.fulfilled_quantity ?? 0) < o.quantity) {
      store.updateObligation(o.id, { notes: [...o.notes, `${event.id}: debtor says done; delivered quantity not evidenced — still open`] });
      continue;
    }
    close(o, doneStatus(o), `"${r.evidence.slice(0, 120)}"`);
  }

  // ---- 5. derived state: artifact currency and constraint checks
  refreshDerived(store, task, event.id, at);
}

export function refreshDerived(store: StateStore, task: TaskSpec, eventId: string | null, at: string) {
  const pack = domainFor(task);
  const lifecycleKeys = new Set(pack.terms.filter((t) => t.lifecycle).map((t) => t.key));
  const log = (type: string, summary: string, subject_id: string | null, detail: Record<string, unknown> = {}) =>
    store.addTransition({ task_id: task.id, event_id: eventId, at, type, subject_id, summary, detail });
  const claims = store.claimsForTask(task.id);
  // parties with an active withdrawal on record
  const withdrawn = new Set(claims.filter((c) => c.status === 'active' && lifecycleKeys.has(c.key)).map((c) => c.speaker));

  for (const a of store.artifactsForTask(task.id)) {
    const backing = store.claimsSupportedByArtifact(a.id);
    // a term is stale on the document only while its current value differs (a value that came back is current again)
    const currentAgain = (c: Claim) => claims.some((x) => x.status === 'active' && x.key === c.key && x.speaker === c.speaker && sameValue(x.value, c.value));
    const outdated = backing.filter((c) => (c.status === 'superseded' && !currentAgain(c)) || c.status === 'retracted');
    let status: Artifact['status'];
    if (a.superseded_by) status = 'superseded';
    // withdrawn: its owner withdrew and nothing it states is still live (an invoice outlives a withdrawn discount offer)
    else if (withdrawn.has(a.owner.toLowerCase()) && !backing.some((c) => c.kind === 'offer' && (c.status === 'active' || c.status === 'contested'))) status = 'withdrawn';
    else if (outdated.length) status = 'partially_stale';
    else status = 'current';
    if (status === a.status) continue;
    store.updateArtifact(a.id, status, a.superseded_by);
    if (status === 'partially_stale') {
      const which = outdated.map((c) => `${c.key} (${c.display}) superseded`).join(', ');
      log('artifact_status', `${a.filename} is now partially stale: ${which}; other terms still current`, a.id, { stale: outdated.map((c) => c.id) });
    } else {
      log('artifact_status', `${a.filename} → ${status}`, a.id);
    }
  }

  const active = claims.filter((c) => c.status === 'active');
  const results = pack.runChecks(task, active);
  const previous = new Map(store.getChecks(task.id).map((c) => [c.id, c]));
  for (const check of results) {
    const before = previous.get(check.id);
    if (before?.status === check.status && before.detail === check.detail) continue;
    if (check.status === 'fail') {
      log('conflict_detected', `Conflict: ${check.label} — ${check.detail}`, check.id, { check });
    } else if (before?.status === 'fail' && check.status === 'pass') {
      log('conflict_resolved', `Resolved: ${check.label} — ${check.detail}`, check.id, { check });
    } else if (check.status === 'pass' && before?.status !== 'pass') {
      log('check_passed', `${check.label}: ${check.detail}`, check.id, { check });
    }
  }
  if (JSON.stringify(results) !== JSON.stringify(store.getChecks(task.id))) store.setChecks(task.id, results);
}

export type { Claim };
