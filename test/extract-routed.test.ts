// Spending a model call only on mail that needs one: our own mail and empty mail go to the rule extractor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ROUTE, routedExtractor, routeFromEnv } from '../src/extract/routed.ts';
import { emptyProposal, type ExtractInput, type Extractor } from '../src/extract/types.ts';
import { defaultAddresses, procurementTask } from '../src/sim/scenario.ts';

const a = defaultAddresses();
const task = procurementTask(a);
let modelCalls = 0;
const model: Extractor = { name: 'model', fingerprint: 'fp', async extract() { modelCalls++; return emptyProposal(); } };
const input = (direction: 'inbound' | 'outbound', body: string, attachments: ExtractInput['attachments'] = []): ExtractInput => ({
  task, attachments, senderRole: direction === 'outbound' ? 'self' : 'counterparty', openObligations: [], activeClaims: [],
  event: { id: 'ev_1', seq: 1, task_id: task.id, link_reason: null, source: 'local-sim', dedupe_key: 'k', thread_id: 't', message_id: '<m@x>', in_reply_to: null, references: [], direction, from: direction === 'outbound' ? a.self : a.supplier, to: [direction === 'outbound' ? a.supplier : a.self], cc: [], subject: 'Re: RFQ', body_text: body, occurred_at: '2026-10-19T10:00:00Z', received_at: '2026-10-19T10:00:00Z', attachments: [] },
});

test('the default route skips empty and plain mail; "none" or an empty value sends every email to the model', async () => {
  assert.deepEqual(routeFromEnv(DEFAULT_ROUTE), { outboundByRules: false, outboundPlainByRules: true, skipEmpty: true });
  assert.deepEqual(routeFromEnv('none'), { outboundByRules: false, outboundPlainByRules: false, skipEmpty: false });
  modelCalls = 0;
  const ex = routedExtractor(model, routeFromEnv(''));
  assert.equal(ex, model);
  await ex.extract(input('outbound', 'Can you deliver by Friday?'));
  assert.equal(modelCalls, 1);
});

test('outbound by rules: our own questions are read without a model call', async () => {
  modelCalls = 0;
  const ex = routedExtractor(model, { outboundByRules: true });
  const p = await ex.extract(input('outbound', 'Hi Dana, can you deliver all 500 units by Friday, Oct 23? Please send a formal quote.'));
  assert.equal(modelCalls, 0);
  assert.ok(p.obligations.length >= 1, 'the rule extractor still records our questions');
  await ex.extract(input('inbound', 'Thanks, noted.'));
  assert.equal(modelCalls, 1, 'inbound mail still goes to the model');
  assert.notEqual(ex.fingerprint, model.fingerprint, 'cached readings are keyed on the routing');
});

test('skip empty: only mail that carries nothing skips the model', async () => {
  modelCalls = 0;
  const ex = routedExtractor(model, { skipEmpty: true });
  await ex.extract(input('inbound', 'Thanks, noted.'));
  assert.equal(modelCalls, 0);
  await ex.extract(input('inbound', 'Thanks, we will ship 300 on Friday.'));
  await ex.extract(input('inbound', 'Got it. Anything else you need from us?'));
  await ex.extract(input('inbound', 'See attached.', [{ filename: 'q.pdf', content_type: 'application/pdf', text: 'Quote' }]));
  await ex.extract(input('inbound', "I'll send the revised quote tomorrow"));
  assert.equal(modelCalls, 4, 'a number, a question, an attachment or a promise sends it to the model');
});

test('outbound plain by rules: only mail that asks, promises, offers or accepts nothing skips the model', async () => {
  modelCalls = 0;
  const ex = routedExtractor(model, { outboundPlainByRules: true });
  await ex.extract(input('outbound', 'Thanks Dana, noted.'));
  await ex.extract(input('outbound', 'Adding Sam from our team.'));
  assert.equal(modelCalls, 0);
  for (const body of ['ok to go to 13.00/ea on po-9145?', 'PO going out tonight', 'We counter at the original terms.', 'Go ahead and ship.', 'Can you get under budget', 'We accept your quote.']) await ex.extract(input('outbound', body));
  assert.equal(modelCalls, 6);
});

test('skip empty: routine mail naming the deal by its reference, with no term words, skips the model', async () => {
  modelCalls = 0;
  const ex = routedExtractor(model, { skipEmpty: true });
  await ex.extract(input('inbound', 'Quick update on PO-4817: production is on track.'));
  await ex.extract(input('inbound', 'Thanks for the call earlier regarding PO-4817.'));
  await ex.extract(input('inbound', 'Our office closes at 3 on Friday for the holiday.'));
  assert.equal(modelCalls, 0);
  await ex.extract(input('inbound', 'PO-4817: boards ship in ESD trays, 50 per tray.'));
  await ex.extract(input('inbound', 'Price for PO-4817 is now 11.20.'));
  await ex.extract(input('inbound', 'Can you confirm the address for PO-4817?'));
  assert.equal(modelCalls, 3, 'a term word with a figure, a price, or a question still goes to the model');
});
