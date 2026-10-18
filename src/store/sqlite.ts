// The SQLite backend (node:sqlite): the explicitly selected OFFLINE mode. One file, one organization,
// readable with the sqlite3 CLI. It opens databases written by earlier versions: new columns are added,
// existing tables and rows are never rewritten.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryStore, COMMIT_COUNTERS, type Delta } from './state.ts';
import type {
  ActionRow, Backend, BlobIn, BlobRef, CommitOptions, CommitResult, JobInput, JobOutcome, JobRow, LinkLookup, Principal, ReceiveResult, SignalRow, TaskSnapshot,
} from './backend.ts';
import type { Artifact, Claim, EventInput, Obligation, StoredEvent, TaskSpec } from '../types.ts';
import { stripAttachmentBytes } from './rows.ts';

export const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, alias TEXT UNIQUE, spec_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_threads (thread_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, dedupe_key TEXT NOT NULL UNIQUE, task_id TEXT, link_reason TEXT,
  source TEXT NOT NULL, direction TEXT NOT NULL, primitive_event_id TEXT, primitive_email_id TEXT, reply_to_sent_email_id TEXT,
  thread_id TEXT, message_id TEXT, in_reply_to TEXT, references_json TEXT NOT NULL,
  from_addr TEXT NOT NULL, from_name TEXT, to_json TEXT NOT NULL, cc_json TEXT NOT NULL,
  subject TEXT NOT NULL, body_text TEXT NOT NULL, occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
  auth_verdict TEXT, attachments_json TEXT NOT NULL, raw_json TEXT
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, seq);
CREATE INDEX IF NOT EXISTS events_msgid ON events(message_id);
CREATE TABLE IF NOT EXISTS extractions (event_id TEXT NOT NULL, extractor TEXT NOT NULL, proposal_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, event_id TEXT NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL,
  sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, kind TEXT NOT NULL, version_label TEXT, text TEXT NOT NULL,
  status TEXT NOT NULL, superseded_by TEXT, owner TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, display TEXT NOT NULL,
  kind TEXT NOT NULL, speaker TEXT NOT NULL, source_event_id TEXT NOT NULL, source_artifact_id TEXT, evidence TEXT NOT NULL,
  status TEXT NOT NULL, superseded_by TEXT, supersede_reason TEXT, learned_at TEXT NOT NULL, confidence REAL NOT NULL,
  extractor TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_task_key ON claims(task_id, key);
CREATE TABLE IF NOT EXISTS claim_evidence (claim_id TEXT NOT NULL, event_id TEXT NOT NULL, artifact_id TEXT, quote TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS obligations (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, debtor TEXT NOT NULL, creditor TEXT NOT NULL, text TEXT NOT NULL,
  topic_keys_json TEXT NOT NULL, expects_artifact TEXT, status TEXT NOT NULL, source_event_id TEXT NOT NULL, evidence TEXT NOT NULL,
  resolved_by_event_id TEXT, resolution_note TEXT, created_at TEXT NOT NULL, resolved_at TEXT, confidence REAL NOT NULL,
  notes_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transitions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, event_id TEXT, at TEXT NOT NULL, type TEXT NOT NULL,
  subject_id TEXT, summary TEXT NOT NULL, detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS transitions_approval ON transitions(type, task_id, seq)
  WHERE type IN ('approval_requested', 'claim_held_for_verification', 'approval_decided', 'approval_expired');
CREATE TABLE IF NOT EXISTS checks (task_id TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (task_id, id));
CREATE TABLE IF NOT EXISTS flags (id TEXT PRIMARY KEY, task_id TEXT, event_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cursors (agent_id TEXT NOT NULL, task_id TEXT NOT NULL, last_seq INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (agent_id, task_id));
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, started_at TEXT NOT NULL, mode TEXT NOT NULL,
  context_json TEXT, briefing TEXT, context_tokens INTEGER, transcript_tokens INTEGER, decision_json TEXT, sent_event_id TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, task_id TEXT, event_id TEXT, seq INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5, run_after TEXT NOT NULL, locked_by TEXT, locked_until TEXT, last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status, run_after);
CREATE TABLE IF NOT EXISTS outbound_actions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, json TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachment_blobs (
  event_id TEXT NOT NULL, part_index INTEGER NOT NULL, sha256 TEXT NOT NULL, content_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  primitive_email_id TEXT, bytes BLOB NOT NULL, PRIMARY KEY (event_id, part_index)
);
CREATE TABLE IF NOT EXISTS principals (token_hash TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS signals (
  key TEXT PRIMARY KEY, task_id TEXT NOT NULL, rule TEXT NOT NULL, severity TEXT NOT NULL, summary TEXT NOT NULL,
  detail_json TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, resolved_at TEXT
);
`;

/** Columns added since the first version; each is tried and skipped when already present. */
const ADDED_COLUMNS = [
  'ALTER TABLE obligations ADD COLUMN due_at TEXT',
  'ALTER TABLE obligations ADD COLUMN ext_json TEXT',
  'ALTER TABLE events ADD COLUMN processing_status TEXT',
  'ALTER TABLE events ADD COLUMN processing_error TEXT',
  'ALTER TABLE extractions ADD COLUMN version INTEGER',
  'ALTER TABLE tasks ADD COLUMN state_version INTEGER',
  'ALTER TABLE agent_runs ADD COLUMN ext_json TEXT',
  'ALTER TABLE events ADD COLUMN time_flags_json TEXT',
];

/** Obligation fields kept together in ext_json. */
const OBLIGATION_EXT = ['issue_key', 'group_id', 'quantity', 'fulfilled_quantity', 'artifact_match', 'condition', 'condition_met_at'] as const;
/** Agent-run fields kept together in ext_json. */
const RUN_EXT = ['state_version', 'context_digest', 'usage', 'actions', 'principal_id', 'purpose', 'budget'] as const;

type Row = Record<string, unknown>;
const toJson = (v: unknown) => JSON.stringify(v ?? null);
function fromJson<T>(text: unknown, fallback: T): T {
  return typeof text === 'string' ? (JSON.parse(text) as T) : fallback;
}
const httpError = (message: string, status: number) => Object.assign(new Error(message), { status });
const EPOCH = new Date(0).toISOString();

export class SqliteBackend implements Backend {
  readonly mode = 'sqlite' as const;
  readonly target: string;
  readonly readOnly: boolean;
  db: DatabaseSync;
  org: string | null = null;
  readonly #statements = new Map<string, StatementSync>();

  /** `readOnly` opens an existing file without any schema change (an import source stays untouched). */
  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    this.readOnly = !!opts.readOnly;
    this.target = path === ':memory:' ? 'sqlite :memory:' : `sqlite file ${path}${this.readOnly ? ' (read-only)' : ''}`;
    if (this.readOnly) {
      this.db = new DatabaseSync(path, { readOnly: true });
      return;
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SQLITE_SCHEMA);
    for (const ddl of ADDED_COLUMNS) {
      try { this.db.exec(ddl); } catch { /* already there */ }
    }
    // a database from an earlier version: seed the transition counter and per-task versions from its rows
    this.db.prepare("INSERT OR IGNORE INTO counters(name, value) VALUES ('tr', (SELECT COALESCE(MAX(seq), 0) FROM transitions))").run();
    this.db.prepare('UPDATE tasks SET state_version = (SELECT COALESCE(MAX(seq), 0) FROM transitions t WHERE t.task_id = tasks.id) WHERE state_version IS NULL').run();
  }

  #q(sql: string): StatementSync {
    let st = this.#statements.get(sql);
    if (!st) this.#statements.set(sql, (st = this.db.prepare(sql)));
    return st;
  }

  #tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  #next(prefix: string): number {
    return (this.#q('INSERT INTO counters(name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value').get(prefix) as { value: number }).value;
  }

  #counters(): Record<string, number> {
    return Object.fromEntries((this.#q('SELECT name, value FROM counters').all() as { name: string; value: number }[]).map((r) => [r.name, r.value]));
  }

  async init() {}
  async close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
  async health() {
    this.db.prepare('SELECT 1').get();
    return { ok: true, detail: this.target, schema: 'sqlite-compat' };
  }

  // ------------------------------------------------------------------ the file's organization

  #storedOrg(): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key = 'org'").get() as { value: string } | undefined)?.value;
  }
  async ensureOrg(org: string) {
    if (this.readOnly) { this.org = org; return; }
    const stored = this.#storedOrg();
    if (!stored) this.#q("INSERT OR IGNORE INTO meta(key, value) VALUES ('org', ?)").run(org);
    this.org = stored ?? org;
  }
  /** A file belongs to one org; any other org gets "not found". */
  #checkOrg(org: string) {
    if (this.readOnly) return;
    this.org ??= this.#storedOrg() ?? org;
    if (org !== this.org) throw httpError(`this SQLite file belongs to ${this.org}`, 404);
  }

  async instanceId(org: string) {
    this.#checkOrg(org);
    this.#q('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('instance_id', randomUUID());
    return (this.#q('SELECT value FROM meta WHERE key = ?').get('instance_id') as { value: string }).value;
  }

  // ------------------------------------------------------------------ tasks

  #versionFromTransitions(taskId: string): number {
    return (this.#q('SELECT COALESCE(MAX(seq), 0) AS v FROM transitions WHERE task_id = ?').get(taskId) as { v: number }).v;
  }

  async createTask(org: string, spec: TaskSpec, at: string, init: (s: MemoryStore) => void) {
    this.#checkOrg(org);
    if (await this.getTask(org, spec.id) || await this.getTask(org, spec.alias)) throw httpError(`task ${spec.id} exists`, 409);
    const work = new MemoryStore();
    this.#tx(() => {
      work.resetCounters(this.#counters());
      work.createTask(spec, at);
      init(work);
      this.#flush(work.takeDelta());
    });
  }
  async getTask(org: string, idOrAlias: string) {
    this.#checkOrg(org);
    const row = this.#q('SELECT spec_json FROM tasks WHERE id = ? OR alias = ?').get(idOrAlias, idOrAlias) as Row | undefined;
    return row ? fromJson<TaskSpec>(row.spec_json, null as never) : null;
  }
  async listTasks(org: string) {
    this.#checkOrg(org);
    return (this.#q('SELECT * FROM tasks ORDER BY created_at').all() as Row[]).map((r) => ({
      spec: fromJson<TaskSpec>(r.spec_json, null as never),
      state_version: (r.state_version as number | null) ?? this.#versionFromTransitions(String(r.id)),
    }));
  }

  // ------------------------------------------------------------------ receipt

  #event(where: string, ...args: (string | number)[]): StoredEvent | null {
    const row = this.#q(`SELECT * FROM events WHERE ${where}`).get(...args) as Row | undefined;
    return row ? rowToEvent(row) : null;
  }

  async receive(org: string, input: EventInput, link: (l: LinkLookup) => Promise<{ task_id: string; reason: string } | null>, blobs: BlobIn[]): Promise<ReceiveResult> {
    this.#checkOrg(org);
    const existing = this.#event('dedupe_key = ?', input.dedupe_key);
    if (existing) return { event: existing, duplicate: true, linked: !!existing.task_id, requeued: existing.task_id ? this.#rearm(existing) : false };

    const target = await link({
      taskForThread: async (t) => (this.#q('SELECT task_id FROM task_threads WHERE thread_id = ?').get(t) as { task_id: string } | undefined)?.task_id ?? null,
      eventByPrimitiveEmailId: async (id) => this.#event('primitive_email_id = ? ORDER BY seq LIMIT 1', id),
      eventByMessageId: async (id) => this.#event('message_id = ? ORDER BY seq LIMIT 1', id),
      tasks: async () => this.#q('SELECT id, alias FROM tasks ORDER BY created_at').all() as { id: string; alias: string }[],
    });

    const id = this.#tx(() => {
      if (this.#event('dedupe_key = ?', input.dedupe_key)) return null; // raced with another delivery
      let seq: number;
      if (input.preserve_seq) {
        seq = input.preserve_seq;
        this.#q("INSERT INTO counters(name, value) VALUES ('ev', ?) ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)").run(seq);
      } else {
        seq = this.#next('ev');
      }
      const eventId = `ev_${seq}`;
      const e = stripAttachmentBytes(input);
      this.#q(`INSERT INTO events(id, seq, dedupe_key, task_id, link_reason, source, direction, primitive_event_id, primitive_email_id,
        reply_to_sent_email_id, thread_id, message_id, in_reply_to, references_json, from_addr, from_name, to_json, cc_json, subject,
        body_text, occurred_at, received_at, auth_verdict, attachments_json, raw_json, processing_status, time_flags_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        eventId, seq, e.dedupe_key, target?.task_id ?? null, target?.reason ?? null, e.source, e.direction, e.primitive_event_id ?? null,
        e.primitive_email_id ?? null, e.reply_to_sent_email_id ?? null, e.thread_id, e.message_id, e.in_reply_to, toJson(e.references),
        e.from, e.from_name ?? null, toJson(e.to), toJson(e.cc), e.subject, e.body_text, e.occurred_at, e.received_at,
        e.auth_verdict ?? null, toJson(e.attachments), input.raw === undefined ? null : toJson(input.raw), target ? 'received' : 'unlinked',
        e.time_flags?.length ? toJson(e.time_flags) : null,
      );
      if (target && e.thread_id) this.#mapThread(e.thread_id, target.task_id, `${eventId}: ${target.reason}`);
      for (const b of blobs) this.#putBlob({ ...b, event_id: eventId });
      if (target) this.#enqueue([{ kind: 'interpret_event', task_id: target.task_id, event_id: eventId, seq, dedupe_key: `interpret:${eventId}` }]);
      return eventId;
    });
    if (!id) return this.receive(org, input, link, blobs);
    return { event: (await this.getEvent(org, id))!, duplicate: false, linked: !!target, requeued: false };
  }

  #mapThread(threadId: string, taskId: string, reason: string) {
    this.#q('INSERT OR IGNORE INTO task_threads(thread_id, task_id, reason) VALUES (?, ?, ?)').run(threadId, taskId, reason);
  }

  /** A redelivered, never-interpreted event gets its interpretation job back. */
  #rearm(ev: StoredEvent): boolean {
    if (this.#q('SELECT 1 FROM extractions WHERE event_id = ?').get(ev.id)) return false;
    const job = this.#q('SELECT id, status FROM jobs WHERE dedupe_key = ?').get(`interpret:${ev.id}`) as { id: number; status: string } | undefined;
    if (!job) {
      this.#enqueue([{ kind: 'interpret_event', task_id: ev.task_id, event_id: ev.id, seq: ev.seq, dedupe_key: `interpret:${ev.id}` }]);
      return true;
    }
    if (job.status === 'dead') {
      this.#q("UPDATE jobs SET status = 'pending', attempts = 0, run_after = ?, last_error = NULL WHERE id = ?").run(EPOCH, job.id);
      this.#q("UPDATE events SET processing_status = 'received' WHERE id = ?").run(ev.id);
      return true;
    }
    return false;
  }

  async linkEvent(org: string, eventId: string, taskId: string, reason: string) {
    this.#checkOrg(org);
    const ev = await this.getEvent(org, eventId);
    if (!ev) throw httpError(`no event ${eventId}`, 404);
    if (!ev.task_id) {
      this.#tx(() => {
        this.#q("UPDATE events SET task_id = ?, link_reason = ?, processing_status = 'received' WHERE id = ?").run(taskId, reason, eventId);
        if (ev.thread_id) this.#mapThread(ev.thread_id, taskId, `manual link of ${eventId}`);
        this.#enqueue([{ kind: 'interpret_event', task_id: taskId, event_id: eventId, seq: ev.seq, dedupe_key: `interpret:${eventId}` }]);
      });
    }
    return (await this.getEvent(org, eventId))!;
  }

  async getEvent(org: string, id: string) {
    this.#checkOrg(org);
    return this.#event('id = ?', id);
  }
  async getEventRaw(org: string, id: string) {
    this.#checkOrg(org);
    return fromJson((this.#q('SELECT raw_json FROM events WHERE id = ?').get(id) as Row | undefined)?.raw_json, null);
  }
  async unlinkedEvents(org: string) {
    this.#checkOrg(org);
    return (this.#q('SELECT * FROM events WHERE task_id IS NULL ORDER BY seq').all() as Row[]).map(rowToEvent);
  }
  async extractionsFor(org: string, id: string) {
    this.#checkOrg(org);
    const rows = this.#q('SELECT extractor, proposal_json, version FROM extractions WHERE event_id = ? ORDER BY rowid').all(id) as Row[];
    return rows.map((r, i) => ({ extractor: String(r.extractor), proposal: fromJson(r.proposal_json, null), version: (r.version as number | null) ?? i + 1 }));
  }
  async findItemTask(org: string, itemId: string) {
    this.#checkOrg(org);
    const table = ({ ev: 'events', cl: 'claims', ob: 'obligations', ar: 'artifacts' } as Record<string, string>)[itemId.split('_')[0]];
    if (!table) return null;
    return ((this.#q(`SELECT task_id FROM ${table} WHERE id = ?`).get(itemId) as Row | undefined)?.task_id as string | null) ?? null;
  }

  // ------------------------------------------------------------------ snapshot

  async loadTask(org: string, taskId: string): Promise<TaskSnapshot> {
    this.#checkOrg(org);
    const store = this.#load(taskId);
    return { org, taskId, version: store.stateVersion(taskId), store };
  }

  #load(taskId: string): MemoryStore {
    const s = new MemoryStore();
    const task = this.#q('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
    if (!task) throw httpError(`unknown task ${taskId}`, 404);
    s.tasks.set(taskId, {
      spec: fromJson<TaskSpec>(task.spec_json, null as never),
      created_at: String(task.created_at),
      state_version: (task.state_version as number | null) ?? this.#versionFromTransitions(taskId),
    });

    for (const r of this.#q('SELECT * FROM events WHERE task_id = ? ORDER BY seq').all(taskId) as Row[]) {
      const e = rowToEvent(r);
      s.events.set(e.id, e);
      if (r.processing_status === 'failed') s.failed.add(e.id);
      // who sent our own mail: staleness checks tell an agent's own sends from someone else's changes
      if (e.direction === 'outbound' && r.raw_json) {
        const raw = fromJson<Record<string, unknown> | null>(r.raw_json, null);
        if (raw?.sent_by_agent) s.raw.set(e.id, { sent_by_agent: raw.sent_by_agent, action_id: raw.action_id ?? null });
      }
    }
    for (const r of this.#q('SELECT thread_id, task_id, reason FROM task_threads WHERE task_id = ?').all(taskId) as Row[]) {
      s.threads.set(String(r.thread_id), { task_id: String(r.task_id), reason: String(r.reason) });
    }
    for (const r of this.#q('SELECT x.* FROM extractions x JOIN events e ON e.id = x.event_id WHERE e.task_id = ? ORDER BY x.rowid').all(taskId) as Row[]) {
      const eventId = String(r.event_id);
      s.extractions.push({
        event_id: eventId, extractor: String(r.extractor), proposal: fromJson(r.proposal_json, null), created_at: String(r.created_at),
        version: (r.version as number | null) ?? s.extractions.filter((x) => x.event_id === eventId).length + 1,
      });
    }
    for (const r of this.#q('SELECT * FROM artifacts WHERE task_id = ? ORDER BY rowid').all(taskId) as Row[]) {
      const a = rowToArtifact(r);
      s.artifacts.set(a.id, a);
    }
    for (const r of this.#q('SELECT * FROM claims WHERE task_id = ?').all(taskId) as Row[]) {
      const c = rowToClaim(r);
      s.claims.set(c.id, c);
    }
    const evidence = this.#q(`SELECT ce.claim_id, ce.event_id, ce.artifact_id, ce.quote FROM claim_evidence ce
      JOIN claims c ON c.id = ce.claim_id WHERE c.task_id = ? ORDER BY ce.rowid`).all(taskId) as Row[];
    for (const r of evidence) {
      s.claimEv.push({ claim_id: String(r.claim_id), event_id: String(r.event_id), artifact_id: (r.artifact_id as string | null) ?? null, quote: String(r.quote) });
    }
    for (const r of this.#q('SELECT * FROM obligations WHERE task_id = ?').all(taskId) as Row[]) {
      const o = rowToObligation(r);
      s.obligations.set(o.id, o);
    }
    for (const r of this.#q('SELECT * FROM transitions WHERE task_id = ? ORDER BY seq').all(taskId) as Row[]) {
      s.transitions.push({
        seq: Number(r.seq), task_id: String(r.task_id), event_id: (r.event_id as string | null) ?? null, at: String(r.at),
        type: String(r.type), subject_id: (r.subject_id as string | null) ?? null, summary: String(r.summary), detail: fromJson(r.detail_json, {}),
      });
    }
    s.checks.set(taskId, (this.#q('SELECT json FROM checks WHERE task_id = ? ORDER BY rowid').all(taskId) as Row[]).map((r) => fromJson(r.json, null as never)));
    for (const r of this.#q('SELECT * FROM flags WHERE task_id = ?').all(taskId) as Row[]) {
      s.flags.push({ id: String(r.id), task_id: String(r.task_id), event_id: String(r.event_id), kind: String(r.kind), detail: String(r.detail), at: String(r.at) });
    }
    for (const r of this.#q('SELECT agent_id, last_seq FROM cursors WHERE task_id = ?').all(taskId) as Row[]) {
      s.setCursorLocal(String(r.agent_id), taskId, Number(r.last_seq));
    }
    s.resetCounters(this.#counters());
    let instance: { value: string } | undefined;
    try {
      instance = this.db.prepare("SELECT value FROM meta WHERE key = 'instance_id'").get() as { value: string } | undefined;
    } catch { /* a database from before the meta table */ }
    if (instance) s.meta.set('instance_id', instance.value);
    s.discardDelta();
    return s;
  }

  async openApprovalTaskIds(org: string): Promise<string[]> {
    this.#checkOrg(org);
    // a card stays open unless the latest decision/expiry naming it (after it, same task) closed it
    const rows = this.#q(`SELECT DISTINCT o.task_id FROM transitions o
      WHERE (o.type = 'approval_requested' OR (o.type = 'claim_held_for_verification' AND o.subject_id IS NOT NULL))
        AND COALESCE((SELECT c.type = 'approval_decided' AND COALESCE(json_extract(c.detail_json, '$.status'), '') = 'held'
          FROM transitions c
          WHERE c.type IN ('approval_decided', 'approval_expired') AND c.task_id = o.task_id AND c.seq > o.seq
            AND COALESCE(json_extract(c.detail_json, '$.approval_id'), c.subject_id) = 'ap_' || o.seq
          ORDER BY c.seq DESC LIMIT 1), 1)`).all() as Row[];
    return rows.map((r) => String(r.task_id));
  }

  // ------------------------------------------------------------------ commit

  async commit<T>(snap: TaskSnapshot, mutate: (s: MemoryStore) => T, opts: CommitOptions = {}): Promise<CommitResult<T>> {
    this.#checkOrg(snap.org);
    return this.#tx((): CommitResult<T> => {
      const version = ((this.#q('SELECT state_version FROM tasks WHERE id = ?').get(snap.taskId) as Row | undefined)?.state_version as number | undefined) ?? 0;
      if (version !== snap.version) return { ok: false, reason: 'stale', version };
      if (opts.actions?.length) {
        const mine = new Set(opts.actions.map((a) => a.idempotency_key));
        const inFlight = (this.#q("SELECT idempotency_key FROM outbound_actions WHERE task_id = ? AND status IN ('pending', 'attempted')").all(snap.taskId) as Row[])
          .filter((r) => !mine.has(String(r.idempotency_key)));
        if (inFlight.length) return { ok: false, reason: 'conflict', version, detail: 'another send for this task is in flight' };
      }
      const work = snap.store;
      work.discardDelta();
      const counters = this.#counters();
      work.resetCounters(Object.fromEntries(COMMIT_COUNTERS.map((k) => [k, counters[k] ?? 0])));
      const value = mutate(work);
      const jobs = opts.jobs?.(work) ?? [];
      this.#flush(work.takeDelta());
      if (opts.eventStatus) {
        this.#q('UPDATE events SET processing_status = ?, processing_error = ? WHERE id = ?').run(opts.eventStatus.status, opts.eventStatus.error ?? null, opts.eventStatus.id);
      }
      if (opts.completeJobId) this.#q("UPDATE jobs SET status = 'done', locked_until = NULL WHERE id = ?").run(Number(opts.completeJobId));
      for (const a of opts.actions ?? []) {
        this.#q('INSERT INTO outbound_actions(id, task_id, json, idempotency_key, status) VALUES (?, ?, ?, ?, ?)').run(a.id, a.task_id, toJson(a), a.idempotency_key, a.status);
      }
      this.#enqueue(jobs);
      snap.version = work.stateVersion(snap.taskId);
      return { ok: true, version: snap.version, value };
    });
  }

  /** Write a delta. */
  #flush(d: Delta) {
    for (const t of d.tasks) {
      this.#q('INSERT INTO tasks(id, alias, spec_json, created_at, state_version) VALUES (?, ?, ?, ?, ?)').run(t.spec.id, t.spec.alias, toJson(t.spec), t.created_at, t.state_version);
    }
    for (const [id, version] of d.taskVersions) {
      this.#q('UPDATE tasks SET state_version = MAX(COALESCE(state_version, 0), ?) WHERE id = ?').run(version, id);
    }
    for (const link of d.eventLinks) this.#q('UPDATE events SET task_id = ?, link_reason = ? WHERE id = ?').run(link.task_id, link.link_reason, link.id);
    for (const t of d.threads) this.#mapThread(t.thread_id, t.task_id, t.reason);
    for (const x of d.extractions) {
      this.#q('INSERT INTO extractions(event_id, extractor, proposal_json, created_at, version) VALUES (?, ?, ?, ?, ?)').run(x.event_id, x.extractor, toJson(x.proposal), x.created_at, x.version);
    }
    for (const a of [...d.artifacts.inserted, ...d.artifacts.updated]) {
      this.#q(`INSERT OR REPLACE INTO artifacts(id, task_id, event_id, filename, content_type, sha256, size_bytes, kind, version_label, text,
        status, superseded_by, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        a.id, a.task_id, a.event_id, a.filename, a.content_type, a.sha256, a.size_bytes, a.kind, a.version_label, a.text, a.status, a.superseded_by, a.owner,
      );
    }
    for (const c of [...d.claims.inserted, ...d.claims.updated]) {
      this.#q(`INSERT OR REPLACE INTO claims(id, task_id, key, value_json, display, kind, speaker, source_event_id, source_artifact_id, evidence,
        status, superseded_by, supersede_reason, learned_at, confidence, extractor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        c.id, c.task_id, c.key, toJson(c.value), c.display, c.kind, c.speaker, c.source_event_id, c.source_artifact_id, c.evidence, c.status,
        c.superseded_by, c.supersede_reason, c.learned_at, c.confidence, c.extractor,
      );
    }
    for (const e of d.claimEvidence) {
      this.#q('INSERT INTO claim_evidence(claim_id, event_id, artifact_id, quote) VALUES (?, ?, ?, ?)').run(e.claim_id, e.event_id, e.artifact_id, e.quote);
    }
    for (const o of [...d.obligations.inserted, ...d.obligations.updated]) {
      const ext = Object.fromEntries(OBLIGATION_EXT.map((k) => [k, o[k] ?? null]));
      this.#q(`INSERT OR REPLACE INTO obligations(id, task_id, kind, debtor, creditor, text, topic_keys_json, expects_artifact, status,
        source_event_id, evidence, resolved_by_event_id, resolution_note, created_at, resolved_at, confidence, notes_json, due_at, ext_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        o.id, o.task_id, o.kind, o.debtor, o.creditor, o.text, toJson(o.topic_keys), o.expects_artifact, o.status, o.source_event_id, o.evidence,
        o.resolved_by_event_id, o.resolution_note, o.created_at, o.resolved_at, o.confidence, toJson(o.notes), o.due_at, toJson(ext),
      );
    }
    for (const t of d.transitions) {
      this.#q('INSERT INTO transitions(seq, task_id, event_id, at, type, subject_id, summary, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        t.seq, t.task_id, t.event_id, t.at, t.type, t.subject_id, t.summary, toJson(t.detail),
      );
    }
    for (const [taskId, checks] of d.checks) {
      this.#q('DELETE FROM checks WHERE task_id = ?').run(taskId);
      for (const c of checks) this.#q('INSERT INTO checks(task_id, id, json) VALUES (?, ?, ?)').run(taskId, c.id, toJson(c));
    }
    for (const f of d.flags) {
      this.#q('INSERT INTO flags(id, task_id, event_id, kind, detail, at) VALUES (?, ?, ?, ?, ?, ?)').run(f.id, f.task_id, f.event_id, f.kind, f.detail, f.at);
    }
    for (const [name, value] of d.counters) {
      this.#q('INSERT INTO counters(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)').run(name, value);
    }
  }

  // ------------------------------------------------------------------ jobs

  async enqueue(org: string, jobs: JobInput[]) {
    this.#checkOrg(org);
    this.#enqueue(jobs);
  }
  #enqueue(jobs: JobInput[]) {
    for (const j of jobs) {
      this.#q(`INSERT OR IGNORE INTO jobs(kind, task_id, event_id, seq, dedupe_key, payload_json, status, max_attempts, run_after, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(
        j.kind, j.task_id, j.event_id ?? null, j.seq ?? 0, j.dedupe_key, toJson(j.payload ?? {}), j.max_attempts ?? 5, j.run_after ?? EPOCH, new Date().toISOString(),
      );
    }
  }

  async claimJob(workerId: string, now: string, leaseMs: number, filter: { org?: string; taskId?: string } = {}) {
    if (filter.org && this.org && filter.org !== this.org) return null;
    return this.#tx(() => {
      const row = this.#q(`SELECT * FROM jobs j
        WHERE ((j.status = 'pending' AND j.run_after <= ?) OR (j.status = 'running' AND j.locked_until <= ?))
          AND (? IS NULL OR j.task_id = ?)
          AND (j.task_id IS NULL OR NOT EXISTS (SELECT 1 FROM jobs k WHERE k.task_id = j.task_id AND k.id <> j.id AND (
            (k.status = 'running' AND k.locked_until > ?) OR
            (j.kind = 'interpret_event' AND k.kind = 'interpret_event' AND k.status IN ('pending', 'running') AND k.seq < j.seq))))
        ORDER BY j.run_after, j.seq, j.id LIMIT 1`).get(now, now, filter.taskId ?? null, filter.taskId ?? null, now) as Row | undefined;
      if (!row) return null;
      const until = new Date(Date.parse(now) + leaseMs).toISOString();
      this.#q("UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = ?, locked_until = ? WHERE id = ?").run(workerId, until, row.id as number);
      if (row.kind === 'interpret_event' && row.event_id) {
        this.#q("UPDATE events SET processing_status = 'interpreting' WHERE id = ? AND processing_status <> 'interpreted'").run(row.event_id as string);
      }
      return rowToJob({ ...row, status: 'running', attempts: (row.attempts as number) + 1, locked_by: workerId, locked_until: until }, this.org ?? 'org_local');
    });
  }

  async finishJob(id: string, outcome: JobOutcome) {
    const jobId = Number(id);
    if (outcome.status === 'done') {
      this.#q("UPDATE jobs SET status = 'done', locked_until = NULL, locked_by = NULL WHERE id = ? AND status <> 'done'").run(jobId);
    } else if (outcome.status === 'retry') {
      this.#q("UPDATE jobs SET status = 'pending', last_error = ?, run_after = ?, locked_until = NULL, locked_by = NULL WHERE id = ? AND status <> 'done'").run(outcome.error, outcome.runAfter, jobId);
    } else {
      this.#tx(() => {
        this.#q("UPDATE jobs SET status = 'dead', last_error = ?, locked_until = NULL, locked_by = NULL WHERE id = ? AND status <> 'done'").run(outcome.error, jobId);
        const eventId = (this.#q("SELECT event_id FROM jobs WHERE id = ? AND kind = 'interpret_event'").get(jobId) as { event_id: string } | undefined)?.event_id;
        if (eventId) this.#q("UPDATE events SET processing_status = 'failed', processing_error = ? WHERE id = ?").run(outcome.error, eventId);
      });
    }
  }

  async jobCounts() {
    return Object.fromEntries((this.#q('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all() as { status: string; n: number }[]).map((r) => [r.status, r.n]));
  }
  async pendingJobs(org: string, taskId: string) {
    this.#checkOrg(org);
    return (this.#q("SELECT * FROM jobs WHERE task_id = ? AND status IN ('pending', 'running') ORDER BY seq, id").all(taskId) as Row[]).map((r) => rowToJob(r, org));
  }

  // ------------------------------------------------------------------ actions

  #action(where: string, arg: string): ActionRow | null {
    return fromJson<ActionRow | null>((this.#q(`SELECT json FROM outbound_actions WHERE ${where}`).get(arg) as Row | undefined)?.json, null);
  }
  async getAction(org: string, id: string) {
    this.#checkOrg(org);
    return this.#action('id = ?', id);
  }
  async getActionByKey(org: string, idempotencyKey: string) {
    this.#checkOrg(org);
    return this.#action('idempotency_key = ?', idempotencyKey);
  }
  async listActions(org: string, taskId: string) {
    this.#checkOrg(org);
    return (this.#q('SELECT json FROM outbound_actions WHERE task_id = ? ORDER BY rowid').all(taskId) as Row[]).map((r) => fromJson<ActionRow>(r.json, null as never));
  }
  async updateAction(org: string, id: string, fields: Partial<ActionRow>) {
    const current = await this.getAction(org, id);
    if (!current) throw new Error(`no action ${id}`);
    const next = { ...current, ...fields, updated_at: new Date().toISOString() };
    this.#q('UPDATE outbound_actions SET json = ?, status = ? WHERE id = ?').run(toJson(next), next.status, id);
    return next;
  }

  // ------------------------------------------------------------------ cursors and runs

  async setCursor(org: string, agentId: string, taskId: string, seq: number, at: string) {
    this.#checkOrg(org);
    this.#q(`INSERT INTO cursors(agent_id, task_id, last_seq, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, task_id) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at`).run(agentId, taskId, seq, at);
  }

  async saveAgentRun(org: string, run: Record<string, unknown>) {
    this.#checkOrg(org);
    const id = typeof run.id === 'string' ? run.id : `run_${this.#next('run')}`;
    const ext = Object.fromEntries(RUN_EXT.map((k) => [k, run[k] ?? null]));
    this.#q(`INSERT INTO agent_runs(id, task_id, agent_id, started_at, mode, context_json, briefing, context_tokens, transcript_tokens,
      decision_json, sent_event_id, ext_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET decision_json = excluded.decision_json, sent_event_id = excluded.sent_event_id, ext_json = excluded.ext_json`).run(
      id, String(run.task_id), String(run.agent_id), String(run.started_at), String(run.mode), toJson(run.context),
      (run.briefing as string) ?? null, (run.context_tokens as number) ?? null, (run.transcript_tokens as number) ?? null,
      toJson(run.decision), (run.sent_event_id as string) ?? null, toJson(ext),
    );
    return id;
  }

  async agentRuns(org: string, taskId: string) {
    this.#checkOrg(org);
    return (this.#q('SELECT * FROM agent_runs WHERE task_id = ? ORDER BY started_at, rowid').all(taskId) as Row[]).map((r) => {
      const { context_json, decision_json, ext_json, ...columns } = r;
      return { ...columns, ...fromJson<Row>(ext_json, {}), context: fromJson(context_json, null), decision: fromJson(decision_json, null) };
    });
  }

  // ------------------------------------------------------------------ remembered Signal alerts

  async listSignals(org: string, opts: { includeResolved?: boolean } = {}) {
    this.#checkOrg(org);
    const where = opts.includeResolved ? '' : 'WHERE resolved_at IS NULL';
    return (this.#q(`SELECT * FROM signals ${where} ORDER BY first_seen, key`).all() as Row[]).map((r) => {
      const { detail_json, ...columns } = r;
      return { ...(columns as unknown as SignalRow), detail: fromJson(detail_json, { evidence: [] }) };
    });
  }
  async saveSignals(org: string, rows: SignalRow[]) {
    this.#checkOrg(org);
    this.#tx(() => {
      for (const s of rows) {
        this.#q(`INSERT OR REPLACE INTO signals(key, task_id, rule, severity, summary, detail_json, first_seen, last_seen, resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.key, s.task_id, s.rule, s.severity, s.summary, toJson(s.detail), s.first_seen, s.last_seen, s.resolved_at);
      }
    });
  }

  // ------------------------------------------------------------------ blobs and principals

  #putBlob(b: BlobIn) {
    this.#q(`INSERT OR REPLACE INTO attachment_blobs(event_id, part_index, sha256, content_type, size_bytes, primitive_email_id, bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(b.event_id, b.part_index, b.sha256, b.content_type, b.size_bytes, b.primitive_email_id, b.bytes);
  }
  async putBlob(org: string, b: BlobIn) {
    this.#checkOrg(org);
    this.#putBlob(b);
  }
  async getBlob(org: string, ref: BlobRef) {
    this.#checkOrg(org);
    const row = this.#q('SELECT bytes FROM attachment_blobs WHERE event_id = ? AND part_index = ?').get(ref.event_id, ref.part_index) as { bytes: Uint8Array } | undefined;
    return row ? Buffer.from(row.bytes) : null;
  }

  async findPrincipal(hash: string) {
    return fromJson<Principal | null>((this.#q('SELECT json FROM principals WHERE token_hash = ?').get(hash) as Row | undefined)?.json, null);
  }
  async createPrincipal(p: Principal, hash: string) {
    this.#q('INSERT INTO principals(token_hash, json) VALUES (?, ?)').run(hash, toJson(p));
  }
}

// ------------------------------------------------------------------ row mappers

const str = (v: unknown) => (v == null ? null : String(v));

export function rowToEvent(r: Row): StoredEvent {
  return {
    id: String(r.id), seq: Number(r.seq), dedupe_key: String(r.dedupe_key), task_id: str(r.task_id), link_reason: str(r.link_reason),
    source: r.source as StoredEvent['source'], direction: r.direction as StoredEvent['direction'],
    primitive_event_id: str(r.primitive_event_id), primitive_email_id: str(r.primitive_email_id), reply_to_sent_email_id: str(r.reply_to_sent_email_id),
    thread_id: str(r.thread_id), message_id: str(r.message_id), in_reply_to: str(r.in_reply_to), references: fromJson(r.references_json, []),
    from: String(r.from_addr), from_name: str(r.from_name), to: fromJson(r.to_json, []), cc: fromJson(r.cc_json, []),
    subject: String(r.subject), body_text: String(r.body_text), occurred_at: String(r.occurred_at), received_at: String(r.received_at),
    auth_verdict: str(r.auth_verdict), attachments: fromJson(r.attachments_json, []),
    ...(r.time_flags_json ? { time_flags: fromJson(r.time_flags_json, []) } : {}),
  };
}

export function rowToClaim(r: Row): Claim {
  const { value_json, ...columns } = r;
  return { ...(columns as unknown as Claim), value: fromJson(value_json, null) };
}

export function rowToObligation(r: Row): Obligation {
  const { topic_keys_json, notes_json, ext_json, ...columns } = r;
  const ext = fromJson<Row>(ext_json, {});
  return {
    ...(columns as unknown as Obligation),
    due_at: str(r.due_at),
    topic_keys: fromJson(topic_keys_json, []),
    notes: fromJson(notes_json, []),
    ...Object.fromEntries(OBLIGATION_EXT.map((k) => [k, ext[k] ?? null])),
  };
}

function rowToArtifact(r: Row): Artifact {
  return { ...(r as unknown as Artifact) };
}

function rowToJob(r: Row, org: string): JobRow {
  return {
    id: String(r.id), org, kind: r.kind as JobRow['kind'], task_id: str(r.task_id), event_id: str(r.event_id), seq: Number(r.seq ?? 0),
    dedupe_key: String(r.dedupe_key), payload: fromJson(r.payload_json, {}), status: r.status as JobRow['status'],
    attempts: Number(r.attempts), max_attempts: Number(r.max_attempts), run_after: String(r.run_after),
    locked_by: str(r.locked_by), locked_until: str(r.locked_until), last_error: str(r.last_error),
  };
}
