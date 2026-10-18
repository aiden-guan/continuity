// The ingestion pipeline.
//
//   receive:   dedupe → link the message to a task → store the immutable event (plus attachment
//              bytes) → queue its interpretation. A single short transaction: the event is durable
//              before anything interprets it, so a crash can never drop mail.
//   interpret: (worker, driven by jobs) load the task's working set → fetch attachments → extract
//              (LLM or rules, with no transaction open) → commit atomically: re-check the state
//              version, run the deterministic resolver, derive checks, complete the job. If the
//              snapshot went stale it is reloaded and the event re-interpreted.
//   deadline:  scheduled jobs that turn a passed due date into an `obligation_overdue` transition,
//              so overdue work wakes agents even when no new mail arrives.
import { createHash, randomUUID } from 'node:crypto';
import type { Backend, JobInput, JobRow, ReceiveResult, TaskSnapshot } from '../store/backend.ts';
import { backoffMs } from '../store/backend.ts';
import type { MemoryStore } from '../store/state.ts';
import type { Artifact, EventInput, Participant, StoredEvent, TaskSpec } from '../types.ts';
import type { ExtractInput, Extractor, Proposal } from '../extract/types.ts';
import { heuristicExtractor, classifyArtifact } from '../extract/heuristic.ts';
import { attachmentText } from '../ingest/attachments.ts';
import { resolveTask } from '../ingest/link.ts';
import { applyProposal, isOpen, labelOf, partyOf, refreshDerived } from './resolver.ts';
import { domainFor } from '../domain/pack.ts';
import { canonicalIso, nowIso } from '../clock.ts';
import { authenticatedEnough, parseSenderAuth, senderAuthPolicyOf } from '../ingest/sender-auth.ts';
import { Breaker, isTransient, limiter, withDeadline } from './limit.ts';

export type AttachmentFetcher = (event: StoredEvent, partIndex: number, signal?: AbortSignal) => Promise<Buffer | null>;

export interface IngestResult {
  event: StoredEvent;
  duplicate: boolean;
  linked: boolean;
  extractor?: string;
}

export interface EngineOptions {
  workerId?: string;
  leaseMs?: number;
  /** times a stale snapshot is reloaded and re-interpreted before the job is retried later */
  maxStaleRetries?: number;
  /** wait for inline processing (ingest/send) before giving up and leaving it to the worker */
  inlineTimeoutMs?: number;
  /** overall deadline for one extraction, retries included (CONTINUITY_EXTRACT_DEADLINE_MS, default 150 s) */
  extractDeadlineMs?: number;
  /** extractions running at once in this process (CONTINUITY_EXTRACT_CONCURRENCY, default 4) */
  extractConcurrency?: number;
  /** per attachment download (CONTINUITY_ATTACHMENT_TIMEOUT_MS, default 30 s) */
  attachmentTimeoutMs?: number;
  breaker?: Breaker;
}

const envNum = (key: string, fallback: number) => (process.env[key] ? Number(process.env[key]) : fallback);

type Listener = (org: string, taskId: string) => void;

/** One attachment's text plus the metadata needed to store it as an artifact. */
type AttachmentText = { filename: string; content_type: string; text: string; sha256: string; size: number; part_index: number };

export const DEFAULT_ORG = 'org_local';

const sha256Hex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Engine {
  backend: Backend;
  extractor: Extractor;
  fetchAttachment: AttachmentFetcher | null;
  listeners = new Set<Listener>();
  workerId: string;
  leaseMs: number;
  maxStaleRetries: number;
  inlineTimeoutMs: number;
  /** handlers for job kinds that belong to other components (outbound reconciliation lives in the service) */
  handlers = new Map<string, (job: JobRow) => Promise<void>>();
  /** test hook: runs after extraction and before commit (to simulate concurrent writers or crashes) */
  beforeCommit: ((job: JobRow, snap: TaskSnapshot) => Promise<void>) | null = null;
  #stopped = true;
  #wake: (() => void) | null = null;
  stats = { processed: 0, stale_retries: 0, failures: 0 };
  /** opens after repeated outages of the primary extractor; events then fall back to the rules at once */
  breaker: Breaker;
  #limit: ReturnType<typeof limiter>;
  #extractDeadlineMs: number;
  #attachmentTimeoutMs: number;

  constructor(backend: Backend, extractor: Extractor, fetchAttachment: AttachmentFetcher | null = null, opts: EngineOptions = {}) {
    this.backend = backend;
    this.extractor = extractor;
    this.fetchAttachment = fetchAttachment;
    this.workerId = opts.workerId ?? `worker-${process.pid}-${randomUUID().slice(0, 6)}`;
    this.leaseMs = opts.leaseMs ?? 120_000;
    this.maxStaleRetries = opts.maxStaleRetries ?? 4;
    this.inlineTimeoutMs = opts.inlineTimeoutMs ?? 120_000;
    this.#extractDeadlineMs = opts.extractDeadlineMs ?? envNum('CONTINUITY_EXTRACT_DEADLINE_MS', 150_000);
    this.#attachmentTimeoutMs = opts.attachmentTimeoutMs ?? envNum('CONTINUITY_ATTACHMENT_TIMEOUT_MS', 30_000);
    this.#limit = limiter(opts.extractConcurrency ?? envNum('CONTINUITY_EXTRACT_CONCURRENCY', 4));
    this.breaker = opts.breaker ?? new Breaker();
  }

  async createTask(org: string, spec: TaskSpec, createdAt: string) {
    const at = canonicalIso(createdAt);
    await this.backend.createTask(org, spec, at, (s) => {
      s.addTransition({
        task_id: spec.id, event_id: null, at, type: 'task_created', subject_id: spec.id,
        summary: `Task ${spec.alias} created: ${spec.goal}`, detail: { requirements: spec.requirements },
      });
      for (const req of spec.requirements) {
        s.addTransition({
          task_id: spec.id, event_id: null, at, type: 'requirement', subject_id: req.key,
          summary: `Requirement${req.hard ? ' (hard)' : ''}: ${req.display}`, detail: { key: req.key, value: req.value },
        });
      }
      refreshDerived(s, spec, null, at);
    });
    this.notify(org, spec.id);
  }

  /** Durable receipt: by the time this resolves the event is stored and its interpretation queued. */
  async receive(org: string, raw: EventInput): Promise<ReceiveResult> {
    // every way in (webhook, REST, MCP, sends, the sim) stores its times in the one canonical form
    const input: EventInput = { ...raw, occurred_at: canonicalIso(raw.occurred_at), received_at: canonicalIso(raw.received_at) };
    const blobs = input.attachments
      .filter((a) => a.content_base64)
      .map((a) => {
        const bytes = Buffer.from(a.content_base64!, 'base64');
        return {
          event_id: '', part_index: a.part_index, sha256: a.sha256 || sha256Hex(bytes), content_type: a.content_type,
          size_bytes: a.size_bytes || bytes.length, bytes, primitive_email_id: input.primitive_email_id ?? null,
        };
      });
    const result = await this.backend.receive(org, input, (lookup) => resolveTask(lookup, input), blobs);
    if (result.linked && !result.duplicate) this.notify(org, result.event.task_id!);
    this.#kick();
    return result;
  }

  /** Receive, then work this task's queue inline until the event is interpreted (tests, sends, offline mode). */
  async ingest(org: string, input: EventInput): Promise<IngestResult> {
    const received = await this.receive(org, input);
    if (!received.linked) return { event: received.event, duplicate: received.duplicate, linked: false };
    const extractor = await this.settle(org, received.event.task_id!, received.event.id);
    const event = (await this.backend.getEvent(org, received.event.id))!;
    return { event, duplicate: received.duplicate, linked: true, extractor: extractor ?? undefined };
  }

  /** Attach an unlinked event to a task by hand (the explicit-linkage escape hatch). */
  async link(org: string, eventId: string, taskId: string): Promise<IngestResult> {
    const existing = await this.backend.getEvent(org, eventId);
    if (!existing) throw Object.assign(new Error(`no event ${eventId}`), { status: 404 });
    if (existing.task_id) return { event: existing, duplicate: true, linked: true };
    await this.backend.linkEvent(org, eventId, taskId, 'linked manually');
    const extractor = await this.settle(org, taskId, eventId);
    const event = (await this.backend.getEvent(org, eventId))!;
    return { event, duplicate: false, linked: true, extractor: extractor ?? undefined };
  }

  /** Run this task's jobs inline until `eventId` has been interpreted (if another worker holds the lease, wait). */
  async settle(org: string, taskId: string, eventId: string): Promise<string | null> {
    const giveUpAt = Date.now() + this.inlineTimeoutMs;
    for (;;) {
      const latest = (await this.backend.extractionsFor(org, eventId)).at(-1);
      if (latest) return latest.extractor;
      const job = await this.backend.claimJob(this.workerId, nowIso(), this.leaseMs, { org, taskId });
      if (job) {
        await this.runJob(job);
        continue;
      }
      const pending = await this.backend.pendingJobs(org, taskId);
      // nothing left to run: interpretation failed for good (dead-lettered) or the event is unlinked
      if (!pending.some((j) => j.kind === 'interpret_event')) return null;
      if (Date.now() > giveUpAt) return null;
      await pause(25);
    }
  }

  /** Process jobs until none are eligible (tests, scripts). */
  async drain(filter: { org?: string; taskId?: string } = {}, now = nowIso()) {
    let count = 0;
    for (;;) {
      const job = await this.backend.claimJob(this.workerId, now, this.leaseMs, filter);
      if (!job) return count;
      await this.runJob(job);
      count++;
    }
  }

  /** The long-running worker loop (embedded in the server, or `npm run worker`). */
  start(pollMs = 500) {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#loop(pollMs);
  }

  async #loop(pollMs: number) {
    while (!this.#stopped) {
      let job: JobRow | null = null;
      try {
        job = await this.backend.claimJob(this.workerId, nowIso(), this.leaseMs);
      } catch (err) {
        console.error('[worker] claim failed:', (err as Error).message);
      }
      if (job) {
        await this.runJob(job);
        continue;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        this.#wake = () => { clearTimeout(timer); resolve(); };
      });
      this.#wake = null;
    }
  }

  stop() {
    this.#stopped = true;
    this.#wake?.();
  }

  #kick() {
    this.#wake?.();
  }

  async runJob(job: JobRow) {
    if (job.attempts > job.max_attempts) {
      await this.#deadLetter(job, job.last_error ?? 'too many attempts (worker crashed or lease expired repeatedly)');
      return;
    }
    try {
      if (job.kind === 'interpret_event') {
        await this.#interpret(job);
      } else if (job.kind === 'deadline') {
        await this.#deadline(job);
      } else {
        const handler = this.handlers.get(job.kind);
        if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
        await handler(job);
      }
      this.stats.processed++;
    } catch (err) {
      this.stats.failures++;
      const message = (err as Error).message ?? String(err);
      if (job.attempts >= job.max_attempts) {
        await this.#deadLetter(job, message);
      } else {
        const runAfter = new Date(Date.now() + backoffMs(job.attempts)).toISOString();
        await this.backend.finishJob(job.id, { status: 'retry', error: message, runAfter });
      }
    }
  }

  async #deadLetter(job: JobRow, error: string) {
    await this.backend.finishJob(job.id, { status: 'dead', error });
    if (job.kind !== 'interpret_event' || !job.task_id || !job.event_id) return;
    const taskId = job.task_id;
    const eventId = job.event_id;
    // write the failure into task state: agents see an incomplete interpretation, never a silent gap
    for (let tries = 0; tries < 3; tries++) {
      const snap = await this.backend.loadTask(job.org, taskId);
      const committed = await this.backend.commit(snap, (s) => {
        s.addFlag(taskId, eventId, 'interpretation_failed', `${eventId} could not be interpreted: ${error.slice(0, 200)}`, nowIso());
        s.addTransition({
          task_id: taskId, event_id: eventId, at: nowIso(), type: 'interpretation_failed', subject_id: eventId,
          summary: `Email ${eventId} could not be interpreted after ${job.attempts} attempts; state may be incomplete`,
          detail: { error: error.slice(0, 500) },
        });
      }, { eventStatus: { id: eventId, status: 'failed', error } });
      if (committed.ok) {
        this.notify(job.org, taskId);
        return;
      }
    }
  }

  async #interpret(job: JobRow) {
    const org = job.org;
    const event = await this.backend.getEvent(org, job.event_id!);
    if (!event) throw new Error(`job ${job.id}: no event ${job.event_id}`);
    if (!event.task_id) {
      await this.backend.finishJob(job.id, { status: 'done' });
      return;
    }
    for (let attempt = 0; ; attempt++) {
      const snap = await this.backend.loadTask(org, event.task_id);
      if (snap.store.isInterpreted(event.id)) {
        await this.backend.finishJob(job.id, { status: 'done' });
        return;
      }
      const task = snap.store.getTask(event.task_id)!;
      const texts = await this.#attachmentTexts(org, event);
      const sender = partyOf(task, event.from);
      const input = {
        task,
        event,
        attachments: texts.map(({ filename, content_type, text }) => ({ filename, content_type, text })),
        senderRole: sender?.role ?? 'unknown',
        openObligations: snap.store.obligationsForTask(task.id).filter(isOpen),
        activeClaims: snap.store.claimsForTask(task.id).filter((c) => c.status === 'active' || c.status === 'contested'),
        claimQuotes: Object.fromEntries(snap.store.claimsForTask(task.id).filter((c) => c.status === 'active' || c.status === 'contested')
          .map((c) => [c.id, snap.store.claimEvidence(c.id).map((r) => r.quote)])),
      } as const;

      const { proposal, extractorName, fallback } = await this.#extract(input);

      if (this.beforeCommit) await this.beforeCommit(job, snap);
      const committed = await this.backend.commit(
        snap,
        (s) => applyInterpretation(s, task, event, texts, proposal, extractorName, fallback),
        { completeJobId: job.id, eventStatus: { id: event.id, status: 'interpreted' }, jobs: (s) => deadlineJobs(s, task) },
      );
      if (committed.ok) {
        this.notify(org, task.id);
        return;
      }
      this.stats.stale_retries++;
      if (attempt >= this.maxStaleRetries) {
        throw new Error(`task ${task.id} kept changing during interpretation (${attempt + 1} stale snapshots)`);
      }
      // the task moved on while we were interpreting: reload and interpret against the new state
    }
  }

  async #attachmentTexts(org: string, event: StoredEvent): Promise<AttachmentText[]> {
    const out: AttachmentText[] = [];
    for (const meta of event.attachments) {
      if (meta.text !== undefined) {
        out.push({ filename: meta.filename, content_type: meta.content_type, text: meta.text, sha256: meta.sha256, size: meta.size_bytes, part_index: meta.part_index });
        continue;
      }
      let bytes = await this.backend.getBlob(org, { event_id: event.id, part_index: meta.part_index });
      if (!bytes && this.fetchAttachment) {
        bytes = await this.fetchAttachment(event, meta.part_index, AbortSignal.timeout(this.#attachmentTimeoutMs)).catch(() => null);
        if (bytes) {
          // cache it privately, keyed by the Primitive source and the content hash
          const digest = sha256Hex(bytes);
          await this.backend.putBlob(org, {
            event_id: event.id, part_index: meta.part_index, sha256: meta.sha256 || digest, content_type: meta.content_type,
            size_bytes: bytes.length, bytes, primitive_email_id: event.primitive_email_id ?? null,
          }).catch(() => undefined);
        }
      }
      const text = bytes ? attachmentText(meta.filename, meta.content_type, bytes) : '';
      out.push({
        filename: meta.filename,
        content_type: meta.content_type,
        text,
        sha256: meta.sha256 || (bytes ? sha256Hex(bytes) : ''),
        size: meta.size_bytes || bytes?.length || 0,
        part_index: meta.part_index,
      });
    }
    return out;
  }

  /**
   * Interpretation with a hard deadline. Any failure (deadline, outage, bad output) falls back to the
   * rule-based extractor and is flagged, so one email never holds its task for long and an event is
   * never lost because interpretation failed. During an outage the breaker skips the primary entirely.
   */
  async #extract(input: ExtractInput): Promise<{ proposal: Proposal; extractorName: string; fallback: string | null }> {
    const primary = this.extractor;
    if (primary === heuristicExtractor) return { proposal: await primary.extract(input), extractorName: primary.name, fallback: null };
    if (!this.breaker.allow()) {
      return { proposal: await heuristicExtractor.extract(input), extractorName: heuristicExtractor.name, fallback: `${primary.name} skipped: circuit open after repeated failures` };
    }
    try {
      // the deadline starts once a concurrency slot is free, so queueing does not eat into it
      const proposal = await this.#limit(() => {
        const signal = AbortSignal.timeout(this.#extractDeadlineMs);
        return withDeadline(primary.extract(input, { signal }), signal);
      });
      this.breaker.success();
      return { proposal, extractorName: primary.name, fallback: null };
    } catch (err) {
      if (isTransient(err)) this.breaker.failure();
      const why = (err as Error)?.name === 'TimeoutError' ? `deadline of ${this.#extractDeadlineMs} ms exceeded` : (err as Error)?.message;
      return { proposal: await heuristicExtractor.extract(input), extractorName: heuristicExtractor.name, fallback: `${primary.name} failed: ${why}` };
    }
  }

  async #deadline(job: JobRow) {
    const { obligation_id, due_at } = job.payload as { obligation_id: string; due_at: string };
    const taskId = job.task_id!;
    for (let attempt = 0; attempt <= this.maxStaleRetries; attempt++) {
      const snap = await this.backend.loadTask(job.org, taskId);
      const committed = await this.backend.commit(snap, (s) => {
        const ob = s.getObligation(obligation_id);
        const today = nowIso().slice(0, 10);
        if (!ob || !isOpen(ob) || ob.due_at !== due_at || today <= due_at) return false;
        if (ob.condition && !ob.condition_met_at) return false;
        const alreadyFlagged = s.transitionsForTask(taskId).some((t) =>
          t.type === 'obligation_overdue' && t.subject_id === ob.id && (t.detail as { due_at?: string }).due_at === due_at);
        if (alreadyFlagged) return false;
        const task = s.getTask(taskId)!;
        const outstanding = ob.quantity != null ? ob.quantity - (ob.fulfilled_quantity ?? 0) : null;
        const remainder = outstanding != null ? ` — ${outstanding} still outstanding` : '';
        s.addTransition({
          task_id: task.id, event_id: null, at: nowIso(), type: 'obligation_overdue', subject_id: ob.id,
          summary: `OVERDUE: ${labelOf(task, ob.debtor)} owes ${labelOf(task, ob.creditor)} "${ob.text}" (due ${due_at})${remainder}`,
          detail: { due_at, debtor: ob.debtor, outstanding },
        });
        return true;
      }, { completeJobId: job.id });
      if (committed.ok) {
        if (committed.value) this.notify(job.org, taskId);
        return;
      }
    }
    throw new Error(`deadline ${job.dedupe_key}: task kept changing`);
  }

  notify(org: string, taskId: string) {
    for (const listener of this.listeners) listener(org, taskId);
  }
}

/** The atomic apply step of interpretation (pure and synchronous; it runs inside the commit). */
export function applyInterpretation(s: MemoryStore, task: TaskSpec, event: StoredEvent, texts: { filename: string; content_type: string; text: string; sha256: string; size: number; part_index: number }[], proposal: Proposal, extractorName: string, fallback: string | null) {
  if (s.isInterpreted(event.id)) return; // idempotent: a redelivered job never applies twice
  if (fallback) s.addFlag(task.id, event.id, 'extractor_fallback', fallback, event.received_at);
  s.saveExtraction(event.id, extractorName, proposal, nowIso());

  const route = `${labelOf(task, event.from)} → ${event.to.map((addr) => labelOf(task, addr)).join(', ')}`;
  const count = event.attachments.length;
  const attachmentNote = count ? ` [${count} attachment${count > 1 ? 's' : ''}]` : '';
  s.addTransition({
    task_id: task.id, event_id: event.id, at: event.received_at, type: 'event_ingested', subject_id: event.id,
    summary: `${route}: "${event.subject}"${attachmentNote}`,
    detail: { link_reason: event.link_reason, thread_id: event.thread_id, direction: event.direction },
  });
  const party = partyOf(task, event.from);
  if (!party) {
    s.addFlag(task.id, event.id, 'unknown_sender', `${event.from} is not a task participant; their statements are recorded as tentative`, event.received_at);
  }
  flagEvidence(s, task, event, party);

  const artifacts: Artifact[] = texts.map((t) => {
    const classified = proposal.artifacts.find((a) => a.filename === t.filename) ?? { ...classifyArtifact(t.filename, t.text, domainFor(task)) };
    if (!t.text) s.addFlag(task.id, event.id, 'attachment_unreadable', `${t.filename}: no extractable text`, event.received_at);
    return s.insertArtifact({
      task_id: task.id, event_id: event.id, filename: t.filename, content_type: t.content_type, sha256: t.sha256,
      size_bytes: t.size, kind: classified.kind, version_label: classified.version_label, text: t.text,
      status: 'current', superseded_by: null, owner: event.from,
    });
  });
  applyProposal({ store: s, task, event, proposal, extractor: extractorName, artifacts });
}

/** Flags about the evidence itself: repaired times (found at receipt) and an unproven sender identity. */
function flagEvidence(s: MemoryStore, task: TaskSpec, event: StoredEvent, party: Participant | null) {
  const flag = (kind: string, detail: string) => {
    if (s.flagsForTask(task.id).some((f) => f.event_id === event.id && f.kind === kind)) return;
    s.addFlag(task.id, event.id, kind, detail, event.received_at);
  };
  for (const f of event.time_flags ?? []) flag(f.kind, f.detail);
  if (event.direction !== 'inbound') return;
  const auth = parseSenderAuth(event.auth_verdict);
  if (party && party.role !== 'self' && auth?.status !== 'pass') {
    // say which policy decided, so a reader knows whether the statements were applied
    const { policy, source } = senderAuthPolicyOf(party);
    const rule = source === 'participant' ? `${party.label}'s sender_auth=${policy}` : `default CONTINUITY_SENDER_AUTH=${policy}`;
    const effect = authenticatedEnough(auth, policy)
      ? `applied anyway (${rule}; verdict unknown, not failed)`
      : `${policy === 'flag' ? `a failing verdict is never relaxed (${rule})` : rule}: its statements are recorded as tentative and it cannot close obligations or replace documents`;
    const how = auth ? `${auth.reason}${auth.dmarc ? `, dmarc=${auth.dmarc}` : ''}${auth.dmarc_policy ? ` p=${auth.dmarc_policy}` : ''}` : 'no auth data';
    flag('sender_unauthenticated', `${event.from} is not authenticated (${how}) — ${effect}. Verify with ${party.label} through a channel you trust before relying on it`);
  }
  if (party?.role === 'self') flag('sender_impersonates_us', `inbound mail claims to be from our own address ${event.from}; ignored as a source of decisions`);
}

/** One deadline job per (obligation, due date), scheduled once the obligation is actually due (conditions met). */
export function deadlineJobs(s: MemoryStore, task: TaskSpec): JobInput[] {
  return s.obligationsForTask(task.id)
    .filter((o) => isOpen(o) && o.due_at && (!o.condition || o.condition_met_at))
    .map((o) => ({
      kind: 'deadline' as const,
      task_id: task.id,
      dedupe_key: `deadline:${task.id}:${o.id}:${o.due_at}`,
      payload: { obligation_id: o.id, due_at: o.due_at },
      run_after: nextDayStart(o.due_at!),
    }));
}

/** Midnight UTC of the day after `d` (a YYYY-MM-DD date). */
function nextDayStart(d: string): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString();
}
