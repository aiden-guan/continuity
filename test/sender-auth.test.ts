// Authority requires an authenticated sender: a forged From header must not approve a budget,
// close an obligation, or retire a document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeValidateEmailReceivedEvent, signWebhookPayload } from '@primitivedotdev/sdk';
import { Harness, runCanonicalScenario } from '../src/sim/harness.ts';
import { counterparty, defaultAddresses, procurementTask, quoteV2, type SimEmail } from '../src/sim/scenario.ts';
import { senderAuthOf, parseSenderAuth } from '../src/ingest/sender-auth.ts';
import { fromPrimitiveWebhook } from '../src/ingest/normalize.ts';
import { SimMailbox, simAuth } from '../src/sim/mailbox.ts';
import { guardSend } from '../src/engine/guard.ts';
import { Continuity, HttpError, validateTaskSpec } from '../src/service.ts';
import { MemoryBackend } from '../src/store/memory-backend.ts';
import { LocalSimTransport } from '../src/transport/transport.ts';
import { heuristicExtractor } from '../src/extract/heuristic.ts';
import type { TaskSpec } from '../src/types.ts';

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

test('CONTINUITY_SENDER_AUTH=flag (the default for parties without a policy) applies unknown verdicts but flags them; a failing one still does not count', async () => {
  process.env.CONTINUITY_SENDER_AUTH = 'flag';
  try {
    const h = new Harness(procurementTask(a));
    await h.in({ ...counterparty.financeApproval(a, await upToFinance(h)), auth: 'no_dmarc' });
    assert.equal(h.active('budget.max_unit_price')[0]?.value, 11.5);
    assert.ok(h.flags().some((f) => f.kind === 'sender_unauthenticated' && /applied anyway \(default CONTINUITY_SENDER_AUTH=flag/.test(f.detail)));
    const forged = new Harness(procurementTask(a));
    await forged.in({ ...counterparty.financeApproval(a, await upToFinance(forged)), auth: 'spoofed' });
    assert.equal(forged.active('budget.max_unit_price').length, 0);
    assert.ok(forged.flags().some((f) => f.kind === 'sender_unauthenticated' && /never relaxed/.test(f.detail)));
  } finally {
    delete process.env.CONTINUITY_SENDER_AUTH;
  }
});

// ---- per-participant policy (Participant.sender_auth) ---------------------------------------------

/** The procurement task with a sender_auth policy on some parties (by label). */
function withPolicy(policies: Record<string, 'enforce' | 'flag'>): TaskSpec {
  const t = procurementTask(a);
  return { ...t, participants: t.participants.map((p) => (policies[p.label] ? { ...p, sender_auth: policies[p.label] } : p)) };
}

test('policy matrix: verdict x policy decides whether finance\'s approval is applied', async () => {
  const cases: { auth: SimEmail['auth']; policy?: 'enforce' | 'flag'; applied: boolean; flag: RegExp | null }[] = [
    { auth: 'pass', policy: 'enforce', applied: true, flag: null },
    { auth: 'pass', policy: 'flag', applied: true, flag: null },
    { auth: 'no_dmarc', applied: false, flag: /default CONTINUITY_SENDER_AUTH=enforce: its statements are recorded as tentative/ },
    { auth: 'no_dmarc', policy: 'enforce', applied: false, flag: /finance's sender_auth=enforce: its statements are recorded as tentative/ },
    { auth: 'no_dmarc', policy: 'flag', applied: true, flag: /applied anyway \(finance's sender_auth=flag; verdict unknown, not failed\)/ },
    { auth: 'spoofed', policy: 'enforce', applied: false, flag: /auth-suspicious, dmarc=fail p=reject\) — finance's sender_auth=enforce/ },
    { auth: 'spoofed', policy: 'flag', applied: false, flag: /a failing verdict is never relaxed \(finance's sender_auth=flag\): its statements are recorded as tentative/ },
  ];
  for (const c of cases) {
    const what = `${c.auth} x ${c.policy ?? 'default'}`;
    const h = new Harness(withPolicy(c.policy ? { finance: c.policy } : {}));
    await h.in({ ...counterparty.financeApproval(a, await upToFinance(h)), auth: c.auth });
    assert.equal(h.active('budget.max_unit_price').length, c.applied ? 1 : 0, what);
    assert.equal(budgetCheck(h)?.status === 'pass', c.applied, what);
    // a forger cannot answer finance's open request; an applied approval does
    assert.equal(h.obligations().some((o) => o.debtor === a.finance && o.status === 'open'), !c.applied, what);
    const flag = h.flags().find((f) => f.kind === 'sender_unauthenticated');
    if (c.flag) assert.match(flag?.detail ?? '(no flag)', c.flag, what);
    else assert.equal(flag, undefined, what);
    if (!c.applied) assert.match(h.claims('budget.max_unit_price')[0]?.supersede_reason ?? '', /sender not authenticated/, what);
  }
});

test('a relaxed party: applied, flagged in the briefing, named in the parties line, and a gray area for the send guard', async () => {
  const h = new Harness({ ...withPolicy({ finance: 'flag' }), approval: { commitments: 'auto_when_clear' } });
  await h.in({ ...counterparty.financeApproval(a, await upToFinance(h)), auth: 'no_dmarc' });
  assert.equal(h.active('budget.max_unit_price')[0]?.value, 11.5);
  const briefing = h.briefing();
  assert.match(briefing, /sender_unauthenticated: .*not authenticated .*applied anyway/);
  assert.match(briefing, /finance <[^>]+> \(unauthenticated mail accepted but flagged\)/);
  assert.doesNotMatch(briefing, /supplier <[^>]+> \(unauthenticated/);
  const ctx = h.context();
  assert.equal(ctx.task.parties.find((p) => p.label === 'finance')?.sender_auth, 'flag');
  assert.equal(ctx.task.parties.find((p) => p.label === 'supplier')?.sender_auth, undefined);
  // with every check passing, the commitment would go out on its own; the flag makes it a human decision
  const passing = h.checks().map((c) => ({ ...c, status: 'pass' as const }));
  const verdict = guardSend(h.task, a.supplier, 'We accept your offer.', passing, h.claims(), 'commit', { flags: h.flags() });
  assert.equal(verdict.outcome, 'hold');
  assert.ok(verdict.gray_areas.includes('an unauthenticated sender wrote on this deal'));
});

test('the sender flag survives the history cap, so a relaxed term never loses its warning', async () => {
  const h = new Harness(withPolicy({ finance: 'flag' }));
  const { event } = await h.in({ ...counterparty.financeApproval(a, await upToFinance(h)), auth: 'no_dmarc' });
  // newer, ordinary flags (the kind the cap keeps only the newest of)
  for (let i = 0; i < 4; i++) h.store.addFlag(h.task.id, event.id, 'attachment_unreadable', `scan-${i}.pdf: no extractable text`, `2026-10-20T0${i}:00:00Z`);
  const ctx = h.context(undefined, { historyLimit: 1 });
  assert.equal(ctx.flags.filter((f) => f.kind === 'attachment_unreadable').length, 1);
  assert.ok(ctx.flags.some((f) => f.kind === 'sender_unauthenticated'));
  assert.match(h.briefing(undefined, { historyLimit: 1 }), /sender_unauthenticated: /);
});

test('the policy is per party: finance relaxed, supplier enforced; a forged supplier still cannot retire the quote', async () => {
  const h = new Harness(withPolicy({ finance: 'flag' }));
  const s = await runCanonicalScenario(h, a, counterparty);
  await h.in({ ...counterparty.supplierCorrection(a, { messageId: s.correction.messageId, subject: 'Re: RFQ: 500 x AX-200 — PO-4817', references: [] }), at: '2026-10-20T12:00:00Z', body: 'Update: all 500 units can arrive Friday (Oct 23) at $11.20 each.', auth: 'no_dmarc' });
  assert.ok(h.claims().some((c) => c.speaker === a.supplier && c.status === 'proposed' && /not authenticated \(auth-unknown\)/.test(c.supersede_reason ?? '')));
  const supplierFlag = h.flags().find((f) => f.kind === 'sender_unauthenticated' && f.detail.startsWith(a.supplier));
  assert.match(supplierFlag?.detail ?? '', /default CONTINUITY_SENDER_AUTH=enforce/);
  // the flag policy never lets a failing verdict retire a document or fulfil a promise
  const h2 = new Harness(withPolicy({ supplier: 'flag' }));
  const s2 = await runCanonicalScenario(h2, a, counterparty);
  const revised = (at: string, inReplyTo: string, auth: SimEmail['auth']): SimEmail => ({
    from: a.supplier, fromName: 'Dana', to: a.self, subject: 'Re: PO-4817', body: 'Here is the revised quote.', at, threadKey: 's', inReplyTo, auth,
    attachments: [{ filename: 'Northwind-Quote-Q-2291-rev2.pdf', content_type: 'application/pdf', bytes: quoteV2() }],
  });
  await h2.in(revised('2026-10-21T09:00:00Z', s2.correction.messageId, 'spoofed'));
  assert.ok(h2.artifacts().filter((x) => x.kind === 'quote').every((x) => x.status !== 'superseded'));
  assert.equal(h2.obligations().filter((o) => o.debtor === a.supplier && o.status === 'open').length, 1);
  // the same email with only an unknown verdict does both, flagged
  const h3 = new Harness(withPolicy({ supplier: 'flag' }));
  const s3 = await runCanonicalScenario(h3, a, counterparty);
  await h3.in(revised('2026-10-21T09:00:00Z', s3.correction.messageId, 'no_dmarc'));
  assert.ok(h3.artifacts().some((x) => x.kind === 'quote' && x.status === 'superseded'));
  assert.equal(h3.obligations().filter((o) => o.debtor === a.supplier && o.status === 'open').length, 0);
  assert.ok(h3.flags().some((f) => f.kind === 'sender_unauthenticated' && /applied anyway \(supplier's sender_auth=flag/.test(f.detail)));
});

test('inbound mail "from us" is never authoritative, whatever the policies say', async () => {
  // validation refuses "flag" on self; a spec that bypasses it (plus a global flag default) still changes nothing
  const t = procurementTask(a);
  const spec: TaskSpec = { ...t, participants: t.participants.map((p) => ({ ...p, sender_auth: 'flag' as const })) };
  process.env.CONTINUITY_SENDER_AUTH = 'flag';
  try {
    for (const auth of ['pass', 'no_dmarc'] as const) {
      const h = new Harness(spec);
      await h.in({ from: a.self, fromName: 'Acme Procurement Agent', to: a.supplier, subject: 'PO-4817', body: 'We accept your offer of 500 units Friday (Oct 23) at $11.40 each.', at: '2026-10-19T12:00:00Z', threadKey: 'x', auth });
      assert.ok(h.store.claimsForTask(h.task.id).every((c) => c.status !== 'active'), auth);
      assert.ok(h.flags().some((f) => f.kind === 'sender_impersonates_us'), auth);
      assert.ok(!h.flags().some((f) => /applied anyway/.test(f.detail)), auth);
    }
  } finally {
    delete process.env.CONTINUITY_SENDER_AUTH;
  }
});

test('validateTaskSpec: sender_auth is kept when valid, omitted when absent, and anything else is refused', () => {
  const base = () => structuredClone(procurementTask(a)) as unknown as Record<string, any>;
  assert.ok(validateTaskSpec(base()).participants.every((p) => !('sender_auth' in p)));
  const t = base();
  t.participants[0].sender_auth = 'enforce'; // harmless on self
  t.participants[1].sender_auth = 'flag';
  t.participants[2].sender_auth = 'enforce';
  assert.deepEqual(validateTaskSpec(t).participants.map((p) => p.sender_auth), ['enforce', 'flag', 'enforce']);
  for (const value of ['off', 'domain', 'FLAG', true, 1, null]) {
    const bad = base();
    bad.participants[1].sender_auth = value;
    assert.throws(() => validateTaskSpec(bad), (e: HttpError) => e.status === 400 && /participants\[1\]\.sender_auth must be enforce \| flag/.test(e.message), String(value));
  }
  const selfFlag = base();
  selfFlag.participants[0].sender_auth = 'flag';
  assert.throws(() => validateTaskSpec(selfFlag), /cannot apply to self/);
});

// ---- the full pipeline: validated task, signed webhook, durable receive, drain, compiled context ----

const SECRET = 'sender-auth-secret';
const ORG = 'org_local';

async function pipeline(policies: Record<string, 'enforce' | 'flag'>) {
  const backend = new MemoryBackend();
  await backend.ensureOrg(ORG);
  const app = new Continuity({ backend, extractor: heuristicExtractor, transport: new LocalSimTransport(), webhookSecret: SECRET, ingestOrg: ORG });
  app.authRetries = 2;
  await app.createTask(ORG, withPolicy(policies)); // through validateTaskSpec, as POST /tasks does
  const mb = new SimMailbox();
  const deliver = async (mail: SimEmail, attempt = 1) => {
    const payload = JSON.parse(mb.inbound(mail, SECRET).body);
    payload.delivery.attempt = attempt;
    const raw = JSON.stringify(payload);
    const r = await app.ingestWebhook(raw, { 'primitive-signature': signWebhookPayload(raw, SECRET).header }) as Record<string, any>;
    await app.engine.drain({ org: ORG });
    return r;
  };
  const state = async () => (await app.snapshot(ORG, 'task_po4817')).snap.store;
  const budget = async () => (await state()).claimsForTask('task_po4817').filter((c) => c.key === 'budget.max_unit_price');
  const verdict = async (eventId: string) => JSON.parse((await app.backend.getEvent(ORG, eventId))!.auth_verdict!);
  return { app, deliver, state, budget, verdict };
}
const approval = (auth: SimEmail['auth']): SimEmail => ({ ...counterparty.financeApproval(a, { messageId: null, subject: 'Budget approval request — PO-4817' }), auth });

test('pipeline: finance with sender_auth=flag — no_dmarc applied and flagged; spoofed tentative; pass applied, unflagged', async () => {
  const p = await pipeline({ finance: 'flag' });
  const r = await p.deliver(approval('no_dmarc'));
  assert.equal((await p.verdict(r.event_id)).status, 'unknown');
  assert.equal((await p.budget()).find((c) => c.status === 'active')?.value, 11.5);
  const ctx = await p.app.context(ORG, 'task_po4817');
  assert.match(ctx.briefing, /sender_unauthenticated: .*applied anyway \(finance's sender_auth=flag/);
  assert.ok(ctx.context.flags.some((f) => f.kind === 'sender_unauthenticated' && f.event === r.event_id));

  const forged = await pipeline({ finance: 'flag' });
  const rf = await forged.deliver(approval('spoofed'));
  assert.equal((await forged.verdict(rf.event_id)).status, 'fail');
  assert.ok((await forged.budget()).every((c) => c.status === 'proposed'));
  assert.ok((await forged.state()).flagsForTask('task_po4817').some((f) => f.kind === 'sender_unauthenticated' && /never relaxed/.test(f.detail)));

  const genuine = await pipeline({ finance: 'flag' });
  await genuine.deliver(approval('pass'));
  assert.equal((await genuine.budget()).find((c) => c.status === 'active')?.value, 11.5);
  assert.ok(!(await genuine.state()).flagsForTask('task_po4817').some((f) => f.kind === 'sender_unauthenticated'));
});

test('pipeline: the default keeps no_dmarc tentative; a DNS error that persists is stored as unknown and relaxed only for a flag party', async () => {
  const strict = await pipeline({});
  await strict.deliver(approval('no_dmarc'));
  assert.ok((await strict.budget()).every((c) => c.status === 'proposed'));

  for (const [policies, applied] of [[{}, false], [{ finance: 'flag' as const }, true]] as const) {
    const p = await pipeline(policies);
    const mail = approval('dns_temperror');
    await assert.rejects(p.deliver(mail, 1), (e: HttpError) => e.status === 503);
    const r = await p.deliver(mail, 2);
    const v = await p.verdict(r.event_id);
    assert.deepEqual([v.status, v.reason, v.retryable], ['unknown', 'dmarc-temperror', false]);
    assert.equal((await p.budget()).some((c) => c.status === 'active'), applied, JSON.stringify(policies));
  }
});
