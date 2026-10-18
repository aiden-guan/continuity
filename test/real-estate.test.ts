// The real-estate domain pack: extraction, checks, the full deal room through fresh agents, the typed
// timeline and Signal — all through the same engine as procurement. Ported from samrocksnature's b615ab7.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Harness } from '../src/sim/harness.ts';
import { dealAddresses, dealParties, elmStreetDeal } from '../src/sim/real-estate.ts';
import { runElmStreet } from '../src/sim/deal-story.ts';
import { heuristicExtractor, stripQuoted } from '../src/extract/heuristic.ts';
import type { ExtractInput } from '../src/extract/types.ts';
import { deriveTimeline, eventTypeIds, stateAt } from '../src/engine/timeline.ts';
import { notifyWebhook, runSignal } from '../src/signal.ts';
import { domainFor, registeredDomains } from '../src/domain/index.ts';
import { bindingPhrases, guardSend } from '../src/engine/guard.ts';
import { MemoryBackend } from '../src/store/memory-backend.ts';
import { SqliteBackend } from '../src/store/sqlite.ts';
import { DEFAULT_ORG } from '../src/engine/engine.ts';
import type { Backend } from '../src/store/backend.ts';
import { backendCases, closeAll, uniqueOrg } from './backends.ts';

after(closeAll);

const a = dealAddresses();
const deal = elmStreetDeal(a);
const roleOf = { listing: 'counterparty', buyer: 'internal', lender: 'internal', inspector: 'internal', self: 'self' } as const;
const extract = async (body: string, who: keyof typeof roleOf, at = '2026-10-20T10:00:00Z') =>
  (await heuristicExtractor.extract({
    task: deal, event: { body_text: body, occurred_at: at, from: a[who] } as never, senderRole: roleOf[who], openObligations: [], activeClaims: [], attachments: [],
  } as unknown as ExtractInput)).claims.map((c) => [c.key, c.value, c.kind]);

test('real estate extraction: counter, ceiling, appraisal, a moved closing date, contingency; deposits and questions ignored', async () => {
  assert.deepEqual(await extract('The seller counters at $845,000 with closing on Friday, Nov 20.', 'listing'), [['price.purchase', 845000, 'offer'], ['closing.date', '2026-11-20', 'offer']]);
  assert.deepEqual(await extract("Yes, I'm comfortable going up to $850,000 for 42 Elm St.", 'buyer'), [['budget.max_price', 850000, 'decision']]);
  assert.deepEqual(await extract('The appraisal came in at $830,000.', 'lender'), [['appraisal.value', 830000, 'info']]);
  assert.deepEqual(await extract('Correction: closing needs to move to Friday, Dec 4.', 'listing', '2026-10-23T09:00:00Z'), [['closing.date', '2026-12-04', 'offer']]);
  assert.deepEqual(await extract('The seller reduced the price from $845,000 to $830,000.', 'listing'), [['price.purchase', 830000, 'offer']]);
  assert.deepEqual(await extract('Earnest money deposit of $25,000 is due Monday.', 'listing'), []);
  assert.deepEqual(await extract('We include a 10-day inspection contingency.', 'listing'), [['contingency.inspection_until', '2026-10-30', 'offer']]);
  // our own mail: only the amount we put forward is our offer, not the numbers we quote back
  assert.deepEqual(await extract('The appraisal came in at $830,000, below the $845,000 price, so we ask the seller to bring the price down to $830,000.', 'self'), [['price.purchase', 830000, 'decision']]);
  assert.deepEqual(await extract('Can the seller do $830,000?', 'listing'), []);
  assert.deepEqual(await extract('Unfortunately the seller has accepted another offer on 42 Elm St.', 'listing'), [['deal.fell_through', 'Unfortunately the seller has accepted another offer on 42 Elm St', 'decision']]);
});

test('the full deal room: fresh agents negotiate from compiled state and accept only when every check passes', async () => {
  const h = new Harness(deal, undefined, '2026-10-19T08:00:00Z');
  const s = await runElmStreet(h, a, 'after-b');
  const b = s.decisions['agent-b'];
  const toListing = b.messages.find((m) => m.to === a.listing)!;
  assert.match(toListing.body, /\$830,000/);
  assert.match(toListing.body, /Fri Nov 20/);
  assert.match(toListing.body, /revised counter/);
  assert.deepEqual(bindingPhrases(toListing.body, domainFor(deal).bindingPatterns), []);
  assert.ok(b.messages.some((m) => m.to === a.inspector && /inspection report by Mon Oct 26/.test(m.body)), 'chases the overdue inspection report');
  assert.ok(h.flags().some((f) => f.kind === 'prompt_injection_suspected'), 'the counter PDF instruction is quarantined');
  assert.equal(h.artifacts().find((x) => x.filename === 'Crestline-Counter-ELM-42.pdf')?.status, 'partially_stale');
  assert.equal(h.artifacts().find((x) => x.filename === 'Crestline-Counter-ELM-42.pdf')?.kind, 'counter_offer');
  // a premature acceptance is refused while the appraisal gap and the closing date fail
  const premature = guardSend(deal, a.listing, 'We accept the $845,000 counter.', h.checks(), h.claims());
  assert.equal(premature.allowed, false);
  assert.match(premature.reasons.join(' '), /Appraisal covers the price/);

  const h2 = new Harness(deal, undefined, '2026-10-19T08:00:00Z');
  const end = await runElmStreet(h2, a, 'end');
  const c = end.decisions['agent-c'];
  assert.equal(c.messages.length, 1);
  assert.match(c.messages[0].body, /we accept for 42 Elm St: purchase price \$830,000, closing Fri Nov 20/);
  assert.ok(h2.checks().every((x) => x.status === 'pass'));
  assert.equal(h2.artifacts().find((x) => x.filename === 'Crestline-Counter-ELM-42.pdf')?.status, 'superseded');
  assert.ok(h2.obligations().every((o) => o.status !== 'open'), 'every promise and question closed');
  assert.equal(h2.context().next_actor, 'none');
});

test('typed timeline: ordered, typed, sourced; the terms at any moment are a step function', async () => {
  const h = new Harness(deal, undefined, '2026-10-19T08:00:00Z');
  await runElmStreet(h, a, 'end');
  const tl = deriveTimeline(h.store, deal.id);
  const types = new Set(tl.map((e) => e.type));
  for (const t of ['offer_made', 'counter_offer', 'price_ceiling_approved', 'inspection_scheduled', 'appraisal_received', 'closing_set', 'contingency_deadline_set',
    'commitment_made', 'commitment_fulfilled', 'conflict_detected', 'conflict_resolved', 'document_received', 'document_superseded', 'injection_quarantined', 'offer_accepted']) {
    assert.ok(types.has(t), t);
  }
  assert.deepEqual(tl.map((e) => e.seq), [...tl.map((e) => e.seq)].sort((x, y) => x - y));
  const moved = tl.find((e) => e.type === 'closing_set' && e.replaces);
  assert.equal(moved?.replaces, 'Fri Nov 20');
  assert.equal(moved?.display, 'Fri Dec 4');
  assert.ok(tl.filter((e) => e.term).every((e) => e.source_event?.startsWith('ev_')));
  // ids: generic below 100, the pack's own from 100
  const ids = eventTypeIds(domainFor(deal));
  assert.ok(ids.get('message_received')! < 100 && ids.get('counter_offer')! >= 100);
  assert.ok(tl.every((e) => e.type_id > 0));
  const term = (st: ReturnType<typeof stateAt>, key: string, party: string) => st.terms.find((t) => t.term === key && t.party === party)?.value;
  const midweek = stateAt(h.store, deal.id, '2026-10-23T12:00:00Z');
  assert.equal(term(midweek, 'price.purchase', 'listing agent'), 845000);
  assert.equal(term(midweek, 'closing.date', 'listing agent'), '2026-12-04');
  assert.equal(term(midweek, 'budget.max_price', 'buyer'), 850000);
  const final = stateAt(h.store, deal.id, '2026-10-29T00:00:00Z');
  assert.equal(term(final, 'price.purchase', 'listing agent'), 830000);
  assert.equal(term(final, 'closing.date', 'listing agent'), '2026-11-20');
  // by seq: the very first event knows no terms yet
  assert.equal(stateAt(h.store, deal.id, tl[0].seq).terms.length, 0);
});

test('a withdrawal ends the deal: terms are retracted on the timeline, the agent stops negotiating', async () => {
  const h = new Harness(deal, undefined, '2026-10-19T08:00:00Z');
  await runElmStreet(h, a, 'before-b');
  await h.in({ ...dealParties.listingCorrection(a, { messageId: null, subject: 'ELM-42' }), at: '2026-10-26T09:00:00Z', body: 'Unfortunately the seller has accepted another offer on 42 Elm St.' });
  const ctx = h.context();
  assert.equal(ctx.suggested_actions.filter((x) => x.kind === 'raise_conflict').length, 0);
  assert.ok(h.checks().some((c) => c.id.startsWith('deal_available:') && c.status === 'fail'));
  const tl = deriveTimeline(h.store, deal.id);
  assert.ok(tl.some((e) => e.type === 'fell_through'));
  assert.ok(tl.some((e) => e.type === 'term_withdrawn' && e.term === 'price.purchase'));
  assert.equal(stateAt(h.store, deal.id, '2026-10-27T00:00:00Z').terms.find((t) => t.term === 'price.purchase' && t.party === 'listing agent'), undefined);
  // Signal stays quiet about a deal that fell through
  const run = await runSignal(h.backend, h.org, { now: '2026-10-27T08:00:00Z' });
  assert.equal(run.open.length, 0);
});

/** Signal over a backend: raise once, remember, resolve when the condition clears. */
async function signalStory(backend: Backend, org = DEFAULT_ORG) {
  const h = new Harness(deal, undefined, '2026-10-19T08:00:00Z', { backend, org });
  await runElmStreet(h, a, 'before-b');
  const first = await runSignal(backend, org, { now: '2026-10-27T08:00:00Z' });
  const rules = first.new.map((x) => x.rule);
  assert.equal(rules.filter((r) => r === 'requirement_failing').length, 2); // appraisal gap + closing date
  assert.ok(rules.includes('overdue'));
  assert.ok(first.new.some((x) => x.rule === 'deadline' && /inspection contingency/.test(x.summary) && /in 3 day/.test(x.summary)));
  assert.ok(rules.includes('security')); // the injected instruction in the counter PDF
  assert.ok(first.new.every((x) => x.detail.evidence.length > 0 || x.rule === 'stalled'));
  assert.equal(first.new[0].severity, 'high');

  const again = await runSignal(backend, org, { now: '2026-10-27T09:00:00Z' });
  assert.equal(again.new.length, 0); // nothing new: no repeated alerts
  assert.equal(again.open.length, first.open.length);

  await h.in(dealParties.listingResolution(a, { messageId: null, subject: 'Re: Offer: 42 Elm St — ELM-42' }, 'appraisal and closing Nov 20'));
  await h.in(dealParties.inspectorReport(a, { messageId: null, subject: 'Inspection booked: 42 Elm St (ELM-42)' }));
  const after = await runSignal(backend, org, { now: '2026-10-28T14:00:00Z' });
  assert.ok(after.resolved.some((k) => k.includes(':conflict:appraisal_gap')));
  assert.ok(after.resolved.some((k) => k.includes(':overdue:')));
  const remembered = await backend.listSignals(org, { includeResolved: true });
  assert.ok(remembered.some((s) => s.resolved_at && s.rule === 'overdue'));
  assert.ok((await backend.listSignals(org)).every((s) => !s.resolved_at));
  return first;
}

test('Signal (memory backend): raises what matters unprompted, reports each alert once, clears it when resolved; webhook delivery', async () => {
  const first = await signalStory(new MemoryBackend());
  let got: { text?: string; alerts?: unknown[] } = {};
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { got = JSON.parse(b); res.end('ok'); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    assert.equal(await notifyWebhook(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`, first), true);
    assert.match(got.text ?? '', /Signal — \d+ new alert/);
    assert.equal(got.alerts?.length, first.new.length);
    assert.equal(await notifyWebhook(undefined, first), false);
  } finally {
    srv.close();
  }
});

test('Signal (SQLite backend): alerts are remembered in the signals table and survive a reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'continuity-signal-'));
  const file = join(dir, 'signal.db');
  try {
    await signalStory(new SqliteBackend(file));
    const reopened = new SqliteBackend(file);
    await reopened.ensureOrg(DEFAULT_ORG);
    assert.ok((await reopened.listSignals(DEFAULT_ORG, { includeResolved: true })).length > 0);
    await reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// the same story on the shared backend matrix (Supabase Postgres joins when CONTINUITY_TEST_DB_URL is set)
for (const backendCase of backendCases().filter((c) => c.name !== 'memory')) {
  test(`Signal (${backendCase.name} backend): alerts are remembered per org`, async () => {
    const backend = await backendCase.make();
    const org = uniqueOrg('signal');
    await backend.ensureOrg(org);
    await signalStory(backend, org);
    assert.equal((await backend.listSignals(uniqueOrg('other'), { includeResolved: true })).length, 0);
  });
}

test('domain packs: real_estate is registered next to procurement and vendor onboarding', () => {
  assert.ok(registeredDomains().includes('real_estate'));
  assert.ok(registeredDomains().includes('procurement'));
  assert.deepEqual(domainFor('procurement').terms.map((t) => t.key).slice(0, 2), ['price.unit', 'delivery.schedule']);
  assert.equal(domainFor('real_estate').decisionKey, 'decision.accept');
});

test('a forged buyer approval (fails DMARC) never raises the ceiling and is flagged', async () => {
  const h = new Harness(deal, undefined, '2026-10-19T08:00:00Z');
  await h.in(dealParties.buyerApproval(a, { messageId: null, subject: 'ELM-42 budget' }));
  await h.in(dealParties.forgedApproval(a));
  await h.refresh();
  const ceilings = h.store.claimsForTask(deal.id).filter((c) => c.key === 'budget.max_price');
  assert.deepEqual(ceilings.filter((c) => c.status === 'active').map((c) => c.value), [850000]);
  const forged = ceilings.find((c) => c.value === 900000)!;
  assert.equal(forged.status, 'proposed');
  assert.match(forged.supersede_reason ?? '', /not authenticated/);
  assert.ok(h.flags().some((f) => f.kind === 'sender_unauthenticated'));
});

test('an acceptance is stored as one word, so a restated acceptance is the same decision', async () => {
  const { canonicalDecision } = await import('../src/domain/values.ts');
  const { domainFor } = await import('../src/domain/pack.ts');
  const re = domainFor(elmStreetDeal(dealAddresses()));
  assert.equal(re.normalizeValue('decision.accept', 'Buyer accepts the counter at $605,000'), 'accepted');
  assert.equal(re.normalizeValue('decision.accept', 'Seller signed the counter at $628,000'), 'accepted');
  assert.equal(re.normalizeValue('decision.accept', 'accepted'), 'accepted');
  // a counter is not an acceptance: unusable as decision.accept
  assert.equal(re.normalizeValue('decision.accept', 'Counter #2 at $752,000'), null);
  assert.equal(canonicalDecision('We will not accept anything over $900k'), 'declined');
  assert.equal(canonicalDecision('accepted and placing PO-3392'), 'accepted');
});

// A scripted reading per message body, so the claims under test are exact.
function scripted(byBody: Record<string, { key: string; value: unknown; kind: 'offer' | 'decision' }[]>) {
  return {
    name: 'scripted',
    async extract(inp: ExtractInput) {
      const proposal = await heuristicExtractor.extract(inp);
      const fresh = stripQuoted(inp.event.body_text); // what this message itself says, not the history it quotes
      const claims = Object.entries(byBody).find(([needle]) => fresh.includes(needle))?.[1] ?? [];
      return { ...proposal, claims: claims.map((c) => ({ ...c, mode: 'assert' as const, evidence: inp.event.body_text, confidence: 0.95, hedged: false, from_attachment: null })) };
    },
  };
}

test('our counter is our current position, kept apart from the seller\'s terms', async () => {
  const a = dealAddresses();
  const h = new Harness(elmStreetDeal(a), scripted({
    'We counter at $945,000': [{ key: 'price.purchase', value: 945000, kind: 'offer' }, { key: 'closing.date', value: '2026-12-18', kind: 'offer' }],
    'Counter at $972,000': [{ key: 'price.purchase', value: 972000, kind: 'offer' }],
    'our ceiling is $975,000': [{ key: 'budget.max_price', value: 975000, kind: 'offer' }],
  }));
  const offer = await h.out(a.listing, 'Offer - 12 Elm St', 'We counter at $945,000, closing Dec 18. Note our ceiling is $975,000 in any case.', '2026-11-02T09:00:00Z');
  await h.in({ from: a.listing, fromName: 'Jordan', to: a.self, subject: 'Re: Offer - 12 Elm St', body: 'Counter at $972,000.', at: '2026-11-02T12:00:00Z', threadKey: 'elm', inReplyTo: offer.messageId });

  const price = (who: string) => h.active('price.purchase').filter((c) => c.speaker === who).map((c) => c.value);
  assert.deepEqual(price(a.self), [945000], 'our counter is current for us');
  assert.deepEqual(price(a.listing), [972000], 'theirs is current for them; neither contests the other');
  assert.equal(h.active('closing.date').find((c) => c.speaker === a.self)?.value, '2026-12-18');
  // a figure of ours on a term our own side decides is still not the buyer's budget
  assert.ok(h.claims('budget.max_price').every((c) => c.status === 'proposed' && /not authoritative/.test(c.supersede_reason!)));
  // the price check reads the seller's terms, not ours
  const check = h.checks().find((c) => c.id.startsWith('price_budget:'));
  assert.match(check?.detail ?? '', /\$972,000/);
});

test('accepting their terms retires a different earlier offer of ours, and keeps one they matched', async () => {
  const a = dealAddresses();
  const h = new Harness(elmStreetDeal(a), scripted({
    'We offer $880,000': [{ key: 'price.purchase', value: 880000, kind: 'offer' }, { key: 'closing.date', value: '2026-12-18', kind: 'offer' }],
    'Counter: $905,000': [{ key: 'price.purchase', value: 905000, kind: 'offer' }, { key: 'closing.date', value: '2026-12-18', kind: 'offer' }],
    'Buyer accepts the counter': [{ key: 'decision.accept', value: 'Buyer accepts the counter at $905,000', kind: 'decision' }],
  }));
  const offer = await h.out(a.listing, 'Offer - 12 Elm St', 'We offer $880,000, closing Dec 18.', '2026-11-02T09:00:00Z');
  const counter = await h.in({ from: a.listing, fromName: 'Jordan', to: a.self, subject: 'Re: Offer - 12 Elm St', body: 'Counter: $905,000, closing Dec 18.', at: '2026-11-02T12:00:00Z', threadKey: 'elm', inReplyTo: offer.messageId });
  await h.out(a.listing, 'Re: Offer - 12 Elm St', 'Buyer accepts the counter at $905,000.', '2026-11-02T15:00:00Z', { messageId: counter.messageId });

  const ours = (key: string) => h.claims(key).filter((c) => c.speaker === a.self);
  const oldPrice = ours('price.purchase').find((c) => c.value === 880000)!;
  assert.equal(oldPrice.status, 'superseded');
  assert.match(oldPrice.supersede_reason!, /we accepted listing agent's price\.purchase \(\$905,000\)/);
  // our closing date matched theirs, so it is still our position
  assert.equal(ours('closing.date')[0].status, 'active');
  assert.equal(h.active('decision.accept')[0].value, 'accepted');
});
