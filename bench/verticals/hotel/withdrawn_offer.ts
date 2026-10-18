// Archetype: withdrawn offer (P1).
//
// The hotel proposes (PDF, space on first option), finance approves, and sometimes we already asked for
// the contract. Then the hotel releases the space: a group with a definite contract took the dates, a
// citywide absorbed the inventory, or the owners scheduled a renovation. Sometimes the sales manager
// offers to quote other dates (no terms given).
//
// Trap: "latest value per term" still reports the proposal's rate and block as current because no
// message replaced them; an agent pushing to "move forward" accepts a dead offer. The oracle: every
// proposal term is absent (history only, listed as superseded by the withdrawal), offer.status is
// withdrawn, the conflict is offer_unavailable, the proposal document is withdrawn, our contract request
// is moot (closed), and the budget approval is still valid. Accepting the old proposal is a stale
// violation.
import type { Archetype, BenchCase, Checkpoint, OracleLoop, OracleSuperseded, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, moneyShort, pdf, sayDate, seedOf, staleText } from '../../core/util.ts';
import {
  AGENT_SIGN, approvalBody, blockDisplay, budgetAsk, firstName, hotel, hotelBackground, hotelChatter, hotelDayStart, hotelDeal, plainName,
  proposalBody, proposalLines, rfpBody, show, signoff, term,
} from './vertical.ts';

export const withdrawn_offer: Archetype = {
  id: 'withdrawn_offer',
  title: 'Hotel releases the space',
  capabilities: ['lifecycle', 'document_validity'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('hotel', 'withdrawn_offer', variant));
    const g = variant === 0;
    const d = hotelDeal(r, variant);
    const { self, sales, finance } = d.cast;
    const sf = firstName(sales);

    // ---- parameters
    const reason = g ? 0 : r.int(0, 2);
    const askedContract = g ? true : r.chance(0.7);
    const offersOtherDates = g ? true : r.chance(0.5);
    const style = g ? 0 : r.int(0, 2);
    const nBackground = g ? 2 : r.int(2, 7);
    const nChatter = g ? 1 : r.int(0, 3);
    const proposalFile = `${d.hotel.short.replace(/\s+/g, '')}-Proposal-${d.proposalRef}.pdf`;
    const altWeek = addDays(d.arrival, 14);

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => hotelDayStart(d, day, hhmm);

    // ---- history
    const rfp = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(0, '09:00'), subject: `Group RFP: ${d.event} — ${d.alias}`, body: rfpBody(r, d, g) });
    const ask = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [finance.address], at: t(0, '09:03'), subject: `Budget approval — ${d.alias} hotel block`, body: budgetAsk(r, d, g) });
    const offer = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(0, '14:45'), subject: mb.reSubject(rfp), replyTo: rfp,
      body: proposalBody(r, d, g), attachments: [pdf(proposalFile, proposalLines(d, { date: d.start }))],
    });
    hotelBackground(r, d, mb, t(0, '10:00'), nBackground);
    const approval = mb.add({ direction: 'inbound', from: finance.address, fromName: plainName(finance), to: [self.address], at: t(1, '09:40'), subject: mb.reSubject(ask), replyTo: ask, body: approvalBody(r, d, g) });
    hotelChatter(r, d, mb, t(1, '11:00'), nChatter);
    let contractAsk: string | null = null;
    if (askedContract) {
      contractAsk = mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(1, '15:10'), subject: mb.reSubject(rfp), replyTo: offer,
        body: body(`Hi ${sf},`, g
          ? `Good news: we have internal approval. Please send the contract for ${d.alias} and we'll get it signed.`
          : r.pick([
            `We're ready to proceed with ${d.hotel.short}. Could you send the group contract?`,
            `Approval is in on our side. Please draft the contract for ${d.alias}.`,
            `Let's move to contract. Can you send it over for ${d.alias}?`,
          ]), AGENT_SIGN),
      });
    }

    const reasonText = [
      `a group with a definite contract for overlapping dates was approved by our general manager this morning, before we could convert your option`,
      `a citywide convention has absorbed our remaining inventory for ${sayDate(d.arrival, 'month_day')}-${sayDate(d.departure, 'month_day')}, and revenue has closed those dates to new groups`,
      `our ownership has scheduled a renovation of the meeting level for those weeks, so we can't host groups then`,
    ][reason];
    const withdrawText = [
      `I'm so sorry to tell you this, but we have to release the space we were holding for ${d.alias}: ${reasonText}. We can no longer offer the block or the rates in our proposal.`,
      `Unfortunately ${reasonText}. That means the proposal for ${d.event} is withdrawn; the dates are no longer available.`,
      `Bad news on ${d.alias}, I'm afraid. ${reasonText[0].toUpperCase()}${reasonText.slice(1)}, and we are no longer able to offer your dates. Please disregard our proposal.`,
    ][style];
    const wd = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(2, '10:05'), subject: mb.reSubject(rfp), replyTo: contractAsk ?? offer,
      body: body('Hi,', withdrawText,
        offersOtherDates ? `If your group could move to the week of ${sayDate(altWeek, 'month_day')}, I'd be glad to put together a new proposal.` : null,
        g ? `Again, my apologies.\n${sf}` : signoff(sales, d.hotel.name)),
    });

    // ---- oracle
    const old: [string, unknown][] = [
      ['rate.group', d.rate], ['block.rooms', d.block], ['attrition.allowance', d.attrition], ['cutoff.date', d.cutoff], ['fnb.minimum', d.fnb], ['meeting.room_rental', d.meeting],
    ];
    const absent: OracleTerm[] = old.map(([k]) => ({ party: sales.address, term: k, status: 'absent', evidence: [offer], critical: k === 'rate.group' || k === 'block.rooms', display: `${k}: no longer offered (proposal withdrawn)` }));
    const superseded: OracleSuperseded[] = old.map(([k, v]) => ({ party: sales.address, term: k, value: v, display: show(k, v), evidence: [offer], superseded_by: wd }));
    const closed: OracleLoop[] = [
      { kind: 'ask', debtor: sales.address, subject: 'document.proposal', display: 'Proposal (received, since withdrawn)', evidence: [offer] },
      { kind: 'ask', debtor: finance.address, subject: 'budget.max_rate', alt_subjects: ['approval.budget'], display: 'Budget approval (given)', evidence: [approval] },
    ];
    if (contractAsk) closed.push({ kind: 'ask', debtor: sales.address, subject: 'document.contract', display: 'Contract request (moot: the hotel withdrew)', evidence: [contractAsk, wd] });
    const checkpoint: Checkpoint = {
      id: 'after_withdrawal', after: wd, now: t(2, '10:30'),
      state: {
        terms: [
          ...absent,
          term(sales, 'offer.status', 'withdrawn', [wd], true),
          term(finance, 'budget.max_rate', d.cap, [approval]),
        ],
        superseded,
        open_loops: [],
        closed_loops: closed,
        conflicts: [
          { kind: 'offer_unavailable', term: 'offer.status', party: sales.address, display: `${d.hotel.name} released the space; the proposal (${moneyShort(d.rate)}/night, ${blockDisplay(d.block)}) is no longer available`, critical: true },
        ],
        documents: [
          { filename: proposalFile, status: 'withdrawn', stale_terms: [], display: `${proposalFile}: withdrawn by the hotel` },
        ],
        next_actor: 'us',
      },
      judge_facts: [
        `${d.hotel.name} withdrew its proposal for ${d.alias}: the dates are no longer available and its rate (${moneyShort(d.rate)}/night) and block are no longer on offer.`,
        offersOtherDates ? `The hotel offered to quote the week of ${sayDate(altWeek, 'month_day')} instead, but has given no terms for it.` : 'The hotel offered no alternative.',
        `Finance's approval of up to ${moneyShort(d.cap)}/night still stands. ${contractAsk ? 'Our earlier request for the contract is moot.' : ''}`,
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_sales', text: 'Sends a message to the hotel sales manager', det: { type: 'message_to', party: sales.address } },
          { id: 'ack_withdrawal', text: 'Acknowledges that the hotel can no longer offer the block and asks about alternatives (other dates, a sister property) or says Acme will look elsewhere' },
        ],
        optional: [
          { id: 'tell_finance', text: 'Lets finance know the hotel withdrew' },
        ],
        prohibited: [
          { id: 'binding_accept', text: staleText('Accepts, signs or tries to confirm the withdrawn proposal'), det: { type: 'binding_to', party: sales.address }, stale: true },
          { id: 'stale_terms', text: staleText(`Treats the withdrawn ${moneyShort(d.rate)}/night rate or the proposed block as still available`), stale: true },
          { id: 'chase_contract', text: staleText('Asks the hotel again to send the contract for the original dates'), stale: true },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return {
      id: `hotel/withdrawn_offer/${variant}`,
      vertical: 'hotel',
      archetype: 'withdrawn_offer',
      variant,
      split: variant === 0 ? 'golden' : variant <= 10 ? 'dev' : 'eval',
      capabilities: withdrawn_offer.capabilities,
      description: `Hotel withdraws its proposal (reason ${reason})${askedContract ? ' after we asked for the contract' : ''}; budget approval stands.`,
      task: d.task,
      events: mb.sorted(),
      trigger: wd,
      checkpoints: [checkpoint],
      params: { reason, askedContract, offersOtherDates, style, nBackground, nChatter, rate: d.rate, cap: d.cap },
    };
  },
};

export { hotel };
