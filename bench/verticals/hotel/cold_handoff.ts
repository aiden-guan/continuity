// Archetype: cold handoff (P0). The headline product test: a fresh agent wakes up mid-negotiation.
//
// A longer story (11-16 task messages plus background mail): RFP, proposal PDF, finance approval in its
// own thread, a Q&A that answers the comp ratio and deposit and in which the hotel commits to a draft
// contract, a second answered question (meeting-room rental), state-neutral chatter (sometimes the
// revenue manager introducing himself), then a correction of ONE proposal term (cutoff pulled earlier,
// a peak night cut, or a higher F&B minimum) that breaks a hard requirement. The trigger is the hotel
// nudging us to move forward because another group wants the dates, with the contract still not sent.
//
// Trap: everything at once. A summary drifts (keeps the proposal value, forgets the comp ratio answer),
// the approval is in another thread, the hold-date pressure invites a premature "we accept", and the
// contract promise is easy to mark as done. The oracle: corrected value current and the old one
// superseded; the proposal partially stale on that term only; the answered questions closed; the
// contract commitment open; the violation raised; nothing binding sent.
import type { Archetype, BenchCase, Checkpoint } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, moneyShort, nextWeekday, pdf, reaskText, sayDate, seedOf, staleText } from '../../core/util.ts';
import {
  AGENT_SIGN, TERM_LABEL, addParty, approvalBody, budgetAsk, dayOf, firstName, hotel, hotelBackground, hotelChatter, hotelDayStart, hotelDeal, night,
  pct, plainName, proposalBody, proposalLines, rfpBody, show, signoff, term, violation, type Lot,
} from './vertical.ts';

type Fix = 'cutoff.date' | 'block.rooms' | 'fnb.minimum';

export const cold_handoff: Archetype = {
  id: 'cold_handoff',
  title: 'Fresh agent takes over a half-negotiated hotel booking',
  capabilities: ['cold_handoff', 'supersession', 'document_validity', 'open_loops', 'cross_thread'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('hotel', 'cold_handoff', variant));
    const g = variant === 0;
    const d = hotelDeal(r, variant);
    const { self, sales, finance, revenue } = d.cast;
    const sf = firstName(sales);

    // ---- parameters
    const fixKey: Fix = g ? 'cutoff.date' : r.pick(['cutoff.date', 'block.rooms', 'fnb.minimum'] as const);
    const peak = Math.max(...d.block.map((l) => l.qty));
    const hit = d.block.find((l) => l.qty === peak)!;
    const cutQty = Math.max(5, Math.round((hit.qty * (g ? 0.75 : r.pick([0.6, 0.7, 0.8]))) / 5) * 5);
    const newCutoffDays = d.maxCutoffDays + (g ? 15 : r.pick([7, 14, 15]));
    const newValue: unknown = fixKey === 'cutoff.date'
      ? addDays(d.arrival, -newCutoffDays)
      : fixKey === 'block.rooms'
        ? d.block.map((l): Lot => (l.date === hit.date ? { qty: cutQty, date: l.date } : { ...l }))
        : d.maxFnb + (g ? 5000 : r.pick([2500, 5000, 7500]));
    const oldValue: unknown = fixKey === 'cutoff.date' ? d.cutoff : fixKey === 'block.rooms' ? d.block : d.fnb;
    const withRevenueIntro = g ? true : r.chance(0.5);
    const nBackground = g ? 3 : r.int(3, 8);
    const nChatter = g ? 2 : r.int(2, 4);
    const proposalFile = `${d.hotel.short.replace(/\s+/g, '')}-Proposal-${d.proposalRef}.pdf`;
    const contractDay = nextWeekday(dayOf(d, 1), 5);
    const newContractDay = nextWeekday(dayOf(d, 4), 2);

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => hotelDayStart(d, day, hhmm);

    // ---- day 0: RFP, budget request, proposal
    const rfp = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(0, '09:00'), subject: `Group RFP: ${d.event} — ${d.alias}`, body: rfpBody(r, d, g) });
    const ask = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [finance.address], at: t(0, '09:05'), subject: `Budget approval — ${d.alias} hotel block`, body: budgetAsk(r, d, g) });
    hotelBackground(r, d, mb, t(0, '10:00'), nBackground);
    const offer = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(0, '15:10'),
      subject: mb.reSubject(rfp), replyTo: rfp, body: proposalBody(r, d, g), attachments: [pdf(proposalFile, proposalLines(d, { date: d.start }))],
    });

    // ---- day 1: approval (other thread), Q&A, contract promise
    const approval = mb.add({ direction: 'inbound', from: finance.address, fromName: plainName(finance), to: [self.address], at: t(1, '10:00'), subject: mb.reSubject(ask), replyTo: ask, body: approvalBody(r, d, g) });
    const q1 = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(1, '11:30'), subject: mb.reSubject(rfp), replyTo: offer,
      body: body(`Hi ${sf},`, g
        ? 'Thanks for the proposal, it looks good. Two questions: what comp ratio do you offer, and what deposit would you need and when? If those work, please send a draft contract.'
        : r.pick([
          'The proposal looks promising. What is your comp ratio, and what is the deposit amount and due date? Assuming those are standard, a draft contract would be great.',
          'Thanks! Before legal review: (1) comp ratio? (2) deposit amount and timing? Please also send a draft contract.',
          'A couple of follow-ups: do you include comp rooms, and how is the deposit structured? Then we would like to see the contract.',
        ]), AGENT_SIGN),
    });
    const a1 = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(1, '16:20'), subject: mb.reSubject(rfp), replyTo: q1,
      body: body('Hi,', g
        ? `Comps are ${d.comp} paid room-nights. The deposit is ${moneyShort(d.deposit)}, due ${sayDate(d.depositDue, 'long')}. I'll have the draft contract to you by ${sayDate(contractDay, 'weekday')}.`
        : r.pick([
          `Comp ratio is ${d.comp}. Deposit: ${moneyShort(d.deposit)} due ${sayDate(d.depositDue, 'month_day')}. I'll get a draft contract over to you by ${sayDate(contractDay, 'weekday')}.`,
          `We offer ${d.comp.replace('1 per', 'one comp per')} paid. We'd need a ${moneyShort(d.deposit)} deposit by ${sayDate(d.depositDue, 'weekday_long')}. Contract coming by ${sayDate(contractDay, 'weekday')}.`,
          `Happy to help: comps at ${d.comp}, and a deposit of ${moneyShort(d.deposit)} payable by ${sayDate(d.depositDue, 'long')}. I'm drafting the contract now and will send it by ${sayDate(contractDay, 'weekday')}.`,
        ]), signoff(sales, d.hotel.name)),
    });
    hotelChatter(r, d, mb, t(2, '08:30'), nChatter);

    // ---- day 2: second answered question
    const q2 = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(2, '10:40'), subject: `Meeting space — ${d.alias}`,
      body: body(`Hi ${sf},`, r.pick([
        'Is the meeting room rental waived if we hit the F&B minimum?',
        'Quick one: does the meeting room rental go away if we meet the F&B minimum?',
        'Would you waive the meeting-space rental once the F&B minimum is reached?',
      ]), AGENT_SIGN),
    });
    const a2 = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(2, '14:05'), subject: mb.reSubject(q2), replyTo: q2,
      body: body('Hi,', r.pick([
        `It isn't waived, I'm afraid; the rental stays at ${moneyShort(d.meeting)} for the program, but it covers the general session and both breakouts all days.`,
        `No waiver on this one; the meeting room rental remains ${moneyShort(d.meeting)} total.`,
        `Unfortunately not. Rental is ${moneyShort(d.meeting)} regardless of F&B, which is already a discount on our standard.`,
      ]), signoff(sales, d.hotel.name)),
    });

    // ---- day 3: the correction (and sometimes the revenue manager intro)
    const fixText = (() => {
      switch (fixKey) {
        case 'cutoff.date': return r.pick([
          `I need to correct the cutoff in the proposal: our peak-season contracting policy requires ${newCutoffDays} days, so the cutoff is ${sayDate(newValue as string, 'long')}, not ${sayDate(d.cutoff, 'month_day')}.`,
          `Correction: the cutoff date should read ${sayDate(newValue as string, 'month_day')} (${newCutoffDays} days prior). The ${sayDate(d.cutoff, 'month_day')} in the proposal was a template error.`,
          `Revenue flagged that the proposal's cutoff was wrong. For your dates it has to be ${sayDate(newValue as string, 'weekday_long')}, ${newCutoffDays} days before arrival.`,
        ]);
        case 'block.rooms': return r.pick([
          `I have to correct your block: ${night(hit.date)} can only be ${cutQty} rooms, not ${hit.qty}, because of a citywide that night. The other nights are unchanged.`,
          `Correction on the proposal: we're capped at ${cutQty} rooms on ${sayDate(hit.date, 'weekday_long')} (instead of ${hit.qty}). Other nights stay the same.`,
          `Revenue has limited group inventory on ${sayDate(hit.date, 'month_day')}, so that night drops from ${hit.qty} to ${cutQty} rooms.`,
        ]);
        default: return r.pick([
          `I need to correct the F&B minimum: it should be ${moneyShort(newValue as number)}, not ${moneyShort(d.fnb)}. The proposal used 2026 banquet pricing.`,
          `Correction: with 2027 menu pricing the F&B minimum comes to ${moneyShort(newValue as number)} rather than ${moneyShort(d.fnb)}.`,
          `Our catering director caught an error: the food and beverage minimum is ${moneyShort(newValue as number)}.`,
        ]);
      }
    })();
    const fix = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(3, '10:15'), subject: mb.reSubject(rfp), replyTo: a1,
      body: body(g ? 'Hi again,' : 'Hi,', fixText, 'Everything else in the proposal is unchanged and the contract will reflect this. Sorry for the confusion.', signoff(sales, d.hotel.name)),
    });
    if (withRevenueIntro) {
      addParty(d, revenue);
      mb.add({
        direction: 'inbound', from: revenue.address, fromName: plainName(revenue), to: [self.address], cc: [sales.address], at: t(3, '15:30'), subject: `Introduction — ${d.alias}`,
        body: body(`Hello,`, `I'm the director of revenue at ${d.hotel.name}. ${sf} has told me about ${d.event}; just wanted to introduce myself. ${sf} remains your main point of contact.`, signoff(revenue, d.hotel.name)),
        note: 'state-neutral intro from the same hotel group',
      });
    }

    // ---- day 4: trigger — hold-date nudge, contract still pending
    const nudge = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(4, '09:50'), subject: mb.reSubject(rfp), replyTo: fix,
      body: body('Hi,', g
        ? `Just a heads-up: another group has asked about your dates. Your first-option hold runs until ${sayDate(d.holdUntil, 'long')}, so let me know soon if you'd like to move forward. The draft contract is taking a little longer than I hoped; you'll have it by ${sayDate(newContractDay, 'weekday')}.`
        : r.pick([
          `Checking in: we have a second group interested in the same dates. We're holding the space for you until ${sayDate(d.holdUntil, 'weekday_long')}; please let me know if you want to go ahead. Sorry, the contract slipped; it'll be with you ${sayDate(newContractDay, 'weekday')}.`,
          `Another planner asked about your dates this morning. Your hold is good through ${sayDate(d.holdUntil, 'month_day')}, so let me know where you land. I'm still finalizing the contract and will send it by ${sayDate(newContractDay, 'weekday')}.`,
          `Friendly nudge: your option on the space expires ${sayDate(d.holdUntil, 'long')} and we have interest from another group. Let me know how you'd like to proceed. The draft contract should be ready ${sayDate(newContractDay, 'weekday')}.`,
        ]), signoff(sales, d.hotel.name)),
    });

    // ---- oracle
    const val = (k: string, v: unknown) => (k === fixKey ? newValue : v);
    const ev = (k: string, e: string[]) => (k === fixKey ? [fix] : e);
    const why = violation(d, fixKey, newValue)!;
    const checkpoint: Checkpoint = {
      id: 'cold_handoff', after: nudge, now: t(4, '10:30'),
      state: {
        terms: [
          term(sales, 'rate.group', d.rate, [offer], true),
          term(sales, 'block.rooms', val('block.rooms', d.block), ev('block.rooms', [offer]), true),
          term(sales, 'attrition.allowance', d.attrition, [offer]),
          term(sales, 'cutoff.date', val('cutoff.date', d.cutoff), ev('cutoff.date', [offer]), fixKey === 'cutoff.date'),
          term(sales, 'fnb.minimum', val('fnb.minimum', d.fnb), ev('fnb.minimum', [offer]), fixKey === 'fnb.minimum'),
          term(sales, 'meeting.room_rental', d.meeting, [offer, a2]),
          term(sales, 'concession.comp_ratio', d.comp, [a1]),
          term(sales, 'deposit.amount', d.deposit, [a1]),
          term(sales, 'deposit.due', d.depositDue, [a1]),
          term(sales, 'offer.hold_until', d.holdUntil, [offer, nudge]),
          term(finance, 'budget.max_rate', d.cap, [approval], true),
        ],
        superseded: [
          { party: sales.address, term: fixKey, value: oldValue, display: show(fixKey, oldValue), evidence: [offer], superseded_by: fix },
        ],
        open_loops: [
          { kind: 'commitment', debtor: sales.address, subject: 'document.contract', display: `Hotel owes the draft contract (now promised by ${sayDate(newContractDay, 'weekday_short_date')})`, evidence: [a1, nudge], critical: true },
          { kind: 'ask', debtor: self.address, subject: 'decision.contract', alt_subjects: ['offer.hold_until'], display: `Hotel asks whether Acme wants to move forward before the hold expires ${sayDate(d.holdUntil, 'weekday_short_date')}`, evidence: [nudge] },
        ],
        closed_loops: [
          { kind: 'ask', debtor: sales.address, subject: 'document.proposal', display: 'Proposal (received)', evidence: [offer] },
          { kind: 'ask', debtor: sales.address, subject: 'rate.group', display: 'Group rate (answered)', evidence: [offer] },
          { kind: 'ask', debtor: finance.address, subject: 'budget.max_rate', alt_subjects: ['approval.budget'], display: 'Budget approval (given)', evidence: [approval] },
          { kind: 'ask', debtor: sales.address, subject: 'concession.comp_ratio', display: 'Comp ratio (answered)', evidence: [a1] },
          { kind: 'ask', debtor: sales.address, subject: 'deposit.amount', alt_subjects: ['deposit.due'], display: 'Deposit amount and due date (answered)', evidence: [a1] },
          { kind: 'ask', debtor: sales.address, subject: 'meeting.room_rental', display: 'Meeting-room rental waiver (answered: not waived)', evidence: [a2] },
        ],
        conflicts: [
          { kind: 'requirement_violation', term: fixKey, party: sales.address, display: why, critical: true },
        ],
        documents: [
          { filename: proposalFile, status: 'partially_stale', stale_terms: [fixKey], display: `${proposalFile}: ${TERM_LABEL[fixKey]} corrected by email; all other terms current` },
        ],
        next_actor: 'us',
      },
      judge_facts: [
        `Current hotel terms: rate ${moneyShort(d.rate)}/night; block ${show('block.rooms', val('block.rooms', d.block))}; attrition ${pct(d.attrition)}; cutoff ${show('cutoff.date', val('cutoff.date', d.cutoff))}; F&B minimum ${show('fnb.minimum', val('fnb.minimum', d.fnb))}; meeting rental ${moneyShort(d.meeting)} (not waived); comps ${d.comp}; deposit ${moneyShort(d.deposit)} due ${sayDate(d.depositDue, 'long')}.`,
        `The proposal's ${TERM_LABEL[fixKey]} (${show(fixKey, oldValue)}) was corrected by the hotel and is no longer valid; the corrected value breaks a hard requirement: ${why}.`,
        `Finance approved up to ${moneyShort(d.cap)}/night in a separate thread. The hotel's draft contract has NOT arrived (now promised by ${sayDate(newContractDay, 'weekday_short_date')}). The hotel holds the space until ${sayDate(d.holdUntil, 'long')}.`,
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_sales', text: 'Sends a message to the hotel sales manager', det: { type: 'message_to', party: sales.address } },
          { id: 'raise_violation', text: `Raises the corrected ${TERM_LABEL[fixKey]} with the hotel (${why}) and asks for it to be fixed before contracting` },
        ],
        optional: [
          { id: 'hold', text: `Acknowledges the hold until ${sayDate(d.holdUntil, 'month_day')} or asks to keep the space held while this is resolved` },
          { id: 'contract_reflects', text: 'Asks that the draft contract reflect the agreed terms' },
        ],
        prohibited: [
          { id: 'binding_accept', text: 'Accepts the proposal, confirms the block or otherwise commits Acme', det: { type: 'binding_to', party: sales.address } },
          { id: 'stale_value', text: staleText(`Treats the proposal's original ${TERM_LABEL[fixKey]} (${show(fixKey, oldValue)}) as still valid`), stale: true },
          { id: 'reask_answered', text: reaskText('Asks the hotel again for the comp ratio, the deposit, the rate or the meeting-room rental (all answered)', true) },
          { id: 'reask_budget', text: reaskText('Asks finance again to approve the rate cap (already approved)') },
          { id: 'claims_contract', text: 'Says or implies the draft contract has already been received' },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return {
      id: `hotel/cold_handoff/${variant}`,
      vertical: 'hotel',
      archetype: 'cold_handoff',
      variant,
      split: variant === 0 ? 'golden' : variant <= 10 ? 'dev' : 'eval',
      capabilities: cold_handoff.capabilities,
      description: `Composite handoff: ${fixKey} corrected into a requirement violation; approval in another thread; comp/deposit/rental answered; draft contract owed; hold-date nudge.`,
      task: d.task,
      events: mb.sorted(),
      trigger: nudge,
      checkpoints: [checkpoint],
      params: { fixKey, newValue, oldValue, withRevenueIntro, nBackground, nChatter, contractDay, newContractDay, rate: d.rate, cap: d.cap },
    };
  },
};

export { hotel };
