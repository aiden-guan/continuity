// Archetype: contradiction within one group (P1).
//
// The supplier quotes all N by the deadline, then corrects itself: part arrives on time, the remaining
// units on a later date. Then a second party on the supplier's side (its freight forwarder or its own
// operations desk; same group, also allowed to speak about delivery) gives a DIFFERENT date for those
// remaining units. In some variants the second party speaks first and the supplier second.
//
// Trap: "newest wins" adopts whichever message came last (often the more convenient date) and marks
// the other as superseded. But neither speaker retracted anything; a disagreement inside one group is a
// contradiction, not a correction. The oracle has the delivery schedule `contested` with both values
// (each with its own speaker and evidence), nothing superseded except the original all-by-deadline
// promise (killed by the supplier's own update), a contradiction conflict, and a requirement violation (both dates
// are after the deadline). The right action asks them to reconcile and does not treat either date as
// settled.
import type { Archetype, BenchCase, Checkpoint, BenchParty } from '../../core/types.ts';
import { MailBuilder, Rand, body, moneyShort, nextWeekday, sayDate, seedOf, staleText, type DateStyle } from '../../core/util.ts';
import { SIGNATURE, addParty, firstName, later, lotsDisplay, procurementBackground, procurementCase, procurementChatter, procurementDayStart, procurementDeal, sayFrom, shortName } from './vertical.ts';

export const contradiction: Archetype = {
  id: 'contradiction',
  title: 'Supplier and its forwarder give different delivery dates',
  capabilities: ['conflict_vs_supersession'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('procurement', 'contradiction', variant));
    const g = variant === 0;
    const d = procurementDeal(r, variant);
    const { self, supplier, forwarder, supplierOps } = d.cast;
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => procurementDayStart(d, day, hhmm);

    // ---- parameters
    const other: BenchParty = g ? forwarder : r.chance(0.6) ? forwarder : supplierOps;
    addParty(d, other);
    const onTime = g ? 300 : Math.round((d.qty * r.pick([0.5, 0.6, 0.7, 0.8])) / 10) * 10;
    const rest = d.qty - onTime;
    // two different dates after the deadline (Mon..Thu of the next week)
    const [supDay, otherDay] = g ? ['2026-10-28', '2026-10-26'] : r.shuffle([1, 2, 3, 4]).slice(0, 2).map((wd) => nextWeekday(d.deadline, wd));
    const supplierFirst = g ? true : r.chance(0.65);
    const otherInThread = g ? false : r.chance(0.4);
    const restatesPrice = g ? false : r.chance(0.5);
    const dateStyle: DateStyle = g ? 'weekday' : r.pick(['weekday', 'weekday_short_date', 'month_day', 'weekday_long'] as const);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 3);
    const booking = `FF-${r.int(10000, 99999)}`;

    // ---- history
    const rfq = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: t(0, '09:00'),
      subject: `RFQ: ${d.qty} x ${d.item.sku} — ${d.alias}`,
      body: body(`Hi ${firstName(supplier)},`, `We need ${d.qty} ${d.item.name} for ${d.alias}, all by ${sayDate(d.deadline, 'weekday_short_date')}. Price and delivery please?`, `Thanks,\n${SIGNATURE}`),
    });
    const offer = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: t(0, '13:30'),
      subject: mb.reSubject(rfq), replyTo: rfq,
      body: body('Hi,', g ? `All ${d.qty} by ${sayDate(d.deadline, 'weekday')} at ${moneyShort(d.price)} each.` : r.pick([`We can do all ${d.qty} by ${sayDate(d.deadline, dateStyle)} at ${moneyShort(d.price)}/unit.`, `${moneyShort(d.price)} per unit, full quantity delivered ${sayDate(d.deadline, dateStyle)}.`, `Yes to ${sayDate(d.deadline, dateStyle)} for all ${d.qty} ${unit}; price ${moneyShort(d.price)} each.`]), firstName(supplier)),
    });
    procurementBackground(r, d, mb, t(0, '10:00'), nBackground, g ? 0 : r.int(0, 6));
    procurementChatter(r, d, mb, t(0, '14:30'), nChatter, g ? 0 : r.int(0, 9));

    const supAt = supplierFirst ? t(1, g ? '10:05' : r.pick(['09:40', '10:05', '11:30'])) : t(2, r.pick(['09:20', '10:45']));
    const otherAt = supplierFirst ? t(2, g ? '08:50' : r.pick(['08:50', '11:10', '15:00'])) : t(1, r.pick(['10:15', '14:40']));
    const supSay = sayFrom(supDay, supAt, dateStyle);
    const supplierMsg = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: supAt,
      subject: mb.reSubject(rfq), replyTo: offer,
      body: body('Hi,', g
        ? `Small change: ${onTime} arrive ${sayDate(d.deadline, 'weekday')} as planned. Remaining ${rest} arrive ${supSay}.`
        : r.pick([
          `Update: we can only get ${onTime} to you by ${sayDate(d.deadline, 'weekday')}. The remaining ${rest} arrive ${supSay}.`,
          `Our second lot slipped. ${onTime} ${unit} on ${sayDate(d.deadline, 'weekday')}, the other ${rest} on ${supSay}.`,
          `Change to delivery: ${onTime} ship for ${sayDate(d.deadline, 'weekday')}; the balance of ${rest} will be delivered ${supSay}.`,
        ]), restatesPrice ? `Price stays at ${moneyShort(d.price)}.` : null, firstName(supplier)),
    });
    const otherSay = sayFrom(otherDay, otherAt, dateStyle);
    const isFwd = other === forwarder;
    const otherText = g
      ? `Our current carrier schedule shows ${otherSay} for the remaining ${rest} units on ${d.alias}.`
      : isFwd
        ? r.pick([
          `Our current carrier schedule shows the remaining ${rest} ${unit} on ${d.alias} arriving ${otherSay}.`,
          `Booking ${booking} (${d.company} → Acme, ${d.alias}): the final ${rest} units are scheduled for delivery ${otherSay}.`,
          `For your planning: the second consignment (${rest} units, ${d.alias}) is booked to arrive ${otherSay}.`,
        ])
        : r.pick([
          `Dispatch plan for ${d.alias}: first ${onTime} go out for ${sayDate(d.deadline, 'weekday')}, the last ${rest} are planned for ${otherSay}.`,
          `From operations: the remaining ${rest} on ${d.alias} are scheduled to reach you ${otherSay}.`,
          `Our production board shows the second batch (${rest} ${unit}) delivered ${otherSay}.`,
        ]);
    const otherMsg = mb.add({
      direction: 'inbound', from: other.address, fromName: shortName(other), to: [self.address], cc: [supplier.address], at: otherAt,
      subject: otherInThread && supplierFirst ? mb.reSubject(rfq) : isFwd ? `Shipment status — ${d.alias} (booking ${booking})` : `${d.alias} dispatch schedule`,
      replyTo: otherInThread && supplierFirst ? supplierMsg : null,
      body: body('Hello,', supplierFirst ? null : `Heads-up: the ${d.qty} ${unit} for ${d.alias} will come in two ${isFwd ? 'consignments' : 'batches'}, ${onTime} for ${sayDate(d.deadline, 'weekday')} and ${rest} later.`, otherText, isFwd ? 'Regards,\nFastFreight Ops' : `${shortName(other)}\n${d.company} Operations`),
    });
    const trigger = supplierFirst ? otherMsg : supplierMsg;
    const trigAt = supplierFirst ? otherAt : supAt;

    // ---- oracle
    const supLots = [{ qty: onTime, date: d.deadline }, { qty: rest, date: supDay }];
    const otherLots = [{ qty: onTime, date: d.deadline }, { qty: rest, date: otherDay }];
    const supS = sayDate(supDay, 'weekday_short_date');
    const otherS = sayDate(otherDay, 'weekday_short_date');
    const deadlineS = sayDate(d.deadline, 'weekday_short_date');
    const who = isFwd ? 'the freight forwarder' : "the supplier's operations team";
    const checkpoint: Checkpoint = {
      id: 'after_contradiction', after: trigger, now: later(trigAt, 20),
      state: {
        terms: [
          { party: supplier.address, term: 'price.unit', status: 'current', value: d.price, evidence: restatesPrice ? [offer, supplierMsg] : [offer], critical: true, display: moneyShort(d.price) },
          {
            party: supplier.address, term: 'delivery.schedule', status: 'contested', critical: true,
            contested: [
              { party: supplier.address, value: supLots, evidence: [supplierMsg] },
              { party: other.address, value: otherLots, evidence: [otherMsg] },
            ],
            evidence: [supplierMsg, otherMsg],
            display: `contested: supplier says ${lotsDisplay(supLots)}; ${who} says ${lotsDisplay(otherLots)}`,
          },
        ],
        superseded: [{ party: supplier.address, term: 'delivery.schedule', value: [{ qty: d.qty, date: d.deadline }], display: `${d.qty} units ${deadlineS}`, evidence: [offer], superseded_by: supplierMsg }], // the supplier's own update kills its promise; the other party only contradicts
        open_loops: [],
        closed_loops: [
          { kind: 'ask', debtor: supplier.address, subject: 'price.unit', display: 'Price (answered)', evidence: [rfq, offer] },
          { kind: 'ask', debtor: supplier.address, subject: 'delivery.schedule', display: 'Delivery (answered)', evidence: [rfq, offer] },
        ],
        conflicts: [
          { kind: 'contradiction', term: 'delivery.schedule', party: supplier.address, display: `Supplier says the remaining ${rest} arrive ${supS}; ${who} says ${otherS}`, critical: true },
          { kind: 'requirement_violation', term: 'delivery.schedule', party: supplier.address, display: `Either way the remaining ${rest} arrive after the ${deadlineS} deadline` },
        ],
        documents: [],
        next_actor: 'us',
      },
      judge_facts: [
        `${d.company} first promised all ${d.qty} by ${deadlineS} (no longer valid). Now ${onTime} arrive ${deadlineS}, but the date of the remaining ${rest} is disputed:`,
        `the supplier (${shortName(supplier)}) says ${supS}, ${who} (${shortName(other)}) says ${otherS}. Neither retracted; it is unresolved.`,
        `Both dates are after Acme's ${deadlineS} deadline. Price is ${moneyShort(d.price)}/unit.`,
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'reconcile', text: `Points out the discrepancy (${supS} from the supplier vs ${otherS} from ${who}) and asks the supplier and/or ${who} to confirm which date is correct` },
        ],
        optional: [
          { id: 'to_supplier', text: 'Sends a message to the supplier', det: { type: 'message_to', party: supplier.address } },
          { id: 'flag_deadline', text: `Notes that the remaining ${rest} units miss the ${deadlineS} deadline whichever date is right (the draft need not spell out either date again)` },
        ],
        prohibited: [
          { id: 'settles_supplier_date', text: `States or treats ${supS} as the confirmed date for the remaining units` },
          { id: 'settles_other_date', text: `States or treats ${otherS} as the confirmed date for the remaining units` },
          { id: 'stale_schedule', text: staleText(`Treats the original "all ${d.qty} by ${deadlineS}" as still valid`), stale: true },
          { id: 'binding_accept', text: 'Accepts or confirms the order with the supplier', det: { type: 'binding_to', party: supplier.address } },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return procurementCase(contradiction, variant, {
      description: `Supplier says the remaining ${rest} arrive ${supS}; ${who} says ${otherS} (${supplierFirst ? 'supplier first' : `${who} first`}).`,
      task: d.task, mb, trigger, checkpoint,
      params: { other: other.label, onTime, rest, supDay, otherDay, supplierFirst, otherInThread, restatesPrice, dateStyle, nBackground, nChatter, qty: d.qty, price: d.price, deadline: d.deadline },
    });
  },
};
