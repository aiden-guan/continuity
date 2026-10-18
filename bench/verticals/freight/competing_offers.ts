// Archetype: competing offers (P1).
//
// We send the load to two independent carriers. Both quote. The cheaper one fails a hard requirement — it can
// only load the next day (outside the shipper's window), it would deliver after the receiver's appointment, or
// (for a reefer load) it only has a dry van. The other is a bit more expensive, within the maximum all-in and
// compliant on everything. Which carrier is which, and which quote arrives last, varies.
//
// Trap: "newest wins" or "cheapest wins" picks the wrong truck; a single-counterparty model merges the two quotes
// into one contradictory carrier. Oracle: both quotes are current, keyed by carrier (no contradiction, nothing
// superseded); the cheaper carrier has a requirement violation; the right action is to book the compliant carrier
// and never bind the non-compliant one.
import type { Archetype, BenchCase, BenchParty, Checkpoint, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addBusinessDays, body, moneyShort, pdf, seedOf } from '../../core/util.ts';
import {
  cur, dayOf, dt, eqLabel, eqWords, firstName, freight, freightBackground, freightCase, freightChatter, freightDayStart, freightDeal, hh, hourOf, personName,
  quoteText, rateConLines, rfqBody, sayDT, sayTemp, sayWin, show, type Equipment, type FreightDeal, type Win, timeOf, withParties,
  poss,
} from './vertical.ts';

type Gap = 'pickup' | 'delivery' | 'equipment';

export const competingOffers: Archetype = {
  id: 'competing_offers',
  title: 'Two carriers quote; the cheaper one fails a requirement',
  capabilities: ['competing_offers'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('freight', 'competing_offers', variant));
    const g = variant === 0;
    const d = freightDeal(r, variant);
    const { self, dispatcher, carrier2 } = d.cast;

    // ---- parameters
    const gap: Gap = g ? 'pickup' : r.pick(d.equipment === 'reefer' ? ['pickup', 'delivery', 'equipment'] as const : ['pickup', 'delivery'] as const);
    const compliantIsA = g ? true : r.chance(0.5);
    const lastIsCheap = g ? true : r.chance(0.6);
    const discount = g ? 220 : r.pick([150, 200, 250, 300]);
    const k = g ? 0 : r.int(0, 3);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 2);
    const good: BenchParty = compliantIsA ? dispatcher : carrier2;
    const cheap: BenchParty = compliantIsA ? carrier2 : dispatcher;
    const goodCo = compliantIsA ? d.carrier : d.carrier2;
    const cheapCo = compliantIsA ? d.carrier2 : d.carrier;
    // a view of the deal as quoted by the compliant carrier (for its rate con and sign-off)
    const dGood: FreightDeal = { ...d, carrier: goodCo, cast: { ...d.cast, dispatcher: good } };
    const file = `${goodCo.short}-RateCon-${d.alias}.pdf`;

    const cheapLh = d.linehaul - discount;
    const cheapAll = cheapLh + d.fuel;
    const nextBd = addBusinessDays(d.pickupDay, 1);
    const cheapWin: Win = gap === 'pickup' ? { start: dt(nextBd, timeOf(d.pickupWin.start)), end: dt(nextBd, timeOf(d.pickupWin.end)) } : d.pickupWin;
    const lateH = hourOf(d.appt) + (g ? 5 : r.pick([4, 5, 6]));
    const cheapEta = gap === 'pickup' ? dt(addBusinessDays(d.deliveryDay, 1), timeOf(d.appt))
      : gap === 'delivery' ? (lateH <= 17 ? dt(d.deliveryDay, hh(lateH)) : dt(addBusinessDays(d.deliveryDay, 1), '08:00')) : d.appt;
    const cheapEq: Equipment = gap === 'equipment' ? 'dry_van' : d.equipment;

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => freightDayStart(d, day, hhmm);

    // ---- history
    const rfqA = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [dispatcher.address], at: t(0, '08:00'), subject: `${d.alias} — ${d.lane.origin} to ${d.lane.dest}`, body: rfqBody(r, d, g, dispatcher) });
    const rfqB = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [carrier2.address], at: t(0, '08:03'), subject: `${d.alias} — ${d.lane.origin} to ${d.lane.dest}`, body: rfqBody(r, d, g, carrier2) });
    freightBackground(r, d, mb, t(0, '06:20'), nBackground);
    freightChatter(r, d, mb, t(0, '08:30'), nChatter, 15);

    const sign = (p: BenchParty, co: typeof goodCo) => `${personName(p)}\n${co.company} | Dispatch\nMC ${co.mc}`;
    const addGood = (hhmm: string) => mb.add({
      direction: 'inbound', from: good.address, fromName: personName(good), to: [self.address], at: t(0, hhmm), subject: mb.reSubject(compliantIsA ? rfqA : rfqB), replyTo: compliantIsA ? rfqA : rfqB,
      body: body('Hi,', quoteText(r, dGood, g, k), sign(good, goodCo)), attachments: [pdf(file, rateConLines(dGood, { date: d.start }))],
    });
    const cheapStyle = g ? 0 : r.int(0, 1);
    const cheapText: Record<Gap, string[]> = {
      pickup: [
        g
          ? `I can do it for ${moneyShort(cheapAll)} all-in (${moneyShort(cheapLh)} + ${moneyShort(d.fuel)} fuel), but my truck can't get there until ${sayWin(cheapWin, 0)}. Delivery would be ${sayDT(cheapEta, 0)}.`
          : `${moneyShort(cheapAll)} all-in. Earliest I can load is ${sayWin(cheapWin, k)}, delivering ${sayDT(cheapEta, k)}.`,
        `Best I can do is ${moneyShort(cheapAll)} all in with a ${sayWin(cheapWin, k)} pickup; delivery ${sayDT(cheapEta, k)}. Truck is a ${eqWords(d)}.`,
      ],
      delivery: [
        `${moneyShort(cheapAll)} all-in, pickup ${sayWin(cheapWin, k)}. With my driver's hours I'd deliver ${sayDT(cheapEta, k)}.`,
        `Can load ${sayWin(cheapWin, k)} for ${moneyShort(cheapAll)} all in (${moneyShort(cheapLh)} linehaul + ${moneyShort(d.fuel)} FSC); ETA at the receiver ${sayDT(cheapEta, k)}.`,
      ],
      equipment: [
        `All I have open is a 53' dry van: ${moneyShort(cheapAll)} all-in, pickup ${sayWin(cheapWin, k)}, delivery ${sayDT(cheapEta, k)}.`,
        `I can cover it with a dry van for ${moneyShort(cheapAll)} all in. Load ${sayWin(cheapWin, k)}, deliver ${sayDT(cheapEta, k)}.`,
      ],
    };
    const cheapStatesLinehaul = (gap === 'pickup' && g) || (gap === 'delivery' && cheapStyle === 1);
    const cheapStatesEquipment = gap === 'equipment' || (gap === 'pickup' && cheapStyle === 1);
    const addCheap = (hhmm: string) => mb.add({
      direction: 'inbound', from: cheap.address, fromName: personName(cheap), to: [self.address], at: t(0, hhmm), subject: mb.reSubject(compliantIsA ? rfqB : rfqA), replyTo: compliantIsA ? rfqB : rfqA,
      body: body('Hi,', cheapText[gap][cheapStyle], sign(cheap, cheapCo)),
    });
    let eGood: string;
    let eCheap: string;
    if (lastIsCheap) { eGood = addGood('09:40'); eCheap = addCheap(g ? '10:25' : r.pick(['10:10', '10:25', '11:05'])); }
    else { eCheap = addCheap('09:35'); eGood = addGood(r.pick(['10:15', '10:40', '11:00'])); }
    const trigger = lastIsCheap ? eCheap : eGood;

    // ---- oracle
    const terms: OracleTerm[] = [
      cur(good.address, 'rate.linehaul', d.linehaul, [eGood]),
      cur(good.address, 'rate.fuel_surcharge', d.fuel, [eGood]),
      cur(good.address, 'rate.all_in', d.allIn, [eGood], true),
      cur(good.address, 'pickup.window', d.pickupWin, [eGood], true),
      cur(good.address, 'delivery.eta', d.appt, [eGood], true),
      cur(good.address, 'equipment.type', d.equipment, [eGood], true),
      ...(d.tempF !== null ? [cur(good.address, 'equipment.reefer_temp_f', d.tempF, [eGood])] : []),
      ...(cheapStatesLinehaul ? [cur(cheap.address, 'rate.linehaul', cheapLh, [eCheap]), cur(cheap.address, 'rate.fuel_surcharge', d.fuel, [eCheap])] : []),
      cur(cheap.address, 'rate.all_in', cheapAll, [eCheap], true),
      cur(cheap.address, 'pickup.window', cheapWin, [eCheap], true),
      cur(cheap.address, 'delivery.eta', cheapEta, [eCheap], true),
      ...(cheapStatesEquipment ? [cur(cheap.address, 'equipment.type', cheapEq, [eCheap], gap === 'equipment'), ...(cheapEq === 'reefer' && d.tempF !== null && gap === 'pickup' ? [cur(cheap.address, 'equipment.reefer_temp_f', d.tempF, [eCheap])] : [])] : []),
    ];
    const violation = gap === 'pickup'
      ? { term: 'pickup.window', display: `${cheapCo.company} can only load ${show('pickup.window', cheapWin)}, outside the shipper's window (${sayWin(d.reqPickup)})` }
      : gap === 'delivery'
        ? { term: 'delivery.eta', display: `${cheapCo.company} would deliver ${show('delivery.eta', cheapEta)}, after the ${sayDT(d.appt)} appointment` }
        : { term: 'equipment.type', display: `${cheapCo.company} offers a dry van; the load needs a ${eqLabel(d)}` };
    const checkpoint: Checkpoint = {
      id: 'after_both_quotes', after: trigger, now: t(0, '11:20'),
      state: {
        terms,
        superseded: [],
        open_loops: [],
        closed_loops: [
          { kind: 'ask', debtor: dispatcher.address, subject: 'rate.all_in', display: `${d.carrier.company}: all-in rate (answered)`, evidence: [compliantIsA ? eGood : eCheap] },
          { kind: 'ask', debtor: carrier2.address, subject: 'rate.all_in', display: `${d.carrier2.company}: all-in rate (answered)`, evidence: [compliantIsA ? eCheap : eGood] },
        ],
        conflicts: [{ kind: 'requirement_violation', term: violation.term, party: cheap.address, display: violation.display, critical: true }],
        documents: [{ filename: file, status: 'current', stale_terms: [], display: `${file}: ${poss(goodCo.company)} rate con, current` }],
        next_actor: 'us',
      },
      judge_facts: [
        `${goodCo.company} quoted ${moneyShort(d.allIn)} all-in, pickup ${show('pickup.window', d.pickupWin)}, delivery ${show('delivery.eta', d.appt)}, ${show('equipment.type', d.equipment)}${d.tempF !== null ? ` at ${sayTemp(d.tempF)}` : ''}: compliant and within the ${moneyShort(d.budget)} maximum.`,
        `${cheapCo.company} quoted a cheaper ${moneyShort(cheapAll)} all-in but ${violation.display.replace(`${cheapCo.company} `, '')}, which breaks a hard requirement.`,
        'These are two independent carriers, not a contradiction. The right choice is the compliant carrier.',
      ].join(' '),
      action: {
        expect: 'send',
        required: [{ id: 'book_compliant', text: `Books ${d.alias} with ${goodCo.company} at ${moneyShort(d.allIn)} all-in` }],
        optional: [{ id: 'decline_other', text: `Tells ${cheapCo.company} the load is covered / declines its quote`, det: { type: 'message_to', party: cheap.address } }],
        prohibited: [
          // judged, not regex-checked: a natural decline to this carrier ("the load is booked with another carrier") would
          // trip the binding patterns
          { id: 'book_cheap', text: `Books or accepts ${poss(cheapCo.company)} non-compliant quote` },
          { id: 'mix_up', text: "Attributes one carrier's rate or times to the other, or treats the two quotes as contradicting each other" },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return freightCase(competingOffers, variant, {
      description: `${goodCo.company} compliant at ${moneyShort(d.allIn)}; ${cheapCo.company} cheaper at ${moneyShort(cheapAll)} but fails on ${gap}; ${lastIsCheap ? 'cheap quote arrives last' : 'compliant quote arrives last'}.`,
      task: withParties(d.task, carrier2), mb, trigger, checkpoints: [checkpoint],
      params: { gap, cheapStyle, compliantIsA, lastIsCheap, discount, k, nBackground, nChatter, allIn: d.allIn, cheapAll, budget: d.budget, cheapWin, cheapEta, day: dayOf(cheapEta) },
    });
  },
};

export { freight };
