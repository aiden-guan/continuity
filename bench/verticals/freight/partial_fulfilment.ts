// Archetype: partial fulfilment (P1).
//
// A shipper has N truckloads ready on one day; the carrier commits N trucks for that pickup day. On the day,
// only k load; the other N−k trucks slip to a later day (breakdown, driver out of hours). Later the dispatcher
// sends PODs for the k delivered loads. In some variants the slip is only announced together with the PODs.
// The shipper needs every load picked up by a deadline; depending on the variant the slipped trucks still make
// it or they do not.
//
// Trap: "carrier committed N" stays fully open (ignoring the k delivered), or the PODs read as "done" and the
// loop is closed. Oracle: capacity.loads is now k on the original day + N−k on the new day (the all-on-one-day
// commitment is superseded); the commitment is open with a residual of N−k; the PODs are current documents; a
// requirement violation exists only when the new day is after the shipper's deadline, and next_actor follows.
import type { Archetype, BenchCase, BenchTask, Checkpoint } from '../../core/types.ts';
import { MailBuilder, Rand, addBusinessDays, addDays, body, moneyShort, pdf, reaskText, sayDate, seedOf, staleText, thousands, weekday } from '../../core/util.ts';
import {
  cur, dead, eqLabel, eqPlural, eqWords, listAnd, sayTemp, equipmentTerms, firstName, freight, freightBackground, freightCase, freightChatter, freightDayStart, freightDeal, personName,
  show, signDispatch, signUs,
} from './vertical.ts';

const prevBusinessDay = (iso: string) => {
  let x = addDays(iso, -1);
  while (['Saturday', 'Sunday'].includes(weekday(x))) x = addDays(x, -1);
  return x;
};

export const partialFulfilment: Archetype = {
  id: 'partial_fulfilment',
  title: 'Carrier covers k of N loads; the rest slip',
  capabilities: ['partial_fulfilment', 'open_loops'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('freight', 'partial_fulfilment', variant));
    const g = variant === 0;
    const d = freightDeal(r, variant);
    const { self, dispatcher } = d.cast;
    const disp = dispatcher.address;

    // ---- parameters
    const n = g ? 4 : r.pick([3, 4, 5, 6]);
    const kDone = g ? 2 : r.int(1, n - 1);
    const left = n - kDone;
    const P = d.pickupDay;
    const podDay = addDays(P, d.lane.transit);
    const newDay = g ? addBusinessDays(podDay, 1) : addBusinessDays(podDay, r.pick([1, 1, 2]));
    // The coin is still drawn (keeps every later random draw unchanged), but the outcome is balanced by variant so
    // about a third of dev and of eval cases still make the deadline (variants 2, 5, 8, 11, 14, 17, 20).
    r.chance(0.5);
    const violate = g ? true : variant % 3 !== 2;
    const deadline = violate ? (prevBusinessDay(newDay) < P ? P : prevBusinessDay(newDay)) : g ? newDay : addBusinessDays(newDay, r.pick([0, 1]));
    const combined = g ? false : r.chance(0.35); // slip announced only with the PODs
    const restates = g ? true : r.chance(0.5);
    const reason = g ? 'one truck broke down and the other driver ran out of hours' : left === 1 ? r.pick([
      'the truck blew a turbo',
      'my driver got stuck at his previous receiver and is out of hours',
      'the truck I had lined up got held at its previous delivery',
      'the driver called out sick',
    ]) : r.pick([
      'we had a breakdown and the other drivers ran out of hours',
      'my drivers got stuck at a receiver and are out of hours',
      'the trucks I had lined up got held at their previous deliveries',
      'we had a breakdown and a driver call out sick',
    ]);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 1 : r.int(0, 3);
    const refs = Array.from({ length: n }, (_, i) => `${d.alias}-${i + 1}`);
    const podFile = `POD-${d.alias}-1-${kDone}.pdf`.replace(`-1-1.pdf`, '-1.pdf');
    const sayDay = (x: string) => sayDate(x, g ? 'weekday_short_date' : r.pick(['weekday_short_date', 'weekday_long', 'long'] as const));
    const plural = left === 1;
    const nWord = (x: number) => (x === 1 ? 'one' : ['zero', 'one', 'two', 'three', 'four', 'five', 'six'][x] ?? String(x));

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => freightDayStart(d, day, hhmm);
    const off = (iso: string) => Math.round((Date.parse(iso) - Date.parse(d.start)) / 86_400_000);

    // ---- task: N loads, all ready on P, all must ship by the deadline
    const task: BenchTask = {
      ...d.task,
      goal: `Cover ${n} truckloads for ${d.commodity.shipper} (${refs[0]} … ${refs[n - 1]}): ${d.commodity.name}, ${thousands(d.weight)} lbs each, ${d.lane.origin} → ${d.lane.dest}. ` +
        `All ${n} are ready ${sayDate(P, 'weekday_short_date')} and must be picked up by ${sayDate(deadline, 'weekday_short_date')}; ${eqLabel(d)}; max ${moneyShort(d.budget)} all-in per load.`,
      requirements: [
        { key: 'requirement.loads', value: n, display: `${n} loads`, hard: true },
        { key: 'requirement.all_picked_up_by', value: deadline, display: sayDate(deadline, 'weekday_short_date'), hard: true },
        { key: 'requirement.equipment', value: d.equipment, display: eqLabel(d), hard: true },
        { key: 'requirement.max_all_in', value: d.budget, display: `max ${moneyShort(d.budget)} all-in per load`, hard: true },
      ],
    };

    // ---- history
    const req = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [disp], at: t(0, '08:10'), subject: `${n} loads ${d.lane.origin.split(',')[0]} → ${d.lane.dest.split(',')[0]} — ${d.alias}`,
      body: body(`Hi ${firstName(dispatcher)},`, g
        ? `${d.commodity.shipper} has ${n} loads of ${d.commodity.name} (${refs[0]} through ${refs[n - 1]}) ready ${sayDay(P)} in ${d.lane.origin}, going to ${d.lane.dest}. ${eqLabel(d)}. All ${n} must be picked up by ${sayDay(deadline)}. Can you cover all ${n}, and what's your all-in per load?`
        : r.pick([
          `I have ${n} ${eqWords(d)} loads (${refs[0]}–${refs[n - 1]}), ${d.lane.origin} → ${d.lane.dest}, all ready ${sayDay(P)}. Shipper needs every one picked up by ${sayDay(deadline)}. Can you take all ${n}? All-in per load?`,
          `Looking for ${n} trucks for ${d.alias} (${d.commodity.name}, ${thousands(d.weight)} lbs each). Loads ready ${sayDay(P)}, ${d.lane.origin} to ${d.lane.dest}, must all ship by ${sayDay(deadline)}. What can you cover and at what all-in?`,
          `${d.commodity.shipper} has ${n} loads this week on ${d.alias}: ready ${sayDay(P)}, pickup no later than ${sayDay(deadline)}. ${eqLabel(d)}. Can you put ${n} trucks on it? Rate per load?`,
        ]), signUs(r, g)),
    });
    const commit = mb.add({
      direction: 'inbound', from: disp, fromName: personName(dispatcher), to: [self.address], at: t(0, '10:30'), subject: mb.reSubject(req), replyTo: req,
      body: body('Hi,', g
        ? `We can cover all ${n}. I'll have ${n} ${eqPlural(d.equipment)} at the shipper ${sayDay(P)} morning${d.tempF !== null ? `, pre-cooled to ${sayTemp(d.tempF)}` : ''}, ${moneyShort(d.allIn)} all-in per load.`
        : r.pick([
          `Yes, we'll take all ${n}. ${n} trucks on ${sayDay(P)}, ${moneyShort(d.allIn)} all-in each.`,
          `Can do all ${n} loads, all picking up ${sayDay(P)}. Rate is ${moneyShort(d.allIn)} all-in per load.`,
          `Good to go on ${n} ${eqPlural(d.equipment)} for ${sayDay(P)}. ${moneyShort(d.allIn)} per load all in.`,
        ]), signDispatch(d)),
    });
    const book = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [disp], at: t(0, '11:05'), subject: mb.reSubject(commit), replyTo: commit,
      body: body(`Great, you're booked on all ${n} (${refs.join(', ')}) at ${moneyShort(d.allIn)} all-in per load, pickup ${sayDay(P)}.`, signUs(r, g)),
    });
    freightBackground(r, d, mb, t(0, '11:30'), nBackground);
    freightChatter(r, d, mb, t(0, '15:00'), nChatter);

    const doneRefs = refs.slice(0, kDone);
    const leftRefs = refs.slice(kDone);
    const slipText = g
      ? `Update on ${d.alias}: ${listAnd(doneRefs)} loaded this morning and are rolling. The other ${nWord(left)} won't make it today — ${reason}. ${plural ? 'It will' : "They'll"} pick up ${sayDay(newDay)}.`
      : r.pick([
        `${kDone} of the ${n} loaded today (${listAnd(doneRefs)}). ${listAnd(leftRefs)} got pushed to ${sayDay(newDay)} — ${reason}.`,
        `Only ${kDone} trucks made it in today; ${reason}. The remaining ${left} (${listAnd(leftRefs)}) will load ${sayDay(newDay)}.`,
        `Heads up: ${listAnd(leftRefs)} ${plural ? 'is' : 'are'} moving to ${sayDay(newDay)}, ${reason}. ${listAnd(doneRefs)} ${kDone === 1 ? 'is' : 'are'} loaded and on the way.`,
      ]);
    let slip: string | null = null;
    if (!combined) {
      slip = mb.add({ direction: 'inbound', from: disp, fromName: personName(dispatcher), to: [self.address], at: t(off(P), '14:40'), subject: mb.reSubject(req), replyTo: book, body: body('Hi,', slipText, firstName(dispatcher)) });
    }
    const podLines = doneRefs.flatMap((ref, i) => [
      `PROOF OF DELIVERY — ${ref}`,
      `Consignee: ${d.consignee}, ${d.lane.dest}    Delivered: ${sayDate(podDay, 'weekday_short_date')} ${String(6 + i).padStart(2, '0')}:${String(10 + 7 * i).padStart(2, '0')}`,
      `Received by: ${r.pick(['T. Reid', 'P. Novak', 'A. Ruiz', 'D. Hart'])}    Pallets: ${r.int(18, 26)}    Exceptions: none`,
    ]);
    const podText = combined
      ? `${listAnd(doneRefs)} delivered this morning, PODs attached. On the rest: ${listAnd(leftRefs)} didn't load on ${sayDate(P, 'weekday')} — ${reason}. ${plural ? 'It will' : "They'll"} pick up ${sayDay(newDay)}.`
      : `${listAnd(doneRefs)} delivered clean this morning, POD${kDone === 1 ? '' : 's'} attached.${restates ? ` ${listAnd(leftRefs)} still on for ${sayDay(newDay)}.` : ''}`;
    const pod = mb.add({
      direction: 'inbound', from: disp, fromName: personName(dispatcher), to: [self.address], at: t(off(podDay), '13:20'), subject: mb.reSubject(req), replyTo: slip ?? book,
      body: body('Hi,', podText, firstName(dispatcher)), attachments: [pdf(podFile, podLines)],
    });

    // ---- oracle
    const slipEv = combined ? [pod] : restates ? [slip!, pod] : [slip!];
    const sched = [{ qty: kDone, date: P }, { qty: left, date: newDay }];
    const checkpoint: Checkpoint = {
      id: 'after_pods', after: pod, now: t(off(podDay), '13:40'),
      state: {
        terms: [
          cur(disp, 'capacity.loads', sched, slipEv, true),
          cur(disp, 'rate.all_in', d.allIn, [commit], true),
          ...equipmentTerms(d, disp, [commit]),
          cur(self.address, 'decision.tender', 'booked', [book]),
        ],
        superseded: [dead(disp, 'capacity.loads', [{ qty: n, date: P }], [commit], combined ? pod : slip!)],
        open_loops: [{
          kind: 'commitment', debtor: disp, subject: 'delivery.remaining_loads', alt_subjects: ['capacity.loads'], display: `Carrier still owes ${left} of ${n} loads (${listAnd(leftRefs)}), now ${sayDate(newDay, 'weekday_short_date')}`,
          evidence: [commit, ...slipEv], critical: true, residual: { qty: left, display: `${left} load${left === 1 ? '' : 's'} (${listAnd(leftRefs)}) picking up ${sayDate(newDay, 'weekday_short_date')}` },
        }],
        closed_loops: [
          { kind: 'ask', debtor: disp, subject: 'capacity.loads', display: `Can you cover all ${n} (answered)`, evidence: [commit] },
          { kind: 'ask', debtor: disp, subject: 'rate.all_in', display: 'All-in per load (answered)', evidence: [commit] },
        ],
        conflicts: violate ? [{ kind: 'requirement_violation', term: 'capacity.loads', party: disp, display: `${left} load${plural ? ' now picks' : 's now pick'} up ${sayDate(newDay, 'weekday_short_date')}, after the ${sayDate(deadline, 'weekday_short_date')} deadline`, critical: true }] : [],
        documents: [{ filename: podFile, status: 'current', stale_terms: [], display: `${podFile}: PODs for ${listAnd(doneRefs)}` }],
        next_actor: violate ? 'us' : 'them',
      },
      judge_facts: [
        `The carrier committed ${n} loads for ${sayDate(P, 'weekday_short_date')} at ${moneyShort(d.allIn)} all-in each; we booked all ${n}.`,
        `${kDone} (${listAnd(doneRefs)}) loaded on ${sayDate(P, 'weekday_short_date')} and were delivered ${sayDate(podDay, 'weekday_short_date')} (PODs received). The other ${left} (${listAnd(leftRefs)}) slipped to ${sayDate(newDay, 'weekday_short_date')} and ${plural ? 'is' : 'are'} still owed.`,
        violate
          ? `The shipper needs all loads picked up by ${sayDate(deadline, 'weekday_short_date')}, so the slipped loads miss a hard requirement.`
          : `The shipper's deadline is ${sayDate(deadline, 'weekday_short_date')}, so the new date still works; we are waiting on the carrier.`,
      ].join(' '),
      action: violate ? {
        expect: 'send',
        required: [
          { id: 'to_carrier', text: 'Sends a message to the carrier dispatcher', det: { type: 'message_to', party: disp } },
          { id: 'raise_late', text: `Tells the carrier that ${listAnd(leftRefs)} picking up ${sayDate(newDay, 'weekday_short_date')} misses the ${sayDate(deadline, 'weekday_short_date')} deadline and asks them to recover (earlier trucks) or release the loads` },
        ],
        optional: [{ id: 'ack_pods', text: `Acknowledges the PODs for ${listAnd(doneRefs)}` }],
        prohibited: [
          { id: 'claims_complete', text: staleText(`Treats all ${n} loads as delivered or the commitment as complete`), stale: true },
          { id: 'full_n_open', text: `Treats all ${n} loads as still outstanding (ignores the ${kDone} delivered)` },
          { id: 'reask_pods', text: reaskText(`Asks again for the PODs of ${listAnd(doneRefs)} (already received)`) },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      } : {
        expect: 'any',
        required: [],
        optional: [
          { id: 'ack_pods', text: `Acknowledges the PODs and confirms ${listAnd(leftRefs)} for ${sayDate(newDay, 'weekday_short_date')}` },
        ],
        prohibited: [
          { id: 'claims_complete', text: staleText(`Treats all ${n} loads as delivered or the commitment as complete`), stale: true },
          { id: 'full_n_open', text: `Treats all ${n} loads as still outstanding (ignores the ${kDone} delivered)` },
          { id: 'false_alarm', text: `Tells the carrier the ${sayDate(newDay, 'weekday_short_date')} pickups miss the deadline (they do not)` },
          { id: 'reask_pods', text: reaskText(`Asks again for the PODs of ${listAnd(doneRefs)} (already received)`) },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return freightCase(partialFulfilment, variant, {
      description: `${n} loads committed for ${sayDate(P, 'weekday_short_date')}; ${kDone} delivered, ${left} slipped to ${sayDate(newDay, 'weekday_short_date')}${violate ? ' (after the deadline)' : ' (still within the deadline)'}${combined ? '; slip announced with the PODs' : ''}.`,
      task, mb, trigger: pod, checkpoints: [checkpoint],
      params: { n, kDone, left, P, podDay, newDay, deadline, violate, combined, restates, nBackground, nChatter, allIn: d.allIn },
    });
  },
};

export { freight };
