// Archetype: supersession chain (P1). A -> B -> C.
//
// A: the proposal (PDF) has a rate above Acme's cap and attrition below Acme's minimum. We push back on
// both. B: the sales manager sends a bundled counteroffer that changes three terms at once: rate down,
// attrition up, and, as the trade, the cutoff pulled earlier. C: one of the three reverts to its value
// in A ("revenue overruled me on the rate"; "attrition has to go back"; "we can keep your original
// cutoff after all"), while the other two from B stand.
//
// Trap: "newest message wins" on the whole offer loses the two B terms that C did not touch; a summary
// keeps B's value for the reverted term; listing A's reverted value as superseded is wrong because it is
// current again. The oracle: latest value per term current; superseded lists exactly the dead values
// (A's two replaced terms and B's reverted term); the proposal PDF is stale only on the two terms whose
// current value differs from it; violations recomputed on the final state.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleConflict, OracleLoop, OracleSuperseded } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, moneyShort, nextWeekday, pdf, sayDate, seedOf, staleText } from '../../core/util.ts';
import {
  AGENT_SIGN, TERM_LABEL, dayOf, firstName, hotel, hotelBackground, hotelChatter, hotelDayStart, hotelDeal, pct, plainName, proposalBody,
  proposalLines, rfpBody, show, signoff, term, violation,
} from './vertical.ts';

type K = 'rate.group' | 'attrition.allowance' | 'cutoff.date';
const KEYS: K[] = ['rate.group', 'attrition.allowance', 'cutoff.date'];

export const supersession_chain: Archetype = {
  id: 'supersession_chain',
  title: 'Bundled counteroffer, then one term reverts',
  capabilities: ['supersession', 'document_validity'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('hotel', 'supersession_chain', variant));
    const g = variant === 0;
    const d = hotelDeal(r, variant);
    const { self, sales } = d.cast;
    const sf = firstName(sales);

    // ---- parameters
    const A: Record<K, unknown> = {
      'rate.group': d.cap + (g ? 14 : r.pick([4, 9, 14, 19, 24])),
      'attrition.allowance': d.minAttrition - 5,
      'cutoff.date': d.cutoff,
    };
    const tradeDays = d.cutoffDays < d.maxCutoffDays ? d.maxCutoffDays : d.maxCutoffDays + 7;
    const B: Record<K, unknown> = {
      'rate.group': d.rate,
      'attrition.allowance': d.attrition,
      'cutoff.date': addDays(d.arrival, -tradeDays),
    };
    const reverted: K = g ? 'rate.group' : r.pick(KEYS);
    const final: Record<K, unknown> = { ...B, [reverted]: A[reverted] };
    const promisesRevised = g ? false : r.chance(0.5);
    const style = g ? 0 : r.int(0, 2);
    const nBackground = g ? 2 : r.int(2, 7);
    const nChatter = g ? 1 : r.int(0, 3);
    const proposalFile = `${d.hotel.short.replace(/\s+/g, '')}-Proposal-${d.proposalRef}.pdf`;

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => hotelDayStart(d, day, hhmm);
    const say = (k: K, v: unknown) => (k === 'rate.group' ? `${moneyShort(v as number)}/night` : k === 'attrition.allowance' ? `${pct(v as number)} attrition` : `a cutoff of ${sayDate(v as string, 'long')} (${Math.round((Date.parse(d.arrival) - Date.parse(v as string)) / 86_400_000)} days out)`);

    // ---- A: proposal
    const rfp = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(0, '09:00'), subject: `Group RFP: ${d.event} — ${d.alias}`, body: rfpBody(r, d, g) });
    const a = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(0, '15:20'), subject: mb.reSubject(rfp), replyTo: rfp,
      body: proposalBody(r, d, g, { rate: A['rate.group'] as number, attrition: A['attrition.allowance'] as number }),
      attachments: [pdf(proposalFile, proposalLines(d, { date: d.start, rate: A['rate.group'] as number, attrition: A['attrition.allowance'] as number }))],
    });
    hotelBackground(r, d, mb, t(0, '10:00'), nBackground);
    const counter = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(1, '10:00'), subject: mb.reSubject(rfp), replyTo: a,
      body: body(`Hi ${sf},`, [
        `Thanks for the proposal. Two things we need to make this work: a rate of ${moneyShort(d.cap)} or less, and at least ${pct(d.minAttrition)} attrition.`,
        `We'd love to book with you, but ${moneyShort(A['rate.group'] as number)} is over our cap and ${pct(A['attrition.allowance'] as number)} attrition is too tight. Can you get to ${moneyShort(d.cap)} or below and ${pct(d.minAttrition)}+ attrition?`,
        `Can revenue improve the rate (we need ${moneyShort(d.cap)} max) and the attrition (we need ${pct(d.minAttrition)} minimum)?`,
      ][style], AGENT_SIGN),
    });

    // ---- B: bundled counteroffer
    const b = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(1, '16:30'), subject: mb.reSubject(rfp), replyTo: counter,
      body: body('Hi,', [
        `I went to bat for you with revenue. We can do ${say('rate.group', B['rate.group'])} and ${say('attrition.allowance', B['attrition.allowance'])}, but in exchange we need ${say('cutoff.date', B['cutoff.date'])}.`,
        `Here's what I can offer: rate ${moneyShort(B['rate.group'] as number)}, attrition ${pct(B['attrition.allowance'] as number)}, and the cutoff moves to ${sayDate(B['cutoff.date'] as string, 'month_day')}. That's the package revenue approved.`,
        `Counterproposal for ${d.alias}: ${moneyShort(B['rate.group'] as number)} per night, ${pct(B['attrition.allowance'] as number)} attrition, cutoff ${sayDate(B['cutoff.date'] as string, 'weekday_long')}. Everything else as in the proposal.`,
      ][style], signoff(sales, d.hotel.name)),
    });
    hotelChatter(r, d, mb, t(2, '09:00'), nChatter);

    // ---- C: one term reverts
    const revertText = {
      'rate.group': [
        `Bad news, I'm afraid: revenue overruled me on the rate. It has to go back to ${moneyShort(A['rate.group'] as number)}. The attrition and cutoff from my last email stand.`,
        `I have to walk back one thing. The rate reverts to the original ${moneyShort(A['rate.group'] as number)}; the ${pct(B['attrition.allowance'] as number)} attrition and ${sayDate(B['cutoff.date'] as string, 'month_day')} cutoff are still fine.`,
        `Update: our DOS won't approve ${moneyShort(B['rate.group'] as number)}, so we're back at ${moneyShort(A['rate.group'] as number)}/night. Attrition and cutoff unchanged from yesterday's offer.`,
      ],
      'attrition.allowance': [
        `One correction to my last email: attrition has to go back to ${pct(A['attrition.allowance'] as number)}, per our revenue director. The ${moneyShort(B['rate.group'] as number)} rate and the cutoff stand.`,
        `I overstepped on attrition, sorry. It reverts to the original ${pct(A['attrition.allowance'] as number)}; rate and cutoff stay as I offered.`,
        `Revenue approved the rate and cutoff but not the attrition, which goes back to ${pct(A['attrition.allowance'] as number)}.`,
      ],
      'cutoff.date': [
        `Some good news: revenue agreed to keep your original cutoff of ${sayDate(A['cutoff.date'] as string, 'long')}. The rate and attrition from my last email stand.`,
        `We don't need the earlier cutoff after all; it goes back to ${sayDate(A['cutoff.date'] as string, 'month_day')}. ${moneyShort(B['rate.group'] as number)} and ${pct(B['attrition.allowance'] as number)} attrition still apply.`,
        `Revision: cutoff returns to the proposal date (${sayDate(A['cutoff.date'] as string, 'weekday_long')}). Rate and attrition unchanged from my counteroffer.`,
      ],
    }[reverted][style];
    const c = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(2, '14:15'), subject: mb.reSubject(rfp), replyTo: b,
      body: body('Hi,', revertText, promisesRevised ? `I'll send a revised proposal by ${sayDate(nextWeekday(dayOf(d, 2), 5), 'weekday')}.` : null, signoff(sales, d.hotel.name)),
    });

    // ---- oracle
    const superseded: OracleSuperseded[] = [];
    for (const k of KEYS) {
      if (k === reverted) superseded.push({ party: sales.address, term: k, value: B[k], display: show(k, B[k]), evidence: [b], superseded_by: c });
      else if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) superseded.push({ party: sales.address, term: k, value: A[k], display: show(k, A[k]), evidence: [a], superseded_by: b });
    }
    const stale = KEYS.filter((k) => JSON.stringify(final[k]) !== JSON.stringify(A[k]));
    const conflicts: OracleConflict[] = KEYS.map((k) => [k, violation(d, k, final[k])] as const).filter(([, v]) => v)
      .map(([k, v]) => ({ kind: 'requirement_violation', term: k, party: sales.address, display: v!, critical: true }));
    const openLoops: OracleLoop[] = promisesRevised ? [{ kind: 'commitment', debtor: sales.address, subject: 'document.proposal', display: 'Hotel owes a revised proposal', evidence: [c] }] : [];
    const required: ActionCond[] = [{ id: 'to_sales', text: 'Sends a message to the hotel sales manager', det: { type: 'message_to', party: sales.address } }];
    for (const x of conflicts) required.push({ id: `push_${x.term.split('.')[0]}`, text: `Pushes back on the ${TERM_LABEL[x.term]}: ${x.display}` });
    if (!conflicts.length) required.push({ id: 'proceed', text: `Moves forward on the current package (${KEYS.map((k) => show(k, final[k])).join(', ')}), e.g. by asking for the contract` });
    const checkpoint: Checkpoint = {
      id: 'after_revert', after: c, now: t(2, '14:40'),
      state: {
        terms: [
          term(sales, 'rate.group', final['rate.group'], reverted === 'rate.group' ? [a, c] : [b, c], true),
          term(sales, 'attrition.allowance', final['attrition.allowance'], reverted === 'attrition.allowance' ? [a, c] : [b, c], true),
          term(sales, 'cutoff.date', final['cutoff.date'], reverted === 'cutoff.date' ? [a, c] : [b, c], true),
          term(sales, 'block.rooms', d.block, [a]),
          term(sales, 'fnb.minimum', d.fnb, [a]),
        ],
        superseded,
        open_loops: openLoops,
        closed_loops: [
          { kind: 'ask', debtor: sales.address, subject: 'rate.group', display: 'Request for a lower rate (answered)', evidence: [b] },
          { kind: 'ask', debtor: sales.address, subject: 'attrition.allowance', display: 'Request for more attrition (answered)', evidence: [b] },
          { kind: 'ask', debtor: sales.address, subject: 'document.proposal', display: 'Proposal (received)', evidence: [a] },
        ],
        conflicts,
        documents: [
          { filename: proposalFile, status: 'partially_stale', stale_terms: stale, display: `${proposalFile}: ${stale.map((k) => TERM_LABEL[k]).join(' and ')} superseded; ${TERM_LABEL[reverted]}, block and F&B current` },
        ],
        next_actor: 'us',
      },
      judge_facts: [
        `Current hotel terms: rate ${show('rate.group', final['rate.group'])}, attrition ${show('attrition.allowance', final['attrition.allowance'])}, cutoff ${show('cutoff.date', final['cutoff.date'])}.`,
        `The ${TERM_LABEL[reverted]} went ${show(reverted, A[reverted])} (proposal) -> ${show(reverted, B[reverted])} (counteroffer) -> back to ${show(reverted, A[reverted])}; the counteroffer's other two terms still stand.`,
        `No longer valid: ${superseded.map((s) => `${TERM_LABEL[s.term]} ${s.display}`).join('; ')}.`,
        conflicts.length ? `Requirement problems: ${conflicts.map((x) => x.display).join('; ')}.` : 'All current terms meet Acme requirements.',
      ].join(' '),
      action: {
        expect: 'send',
        required,
        optional: [{ id: 'confirm_package', text: 'Restates the current package back to the hotel to confirm it' }],
        prohibited: [
          ...superseded.map((s, i) => ({
            id: `stale_${i}`,
            text: staleText(`Treats the ${TERM_LABEL[s.term]} of ${s.display} as current`),
            stale: true,
          })),
          ...(conflicts.length ? [{ id: 'binding', text: 'Accepts the offer or confirms the booking while a requirement is still broken', det: { type: 'binding_to' as const, party: sales.address } }] : []),
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return {
      id: `hotel/supersession_chain/${variant}`,
      vertical: 'hotel',
      archetype: 'supersession_chain',
      variant,
      split: variant === 0 ? 'golden' : variant <= 10 ? 'dev' : 'eval',
      capabilities: supersession_chain.capabilities,
      description: `Proposal -> bundled counter (rate, attrition, cutoff) -> ${reverted} reverts.`,
      task: d.task,
      events: mb.sorted(),
      trigger: c,
      checkpoints: [checkpoint],
      params: { A, B, final, reverted, promisesRevised, style, nBackground, nChatter },
    };
  },
};

export { hotel };
