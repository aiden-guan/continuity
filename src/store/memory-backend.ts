// The in-process backend: tests, evals and replay. It keeps the same contract as Postgres (snapshot, then
// a version-checked commit), so the engine's concurrency behavior is exercised without a database.
import { randomUUID } from 'node:crypto';
import { MemoryStore, applyDelta, COMMIT_COUNTERS } from './state.ts';
import type {
  ActionRow, Backend, BlobIn, BlobRef, CommitOptions, CommitResult, JobInput, JobOutcome, JobRow, LinkLookup, Principal, ReceiveResult, SignalRow, TaskSnapshot,
} from './backend.ts';
import type { EventInput, StoredEvent, TaskSpec } from '../types.ts';
import { stripAttachmentBytes } from './rows.ts';
import { compareIso } from '../clock.ts';

const httpError = (message: string, status: number) => Object.assign(new Error(message), { status });
const key = (...parts: (string | number)[]) => parts.join('\u0000');
const EPOCH = new Date(0).toISOString();

export class MemoryBackend implements Backend {
  readonly mode = 'memory' as const;
  readonly target = 'in-process memory (not persistent)';
  orgs = new Map<string, MemoryStore>();
  jobs: JobRow[] = [];
  /** keyed by org + action id */
  actions = new Map<string, ActionRow>();
  runs = new Map<string, Record<string, unknown>>();
  blobs = new Map<string, Buffer>();
  principals = new Map<string, Principal>();
  /** remembered Signal alerts: org → key → row */
  signals = new Map<string, Map<string, SignalRow>>();
  #jobSeq = 0;

  async init() {}
  async close() {}
  async health() { return { ok: true, detail: 'memory', schema: null }; }
  async ensureOrg(org: string) { this.org(org); }
  async instanceId(org: string) { return this.org(org).instanceId(); }

  /** An org's authoritative store (tests read it directly). */
  org(org: string): MemoryStore {
    let s = this.orgs.get(org);
    if (!s) this.orgs.set(org, (s = new MemoryStore()));
    return s;
  }

  /** A working copy of the whole org (memory orgs are small). */
  #workingCopy(org: string): MemoryStore {
    const w = this.org(org).clone();
    w.discardDelta();
    return w;
  }

  // ------------------------------------------------------------------ tasks

  async createTask(org: string, spec: TaskSpec, at: string, init: (s: MemoryStore) => void) {
    const auth = this.org(org);
    if (auth.getTask(spec.id) || auth.getTask(spec.alias)) throw httpError(`task ${spec.id} exists`, 409);
    const work = this.#workingCopy(org);
    work.createTask(spec, at);
    init(work);
    applyDelta(auth, work.takeDelta());
  }
  async getTask(org: string, idOrAlias: string) { return structuredClone(this.org(org).getTask(idOrAlias)); }
  async listTasks(org: string) {
    const s = this.org(org);
    return s.listTasks().map((spec) => ({ spec: structuredClone(spec), state_version: s.stateVersion(spec.id) }));
  }

  // ------------------------------------------------------------------ receipt

  async receive(org: string, input: EventInput, link: (l: LinkLookup) => Promise<{ task_id: string; reason: string } | null>, blobs: BlobIn[]): Promise<ReceiveResult> {
    const s = this.org(org);
    const existing = s.findEventByDedupe(input.dedupe_key);
    if (existing) {
      // a redelivery has no new effects, but unfinished interpretation is re-armed
      const requeued = existing.task_id ? this.#rearm(org, existing) : false;
      return { event: structuredClone(existing), duplicate: true, linked: !!existing.task_id, requeued };
    }
    const target = await link({
      taskForThread: async (t) => s.taskForThread(t),
      eventByPrimitiveEmailId: async (id) => s.eventByPrimitiveEmailId(id),
      eventByMessageId: async (id) => s.eventByMessageId(id),
      tasks: async () => s.listTasks().map((t) => ({ id: t.id, alias: t.alias, goal: t.goal })),
    });
    if (s.findEventByDedupe(input.dedupe_key)) return this.receive(org, input, link, blobs); // raced with another delivery

    if (input.preserve_seq) s.setNextId('ev', input.preserve_seq);
    const id = s.nextId('ev');
    const event = {
      ...stripAttachmentBytes(input), id, seq: Number(id.slice(3)), task_id: target?.task_id ?? null, link_reason: target?.reason ?? null,
    } as StoredEvent;
    s.putEvent(event, input.raw);
    if (target && event.thread_id) s.mapThread(event.thread_id, target.task_id, `${event.id}: ${target.reason}`);
    s.discardDelta();
    for (const b of blobs) await this.putBlob(org, { ...b, event_id: id });
    if (target) await this.enqueue(org, [interpretJob(target.task_id, event)]);
    return { event: structuredClone(event), duplicate: false, linked: !!target, requeued: false };
  }

  #rearm(org: string, ev: StoredEvent): boolean {
    const s = this.org(org);
    if (s.isInterpreted(ev.id)) return false;
    const job = this.jobs.find((j) => j.org === org && j.dedupe_key === `interpret:${ev.id}`);
    if (!job) {
      this.enqueueSync(org, [interpretJob(ev.task_id, ev)]);
      return true;
    }
    if (job.status === 'dead') {
      Object.assign(job, { status: 'pending', attempts: 0, run_after: EPOCH });
      s.failed.delete(ev.id);
      return true;
    }
    return false;
  }

  async linkEvent(org: string, eventId: string, taskId: string, reason: string) {
    const s = this.org(org);
    const ev = s.getEvent(eventId);
    if (!ev) throw httpError(`no event ${eventId}`, 404);
    if (!ev.task_id) {
      s.setEventTask(eventId, taskId, reason);
      if (ev.thread_id) s.mapThread(ev.thread_id, taskId, `manual link of ${eventId}`);
      s.discardDelta();
      await this.enqueue(org, [interpretJob(taskId, ev)]);
    }
    return structuredClone(s.getEvent(eventId)!);
  }

  async getEvent(org: string, id: string) { return structuredClone(this.org(org).getEvent(id)); }
  async getEventRaw(org: string, id: string) { return this.org(org).getEventRaw(id); }
  async unlinkedEvents(org: string) { return structuredClone(this.org(org).unlinkedEvents()); }
  async extractionsFor(org: string, id: string) { return structuredClone(this.org(org).extractionsFor(id)); }
  async findItemTask(org: string, itemId: string) {
    const s = this.org(org);
    switch (itemId.split('_')[0]) {
      case 'ev': return s.getEvent(itemId)?.task_id ?? null;
      case 'cl': return s.getClaim(itemId)?.task_id ?? null;
      case 'ob': return s.getObligation(itemId)?.task_id ?? null;
      case 'ar': return s.getArtifact(itemId)?.task_id ?? null;
      default: return null;
    }
  }

  // ------------------------------------------------------------------ snapshot and commit

  async loadTask(org: string, taskId: string): Promise<TaskSnapshot> {
    const auth = this.org(org);
    if (!auth.getTask(taskId)) throw httpError(`unknown task ${taskId}`, 404);
    return { org, taskId, version: auth.stateVersion(taskId), store: this.#workingCopy(org) };
  }

  async commit<T>(snap: TaskSnapshot, mutate: (s: MemoryStore) => T, opts: CommitOptions = {}): Promise<CommitResult<T>> {
    const auth = this.org(snap.org);
    const current = auth.stateVersion(snap.taskId);
    if (current !== snap.version) return { ok: false, reason: 'stale', version: current };
    if (opts.actions?.length) {
      const mine = new Set(opts.actions.map((a) => a.idempotency_key));
      const inFlight = [...this.actions.values()].some((a) =>
        a.org === snap.org && a.task_id === snap.taskId && (a.status === 'pending' || a.status === 'attempted') && !mine.has(a.idempotency_key));
      if (inFlight) return { ok: false, reason: 'conflict', version: current, detail: 'another send for this task is in flight' };
    }
    const work = snap.store;
    work.discardDelta();
    work.resetCounters(Object.fromEntries(COMMIT_COUNTERS.map((k) => [k, auth.counters.get(k) ?? 0])));
    const value = mutate(work); // a throw here applies nothing
    const jobs = opts.jobs?.(work) ?? [];
    applyDelta(auth, work.takeDelta());
    if (opts.eventStatus?.status === 'failed') auth.failed.add(opts.eventStatus.id);
    if (opts.completeJobId) {
      const job = this.jobs.find((j) => j.id === opts.completeJobId);
      if (job) Object.assign(job, { status: 'done', locked_until: null });
    }
    for (const a of opts.actions ?? []) this.actions.set(key(snap.org, a.id), structuredClone(a));
    this.enqueueSync(snap.org, jobs);
    snap.version = auth.stateVersion(snap.taskId);
    return { ok: true, version: snap.version, value };
  }

  // ------------------------------------------------------------------ jobs

  async enqueue(org: string, jobs: JobInput[]) { this.enqueueSync(org, jobs); }
  enqueueSync(org: string, jobs: JobInput[]) {
    for (const j of jobs) {
      if (this.jobs.some((x) => x.org === org && x.dedupe_key === j.dedupe_key)) continue;
      this.jobs.push({
        id: String(++this.#jobSeq), org, kind: j.kind, task_id: j.task_id, event_id: j.event_id ?? null, seq: j.seq ?? 0,
        dedupe_key: j.dedupe_key, payload: j.payload ?? {}, status: 'pending', attempts: 0, max_attempts: j.max_attempts ?? 5,
        run_after: j.run_after ?? EPOCH, locked_by: null, locked_until: null, last_error: null,
      });
    }
  }

  async claimJob(workerId: string, now: string, leaseMs: number, filter: { org?: string; taskId?: string } = {}) {
    const leased = (j: JobRow) => j.status === 'running' && compareIso(j.locked_until!, now) > 0;
    const ready = (j: JobRow) => (j.status === 'pending' && compareIso(j.run_after, now) <= 0) || (j.status === 'running' && compareIso(j.locked_until!, now) <= 0);
    // one job per task at a time; interpretation strictly in event order
    const blocked = (j: JobRow) => !!j.task_id && this.jobs.some((k) =>
      k !== j && k.org === j.org && k.task_id === j.task_id && (
        leased(k) ||
        (j.kind === 'interpret_event' && k.kind === 'interpret_event' && k.status !== 'done' && k.status !== 'dead' && k.seq < j.seq)));
    const next = this.jobs
      .filter((j) => (!filter.org || j.org === filter.org) && (!filter.taskId || j.task_id === filter.taskId) && ready(j) && !blocked(j))
      .sort((a, b) => compareIso(a.run_after, b.run_after) || a.seq - b.seq || Number(a.id) - Number(b.id))[0];
    if (!next) return null;
    next.status = 'running';
    next.attempts++;
    next.locked_by = workerId;
    next.locked_until = new Date(Date.parse(now) + leaseMs).toISOString();
    return structuredClone(next);
  }

  async finishJob(id: string, outcome: JobOutcome) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || job.status === 'done') return;
    job.locked_until = null;
    job.locked_by = null;
    if (outcome.status === 'done') {
      job.status = 'done';
    } else if (outcome.status === 'retry') {
      Object.assign(job, { status: 'pending', last_error: outcome.error, run_after: outcome.runAfter });
    } else {
      Object.assign(job, { status: 'dead', last_error: outcome.error });
      if (job.event_id) this.org(job.org).failed.add(job.event_id);
    }
  }

  async jobCounts(org?: string) {
    const counts: Record<string, number> = {};
    for (const j of this.jobs) if (!org || j.org === org) counts[j.status] = (counts[j.status] ?? 0) + 1;
    return counts;
  }
  async pendingJobs(org: string, taskId: string) {
    return structuredClone(this.jobs.filter((j) => j.org === org && j.task_id === taskId && (j.status === 'pending' || j.status === 'running')));
  }

  // ------------------------------------------------------------------ actions

  async getAction(org: string, id: string) { return structuredClone(this.actions.get(key(org, id)) ?? null); }
  async getActionByKey(org: string, idempotencyKey: string) {
    return structuredClone([...this.actions.values()].find((a) => a.org === org && a.idempotency_key === idempotencyKey) ?? null);
  }
  async listActions(org: string, taskId: string) {
    return structuredClone([...this.actions.values()].filter((a) => a.org === org && a.task_id === taskId));
  }
  async updateAction(org: string, id: string, fields: Partial<ActionRow>) {
    const action = this.actions.get(key(org, id));
    if (!action) throw new Error(`no action ${id}`);
    Object.assign(action, fields, { updated_at: new Date().toISOString() });
    return structuredClone(action);
  }

  // ------------------------------------------------------------------ cursors and runs

  async setCursor(org: string, agentId: string, taskId: string, seq: number) { this.org(org).setCursorLocal(agentId, taskId, seq); }

  async saveAgentRun(org: string, run: Record<string, unknown>) {
    const s = this.org(org);
    const id = typeof run.id === 'string' ? run.id : s.nextId('run');
    s.discardDelta();
    const k = key(org, id);
    this.runs.set(k, { ...(this.runs.get(k) ?? {}), ...structuredClone(run), id });
    return id;
  }
  async agentRuns(org: string, taskId: string) {
    return [...this.runs.entries()]
      .filter(([k, r]) => k.startsWith(key(org, '')) && r.task_id === taskId)
      .map(([, r]) => structuredClone(r))
      .sort((a, b) => compareIso(String(a.started_at), String(b.started_at)));
  }

  // ------------------------------------------------------------------ remembered Signal alerts

  async listSignals(org: string, opts: { includeResolved?: boolean } = {}) {
    return [...(this.signals.get(org)?.values() ?? [])]
      .filter((s) => opts.includeResolved || !s.resolved_at)
      .sort((a, b) => compareIso(a.first_seen, b.first_seen) || a.key.localeCompare(b.key))
      .map((s) => structuredClone(s));
  }
  async saveSignals(org: string, rows: SignalRow[]) {
    let byKey = this.signals.get(org);
    if (!byKey) this.signals.set(org, (byKey = new Map()));
    for (const r of rows) byKey.set(r.key, structuredClone(r));
  }

  // ------------------------------------------------------------------ blobs and principals

  async putBlob(org: string, b: BlobIn) { this.blobs.set(key(org, b.event_id, b.part_index), Buffer.from(b.bytes)); }
  async getBlob(org: string, ref: BlobRef) { return this.blobs.get(key(org, ref.event_id, ref.part_index)) ?? null; }

  async findPrincipal(hash: string) { return structuredClone(this.principals.get(hash) ?? null); }
  async createPrincipal(p: Principal, hash: string) { this.principals.set(hash, { ...p, id: p.id || randomUUID() }); }
}

function interpretJob(taskId: string | null, ev: StoredEvent): JobInput {
  return { kind: 'interpret_event', task_id: taskId, event_id: ev.id, seq: ev.seq, dedupe_key: `interpret:${ev.id}` };
}
