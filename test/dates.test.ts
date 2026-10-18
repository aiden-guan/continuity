// Date headers are sender-controlled: parsing never throws, receipt time is the record time, and
// a claimed earlier date only demotes a claim when the message is a forward.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseMailDate, resolveEventTimes } from '../src/ingest/maildate.ts';
import { Harness, runCanonicalScenario } from '../src/sim/harness.ts';
import { counterparty, defaultAddresses, procurementTask } from '../src/sim/scenario.ts';
import { fromPrimitiveWebhook } from '../src/ingest/normalize.ts';
import { SimMailbox } from '../src/sim/mailbox.ts';
import { SqliteBackend } from '../src/store/sqlite.ts';
import { backendCases, closeAll, uniqueOrg } from './backends.ts';

const a = defaultAddresses();
const NEW_SCHEDULE = [{ qty: 300, date: '2026-10-23' }, { qty: 200, date: '2026-10-28' }];

after(closeAll);

test('parseMailDate: RFC 5322 forms, never throws, never uses the host time zone', () => {
  const ok = (raw: string, iso: string) => assert.equal(parseMailDate(raw).iso, iso, raw);
  ok('Mon, 19 Oct 2026 11:20:00 GMT', '2026-10-19T11:20:00.000Z');
  ok('Mon, 19 Oct 2026 07:20:00 -0400', '2026-10-19T11:20:00.000Z');
  ok('19 Oct 2026 13:20 +0200', '2026-10-19T11:20:00.000Z');
  ok('Mon, 19 Oct 2026 04:20:00 PDT (Pacific Daylight Time)', '2026-10-19T11:20:00.000Z');
  ok('2026-10-19T11:20:00Z', '2026-10-19T11:20:00.000Z');
  // zone-less: read as UTC and flagged, whatever TZ the server runs in
  const noZone = parseMailDate('Mon, 19 Oct 2026 11:20:00');
  assert.equal(noZone.iso, '2026-10-19T11:20:00.000Z');
  assert.ok(noZone.issues.includes('zone_unknown'));
  assert.ok(parseMailDate('Mon, 19 Oct 2026 11:20:00 A').issues.includes('zone_unknown')); // military zone
  // obsolete years (RFC 5322 §4.3)
  assert.equal(parseMailDate('19 Oct 126 11:20:00 +0000').iso, '2026-10-19T11:20:00.000Z');
  assert.equal(parseMailDate('19 Oct 26 11:20:00 +0000').iso, '2026-10-19T11:20:00.000Z');
  assert.ok(parseMailDate('Fri, 19 Oct 2026 11:20:00 +0000').issues.includes('weekday_mismatch'));
  for (const bad of ['garbage', 'Mon, 19 Oct 2026 11:20:00 +2500', '31 Feb 2026 10:00:00 +0000', 'Mon, 19 Foo 2026 11:20:00 GMT', '', '   ']) {
    assert.equal(parseMailDate(bad).iso, null, bad);
  }
});

test('resolveEventTimes: bad header falls back to received_at; a future header is clamped', () => {
  const bad = resolveEventTimes('not a date', '2026-10-20T10:00:00Z');
  assert.equal(bad.occurred_at, '2026-10-20T10:00:00.000Z');
  assert.deepEqual(bad.time_flags.map((f) => f.kind), ['date_header_invalid']);
  const future = resolveEventTimes('Fri, 01 Jan 2027 00:00:00 +0000', '2026-10-20T10:00:00Z');
  assert.equal(future.occurred_at, '2026-10-20T10:00:00.000Z');
  assert.deepEqual(future.time_flags.map((f) => f.kind), ['date_header_future']);
  const slightlyAhead = resolveEventTimes('Tue, 20 Oct 2026 10:05:00 +0000', '2026-10-20T10:00:00Z');
  assert.equal(slightlyAhead.occurred_at, '2026-10-20T10:05:00.000Z'); // within the skew allowance
  assert.equal(resolveEventTimes(undefined, 'nonsense').time_flags[0].kind, 'received_at_missing');
});

// time flags are stored with the event at receipt and written as task flags when it is interpreted,
// so they have to survive every backend's evidence row
const matrix = [
  ...backendCases(),
  { name: 'sqlite', make: async () => new SqliteBackend(':memory:') },
];
for (const bc of matrix) {
  test(`[${bc.name}] a malformed Date header no longer loses the email: it is stored, interpreted and flagged once`, async () => {
    const backend = await bc.make();
    const h = new Harness(procurementTask(a), undefined, undefined, { backend, org: uniqueOrg('dates') });
    const d = await h.in({ from: a.supplier, fromName: 'Dana', to: a.self, subject: 'PO-4817 offer', body: 'We can deliver 500 units Friday (Oct 23) at $11.40 each.', at: '2026-10-19T11:00:00Z', threadKey: 's', dateHeader: 'Mon, 32 Foo 2026 99:99' });
    assert.equal(d.linked, true);
    assert.equal(d.event.occurred_at, '2026-10-19T11:00:00.000Z');
    assert.deepEqual(d.event.time_flags?.map((f) => f.kind), ['date_header_invalid']);
    assert.equal(h.active('price.unit')[0].value, 11.4);
    assert.equal(h.flags().filter((f) => f.kind === 'date_header_invalid' && f.event_id === d.event.id).length, 1);
    // an ordinary email carries no time flags
    const ok = await h.in({ from: a.supplier, fromName: 'Dana', to: a.self, subject: 'Re: PO-4817 offer', body: 'Thanks.', at: '2026-10-19T12:00:00Z', threadKey: 's' });
    assert.equal(ok.event.time_flags, undefined);
  });
}

test('normalize never throws on a bad Date header (the old code raised RangeError → webhook 500 → retried forever)', () => {
  const mb = new SimMailbox();
  const d = mb.inbound({ from: a.supplier, fromName: 'Dana', to: a.self, subject: 'x', body: 'y', at: '2026-10-19T11:00:00Z', threadKey: 's', dateHeader: 'garbage' }, 'k');
  const e = fromPrimitiveWebhook(JSON.parse(d.body));
  assert.equal(e.occurred_at, '2026-10-19T11:00:00.000Z');
});

test('a back-dated correction that is not a forward still supersedes (arrival order wins) and is flagged', async () => {
  const h = new Harness(procurementTask(a));
  await runCanonicalScenario(h, a, counterparty);
  assert.deepEqual(h.active('delivery.schedule')[0].value, NEW_SCHEDULE);
  // the supplier's laptop clock is a day behind: the Date header predates the correction it follows
  await h.in({ from: a.supplier, fromName: 'Dana', to: a.self, subject: 'Re: PO-4817', body: 'Good news: we can deliver all 500 units Friday (Oct 23) after all.', at: '2026-10-19T12:00:00Z', receivedAt: '2026-10-20T15:00:00Z', threadKey: 's' });
  assert.deepEqual(h.active('delivery.schedule')[0].value, [{ qty: 500, date: '2026-10-23' }]);
  assert.ok(h.flags().some((f) => f.kind === 'date_skew'));
  assert.ok(!h.transitions().some((t) => t.type === 'stale_evidence'));
});

test('a forwarded older offer that arrives late is still recognised as stale evidence (realistic receipt time)', async () => {
  const h = new Harness(procurementTask(a));
  await runCanonicalScenario(h, a, counterparty);
  await h.in({ from: a.supplier, fromName: 'Dana', to: a.self, subject: 'Fwd: PO-4817 original offer', body: 'We can deliver 500 units Friday (Oct 23) at $11.40 each.', at: '2026-10-19T11:30:00Z', receivedAt: '2026-10-20T16:00:00Z', threadKey: 'late' });
  assert.deepEqual(h.active('delivery.schedule')[0].value, NEW_SCHEDULE);
  assert.ok(h.transitions().some((t) => t.type === 'stale_evidence'));
});

test('a forward-dated message cannot pin its claim: the clamp lets the next correction supersede it', async () => {
  const h = new Harness(procurementTask(a));
  // offer whose Date header claims next year
  await h.in({ from: a.supplier, fromName: 'Dana', to: a.self, subject: 'PO-4817 offer', body: 'We can deliver 500 units Friday (Oct 23) at $11.40 each.', at: '2026-10-19T11:00:00Z', dateHeader: 'Fri, 01 Jan 2027 00:00:00 +0000', threadKey: 's' });
  assert.ok(h.flags().some((f) => f.kind === 'date_header_future'));
  await h.in({ from: a.supplier, fromName: 'Dana', to: a.self, subject: 'Re: PO-4817 offer', body: 'Correction: only 300 units can arrive Friday. The other 200 won\'t arrive until Wednesday, Oct 28.', at: '2026-10-20T10:00:00Z', threadKey: 's' });
  assert.deepEqual(h.active('delivery.schedule')[0].value, NEW_SCHEDULE);
});
