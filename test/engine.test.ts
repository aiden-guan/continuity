// How the engine maintains communication state across the canonical story and its edge cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Harness, runCanonicalScenario } from '../src/sim/harness.ts';
import { counterparty, defaultAddresses, procurementTask, quoteV1, quoteV2 } from '../src/sim/scenario.ts';
import type { Extractor, Proposal } from '../src/extract/types.ts';
import { heuristicExtractor } from '../src/extract/heuristic.ts';
import { fromPrimitiveWebhook } from '../src/ingest/normalize.ts';
import { resolveTask } from '../src/ingest/link.ts';
import type { EventInput } from '../src/types.ts';

const addr = defaultAddresses();

// The split delivery the supplier corrects to in the canonical story.
const SPLIT_SCHEDULE = [{ qty: 300, date: '2026-10-23' }, { qty: 200, date: '2026-10-28' }];

// A harness that has already played the canonical story.
async function afterCanonical(task = procurementTask(addr), extractor?: Extractor) {
  const h = extractor ? new Harness(task, extractor) : new Harness(task);
  const story = await runCanonicalScenario(h, addr, counterparty);
  return { h, story };
}

const theCommitment = (h: Harness) => h.obligations().find((o) => o.kind === 'commitment')!;

test('canonical scenario: corrections, budget, conflict, commitments, staleness, provenance', async () => {
  const { h, story } = await afterCanonical();

  // Delivery: exactly one live schedule (the correction), and the original points at it.
  const schedule = h.active('delivery.schedule');
  assert.equal(schedule.length, 1);
  assert.deepEqual(schedule[0].value, SPLIT_SCHEDULE);
  const replaced = h.claims('delivery.schedule').filter((c) => c.status === 'superseded');
  assert.ok(replaced.length >= 1 && replaced.every((c) => c.superseded_by === schedule[0].id));
  assert.match(replaced[0].supersede_reason!, /explicit correction/);

  // Price is unchanged; the budget came from finance on another thread and is respected.
  assert.equal(h.active('price.unit')[0].value, 11.4);
  const budget = h.active('budget.max_unit_price')[0];
  assert.equal(budget.value, 11.5);
  assert.equal(h.active('budget.max_unit_price')[0].source_event_id, story.approval.event.id);
  const checkStatus = Object.fromEntries(h.checks().map((c) => [c.id.split(':')[0], c.status]));
  assert.deepEqual(checkStatus, { delivery_deadline: 'fail', quantity: 'pass', price_budget: 'pass', budget_approval: 'pass' });

  // The quote is only partly stale: its delivery term changed, its price did not.
  const [quote] = h.artifacts();
  assert.equal(quote.status, 'partially_stale');
  const ctx = h.context();
  const quoteDoc = ctx.documents[0];
  assert.deepEqual(quoteDoc.stale_terms.map((t) => t.term), ['delivery.schedule']);
  assert.ok(quoteDoc.still_current_terms.some((t) => t.startsWith('price.unit')));

  // The supplier owes us a revised quote; everything we asked has been answered.
  const stillOpen = h.obligations().filter((o) => o.status === 'open');
  assert.deepEqual(stillOpen.map((o) => [o.kind, o.debtor, o.expects_artifact]), [['commitment', addr.supplier, 'quote']]);
  assert.ok(h.obligations().filter((o) => o.kind !== 'commitment').every((o) => o.status === 'answered'));

  // It is our move: push back on the delivery conflict with the supplier.
  assert.equal(ctx.next_actor, 'us');
  const [firstAction] = ctx.suggested_actions;
  assert.equal(firstAction.kind, 'raise_conflict');
  assert.equal(firstAction.to_address, addr.supplier);

  // Provenance and hygiene: terms cite their sources, the injection is flagged, the promo is not linked.
  assert.ok(ctx.current_terms.every((t) => t.stated_in.length > 0));
  assert.ok(h.flags().some((f) => f.kind === 'prompt_injection_suspected'));
  assert.equal(story.stray.linked, false);
  assert.equal(story.approval.event.link_reason?.includes('thread'), true);
});

test('revised quote fulfils the commitment, supersedes the old quote, resolves the conflict', async () => {
  const { h, story } = await afterCanonical();
  const pushBack = await h.out(
    addr.supplier,
    `Re: ${story.rfq.subject}`,
    'Hi Dana, all 500 must arrive by Friday Oct 23. Can you expedite the remaining 200? Also still waiting on the revised quote.',
    '2026-10-20T11:00:00Z',
    { messageId: story.correction.messageId },
  );
  await h.in(counterparty.supplierResolution(addr, { messageId: pushBack.messageId, subject: pushBack.subject, references: pushBack.references }, pushBack.body));

  assert.deepEqual(h.active('delivery.schedule')[0].value, [{ qty: 500, date: '2026-10-23' }]);
  assert.equal(h.active('price.unit')[0].value, 11.48);
  assert.equal(theCommitment(h).status, 'fulfilled');

  const [original, revised] = h.artifacts();
  assert.equal(original.status, 'superseded');
  assert.equal(original.superseded_by, revised.id);
  assert.equal(revised.status, 'current');

  assert.ok(h.checks().every((c) => c.status === 'pass'));
  assert.equal(h.context().suggested_actions[0].kind, 'accept_offer');
});

test('webhook redelivery is idempotent', async () => {
  const h = new Harness(procurementTask(addr));
  const delivery = h.mailbox.inbound(counterparty.strayPromo(addr), 'k');
  const email = fromPrimitiveWebhook(JSON.parse(delivery.body));
  const first = await h.ingest(email);
  const second = await h.ingest(email);
  assert.equal(first.event.id, second.event.id);
  assert.equal(second.duplicate, true);
});

test('explicit task alias links a brand-new thread (cross-thread continuity)', async () => {
  const h = new Harness(procurementTask(addr));
  const result = await h.in({
    from: addr.finance, fromName: 'Priya', to: addr.self, subject: 'Re: budget for PO-4817',
    body: 'Approved up to $11.50 per unit.', at: '2026-10-19T12:00:00Z', threadKey: 'x',
  });
  assert.equal(result.linked, true);
  assert.match(result.event.link_reason!, /PO-4817/);
  assert.equal(h.active('budget.max_unit_price')[0].value, 11.5);
});

test('an alias named with its own prefix beats a bare number on an earlier task (INV-4817 vs PO-4817)', async () => {
  const tasks = [{ id: 'task_inv', alias: 'INV-4817' }, { id: 'task_po', alias: 'PO-4817' }];
  const store = { taskForThread: async () => null, eventByPrimitiveEmailId: async () => null, eventByMessageId: async () => null, tasks: async () => tasks };
  const link = (subject: string, body = '') => resolveTask(store, { subject, body_text: body, references: [] } as unknown as EventInput).then((r) => r?.task_id ?? null);
  assert.equal(await link('Re: PO 4817 delivery'), 'task_po');
  assert.equal(await link('INV4817 attached'), 'task_inv');
  assert.equal(await link('Re: delivery', 'See PO-4817.'), 'task_po');
  // only a bare number after a noun: the first task that fits still wins, as before
  assert.equal(await link('order #4817 update'), 'task_inv');
  assert.equal(await link('Re: delivery'), null);
});

test('a new thread from a known party links to the one task that names them, and only then', async () => {
  const tasks = [
    { id: 'task_a', alias: 'PO-1001', participants: ['buyer@home.example', 'rep@supplier.example'] },
    { id: 'task_b', alias: 'PO-1002', participants: ['rep@supplier.example'] },
  ];
  const store = { taskForThread: async () => null, eventByPrimitiveEmailId: async () => null, eventByMessageId: async () => null, tasks: async () => tasks };
  const link = (from: string, direction = 'inbound') =>
    resolveTask(store, { from, direction, subject: 'Wren Hollow', body_text: 'Take the 805.', references: [] } as unknown as EventInput);
  const buyer = await link('Buyer@Home.example');
  assert.equal(buyer?.task_id, 'task_a');
  assert.match(buyer!.reason, /participant only on this task/);
  assert.equal(await link('rep@supplier.example'), null, 'a sender on two tasks stays unlinked');
  assert.equal(await link('deals@bulk-electronics.example'), null, 'a stranger stays unlinked');
  assert.equal(await link('buyer@home.example', 'outbound'), null, 'only inbound mail is routed by sender');
});

test('newer is not truer: a third party contradicting the supplier is contested, not superseding', async () => {
  const forwarder = 'ops@fastfreight.example';
  const task = procurementTask(addr);
  task.participants.push({ address: forwarder, name: 'FastFreight Ops', role: 'counterparty', label: 'freight forwarder', authority: ['delivery.'], group: 'northwind' });
  const { h } = await afterCanonical(task);
  await h.in({ from: forwarder, fromName: 'FastFreight', to: addr.self, subject: 'PO-4817 shipment', body: 'Our system shows 500 units arriving Thursday, Oct 22.', at: '2026-10-20T12:00:00Z', threadKey: 'ff' });

  const contested = h.claims('delivery.schedule').filter((c) => c.status === 'contested');
  assert.equal(contested.length, 2);
  assert.deepEqual(new Set(contested.map((c) => c.speaker)), new Set([addr.supplier, forwarder]));
  const ctx = h.context();
  assert.ok(ctx.conflicts.some((c) => c.type === 'contradictory_claims'));
  assert.equal(ctx.next_actor, 'us');
});

test('late-arriving older evidence does not overwrite the current term', async () => {
  const { h } = await afterCanonical();
  // This message is dated before the correction but only shows up now.
  await h.in({ from: addr.supplier, fromName: 'Dana', to: addr.self, subject: 'Fwd: PO-4817 original offer', body: 'We can deliver 500 units Friday (Oct 23) at $11.40 each.', at: '2026-10-19T11:30:00Z', threadKey: 'late' });
  assert.deepEqual(h.active('delivery.schedule')[0].value, SPLIT_SCHEDULE);
  assert.ok(h.store.transitionsForTask(h.task.id).some((t) => t.type === 'stale_evidence'));
});

test('hedged statements and non-authoritative speakers do not change state', async () => {
  const { h } = await afterCanonical();
  await h.in({ from: addr.supplier, fromName: 'Dana', to: addr.self, subject: 'Re: PO-4817', body: 'We might be able to deliver all 500 units by Friday, Oct 23.', at: '2026-10-20T13:00:00Z', threadKey: 's' });
  await h.in({ from: addr.finance, fromName: 'Priya', to: addr.self, subject: 'PO-4817', body: 'FYI the supplier can deliver 500 units Thursday, Oct 22.', at: '2026-10-20T13:10:00Z', threadKey: 'f' });

  assert.deepEqual(h.active('delivery.schedule')[0].value, SPLIT_SCHEDULE);
  const proposed = h.claims('delivery.schedule').filter((c) => c.status === 'proposed');
  assert.equal(proposed.length, 2);
  const hasReason = (re: RegExp) => proposed.some((c) => re.test(c.supersede_reason!));
  assert.ok(hasReason(/hedged/) && hasReason(/not authoritative/));
});

test('a promise to send a document is not fulfilled by words alone', async () => {
  // A stand-in for an over-eager LLM: it declares the commitment fulfilled whenever the mail says
  // "here is", whether or not anything is attached.
  const overEager: Extractor = {
    name: 'fake-llm',
    async extract(inp) {
      const proposal: Proposal = await heuristicExtractor.extract(inp);
      const pending = inp.openObligations.find((o) => o.kind === 'commitment');
      if (pending && /here is/i.test(inp.event.body_text)) {
        proposal.resolutions.push({ obligation_id: pending.id, resolution: 'fulfilled', evidence: 'here is the revised quote', confidence: 0.95 });
      }
      return proposal;
    },
  };
  const { h, story } = await afterCanonical(procurementTask(addr), overEager);
  const supplierReply = (body: string, at: string, attachments?: Parameters<Harness['in']>[0]['attachments']) =>
    h.in({ from: addr.supplier, fromName: 'Dana', to: addr.self, subject: `Re: ${story.rfq.subject}`, body, at, threadKey: 'supplier', inReplyTo: story.correction.messageId, ...(attachments ? { attachments } : {}) });

  // 1. Words, no document.
  await supplierReply('Here is the revised quote.', '2026-10-20T15:00:00Z');
  const afterWords = theCommitment(h);
  assert.equal(afterWords.status, 'open');
  assert.ok(afterWords.notes.some((n) => /no quote attached/.test(n)));

  // 2. A document named like the revision, but its contents are the quote we already had.
  await supplierReply('Oops, attached now.', '2026-10-20T15:05:00Z', [{ filename: 'Q-2291-rev2.pdf', content_type: 'application/pdf', bytes: quoteV1() }]);
  assert.equal(theCommitment(h).status, 'open');
  assert.ok(theCommitment(h).notes.some((n) => /copy of a quote we already had/.test(n)));

  // 3. The actual revision.
  await supplierReply('Sorry, wrong file. Correct one attached.', '2026-10-20T15:10:00Z', [{ filename: 'Q-2291-rev2.pdf', content_type: 'application/pdf', bytes: quoteV2() }]);
  assert.equal(theCommitment(h).status, 'fulfilled');
});

test('a ceiling we quote in our own RFQ is not a budget approval', async () => {
  // A stand-in for a small model that read "must not exceed $11.50" in our RFQ as our own budget decision.
  const ownCeilingAsDecision: Extractor = {
    name: 'fake-llm',
    async extract(inp) {
      const proposal: Proposal = await heuristicExtractor.extract(inp);
      if (inp.event.direction === 'outbound' && /\$11\.50/.test(inp.event.body_text)) {
        proposal.claims.push({ key: 'budget.max_unit_price', value: 11.5, kind: 'decision', mode: 'assert', evidence: 'It must not exceed $11.50 per unit.', confidence: 0.95, hedged: false, from_attachment: null });
      }
      return proposal;
    },
  };
  const { h, story } = await afterCanonical(procurementTask(addr), ownCeilingAsDecision);

  // Only finance's reply sets the budget; our own figure stays tentative.
  const live = h.active('budget.max_unit_price');
  assert.equal(live.length, 1);
  assert.equal(live[0].source_event_id, story.approval.event.id);
  const ours = h.claims('budget.max_unit_price').filter((c) => c.speaker === addr.self);
  assert.ok(ours.length >= 1 && ours.every((c) => c.status === 'proposed' && /not authoritative/.test(c.supersede_reason!)));
});

test('a promise of ours makes it our move only once it is overdue', async () => {
  const promising: Extractor = {
    name: 'fake-llm',
    async extract(inp) {
      const proposal: Proposal = await heuristicExtractor.extract(inp);
      if (inp.event.direction === 'outbound') {
        proposal.obligations.push({ kind: 'commitment', debtor: 'sender', text: 'Send the signed PO by Oct 30', topic_keys: [], expects_artifact: 'po', due: '2026-10-30', evidence: 'Signed PO to follow by Oct 30.', confidence: 0.9 });
      }
      return proposal;
    },
  };
  const h = new Harness(procurementTask(addr), promising);
  await h.out(addr.supplier, 'PO-4817', 'Thanks Dana. Signed PO to follow by Oct 30.', '2026-10-21T09:00:00Z');

  const early = h.context(undefined, { now: '2026-10-22T09:00:00Z' });
  assert.notEqual(early.next_actor, 'us', 'a promise not yet due leaves the ball with them');
  assert.ok(early.suggested_actions.some((a) => a.kind === 'fulfil_our_commitment' && a.priority === 2));

  const late = h.context(undefined, { now: '2026-11-02T09:00:00Z' });
  assert.equal(late.next_actor, 'us');
  assert.match(late.suggested_actions[0].action, /OVERDUE \(due 2026-10-30\)/);
});

test('unknown senders on a linked thread are recorded but cannot set terms', async () => {
  const { h, story } = await afterCanonical();
  await h.in({ from: 'mallory@evil.example', fromName: 'Mallory', to: addr.self, subject: 'Re: PO-4817', body: 'Price is now $9.00 per unit.', at: '2026-10-20T16:00:00Z', threadKey: 'supplier', inReplyTo: story.correction.messageId });
  assert.equal(h.active('price.unit')[0].value, 11.4);
  assert.ok(h.flags().some((f) => f.kind === 'unknown_sender'));
});

test('briefing never presents superseded terms as current', async () => {
  const { h } = await afterCanonical();
  const briefing = h.briefing();
  const section = (heading: string) => briefing.split(heading)[1].split('\n## ')[0];
  const current = section('## Current terms');
  assert.match(current, /300 units Fri Oct 23 \+ 200 units Wed Oct 28/);
  assert.doesNotMatch(current, /500 units Fri Oct 23/);
  assert.match(section('## Superseded'), /500 units Fri Oct 23/);
});

test('commitment deadlines: "by tomorrow" gets a due date and becomes an overdue follow-up', async () => {
  const { h } = await afterCanonical();
  // The correction went out Tue Oct 20 and said "I'll send a revised quote by tomorrow".
  assert.equal(theCommitment(h).due_at, '2026-10-21');
  const { compileContext } = await import('../src/compiler/compile.ts');
  const beforeDue = compileContext(h.store, h.task.id, { now: '2026-10-20T12:00:00Z' });
  assert.equal(beforeDue.waiting_on_them[0].overdue, false);
  const pastDue = compileContext(h.store, h.task.id, { now: '2026-10-22T09:00:00Z' });
  assert.equal(pastDue.waiting_on_them[0].overdue, true);
  assert.ok(pastDue.suggested_actions.some((x) => x.priority === 1 && /OVERDUE/.test(x.action)));
});

test('questions never get due dates from their subject matter', async () => {
  const { h } = await afterCanonical();
  // "Can you deliver all 500 by Friday?" asks about a date; it is not "answer by Friday".
  const questions = h.obligations().filter((o) => o.kind === 'question');
  assert.ok(questions.length > 0 && questions.every((o) => o.due_at === null));
});

test('context reports emails still being interpreted, so agents never act on a half-updated state', async () => {
  // An extractor that blocks until we let it go, so we can look at the state mid-interpretation.
  // `reached` resolves once interpretation is under way, so the test never guesses how long that takes.
  let unblock!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (unblock = resolve));
  const reached = new Promise<void>((resolve) => (entered = resolve));
  const blocked: Extractor = { name: 'slow', async extract(inp) { entered(); await gate; return heuristicExtractor.extract(inp); } };
  const h = new Harness(procurementTask(addr), blocked);
  const delivery = h.mailbox.inbound({ from: addr.supplier, fromName: 'Dana', to: addr.self, subject: 'PO-4817 update', body: 'We can deliver 500 units Friday (Oct 23) at $11.40 each.', at: '2026-10-19T11:00:00Z', threadKey: 's' }, 'k');
  const ingesting = h.ingest(fromPrimitiveWebhook(JSON.parse(delivery.body)));
  await reached;

  assert.equal(h.context().meta.pending_events.length, 1);
  assert.match(h.briefing(), /still being processed/);

  unblock();
  await ingesting;
  assert.equal(h.context().meta.pending_events.length, 0);
  assert.equal(h.active('price.unit')[0].value, 11.4);
});

test('our conditional promises ("pay on invoice") are tracked but not urgent', async () => {
  const h = new Harness(procurementTask(addr));
  await h.out(addr.supplier, 'PO-4817', 'We will pay per Net 30 terms on invoice.', '2026-10-21T10:00:00Z');
  const promise = theCommitment(h);
  assert.equal(promise.status, 'open');
  const ctx = h.context();
  const reminder = ctx.suggested_actions.find((x) => x.obligation_id === promise.id)!;
  assert.equal(reminder.priority, 3);
  assert.notEqual(ctx.next_actor, 'us');
});

test('a colleague re-sending the replaced quote "for your files" changes nothing', async () => {
  const cs = 'cs@northwind.example';
  const task = procurementTask(addr);
  const group = task.participants.find((p) => p.address === addr.supplier)!.group;
  task.participants.push({ address: cs, name: 'Northwind CS', role: 'counterparty', label: 'supplier CS', authority: ['price.', 'delivery.', 'order.', 'payment.', 'quote.'], group });
  const h = new Harness(task);
  const rfq = await h.out(addr.supplier, 'RFQ — PO-4817', 'Hi Dana, please quote 500 units.', '2026-10-19T09:00:00Z');
  const pdf = (bytes: Buffer, filename: string) => [{ filename, content_type: 'application/pdf', bytes }];
  await h.in({ from: addr.supplier, fromName: 'Dana', to: addr.self, subject: 'Re: RFQ — PO-4817', body: 'Quote attached.', at: '2026-10-19T10:00:00Z', threadKey: 's', inReplyTo: rfq.messageId, attachments: pdf(quoteV1(), 'Q-2291.pdf') });
  await h.in({ from: addr.supplier, fromName: 'Dana', to: addr.self, subject: 'Re: RFQ — PO-4817', body: 'Revised quote attached.', at: '2026-10-20T10:00:00Z', threadKey: 's', inReplyTo: rfq.messageId, attachments: pdf(quoteV2(), 'Q-2291-rev2.pdf') });
  const before = h.claims().filter((c) => c.status === 'active').map((c) => [c.speaker, c.key, JSON.stringify(c.value)].join(' ')).sort();

  await h.in({ from: cs, fromName: 'Northwind CS', to: addr.self, subject: 'FW: RE: RFQ — PO-4817', body: 'Dana asked me to send the quote paperwork for your files.\n\n -----Original Message-----\nFrom: \tRuiz, Dana\nSent:\tMonday, October 19, 2026 10:00 AM\n\nQuote attached.', at: '2026-10-21T10:00:00Z', threadKey: 'cs', attachments: pdf(quoteV1(), 'Q-2291.pdf') });

  const copy = h.artifacts().filter((x) => x.filename === 'Q-2291.pdf').at(-1)!;
  assert.equal(copy.status, 'superseded');
  const fromCs = h.claims().filter((c) => c.speaker === cs);
  assert.ok(fromCs.length > 0 && fromCs.every((c) => c.status === 'superseded' && /copy of Q-2291\.pdf, which was already replaced/.test(c.supersede_reason!)));
  assert.equal(h.claims().filter((c) => c.status === 'contested').length, 0, 'the old terms do not contest the current ones');
  const after = h.claims().filter((c) => c.status === 'active').map((c) => [c.speaker, c.key, JSON.stringify(c.value)].join(' ')).sort();
  assert.deepEqual(after, before);
});
