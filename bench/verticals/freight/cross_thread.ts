// Archetype: cross-thread fact (P1).
//
// We ask Acme ops to approve the carrier cost in a budget thread. Ops never replies there: the approval arrives
// in a brand-new thread whose only link to the load is the load number (sometimes just its digits). Meanwhile the
// same carrier quotes a look-alike load (digits swapped, e.g. ACM-58213 vs ACM-58231) and ops approves a LOWER
// ceiling for that one, which would make our quote look over budget if it bled in. Optionally the dispatcher then
// pings for an answer.
//
// Trap: thread-scoped memory never sees the approval; keyword search for "approved" / the carrier's name finds
// the look-alike's numbers. Oracle: the budget from the new thread is current for this load; the look-alike's
// quote and budget are background and appear nowhere in the state; the carrier's quote is within budget and
// meets every requirement, so the right move is to book the truck at the quoted rate.
import type { Archetype, BenchCase, Checkpoint } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, moneyShort, pdf, reaskText, sayDate, seedOf } from '../../core/util.ts';
import {
  budgetAskBody, cur, equipmentTerms, firstName, freight, freightBackground, freightCase, freightChatter, freightDayStart, freightDeal, lookalike, lookalikeRate,
  personName, quoteText, rateConFile, rateConLines, rateTerms, rfqBody, show, signDispatch,
} from './vertical.ts';

export const crossThread: Archetype = {
  id: 'cross_thread',
  title: 'Ops approves the budget in a new thread; a look-alike load must not bleed in',
  capabilities: ['cross_thread'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('freight', 'cross_thread', variant));
    const g = variant === 0;
    const d = freightDeal(r, variant);
    const { self, dispatcher, ops } = d.cast;
    const disp = dispatcher.address;

    // ---- parameters
    const other = lookalike(d.alias);
    const otherRate = lookalikeRate(d);
    const otherBudget = otherRate + 100; // always below our all-in
    const refStyle = g ? 0 : r.int(0, 2);
    const ref = [d.alias, d.alias.slice(4), `load ${d.alias.slice(4)}`][refStyle];
    const Ref = ref[0].toUpperCase() + ref.slice(1);
    const order: 'before' | 'after' = g ? 'after' : r.pick(['before', 'after'] as const);
    const ping = order === 'after' || g || r.chance(0.5);
    const k = g ? 0 : r.int(0, 3);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 3);
    const file = rateConFile(d);

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => freightDayStart(d, day, hhmm);
    const dispName = personName(dispatcher);

    // ---- history
    const rfq = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [disp], at: t(0, '08:00'), subject: `${d.alias} — ${d.lane.origin} to ${d.lane.dest}`, body: rfqBody(r, d, g, dispatcher) });
    mb.add({
      background: true, direction: 'inbound', from: disp, fromName: dispName, to: [self.address], at: t(0, '09:05'), subject: `${other} quote`,
      body: body('Hi,', `For ${other} (Ontario, CA → Las Vegas, NV) I can do ${moneyShort(otherRate)} all-in, pickup ${sayDate(addDays(d.pickupDay, 2), 'weekday_short_date')} 0800-1200. Dry van.`, firstName(dispatcher)),
      note: 'look-alike load, same carrier, different load number',
    });
    const quote = mb.add({
      direction: 'inbound', from: disp, fromName: dispName, to: [self.address], at: t(0, '09:40'), subject: mb.reSubject(rfq), replyTo: rfq,
      body: body('Hi,', quoteText(r, d, g, k), signDispatch(d)),
      attachments: [pdf(file, rateConLines(d, { date: d.start }))],
    });
    const ask = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [ops.address], at: t(0, '09:55'), subject: `Carrier budget approval — ${d.alias}`,
      body: body(`Hi ${firstName(ops)},`, `${d.carrier.company} quoted ${moneyShort(d.allIn)} all-in on ${d.alias}. Can you approve up to ${moneyShort(d.budget)} all-in so I can book?`, 'Thanks,\nAcme Logistics Booking Desk'),
    });
    freightBackground(r, d, mb, t(0, '07:20'), nBackground, { lookalike: false });
    freightChatter(r, d, mb, t(0, '10:10'), nChatter, 15);

    const lookalikeApproval = (hhmm: string) => mb.add({
      background: true, direction: 'inbound', from: ops.address, fromName: personName(ops), to: [self.address], at: t(0, hhmm), subject: `${other} approved`,
      body: body(`${other}: approved up to ${moneyShort(otherBudget)} all-in, don't go over.`, firstName(ops)), note: 'look-alike load approval (lower ceiling)',
    });
    if (order === 'before') lookalikeApproval('12:40');
    const subject = g ? `${d.alias} — approved` : r.pick([`${Ref} — approved`, `RE carrier cost ${ref}`, `OK on ${ref}`, `${Ref} go ahead`]);
    const approval = mb.add({
      direction: 'inbound', from: ops.address, fromName: personName(ops), to: [self.address], at: t(0, '13:15'), subject,
      body: body(g
        ? `Saw your note on ${d.alias}. Approved up to ${moneyShort(d.budget)} all-in — go ahead and book it.`
        : r.pick([
          `Approved up to ${moneyShort(d.budget)} all-in on ${ref}.`,
          `Re ${ref}: you can go to ${moneyShort(d.budget)} all-in. Book it.`,
          `${Ref} is approved, ceiling ${moneyShort(d.budget)} all-in.`,
        ]), firstName(ops)),
      note: 'approval in a new thread, linked only by the load number',
    });
    if (order === 'after') lookalikeApproval('13:40');
    let trigger = approval;
    if (ping) {
      trigger = mb.add({
        direction: 'inbound', from: disp, fromName: dispName, to: [self.address], at: t(0, '14:05'), subject: mb.reSubject(rfq), replyTo: quote,
        body: body(g ? `Do you want the truck on ${d.alias}? I need to know by 3pm or I'll put him on something else.` : r.pick([
          `Any word on ${d.alias}? Need an answer within the hour or the truck goes elsewhere.`,
          `Following up on ${d.alias} — are we booked? I've got other offers for this driver.`,
          `Still holding the truck for ${d.alias}. Can you confirm by 3?`,
        ]), firstName(dispatcher)),
      });
    }

    // ---- oracle
    const checkpoint: Checkpoint = {
      id: 'after_new_thread', after: trigger, now: t(0, ping ? '14:15' : '13:25'),
      state: {
        terms: [
          ...rateTerms(disp, d.linehaul, d.fuel, { lh: [quote], fuel: [quote], all: [quote] }),
          cur(disp, 'pickup.window', d.pickupWin, [quote], true),
          cur(disp, 'delivery.eta', d.appt, [quote], true),
          ...equipmentTerms(d, disp, [quote]),
          cur(disp, 'accessorial.detention_per_hour', d.detention, [quote]),
          cur(disp, 'payment.terms', d.payTerms, [quote]),
          cur(ops.address, 'budget.max_all_in', d.budget, [approval], true),
        ],
        superseded: [],
        open_loops: ping ? [{ kind: 'ask', debtor: self.address, subject: 'decision.tender', display: 'Carrier asks whether we want the truck', evidence: [trigger], critical: true }] : [],
        closed_loops: [
          { kind: 'ask', debtor: ops.address, subject: 'budget.max_all_in', alt_subjects: ['approval.budget'], display: 'Budget approval (given, in a new thread)', evidence: [approval], critical: true },
          { kind: 'ask', debtor: disp, subject: 'rate.all_in', display: 'All-in rate (answered)', evidence: [quote] },
          { kind: 'ask', debtor: disp, subject: 'document.rate_confirmation', display: 'Rate con (received)', evidence: [quote] },
        ],
        conflicts: [],
        documents: [{ filename: file, status: 'current', stale_terms: [], display: `${file}: current` }],
        next_actor: 'us',
      },
      judge_facts: [
        `For ${d.alias}, ${d.carrier.company} quoted ${moneyShort(d.allIn)} all-in, pickup ${show('pickup.window', d.pickupWin)}, delivery ${show('delivery.eta', d.appt)}, ${show('equipment.type', d.equipment)}; this meets every requirement.`,
        `Ops approved up to ${moneyShort(d.budget)} all-in for ${d.alias} in a separate new thread, so the quote is within budget.`,
        `${other} is a different load (same carrier, ${moneyShort(otherRate)} quote, ${moneyShort(otherBudget)} ceiling) and has nothing to do with ${d.alias}.`,
        ping ? 'The carrier is waiting for our answer.' : '',
      ].filter(Boolean).join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'book', text: `Books / confirms ${d.alias} with the carrier at the quoted ${moneyShort(d.allIn)} all-in` },
        ],
        optional: [{ id: 'tell_ops', text: 'Tells ops the load is booked' }],
        prohibited: [
          { id: 'bleed', text: `Uses the ${other} figures (${moneyShort(otherRate)} quote or ${moneyShort(otherBudget)} ceiling) for ${d.alias}, or says the quote is over budget` },
          { id: 'reask_budget', text: reaskText('Asks ops again to approve the budget for this load (already approved)') },
          { id: 'renegotiate', text: 'Asks the carrier to lower the rate because of a budget problem that does not exist' },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return freightCase(crossThread, variant, {
      description: `Budget for ${d.alias} approved in a new thread (ref "${ref}"); look-alike ${other} with a lower ceiling arrives ${order}; ${ping ? 'carrier pings for an answer' : 'no ping'}.`,
      task: d.task, mb, trigger, checkpoints: [checkpoint],
      params: { other, otherRate, otherBudget, refStyle, order, ping, k, nBackground, nChatter, allIn: d.allIn, budget: d.budget },
    });
  },
};

export { freight };
