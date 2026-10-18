// The Supabase Postgres backend (Postgres.js): the authoritative store for hosted operation.
//
//  - loadTask: one REPEATABLE READ, read-only transaction reads the task's whole working set in a
//    handful of queries, not one round trip per state operation.
//  - commit: one short transaction. Lock the task row, check state_version, lock the id counters, run the
//    synchronous resolver on the working set, upsert exactly the rows it touched, complete the job,
//    enqueue follow-ups, bump the version. No network calls inside.
//  - jobs: leased with FOR UPDATE SKIP LOCKED; interpretation is serialized per task in event order;
//    a crashed worker's expired lease is picked up again.
//  - attachments: content-addressed objects in a private Supabase Storage bucket (server-side key); the
//    metadata row keeps the Primitive email id and sha256. Without Storage the bytes go inline (bytea).
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { MemoryStore, COMMIT_COUNTERS, type Delta } from './state.ts';
import type {
  ActionRow, Backend, BlobIn, BlobRef, CommitOptions, CommitResult, JobInput, JobOutcome, JobRow, LinkLookup, Principal, ReceiveResult, SignalRow, TaskSnapshot,
} from './backend.ts';
import type { Artifact, Claim, EventInput, Obligation, StoredEvent, TaskSpec } from '../types.ts';
import { stripAttachmentBytes } from './rows.ts';
import { redactUrl } from './index.ts';

type Sql = postgres.Sql | postgres.TransactionSql;
type Row = Record<string, any>;
type StoredBytes = { storage: 'supabase_storage' | 'postgres_inline'; path: string | null };

/** ISO time; second precision is kept when there are no milliseconds, so '…:00Z' inputs round-trip exactly. */
const ts = (v: unknown): string => (v instanceof Date ? v.toISOString().replace('.000Z', 'Z') : String(v));
const tsOrNull = (v: unknown): string | null => (v == null ? null : ts(v));
const two = (n: number) => String(n).padStart(2, '0');
const day = (v: unknown): string | null => {
  if (v == null) return null;
  return v instanceof Date ? `${v.getUTCFullYear()}-${two(v.getUTCMonth() + 1)}-${two(v.getUTCDate())}` : String(v).slice(0, 10);
};
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));
const httpError = (message: string, status: number) => Object.assign(new Error(message), { status });

const SCHEMA_VERSION = '20261017220000_continuity_signals';
const EPOCH = new Date(0).toISOString();
const ITEM_TABLES: Record<string, string> = { ev: 'events', cl: 'claims', ob: 'obligations', ar: 'artifacts' };

/** Thrown inside a receive transaction that lost a race with a concurrent delivery. */
class LostRace extends Error {}

export interface PostgresOptions {
  storage?: { url: string; key: string; bucket: string } | null;
  max?: number;
}

export class PostgresBackend implements Backend {
  readonly mode = 'postgres' as const;
  readonly target: string;
  readonly sql: postgres.Sql;
  readonly storage: PostgresOptions['storage'];

  constructor(url: string, opts: PostgresOptions = {}) {
    this.target = `postgres ${redactUrl(url)}`;
    const u = new URL(url);
    // Supavisor in transaction mode (port 6543) cannot use prepared statements
    const transactionPooler = u.port === '6543' || u.searchParams.get('pgbouncer') === 'true';
    this.sql = postgres(url, {
      max: opts.max ?? 10,
      prepare: !transactionPooler,
      onnotice: () => undefined,
      idle_timeout: 30,
      connect_timeout: 10,
      // keep DATE columns as 'YYYY-MM-DD' strings
      types: { date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x } } as never,
    });
    this.storage = opts.storage ?? null;
  }

  async init() {
    const [r] = await this.sql`select to_regclass('continuity.events') as events, to_regclass('continuity.jobs') as jobs`;
    if (!r.events || !r.jobs) {
      throw new Error(`Continuity schema not found in ${this.target}. Apply supabase/migrations (local: \`supabase migration up --local\`; hosted: \`supabase db push\` after review).`);
    }
  }
  async close() { await this.sql.end({ timeout: 5 }); }
  async health() {
    try {
      await this.sql`select 1`;
      return { ok: true, detail: this.target, schema: SCHEMA_VERSION };
    } catch (e) {
      return { ok: false, detail: `database unreachable: ${(e as Error).message}`, schema: null };
    }
  }

  async ensureOrg(org: string, name?: string) {
    await this.sql`insert into continuity.orgs (id, name) values (${org}, ${name ?? org}) on conflict (id) do nothing`;
    const counters = ['ev', 'run', ...COMMIT_COUNTERS] as string[];
    await this.sql`insert into continuity.counters (org_id, name, value) select ${org}, n, 0 from unnest(${counters}::text[]) as n on conflict do nothing`;
  }

  async instanceId(org: string) {
    await this.sql`insert into continuity.meta (org_id, key, value) values (${org}, 'instance_id', ${randomUUID()}) on conflict do nothing`;
    const [r] = await this.sql`select value from continuity.meta where org_id = ${org} and key = 'instance_id'`;
    return r.value as string;
  }

  // ------------------------------------------------------------------ tasks

  async createTask(org: string, spec: TaskSpec, at: string, init: (s: MemoryStore) => void) {
    await this.ensureOrg(org);
    await this.sql.begin(async (tx) => {
      const exists = await tx`select 1 from continuity.tasks where org_id = ${org} and (id = ${spec.id} or alias = ${spec.alias})`;
      if (exists.length) throw httpError(`task ${spec.id} exists`, 409);
      const work = new MemoryStore();
      work.resetCounters(await this.#lockCounters(tx, org));
      work.createTask(spec, at);
      init(work);
      await this.#flush(tx, org, work, work.takeDelta());
    });
  }

  async getTask(org: string, idOrAlias: string) {
    const rows = await this.sql`select spec from continuity.tasks where org_id = ${org} and (id = ${idOrAlias} or alias = ${idOrAlias})
      order by (id = ${idOrAlias}) desc limit 1`;
    return rows.length ? (rows[0].spec as TaskSpec) : null;
  }

  async listTasks(org: string) {
    const rows = await this.sql`select spec, state_version from continuity.tasks where org_id = ${org} order by created_at`;
    return rows.map((r) => ({ spec: r.spec as TaskSpec, state_version: Number(r.state_version) }));
  }

  // ------------------------------------------------------------------ receipt

  async receive(org: string, input: EventInput, link: (l: LinkLookup) => Promise<{ task_id: string; reason: string } | null>, blobs: BlobIn[]): Promise<ReceiveResult> {
    const existing = await this.#eventBy(this.sql, org, 'dedupe_key', input.dedupe_key);
    if (existing) {
      const requeued = existing.task_id ? await this.#rearm(org, existing) : false;
      return { event: existing, duplicate: true, linked: !!existing.task_id, requeued };
    }
    // bytes go to the private cache first; it is content-addressed, so no event id is needed yet
    const stored = await Promise.all(blobs.map(async (b) => ({ b, ...(await this.#storeBytes(org, b)) })));
    try {
      const id = await this.sql.begin(async (tx) => {
        const target = await link({
          taskForThread: async (t) => (await tx`select task_id from continuity.task_threads where org_id = ${org} and thread_id = ${t}`)[0]?.task_id ?? null,
          eventByPrimitiveEmailId: async (pid) => this.#eventBy(tx, org, 'primitive_email_id', pid),
          eventByMessageId: async (mid) => this.#eventBy(tx, org, 'message_id', mid),
          tasks: async () => (await tx`select id, alias from continuity.tasks where org_id = ${org} order by created_at`).map((r) => ({ id: r.id as string, alias: r.alias as string })),
        });
        const seq = input.preserve_seq
          ? Number((await tx`update continuity.counters set value = greatest(value, ${input.preserve_seq}) where org_id = ${org} and name = 'ev'
              returning ${input.preserve_seq}::bigint as v`)[0].v)
          : Number((await tx`update continuity.counters set value = value + 1 where org_id = ${org} and name = 'ev' returning value`)[0].value);
        const eventId = `ev_${seq}`;
        const e = stripAttachmentBytes(input);
        const inserted = await tx`insert into continuity.events ${tx({
          org_id: org, id: eventId, seq, dedupe_key: e.dedupe_key, task_id: target?.task_id ?? null, link_reason: target?.reason ?? null,
          source: e.source, direction: e.direction, primitive_event_id: e.primitive_event_id ?? null, primitive_email_id: e.primitive_email_id ?? null,
          reply_to_sent_email_id: e.reply_to_sent_email_id ?? null, thread_id: e.thread_id, message_id: e.message_id, in_reply_to: e.in_reply_to,
          references: tx.json(e.references as never), from_addr: e.from, from_name: e.from_name ?? null, to_addrs: tx.json(e.to as never),
          cc_addrs: tx.json(e.cc as never), subject: e.subject, body_text: e.body_text, occurred_at: e.occurred_at, received_at: e.received_at,
          auth_verdict: e.auth_verdict ?? null, attachments: tx.json(e.attachments as never), raw: input.raw === undefined ? null : tx.json(input.raw as never),
          time_flags: tx.json((e.time_flags ?? []) as never), processing_status: target ? 'received' : 'unlinked',
        })} on conflict (org_id, dedupe_key) do nothing returning id`;
        if (!inserted.length) throw new LostRace();
        if (target && e.thread_id) await this.#mapThread(tx, org, e.thread_id, target.task_id, `${eventId}: ${target.reason}`);
        for (const s of stored) await this.#blobRow(tx, org, { ...s.b, event_id: eventId }, s);
        if (target) await this.#enqueue(tx, org, [{ kind: 'interpret_event', task_id: target.task_id, event_id: eventId, seq, dedupe_key: `interpret:${eventId}` }]);
        return eventId;
      });
      const event = (await this.getEvent(org, id))!;
      return { event, duplicate: false, linked: !!event.task_id, requeued: false };
    } catch (err) {
      if (err instanceof LostRace || (err as { code?: string }).code === '23505') return this.receive(org, input, link, []);
      throw err;
    }
  }

  async #mapThread(tx: Sql, org: string, threadId: string, taskId: string, reason: string) {
    await tx`insert into continuity.task_threads (org_id, thread_id, task_id, reason) values (${org}, ${threadId}, ${taskId}, ${reason}) on conflict do nothing`;
  }

  /** A redelivered, never-interpreted event gets its interpretation job back. */
  async #rearm(org: string, ev: StoredEvent): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      if ((await tx`select 1 from continuity.extractions where org_id = ${org} and event_id = ${ev.id} limit 1`).length) return false;
      const [job] = await tx`select id, status from continuity.jobs where org_id = ${org} and dedupe_key = ${`interpret:${ev.id}`} for update`;
      if (!job) {
        await this.#enqueue(tx, org, [{ kind: 'interpret_event', task_id: ev.task_id, event_id: ev.id, seq: ev.seq, dedupe_key: `interpret:${ev.id}` }]);
        return true;
      }
      if (job.status === 'dead') {
        await tx`update continuity.jobs set status = 'pending', attempts = 0, run_after = now(), last_error = null, updated_at = now() where id = ${job.id}`;
        await tx`update continuity.events set processing_status = 'received', processing_error = null where org_id = ${org} and id = ${ev.id}`;
        return true;
      }
      return false;
    });
  }

  async linkEvent(org: string, eventId: string, taskId: string, reason: string) {
    await this.sql.begin(async (tx) => {
      const [ev] = await tx`select task_id, thread_id, seq from continuity.events where org_id = ${org} and id = ${eventId} for update`;
      if (!ev) throw httpError(`no event ${eventId}`, 404);
      if (ev.task_id) return;
      await tx`update continuity.events set task_id = ${taskId}, link_reason = ${reason}, processing_status = 'received' where org_id = ${org} and id = ${eventId}`;
      if (ev.thread_id) await this.#mapThread(tx, org, ev.thread_id, taskId, `manual link of ${eventId}`);
      await this.#enqueue(tx, org, [{ kind: 'interpret_event', task_id: taskId, event_id: eventId, seq: Number(ev.seq), dedupe_key: `interpret:${eventId}` }]);
    });
    return (await this.getEvent(org, eventId))!;
  }

  async #eventBy(sql: Sql, org: string, column: 'id' | 'dedupe_key' | 'primitive_email_id' | 'message_id', value: string): Promise<StoredEvent | null> {
    const rows = await sql`select * from continuity.events where org_id = ${org} and ${sql(column)} = ${value} order by seq limit 1`;
    return rows.length ? rowToEvent(rows[0]) : null;
  }
  async getEvent(org: string, id: string) { return this.#eventBy(this.sql, org, 'id', id); }
  async getEventRaw(org: string, id: string) {
    return (await this.sql`select raw from continuity.events where org_id = ${org} and id = ${id}`)[0]?.raw ?? null;
  }
  async unlinkedEvents(org: string) {
    return (await this.sql`select * from continuity.events where org_id = ${org} and task_id is null order by seq`).map(rowToEvent);
  }
  async extractionsFor(org: string, eventId: string) {
    const rows = await this.sql`select extractor, proposal, version from continuity.extractions where org_id = ${org} and event_id = ${eventId} order by version`;
    return rows.map((r) => ({ extractor: r.extractor as string, proposal: r.proposal, version: r.version as number }));
  }
  async findItemTask(org: string, itemId: string) {
    const table = ITEM_TABLES[itemId.split('_')[0]];
    if (!table) return null;
    return (await this.sql`select task_id from ${this.sql(`continuity.${table}`)} where org_id = ${org} and id = ${itemId}`)[0]?.task_id ?? null;
  }

  // ------------------------------------------------------------------ snapshot

  async loadTask(org: string, taskId: string): Promise<TaskSnapshot> {
    const store = await this.sql.begin('isolation level repeatable read read only', (tx) => this.#load(tx, org, taskId));
    return { org, taskId, version: store.stateVersion(taskId), store };
  }

  async #load(tx: Sql, org: string, taskId: string): Promise<MemoryStore> {
    const s = new MemoryStore();
    const [task] = await tx`select spec, created_at, state_version from continuity.tasks where org_id = ${org} and id = ${taskId}`;
    if (!task) throw httpError(`unknown task ${taskId}`, 404);
    s.tasks.set(taskId, { spec: task.spec, created_at: ts(task.created_at), state_version: Number(task.state_version) });

    const [events, threads, extractions, artifacts, claims, evidence, obligations, transitions, checks, flags, cursors, counters, meta] = await Promise.all([
      tx`select * from continuity.events where org_id = ${org} and task_id = ${taskId} order by seq`,
      tx`select thread_id, task_id, reason from continuity.task_threads where org_id = ${org} and task_id = ${taskId}`,
      tx`select x.event_id, x.extractor, x.proposal, x.created_at, x.version from continuity.extractions x
           join continuity.events e on e.org_id = x.org_id and e.id = x.event_id
           where x.org_id = ${org} and e.task_id = ${taskId} order by e.seq, x.version`,
      tx`select * from continuity.artifacts where org_id = ${org} and task_id = ${taskId}`,
      tx`select * from continuity.claims where org_id = ${org} and task_id = ${taskId}`,
      tx`select ce.claim_id, ce.event_id, ce.artifact_id, ce.quote from continuity.claim_evidence ce
           join continuity.claims c on c.org_id = ce.org_id and c.id = ce.claim_id
           where ce.org_id = ${org} and c.task_id = ${taskId} order by ce.claim_id, ce.ord`,
      tx`select * from continuity.obligations where org_id = ${org} and task_id = ${taskId}`,
      tx`select * from continuity.transitions where org_id = ${org} and task_id = ${taskId} order by seq`,
      tx`select result from continuity.checks where org_id = ${org} and task_id = ${taskId} order by ord`,
      tx`select * from continuity.flags where org_id = ${org} and task_id = ${taskId}`,
      tx`select agent_id, last_seq from continuity.cursors where org_id = ${org} and task_id = ${taskId}`,
      tx`select name, value from continuity.counters where org_id = ${org}`,
      tx`select value from continuity.meta where org_id = ${org} and key = 'instance_id'`,
    ]);

    for (const r of events) {
      const e = rowToEvent(r);
      s.events.set(e.id, e);
      if (r.processing_status === 'failed') s.failed.add(e.id);
      // who sent our own mail: staleness checks tell an agent's own sends from someone else's changes
      if (e.direction === 'outbound' && r.raw?.sent_by_agent) s.raw.set(e.id, { sent_by_agent: r.raw.sent_by_agent, action_id: r.raw.action_id ?? null });
    }
    for (const r of threads) s.threads.set(r.thread_id, { task_id: r.task_id, reason: r.reason });
    for (const r of extractions) s.extractions.push({ event_id: r.event_id, extractor: r.extractor, proposal: r.proposal, created_at: ts(r.created_at), version: r.version });
    for (const r of artifacts) { const a = rowToArtifact(r); s.artifacts.set(a.id, a); }
    for (const r of claims) { const c = rowToClaim(r); s.claims.set(c.id, c); }
    for (const r of evidence) s.claimEv.push({ claim_id: r.claim_id, event_id: r.event_id, artifact_id: r.artifact_id ?? null, quote: r.quote });
    for (const r of obligations) { const o = rowToObligation(r); s.obligations.set(o.id, o); }
    for (const r of transitions) {
      s.transitions.push({ seq: Number(r.seq), task_id: r.task_id, event_id: r.event_id ?? null, at: ts(r.at), type: r.type, subject_id: r.subject_id ?? null, summary: r.summary, detail: r.detail });
    }
    s.checks.set(taskId, checks.map((r) => r.result));
    for (const r of flags) s.flags.push({ id: r.id, task_id: r.task_id, event_id: r.event_id, kind: r.kind, detail: r.detail, at: ts(r.at) });
    for (const r of cursors) s.setCursorLocal(r.agent_id, taskId, Number(r.last_seq));
    s.resetCounters(Object.fromEntries(counters.map((r) => [r.name, Number(r.value)])));
    if (meta[0]) s.meta.set('instance_id', meta[0].value);
    s.discardDelta();
    return s;
  }

  async #lockCounters(tx: Sql, org: string): Promise<Record<string, number>> {
    const rows = await tx`select name, value from continuity.counters where org_id = ${org} and name in ${tx([...COMMIT_COUNTERS])} order by name for update`;
    return Object.fromEntries(rows.map((r) => [r.name, Number(r.value)]));
  }

  // ------------------------------------------------------------------ commit

  async commit<T>(snap: TaskSnapshot, mutate: (s: MemoryStore) => T, opts: CommitOptions = {}): Promise<CommitResult<T>> {
    const org = snap.org;
    try {
      return await this.sql.begin(async (tx): Promise<CommitResult<T>> => {
        const [task] = await tx`select state_version from continuity.tasks where org_id = ${org} and id = ${snap.taskId} for update`;
        if (!task) throw httpError(`unknown task ${snap.taskId}`, 404);
        const version = Number(task.state_version);
        if (version !== snap.version) return { ok: false, reason: 'stale', version };
        if (opts.actions?.length) {
          const keys = opts.actions.map((a) => a.idempotency_key);
          const busy = await tx`select id from continuity.outbound_actions where org_id = ${org} and task_id = ${snap.taskId}
            and status in ('pending', 'attempted') and not (idempotency_key = any(${keys}))`;
          if (busy.length) return { ok: false, reason: 'conflict', version, detail: `another send for this task is in flight (${busy[0].id})` };
        }
        const work = snap.store;
        work.discardDelta();
        work.resetCounters(await this.#lockCounters(tx, org));
        const value = mutate(work);
        const jobs = opts.jobs?.(work) ?? [];
        await this.#flush(tx, org, work, work.takeDelta());
        if (opts.eventStatus) {
          await tx`update continuity.events set processing_status = ${opts.eventStatus.status}, processing_error = ${opts.eventStatus.error ?? null}
            where org_id = ${org} and id = ${opts.eventStatus.id}`;
        }
        if (opts.completeJobId) await tx`update continuity.jobs set status = 'done', locked_until = null, updated_at = now() where id = ${opts.completeJobId}`;
        for (const a of opts.actions ?? []) await tx`insert into continuity.outbound_actions ${tx(actionToRow(tx, a))}`;
        await this.#enqueue(tx, org, jobs);
        snap.version = work.stateVersion(snap.taskId);
        return { ok: true, version: snap.version, value };
      });
    } catch (err) {
      if ((err as { constraint_name?: string }).constraint_name === 'outbound_one_in_flight') {
        return { ok: false, reason: 'conflict', version: snap.version, detail: 'another send for this task is in flight' };
      }
      throw err;
    }
  }

  async #insertTaskRow(tx: Sql, org: string, t: { spec: TaskSpec; created_at: string; state_version: number }) {
    await tx`insert into continuity.tasks ${tx({
      org_id: org, id: t.spec.id, alias: t.spec.alias, domain: t.spec.domain, goal: t.spec.goal, spec: tx.json(t.spec as never),
      created_at: t.created_at, state_version: t.state_version,
    })}`;
    const parts = t.spec.participants.map((p) => ({
      org_id: org, task_id: t.spec.id, address: p.address.toLowerCase(), name: p.name, label: p.label, role: p.role,
      authority: p.authority, group_key: p.group ?? null,
    }));
    if (parts.length) await tx`insert into continuity.participants ${tx(parts)} on conflict do nothing`;
  }

  /** Write a delta: exactly the rows the apply touched. */
  async #flush(tx: Sql, org: string, store: MemoryStore, d: Delta) {
    for (const t of d.tasks) await this.#insertTaskRow(tx, org, t);
    for (const [id, version] of d.taskVersions) {
      await tx`update continuity.tasks set state_version = greatest(state_version, ${version}), updated_at = now() where org_id = ${org} and id = ${id}`;
    }
    for (const link of d.eventLinks) {
      await tx`update continuity.events set task_id = ${link.task_id}, link_reason = ${link.link_reason} where org_id = ${org} and id = ${link.id}`;
    }
    for (const t of d.threads) await this.#mapThread(tx, org, t.thread_id, t.task_id, t.reason);
    if (d.extractions.length) {
      await tx`insert into continuity.extractions ${tx(d.extractions.map((x) => ({
        org_id: org, event_id: x.event_id, version: x.version, extractor: x.extractor, proposal: tx.json(x.proposal as never), created_at: x.created_at,
      })))}`;
    }
    const artifacts = [...d.artifacts.inserted, ...d.artifacts.updated];
    if (artifacts.length) {
      await tx`insert into continuity.artifacts ${tx(artifacts.map((a) => ({
        org_id: org, id: a.id, task_id: a.task_id, event_id: a.event_id, filename: a.filename, content_type: a.content_type, sha256: a.sha256,
        size_bytes: a.size_bytes, kind: a.kind, version_label: a.version_label, text: a.text, status: a.status, superseded_by: a.superseded_by, owner: a.owner,
      })))} on conflict (org_id, id) do update set status = excluded.status, superseded_by = excluded.superseded_by`;
    }
    const claims = [...d.claims.inserted, ...d.claims.updated];
    if (claims.length) {
      await tx`insert into continuity.claims ${tx(claims.map((c) => ({
        org_id: org, id: c.id, task_id: c.task_id, key: c.key, value: tx.json(c.value as never), display: c.display, kind: c.kind, speaker: c.speaker,
        source_event_id: c.source_event_id, source_artifact_id: c.source_artifact_id, evidence: c.evidence, status: c.status, superseded_by: c.superseded_by,
        supersede_reason: c.supersede_reason, learned_at: c.learned_at, confidence: c.confidence, extractor: c.extractor,
      })))} on conflict (org_id, id) do update set status = excluded.status, superseded_by = excluded.superseded_by, supersede_reason = excluded.supersede_reason`;
    }
    if (d.claimEvidence.length) {
      // ord: the row's position among its claim's evidence
      await tx`insert into continuity.claim_evidence ${tx(d.claimEvidence.map((e) => ({
        org_id: org, claim_id: e.claim_id, ord: store.claimEv.filter((x) => x.claim_id === e.claim_id).indexOf(e), event_id: e.event_id,
        artifact_id: e.artifact_id, quote: e.quote,
      })))}`;
    }
    const obligations = [...d.obligations.inserted, ...d.obligations.updated];
    if (obligations.length) {
      await tx`insert into continuity.obligations ${tx(obligations.map((o) => ({
        org_id: org, id: o.id, task_id: o.task_id, kind: o.kind, debtor: o.debtor, creditor: o.creditor, text: o.text, topic_keys: o.topic_keys,
        issue_key: o.issue_key ?? null, group_id: o.group_id ?? null, expects_artifact: o.expects_artifact,
        artifact_match: o.artifact_match ? tx.json(o.artifact_match as never) : null, status: o.status, quantity: o.quantity ?? null,
        fulfilled_quantity: o.fulfilled_quantity ?? null, condition: o.condition ? tx.json(o.condition as never) : null,
        condition_met_at: o.condition_met_at ?? null, due_at: o.due_at, source_event_id: o.source_event_id, evidence: o.evidence,
        resolved_by_event_id: o.resolved_by_event_id, resolution_note: o.resolution_note, created_at: o.created_at, resolved_at: o.resolved_at,
        confidence: o.confidence, notes: tx.json(o.notes as never),
      })))} on conflict (org_id, id) do update set status = excluded.status, group_id = excluded.group_id,
        fulfilled_quantity = excluded.fulfilled_quantity, condition_met_at = excluded.condition_met_at,
        resolved_by_event_id = excluded.resolved_by_event_id, resolution_note = excluded.resolution_note, resolved_at = excluded.resolved_at,
        notes = excluded.notes`;
    }
    if (d.transitions.length) {
      await tx`insert into continuity.transitions ${tx(d.transitions.map((t) => ({
        org_id: org, seq: t.seq, task_id: t.task_id, event_id: t.event_id, at: t.at, type: t.type, subject_id: t.subject_id, summary: t.summary,
        detail: tx.json(t.detail as never),
      })))}`;
    }
    for (const [taskId, checks] of d.checks) {
      await tx`delete from continuity.checks where org_id = ${org} and task_id = ${taskId}`;
      if (checks.length) {
        await tx`insert into continuity.checks ${tx(checks.map((c, i) => ({ org_id: org, task_id: taskId, id: c.id, ord: i, result: tx.json(c as never) })))}`;
      }
    }
    if (d.flags.length) {
      await tx`insert into continuity.flags ${tx(d.flags.map((f) => ({ org_id: org, id: f.id, task_id: f.task_id, event_id: f.event_id, kind: f.kind, detail: f.detail, at: f.at })))}`;
    }
    for (const [name, value] of d.counters) await this.#raiseCounter(tx, org, name, value);
  }

  async #raiseCounter(tx: Sql, org: string, name: string, value: number) {
    await tx`insert into continuity.counters (org_id, name, value) values (${org}, ${name}, ${value})
      on conflict (org_id, name) do update set value = greatest(continuity.counters.value, excluded.value)`;
  }

  // ------------------------------------------------------------------ jobs

  async enqueue(org: string, jobs: JobInput[]) { await this.#enqueue(this.sql, org, jobs); }
  async #enqueue(sql: Sql, org: string, jobs: JobInput[]) {
    if (!jobs.length) return;
    await sql`insert into continuity.jobs ${sql(jobs.map((j) => ({
      org_id: org, kind: j.kind, task_id: j.task_id, event_id: j.event_id ?? null, seq: j.seq ?? 0, dedupe_key: j.dedupe_key,
      payload: sql.json((j.payload ?? {}) as never), max_attempts: j.max_attempts ?? 5, run_after: j.run_after ?? EPOCH,
    })))} on conflict (org_id, dedupe_key) do nothing`;
  }

  async claimJob(workerId: string, now: string, leaseMs: number, filter: { org?: string; taskId?: string } = {}) {
    const until = new Date(Date.parse(now) + leaseMs).toISOString();
    const org = filter.org ?? null;
    const task = filter.taskId ?? null;
    const rows = await this.sql.begin(async (tx) => {
      const claimed = await tx`
        with candidate as (
          select j.id from continuity.jobs j
          where ((j.status = 'pending' and j.run_after <= ${now}) or (j.status = 'running' and j.locked_until <= ${now}))
            and (${org}::text is null or j.org_id = ${org}) and (${task}::text is null or j.task_id = ${task})
            and (j.task_id is null or not exists (
              select 1 from continuity.jobs k where k.org_id = j.org_id and k.task_id = j.task_id and k.id <> j.id and (
                (k.status = 'running' and k.locked_until > ${now}) or
                (j.kind = 'interpret_event' and k.kind = 'interpret_event' and k.status in ('pending', 'running') and k.seq < j.seq))))
          order by j.run_after, j.seq, j.id
          for update skip locked limit 1)
        update continuity.jobs set status = 'running', attempts = attempts + 1, locked_by = ${workerId}, locked_until = ${until}, updated_at = now()
        from candidate where continuity.jobs.id = candidate.id returning continuity.jobs.*`;
      const job = claimed[0];
      if (job?.kind === 'interpret_event' && job.event_id) {
        await tx`update continuity.events set processing_status = 'interpreting'
          where org_id = ${job.org_id} and id = ${job.event_id} and processing_status in ('received', 'interpreting')`;
      }
      return claimed;
    });
    return rows.length ? rowToJob(rows[0]) : null;
  }

  async finishJob(id: string, outcome: JobOutcome) {
    if (outcome.status === 'done') {
      await this.sql`update continuity.jobs set status = 'done', locked_until = null, locked_by = null, updated_at = now() where id = ${id} and status <> 'done'`;
    } else if (outcome.status === 'retry') {
      await this.sql`update continuity.jobs set status = 'pending', last_error = ${outcome.error}, run_after = ${outcome.runAfter}, locked_until = null,
        locked_by = null, updated_at = now() where id = ${id} and status <> 'done'`;
    } else {
      await this.sql.begin(async (tx) => {
        const [job] = await tx`update continuity.jobs set status = 'dead', last_error = ${outcome.error}, locked_until = null, locked_by = null, updated_at = now()
          where id = ${id} and status <> 'done' returning org_id, kind, event_id`;
        if (job?.kind === 'interpret_event' && job.event_id) {
          await tx`update continuity.events set processing_status = 'failed', processing_error = ${outcome.error} where org_id = ${job.org_id} and id = ${job.event_id}`;
        }
      });
    }
  }

  async jobCounts(org?: string) {
    const rows = org
      ? await this.sql`select status, count(*)::int as n from continuity.jobs where org_id = ${org} group by status`
      : await this.sql`select status, count(*)::int as n from continuity.jobs group by status`;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  async pendingJobs(org: string, taskId: string) {
    const rows = await this.sql`select * from continuity.jobs where org_id = ${org} and task_id = ${taskId} and status in ('pending', 'running') order by seq, id`;
    return rows.map(rowToJob);
  }

  // ------------------------------------------------------------------ actions

  async getAction(org: string, id: string) {
    const rows = await this.sql`select * from continuity.outbound_actions where org_id = ${org} and id = ${id}`;
    return rows.length ? rowToAction(rows[0]) : null;
  }
  async getActionByKey(org: string, idempotencyKey: string) {
    const rows = await this.sql`select * from continuity.outbound_actions where org_id = ${org} and idempotency_key = ${idempotencyKey}`;
    return rows.length ? rowToAction(rows[0]) : null;
  }
  async listActions(org: string, taskId: string) {
    return (await this.sql`select * from continuity.outbound_actions where org_id = ${org} and task_id = ${taskId} order by created_at`).map(rowToAction);
  }
  async updateAction(org: string, id: string, fields: Partial<ActionRow>) {
    const MUTABLE = ['status', 'attempts', 'provider', 'primitive_email_id', 'event_id', 'last_error'] as const;
    const set: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of MUTABLE) {
      if (!(k in fields)) continue;
      set[k] = k === 'provider' ? (fields.provider == null ? null : this.sql.json(fields.provider as never)) : fields[k];
    }
    const rows = await this.sql`update continuity.outbound_actions set ${this.sql(set)} where org_id = ${org} and id = ${id} returning *`;
    if (!rows.length) throw new Error(`no action ${id}`);
    return rowToAction(rows[0]);
  }

  // ------------------------------------------------------------------ cursors and runs

  async setCursor(org: string, agentId: string, taskId: string, seq: number, at: string) {
    await this.sql`insert into continuity.cursors (org_id, agent_id, task_id, last_seq, updated_at) values (${org}, ${agentId}, ${taskId}, ${seq}, ${at})
      on conflict (org_id, agent_id, task_id) do update set last_seq = excluded.last_seq, updated_at = excluded.updated_at`;
  }

  async saveAgentRun(org: string, run: Record<string, unknown>) {
    const id = typeof run.id === 'string'
      ? run.id
      : `run_${Number((await this.sql`update continuity.counters set value = value + 1 where org_id = ${org} and name = 'run' returning value`)[0].value)}`;
    const json = (v: unknown) => (v == null ? null : this.sql.json(v as never));
    const text = (v: unknown) => (v as string | undefined) ?? null;
    const int = (v: unknown) => (v as number | undefined) ?? null;
    await this.sql`insert into continuity.agent_runs ${this.sql({
      org_id: org, id, task_id: run.task_id as string, agent_id: run.agent_id as string, principal_id: text(run.principal_id),
      started_at: run.started_at as string, mode: run.mode as string, purpose: text(run.purpose), state_version: int(run.state_version),
      context_digest: text(run.context_digest), context: json(run.context), briefing: text(run.briefing), budget: json(run.budget),
      context_tokens: int(run.context_tokens), transcript_tokens: int(run.transcript_tokens), usage: json(run.usage), decision: json(run.decision),
      actions: json(run.actions), sent_event_id: text(run.sent_event_id),
    })} on conflict (org_id, id) do update set decision = excluded.decision, actions = excluded.actions, usage = excluded.usage, sent_event_id = excluded.sent_event_id`;
    return id;
  }

  async agentRuns(org: string, taskId: string) {
    const rows = await this.sql`select * from continuity.agent_runs where org_id = ${org} and task_id = ${taskId} order by started_at, id`;
    return rows.map((r) => ({ ...r, org_id: undefined, started_at: ts(r.started_at), state_version: numOrNull(r.state_version) }));
  }

  // ------------------------------------------------------------------ remembered Signal alerts
  // (continuity.signals, added by supabase/migrations/20261017220000_continuity_signals.sql)

  async listSignals(org: string, opts: { includeResolved?: boolean } = {}) {
    const rows = await this.sql`select * from continuity.signals where org_id = ${org} ${opts.includeResolved ? this.sql`` : this.sql`and resolved_at is null`}
      order by first_seen, key`;
    return rows.map((r) => ({
      key: r.key as string, task_id: r.task_id as string, rule: r.rule as string, severity: r.severity as SignalRow['severity'], summary: r.summary as string,
      detail: (r.detail ?? { evidence: [] }) as SignalRow['detail'], first_seen: ts(r.first_seen), last_seen: ts(r.last_seen), resolved_at: tsOrNull(r.resolved_at),
    }));
  }

  async saveSignals(org: string, rows: SignalRow[]) {
    if (!rows.length) return;
    await this.sql.begin(async (tx) => {
      for (const s of rows) {
        await tx`insert into continuity.signals ${tx({
          org_id: org, key: s.key, task_id: s.task_id, rule: s.rule, severity: s.severity, summary: s.summary, detail: tx.json(s.detail as never),
          first_seen: s.first_seen, last_seen: s.last_seen, resolved_at: s.resolved_at,
        })} on conflict (org_id, key) do update set task_id = excluded.task_id, rule = excluded.rule, severity = excluded.severity,
          summary = excluded.summary, detail = excluded.detail, first_seen = excluded.first_seen, last_seen = excluded.last_seen, resolved_at = excluded.resolved_at`;
      }
    });
  }

  // ------------------------------------------------------------------ attachments

  #objectUrl(path: string) { return `${this.storage!.url}/storage/v1/object/${this.storage!.bucket}/${path}`; }
  #authHeaders() { return { authorization: `Bearer ${this.storage!.key}`, apikey: this.storage!.key }; }

  async #storeBytes(org: string, b: BlobIn): Promise<StoredBytes> {
    if (!this.storage) return { storage: 'postgres_inline', path: null };
    const path = `${encodeURIComponent(org)}/sha256/${b.sha256}`;
    const res = await fetch(this.#objectUrl(path), {
      method: 'POST',
      headers: { ...this.#authHeaders(), 'content-type': b.content_type || 'application/octet-stream', 'x-upsert': 'true' },
      body: new Uint8Array(b.bytes),
    });
    if (!res.ok) throw new Error(`attachment cache upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return { storage: 'supabase_storage', path };
  }

  async #blobRow(sql: Sql, org: string, b: BlobIn, stored: StoredBytes) {
    await sql`insert into continuity.attachment_blobs ${sql({
      org_id: org, event_id: b.event_id, part_index: b.part_index, sha256: b.sha256, content_type: b.content_type, size_bytes: b.size_bytes,
      primitive_email_id: b.primitive_email_id, storage: stored.storage, storage_path: stored.path,
      inline_bytes: stored.storage === 'postgres_inline' ? b.bytes : null,
    })} on conflict (org_id, event_id, part_index) do nothing`;
  }

  async putBlob(org: string, b: BlobIn) {
    await this.#blobRow(this.sql, org, b, await this.#storeBytes(org, b));
  }

  async getBlob(org: string, ref: BlobRef) {
    const [r] = await this.sql`select storage, storage_path, inline_bytes, sha256 from continuity.attachment_blobs
      where org_id = ${org} and event_id = ${ref.event_id} and part_index = ${ref.part_index}`;
    if (!r) return null;
    if (r.storage === 'postgres_inline') return Buffer.from(r.inline_bytes);
    if (!this.storage) throw new Error('attachment is in Supabase Storage but SUPABASE_URL/SUPABASE_SECRET_KEY are not configured');
    const res = await fetch(this.#objectUrl(r.storage_path), { headers: this.#authHeaders() });
    if (!res.ok) throw new Error(`attachment cache download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  // ------------------------------------------------------------------ import and rollback (scripts/import-sqlite.ts)

  /** Ids from one task's evidence and projection that already exist in the target org (collision check). */
  async existingIds(org: string, ids: { events: string[]; claims: string[]; obligations: string[]; artifacts: string[]; seqs: number[] }) {
    const [ev, cl, ob, ar, tr] = await Promise.all([
      this.sql`select id from continuity.events where org_id = ${org} and id = any(${ids.events})`,
      this.sql`select id from continuity.claims where org_id = ${org} and id = any(${ids.claims})`,
      this.sql`select id from continuity.obligations where org_id = ${org} and id = any(${ids.obligations})`,
      this.sql`select id from continuity.artifacts where org_id = ${org} and id = any(${ids.artifacts})`,
      this.sql`select seq from continuity.transitions where org_id = ${org} and seq = any(${ids.seqs})`,
    ]);
    return [...ev, ...cl, ...ob, ...ar].map((r) => r.id as string).concat(tr.map((r) => `transition seq ${r.seq}`));
  }

  /** Copy one task's whole working set (evidence and projection) verbatim, in one transaction. */
  async importTask(org: string, s: MemoryStore, taskId: string, extra: { raw: Map<string, unknown>; runs: Record<string, unknown>[]; blobs: BlobIn[]; label: string }) {
    await this.ensureOrg(org);
    const stored = await Promise.all(extra.blobs.map(async (b) => ({ b, ...(await this.#storeBytes(org, b)) })));
    await this.sql.begin(async (tx) => {
      const task = s.tasks.get(taskId)!;
      const events = s.eventsForTask(taskId);
      const eventIds = new Set(events.map((e) => e.id));
      const projection: Delta = {
        tasks: [], taskVersions: new Map(), events: [], eventRaw: new Map(), eventLinks: [],
        threads: s.threadsForTask(taskId).map((t) => ({ ...t, task_id: taskId })),
        extractions: s.extractions.filter((x) => eventIds.has(x.event_id)),
        artifacts: { inserted: s.artifactsForTask(taskId), updated: [] },
        claims: { inserted: s.claimsForTask(taskId), updated: [] },
        claimEvidence: s.claimEv.filter((x) => s.getClaim(x.claim_id)?.task_id === taskId),
        obligations: { inserted: s.obligationsForTask(taskId), updated: [] },
        transitions: s.transitionsForTask(taskId),
        checks: new Map([[taskId, s.getChecks(taskId)]]),
        flags: s.flags.filter((f) => f.task_id === taskId),
        counters: new Map(),
      };

      // the task row first, then the evidence (projection rows reference events), then the projection
      await this.#insertTaskRow(tx, org, task);
      for (const e of events) {
        const raw = extra.raw.get(e.id);
        await tx`insert into continuity.events ${tx({
          org_id: org, id: e.id, seq: e.seq, dedupe_key: e.dedupe_key, task_id: taskId, link_reason: e.link_reason, source: e.source, direction: e.direction,
          primitive_event_id: e.primitive_event_id ?? null, primitive_email_id: e.primitive_email_id ?? null, reply_to_sent_email_id: e.reply_to_sent_email_id ?? null,
          thread_id: e.thread_id, message_id: e.message_id, in_reply_to: e.in_reply_to, references: tx.json(e.references as never), from_addr: e.from,
          from_name: e.from_name ?? null, to_addrs: tx.json(e.to as never), cc_addrs: tx.json(e.cc as never), subject: e.subject, body_text: e.body_text,
          occurred_at: e.occurred_at, received_at: e.received_at, auth_verdict: e.auth_verdict ?? null, attachments: tx.json(e.attachments as never),
          raw: raw != null ? tx.json(raw as never) : null, time_flags: tx.json((e.time_flags ?? []) as never),
          processing_status: s.failed.has(e.id) ? 'failed' : s.isInterpreted(e.id) ? 'interpreted' : 'received',
        })}`;
      }
      await this.#flush(tx, org, s, projection);
      for (const st of stored) await this.#blobRow(tx, org, st.b, st);
      for (const [k, seq] of s.cursors) {
        const [agentId, tid] = k.split('\u0000');
        if (tid === taskId) await tx`insert into continuity.cursors (org_id, agent_id, task_id, last_seq, updated_at) values (${org}, ${agentId}, ${taskId}, ${seq}, now()) on conflict do nothing`;
      }
      // move every counter past the imported ids, so new ids never collide
      const maxId = (ids: string[]) => Math.max(0, ...ids.map((i) => Number(i.split('_')[1])).filter(Number.isFinite));
      const counters = {
        ev: maxId(events.map((e) => e.id)),
        cl: maxId(projection.claims.inserted.map((c) => c.id)),
        ob: maxId(projection.obligations.inserted.map((o) => o.id)),
        ar: maxId(projection.artifacts.inserted.map((a) => a.id)),
        fl: maxId(projection.flags.map((f) => f.id)),
        tr: Math.max(0, ...projection.transitions.map((t) => t.seq)),
      };
      for (const [name, value] of Object.entries(counters)) await this.#raiseCounter(tx, org, name, value);
      // events still waiting for interpretation get their job back
      const waiting = events.filter((e) => !s.isInterpreted(e.id) && !s.failed.has(e.id));
      await this.#enqueue(tx, org, waiting.map((e) => ({ kind: 'interpret_event' as const, task_id: taskId, event_id: e.id, seq: e.seq, dedupe_key: `interpret:${e.id}` })));
      await tx`insert into continuity.meta (org_id, key, value) values (${org}, ${`import:${taskId}`}, ${extra.label})
        on conflict (org_id, key) do update set value = excluded.value`;
    });
    for (const run of extra.runs) await this.saveAgentRun(org, { ...run, task_id: taskId });
  }

  async importLabel(org: string, taskId: string) {
    return (await this.sql`select value from continuity.meta where org_id = ${org} and key = ${`import:${taskId}`}`)[0]?.value as string | undefined;
  }

  /** Roll back an import: delete one task and everything scoped to it, evidence included, from one org. */
  async deleteTask(org: string, taskId: string) {
    await this.sql.begin(async (tx) => {
      await tx`delete from continuity.flags where org_id = ${org} and task_id = ${taskId}`;
      await tx`delete from continuity.jobs where org_id = ${org} and task_id = ${taskId}`;
      await tx`delete from continuity.claim_evidence ce using continuity.claims c
        where ce.org_id = ${org} and c.org_id = ce.org_id and c.id = ce.claim_id and c.task_id = ${taskId}`;
      await tx`delete from continuity.claims where org_id = ${org} and task_id = ${taskId}`;
      await tx`delete from continuity.artifacts where org_id = ${org} and task_id = ${taskId}`;
      // cascades to events, obligations, transitions, checks, cursors, runs and actions
      await tx`delete from continuity.tasks where org_id = ${org} and id = ${taskId}`;
      await tx`delete from continuity.meta where org_id = ${org} and key = ${`import:${taskId}`}`;
    });
  }

  // ------------------------------------------------------------------ principals

  async findPrincipal(hash: string): Promise<Principal | null> {
    const [r] = await this.sql`select * from continuity.api_tokens where token_hash = ${hash} and revoked_at is null`;
    return r ? { id: r.id, org: r.org_id, kind: r.kind, agent_id: r.agent_id ?? null, scopes: r.scopes, task_ids: r.task_ids ?? null, label: r.label ?? null } : null;
  }

  async createPrincipal(p: Principal, hash: string) {
    await this.sql`insert into continuity.api_tokens ${this.sql({
      token_hash: hash, id: p.id, org_id: p.org, kind: p.kind, agent_id: p.agent_id, scopes: p.scopes, task_ids: p.task_ids, label: p.label ?? null,
    })}`;
  }
}

// ------------------------------------------------------------------ row mappers

function rowToEvent(r: Row): StoredEvent {
  return {
    id: r.id, seq: Number(r.seq), dedupe_key: r.dedupe_key, task_id: r.task_id ?? null, link_reason: r.link_reason ?? null,
    source: r.source, direction: r.direction, primitive_event_id: r.primitive_event_id ?? null, primitive_email_id: r.primitive_email_id ?? null,
    reply_to_sent_email_id: r.reply_to_sent_email_id ?? null, thread_id: r.thread_id ?? null, message_id: r.message_id ?? null,
    in_reply_to: r.in_reply_to ?? null, references: r.references ?? [], from: r.from_addr, from_name: r.from_name ?? null,
    to: r.to_addrs ?? [], cc: r.cc_addrs ?? [], subject: r.subject, body_text: r.body_text, occurred_at: ts(r.occurred_at),
    received_at: ts(r.received_at), auth_verdict: r.auth_verdict ?? null, attachments: r.attachments ?? [],
    ...(r.time_flags?.length ? { time_flags: r.time_flags } : {}),
  };
}

function rowToArtifact(r: Row): Artifact {
  return {
    id: r.id, task_id: r.task_id, event_id: r.event_id, filename: r.filename, content_type: r.content_type, sha256: r.sha256,
    size_bytes: Number(r.size_bytes), kind: r.kind, version_label: r.version_label ?? null, text: r.text, status: r.status,
    superseded_by: r.superseded_by ?? null, owner: r.owner,
  };
}

function rowToClaim(r: Row): Claim {
  return {
    id: r.id, task_id: r.task_id, key: r.key, value: r.value, display: r.display, kind: r.kind, speaker: r.speaker,
    source_event_id: r.source_event_id, source_artifact_id: r.source_artifact_id ?? null, evidence: r.evidence, status: r.status,
    superseded_by: r.superseded_by ?? null, supersede_reason: r.supersede_reason ?? null, learned_at: ts(r.learned_at),
    confidence: Number(r.confidence), extractor: r.extractor,
  };
}

function rowToObligation(r: Row): Obligation {
  return {
    id: r.id, task_id: r.task_id, kind: r.kind, debtor: r.debtor, creditor: r.creditor, text: r.text, topic_keys: r.topic_keys ?? [],
    expects_artifact: r.expects_artifact ?? null, status: r.status, source_event_id: r.source_event_id, evidence: r.evidence,
    resolved_by_event_id: r.resolved_by_event_id ?? null, resolution_note: r.resolution_note ?? null, created_at: ts(r.created_at),
    resolved_at: tsOrNull(r.resolved_at), due_at: day(r.due_at), confidence: Number(r.confidence), notes: r.notes ?? [],
    issue_key: r.issue_key ?? null, group_id: r.group_id ?? null, quantity: numOrNull(r.quantity), fulfilled_quantity: numOrNull(r.fulfilled_quantity),
    artifact_match: r.artifact_match ?? null, condition: r.condition ?? null, condition_met_at: tsOrNull(r.condition_met_at),
  };
}

function rowToJob(r: Row): JobRow {
  return {
    id: String(r.id), org: r.org_id, kind: r.kind, task_id: r.task_id ?? null, event_id: r.event_id ?? null, seq: Number(r.seq),
    dedupe_key: r.dedupe_key, payload: r.payload ?? {}, status: r.status, attempts: r.attempts, max_attempts: r.max_attempts,
    run_after: ts(r.run_after), locked_by: r.locked_by ?? null, locked_until: tsOrNull(r.locked_until), last_error: r.last_error ?? null,
  };
}

function rowToAction(r: Row): ActionRow {
  return {
    id: r.id, org: r.org_id, task_id: r.task_id, agent_id: r.agent_id, principal_id: r.principal_id ?? null, idempotency_key: r.idempotency_key,
    based_on_version: Number(r.based_on_version), to_addr: r.to_addr, subject: r.subject, body: r.body, body_sha256: r.body_sha256,
    in_reply_to: r.in_reply_to ?? null, references: r.references ?? [], status: r.status, attempts: r.attempts, provider: r.provider ?? null,
    primitive_email_id: r.primitive_email_id ?? null, event_id: r.event_id ?? null, last_error: r.last_error ?? null,
    created_at: ts(r.created_at), updated_at: ts(r.updated_at),
  };
}

function actionToRow(sql: Sql, a: ActionRow) {
  return {
    org_id: a.org, id: a.id, task_id: a.task_id, agent_id: a.agent_id, principal_id: a.principal_id, idempotency_key: a.idempotency_key,
    based_on_version: a.based_on_version, to_addr: a.to_addr, subject: a.subject, body: a.body, body_sha256: a.body_sha256,
    in_reply_to: a.in_reply_to, references: sql.json(a.references as never), status: a.status, attempts: a.attempts,
    provider: a.provider ? sql.json(a.provider as never) : null, primitive_email_id: a.primitive_email_id, event_id: a.event_id,
    last_error: a.last_error, created_at: a.created_at, updated_at: a.updated_at,
  };
}
