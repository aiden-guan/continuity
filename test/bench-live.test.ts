// The live-Primitive mode of the benchmark, against the in-memory fake (nothing is sent): delivery order,
// resume without double sends, the own-domain guard, delivery verification, the read tools' scoping and
// mapping, Continuity's ingestion from Primitive rows, and secret redaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadVerticals, enumerate } from '../bench/verticals/index.ts';
import { materialize, resolveSourceId } from '../bench/core/mailbox.ts';
import { FakeLiveClient } from '../bench/live/fake.ts';
import { SendBudget, cursorAt, redact, sentWithMessageId } from '../bench/live/client.ts';
import { aliasesFor, assertOwnDomain, caseMapper, deliverCase, liveSupport, type CaseDelivery } from '../bench/live/deliver.ts';
import { liveEventInputs, liveMailbox, liveTool, liveTriggerDetail } from '../bench/live/view.ts';
import { parseSenderAuth } from '../src/ingest/sender-auth.ts';
import type { BenchCase } from '../bench/core/types.ts';

const [mod] = await loadVerticals(['procurement']);
const golden = enumerate([mod], { splits: ['golden'] }).map((x) => x.case);
const byArch = (a: string) => golden.find((c) => c.archetype === a)!;
const withAttachment = golden.find((c) => !liveSupport(c) && c.events.some((e) => e.direction === 'inbound' && e.attachments?.length && e.replyTo))!;
const SINCE = new Date(Date.now() - 60_000).toISOString();

async function deliver(c: BenchCase, client = new FakeLiveClient(), prior?: CaseDelivery) {
  const d = await deliverCase(client, c, prior, { runTag: 't0001', domain: client.domain, since: SINCE });
  return { client, d };
}

test('every case address maps to a distinct address on our own domain, and maps back', () => {
  const c = byArch('cold_handoff');
  const aliases = aliasesFor(c, 't0001', 'acme.primitive.email');
  const live = Object.values(aliases);
  assert.ok(live.every((a) => a.endsWith('@acme.primitive.email')));
  assert.equal(new Set(live).size, live.length, 'two case addresses share a live address');
  const back = caseMapper(aliases);
  for (const [caseAddr, alias] of Object.entries(aliases)) assert.equal(back(`From: Dana <${alias.toUpperCase()}>`), `From: Dana <${caseAddr}>`);
  // look-alike domains stay apart
  const twins = aliasesFor({ ...c, events: [], task: { ...c.task, parties: [{ ...c.task.parties[0], address: 'dana@northwind.example' }, { ...c.task.parties[0], address: 'dana@northwind.example.co' }] } }, 't', 'd.email');
  assert.notEqual(twins['dana@northwind.example'], twins['dana@northwind.example.co']);
});

test('nothing is ever sent outside our own domain', async () => {
  assert.throws(() => assertOwnDomain('dana@northwind.example', 'acme.primitive.email'), /refusing/);
  assert.doesNotThrow(() => assertOwnDomain('x@ACME.primitive.email', 'acme.primitive.email'));
  await assert.rejects(new FakeLiveClient('acme.primitive.email').send({ from: 'A <a@acme.primitive.email>', to: 'b@elsewhere.example', subject: 's', bodyText: 'b' }, 'k'), /not on/);
});

test('cases with spoofed senders stay replay-only', async () => {
  const spoof = golden.find((c) => c.events.some((e) => e.auth === 'fail'))!;
  assert.match(liveSupport(spoof)!, /spoofed sender/);
  const { client, d } = await deliver(spoof);
  assert.equal(d.status, 'unsupported');
  assert.equal(client.sends, 0);
});

test('a case is delivered in order, threaded, verified, and never sent twice on resume', async () => {
  const c = byArch('cold_handoff');
  const mb = materialize(c);
  const { client, d } = await deliver(c);
  assert.equal(d.status, 'delivered', JSON.stringify(d.verification ?? d.reason));
  assert.equal(client.sends, mb.messages.length);
  assert.deepEqual(d.messages.map((x) => x.m), mb.messages.map((m) => m.id), 'sent out of order');
  for (const m of mb.messages.filter((x) => x.event.replyTo)) {
    const row = d.messages.find((x) => x.m === m.id)!;
    const parent = d.messages.find((x) => x.key === m.event.replyTo)!;
    assert.equal(row.references.at(-1), parent.message_id, `${m.id} not threaded under its parent`);
  }
  assert.ok(d.messages.filter((x) => x.direction === 'inbound').every((x) => x.inbound_id && x.latency_ms != null));

  // a finished case is not touched again
  const again = await deliver(c, client, d);
  assert.equal(client.sends, mb.messages.length);
  assert.equal(again.d, d);

  // a run that crashed after two messages resumes; Primitive's idempotency key covers a send whose result was lost
  const partial: CaseDelivery = { ...structuredClone(d), status: 'error', messages: d.messages.slice(0, 2), verification: undefined };
  const resumed = await deliver(c, client, partial);
  assert.equal(resumed.d.status, 'delivered');
  assert.equal(client.sends, mb.messages.length, 'resume sent a message twice');
});

test('verification catches what got lost in transit', async () => {
  const c = withAttachment;
  const lossy = new FakeLiveClient();
  lossy.faults.dropAttachments = true;
  const dropped = await deliver(c, lossy);
  assert.equal(dropped.d.status, 'fault');
  assert.ok(dropped.d.verification!.faults.some((f) => /attachment .* missing/.test(f)));

  const truncating = new FakeLiveClient();
  truncating.faults.truncateBodies = true;
  const cut = await deliver(byArch('cold_handoff'), truncating);
  assert.equal(cut.d.status, 'fault');
  assert.ok(cut.d.verification!.faults.some((f) => /author's text/.test(f)));

  const losing = new FakeLiveClient();
  losing.faults.loseInbound = true;
  const lost = await deliver(byArch('cold_handoff'), losing);
  assert.equal(lost.d.status, 'error');
  assert.match(lost.d.reason!, /did not arrive/);
});

test('the read tools see only the case, in its own addresses and clock, with Primitive ids', async () => {
  const client = new FakeLiveClient();
  const c = withAttachment;
  const { d } = await deliver(c, client);
  await deliver(byArch('cold_handoff'), client); // another case in the same inbox
  const mb = liveMailbox(c, d, client, SINCE);
  const caseAddrs = new Set([c.task.self_address, ...c.events.flatMap((e) => [e.from, ...e.to, ...(e.cc ?? [])])].map((a) => a.toLowerCase()));

  const inbox = await liveTool(mb, 'list_inbox', {}) as { data: Record<string, any>[] };
  const inboundM = mb.messages.filter((m) => m.event.direction === 'inbound');
  assert.equal(inbox.data.length, inboundM.length, 'list_inbox leaked another case or missed one');
  for (const row of inbox.data) {
    assert.ok(caseAddrs.has(String(row.to).toLowerCase()), `live address leaked: ${row.to}`);
    assert.ok(!JSON.stringify(row).includes(client.domain), 'live domain leaked into a tool result');
    const m = mb.byId.get(mb.live!.idToM.get(row.id)!)!;
    assert.equal(row.received_at, m.event.at, 'timestamp not on the case clock');
    assert.equal(resolveSourceId(mb, row.id), m.key, 'a Primitive id does not resolve to its oracle key');
  }

  const att = inboundM.find((m) => m.attachments.length)!;
  const row = d.messages.find((x) => x.m === att.id)!;
  const got = await liveTool(mb, 'get_attachment', { email_id: row.inbound_id, filename: att.attachments[0].filename }) as { text: string };
  assert.ok(att.attachments[0].lines.filter((l) => l.trim()).every((l) => got.text.includes(l.trim())), 'attachment text did not survive the round trip');

  const other = await liveMailboxOf(client, byArch('cold_handoff'));
  const foreign = other.live!.delivery.messages.find((x) => x.inbound_id)!.inbound_id!;
  assert.deepEqual(await liveTool(mb, 'get_email', { id: foreign }), { error: 'not_found' }, 'read another case\'s email');
  assert.deepEqual(await liveTool(mb, 'get_attachment', { email_id: foreign, filename: 'x.pdf' }), { error: 'not_found' });
  const conv = await liveTool(mb, 'get_conversation', { email_id: row.inbound_id }) as { messages: { id: string }[] };
  assert.ok(conv.messages.every((x) => mb.live!.idToM.has(x.id)), 'conversation leaked a row outside the case');
  const trig = await liveTriggerDetail(mb);
  assert.equal(trig.subject, mb.trigger.event.subject);
  // Message-IDs carry the sender's case domain, not ours, and still chain (In-Reply-To → the parent's id)
  for (const m of inboundM) {
    const r = d.messages.find((x) => x.m === m.id)!;
    const got = await liveTool(mb, 'get_email', { id: r.inbound_id }) as Record<string, any>;
    assert.ok(!JSON.stringify(got).includes(client.domain), `${m.id}: our domain leaked: ${JSON.stringify(got).match(/[^"]*bench-fake[^"]*/)?.[0]}`);
    assert.ok(String(got.message_id).endsWith(`@${m.event.from.split('@')[1]}>`));
    const p = m.event.replyTo ? d.messages.find((x) => x.key === m.event.replyTo)! : null;
    if (p) {
      const parent = await liveTool(mb, 'get_email', { id: p.inbound_id ?? p.sent_id }) as Record<string, any>;
      assert.deepEqual(got.in_reply_to, [parent.message_id]);
    }
  }
});

async function liveMailboxOf(client: FakeLiveClient, c: BenchCase) {
  const { d } = await deliver(c, client);
  return liveMailbox(c, d, client, SINCE);
}

test('Continuity ingests Primitive rows the production way: auth judged on the real sender, case addresses and clock', async () => {
  const client = new FakeLiveClient();
  const mb = await liveMailboxOf(client, withAttachment);
  const inputs = await liveEventInputs(mb, mb.case.task.id);
  assert.equal(inputs.length, mb.messages.length);
  for (const { m, input } of inputs) {
    const msg = mb.byId.get(m)!;
    assert.equal(input.from, msg.event.from.toLowerCase());
    assert.equal(input.occurred_at, msg.event.at);
    if (msg.event.direction === 'inbound') {
      assert.equal(parseSenderAuth(input.auth_verdict)?.status, 'pass', `${m}: real sender did not authenticate`);
      assert.ok(input.thread_id && input.message_id);
      assert.equal(input.attachments.length, msg.attachments.length);
      assert.ok(input.attachments.every((a) => a.content_base64), `${m}: attachment bytes not downloaded`);
    }
  }
});

test('secrets and signed links never reach logs', () => {
  const s = redact('failed: key prim_live_abc123XYZ987 header Bearer eyJhbGciOi.x.y url https://x/raw?id=1&sig=deadbeef&expires=999');
  assert.ok(!/abc123|eyJhbGci|deadbeef|999/.test(s), s);
});

test('sends are paced under the hourly limit and stop at the cap', async () => {
  let now = 0;
  const waits: number[] = [];
  const budget = new SendBudget(3600, 3, () => now, async (ms) => { waits.push(ms); now += ms; });
  for (let i = 0; i < 3; i++) await budget.take();
  assert.deepEqual(waits, [1000, 1000]);
  await assert.rejects(budget.take(), /send cap reached/);
  assert.equal(cursorAt('2026-10-17T20:00:00.123Z'), '2026-10-17T20:00:00.123000Z|00000000-0000-0000-0000-000000000000');
});

test('a send waits for Primitive to give the sent row its Message-ID (seen live: it lags the send by ~300 ms)', async () => {
  const rows = [{ id: 's1', message_id: null }, { id: 's1', message_id: null }, { id: 's1', message_id: '<x@d>' }];
  const waits: number[] = [];
  const got = await sentWithMessageId(async () => rows.shift() ?? null, async (ms) => { waits.push(ms); });
  assert.equal(got?.message_id, '<x@d>');
  assert.deepEqual(waits, [250, 500]);
  const never = await sentWithMessageId(async () => ({ id: 's2', message_id: null }), async () => {});
  assert.equal(never?.message_id, null, 'gives up after the backoff and lets the caller report it');
});
