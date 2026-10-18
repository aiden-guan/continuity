// Archetype: correction / supersession (P0). The reference hotel archetype.
//
// The hotel proposes the full block (with a proposal PDF), finance approves the rate cap in a separate
// thread, then the sales manager corrects ONE night of the block (a citywide convention / another
// group's contracted block took inventory): the peak night drops below what Acme needs. The rate and
// every other night are unchanged, and a revised proposal (or the contract) is promised.
//
// Trap: a running summary keeps "60 rooms every peak night" or merges the two blocks; "newest wins" on
// the whole proposal throws away the unchanged rate/attrition/cutoff; the proposal PDF is only stale on
// block.rooms; the revised document is promised, not received; the budget lives in another thread. The
// oracle: corrected block current, original block superseded, requirement violation on the short night,
// open commitment for the revised document, proposal partially stale on block.rooms only.
import type { Archetype, BenchCase, Checkpoint } from '../../core/types.ts';
import { MailBuilder, Rand, body, moneyShort, nextWeekday, pdf, reaskText, sayDate, seedOf, staleText } from '../../core/util.ts';
import {
  approvalBody, blockDisplay, budgetAsk, dayOf, firstName, hotel, hotelBackground, hotelChatter, hotelDayStart, hotelDeal, night,
  plainName, proposalBody, proposalLines, rfpBody, signoff, term, type Lot,
} from './vertical.ts';

export const correction: Archetype = {
  id: 'correction',
  title: 'Hotel corrects one night of the room block',
  capabilities: ['supersession', 'document_validity', 'cross_thread', 'open_loops', 'cold_handoff'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('hotel', 'correction', variant));
    const g = variant === 0;
    const d = hotelDeal(r, variant);
    const { self, sales, finance } = d.cast;
    const sf = firstName(sales);

    // ---- parameters
    const peak = Math.max(...d.block.map((l) => l.qty));
    const peakNights = d.block.filter((l) => l.qty === peak);
    const hit = g ? d.block[1] : r.pick(peakNights);
    const newQty = g ? 45 : Math.max(5, Math.round((hit.qty * r.pick([0.6, 0.7, 0.75, 0.8])) / 5) * 5);
    const lost = hit.qty - newQty;
    const corrected: Lot[] = d.block.map((l) => (l.date === hit.date ? { qty: newQty, date: l.date } : { ...l }));
    const reason = g ? 0 : r.int(0, 2);
    const reasonText = [
      `a citywide convention lands on ${sayDate(hit.date, 'weekday')} night and our revenue team has capped group inventory`,
      `another group already contracted rooms on ${sayDate(hit.date, 'weekday')} night that I missed when I built your proposal`,
      `one of our towers has a floor out of service for renovation on ${sayDate(hit.date, 'weekday')} night`,
    ][reason];
    const correctionStyle = g ? 0 : r.int(0, 3);
    const restatesRate = g ? true : r.chance(0.6);
    const promiseDoc: 'document.proposal' | 'document.contract' = g ? 'document.proposal' : r.pick(['document.proposal', 'document.contract'] as const);
    const fixDay = dayOf(d, 2);
    const due = g ? 'by Friday' : r.pick(['by Friday', 'later today', 'tomorrow', '']);
    const dueText = due === 'by Friday' ? `by ${sayDate(nextWeekday(fixDay, 5), 'weekday')}` : due;
    const nBackground = g ? 2 : r.int(2, 8);
    const nChatter = g ? 0 : r.int(0, 4);
    const proposalFile = `${d.hotel.short.replace(/\s+/g, '')}-Proposal-${d.proposalRef}.pdf`;

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => hotelDayStart(d, day, hhmm);

    // ---- history
    const rfp = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(0, '09:00'),
      subject: `Group RFP: ${d.event} — ${d.alias}`, body: rfpBody(r, d, g),
    });
    const ask = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [finance.address], at: t(0, '09:06'),
      subject: `Budget approval — ${d.alias} hotel block`, body: budgetAsk(r, d, g),
    });
    const offer = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(0, '14:20'),
      subject: mb.reSubject(rfp), replyTo: rfp, body: proposalBody(r, d, g),
      attachments: [pdf(proposalFile, proposalLines(d, { date: d.start }))],
    });
    hotelBackground(r, d, mb, t(0, '11:00'), nBackground);
    const approval = mb.add({
      direction: 'inbound', from: finance.address, fromName: plainName(finance), to: [self.address], at: t(1, '10:05'),
      subject: mb.reSubject(ask), replyTo: ask, body: approvalBody(r, d, g),
    });
    hotelChatter(r, d, mb, t(1, '13:00'), nChatter);

    const was = `${hit.qty} rooms`;
    const correctionText = [
      `I need to correct the proposal I sent: we can only offer ${newQty} rooms on ${sayDate(hit.date, 'weekday_long')}, not ${hit.qty}. Unfortunately ${reasonText}.`,
      `Correction on ${d.alias}: ${reasonText}, so ${sayDate(hit.date, 'weekday')} night (${sayDate(hit.date, 'month_day')}) has to come down from ${was} to ${newQty}. The other nights are fine as proposed.`,
      `Apologies, I have to revise your block. ${reasonText[0].toUpperCase()}${reasonText.slice(1)}. The most I can hold on ${night(hit.date)} is ${newQty} rooms (instead of ${hit.qty}); every other night stays as proposed.`,
      `Quick but important update: ${sayDate(hit.date, 'month_day')} is now ${newQty} rooms rather than ${hit.qty}, because ${reasonText}.`,
    ][correctionStyle];
    const promise = promiseDoc === 'document.proposal'
      ? `I'll send a revised proposal${dueText ? ` ${dueText}` : ''}.`
      : `I'll send the contract${dueText ? ` ${dueText}` : ''}, and it will reflect the updated block.`;
    const fix = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(2, '10:12'),
      subject: mb.reSubject(rfp), replyTo: offer,
      body: body(
        g ? 'Hi again,' : 'Hi,', correctionText,
        `${restatesRate ? `Your rate of ${moneyShort(d.rate)} is unchanged. ` : ''}${promise}`,
        g ? `Sorry about that,\n${sf}` : signoff(sales, d.hotel.name),
      ),
    });

    // ---- oracle
    const shortText = `${newQty} rooms on ${night(hit.date)} is ${lost} short of the ${hit.qty} Acme needs`;
    const checkpoint: Checkpoint = {
      id: 'after_correction', after: fix, now: t(2, '10:30'),
      state: {
        terms: [
          term(sales, 'rate.group', d.rate, restatesRate ? [offer, fix] : [offer], true),
          term(sales, 'block.rooms', corrected, [fix], true),
          term(finance, 'budget.max_rate', d.cap, [approval], true),
          term(sales, 'attrition.allowance', d.attrition, [offer]),
          term(sales, 'cutoff.date', d.cutoff, [offer]),
          term(sales, 'fnb.minimum', d.fnb, [offer]),
          term(sales, 'meeting.room_rental', d.meeting, [offer]),
        ],
        superseded: [
          { party: sales.address, term: 'block.rooms', value: d.block, display: blockDisplay(d.block), evidence: [offer], superseded_by: fix },
        ],
        open_loops: [
          {
            kind: 'commitment', debtor: sales.address, subject: promiseDoc, alt_subjects: [promiseDoc === 'document.proposal' ? 'document.contract' : 'document.proposal'],
            display: promiseDoc === 'document.proposal' ? 'Hotel owes a revised proposal with the corrected block' : 'Hotel owes the contract reflecting the corrected block', evidence: [fix], critical: true,
          },
        ],
        closed_loops: [
          { kind: 'ask', debtor: sales.address, subject: 'rate.group', display: 'Group rate (answered)', evidence: [offer] },
          { kind: 'ask', debtor: sales.address, subject: 'block.rooms', display: 'Availability for the requested block (answered)', evidence: [offer] },
          { kind: 'ask', debtor: sales.address, subject: 'document.proposal', display: 'Initial proposal (received)', evidence: [offer] },
          { kind: 'ask', debtor: finance.address, subject: 'budget.max_rate', alt_subjects: ['approval.budget'], display: 'Budget approval (given)', evidence: [approval] },
        ],
        conflicts: [
          { kind: 'requirement_violation', term: 'block.rooms', party: sales.address, display: shortText, critical: true },
        ],
        documents: [
          { filename: proposalFile, status: 'partially_stale', stale_terms: ['block.rooms'], display: `${proposalFile}: ${night(hit.date)} block superseded; rate, attrition, cutoff, F&B and other nights still current` },
        ],
        next_actor: 'us',
      },
      judge_facts: [
        `Current hotel terms: group rate ${moneyShort(d.rate)}/night; block ${blockDisplay(corrected)}.`,
        `The original block (${hit.qty} rooms on ${night(hit.date)}) was corrected by the hotel and is no longer valid; the other nights did not change.`,
        `Acme needs ${hit.qty} rooms on ${night(hit.date)}, so the corrected block is ${lost} rooms short of a hard requirement.`,
        `Finance already approved up to ${moneyShort(d.cap)}/night. The hotel promised ${promiseDoc === 'document.proposal' ? 'a revised proposal' : 'the contract'}, which has NOT arrived yet.`,
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_sales', text: 'Sends a message to the hotel sales manager', det: { type: 'message_to', party: sales.address } },
          { id: 'raise_shortfall', text: `Tells the hotel that ${newQty} rooms on ${night(hit.date)} falls ${lost} short of the ${hit.qty} needed and asks for a fix (restore the rooms, an overflow/sister property, or another option)` },
        ],
        optional: [
          { id: 'mention_revised_doc', text: `Mentions that the ${promiseDoc === 'document.proposal' ? 'revised proposal' : 'contract'} is still expected` },
        ],
        prohibited: [
          { id: 'binding_accept', text: 'Accepts the proposal or confirms the block with the hotel', det: { type: 'binding_to', party: sales.address } },
          { id: 'stale_block', text: staleText(`Treats the original ${hit.qty} rooms on ${night(hit.date)} as still offered`), stale: true },
          { id: 'reask_rate', text: reaskText(`Asks the hotel again for the group rate (already known: ${moneyShort(d.rate)}/night)`, true) },
          { id: 'reask_budget', text: reaskText('Asks finance again to approve the rate cap (already approved)') },
          { id: 'claims_doc_arrived', text: 'Says or implies the revised proposal or contract has already been received' },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return {
      id: `hotel/correction/${variant}`,
      vertical: 'hotel',
      archetype: 'correction',
      variant,
      split: variant === 0 ? 'golden' : variant <= 10 ? 'dev' : 'eval',
      capabilities: correction.capabilities,
      description: `Hotel corrects ${night(hit.date)} from ${hit.qty} to ${newQty} rooms; rate unchanged; budget approved in a separate thread; ${promiseDoc === 'document.proposal' ? 'revised proposal' : 'contract'} owed.`,
      task: d.task,
      events: mb.sorted(),
      trigger: fix,
      checkpoints: [checkpoint],
      params: { hit: hit.date, from: hit.qty, to: newQty, reason, correctionStyle, restatesRate, promiseDoc, due, nBackground, nChatter, rate: d.rate, cap: d.cap, arrival: d.arrival },
    };
  },
};

export { hotel };
