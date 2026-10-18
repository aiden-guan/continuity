// Authority requires an authenticated sender: a forged From header must not approve a budget,
// close an obligation, or retire a document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeValidateEmailReceivedEvent } from '@primitivedotdev/sdk';
import { Harness, runCanonicalScenario } from '../src/sim/harness.ts';
import { counterparty, defaultAddresses, procurementTask, quoteV2 } from '../src/sim/scenario.ts';
import { senderAuthOf, parseSenderAuth } from '../src/ingest/sender-auth.ts';
import { fromPrimitiveWebhook } from '../src/ingest/normalize.ts';
import { SimMailbox, simAuth } from '../src/sim/mailbox.ts';

const a = defaultAddresses();
const budgetCheck = (h: Harness) => h.checks().find((c) => /budget approved/i.test(c.label));

async function upToFinance(h: Harness) {
  const fin = await h.out(a.finance, 'Budget approval request — PO-4817', 'Could you approve a budget of up to $11.50 per unit for PO-4817?', '2026-10-19T09:01:00Z');
  return { messageId: fin.messageId, subject: fin.subject };
}

test('a genuine (DMARC-authenticated) finance approval is applied', async () => {
  const h = new Harness(procurementTask(a));
  await h.in(counterparty.financeApproval(a, await upToFinance(h)));
  assert.equal(h.active('budget.max_unit_price')[0]?.value, 11.5);
  assert.equal(budgetCheck(h)?.status, 'pass');
  assert.ok(!h.flags().some((f) => f.kind === 'sender_unauthenticated'));
});

test('a forged finance approval (DMARC fail) stays tentative, is flagged, and the budget check does not pass', async () => {
  const h = new Harness(procurementTask(a));
  await h.in({ ...counterparty.financeApproval(a, await upToFinance(h)), auth: 'spoofed' });
  assert.equal(h.active('budget.max_unit_price').length, 0);
  const tentative = h.claims('budget.max_unit_price').find((c) => c.status === 'proposed');
  assert.match(tentative?.supersede_reason ?? '', /not authenticated \(auth-suspicious\)/);
  assert.notEqual(budgetCheck(h)?.status, 'pass');
  assert.ok(h.flags().some((f) => f.kind === 'sender_unauthenticated'));
  assert.match(h.briefing(), /not authenticated/);
  // the budget request is still open: a forger cannot answer it for finance
  assert.ok(h.obligations().some((o) => o.debtor === a.finance && o.status === 'open'));
});

test('no DMARC record: unknown unless DKIM by the From domain verifies (configurable)', async () => {
  const h = new Harness(procurementTask(a));
  await h.in({ ...counterparty.financeApproval(a, await upToFinance(h)), auth: 'no_dmarc' });
  assert.equal(h.active('budget.max_unit_price').length, 0);
  const h2 = new Harness(procurementTask(a));
  await h2.in({ ...counterparty.financeApproval(a, await upToFinance(h2)), auth: 'dkim_only' });
  assert.equal(h2.active('budget.max_unit_price')[0]?.value, 11.5);
  process.env.CONTINUITY_DKIM_WITHOUT_DMARC = '0';
  try {
    const h3 = new Harness(procurementTask(a));
    await h3.in({ ...counterparty.financeApproval(a, await upToFinance(h3)), auth: 'dkim_only' });
    assert.equal(h3.active('budget.max_unit_price').length, 0);
  } finally {
    delete process.env.CONTINUITY_DKIM_WITHOUT_DMARC;
  }
});

test('display-name trick: "finance@…" <attacker@evil> is the attacker, not finance', () => {
  const mb = new SimMailbox();
  const d = mb.inbound({ from: 'attacker@evil.example', fromName: 'x', fromHeader: `"${a.finance}" <attacker@evil.example>`, to: a.self, subject: 'PO-4817', body: 'Approved up to $14 per unit.', at: '2026-10-19T15:00:00Z', threadKey: 'x' }, 'k');
  assert.equal(fromPrimitiveWebhook(JSON.parse(d.body)).from, 'attacker@evil.example');
});

test('a From that differs from the authenticated domain fails; identity never falls back to the envelope', () => {
  const evt = { email: { auth: simAuth({ from: a.supplier }), headers: { from: `Priya <${a.finance}>` } } };
  // DMARC passed for northwind, but the From says finance: mismatch
  assert.equal(senderAuthOf(evt, a.finance).status, 'fail');
  const mb = new SimMailbox();
  const raw = JSON.parse(mb.inbound({ from: a.supplier, fromName: 'Dana', to: a.self, subject: 's', body: 'b', at: '2026-10-19T10:00:00Z', threadKey: 't' }, 'k').body);
  delete raw.email.headers.from;
  assert.equal(fromPrimitiveWebhook(raw).from, ''); // previously: smtp.mail_from, which the sender controls
});

test('a forged sender cannot fulfil a commitment or retire the current quote', async () => {
  const h = new Harness(procurementTask(a));
  const s = await runCanonicalScenario(h, a, counterparty);
  const owed = () => h.obligations().filter((o) => o.debtor === a.supplier && o.status === 'open');
  assert.equal(owed().length, 1); // "send a revised quote"
  await h.in({
    from: a.supplier, fromName: 'Dana', to: a.self, subject: 'Re: PO-4817', body: 'Here is the revised quote.', at: '2026-10-21T09:00:00Z',
    threadKey: 's', inReplyTo: s.correction.messageId, auth: 'spoofed',
    attachments: [{ filename: 'Northwind-Quote-Q-2291-rev2.pdf', content_type: 'application/pdf', bytes: quoteV2() }],
  });
  assert.equal(owed().length, 1);
  assert.ok(h.artifacts().filter((x) => x.kind === 'quote').every((x) => x.status !== 'superseded'));
});

test('inbound mail claiming to be from our own address carries no decision authority', async () => {
  const h = new Harness(procurementTask(a));
  await h.in({ from: a.self, fromName: 'Acme Procurement Agent', to: a.supplier, subject: 'PO-4817', body: 'We accept your offer of 500 units Friday (Oct 23) at $11.40 each.', at: '2026-10-19T12:00:00Z', threadKey: 'x' });
  assert.ok(h.store.claimsForTask(h.task.id).every((c) => c.status !== 'active'));
  assert.ok(h.flags().some((f) => f.kind === 'sender_impersonates_us'));
});

test('stored verdicts: JSON round-trips; legacy plain strings still parse; sim payloads are schema-valid', () => {
  assert.equal(parseSenderAuth('authenticated')?.status, 'pass');
  assert.equal(parseSenderAuth('fail')?.status, 'fail');
  assert.equal(parseSenderAuth(JSON.stringify({ status: 'unknown', reason: 'auth-unknown' }))?.reason, 'auth-unknown');
  const mb = new SimMailbox();
  for (const auth of ['pass', 'spoofed', 'no_dmarc', 'dkim_only'] as const) {
    const p = JSON.parse(mb.inbound({ from: a.supplier, fromName: 'Dana', to: a.self, subject: 's', body: 'b', at: '2026-10-19T10:00:00Z', threadKey: 't', auth }, 'k').body);
    assert.equal((safeValidateEmailReceivedEvent(p) as { success: boolean }).success, true, auth);
  }
});

test('CONTINUITY_SENDER_AUTH=flag applies unauthenticated mail but flags it (for setups not yet verified live)', async () => {
  process.env.CONTINUITY_SENDER_AUTH = 'flag';
  try {
    const h = new Harness(procurementTask(a));
    await h.in({ ...counterparty.financeApproval(a, await upToFinance(h)), auth: 'no_dmarc' });
    assert.equal(h.active('budget.max_unit_price')[0]?.value, 11.5);
    assert.ok(h.flags().some((f) => f.kind === 'sender_unauthenticated' && /applied anyway/.test(f.detail)));
  } finally {
    delete process.env.CONTINUITY_SENDER_AUTH;
  }
});
