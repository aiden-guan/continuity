// Archetype: partial fulfilment (P1).
//
// The supplier commits to deliver all N units on a date and we confirm the order. On that date the
// supplier (or its operations desk) reports that k units were delivered and the remaining N−k are
// delayed to a later date.
//
// Trap: a commitment tracker that only knows "open" and "fulfilled" either closes the loop (a delivery
// happened) or keeps the full N-unit promise open (as if nothing arrived), and a duplicate N-unit loop
// is just as wrong. The oracle keeps ONE commitment open with a residual of N−k, the original
// all-N schedule superseded and the current schedule listing both lots (k on the original date, N−k on
// the new one). When the new date is after the hard deadline the agent must chase the residual units;
// otherwise it may simply acknowledge or wait.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleConflict, OracleLoop } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, moneyShort, nextWeekday, sayDate, seedOf, staleText, type DateStyle } from '../../core/util.ts';
import { SIGNATURE, addParty, firstName, later, lotsDisplay, procurementBackground, procurementCase, procurementChatter, procurementDayStart, procurementDeal, sayFrom, shortName } from './vertical.ts';

export const partial_fulfilment: Archetype = {
  id: 'partial_fulfilment',
  title: 'Part of a committed delivery arrives, the rest slips',
  capabilities: ['partial_fulfilment', 'open_loops', 'supersession'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('procurement', 'partial_fulfilment', variant));
    const g = variant === 0;
    const d = procurementDeal(r, variant);
    const { self, supplier, supplierOps } = d.cast;
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => procurementDayStart(d, day, hhmm);

    // ---- parameters
    const early = g ? false : r.chance(0.3); // promise is earlier than the deadline, so the slip may still be on time
    const promiseDay = early ? addDays(d.deadline, -2) : d.deadline; // Wednesday or Friday
    const promiseOffset = early ? 2 : 4;
    const delivered = g ? 300 : Math.round((d.qty * r.pick([0.4, 0.5, 0.6, 0.75])) / 10) * 10;
    const residual = d.qty - delivered;
    const newDay = g ? nextWeekday(d.deadline, 1) : early ? addDays(promiseDay, r.pick([1, 2])) : nextWeekday(d.deadline, r.pick([1, 2, 3]));
    const reporter = g ? supplier : r.chance(0.35) ? supplierOps : supplier;
    if (reporter === supplierOps) addParty(d, supplierOps);
    const supplierAck = g ? false : r.chance(0.5);
    const reportInThread = g ? true : r.chance(0.5) && reporter === supplier;
    const reason = g ? null : r.pick([null, 'a component shortage on our second line', 'a QC hold on the second batch', 'our carrier not having capacity', 'a delayed inbound shipment of parts']);
    const dateStyle: DateStyle = g ? 'weekday' : r.pick(['weekday', 'weekday_short_date', 'month_day', 'weekday_long'] as const);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 4);

    // ---- history
    const rfq = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: t(0, '08:45'),
      subject: `RFQ: ${d.qty} x ${d.item.sku} — ${d.alias}`,
      body: body(`Hi ${firstName(supplier)},`, `We need ${d.qty} ${d.item.name} for ${d.alias}, all by ${sayDate(d.deadline, 'weekday_short_date')} at the latest. Price and delivery date please?`, `Thanks,\n${SIGNATURE}`),
    });
    const promiseSay = sayDate(promiseDay, dateStyle); // written on Monday: a bare weekday means this week
    const offer = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: t(0, g ? '11:30' : r.pick(['10:50', '11:30', '13:15'])),
      subject: mb.reSubject(rfq), replyTo: rfq,
      body: body('Hi,', g
        ? `${moneyShort(d.price)} per unit, and I'll deliver all ${d.qty} ${sayDate(promiseDay, 'weekday')}.`
        : r.pick([
          `We can do ${moneyShort(d.price)} each. I'll deliver all ${d.qty} ${promiseSay}.`,
          `Price is ${moneyShort(d.price)}/unit and the full ${d.qty} ${unit} will be with you ${promiseSay}.`,
          `${moneyShort(d.price)} a unit. You'll have all ${d.qty} on ${promiseSay}, guaranteed.`,
        ]), firstName(supplier)),
    });
    const confirm = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: t(0, '15:00'),
      subject: mb.reSubject(rfq), replyTo: offer,
      body: body(`Hi ${firstName(supplier)},`, g ? `Great. We confirm the order: ${d.qty} at ${moneyShort(d.price)}, all ${d.qty} delivered ${sayDate(promiseDay, 'weekday')}.` : r.pick([`Perfect, please go ahead: ${d.qty} at ${moneyShort(d.price)} each, all delivered ${promiseSay}.`, `We confirm the order for ${d.qty} ${unit} at ${moneyShort(d.price)}, delivery ${promiseSay}.`]), SIGNATURE),
    });
    let ack: string | null = null;
    let ackRestates = false;
    if (supplierAck) {
      const ackText = r.pick([`Thanks, order booked. All ${d.qty} on ${promiseSay}.`, `Confirmed on our side, ${d.qty} ${unit} for ${promiseSay}.`, 'Received, thank you. Order is in the system.']);
      ackRestates = ackText.includes(String(d.qty));
      ack = mb.add({
        direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: t(0, '16:20'),
        subject: mb.reSubject(rfq), replyTo: confirm,
        body: body(ackText, firstName(supplier)),
      });
    }
    procurementBackground(r, d, mb, t(0, '09:30'), nBackground, g ? 0 : r.int(0, 6));
    procurementChatter(r, d, mb, t(1, '09:00'), nChatter, g ? 0 : r.int(0, 9));

    const reportAt = t(promiseOffset, g ? '14:10' : r.pick(['12:30', '14:10', '16:45']));
    const newSay = sayFrom(newDay, reportAt, dateStyle);
    const reportText = g
      ? `First shipment of ${delivered} has been delivered. The remaining ${residual} are delayed until ${newSay}.`
      : r.pick([
        `${delivered} of the ${d.qty} ${unit} were delivered to your dock today. Unfortunately the remaining ${residual} are delayed to ${newSay}${reason ? ` due to ${reason}` : ''}.`,
        `Update on ${d.alias}: the first ${delivered} have been delivered. The other ${residual} will follow on ${newSay}${reason ? ` (${reason})` : ''}.`,
        `Partial delivery today: ${delivered} ${unit} received at your site. ${reason ? `Because of ${reason}, the` : 'The'} balance of ${residual} now ships for ${newSay}.`,
        `We got ${delivered} to you this morning. The last ${residual} are running late and are now scheduled for ${newSay}.`,
      ]);
    const report = mb.add({
      direction: 'inbound', from: reporter.address, fromName: shortName(reporter), to: [self.address], cc: reporter === supplierOps ? [supplier.address] : undefined, at: reportAt,
      subject: reportInThread ? mb.reSubject(rfq) : g ? `Delivery update — ${d.alias}` : r.pick([`Delivery update — ${d.alias}`, `${d.alias} shipment status`, `${d.alias}: partial delivery`]),
      replyTo: reportInThread ? (ack ?? confirm) : null,
      body: body('Hi,', reportText, reporter === supplierOps ? `${shortName(supplierOps)}\n${d.company} Operations` : g ? 'Dana' : firstName(supplier)),
    });

    // ---- oracle
    const schedule = [{ qty: delivered, date: promiseDay }, { qty: residual, date: newDay }];
    const late = newDay > d.deadline;
    const conflicts: OracleConflict[] = late ? [{ kind: 'requirement_violation', term: 'delivery.schedule', party: reporter.address, display: `${residual} units now arrive ${sayDate(newDay, 'weekday_short_date')}, after the ${sayDate(d.deadline, 'weekday_short_date')} deadline`, critical: true }] : [];
    const commitEv = [offer, ...(ack ? [ack] : []), report];
    const open_loops: OracleLoop[] = [
      { kind: 'commitment', debtor: supplier.address, ...(reporter === supplierOps ? { alt_debtors: [supplierOps.address] } : {}), subject: 'delivery.remaining_units', alt_subjects: ['delivery.schedule'], display: `Supplier still owes the remaining ${residual} units (due ${sayDate(newDay, 'weekday_short_date')})`, evidence: commitEv, critical: true, residual: { qty: residual, display: `${residual} of ${d.qty} units` } },
    ];
    const closed_loops: OracleLoop[] = [
      { kind: 'ask', debtor: supplier.address, subject: 'price.unit', display: 'Unit price (answered)', evidence: [rfq, offer] },
      { kind: 'ask', debtor: supplier.address, subject: 'delivery.schedule', display: 'Delivery date (answered)', evidence: [rfq, offer] },
    ];
    const deadlineS = sayDate(d.deadline, 'weekday_short_date');
    const newS = sayDate(newDay, 'weekday_short_date');
    const prohibited: ActionCond[] = [
      { id: 'claims_complete', text: `Says or implies that all ${d.qty} units have been delivered or that the order is complete` },
      { id: 'full_qty_outstanding', text: `Treats all ${d.qty} units as still outstanding (e.g. asks when the ${d.qty} will arrive or for a new ${d.qty}-unit delivery)` },
      { id: 'stale_schedule', text: staleText(`Treats the original "all ${d.qty} on ${sayDate(promiseDay, 'weekday_short_date')}" as still on track`), stale: true },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    const checkpoint: Checkpoint = {
      id: 'after_partial_delivery', after: report, now: later(reportAt, 20),
      state: {
        terms: [
          { party: supplier.address, term: 'price.unit', status: 'current', value: d.price, evidence: [offer], critical: true, display: moneyShort(d.price) },
          // keyed by whoever stated the new schedule: the supplier, or its operations desk (which may set delivery terms)
          { party: reporter.address, term: 'delivery.schedule', status: 'current', value: schedule, evidence: [report], critical: true, display: `${lotsDisplay(schedule)} (first lot delivered)` },
        ],
        superseded: [{ party: supplier.address, term: 'delivery.schedule', value: [{ qty: d.qty, date: promiseDay }], display: `${d.qty} units ${sayDate(promiseDay, 'weekday_short_date')}`, evidence: ack && ackRestates ? [offer, ack] : [offer], superseded_by: report }],
        open_loops, closed_loops, conflicts, documents: [],
        next_actor: late ? 'us' : 'them',
      },
      judge_facts: [
        `The supplier committed to deliver all ${d.qty} units on ${sayDate(promiseDay, 'weekday_short_date')} and Acme confirmed the order at ${moneyShort(d.price)}/unit.`,
        `${delivered} units have been delivered; the remaining ${residual} are now due ${newS}. Only those ${residual} are still owed.`,
        late ? `Acme needs all units by ${deadlineS}, so the ${residual} late units break a hard requirement.` : `${newS} is still within Acme's ${deadlineS} deadline, so nothing is in breach yet.`,
      ].join(' '),
      action: late
        ? {
          expect: 'send',
          required: [
            reporter === supplierOps
              ? { id: 'to_supplier', text: "Sends a message to the supplier or its operations desk", det: { type: 'message_to_any', parties: [supplier.address, supplierOps.address] } }
              : { id: 'to_supplier', text: 'Sends a message to the supplier', det: { type: 'message_to', party: supplier.address } },
            { id: 'chase_residual', text: `Raises that the remaining ${residual} units due ${newS} miss the ${deadlineS} deadline and asks for a fix (expedite, firm date, or alternative)` },
          ],
          optional: [{ id: 'ack_delivered', text: `Acknowledges receipt of the ${delivered} delivered units` }],
          prohibited,
        }
        : {
          expect: 'any',
          required: [],
          optional: [{ id: 'ack_and_confirm', text: `Acknowledges the ${delivered} delivered and confirms the remaining ${residual} for ${newS}` }],
          prohibited,
        },
    };

    return procurementCase(partial_fulfilment, variant, {
      description: `Supplier committed all ${d.qty} on ${sayDate(promiseDay, 'weekday_short_date')}; ${delivered} delivered, ${residual} slip to ${newS}${late ? ' (after the deadline)' : ''}.`,
      task: d.task, mb, trigger: report, checkpoint,
      params: { early, promiseDay, delivered, residual, newDay, reporter: reporter.label, supplierAck, reportInThread, reason, dateStyle, nBackground, nChatter, qty: d.qty, price: d.price, deadline: d.deadline },
    });
  },
};
