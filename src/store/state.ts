// The synchronous state surface that the resolver and the compiler work against.
//
// Persistence is asynchronous (Supabase Postgres, SQLite, memory); interpretation is not. A worker loads
// one task's working set into a MemoryStore, runs the extractor with no transaction open (it may call a
// model), and then, inside a short transaction that re-checks the task's state version, runs the
// deterministic resolver on the working set and writes back exactly the rows it touched (the Delta).
import { randomUUID } from 'node:crypto';
import type { Artifact, CheckResult, Claim, Obligation, StoredEvent, TaskSpec, Transition } from '../types.ts';
import { compareIso } from '../clock.ts';

export interface ClaimEvidenceRow { claim_id: string; event_id: string; artifact_id: string | null; quote: string }
export interface FlagRow { id: string; task_id: string | null; event_id: string; kind: string; detail: string; at: string }
export interface ExtractionRow { event_id: string; extractor: string; proposal: unknown; created_at: string; version: number }
export interface TaskRow { spec: TaskSpec; created_at: string; state_version: number }

/** Id counters allocated inside a task commit. Events are numbered at receipt instead. */
export const COMMIT_COUNTERS = ['cl', 'ob', 'ar', 'fl', 'tr'] as const;

interface Changes<T> { inserted: T[]; updated: T[] }

/** Everything a commit has to write. */
export interface Delta {
  tasks: TaskRow[];
  taskVersions: Map<string, number>;
  /** Only the memory backend and replay insert events here; persistent backends insert at receipt. */
  events: StoredEvent[];
  eventRaw: Map<string, unknown>;
  eventLinks: { id: string; task_id: string; link_reason: string }[];
  threads: { thread_id: string; task_id: string; reason: string }[];
  extractions: ExtractionRow[];
  artifacts: Changes<Artifact>;
  claims: Changes<Claim>;
  claimEvidence: ClaimEvidenceRow[];
  obligations: Changes<Obligation>;
  transitions: Transition[];
  checks: Map<string, CheckResult[]>;
  flags: FlagRow[];
  counters: Map<string, number>;
}

function emptyDelta(): Delta {
  return {
    tasks: [], taskVersions: new Map(), events: [], eventRaw: new Map(), eventLinks: [], threads: [], extractions: [],
    artifacts: { inserted: [], updated: [] }, claims: { inserted: [], updated: [] }, claimEvidence: [],
    obligations: { inserted: [], updated: [] }, transitions: [], checks: new Map(), flags: [], counters: new Map(),
  };
}

const idNumber = (id: string) => Number(id.split('_')[1]);
const byIdNumber = (a: { id: string }, b: { id: string }) => idNumber(a.id) - idNumber(b.id);
const cursorKey = (agentId: string, taskId: string) => `${agentId}\u0000${taskId}`;

/** Record that `row` changed; an insert already carries the row's final state. */
function touch<T extends { id: string }>(changes: Changes<T>, row: T): void {
  if (changes.inserted.some((x) => x.id === row.id) || changes.updated.some((x) => x.id === row.id)) return;
  changes.updated.push(row);
}

/**
 * The in-memory state surface, with change tracking. It is either a task's working set loaded from a
 * persistent backend, or the authoritative store of the memory backend (tests, replay, offline evals).
 */
export class MemoryStore {
  tasks = new Map<string, TaskRow>();
  events = new Map<string, StoredEvent>();
  raw = new Map<string, unknown>();
  threads = new Map<string, { task_id: string; reason: string }>();
  extractions: ExtractionRow[] = [];
  artifacts = new Map<string, Artifact>();
  claims = new Map<string, Claim>();
  claimEv: ClaimEvidenceRow[] = [];
  obligations = new Map<string, Obligation>();
  transitions: Transition[] = [];
  checks = new Map<string, CheckResult[]>();
  flags: FlagRow[] = [];
  cursors = new Map<string, number>();
  counters = new Map<string, number>();
  meta = new Map<string, string>();
  /** Events of the working set whose interpretation is still outstanding (set by the loader). */
  pending = new Set<string>();
  /** Events whose interpretation failed for good (dead-lettered). */
  failed = new Set<string>();

  #delta: Delta = emptyDelta();

  // ------------------------------------------------------------------ change tracking

  takeDelta(): Delta {
    const d = this.#delta;
    this.#delta = emptyDelta();
    return d;
  }
  peekDelta(): Delta { return this.#delta; }
  discardDelta(): void { this.#delta = emptyDelta(); }

  /** A deep copy, so a snapshot survives an apply that throws halfway. */
  clone(): MemoryStore {
    const c = new MemoryStore();
    const copyMap = <K, V>(from: Map<K, V>, to: Map<K, V>, f: (v: V) => V = structuredClone) => { for (const [k, v] of from) to.set(k, f(v)); };
    copyMap(this.tasks, c.tasks);
    copyMap(this.events, c.events);
    copyMap(this.raw, c.raw, (v) => v);
    copyMap(this.threads, c.threads, (v) => ({ ...v }));
    copyMap(this.artifacts, c.artifacts, (v) => ({ ...v }));
    copyMap(this.claims, c.claims);
    copyMap(this.obligations, c.obligations);
    copyMap(this.checks, c.checks);
    copyMap(this.cursors, c.cursors, (v) => v);
    copyMap(this.counters, c.counters, (v) => v);
    copyMap(this.meta, c.meta, (v) => v);
    c.extractions = this.extractions.map((x) => structuredClone(x));
    c.claimEv = this.claimEv.map((x) => ({ ...x }));
    c.transitions = this.transitions.map((x) => structuredClone(x));
    c.flags = this.flags.map((x) => ({ ...x }));
    c.pending = new Set(this.pending);
    c.failed = new Set(this.failed);
    return c;
  }

  instanceId(): string {
    if (!this.meta.has('instance_id')) this.meta.set('instance_id', randomUUID());
    return this.meta.get('instance_id')!;
  }

  // ------------------------------------------------------------------ ids

  /** Take the counters from the authoritative store (inside a commit, before the apply). */
  resetCounters(values: Map<string, number> | Record<string, number>): void {
    const entries = values instanceof Map ? [...values] : Object.entries(values);
    for (const [name, value] of entries) this.counters.set(name, Math.max(Number(value), 0));
  }

  #setCounter(prefix: string, value: number) {
    this.counters.set(prefix, value);
    this.#delta.counters.set(prefix, value);
  }
  setNextId(prefix: string, n: number): void { this.#setCounter(prefix, n - 1); }
  nextId(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.#setCounter(prefix, n);
    return `${prefix}_${n}`;
  }

  // ------------------------------------------------------------------ tasks and threads

  createTask(spec: TaskSpec, at: string): void {
    if (this.tasks.has(spec.id)) throw new Error(`task ${spec.id} exists`);
    const row = { spec, created_at: at, state_version: 0 };
    this.tasks.set(spec.id, row);
    this.#delta.tasks.push(row);
  }
  getTask(idOrAlias: string): TaskSpec | null {
    const row = this.tasks.get(idOrAlias) ?? [...this.tasks.values()].find((t) => t.spec.alias === idOrAlias);
    return row?.spec ?? null;
  }
  taskCreatedAt(taskId: string): string | null { return this.tasks.get(taskId)?.created_at ?? null; }
  listTasks(): TaskSpec[] {
    return [...this.tasks.values()].sort((a, b) => compareIso(a.created_at, b.created_at)).map((t) => t.spec);
  }
  stateVersion(taskId: string): number { return this.tasks.get(taskId)?.state_version ?? 0; }
  /** Swap a task definition in place (eval scenarios add participants; the service never does). */
  replaceTaskSpec(spec: TaskSpec): void {
    const row = this.tasks.get(spec.id);
    if (row) row.spec = spec;
  }

  mapThread(threadId: string, taskId: string, reason: string): void {
    if (this.threads.has(threadId)) return;
    this.threads.set(threadId, { task_id: taskId, reason });
    this.#delta.threads.push({ thread_id: threadId, task_id: taskId, reason });
  }
  taskForThread(threadId: string): string | null { return this.threads.get(threadId)?.task_id ?? null; }
  threadsForTask(taskId: string): { thread_id: string; reason: string }[] {
    return [...this.threads].filter(([, t]) => t.task_id === taskId).map(([thread_id, t]) => ({ thread_id, reason: t.reason }));
  }

  // ------------------------------------------------------------------ events

  /** Insert an event (memory backend and replay only). */
  putEvent(e: StoredEvent, raw?: unknown): void {
    this.events.set(e.id, e);
    this.#delta.events.push(e);
    if (raw !== undefined) {
      this.raw.set(e.id, raw);
      this.#delta.eventRaw.set(e.id, raw);
    }
  }
  #eventsInOrder(): StoredEvent[] { return [...this.events.values()].sort((a, b) => a.seq - b.seq); }
  findEventByDedupe(key: string): StoredEvent | null { return [...this.events.values()].find((e) => e.dedupe_key === key) ?? null; }
  getEvent(id: string): StoredEvent | null { return this.events.get(id) ?? null; }
  getEventRaw(id: string): unknown { return this.raw.get(id) ?? null; }
  eventByMessageId(messageId: string): StoredEvent | null { return this.#eventsInOrder().find((e) => e.message_id === messageId) ?? null; }
  eventByPrimitiveEmailId(emailId: string): StoredEvent | null { return this.#eventsInOrder().find((e) => e.primitive_email_id === emailId) ?? null; }
  eventsForTask(taskId: string): StoredEvent[] { return this.#eventsInOrder().filter((e) => e.task_id === taskId); }
  unlinkedEvents(): StoredEvent[] { return this.#eventsInOrder().filter((e) => !e.task_id); }
  setEventTask(eventId: string, taskId: string, reason: string): void {
    const e = this.events.get(eventId);
    if (!e) throw new Error(`no event ${eventId}`);
    e.task_id = taskId;
    e.link_reason = reason;
    this.#delta.eventLinks.push({ id: eventId, task_id: taskId, link_reason: reason });
  }

  isInterpreted(eventId: string): boolean { return this.extractions.some((x) => x.event_id === eventId); }
  /** Task events that are stored but not interpreted yet. */
  pendingEventIds(taskId: string): string[] {
    return this.eventsForTask(taskId)
      .filter((e) => this.pending.has(e.id) || (!this.failed.has(e.id) && !this.isInterpreted(e.id)))
      .map((e) => e.id);
  }
  failedEventIds(taskId: string): string[] { return this.eventsForTask(taskId).filter((e) => this.failed.has(e.id)).map((e) => e.id); }

  saveExtraction(eventId: string, extractor: string, proposal: unknown, at: string): void {
    const version = this.extractions.filter((x) => x.event_id === eventId).length + 1;
    const row = { event_id: eventId, extractor, proposal, created_at: at, version };
    this.extractions.push(row);
    this.pending.delete(eventId);
    this.#delta.extractions.push(row);
  }
  extractionsFor(eventId: string): { extractor: string; proposal: unknown; version?: number; created_at?: string }[] {
    return this.extractions
      .filter((x) => x.event_id === eventId)
      .map(({ extractor, proposal, version, created_at }) => ({ extractor, proposal, version, created_at }));
  }

  // ------------------------------------------------------------------ artifacts

  insertArtifact(a: Omit<Artifact, 'id'>): Artifact {
    const row = { ...a, id: this.nextId('ar') };
    this.artifacts.set(row.id, row);
    this.#delta.artifacts.inserted.push(row);
    return row;
  }
  getArtifact(id: string): Artifact | null { return this.artifacts.get(id) ?? null; }
  artifactsForTask(taskId: string): Artifact[] { return [...this.artifacts.values()].filter((a) => a.task_id === taskId).sort(byIdNumber); }
  updateArtifact(id: string, status: string, supersededBy: string | null): void {
    const a = this.artifacts.get(id);
    if (!a) return;
    a.status = status as Artifact['status'];
    a.superseded_by = supersededBy;
    touch(this.#delta.artifacts, a);
  }

  // ------------------------------------------------------------------ claims

  insertClaim(c: Omit<Claim, 'id'>): Claim {
    const row = { ...c, id: this.nextId('cl') };
    this.claims.set(row.id, row);
    this.#delta.claims.inserted.push(row);
    return row;
  }
  updateClaim(id: string, patch: Partial<Pick<Claim, 'status' | 'superseded_by' | 'supersede_reason'>>): void {
    const c = this.claims.get(id);
    if (!c) return;
    Object.assign(c, patch);
    touch(this.#delta.claims, c);
  }
  getClaim(id: string): Claim | null { return this.claims.get(id) ?? null; }
  claimsForTask(taskId: string): Claim[] { return [...this.claims.values()].filter((c) => c.task_id === taskId).sort(byIdNumber); }

  addClaimEvidence(claimId: string, eventId: string, artifactId: string | null, quote: string): void {
    const row = { claim_id: claimId, event_id: eventId, artifact_id: artifactId, quote };
    this.claimEv.push(row);
    this.#delta.claimEvidence.push(row);
  }
  claimEvidence(claimId: string): { event_id: string; artifact_id: string | null; quote: string }[] {
    return this.claimEv.filter((e) => e.claim_id === claimId).map(({ event_id, artifact_id, quote }) => ({ event_id, artifact_id, quote }));
  }
  /** Claims a document supports, in the order its statements were recorded. */
  claimsSupportedByArtifact(artifactId: string): Claim[] {
    const ids = new Set(this.claimEv.filter((e) => e.artifact_id === artifactId).map((e) => e.claim_id));
    return [...ids].map((id) => this.claims.get(id)).filter((c): c is Claim => !!c);
  }

  // ------------------------------------------------------------------ obligations

  insertObligation(o: Omit<Obligation, 'id'>): Obligation {
    const row = { ...o, id: this.nextId('ob') };
    this.obligations.set(row.id, row);
    this.#delta.obligations.inserted.push(row);
    return row;
  }
  updateObligation(id: string, patch: Partial<Omit<Obligation, 'id' | 'task_id'>>): void {
    const o = this.obligations.get(id);
    if (!o) return;
    Object.assign(o, patch);
    touch(this.#delta.obligations, o);
  }
  getObligation(id: string): Obligation | null { return this.obligations.get(id) ?? null; }
  obligationsForTask(taskId: string): Obligation[] { return [...this.obligations.values()].filter((o) => o.task_id === taskId).sort(byIdNumber); }

  // ------------------------------------------------------------------ transitions, checks, flags

  /** Append a transition. Its sequence number becomes the task's state version. */
  addTransition(t: Omit<Transition, 'seq'>): number {
    const seq = idNumber(this.nextId('tr'));
    const row = { ...t, seq };
    this.transitions.push(row);
    this.#delta.transitions.push(row);
    const task = this.tasks.get(t.task_id);
    if (task && seq > task.state_version) {
      task.state_version = seq;
      this.#delta.taskVersions.set(t.task_id, seq);
    }
    return seq;
  }
  transitionsForTask(taskId: string, sinceSeq = 0): Transition[] {
    return this.transitions.filter((t) => t.task_id === taskId && t.seq > sinceSeq).sort((a, b) => a.seq - b.seq);
  }
  latestTransitionSeq(taskId: string): number { return this.stateVersion(taskId); }

  getChecks(taskId: string): CheckResult[] { return this.checks.get(taskId) ?? []; }
  setChecks(taskId: string, checks: CheckResult[]): void {
    this.checks.set(taskId, checks);
    this.#delta.checks.set(taskId, checks);
  }

  addFlag(taskId: string | null, eventId: string, kind: string, detail: string, at: string): void {
    const row = { id: this.nextId('fl'), task_id: taskId, event_id: eventId, kind, detail, at };
    this.flags.push(row);
    this.#delta.flags.push(row);
  }
  flagsForTask(taskId: string): { id: string; event_id: string; kind: string; detail: string; at: string }[] {
    return this.flags
      .filter((f) => f.task_id === taskId)
      .sort((a, b) => compareIso(a.at, b.at) || byIdNumber(a, b))
      .map(({ id, event_id, kind, detail, at }) => ({ id, event_id, kind, detail, at }));
  }

  // ------------------------------------------------------------------ cursors (read here; written through the backend)

  getCursor(agentId: string, taskId: string): number { return this.cursors.get(cursorKey(agentId, taskId)) ?? 0; }
  setCursorLocal(agentId: string, taskId: string, seq: number): void { this.cursors.set(cursorKey(agentId, taskId), seq); }
}

/** The surface the resolver and compiler need. */
export type StateStore = MemoryStore;

/** Merge a working-set delta into an authoritative in-memory store (memory backend). */
export function applyDelta(target: MemoryStore, d: Delta): void {
  for (const row of d.tasks) target.tasks.set(row.spec.id, structuredClone(row));
  for (const [id, version] of d.taskVersions) {
    const row = target.tasks.get(id);
    if (row && version > row.state_version) row.state_version = version;
  }
  for (const e of d.events) target.events.set(e.id, structuredClone(e));
  for (const [id, raw] of d.eventRaw) target.raw.set(id, raw);
  for (const link of d.eventLinks) {
    const e = target.events.get(link.id);
    if (e) { e.task_id = link.task_id; e.link_reason = link.link_reason; }
  }
  for (const t of d.threads) if (!target.threads.has(t.thread_id)) target.threads.set(t.thread_id, { task_id: t.task_id, reason: t.reason });
  for (const x of d.extractions) {
    target.extractions.push(structuredClone(x));
    target.pending.delete(x.event_id);
  }
  for (const a of [...d.artifacts.inserted, ...d.artifacts.updated]) target.artifacts.set(a.id, { ...a });
  for (const c of [...d.claims.inserted, ...d.claims.updated]) target.claims.set(c.id, structuredClone(c));
  for (const e of d.claimEvidence) target.claimEv.push({ ...e });
  for (const o of [...d.obligations.inserted, ...d.obligations.updated]) target.obligations.set(o.id, structuredClone(o));
  for (const t of d.transitions) target.transitions.push(structuredClone(t));
  for (const [id, checks] of d.checks) target.checks.set(id, structuredClone(checks));
  for (const f of d.flags) target.flags.push({ ...f });
  for (const [name, value] of d.counters) target.counters.set(name, Math.max(target.counters.get(name) ?? 0, value));
}
