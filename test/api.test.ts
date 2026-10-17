// The HTTP surface: webhook signatures, the send guard over HTTP, and the offline agent policy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/server.ts';
import { counterparty, defaultAddresses, procurementTask } from '../src/sim/scenario.ts';
import { Harness, runCanonicalScenario } from '../src/sim/harness.ts';
import { policyDecide } from '../src/agent/policy.ts';
import { SimMailbox } from '../src/sim/mailbox.ts';
import { MemoryBackend } from '../src/store/memory-backend.ts';
import { LocalSimTransport } from '../src/transport/transport.ts';

// Keep the run offline: no real Primitive delivery and no LLM calls.
delete process.env.PRIMITIVE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const addr = defaultAddresses();
let baseUrl = '';
let stopServer: () => void;
const transport = new LocalSimTransport();
const JSON_HEADERS = { 'content-type': 'application/json' };

before(async () => {
  const { server } = await buildApp({ backend: new MemoryBackend(), port: 0, auth: 'off', transport });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  stopServer = () => server.close();
  await fetch(`${baseUrl}/tasks`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(procurementTask(addr)) });
});

after(() => stopServer());

// Small JSON client: returns the status plus the parsed body.
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: body === undefined ? {} : JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

const postWebhook = (delivery: ReturnType<SimMailbox['inbound']>) =>
  fetch(`${baseUrl}/webhooks/primitive`, { method: 'POST', headers: delivery.headers, body: delivery.body });

test('webhook: bad signature is rejected, valid signature is ingested, redelivery is a no-op', async () => {
  const mailbox = new SimMailbox();

  const forged = mailbox.inbound(counterparty.strayPromo(addr), 'wrong-secret');
  const rejected = await postWebhook(forged);
  assert.equal(rejected.status, 401);

  const signed = mailbox.inbound({ ...counterparty.strayPromo(addr), subject: 'PO-4817 question', body: 'Is PO-4817 still open?' }, 'local-sim-webhook-secret');
  const firstRes = await postWebhook(signed);
  const first = await firstRes.json();
  assert.equal(firstRes.status, 200);
  assert.equal(first.linked, true);

  // the very same delivery again maps onto the already stored event
  const again = await (await postWebhook(signed)).json();
  assert.equal(again.duplicate, true);
  assert.equal(again.event_id, first.event_id);
});

test('routes accept alias or id; context has both json and text forms', async () => {
  const viaAlias = await call('GET', '/tasks/PO-4817/context');
  const viaId = await call('GET', '/tasks/task_po4817/context');
  assert.equal(viaAlias.status, 200);
  assert.equal(viaAlias.body.context.meta.task_id, viaId.body.context.meta.task_id);
  const asText = await (await fetch(`${baseUrl}/tasks/PO-4817/context?format=text`)).text();
  assert.match(asText, /^# Task PO-4817/);
});

test('guard: no mail to non-participants, no binding language while requirements fail', async () => {
  const toStranger = await call('POST', '/tasks/PO-4817/send', { agent_id: 't', to: 'attacker@evil.example', body: 'hello' });
  assert.equal(toStranger.status, 409);
  assert.match(JSON.stringify(toStranger.body.detail), /not a participant/);

  const premature = await call('POST', '/tasks/PO-4817/send', { agent_id: 't', to: addr.supplier, body: 'We accept your offer.' });
  assert.equal(premature.status, 409);
  assert.match(JSON.stringify(premature.body.detail), /binding language blocked/);

  const harmless = await call('POST', '/tasks/PO-4817/send', { agent_id: 't', to: addr.supplier, body: 'Hi Dana, can you quote 500 units?' });
  assert.equal(harmless.status, 200);
  assert.equal(harmless.body.transport.mode, 'local-sim');

  // the blocked attempts are part of the change feed
  const feed = await call('GET', '/tasks/PO-4817/changes?since=0');
  assert.ok(feed.body.changes.some((c: { type: string }) => c.type === 'send_blocked'));
});

test('offline agent policy: from compiled state alone, raises the right conflict and reminds the open commitment', async () => {
  const h = new Harness(procurementTask(addr));
  await runCanonicalScenario(h, addr, counterparty);
  const decision = policyDecide(h.context('fresh-agent'));
  assert.equal(decision.action, 'send');
  assert.equal(decision.messages.length, 1);
  const [email] = decision.messages;
  assert.equal(email.to, addr.supplier);
  assert.match(email.body, /200 units arrive Wed Oct 28/);
  assert.match(email.body, /by Fri Oct 23/);
  assert.match(email.body, /revised quote/);
  // the price question was already answered, so it must not be asked again
  assert.doesNotMatch(email.body, /unit price\?|what is your price/i);
  assert.doesNotMatch(email.body, /we accept/i);
});

test('offline agent policy: waits when only others owe us something', async () => {
  const h = new Harness(procurementTask(addr));
  const rfq = await h.out(addr.supplier, 'RFQ — PO-4817', 'Hi Dana, can you deliver all 500 units by Friday, Oct 23, and what is your unit price?', '2026-10-19T09:00:00Z');
  await h.out(addr.finance, 'Budget — PO-4817', 'Could you approve a budget of up to $11.50 per unit?', '2026-10-19T09:01:00Z');
  await h.in(counterparty.supplierOffer(addr, { messageId: rfq.messageId, subject: rfq.subject }));
  const decision = policyDecide(h.context());
  assert.equal(decision.action, 'wait');
  assert.match(decision.rationale, /finance/);
});

test('live receiver path: the server fetches the EmailDetail by id, normalizes and links it', async () => {
  const emailDetail = {
    id: 'em_test_detail_1',
    message_id: '<abc@northwind>',
    sender: addr.supplier,
    recipient: addr.self,
    subject: 'PO-4817 update',
    body_text: 'Unit price for PO-4817 is $11.40 per unit.',
    from_header: `Dana Ruiz <${addr.supplier}>`,
    from_email: addr.supplier,
    to_email: addr.self,
    received_at: '2026-10-20T09:00:00Z',
    created_at: '2026-10-20T09:00:00Z',
    thread_id: 'thr_live_1',
    reply_to_sent_email_id: null,
    parsed: { in_reply_to: [], references: [], attachments: [], cc: [] },
    auth: { dmarc: 'pass' },
  };
  // the receiver only names the id; the server fetches the email from Primitive (here the sim's stand-in)
  transport.details.set(emailDetail.id, emailDetail);
  const ingested = await call('POST', '/ingest/primitive-email', { id: emailDetail.id });
  assert.equal(ingested.status, 200);
  assert.equal(ingested.body.linked, true);
  const stored = await call('GET', `/events/${ingested.body.event_id}`);
  assert.equal(stored.body.item.from, addr.supplier);
  assert.equal(stored.body.item.thread_id, 'thr_live_1');
});

test('context as_of replays the event log to an earlier point', async () => {
  const current = await call('GET', '/tasks/PO-4817/context');
  assert.ok(current.body.context.meta.events_total >= 1);
  const firstEventId = (await call('GET', '/tasks/PO-4817/timeline')).body.events[0].id;
  const past = await call('GET', `/tasks/PO-4817/context?as_of=${firstEventId}`);
  assert.equal(past.status, 200);
  assert.equal(past.body.context.meta.events_total, 1);
});

test('the fresh agent follows the data, not a script: a different correction yields a different email', async () => {
  const h = new Harness(procurementTask(addr));
  const rfq = await h.out(addr.supplier, 'RFQ — PO-4817', 'Can you deliver all 500 units by Friday, Oct 23, and at what unit price? Please send a formal quote.', '2026-10-19T09:00:00Z');
  const budgetAsk = await h.out(addr.finance, 'Budget — PO-4817', 'Could you approve a budget of up to $11.50 per unit?', '2026-10-19T09:01:00Z');
  const offer = await h.in(counterparty.supplierOffer(addr, { messageId: rfq.messageId, subject: rfq.subject }));
  await h.in(counterparty.financeApproval(addr, { messageId: budgetAsk.messageId, subject: budgetAsk.subject }));
  // a correction with different numbers than the canonical story, and no promised revision
  await h.in({
    from: addr.supplier, fromName: 'Dana', to: addr.self, subject: `Re: ${rfq.subject}`, at: '2026-10-20T10:12:00Z', threadKey: 's', inReplyTo: offer.messageId,
    body: 'Update: we can only ship 350 units for Friday. The remaining 150 units will arrive Monday, Nov 2.',
  });
  const email = policyDecide(h.context('another-fresh-agent')).messages[0];
  assert.match(email.body, /150 units arrive Mon Nov 2/);
  assert.doesNotMatch(email.body, /Oct 28|200 units/);
  assert.doesNotMatch(email.body, /revised quote/);
});
