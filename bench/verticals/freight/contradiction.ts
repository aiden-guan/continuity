// Archetype: contradiction within one group (P1).
//
// The load is booked and the receiver has a confirmed appointment. While it is in transit we ask the carrier for
// an ETA. The dispatcher says the driver is on schedule for the appointment; within an hour or two the driver
// himself (same carrier, same group) emails a different ETA — out of hours, held at the shipper, he will be late.
// Neither message references the other. Which one arrives last varies.
//
// Trap: "newest wins" picks whichever came last; a dispatcher-has-authority rule silently drops the driver. Both
// are the carrier talking about the same load, and neither retracted anything. Oracle: delivery.eta is contested
// with both values (each by its own speaker), nothing is superseded, the conflict is a contradiction, and the
// right action is to get the carrier to reconcile before telling the receiver anything definite or moving the
// appointment.
import type { Archetype, BenchCase, Checkpoint } from '../../core/types.ts';
import { MailBuilder, Rand, addBusinessDays, addDays, body, moneyShort, pdf, seedOf } from '../../core/util.ts';
import {
  cur, dt, equipmentTerms, firstName, freight, freightBackground, freightCase, freightChatter, freightDayStart, freightDeal, hh, hourOf, personName,
  rateConFile, rateConLines, sayDT, sayWin, show, signDispatch, signUs, withParties,
} from './vertical.ts';

export const contradiction: Archetype = {
  id: 'contradiction',
  title: 'Dispatcher and driver give different delivery ETAs',
  capabilities: ['conflict_vs_supersession'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('freight', 'contradiction', variant));
    const g = variant === 0;
    const d = freightDeal(r, variant);
    const { self, dispatcher, driver, receiver } = d.cast;
    const disp = dispatcher.address;

    // ---- parameters
    const order: 'dispatcher_first' | 'driver_first' = g ? 'dispatcher_first' : r.pick(['dispatcher_first', 'driver_first'] as const);
    const k = g ? 0 : r.int(0, 3);
    const dispEta = g ? d.appt : r.chance(0.5) ? d.appt : dt(d.deliveryDay, hh(Math.max(5, hourOf(d.appt) - 1)));
    const lateH = hourOf(d.appt) + (g ? 25 : r.pick([5, 6, 12, 25]));
    const drvEta = lateH <= 18 ? dt(d.deliveryDay, hh(lateH)) : dt(addBusinessDays(d.deliveryDay, 1), hh(g ? 9 : r.pick([7, 8, 9])));
    const ccDispatch = g ? false : r.chance(0.4);
    const apptNo = g ? '45512' : String(r.int(10000, 99999));
    const nBackground = g ? 2 : r.int(2, 7);
    const nChatter = g ? 1 : r.int(0, 3);
    const file = rateConFile(d);
    const off = (iso: string) => Math.round((Date.parse(iso.slice(0, 10)) - Date.parse(d.start)) / 86_400_000);
    const dayX = addDays(d.deliveryDay, -1); // the evening before delivery

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => freightDayStart(d, day, hhmm);

    // ---- history: appointment, booking, signed rate con
    const apptAsk = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [receiver.address], at: t(0, '08:15'), subject: `Delivery appointment — ${d.alias} / ${d.commodity.shipper}`,
      body: body('Hello,', `Please book ${sayDT(d.appt, k)} for ${d.alias} (${d.commodity.shipper}, one truckload of ${d.commodity.name}).`, signUs(r, g)),
    });
    const apptOk = mb.add({
      direction: 'inbound', from: receiver.address, fromName: personName(receiver), to: [self.address], at: t(0, '09:40'), subject: mb.reSubject(apptAsk), replyTo: apptAsk,
      body: body(g ? `Confirmed: ${show('delivery.appointment', d.appt)}, appt #${apptNo}.` : r.pick([`You're booked for ${sayDT(d.appt, k)}, appt #${apptNo}.`, `Appointment ${apptNo} set for ${sayDT(d.appt, k)}.`, `Confirmed ${sayDT(d.appt, k)} — #${apptNo}. Trucks more than 2 hours late will be reworked.`]), `${firstName(receiver)}\n${d.consignee} Receiving`),
    });
    const book = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [disp], at: t(0, '10:30'), subject: `${d.alias} booked — ${d.lane.origin} to ${d.lane.dest}`,
      body: body(`Hi ${firstName(dispatcher)},`, `Per our call, you're booked on ${d.alias} at ${moneyShort(d.allIn)} all-in. Pickup ${sayWin(d.pickupWin, k)}; delivery appointment ${sayDT(d.appt, k)} (#${apptNo}). Please send the signed rate con.`, signUs(r, g)),
    });
    const signed = mb.add({
      direction: 'inbound', from: disp, fromName: personName(dispatcher), to: [self.address], at: t(0, '11:15'), subject: mb.reSubject(book), replyTo: book,
      body: body('Signed rate con attached. Thanks for the load!', signDispatch(d)), attachments: [pdf(file, rateConLines(d, { date: d.start, extra: [`Appointment #: ${apptNo}`] }))],
    });
    freightBackground(r, d, mb, t(0, '12:00'), nBackground);
    freightChatter(r, d, mb, t(0, '15:00'), nChatter);
    const etaAsk = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [disp], at: t(off(dayX), '13:30'), subject: mb.reSubject(book), replyTo: signed,
      body: body(`Hi ${firstName(dispatcher)},`, g ? `How's ${d.alias} looking? Please send me an ETA for the ${sayDT(d.appt, 0)} appointment.` : r.pick([`Can I get an ETA on ${d.alias}?`, `Checking in on ${d.alias} — are we on time for the ${sayDT(d.appt, k)} appt?`, `Please send an updated ETA for ${d.alias}.`]), signUs(r, g)),
    });

    const dispText = g
      ? `Driver loaded on time and is rolling. ETA ${sayDT(dispEta, 0)}, he'll make the appointment.`
      : r.pick([
        `All good on ${d.alias}. Driver is rolling, ETA ${sayDT(dispEta, k)}.`,
        `He's on schedule — should be at ${d.consignee} ${sayDT(dispEta, k)}.`,
        `Checked the ELD, he's got the hours. ETA ${sayDT(dispEta, k)}, on time for the appt.`,
      ]);
    const drvText = g
      ? `Hi this is ${firstName(driver)} on load ${d.alias}. I'm out of hours on my 70 and have to take a 34-hour restart in ${d.lane.via}. ETA at the receiver is ${sayDT(drvEta, 0)}.`
      : r.pick([
        `This is ${firstName(driver)}, driver on ${d.alias}. Running out of hours after the wait at the shipper, I'll be at the receiver ${sayDT(drvEta, k)}.`,
        `Driver for ${d.alias} here. Hit weather near ${d.lane.via} and need my 10-hour break. Looks like ${sayDT(drvEta, k)} for delivery.`,
        `${firstName(driver)} here (${d.carrier.company}), load ${d.alias}. Won't make the appt, ETA is ${sayDT(drvEta, k)}. Sorry.`,
      ]);
    const addDisp = (hhmm: string) => mb.add({ direction: 'inbound', from: disp, fromName: personName(dispatcher), to: [self.address], at: t(off(dayX), hhmm), subject: mb.reSubject(etaAsk), replyTo: etaAsk, body: body('Hi,', dispText, firstName(dispatcher)) });
    const addDrv = (hhmm: string) => mb.add({ direction: 'inbound', from: driver.address, fromName: personName(driver), to: [self.address], cc: ccDispatch ? [disp] : undefined, at: t(off(dayX), hhmm), subject: `${d.alias} ETA`, body: body(drvText, firstName(driver)) });
    let eDisp: string;
    let eDrv: string;
    if (order === 'dispatcher_first') { eDisp = addDisp('14:20'); eDrv = addDrv(g ? '15:05' : r.pick(['15:05', '15:40', '16:10'])); }
    else { eDrv = addDrv('14:10'); eDisp = addDisp(g ? '15:00' : r.pick(['15:00', '15:30', '16:05'])); }
    const trigger = order === 'dispatcher_first' ? eDrv : eDisp;

    // ---- oracle
    const dispEv = dispEta === d.appt ? [signed, eDisp] : [eDisp];
    const checkpoint: Checkpoint = {
      id: 'after_contradiction', after: trigger, now: t(off(dayX), '16:30'),
      state: {
        terms: [
          {
            party: disp, term: 'delivery.eta', status: 'contested', evidence: [eDisp, eDrv], critical: true,
            contested: [{ party: disp, value: dispEta, evidence: dispEv }, { party: driver.address, value: drvEta, evidence: [eDrv] }],
            display: `dispatcher says ${show('delivery.eta', dispEta)}; driver says ${show('delivery.eta', drvEta)}`,
          },
          cur(receiver.address, 'delivery.appointment', d.appt, [apptOk], true),
          cur(disp, 'rate.all_in', d.allIn, [signed]),
          cur(disp, 'pickup.window', d.pickupWin, [signed]),
          ...equipmentTerms(d, disp, [signed]),
          cur(self.address, 'decision.tender', 'booked', [book]),
        ],
        superseded: [],
        open_loops: [],
        closed_loops: [
          { kind: 'ask', debtor: receiver.address, subject: 'delivery.appointment', display: 'Delivery appointment (confirmed)', evidence: [apptOk] },
          { kind: 'ask', debtor: disp, subject: 'document.rate_confirmation', display: 'Signed rate con (received)', evidence: [signed] },
        ],
        conflicts: [{ kind: 'contradiction', term: 'delivery.eta', party: disp, display: `Dispatcher ETA ${show('delivery.eta', dispEta)} vs driver ETA ${show('delivery.eta', drvEta)}`, critical: true }],
        documents: [{ filename: file, status: 'current', stale_terms: [], display: `${file}: signed rate con, current` }],
        next_actor: 'us',
      },
      judge_facts: [
        `${d.alias} is booked with ${d.carrier.company} and the receiver's appointment is ${sayDT(d.appt)} (#${apptNo}).`,
        `The dispatcher says the ETA is ${show('delivery.eta', dispEta)} (on time); the driver separately says ${show('delivery.eta', drvEta)} (late). Neither retracted anything, and the later message is not automatically right.`,
        'The ETA is unresolved and must be reconciled with the carrier before the receiver is told a definite time or the appointment is moved.',
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_carrier', text: 'Sends a message to the carrier dispatcher', det: { type: 'message_to', party: disp } },
          { id: 'reconcile', text: `Points out that the dispatcher's ETA (${show('delivery.eta', dispEta)}) and the driver's ETA (${show('delivery.eta', drvEta)}) disagree and asks which is right` },
        ],
        optional: [{ id: 'warn_receiver', text: 'Gives the receiver a heads-up that the ETA is being confirmed, without committing to a new time' }],
        prohibited: [
          { id: 'pick_one', text: 'Treats one of the two ETAs as settled (e.g. tells someone it is definitely on time or definitely late) without reconciling' },
          { id: 'move_appt', text: 'Reschedules or cancels the receiver appointment based on one of the two ETAs' },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return freightCase(contradiction, variant, {
      description: `Booked load in transit: dispatcher ETA ${show('delivery.eta', dispEta)} vs driver ETA ${show('delivery.eta', drvEta)} (${order}); appointment ${show('delivery.appointment', d.appt)}.`,
      task: withParties(d.task, driver, receiver), mb, trigger, checkpoints: [checkpoint],
      params: { order, k, dispEta, drvEta, ccDispatch, apptNo, nBackground, nChatter, appt: d.appt },
    });
  },
};

export { freight };
