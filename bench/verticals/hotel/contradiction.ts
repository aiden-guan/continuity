// Archetype: contradiction within one counterparty group (P1).
//
// The group sales manager quotes terms and starts drafting the contract. The hotel's director of
// revenue (same hotel, same authority) writes separately with a different value for one term: a higher
// rate, a tighter attrition allowance, or an earlier cutoff. In half the variants the sales manager
// writes last, re-confirming her own value without acknowledging the revenue manager; in the others the
// revenue manager writes last.
//
// Trap: "newest wins" picks whichever message came last, but neither person retracted anything and
// neither message references the other: inside one group a later statement is not more true. The
// oracle: the term is contested with both values (each keyed to its speaker), nothing is superseded,
// the conflict is a contradiction, and the right move is to ask the hotel to reconcile before
// contracting. Both values meet Acme's requirements, so this is not a requirement violation.
import type { Archetype, BenchCase, Checkpoint, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, moneyShort, nextWeekday, sayDate, seedOf } from '../../core/util.ts';
import {
  AGENT_SIGN, TERM_LABEL, addParty, blockProse, dayOf, firstName, hotel, hotelBackground, hotelChatter, hotelDayStart, hotelDeal, pct, plainName,
  rfpBody, show, signoff, term,
} from './vertical.ts';

type Key = 'rate.group' | 'attrition.allowance' | 'cutoff.date';

export const contradiction: Archetype = {
  id: 'contradiction',
  title: 'Sales manager and revenue manager state different terms',
  capabilities: ['conflict_vs_supersession'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('hotel', 'contradiction', variant));
    const g = variant === 0;
    const d = hotelDeal(r, variant);
    const { self, sales, revenue } = d.cast;
    addParty(d, revenue);
    const sf = firstName(sales);

    // ---- parameters: both values must satisfy Acme's requirements (a contradiction, not a violation)
    const options: Key[] = ['rate.group'];
    if (d.attrition - 5 >= d.minAttrition) options.push('attrition.allowance');
    if (addDays(d.cutoff, -7) >= d.notBefore) options.push('cutoff.date');
    const key: Key = g ? 'rate.group' : r.pick(options);
    const delta = Math.min(g ? 20 : r.pick([10, 15, 20]), d.cap - d.rate);
    const salesValue: unknown = key === 'rate.group' ? d.rate : key === 'attrition.allowance' ? d.attrition : d.cutoff;
    const revValue: unknown = key === 'rate.group' ? d.rate + delta : key === 'attrition.allowance' ? d.attrition - 5 : addDays(d.cutoff, -7);
    const salesLast = g ? false : r.chance(0.5);
    const style = g ? 0 : r.int(0, 2);
    const nBackground = g ? 2 : r.int(2, 7);
    const nChatter = g ? 0 : r.int(0, 3);
    const contractDay = nextWeekday(dayOf(d, 2), 5);

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => hotelDayStart(d, day, hhmm);
    const say = (k: Key, v: unknown) => (k === 'rate.group' ? `${moneyShort(v as number)} per night` : k === 'attrition.allowance' ? `${pct(v as number)} attrition` : `a cutoff of ${sayDate(v as string, 'long')}`);

    // ---- history
    const rfp = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(0, '09:00'), subject: `Group RFP: ${d.event} — ${d.alias}`, body: rfpBody(r, d, g) });
    const quote = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(0, '15:00'), subject: mb.reSubject(rfp), replyTo: rfp,
      body: body('Hi,', g
        ? `Thanks for thinking of us for ${d.event}! We can offer ${blockProse(d.block, 0)} at ${moneyShort(d.rate)} per night, including breakfast. Attrition is ${pct(d.attrition)}, cutoff ${sayDate(d.cutoff, 'long')}, and the F&B minimum is ${moneyShort(d.fnb)}.`
        : r.pick([
          `We'd love to host you. Terms: ${blockProse(d.block, r.int(0, 2))}; rate ${moneyShort(d.rate)}/night; attrition ${pct(d.attrition)}; cutoff ${sayDate(d.cutoff, 'month_day')}; F&B minimum ${moneyShort(d.fnb)}.`,
          `Your dates work. Group rate ${moneyShort(d.rate)}, ${pct(d.attrition)} attrition, reservations due by ${sayDate(d.cutoff, 'long')}, F&B minimum ${moneyShort(d.fnb)}. Block: ${blockProse(d.block, r.int(0, 2))}.`,
          `Here's what I can offer for ${d.alias}: ${moneyShort(d.rate)} per room-night for ${blockProse(d.block, r.int(0, 2))}, attrition ${pct(d.attrition)}, cutoff ${sayDate(d.cutoff, 'weekday_long')}, F&B minimum ${moneyShort(d.fnb)}.`,
        ]), signoff(sales, d.hotel.name)),
    });
    hotelBackground(r, d, mb, t(0, '10:00'), nBackground);
    const go = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(1, '10:00'), subject: mb.reSubject(rfp), replyTo: quote,
      body: body(`Hi ${sf},`, r.pick(['Those terms work for us. Please send the contract.', `Great, we'd like to proceed. Could you draft the contract for ${d.alias}?`, 'Looks good. Next step is the contract, please.']), AGENT_SIGN),
    });
    hotelChatter(r, d, mb, t(1, '11:00'), nChatter);

    const salesMsg = (at: string, replyTo: string) => mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at, subject: mb.reSubject(rfp), replyTo,
      body: body('Hi,', [
        `Wonderful! I'm drafting the contract now: ${say(key, salesValue)}, as quoted. You'll have it by ${sayDate(contractDay, 'weekday')}.`,
        `Great news. The contract will go out by ${sayDate(contractDay, 'weekday')} with ${say(key, salesValue)} as we discussed.`,
        `Thanks! Contract coming by ${sayDate(contractDay, 'weekday')}; confirming ${say(key, salesValue)}.`,
      ][style], signoff(sales, d.hotel.name)),
    });
    const revMsg = (at: string) => mb.add({
      direction: 'inbound', from: revenue.address, fromName: plainName(revenue), to: [self.address], at, subject: `${d.alias} — group terms`,
      body: body('Hello,', [
        `I'm the director of revenue at ${d.hotel.name} and I review every group before contracting. For ${d.event} the ${TERM_LABEL[key]} we can offer is ${show(key, revValue)}${key === 'rate.group' ? ' per night' : ''}, given the demand we're seeing for those dates.`,
        `Revenue here. Just so expectations are clear for ${d.alias}: on these dates we would need ${say(key, revValue)}.`,
        `Writing in on group ${d.alias}: our position for these dates is ${say(key, revValue)}. Happy to discuss.`,
      ][style], signoff(revenue, d.hotel.name)),
    });
    let sMsg: string, rMsg: string;
    if (salesLast) { rMsg = revMsg(t(2, '09:30')); sMsg = salesMsg(t(2, '14:10'), go); }
    else { sMsg = salesMsg(t(1, '16:20'), go); rMsg = revMsg(t(2, '11:05')); }
    const trigger = salesLast ? sMsg : rMsg;

    // ---- oracle
    const contested: OracleTerm = {
      party: sales.address, term: key, status: 'contested', evidence: [quote, sMsg, rMsg], critical: true,
      contested: [
        { party: sales.address, value: salesValue, evidence: [quote, sMsg] },
        { party: revenue.address, value: revValue, evidence: [rMsg] },
      ],
      display: `${show(key, salesValue)} (sales manager) vs ${show(key, revValue)} (director of revenue)`,
    };
    const others: OracleTerm[] = [
      key === 'rate.group' ? null : term(sales, 'rate.group', d.rate, [quote], true),
      term(sales, 'block.rooms', d.block, [quote], true),
      key === 'attrition.allowance' ? null : term(sales, 'attrition.allowance', d.attrition, [quote]),
      key === 'cutoff.date' ? null : term(sales, 'cutoff.date', d.cutoff, [quote]),
      term(sales, 'fnb.minimum', d.fnb, [quote]),
    ].filter((x): x is OracleTerm => x !== null);
    const checkpoint: Checkpoint = {
      id: 'after_contradiction', after: trigger, now: salesLast ? t(2, '14:30') : t(2, '11:30'),
      state: {
        terms: [contested, ...others],
        superseded: [],
        open_loops: [
          { kind: 'commitment', debtor: sales.address, subject: 'document.contract', display: `Hotel owes the contract (promised by ${sayDate(contractDay, 'weekday_short_date')})`, evidence: [sMsg] },
        ],
        closed_loops: [
          { kind: 'ask', debtor: sales.address, subject: 'rate.group', display: 'Group rate (answered)', evidence: [quote] },
          { kind: 'ask', debtor: sales.address, subject: 'block.rooms', display: 'Availability (answered)', evidence: [quote] },
        ],
        conflicts: [
          { kind: 'contradiction', term: key, party: sales.address, display: `${plainName(sales)} says ${show(key, salesValue)}; ${plainName(revenue)} (same hotel) says ${show(key, revValue)}`, critical: true },
        ],
        documents: [],
        next_actor: 'us',
      },
      judge_facts: [
        `Two people at ${d.hotel.name} gave different ${TERM_LABEL[key]}s: the sales manager ${show(key, salesValue)} (quoted and re-confirmed for the contract), the director of revenue ${show(key, revValue)}.`,
        `Neither message retracts or references the other, so neither value is settled; the ${salesLast ? 'sales manager' : 'revenue manager'} simply wrote last.`,
        'Both values would meet Acme requirements. The contract has not arrived yet.',
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'reconcile', text: `Points out to the hotel that the sales manager said ${show(key, salesValue)} and the director of revenue said ${show(key, revValue)}, and asks which applies before the contract is issued` },
        ],
        optional: [
          { id: 'to_sales', text: 'Writes to the sales manager (the main contact)', det: { type: 'message_to', party: sales.address } },
          { id: 'cc_revenue', text: 'Includes the director of revenue', det: { type: 'message_to', party: revenue.address } },
          { id: 'prefer_quoted', text: `Notes that Acme expects the quoted ${show(key, salesValue)} to be honoured` },
        ],
        prohibited: [
          { id: 'binding', text: 'Accepts either value or confirms the booking before the discrepancy is resolved', det: { type: 'binding_to', party: sales.address } },
          { id: 'newest_wins', text: `Treats ${show(key, salesLast ? salesValue : revValue)} as settled just because it came last, ignoring the other value` },
          { id: 'silent_switch', text: `Assumes the ${show(key, revValue)} from revenue replaced the quote without asking` },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return {
      id: `hotel/contradiction/${variant}`,
      vertical: 'hotel',
      archetype: 'contradiction',
      variant,
      split: variant === 0 ? 'golden' : variant <= 10 ? 'dev' : 'eval',
      capabilities: contradiction.capabilities,
      description: `Sales says ${key} = ${show(key, salesValue)}; revenue says ${show(key, revValue)}; ${salesLast ? 'sales' : 'revenue'} writes last.`,
      task: d.task,
      events: mb.sorted(),
      trigger,
      checkpoints: [checkpoint],
      params: { key, salesValue, revValue, salesLast, style, nBackground, nChatter },
    };
  },
};

export { hotel };
