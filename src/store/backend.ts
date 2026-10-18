// The storage boundary. Three implementations share one contract:
//   postgres  Supabase Postgres, the authoritative store for hosted operation
//   sqlite    a node:sqlite file, the explicitly selected offline mode
//   memory    in-process, for tests, evals and replay
// The contract: load a task snapshot → interpret (no transaction open) → commit, version-checked and atomic.
import type { MemoryStore } from './state.ts';
import type { EventInput, StoredEvent, TaskSpec } from '../types.ts';

export type StorageMode = 'postgres' | 'sqlite' | 'memory';

export interface TaskSnapshot {
  org: string;
  taskId: string;
  /** tasks.state_version when loaded; the commit succeeds only if it is unchanged. */
  version: number;
  store: MemoryStore;
}

export type JobKind = 'interpret_event' | 'deadline' | 'reconcile_action' | 'notify_approval';
export type JobStatus = 'pending' | 'running' | 'done' | 'dead';

export interface JobInput {
  kind: JobKind;
  task_id: string | null;
  event_id?: string | null;
  /** Order within a task: interpretation runs in event order. */
  seq?: number;
  /** At most one job per key ever exists (restart-safe dedupe). */
  dedupe_key: string;
  payload?: Record<string, unknown>;
  /** ISO time; defaults to now. */
  run_after?: string;
  max_attempts?: number;
}

export interface JobRow extends Required<Omit<JobInput, 'event_id' | 'run_after' | 'payload' | 'max_attempts'>> {
  id: string;
  org: string;
  event_id: string | null;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_by: string | null;
  locked_until: string | null;
  last_error: string | null;
}

export type ActionStatus = 'pending' | 'attempted' | 'delivered' | 'replayed' | 'failed';

/** An outbound email, recorded before the provider is called so a crash never loses or doubles it. */
export interface ActionRow {
  id: string;
  org: string;
  task_id: string;
  agent_id: string;
  principal_id: string | null;
  idempotency_key: string;
  based_on_version: number;
  to_addr: string;
  subject: string;
  body: string;
  body_sha256: string;
  in_reply_to: string | null;
  references: string[];
  status: ActionStatus;
  attempts: number;
  provider: Record<string, unknown> | null;
  primitive_email_id: string | null;
  event_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommitOptions {
  /** Mark this job done in the same transaction. */
  completeJobId?: string | null;
  /** Event processing status, written in the same transaction. */
  eventStatus?: { id: string; status: 'interpreted' | 'failed'; error?: string | null } | null;
  /** Follow-up jobs, computed from the state after the apply and enqueued in the same transaction. */
  jobs?: (s: MemoryStore) => JobInput[];
  /** Outbound action rows, written in the same transaction. */
  actions?: ActionRow[];
  /** Skip the version check (task creation). */
  create?: boolean;
}

export type CommitResult<T> =
  | { ok: true; version: number; value: T }
  | { ok: false; reason: 'stale' | 'conflict'; version: number; detail?: string };

export interface ReceiveResult { event: StoredEvent; duplicate: boolean; linked: boolean; requeued: boolean }

/** The lookups the task linker uses (explicit signals only). */
export interface LinkLookup {
  taskForThread(threadId: string): Promise<string | null>;
  eventByPrimitiveEmailId(id: string): Promise<StoredEvent | null>;
  eventByMessageId(id: string): Promise<StoredEvent | null>;
  tasks(): Promise<{ id: string; alias: string }[]>;
}

export interface BlobRef { event_id: string; part_index: number }
export interface BlobIn extends BlobRef {
  sha256: string;
  content_type: string;
  size_bytes: number;
  bytes: Buffer;
  primitive_email_id: string | null;
}

export type PrincipalKind = 'agent' | 'operator' | 'ingest';

/** Whoever holds an API token. */
export interface Principal {
  id: string;
  org: string;
  kind: PrincipalKind;
  /** An agent token acts as exactly this agent id. */
  agent_id: string | null;
  scopes: string[];
  /** null: every task in the org. */
  task_ids: string[] | null;
  label?: string | null;
}

/** An alert raised by Signal (src/signal.ts). One row per distinct alert, kept after its condition clears. */
export interface SignalRow {
  /** stable identity of the condition, e.g. "<task>:overdue:<obligation>" */
  key: string;
  task_id: string;
  rule: string;
  severity: 'high' | 'medium' | 'low';
  summary: string;
  detail: { evidence: string[]; [k: string]: unknown };
  first_seen: string;
  last_seen: string;
  /** null while the condition still holds */
  resolved_at: string | null;
}

export type JobOutcome =
  | { status: 'done' }
  | { status: 'retry'; error: string; runAfter: string }
  | { status: 'dead'; error: string };

export interface Backend {
  readonly mode: StorageMode;
  /** Where the data lives, with secrets removed. */
  readonly target: string;
  init(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<{ ok: boolean; detail: string; schema?: string | null }>;
  ensureOrg(org: string, name?: string): Promise<void>;
  instanceId(org: string): Promise<string>;

  // tasks
  createTask(org: string, spec: TaskSpec, at: string, init: (s: MemoryStore) => void): Promise<void>;
  getTask(org: string, idOrAlias: string): Promise<TaskSpec | null>;
  listTasks(org: string): Promise<{ spec: TaskSpec; state_version: number }[]>;

  // evidence receipt (durable before interpretation)
  receive(org: string, input: EventInput, link: (lookup: LinkLookup) => Promise<{ task_id: string; reason: string } | null>, blobs: BlobIn[]): Promise<ReceiveResult>;
  linkEvent(org: string, eventId: string, taskId: string, reason: string): Promise<StoredEvent>;
  getEvent(org: string, id: string): Promise<StoredEvent | null>;
  getEventRaw(org: string, id: string): Promise<unknown>;
  unlinkedEvents(org: string): Promise<StoredEvent[]>;
  extractionsFor(org: string, eventId: string): Promise<{ extractor: string; proposal: unknown; version?: number }[]>;
  /** The task an item id (ev_ / cl_ / ob_ / ar_) belongs to, or null. */
  findItemTask(org: string, itemId: string): Promise<string | null>;

  // versioned task state
  loadTask(org: string, taskId: string): Promise<TaskSnapshot>;
  /**
   * Tasks with an approval card open as recorded in their transition log: an approval_requested or
   * claim_held_for_verification not yet followed by approval_expired or by an approval_decided other
   * than "held" (src/engine/approval-log.ts openApprovalTaskIds). A superset of the tasks with open
   * approvals: expiry by time and staleness need the loaded task. Unordered.
   */
  openApprovalTaskIds(org: string): Promise<string[]>;
  commit<T>(snap: TaskSnapshot, mutate: (s: MemoryStore) => T, opts?: CommitOptions): Promise<CommitResult<T>>;

  // durable jobs
  enqueue(org: string, jobs: JobInput[]): Promise<void>;
  claimJob(workerId: string, now: string, leaseMs: number, filter?: { org?: string; taskId?: string }): Promise<JobRow | null>;
  finishJob(id: string, outcome: JobOutcome): Promise<void>;
  jobCounts(org?: string): Promise<Record<string, number>>;
  /** Jobs not done yet for a task (the interpretation backlog). */
  pendingJobs(org: string, taskId: string): Promise<JobRow[]>;

  // outbound actions
  getAction(org: string, id: string): Promise<ActionRow | null>;
  getActionByKey(org: string, key: string): Promise<ActionRow | null>;
  listActions(org: string, taskId: string): Promise<ActionRow[]>;
  updateAction(org: string, id: string, fields: Partial<ActionRow>): Promise<ActionRow>;

  // cursors and agent runs
  setCursor(org: string, agentId: string, taskId: string, seq: number, at: string): Promise<void>;
  saveAgentRun(org: string, run: Record<string, unknown>): Promise<string>;
  agentRuns(org: string, taskId: string): Promise<Record<string, unknown>[]>;

  // remembered Signal alerts (not task state: written outside task commits)
  listSignals(org: string, opts?: { includeResolved?: boolean }): Promise<SignalRow[]>;
  /** Insert or replace rows by key. */
  saveSignals(org: string, rows: SignalRow[]): Promise<void>;

  // private attachment cache (Supabase Storage in hosted mode)
  putBlob(org: string, blob: BlobIn): Promise<void>;
  getBlob(org: string, ref: BlobRef): Promise<Buffer | null>;

  // principals (hashed API tokens)
  findPrincipal(tokenHash: string): Promise<Principal | null>;
  createPrincipal(p: Principal, tokenHash: string): Promise<void>;
}

export class StaleStateError extends Error {
  constructor(message = 'task state changed during interpretation') { super(message); }
}

/** Retry delay for a failed job, in ms: 0.5 s doubling up to a minute. */
export function backoffMs(attempt: number): number {
  return Math.min(60_000, 500 * 2 ** Math.max(0, attempt - 1));
}
