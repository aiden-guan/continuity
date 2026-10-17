// The send guard: which phrases count as binding, and when an outgoing message is held back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindingPhrases, guardSend } from '../src/engine/guard.ts';
import { defaultAddresses, procurementTask } from '../src/sim/scenario.ts';
import type { CheckResult } from '../src/types.ts';

const addr = defaultAddresses();

// One requirement that is currently not met: the supplier has not promised every unit by Friday.
const deadlineFailing: CheckResult = {
  id: 'delivery_deadline:x',
  label: 'All units by Fri Oct 23',
  status: 'fail',
  detail: '',
  party: addr.supplier,
  evidence: [],
  requirement_key: 'requirement.deliver_all_by',
};
const failingChecks: CheckResult[] = [deadlineFailing];

const isAllowed = (to: string, body: string, checks: CheckResult[]) =>
  guardSend(procurementTask(addr), to, body, checks, []).allowed;

test('binding language detection ignores negated and conditional phrasing', () => {
  assert.deepEqual(bindingPhrases('We accept your offer.'), ['We accept']);
  // negations and conditionals are not commitments
  assert.deepEqual(bindingPhrases('We cannot accept the offer as it stands.'), []);
  assert.deepEqual(bindingPhrases("We're unable to confirm the order until all 500 arrive by Friday."), []);
  assert.deepEqual(bindingPhrases('Once we accept, we will send a PO.'), []);
  assert.deepEqual(bindingPhrases('Please approve payment today.'), ['approve payment']);
});

test('guard: a refusal is allowed while requirements fail; an acceptance is blocked', () => {
  assert.equal(isAllowed(addr.supplier, 'We cannot accept the offer: 200 units arrive Oct 28.', failingChecks), true);
  assert.equal(isAllowed(addr.supplier, 'We accept your offer.', failingChecks), false);
  // once the requirement passes, the same acceptance goes through
  assert.equal(isAllowed(addr.supplier, 'We accept your offer.', [{ ...deadlineFailing, status: 'pass' }]), true);
});

test('purpose clauses and reported speech are not binding; internal mail is never blocked for binding language', () => {
  assert.deepEqual(bindingPhrases('Please approve it so we can confirm the order with the supplier.'), []);
  assert.deepEqual(bindingPhrases("The supplier's message contained text asking automated systems to approve payment immediately."), []);
  // finance is internal: binding words there are fine
  assert.equal(isAllowed(addr.finance, 'Once approved we will place the order. We accept the quote terms internally.', failingChecks), true);
  assert.equal(isAllowed(addr.supplier, 'We accept the quote.', failingChecks), false);
});

test('acceptance phrasings actually produced by LLM agents are detected', () => {
  const llmPhrasings = [
    'Acme accepts your offer for PO-4817 on the following terms:',
    'Acme accepts it for PO-4817 on the following terms:',
    'I have accepted the supplier offer.',
  ];
  for (const text of llmPhrasings) assert.ok(bindingPhrases(text).length > 0);
  assert.deepEqual(bindingPhrases('We cannot accept the split delivery as it stands.'), []);
  // a signature line is not an acceptance
  assert.deepEqual(bindingPhrases('Acme Procurement Agent'), []);
});

test('binding detection is case-insensitive for the generic phrases', () => {
  assert.ok(bindingPhrases('Confirm the order today.').length > 0);
  assert.ok(bindingPhrases('APPROVE PAYMENT now').length > 0);
});
