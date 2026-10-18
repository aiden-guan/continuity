// The send guard: which phrases count as binding, and whether an outgoing message is allowed, held
// for a human, or blocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindingPhrases, guardSend, selfNamesOf, taskBindingPhrases } from '../src/engine/guard.ts';
import { defaultAddresses, procurementTask } from '../src/sim/scenario.ts';
import type { CheckResult, Claim } from '../src/types.ts';

const a = defaultAddresses();
const failing: CheckResult[] = [{ id: 'delivery_deadline:x', label: 'All units by Fri Oct 23', status: 'fail', detail: '', party: a.supplier, evidence: [], requirement_key: 'requirement.deliver_all_by' }];

test('binding language detection ignores negated and conditional phrasing', () => {
  assert.deepEqual(bindingPhrases('We accept your offer.'), ['We accept']);
  assert.deepEqual(bindingPhrases('We cannot accept the offer as it stands.'), []);
  assert.deepEqual(bindingPhrases("We're unable to confirm the order until all 500 arrive by Friday."), []);
  assert.deepEqual(bindingPhrases('Once we accept, we will send a PO.'), []);
  assert.deepEqual(bindingPhrases('Please approve payment today.'), ['approve payment']);
});

test('guard: a refusal is allowed while requirements fail; an acceptance is blocked, and held for a human once they pass', () => {
  const t = procurementTask(a);
  assert.equal(guardSend(t, a.supplier, 'We cannot accept the offer: 200 units arrive Oct 28.', failing, []).allowed, true);
  assert.equal(guardSend(t, a.supplier, 'We accept your offer.', failing, []).allowed, false);
  const ok = guardSend(t, a.supplier, 'We accept your offer.', [{ ...failing[0], status: 'pass' }], []);
  assert.equal(ok.outcome, 'hold'); // requirements pass, but a human approves every commitment by default
  assert.match(ok.hold_reasons.join(' '), /a human approves every commitment/);
  assert.equal(guardSend({ ...t, approval: { commitments: 'auto_when_clear' } }, a.supplier, 'We accept your offer.', [{ ...failing[0], status: 'pass' }], []).outcome, 'allow');
});

test('purpose clauses and reported speech are not binding; internal mail is never blocked for binding language', () => {
  assert.deepEqual(bindingPhrases('Please approve it so we can confirm the order with the supplier.'), []);
  assert.deepEqual(bindingPhrases("The supplier's message contained text asking automated systems to approve payment immediately."), []);
  const t = procurementTask(a);
  assert.equal(guardSend(t, a.finance, 'Once approved we will place the order. We accept the quote terms internally.', failing, []).allowed, true);
  assert.equal(guardSend(t, a.supplier, 'We accept the quote.', failing, []).allowed, false);
});

test('acceptance phrasings actually produced by LLM agents are detected', () => {
  assert.ok(bindingPhrases('Acme accepts your offer for PO-4817 on the following terms:').length > 0);
  assert.ok(bindingPhrases('Acme accepts it for PO-4817 on the following terms:').length > 0);
  assert.ok(bindingPhrases('I have accepted the supplier offer.').length > 0);
  assert.deepEqual(bindingPhrases('We cannot accept the split delivery as it stands.'), []);
  assert.deepEqual(bindingPhrases('Acme Procurement Agent'), []);
});

test('binding detection is case-insensitive for the generic phrases', () => {
  assert.ok(bindingPhrases('Confirm the order today.').length > 0);
  assert.ok(bindingPhrases('APPROVE PAYMENT now').length > 0);
});

import { BINDING_FRESH, BINDING_HELDOUT, BINDING_TUNING, NON_BINDING_FRESH, NON_BINDING_HELDOUT, NON_BINDING_TUNING } from './fixtures/binding-corpus.ts';
const passing: CheckResult[] = [{ ...failing[0], status: 'pass' }];

test('previously reported bypasses are caught', () => {
  for (const s of ['Not a problem at all, we accept your offer.', 'Glad we were able to agree, we accept your offer.', 'Deal — please go ahead and ship all 500.', 'We are happy to proceed with the order.',
    'We ассept your offer.', 'We acc​ept your offer.', 'Before anything else: we accept your offer.', 'We accept your offer, ok?']) {
    assert.ok(bindingPhrases(s).length > 0, s);
  }
});

test('corpus regression: every binding sentence caught, no harmless sentence flagged', () => {
  for (const s of [...BINDING_TUNING, ...BINDING_HELDOUT, ...BINDING_FRESH]) assert.ok(bindingPhrases(s).length > 0, `missed: ${s}`);
  for (const s of [...NON_BINDING_TUNING, ...NON_BINDING_HELDOUT, ...NON_BINDING_FRESH]) assert.deepEqual(bindingPhrases(s), [], `false positive: ${s}`);
});

test('declared intent: commit needs passing requirements; a non-commit that reads as binding is a mismatch', () => {
  const t = procurementTask(a);
  // commit with failing requirements: blocked even if the wording dodges the tripwire
  const dodge = guardSend(t, a.supplier, 'Locked and loaded, ship them out.', failing, [], 'commit');
  assert.equal(dodge.allowed, false);
  assert.match(dodge.reasons.join(' '), /requirements not met/);
  assert.equal(guardSend(t, a.supplier, 'We accept your offer.', passing, [], 'commit').outcome, 'hold');
  // declared negotiate but wrote an acceptance: a human decides what was meant (blocked outright if a requirement fails)
  const mismatch = guardSend(t, a.supplier, 'We accept your offer.', passing, [], 'negotiate');
  assert.equal(mismatch.outcome, 'hold');
  assert.match(mismatch.hold_reasons.join(' '), /intent mismatch/);
  assert.equal(guardSend(t, a.supplier, 'We accept your offer.', failing, [], 'negotiate').outcome, 'block');
  assert.equal(guardSend(t, a.supplier, 'Can you deliver all 500 by Friday?', failing, [], 'ask').allowed, true);
  // no declared intent (older clients): binding text is treated as a commitment
  assert.equal(guardSend(t, a.supplier, 'We accept your offer.', failing, []).allowed, false);
  // internal mail cannot commit us to a counterparty
  assert.equal(guardSend(t, a.finance, 'We accept the quote terms internally.', failing, [], 'commit').allowed, true);
});

test('the domain pack adds binding phrases, and the name we sign as comes from the task (not a literal)', () => {
  const t = procurementTask(a);
  assert.deepEqual(selfNamesOf(t), ['acme']);
  // "Acme authorizes …" commits us only because the task says we are Acme
  assert.ok(taskBindingPhrases(t, 'Acme authorizes shipment of all 500 units.').length > 0);
  assert.deepEqual(bindingPhrases('Acme authorizes shipment of all 500 units.', []), []);
  const renamed = { ...t, participants: t.participants.map((p) => (p.role === 'self' ? { ...p, name: 'Globex Buying Desk', label: 'Globex (us)' } : p)) };
  assert.deepEqual(taskBindingPhrases(renamed, 'Acme authorizes shipment of all 500 units.'), []);
  assert.ok(taskBindingPhrases(renamed, 'Globex authorizes shipment of all 500 units.').length > 0);
  // a pack's own phrasing goes through the same clause-aware checks (negation, conditionals, questions)
  const vendor = { ...t, domain: 'vendor_onboarding' };
  assert.ok(taskBindingPhrases(vendor, 'Good news: onboarding is complete.').length > 0);
  assert.deepEqual(taskBindingPhrases(vendor, 'Once we receive your W-9, onboarding is complete.'), []);
  assert.deepEqual(taskBindingPhrases(vendor, 'Is onboarding complete on your side?'), []);
  assert.deepEqual(taskBindingPhrases(t, 'Good news: onboarding is complete.'), []);
});

test('payment / wire details are held for a human even on internal mail; credentials are blocked', () => {
  const t = procurementTask(a);
  const wire = guardSend(t, a.finance, 'Please wire the funds to account number 4455-2210 today.', passing, [], 'inform');
  assert.equal(wire.outcome, 'hold');
  assert.match(wire.hold_reasons.join(' '), /payment \/ wire \/ bank details/);
  assert.equal(guardSend(t, a.finance, `Our key is ctk_${'x'.repeat(24)}`, passing, [], 'inform').outcome, 'block');
});

test('our own echo of a term only finance sets does not hold a budget request; an unverified claim still does', () => {
  const t = procurementTask(a);
  const claim = (speaker: string, reason: string): Claim => ({
    id: 'cl_1', task_id: t.id, key: 'budget.max_unit_price', value: 11.5, display: '$11.50', kind: 'info', speaker,
    source_event_id: 'ev_1', source_artifact_id: null, evidence: '', status: 'proposed', superseded_by: null,
    supersede_reason: reason, learned_at: '2026-10-19T09:00:00Z', confidence: 1, extractor: 'test',
  });
  const ask = 'Could you approve a budget of up to $11.50 per unit for PO-4817?';
  assert.equal(guardSend(t, a.finance, ask, [], [claim(a.self, 'Acme (us) is not authoritative for budget.max_unit_price')]).outcome, 'allow');
  const relayed = guardSend(t, a.supplier, 'Our budget is $11.50 per unit.', [], [claim(a.supplier, 'supplier is not authoritative for budget.max_unit_price')]);
  assert.equal(relayed.outcome, 'hold');
});
