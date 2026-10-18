// Event-sourced replay: rebuild a task's state from its immutable event log.
//
//  - using the saved proposals (the default) it reproduces exactly what the system believed after
//    any given event ("what did we know when we sent ev_7?")
//  - using a fresh extractor it re-interprets the same evidence (say, after an extractor upgrade)
//    without touching the original events.
// Human decisions are not emails: approvals and phone verifications are event-less transitions. Replay
// re-applies them where they happened (between the emails, in transition order) through the functions the
// live system uses, so the state they changed (claim status, checks) is rebuilt rather than copied.
// Replay always runs in memory; the source can be a task working set from any backend.
import { MemoryBackend } from '../store/memory-backend.ts';
import type { MemoryStore } from '../store/state.ts';
import { Engine, DEFAULT_ORG } from './engine.ts';
import {
  APPROVAL_DECIDED, APPROVAL_EXPIRED, APPROVAL_REQUESTED, HELD_FOR_VERIFICATION, approvalId, recordDecision, recordExpired, requestApproval,
  type ApprovalDecisionDetail, type ApprovalRequestDetail,
} from './approval-log.ts';
import { applyVerifiedClaim, rejectHeldClaim } from '../approvals.ts';
import type { Extractor, Proposal } from '../extract/types.ts';
import type { Claim, EventInput, StoredEvent, TaskSpec, Transition } from '../types.ts';

/** Transitions a human decision adds between emails; replay re-applies these. */
export const HUMAN_DECISIONS = new Set([APPROVAL_REQUESTED, APPROVAL_DECIDED, APPROVAL_EXPIRED, 'claim_verified', 'claim_rejected']);

/**
 * A task's record of human decisions, without the claim and approval ids a replay renumbers, so a replay
 * can be compared with its source. Includes the verification cards the resolver opens while interpreting.
 */
export function decisionLog(store: MemoryStore, taskId: string): [string, string][] {
  return store.transitionsForTask(taskId)
    .filter((t) => HUMAN_DECISIONS.has(t.type) || t.type === HELD_FOR_VERIFICATION)
    .map((t) => [t.type, t.summary.replace(/\bap_\d+\b/g, 'ap_*')]);
}

/** An extractor that hands back whatever proposal was last saved for each event. */
export function savedProposals(src: MemoryStore): Extractor {
  return {
    name: 'replay:saved-proposals',
    async extract(input) {
      const latest = src.extractionsFor(input.event.id).at(-1);
      if (!latest) throw new Error(`no saved proposal for ${input.event.id}`);
      return latest.proposal as Proposal;
    },
  };
}

export async function replayTask(src: MemoryStore, taskId: string, opts: { uptoEventId?: string; extractor?: Extractor; raw?: (e: StoredEvent) => unknown } = {}): Promise<MemoryStore> {
  const task = src.getTask(taskId);
  if (!task) throw new Error(`unknown task ${taskId}`);
  const lastSeq = opts.uptoEventId ? src.getEvent(opts.uptoEventId)?.seq ?? Infinity : Infinity;

  // where each email sits in the task's transition order: its first transition (interpreted, or failed)
  const log = src.transitionsForTask(task.id);
  const placed = new Map<string, number>();
  for (const t of log) if (t.event_id && !placed.has(t.event_id)) placed.set(t.event_id, t.seq);
  // as of an email: only the decisions made before it was interpreted (a still-pending email is the present)
  const cutoff = opts.uptoEventId ? placed.get(opts.uptoEventId) ?? Infinity : Infinity;
  const decisions = log.filter((t) => HUMAN_DECISIONS.has(t.type) && t.seq < cutoff);

  const target = new MemoryBackend();
  const engine = new Engine(target, opts.extractor ?? savedProposals(src));
  await engine.createTask(DEFAULT_ORG, task, src.taskCreatedAt(task.id) ?? new Date(0).toISOString());
  const ids = new IdMap(src, task.id);
  const decideBefore = async (seq: number) => {
    while (decisions.length && decisions[0].seq < seq) await reapply(target, task, decisions.shift()!, ids);
  };

  const artifacts = src.artifactsForTask(task.id);
  const storedText = (eventId: string, filename: string) =>
    artifacts.find((a) => a.event_id === eventId && a.filename === filename)?.text;

  for (const e of src.eventsForTask(task.id)) {
    if (e.seq > lastSeq) break;
    // still pending at the source, so not part of what was believed (unless re-interpreting)
    if (!src.isInterpreted(e.id) && !opts.extractor) continue;
    if (placed.has(e.id)) await decideBefore(placed.get(e.id)!);
    const input: EventInput = {
      ...e,
      raw: opts.raw?.(e) ?? src.getEventRaw(e.id) ?? undefined,
      task_id: task.id,
      link_reason: e.link_reason,
      preserve_seq: e.seq, // keep the original event ids so evidence references stay valid
      attachments: e.attachments.map((m) => ({ ...m, text: m.text ?? storedText(e.id, m.filename) ?? '' })),
    };
    await engine.ingest(DEFAULT_ORG, input);
  }
  await decideBefore(Infinity);
  return target.org(DEFAULT_ORG);
}

/**
 * Events keep their ids in a replay; claims and transitions (so approvals, "ap_<seq>") are renumbered.
 * A claim is found again by what it is (source email, speaker, term, value), an approval by what opened it.
 */
class IdMap {
  /** source approval id → replayed approval id, for the cards replay requested again */
  requested = new Map<string, string>();
  #src: MemoryStore;
  #taskId: string;
  constructor(src: MemoryStore, taskId: string) {
    this.#src = src;
    this.#taskId = taskId;
  }

  claim(store: MemoryStore, srcId: string): string | null {
    const c = this.#src.getClaim(srcId);
    if (!c) return null;
    const same = (x: Claim) => x.source_event_id === c.source_event_id && x.speaker === c.speaker && x.key === c.key && x.display === c.display;
    const nth = this.#src.claimsForTask(this.#taskId).filter(same).findIndex((x) => x.id === c.id);
    return store.claimsForTask(this.#taskId).filter(same)[nth]?.id ?? null;
  }

  approval(store: MemoryStore, srcId: string): string | null {
    if (this.requested.has(srcId)) return this.requested.get(srcId)!;
    // a verification card is opened by the resolver while it interprets the email, so it replays with the email
    const opener = this.#src.transitionsForTask(this.#taskId).find((t) => approvalId(t.seq) === srcId);
    if (opener?.type !== HELD_FOR_VERIFICATION || !opener.subject_id) return null;
    const claimId = this.claim(store, opener.subject_id);
    const held = store.transitionsForTask(this.#taskId).find((t) => t.type === HELD_FOR_VERIFICATION && t.subject_id === claimId);
    return held ? approvalId(held.seq) : null;
  }
}

/** Re-apply one recorded decision through the live code path (one commit per transition). */
async function reapply(backend: MemoryBackend, task: TaskSpec, t: Transition, ids: IdMap): Promise<void> {
  const snap = await backend.loadTask(DEFAULT_ORG, task.id);
  const committed = await backend.commit(snap, (w) => {
    switch (t.type) {
      case 'claim_verified':
      case 'claim_rejected': {
        // a re-interpretation may no longer hold this detail for verification: then there is nothing to decide
        const claimId = ids.claim(w, t.subject_id ?? '');
        if (!claimId || w.getClaim(claimId)?.status !== 'proposed') return;
        const decide = t.type === 'claim_verified' ? applyVerifiedClaim : rejectHeldClaim;
        decide(w, task, claimId, String(t.detail.by ?? ''), t.at);
        return;
      }
      case APPROVAL_REQUESTED: {
        // the fingerprint is taken again, from the replayed state the card was made on; the deadline is kept
        const { fingerprint: _fp, ...d } = t.detail as unknown as ApprovalRequestDetail;
        const claimId = d.claim_id ? ids.claim(w, d.claim_id) : null;
        const replaces = d.replaces ? { replaces: ids.approval(w, d.replaces) } : {};
        ids.requested.set(approvalId(t.seq), requestApproval(w, task.id, t.at, { ...d, claim_id: claimId, ...replaces }));
        return;
      }
      case APPROVAL_EXPIRED:
        recordExpired(w, task.id, t.at); // every card past its deadline at that moment, as the source recorded
        return;
      case APPROVAL_DECIDED: {
        const d = t.detail as unknown as ApprovalDecisionDetail;
        const id = ids.approval(w, d.approval_id);
        if (!id) return;
        const newer = d.new_approval_id ? { new_approval_id: ids.approval(w, d.new_approval_id) } : {};
        const summary = t.summary.replace(/\bap_\d+\b/g, (x) => ids.approval(w, x) ?? x);
        recordDecision(w, task.id, t.at, { ...d, approval_id: id, ...newer }, summary);
      }
    }
  });
  if (!committed.ok) throw new Error(`replay: could not re-apply ${t.type} (seq ${t.seq}): ${committed.reason}`);
}
