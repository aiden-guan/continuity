// The hosted deployment against a real (local) Supabase stack. Covers the authenticated,
// tenant-scoped HTTP API over the Postgres store, the private Storage cache for attachments,
// health/status output, and the SQLite importer's integrity checks.
// Every test here is skipped unless CONTINUITY_TEST_DB_URL is set (npm run test:supabase).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/server.ts';
import { mintToken } from '../src/auth.ts';
import { LocalSimTransport } from '../src/transport/transport.ts';
import { SimMailbox } from '../src/sim/mailbox.ts';
import { fromPrimitiveWebhook } from '../src/ingest/normalize.ts';
import { counterparty, defaultAddresses, procurementTask, quoteV1 } from '../src/sim/scenario.ts';
import { Harness, runCanonicalScenario } from '../src/sim/harness.ts';
import { SqliteBackend } from '../src/store/sqlite.ts';
import type { PostgresBackend } from '../src/store/postgres.ts';
import { importSqlite } from '../scripts/import-sqlite.ts';
import { PG_URL, STORAGE, pg, closeAll, uniqueOrg } from './backends.ts';

const skip = !PG_URL ? 'CONTINUITY_TEST_DB_URL not set (npm run test:supabase)' : false;

const addr = defaultAddresses();
const orgA = uniqueOrg('tenantA');
const orgB = uniqueOrg('tenantB');

let baseUrl = '';
let app: Awaited<ReturnType<typeof buildApp>> | null = null;

// Bearer tokens minted once for the whole file:
//   opA / opB  operators of org A and org B
//   agentA     agent "agent-a", limited to task_po4817 in org A
//   otherTask  agent "agent-z", limited to a different task in org A
const tokens: Record<string, string> = {};

const sha256 = (data: Buffer | Uint8Array) => createHash('sha256').update(data).digest('hex');

before(async () => {
  if (skip) return;
  const backend = await pg({ storage: !!STORAGE });
  app = await buildApp({ backend, auth: 'required', transport: new LocalSimTransport(), worker: false, org: orgA, port: 0 });
  await new Promise<void>((resolve) => app!.server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const mint = async (spec: Parameters<typeof mintToken>[1]) => (await mintToken(backend, spec)).token;
  tokens.opA = await mint({ org: orgA, kind: 'operator', label: 'test operator A' });
  tokens.opB = await mint({ org: orgB, kind: 'operator', label: 'test operator B' });
  tokens.agentA = await mint({ org: orgA, kind: 'agent', agent_id: 'agent-a', task_ids: ['task_po4817'] });
  tokens.otherTask = await mint({ org: orgA, kind: 'agent', agent_id: 'agent-z', task_ids: ['task_other'] });
});

after(async () => {
  if (app) {
    app.server.close();
    app.engine.stop();
  }
  await closeAll();
});

// Calls the API with an optional bearer token. The body is parsed as JSON when possible.
async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, body: parsed, headers: res.headers };
}

test('health reports the authoritative Supabase store, auth and transport modes', { skip }, async () => {
  const health = await call('GET', '/api/health', null);
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.storage.mode, 'postgres');
  assert.equal(health.body.storage.authoritative, true);
  assert.equal(health.body.auth, 'required');
  assert.equal(health.body.transport, 'local-sim');
  assert.doesNotMatch(JSON.stringify(health.body), /postgres:postgres@|sb_secret|eyJ/, 'no credentials in health output');
});

test('authentication and scopes: no token → 401; agent tokens are task- and identity-scoped', { skip }, async () => {
  assert.equal((await call('GET', '/tasks', null)).status, 401);
  assert.equal((await call('GET', '/tasks', 'ctk_not_a_real_token')).status, 401);
  assert.equal((await call('POST', '/tasks', tokens.opA, procurementTask(addr))).status, 200);
  const agentDefines = await call('POST', '/tasks', tokens.agentA, { ...procurementTask(addr), id: 't2', alias: 'X-2' });
  assert.equal(agentDefines.status, 403, 'agents cannot define tasks');

  const ctx = await call('GET', '/tasks/PO-4817/context', tokens.agentA);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.context.meta.for_agent, 'agent-a', "an agent token's cursor is its own");
  assert.equal((await call('GET', '/tasks/PO-4817/context', tokens.otherTask)).status, 404, 'tasks outside the token scope do not exist for it');

  const version = ctx.body.state_version;
  const impersonation = await call('POST', '/tasks/PO-4817/send', tokens.agentA, { agent_id: 'agent-b', to: addr.supplier, body: 'hi', based_on_version: version });
  assert.equal(impersonation.status, 403, 'an agent cannot act as another agent');
  const unversioned = await call('POST', '/tasks/PO-4817/send', tokens.agentA, { agent_id: 'agent-a', to: addr.supplier, body: 'Hi Dana, can you quote 500 units?' });
  assert.equal(unversioned.status, 428, 'hosted sends must state the version they were decided on');
  const sent = await call('POST', '/tasks/PO-4817/send', tokens.agentA, { agent_id: 'agent-a', to: addr.supplier, body: 'Hi Dana, can you quote 500 AX-200 boards by Friday Oct 23?', based_on_version: version });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.status, 'delivered');

  const actions = await call('GET', '/tasks/PO-4817/actions', tokens.opA);
  assert.equal(actions.body.length, 1);
  assert.equal(actions.body[0].status, 'delivered');
});

test('tenant separation: same task id/alias and same evidence ids in two orgs never cross', { skip }, async () => {
  assert.equal((await call('POST', '/tasks', tokens.opB, procurementTask(addr))).status, 200, 'org B may use the same task id and alias');
  const stateA = await call('GET', '/tasks/PO-4817/state', tokens.opA);
  const stateB = await call('GET', '/tasks/PO-4817/state', tokens.opB);
  assert.equal(stateB.body.actions.length, 0, "org A's send is invisible to org B");
  assert.ok(stateA.body.actions.length >= 1);

  const eventInA = (await call('GET', '/tasks/PO-4817/timeline', tokens.opA)).body.events[0].id;
  const readFromB = await call('GET', `/events/${eventInA}`, tokens.opB);
  assert.equal(readFromB.status, 404, `${eventInA} exists in org A only`);
  assert.equal((await call('GET', '/items/cl_1/provenance', tokens.opB)).status, 404);
  assert.equal((await call('GET', '/tasks', tokens.opB)).body.length, 1);
});

test('attachments: cached privately with source id and hash; readable only through scoped evidence access', { skip }, async () => {
  const mailbox = new SimMailbox();
  const quotePdf = quoteV1();
  const delivery = mailbox.inbound({
    from: addr.supplier, fromName: 'Dana', to: addr.self, subject: 'PO-4817 quote', body: 'Quote attached: $11.40 per unit.',
    at: '2026-10-19T11:20:00Z', threadKey: 'att', attachments: [{ filename: 'Q-2291.pdf', content_type: 'application/pdf', bytes: quotePdf }],
  }, 'k');
  const input = fromPrimitiveWebhook(JSON.parse(delivery.body));
  const ingested = await app!.engine.ingest(orgA, input);
  assert.equal(ingested.linked, true);
  const attachmentPath = `/events/${ingested.event.id}/attachments/0`;
  const expectedHash = sha256(quotePdf);

  // The owning operator gets the exact bytes back, with the hash in a header.
  const download = await fetch(`${baseUrl}${attachmentPath}`, { headers: { authorization: `Bearer ${tokens.opA}` } });
  assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(sha256(bytes), expectedHash);
  assert.equal(download.headers.get('x-content-sha256'), expectedHash);
  assert.equal((await call('GET', attachmentPath, tokens.opB)).status, 404, 'another org cannot read it');
  assert.equal((await call('GET', attachmentPath, tokens.otherTask)).status, 404, 'a token for another task cannot read it');

  // The cache row records where the bytes live and what they came from.
  const backend = app!.backend as PostgresBackend;
  const [row] = await backend.sql`select storage, storage_path, primitive_email_id, sha256 from continuity.attachment_blobs where org_id = ${orgA} and event_id = ${ingested.event.id}`;
  assert.equal(row.sha256, expectedHash);
  assert.equal(row.primitive_email_id, input.primitive_email_id);

  if (!STORAGE) {
    assert.equal(row.storage, 'postgres_inline');
    return;
  }
  assert.equal(row.storage, 'supabase_storage');
  const publicRes = await fetch(`${STORAGE.url}/storage/v1/object/public/${STORAGE.bucket}/${row.storage_path}`);
  assert.ok(publicRes.status >= 400, `public URL must not serve the object (got ${publicRes.status})`);
  const anonKey = process.env.CONTINUITY_TEST_ANON_KEY;
  if (anonKey) {
    const anonRes = await fetch(`${STORAGE.url}/storage/v1/object/${STORAGE.bucket}/${row.storage_path}`, { headers: { apikey: anonKey, authorization: `Bearer ${anonKey}` } });
    assert.ok(anonRes.status >= 400, `anon key must not read the private bucket (got ${anonRes.status})`);
  }
});

test('the database schema is private: anon/authenticated roles have no access to evidence', { skip }, async () => {
  const backend = app!.backend as PostgresBackend;
  const grants = await backend.sql`select grantee, table_name from information_schema.role_table_grants where table_schema = 'continuity' and grantee in ('anon', 'authenticated') and table_name in ('events', 'claims', 'api_tokens', 'attachment_blobs', 'outbound_actions')`;
  assert.deepEqual([...grants], []);
  const tablesWithoutRls = await backend.sql`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'continuity' and c.relkind = 'r' and not c.relrowsecurity`;
  assert.deepEqual([...tablesWithoutRls], [], 'RLS enabled on every table');
  // The database itself refuses to edit stored evidence.
  const [someEvent] = await backend.sql`select id from continuity.events where org_id = ${orgA} limit 1`;
  await assert.rejects(backend.sql`update continuity.events set body_text = 'tampered' where org_id = ${orgA} and id = ${someEvent.id}`, /immutable/);
});

test('the canonical story persists through Supabase and resumes in a new process-equivalent (fresh backend + engine)', { skip }, async () => {
  const org = uniqueOrg('resume');
  const firstPool = await pg();
  const h = new Harness(procurementTask(addr), undefined, undefined, { backend: firstPool, org });
  await h.ready;
  await runCanonicalScenario(h, addr, counterparty);
  const briefingBefore = h.briefing('agent-b');
  await firstPool.close();

  // A new pool and engine: nothing is carried over in memory.
  const secondPool = await pg();
  const snap = await secondPool.loadTask(org, 'task_po4817');
  const { compileContext } = await import('../src/compiler/compile.ts');
  const { renderBriefing } = await import('../src/compiler/render.ts');
  const briefingAfter = renderBriefing(compileContext(snap.store, 'task_po4817', { agentId: 'agent-b' }));
  const withoutTimestamp = (text: string) => text.replace(/compiled_at.*$/m, '');
  assert.equal(withoutTimestamp(briefingAfter), withoutTimestamp(briefingBefore));
  const liveSchedule = snap.store.claimsForTask('task_po4817').find((c) => c.status === 'active' && c.key === 'delivery.schedule');
  assert.equal(liveSchedule?.display, '300 units Fri Oct 23 + 200 units Wed Oct 28');
});

test('SQLite import: dry-run inventory, exact copy with integrity checks, repeatable, source untouched, rollback', { skip }, async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'continuity-import-'));
  try {
    // Build a local SQLite database holding the canonical story.
    const dbFile = join(workDir, 'source.db');
    const source = new SqliteBackend(dbFile);
    const local = new Harness(procurementTask(addr), undefined, undefined, { backend: source, org: 'org_local' });
    await local.ready;
    await runCanonicalScenario(local, addr, counterparty);
    await source.close();
    const fileHash = () => sha256(readFileSync(dbFile));
    const hashBefore = fileHash();

    const target = (await pg()) as PostgresBackend;
    const org = uniqueOrg('import');

    // Dry run: report what would be copied, write nothing.
    const plan = await importSqlite({ db: dbFile, org, target, apply: false });
    assert.equal(plan.dry_run, true);
    assert.equal(plan.tasks[0].status, 'planned');
    assert.equal(plan.tasks[0].events, 5);
    assert.equal(plan.unlinked_events_not_imported, 1);
    assert.equal(await target.getTask(org, 'task_po4817'), null, 'dry run writes nothing');

    // Real import, verified field for field.
    const applied = await importSqlite({ db: dbFile, org, target, apply: true });
    const [imported] = applied.tasks;
    assert.equal(imported.status, 'imported', JSON.stringify(imported));
    assert.equal(imported.integrity!.evidence_identical, true);
    assert.equal(imported.integrity!.projection_identical, true);
    assert.equal(imported.attachment_blobs, 1, 'the quote PDF bytes were copied to the private cache');

    // Running it again is a no-op, and the source file never changes.
    const rerun = await importSqlite({ db: dbFile, org, target, apply: true });
    assert.equal(rerun.tasks[0].status, 'already_imported');
    assert.equal(fileHash(), hashBefore, 'source database untouched');

    // The imported task is live: new mail continues it with ids after the imported ones.
    const hosted = new Harness(procurementTask(addr), undefined, undefined, { backend: target, org, create: false });
    await hosted.ready;
    const next = await hosted.in({ from: addr.supplier, fromName: 'Dana', to: addr.self, subject: 'Re: PO-4817', body: 'Pricing update: $11.45 per unit.', at: '2026-10-21T09:00:00Z', threadKey: 's' });
    assert.equal(next.event.id, 'ev_7');

    // Rolling back removes the task and everything under it.
    await target.deleteTask(org, 'task_po4817');
    assert.equal(await target.getTask(org, 'task_po4817'), null, 'rollback removed the task and its rows');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
