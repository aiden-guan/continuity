// Copies chosen tasks from an existing SQLite database into Supabase Postgres.
//
//   npm run import:sqlite -- --db data/demo.db                       # dry run: inventory only (default)
//   npm run import:sqlite -- --db data/demo.db --org org_demo --apply
//   npm run import:sqlite -- --db data/demo.db --org org_demo --task PO-4817 --apply --mode replay
//   npm run import:sqlite -- --org org_demo --task PO-4817 --rollback   # delete that imported task from Postgres
//
// The SQLite file is opened read-only and is never changed. Nothing moves implicitly: you name the file,
// the target organization and (optionally) which tasks.
//   copy   (default) evidence + projection rows copied as-is; ids kept; integrity = exact equality
//   replay evidence + saved extraction proposals re-applied by today's resolver; evidence must match
//          exactly, projection differences are reported (expected after semantic upgrades)
// After importing we check: evidence fingerprints, extraction versions, projection fingerprint (copy),
// and an in-memory replay of the imported evidence, which must reproduce the imported projection.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { SqliteBackend } from '../src/store/sqlite.ts';
import { PostgresBackend } from '../src/store/postgres.ts';
import type { MemoryStore } from '../src/store/state.ts';
import type { BlobIn } from '../src/store/backend.ts';
import { replayTask } from '../src/engine/replay.ts';
import { storageConfig } from '../src/store/index.ts';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Hash of the database file together with its write-ahead log (rows not yet checkpointed live in -wal). */
function fileSha(path: string) {
  const parts = [readFileSync(path)];
  if (existsSync(`${path}-wal`)) parts.push(readFileSync(`${path}-wal`));
  return sha256(Buffer.concat(parts));
}

/** JSON with object keys sorted, because Postgres jsonb does not keep key order. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
  });

/** Everything that identifies the evidence of a task: events, bodies (hashed), attachments and extractions. */
export function evidenceFingerprint(store: MemoryStore, taskId: string) {
  return store.eventsForTask(taskId).map((e) => ({
    id: e.id,
    seq: e.seq,
    dedupe_key: e.dedupe_key,
    direction: e.direction,
    from: e.from,
    to: e.to,
    subject: e.subject,
    body_sha256: sha256(e.body_text),
    thread_id: e.thread_id,
    message_id: e.message_id,
    primitive_email_id: e.primitive_email_id ?? null,
    attachments: e.attachments.map((att) => [att.filename, att.sha256, att.size_bytes, att.part_index]),
    extractions: store.extractionsFor(e.id).map((x) => [x.extractor, sha256(canonical(x.proposal))]),
  }));
}

/** The derived state of a task, reduced to the fields that matter for comparison. */
export function projectionFingerprint(store: MemoryStore, taskId: string) {
  return {
    claims: store.claimsForTask(taskId).map((c) => [c.id, c.key, c.status, canonical(c.value), c.superseded_by, c.source_event_id, store.claimEvidence(c.id).length]),
    obligations: store.obligationsForTask(taskId).map((o) => [o.id, o.kind, o.status, o.debtor, o.due_at, o.resolved_by_event_id]),
    artifacts: store.artifactsForTask(taskId).map((art) => [art.id, art.filename, art.sha256, art.status, art.superseded_by]),
    checks: store.getChecks(taskId).map((c) => [c.id, c.status, c.detail]).sort(),
    transitions: store.transitionsForTask(taskId).map((t) => [t.type, t.summary]),
  };
}

const sameJson = (x: unknown, y: unknown) => canonical(x) === canonical(y);

/** Projection sections compared between source, target and replay. */
const PROJECTION_PARTS = ['claims', 'obligations', 'artifacts', 'checks'] as const;
type Projection = ReturnType<typeof projectionFingerprint>;
const differingParts = (x: Projection, y: Projection) => PROJECTION_PARTS.filter((k) => !sameJson(x[k], y[k]));

export interface ImportReport {
  source: string; source_sha256_before: string; source_sha256_after?: string; org: string; mode: 'copy' | 'replay'; dry_run: boolean;
  tasks: { id: string; alias: string; events: number; extractions: number; claims: number; obligations: number; artifacts: number; transitions: number; pending: number; attachment_blobs: number; agent_runs: number;
    status: 'planned' | 'imported' | 'already_imported' | 'skipped_collision' | 'failed'; detail?: string; integrity?: Record<string, boolean | string> }[];
  unlinked_events_not_imported: number;
}
type TaskRow = ImportReport['tasks'][number];

export async function importSqlite(opts: { db: string; org: string; target: PostgresBackend | null; tasks?: string[]; apply: boolean; mode?: 'copy' | 'replay' }): Promise<ImportReport> {
  if (!existsSync(opts.db)) throw new Error(`no such SQLite file: ${opts.db}`);
  const shaBefore = fileSha(opts.db);
  const source = new SqliteBackend(opts.db, { readOnly: true });
  const mode = opts.mode ?? 'copy';
  await source.ensureOrg(opts.org);

  const wanted = opts.tasks;
  const allTasks = await source.listTasks(opts.org);
  const selected = allTasks.filter((t) => !wanted?.length || wanted.includes(t.spec.id) || wanted.includes(t.spec.alias));
  const report: ImportReport = {
    source: opts.db,
    source_sha256_before: shaBefore,
    org: opts.org,
    mode,
    dry_run: !opts.apply,
    tasks: [],
    unlinked_events_not_imported: (await source.unlinkedEvents(opts.org)).length,
  };

  for (const t of selected) {
    const taskId = t.spec.id;
    const store = (await source.loadTask(opts.org, taskId)).store;
    const events = store.eventsForTask(taskId);

    // raw payloads and cached attachment bytes travel with the evidence
    const raw = new Map<string, unknown>();
    for (const e of events) raw.set(e.id, await source.getEventRaw(opts.org, e.id));
    const blobs: BlobIn[] = [];
    for (const e of events) {
      for (const att of e.attachments) {
        const bytes = await source.getBlob(opts.org, { event_id: e.id, part_index: att.part_index }).catch(() => null);
        if (!bytes) continue;
        blobs.push({ event_id: e.id, part_index: att.part_index, sha256: att.sha256 || sha256(bytes), content_type: att.content_type, size_bytes: bytes.length, bytes, primitive_email_id: e.primitive_email_id ?? null });
      }
    }
    const runs = await source.agentRuns(opts.org, taskId);

    const row: TaskRow = {
      id: taskId,
      alias: t.spec.alias,
      events: events.length,
      extractions: store.extractions.length,
      claims: store.claimsForTask(taskId).length,
      obligations: store.obligationsForTask(taskId).length,
      artifacts: store.artifactsForTask(taskId).length,
      transitions: store.transitionsForTask(taskId).length,
      pending: store.pendingEventIds(taskId).length,
      attachment_blobs: blobs.length,
      agent_runs: runs.length,
      status: 'planned',
    };
    report.tasks.push(row);
    if (!opts.apply || !opts.target) continue;

    const target = opts.target;
    const label = `sqlite:${shaBefore.slice(0, 16)}:${mode}`;
    try {
      // a task that already exists is either our own earlier import (no-op) or a collision
      const existing = await target.getTask(opts.org, taskId);
      if (existing) {
        const previousLabel = await target.importLabel(opts.org, taskId);
        const there = (await target.loadTask(opts.org, taskId)).store;
        const repeat = previousLabel === label && sameJson(evidenceFingerprint(there, taskId), evidenceFingerprint(store, taskId));
        row.status = repeat ? 'already_imported' : 'skipped_collision';
        row.detail = repeat
          ? 'identical evidence already present (repeat run is a no-op)'
          : `task ${taskId} already exists in ${opts.org}${previousLabel ? ` (import ${previousLabel})` : ''}; roll it back first or choose another --org`;
        continue;
      }
      const collisions = await target.existingIds(opts.org, {
        events: events.map((e) => e.id),
        claims: store.claimsForTask(taskId).map((c) => c.id),
        obligations: store.obligationsForTask(taskId).map((o) => o.id),
        artifacts: store.artifactsForTask(taskId).map((art) => art.id),
        seqs: store.transitionsForTask(taskId).map((x) => x.seq),
      });
      if (collisions.length) {
        row.status = 'skipped_collision';
        row.detail = `ids already used in ${opts.org}: ${collisions.slice(0, 8).join(', ')}${collisions.length > 8 ? ', …' : ''} — import into a fresh --org`;
        continue;
      }

      if (mode === 'copy') {
        await target.importTask(opts.org, store, taskId, { raw, runs, blobs, label });
      } else {
        // replay: the evidence keeps its original ids and is interpreted by today's resolver from the saved proposals
        const replayed = await replayTask(store, taskId, { raw: (e) => raw.get(e.id) });
        // keep the original interpretation rows (extractor, time, proposal) that the replay applied
        replayed.extractions = store.extractions.map((x) => ({ ...x }));
        await target.importTask(opts.org, replayed, taskId, { raw, runs, blobs, label });
      }

      // ---- integrity checks on what actually landed in Postgres
      const landed = (await target.loadTask(opts.org, taskId)).store;
      const integrity: Record<string, boolean | string> = {};
      integrity.evidence_identical = sameJson(evidenceFingerprint(landed, taskId), evidenceFingerprint(store, taskId));
      const srcProjection = projectionFingerprint(store, taskId);
      const tgtProjection = projectionFingerprint(landed, taskId);
      if (mode === 'copy') integrity.projection_identical = sameJson(srcProjection, tgtProjection);
      else integrity.projection_diff = differingParts(srcProjection, tgtProjection).join(', ') || 'none';
      // re-apply the imported evidence + proposals with today's resolver
      const reReplayed = await replayTask(landed, taskId);
      const replayDiff = differingParts(projectionFingerprint(reReplayed, taskId), tgtProjection);
      if (mode === 'replay') integrity.replay_reproduces_projection = replayDiff.length === 0; // must hold: today's resolver built this projection
      else integrity.current_resolver_would_differ_in = replayDiff.join(', ') || 'nothing'; // for information: the data came from an earlier version
      integrity.attachment_blobs = `${blobs.length} copied`;
      row.integrity = integrity;

      const failedChecks = Object.entries(integrity).filter(([, v]) => v === false).map(([k]) => k);
      row.status = failedChecks.length ? 'failed' : 'imported';
      if (failedChecks.length) row.detail = `integrity check failed: ${failedChecks.join(', ')} — roll back with --rollback`;
    } catch (err) {
      row.status = 'failed';
      row.detail = (err as Error).message;
    }
  }

  await source.close();
  report.source_sha256_after = fileSha(opts.db);
  if (report.source_sha256_after !== shaBefore) throw new Error('source SQLite file changed during import (it must be read-only)');
  return report;
}

// ---------------------------------------------------------------- CLI
async function rollback(target: PostgresBackend, org: string, tasks: string[] | undefined) {
  if (!tasks?.length) throw new Error('--rollback needs --task <id> (one or more)');
  for (const ref of tasks) {
    const task = await target.getTask(org, ref);
    if (!task) {
      console.log(`${ref}: not present in ${org}`);
      continue;
    }
    await target.deleteTask(org, task.id);
    console.log(`${task.alias} (${task.id}): removed from ${org}`);
  }
}

function printReport(r: ImportReport, target: PostgresBackend | null) {
  console.log(`${r.dry_run ? 'DRY RUN (nothing written; add --apply)' : 'IMPORT'}: ${r.source} → ${target ? target.target : 'Supabase Postgres'} org=${r.org} mode=${r.mode}`);
  for (const t of r.tasks) {
    console.log(`  ${t.alias} (${t.id}): ${t.events} events, ${t.extractions} extractions, ${t.claims} claims, ${t.obligations} obligations, ${t.artifacts} documents, ${t.transitions} transitions, ${t.pending} pending, ${t.attachment_blobs} cached attachments, ${t.agent_runs} agent runs → ${t.status}${t.detail ? ` — ${t.detail}` : ''}`);
    if (t.integrity) console.log(`    integrity: ${Object.entries(t.integrity).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }
  console.log(`  unlinked events (not part of a task, not imported): ${r.unlinked_events_not_imported}`);
  console.log(`  source unchanged: sha256 ${r.source_sha256_before.slice(0, 16)}… before and after`);
}

if (process.argv[1]?.endsWith('import-sqlite.ts')) {
  const { values: cli } = parseArgs({
    options: {
      db: { type: 'string' },
      org: { type: 'string', default: process.env.CONTINUITY_ORG || 'org_local' },
      task: { type: 'string', multiple: true },
      apply: { type: 'boolean', default: false },
      mode: { type: 'string', default: 'copy' },
      rollback: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });

  // Postgres is only opened when something will be written or removed
  let target: PostgresBackend | null = null;
  if (cli.apply || cli.rollback) {
    const cfg = storageConfig({ ...process.env, CONTINUITY_STORE: 'postgres' });
    target = new PostgresBackend(cfg.url!, { storage: cfg.storage ?? null });
    await target.init();
  }
  try {
    if (cli.rollback) {
      await rollback(target!, cli.org!, cli.task);
    } else {
      if (!cli.db) throw new Error('--db <sqlite file> is required');
      const report = await importSqlite({ db: cli.db, org: cli.org!, target, tasks: cli.task, apply: !!cli.apply, mode: cli.mode as 'copy' | 'replay' });
      if (cli.json) console.log(JSON.stringify(report, null, 2));
      else printReport(report, target);
      if (report.tasks.some((t) => t.status === 'failed')) process.exitCode = 1;
    }
  } finally {
    await target?.close();
  }
}
