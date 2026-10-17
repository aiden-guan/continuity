// API hardening: authentication before any lookup, request hygiene (JSON only, body cap, 405), startup
// refusals for an open API, DNS rebinding, a webhook that fails closed, ingest by id, and server-side
// task validation. Ported from samrocksnature's test/security.test.ts onto per-principal tokens.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { signWebhookPayload } from '@primitivedotdev/sdk';
import { buildApp } from '../src/server.ts';
import { Continuity, HttpError, validateTaskSpec } from '../src/service.ts';
import { mintToken } from '../src/auth.ts';
import { registeredDomains } from '../src/domain/index.ts';
import { guardSend } from '../src/engine/guard.ts';
import { heuristicExtractor } from '../src/extract/heuristic.ts';
import { SimMailbox } from '../src/sim/mailbox.ts';
import { counterparty, defaultAddresses, procurementTask } from '../src/sim/scenario.ts';
import { MemoryBackend } from '../src/store/memory-backend.ts';
import { LocalSimTransport, PrimitiveTransport } from '../src/transport/transport.ts';

delete process.env.PRIMITIVE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.PRIMITIVE_WEBHOOK_SECRET;

const addr = defaultAddresses();
const ORG = 'org_security';
const T = { operator: '', agent: '', reader: '', ingest: '' };
const transport = new LocalSimTransport();
let base = '';
let close: () => void;

before(async () => {
  const backend = new MemoryBackend();
  const built = await buildApp({ backend, port: 0, auth: 'required', transport, worker: false, org: ORG });
  T.operator = (await mintToken(backend, { org: ORG, kind: 'operator' })).token;
  T.agent = (await mintToken(backend, { org: ORG, kind: 'agent', agent_id: 'agent-x' })).token;
  T.reader = (await mintToken(backend, { org: ORG, kind: 'agent', agent_id: 'agent-r', scopes: ['context:read'] })).token;
  T.ingest = (await mintToken(backend, { org: ORG, kind: 'ingest' })).token;
  await new Promise<void>((resolve) => built.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(built.server.address() as AddressInfo).port}`;
  close = () => built.server.close();
  assert.equal((await call('POST', '/tasks', T.operator, procurementTask(addr))).status, 200);
});
after(() => close());

async function call(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

const listening = async (built: Awaited<ReturnType<typeof buildApp>>) => {
  await new Promise<void>((resolve) => built.server.listen(0, '127.0.0.1', resolve));
  return (built.server.address() as AddressInfo).port;
};

test('no or wrong token → 401 with WWW-Authenticate, before any task lookup; health stays public', async () => {
  const none = await call('GET', '/tasks/PO-4817/context', null);
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate') ?? '', /^Bearer/);
  assert.equal((await call('GET', '/tasks/PO-4817/context', 'ctk_not_a_real_token_at_all_000000')).status, 401);
  // unknown task ids are not revealed to unauthenticated callers
  assert.equal((await call('GET', '/tasks/nope/context', null)).status, 401);
  const health = await call('GET', '/api/health', null);
  assert.equal(health.status, 200);
  assert.equal(health.body.extractor_breaker, 'closed');
});

test('scopes: read-only reads, agents send, only operators create tasks, the ingest token does nothing else', async () => {
  assert.equal((await call('GET', '/tasks/PO-4817/state', T.reader)).status, 200);
  assert.equal((await call('POST', '/tasks/PO-4817/send', T.reader, { agent_id: 'agent-r', to: addr.supplier, body: 'hi' })).status, 403);
  assert.equal((await call('POST', '/tasks/PO-4817/send', T.agent, { agent_id: 'agent-x', to: addr.supplier, body: 'Hi Dana, can you quote 500 units?' })).status, 200);
  assert.equal((await call('POST', '/tasks', T.agent, { ...procurementTask(addr), id: 'task_evil', alias: 'EVIL-1' })).status, 403);
  assert.equal((await call('GET', '/tasks/PO-4817/state', T.ingest)).status, 403);
  assert.equal((await call('POST', '/tasks/PO-4817/send', T.ingest, { agent_id: 'i', to: addr.supplier, body: 'hi' })).status, 403);
  assert.equal((await call('POST', '/sim/clock', T.agent, { now: '2026-10-19T09:00:00Z' })).status, 403);
});

test('request hygiene: JSON content-type required, malformed JSON → 400, oversized body → 413, wrong method → 405', async () => {
  // a cross-site page can POST text/plain without a CORS preflight; that must not work
  const plain = await call('POST', '/tasks/PO-4817/send', T.agent, JSON.stringify({ agent_id: 'agent-x', to: addr.supplier, body: 'hi' }), { 'content-type': 'text/plain' });
  assert.equal(plain.status, 415);
  assert.equal((await call('POST', '/tasks/PO-4817/send', T.agent, '{"agent_id":')).status, 400);
  assert.equal((await call('POST', '/tasks/PO-4817/send', T.agent, '[1, 2]')).status, 400);
  assert.equal((await call('POST', '/tasks/PO-4817/cursor', T.agent, { agent_id: 'agent-x' })).status, 400);
  const big = await call('POST', '/tasks/PO-4817/send', T.agent, { agent_id: 'agent-x', to: addr.supplier, body: 'x'.repeat(5 * 1024 * 1024) });
  assert.equal(big.status, 413);
  assert.equal((await call('GET', '/no-such-route', T.operator)).status, 404);
  assert.equal((await call('DELETE', '/tasks', T.operator)).status, 405);
});

test('the observability UI cannot be framed', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  await res.arrayBuffer();
});

test('ingest takes only an id: the server fetches the email and keeps only mail to an agent inbox', async () => {
  const detail = (id: string, to: string) => ({
    id, message_id: `<${id}@northwind>`, sender: addr.supplier, recipient: to, subject: 'PO-4817 update',
    body_text: 'Unit price for PO-4817 is $11.40 per unit.', from_header: `Dana Ruiz <${addr.supplier}>`, from_email: addr.supplier, to_email: to,
    received_at: '2026-10-20T09:00:00Z', created_at: '2026-10-20T09:00:00Z', thread_id: `thr_${id}`, reply_to_sent_email_id: null,
    parsed: { in_reply_to: [], references: [], attachments: [], cc: [] }, auth: { dmarc: 'pass' },
  });
  transport.details.set('em_ours', detail('em_ours', addr.self));
  transport.details.set('em_other_inbox', detail('em_other_inbox', 'sales@acme-buyer.primitive.email'));

  const ours = await call('POST', '/ingest/primitive-email', T.ingest, { id: 'em_ours' });
  assert.equal(ours.status, 200);
  assert.equal(ours.body.linked, true);
  const other = await call('POST', '/ingest/primitive-email', T.ingest, { id: 'em_other_inbox' });
  assert.equal(other.status, 200);
  assert.equal(other.body.ignored, true);
  assert.equal((await call('POST', '/ingest/primitive-email', T.ingest, { id: 'em_unknown' })).status, 404);
  // a caller can no longer hand over email content of its own
  assert.equal((await call('POST', '/ingest/primitive-email', T.ingest, { ...detail('em_forged', addr.self), id: undefined })).status, 400);
  assert.equal((await call('POST', '/ingest/primitive-email', T.ingest, { id: '../../etc' })).status, 400);
});

test('task validation: participants, self address and domain pack are checked server-side', async () => {
  const good = procurementTask(addr);
  const cases: [string, unknown][] = [
    ['no self participant', { ...good, id: 't1', alias: 'T-1', participants: good.participants.filter((p) => p.role !== 'self') }],
    ['self_address not the self participant', { ...good, id: 't2', alias: 'T-2', self_address: 'someone@else.example' }],
    ['duplicate participant', { ...good, id: 't3', alias: 'T-3', participants: [...good.participants, { ...good.participants[1] }] }],
    ['bad address', { ...good, id: 't4', alias: 'T-4', participants: good.participants.map((p, i) => (i === 1 ? { ...p, address: 'not-an-address' } : p)) }],
    ['bad id', { ...good, id: '../x', alias: 'T-5' }],
    ['unknown role', { ...good, id: 't6', alias: 'T-6', participants: good.participants.map((p, i) => (i === 1 ? { ...p, role: 'owner' } : p)) }],
    ['unknown domain pack', { ...good, id: 't7', alias: 'T-7', domain: 'no_such_pack' }],
    ['bad requirement key', { ...good, id: 't8', alias: 'T-8', requirements: [{ key: 'price.unit', value: 1, display: 'x', hard: true }] }],
  ];
  for (const [why, spec] of cases) {
    const r = await call('POST', '/tasks', T.operator, spec);
    assert.equal(r.status, 400, why);
  }
  // every registered pack is accepted
  for (const domain of registeredDomains()) assert.equal(validateTaskSpec({ ...good, domain }).domain, domain);
  // in live mode, tasks must use this agent's own inbox
  assert.throws(() => validateTaskSpec(good, 'procurement@other.primitive.email'), (e: unknown) => e instanceof HttpError && /self_address must be/.test(e.message));
  // unknown fields are dropped; addresses are normalized
  const v = validateTaskSpec({ ...good, participants: good.participants.map((p) => ({ ...p, address: p.address.toUpperCase() })), self_address: good.self_address.toUpperCase(), extra: 1 });
  assert.equal('extra' in v, false);
  assert.equal(v.participants[1].address, addr.supplier);
});

test('startup refuses an open API where it would be reachable or would send real mail', async () => {
  const live = new PrimitiveTransport('prim_test_not_a_real_key');
  await assert.rejects(buildApp({ backend: new MemoryBackend(), auth: 'off', host: '0.0.0.0', transport: new LocalSimTransport(), worker: false }), /Refusing to bind 0\.0\.0\.0/);
  await assert.rejects(buildApp({ backend: new MemoryBackend(), auth: 'off', transport: live, worker: false }), /live Primitive mail without authentication/);
  process.env.PRIMITIVE_WEBHOOK_SECRET = 'whsec_rotated_one, local-sim-webhook-secret';
  try {
    await assert.rejects(buildApp({ backend: new MemoryBackend(), auth: 'required', transport: live, worker: false }), /public local-sim secret/);
  } finally {
    delete process.env.PRIMITIVE_WEBHOOK_SECRET;
  }
});

test('live mode without a webhook secret: the webhook route answers 503, never accepts unverified mail', async () => {
  const built = await buildApp({ backend: new MemoryBackend(), port: 0, auth: 'required', transport: new PrimitiveTransport('prim_test_not_a_real_key'), worker: false });
  const port = await listening(built);
  try {
    const delivery = new SimMailbox().inbound(counterparty.strayPromo(addr), 'anything');
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/primitive`, { method: 'POST', headers: delivery.headers, body: delivery.body });
    assert.equal(res.status, 503);
  } finally {
    built.server.close();
  }
});

test('open mode (sim, loopback, auth off) rejects a foreign Host header (DNS rebinding)', async () => {
  const built = await buildApp({ backend: new MemoryBackend(), port: 0, auth: 'off', transport: new LocalSimTransport(), worker: false });
  const port = await listening(built);
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/tasks', headers: { host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 421);
    assert.equal((await fetch(`http://localhost:${port}/tasks`)).status, 200);
  } finally {
    built.server.close();
  }
});

test('webhook: rotated secrets both verify, the event type comes from the signed body, an unnormalizable payload is kept', async () => {
  const backend = new MemoryBackend();
  const app = new Continuity({ backend, extractor: heuristicExtractor, transport: new LocalSimTransport(), webhookSecret: 'whsec_old, whsec_new', ingestOrg: ORG });
  await backend.ensureOrg(ORG);
  await app.createTask(ORG, procurementTask(addr));
  const mailbox = new SimMailbox();
  const mail = (subject: string) => ({ ...counterparty.strayPromo(addr), subject, body: 'Is PO-4817 still open?' });

  for (const secret of ['whsec_old', 'whsec_new']) {
    const d = mailbox.inbound(mail(`PO-4817 via ${secret}`), secret);
    assert.equal((await app.ingestWebhook(d.body, d.headers) as { linked: boolean }).linked, true);
  }
  const forged = mailbox.inbound(mail('PO-4817 forged'), 'whsec_unknown');
  await assert.rejects(app.ingestWebhook(forged.body, forged.headers), (e: unknown) => e instanceof HttpError && e.status === 401);

  // an unsigned header cannot turn a signed email.received into something else (or the reverse)
  const d = mailbox.inbound(mail('PO-4817 header games'), 'whsec_new');
  const r = await app.ingestWebhook(d.body, { ...d.headers, 'x-webhook-event': 'email.bounced' }) as { linked?: boolean; ignored?: boolean };
  assert.equal(r.ignored, undefined);
  assert.equal(r.linked, true);

  // a signed payload the normalizer chokes on is stored minimally, not answered with an error forever
  const payload = JSON.parse(mailbox.inbound(mail('PO-4817 odd payload'), 'x').body);
  payload.email.parsed.attachments = 'not-a-list';
  const raw = JSON.stringify(payload);
  const headers = { 'primitive-signature': signWebhookPayload(raw, 'whsec_new').header, 'content-type': 'application/json' };
  const kept = await app.ingestWebhook(raw, headers) as { event_id: string; duplicate: boolean };
  const stored = await backend.getEvent(ORG, kept.event_id);
  assert.equal(stored?.primitive_email_id, payload.email.id);
  assert.match(String((await backend.getEventRaw(ORG, kept.event_id) as { normalize_error?: string }).normalize_error), /attachments/);
  assert.equal((await app.ingestWebhook(raw, headers) as { duplicate: boolean }).duplicate, true, 'a redelivery maps onto the stored event');
});

test('guard: an API token can never leave in an email body', () => {
  const r = guardSend(procurementTask(addr), addr.supplier, `our key is ${T.agent}`, [], []);
  assert.equal(r.allowed, false);
  assert.match(r.reasons.join(' '), /credential/);
});
