// Archetype: correction / supersession (P0). Mirrors the procurement reference.
//
// The carrier dispatcher quotes the load with a rate con (pickup window, delivery, rate, equipment), Acme ops
// approves the carrier budget in a separate thread, then the dispatcher corrects ONE term: either the pickup
// window (the truck can't be empty in time, so it now arrives after the shipper's loading window closes) or the
// delivery ETA (driver's hours: it now misses the receiver's appointment). The rate is unchanged and a corrected
// rate con is promised.
//
// Trap: a running summary keeps the original window/ETA ("truck at 6am"), a latest-email reader loses the rate,
// the budget (other thread) and the equipment, and "newest wins" on documents marks the whole rate con dead.
// Oracle: the corrected value is current and the original is superseded; rate, equipment, detention, terms stay
// current; the rate con is stale on the corrected term only; the corrected rate con is an open commitment; and the
// corrected value breaks a hard requirement, so we must not book and must raise it with the carrier.
import type { Archetype, BenchCase, Checkpoint } from '../../core/types.ts';
import { MailBuilder, Rand, addBusinessDays, addDays, body, moneyShort, pdf, reaskText, seedOf, staleText } from '../../core/util.ts';
import {
  approvalBody, budgetAskBody, cur, dead, dt, dayOf, equipmentTerms, firstName, freight, freightBackground, freightCase, freightChatter, freightDayStart,
  freightDeal, hh, hourOf, personName, quoteText, rateConFile, rateConLines, rateTerms, rfqBody, sayDT, sayWin, show, signDispatch, win,
} from './vertical.ts';

export const correction: Archetype = {
  id: 'correction',
  title: 'Carrier corrects the pickup window or delivery ETA',
  capabilities: ['supersession', 'document_validity', 'cross_thread', 'open_loops', 'cold_handoff'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('freight', 'correction', variant));
    const g = variant === 0;
    const d = freightDeal(r, variant);
    const { self, dispatcher, ops } = d.cast;
    const first = firstName(dispatcher);

    // ---- parameters
    const kind: 'pickup' | 'delivery' = g ? 'pickup' : r.pick(['pickup', 'delivery'] as const);
    const k = g ? 0 : r.int(0, 3); // wording style for windows / datetimes
    const reqEnd = hourOf(d.reqPickup.end);
    const newStart = reqEnd + (g ? 1 : r.pick([1, 2]));
    const newWin = win(d.pickupDay, hh(newStart), hh(newStart + 4)); // starts when (or after) the shipper closes
    const apptH = hourOf(d.appt);
    const lateH = apptH + (g ? 5 : r.pick([4, 5, 6]));
    const newEta = lateH <= 17 ? dt(d.deliveryDay, hh(lateH)) : dt(addBusinessDays(d.deliveryDay, 1), '08:00');
    const style = g ? 0 : r.int(0, 3);
    const restatesRate = g ? true : r.chance(0.6);
    const restatesOther = g ? true : r.chance(0.5);
    const due = g ? 'tonight' : r.pick(['tonight', 'first thing tomorrow', 'within the hour', '']);
    const nBackground = g ? 2 : r.int(2, 7);
    const nChatter = g ? 0 : r.int(0, 3);
    const file = rateConFile(d);
    const pOff = Math.round((Date.parse(d.pickupDay) - Date.parse(d.start)) / 86_400_000);

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => freightDayStart(d, day, hhmm);

    // ---- history
    const rfq = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [dispatcher.address], at: t(0, '08:10'), subject: `${d.alias} — ${d.lane.origin} to ${d.lane.dest}`, body: rfqBody(r, d, g, dispatcher) });
    const ask = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ops.address], at: t(0, '08:14'), subject: `Carrier budget approval — ${d.alias}`, body: budgetAskBody(r, d, g) });
    const offer = mb.add({
      direction: 'inbound', from: dispatcher.address, fromName: personName(dispatcher), to: [self.address], at: t(0, '10:40'), subject: mb.reSubject(rfq), replyTo: rfq,
      body: body(g ? 'Hi,' : r.pick(['Hi,', 'Hello,', `Hey there,`]), quoteText(r, d, g, k), signDispatch(d)),
      attachments: [pdf(file, rateConLines(d, { date: d.start }))],
    });
    const approval = mb.add({ direction: 'inbound', from: ops.address, fromName: personName(ops), to: [self.address], at: t(0, '13:55'), subject: mb.reSubject(ask), replyTo: ask, body: approvalBody(r, d, g) });
    freightBackground(r, d, mb, t(0, '11:05'), nBackground);
    freightChatter(r, d, mb, t(0, '14:10'), nChatter);

    const was = sayWin(d.pickupWin, k);
    const now = sayWin(newWin, k);
    const pickupText = [
      `Correction on ${d.alias}: my driver is still getting unloaded in ${d.lane.near} and won't make the ${was} pickup. Realistically he'll be at the shipper ${now}.`,
      `I need to correct my earlier email — the truck I had for ${d.alias} won't be empty in time. Pickup will be ${now}, not ${was}.`,
      `Sorry, update on ${d.alias}: pickup has to move to ${now}. My driver is on his 10-hour break until then.`,
      `Revision on ${d.alias}: we can't load in the morning after all. Earliest the truck can be there is ${now}.`,
    ][style];
    const deliveryText = [
      `Correction on ${d.alias}: with the hours my driver has left he can't make the ${sayDT(d.appt, k)} appointment. Best ETA at the receiver is ${sayDT(newEta, k)}.`,
      `I have to correct my ETA on ${d.alias} — delivery will be ${sayDT(newEta, k)}, not ${sayDT(d.appt, k)}.`,
      `Heads up on ${d.alias}: the ${sayDT(d.appt, k)} delivery isn't doable with his reset. He'll deliver ${sayDT(newEta, k)}.`,
      `Revising our delivery commitment on ${d.alias}: ${sayDT(newEta, k)} at the receiver.`,
    ][style];
    const otherText = kind === 'pickup' ? `He'll still make the ${sayDT(d.appt, k)} delivery.` : 'Pickup time is unchanged.';
    const fix = mb.add({
      direction: 'inbound', from: dispatcher.address, fromName: personName(dispatcher), to: [self.address], at: t(pOff - 1, '17:20'), subject: mb.reSubject(rfq), replyTo: offer,
      body: body(g ? 'Hi again,' : 'Hi,', kind === 'pickup' ? pickupText : deliveryText, restatesOther ? otherText : null,
        `${restatesRate ? r.pick(['Rate stays the same. ', 'No change to the rate. ', 'Rate is unchanged. ']) : ''}I'll send a corrected rate con${due ? ` ${due}` : ''}.`,
        g ? 'Sorry about that,\nCarla' : first),
    });

    // ---- oracle
    const term = kind === 'pickup' ? 'pickup.window' : 'delivery.eta';
    const oldValue = kind === 'pickup' ? d.pickupWin : d.appt;
    const newValue = kind === 'pickup' ? newWin : newEta;
    const violation = kind === 'pickup'
      ? `Truck now arrives ${show('pickup.window', newWin)}, after the shipper's loading window (${sayWin(d.reqPickup)}) closes`
      : `Delivery now ${show('delivery.eta', newEta)}, after the ${sayDT(d.appt)} appointment`;
    const checkpoint: Checkpoint = {
      id: 'after_correction', after: fix, now: t(pOff - 1, '17:40'),
      state: {
        terms: [
          ...rateTerms(dispatcher.address, d.linehaul, d.fuel, { lh: [offer], fuel: [offer], all: restatesRate ? [offer, fix] : [offer] }),
          cur(dispatcher.address, 'pickup.window', kind === 'pickup' ? newWin : d.pickupWin, kind === 'pickup' ? [fix] : restatesOther ? [offer, fix] : [offer], true),
          cur(dispatcher.address, 'delivery.eta', kind === 'delivery' ? newEta : d.appt, kind === 'delivery' ? [fix] : restatesOther ? [offer, fix] : [offer], true),
          ...equipmentTerms(d, dispatcher.address, [offer]),
          cur(dispatcher.address, 'accessorial.detention_per_hour', d.detention, [offer]),
          cur(dispatcher.address, 'payment.terms', d.payTerms, [offer]),
          cur(ops.address, 'budget.max_all_in', d.budget, [approval], true),
        ],
        superseded: [dead(dispatcher.address, term, oldValue, [offer], fix)],
        open_loops: [
          { kind: 'commitment', debtor: dispatcher.address, subject: 'document.rate_confirmation', display: 'Carrier owes a corrected rate con', evidence: [fix], critical: true },
        ],
        closed_loops: [
          { kind: 'ask', debtor: dispatcher.address, subject: 'rate.all_in', display: 'All-in rate (answered)', evidence: [offer] },
          { kind: 'ask', debtor: dispatcher.address, subject: 'pickup.window', alt_subjects: ['delivery.eta'], display: 'Can the truck make the pickup and delivery times (answered)', evidence: [offer] },
          { kind: 'ask', debtor: dispatcher.address, subject: 'document.rate_confirmation', display: 'Rate con (received)', evidence: [offer] },
          { kind: 'ask', debtor: ops.address, subject: 'budget.max_all_in', alt_subjects: ['approval.budget'], display: 'Budget approval (given)', evidence: [approval] },
        ],
        conflicts: [{ kind: 'requirement_violation', term, party: dispatcher.address, display: violation, critical: true }],
        documents: [{ filename: file, status: 'partially_stale', stale_terms: [term], display: `${file}: ${kind === 'pickup' ? 'pickup window' : 'delivery time'} superseded; rate, equipment and the rest still current` }],
        next_actor: 'us',
      },
      judge_facts: [
        `Current carrier terms: ${moneyShort(d.allIn)} all-in (unchanged); pickup ${show('pickup.window', kind === 'pickup' ? newWin : d.pickupWin)}; delivery ${show('delivery.eta', kind === 'delivery' ? newEta : d.appt)}.`,
        `The carrier's original ${kind === 'pickup' ? `pickup window ${show('pickup.window', d.pickupWin)}` : `delivery ${show('delivery.eta', d.appt)}`} was corrected and is no longer valid.`,
        kind === 'pickup'
          ? `The shipper only loads ${sayWin(d.reqPickup)}, so the new pickup window misses a hard requirement.`
          : `The receiver's appointment is ${sayDT(d.appt)}, so the new ETA misses a hard requirement.`,
        `Ops already approved up to ${moneyShort(d.budget)} all-in. The carrier promised a corrected rate con that has NOT arrived yet. The load is not booked.`,
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_carrier', text: 'Sends a message to the carrier dispatcher', det: { type: 'message_to', party: dispatcher.address } },
          {
            id: 'raise_conflict',
            text: kind === 'pickup'
              ? `Tells the carrier that a ${show('pickup.window', newWin)} arrival misses the shipper's loading window (${sayWin(d.reqPickup)}) and asks whether they can still make it or need to be replaced`
              : `Tells the carrier that delivering ${show('delivery.eta', newEta)} misses the ${sayDT(d.appt)} appointment and asks whether they can make it (or for a fix)`,
          },
        ],
        optional: [{ id: 'mention_ratecon', text: 'Mentions that the corrected rate con is still expected' }],
        prohibited: [
          { id: 'binding_book', text: 'Books or confirms the load with the carrier', det: { type: 'binding_to', party: dispatcher.address } },
          { id: 'stale_value', text: staleText(`Treats the original ${kind === 'pickup' ? `pickup window (${show('pickup.window', d.pickupWin)})` : `delivery time (${show('delivery.eta', d.appt)})`} as still valid`), stale: true },
          { id: 'reask_rate', text: reaskText(`Asks the carrier again for the rate (already known: ${moneyShort(d.allIn)} all-in, unchanged)`, true) },
          { id: 'reask_budget', text: reaskText('Asks ops again to approve the budget (already approved)') },
          { id: 'claims_ratecon', text: 'Says or implies the corrected rate con has already been received' },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return freightCase(correction, variant, {
      description: `Carrier corrects ${kind === 'pickup' ? `pickup to ${show('pickup.window', newWin)} (after the shipper's window)` : `delivery to ${show('delivery.eta', newEta)} (after the appointment)`}; rate unchanged; budget approved in a separate thread; corrected rate con owed.`,
      task: d.task, mb, trigger: fix, checkpoints: [checkpoint],
      params: { kind, k, style, newWin, newEta, restatesRate, restatesOther, due, nBackground, nChatter, allIn: d.allIn, budget: d.budget, pickupWin: d.pickupWin, reqPickup: d.reqPickup, appt: d.appt, dayOf: dayOf(d.appt) },
    });
  },
};

export { freight };
