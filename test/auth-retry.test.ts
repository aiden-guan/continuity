// A temporary DNS error while authenticating the sender: ask for redelivery a few times, then store
// the email with an "unknown" sender instead of retrying forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signWebhookPayload } from '@primitivedotdev/sdk';
import { Continuity, HttpError } from '../src/service.ts';
import { MemoryBackend } from '../src/store/memory-backend.ts';
import { LocalSimTransport } from '../src/transport/transport.ts';
import { heuristicExtractor } from '../src/extract/heuristic.ts';
import { counterparty, defaultAddresses, procurementTask } from '../src/sim/scenario.ts';
import { SimMailbox, simAuth } from '../src/sim/mailbox.ts';

const a = defaultAddresses();
const SECRET = 'auth-retry-secret';
const ORG = 'org_local';

async function makeApp() {
  const backend = new MemoryBackend();
  await backend.ensureOrg(ORG);
  const app = new Continuity({ backend, extractor: heuristicExtractor, transport: new LocalSimTransport(), webhookSecret: SECRET, ingestOrg: ORG });
  app.authRetries = 3;
  await app.createTask(ORG, procurementTask(a));
  return app;
}

/** One email, delivered as Primitive would: the same email id each time, an attempt number and signature per delivery. */
function deliveries(app: Continuity, subject: string) {
  const mail = { ...counterparty.financeApproval(a, { messageId: '<none@x>', subject }), subject };
  const payload = JSON.parse(new SimMailbox().inbound({ ...mail, auth: 'dns_temperror' }, SECRET).body);
  return async (attempt: number, auth: 'dns_temperror' | 'pass' = 'dns_temperror') => {
    const p = structuredClone(payload);
    p.delivery.attempt = attempt;
    p.email.auth = simAuth({ from: mail.from, auth });
    const raw = JSON.stringify(p);
    try {
      return { status: 200, body: await app.ingestWebhook(raw, { 'primitive-signature': signWebhookPayload(raw, SECRET).header }) as Record<string, any> };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: { error: err.message } as Record<string, any> };
      throw err;
    }
  };
}

const verdictOf = async (app: Continuity, eventId: string) => JSON.parse((await app.backend.getEvent(ORG, eventId))!.auth_verdict!);

test('webhook: 503 (redeliver) while retries remain, then stored as unknown and flagged', async () => {
  const app = await makeApp();
  const send = deliveries(app, 'PO-4817 budget A');
  assert.equal((await send(1)).status, 503);
  assert.equal((await send(2)).status, 503);
  const r3 = await send(3);
  assert.equal(r3.status, 200);
  const verdict = await verdictOf(app, r3.body.event_id);
  assert.equal(verdict.status, 'unknown');
  assert.equal(verdict.reason, 'dmarc-temperror');
  assert.equal(verdict.retryable, false);
  assert.match(verdict.detail.join(' '), /after 3 attempt/);
  assert.equal((await send(4)).body.duplicate, true); // later redeliveries are no-ops
  // the email is kept, but its sender has no authority until verified some other way
  await app.engine.drain({ org: ORG });
  const { snap } = await app.snapshot(ORG, 'task_po4817');
  assert.ok(snap.store.flagsForTask('task_po4817').some((f) => f.kind === 'sender_unauthenticated' && f.event_id === r3.body.event_id));
  assert.equal(snap.store.claimsForTask('task_po4817').filter((c) => c.key === 'budget.max_unit_price' && c.status === 'active').length, 0);
});

test('webhook: DNS recovers on a redelivery → authenticated normally', async () => {
  const app = await makeApp();
  const send = deliveries(app, 'PO-4817 budget B');
  assert.equal((await send(1)).status, 503);
  const r2 = await send(2, 'pass');
  assert.equal(r2.status, 200);
  assert.equal((await verdictOf(app, r2.body.event_id)).status, 'pass');
});

test('webhook: counts attempts itself when redeliveries do not increment the attempt number', async () => {
  const app = await makeApp();
  const send = deliveries(app, 'PO-4817 budget C');
  assert.equal((await send(1)).status, 503);
  assert.equal((await send(1)).status, 503);
  assert.equal((await send(1)).status, 200);
});

test('pull path (ingest by id): re-fetches while the error is temporary, then stores as unknown', async () => {
  const app = await makeApp();
  app.authRetryDelayMs = 0;
  const transport = app.transport as LocalSimTransport;
  const detail = (id: string, auth: 'dns_temperror' | 'pass') => ({
    id, message_id: `<${id}@x>`, from_header: `Priya <${a.finance}>`, from_email: a.finance, to_email: a.self, subject: 'PO-4817 budget D',
    body_text: 'Approved up to $11.50/unit for PO-4817.', received_at: '2026-10-19T15:05:00Z', created_at: '2026-10-19T15:05:00Z', thread_id: null, reply_to_sent_email_id: null,
    parsed: { in_reply_to: [], references: [], attachments: [], cc: [] },
    auth: simAuth({ from: a.finance, auth }),
  });
  let fetches = 0;
  transport.fetchEmailDetail = async (id: string) => { fetches++; return detail(id, fetches < 2 ? 'dns_temperror' : 'pass'); };
  const ok = await app.ingestEmailById(ORG, { id: 'em_retry_x' }) as Record<string, any>;
  assert.equal(fetches, 2);
  assert.equal((await verdictOf(app, ok.event_id)).status, 'pass');

  fetches = 0; // stays temporary for every attempt
  transport.fetchEmailDetail = async (id: string) => { fetches++; return detail(id, 'dns_temperror'); };
  const unknown = await app.ingestEmailById(ORG, { id: 'em_retry_y' }) as Record<string, any>;
  assert.equal(fetches, app.authRetries);
  const verdict = await verdictOf(app, unknown.event_id);
  assert.equal(verdict.status, 'unknown');
  assert.equal(verdict.retryable, false);
});
