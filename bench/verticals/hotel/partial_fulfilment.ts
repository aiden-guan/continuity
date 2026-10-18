// Archetype: partial fulfilment (P1).
//
// Two instantiations of "commitment of N, k delivered, N-k delayed":
//  - rooms: registration runs ahead of plan, we ask the (already contracted) hotel to add X rooms on the
//    peak night; the sales manager commits to add them, then loads only k now and says the remaining
//    X-k are pending until another group's cutoff releases inventory on a stated date.
//  - beo: after contracting, the convention services manager commits to send banquet event orders for
//    all D event days; k BEOs arrive (attached), the rest are pending the chef's menu.
//
// Trap: a fully open loop ("hotel still owes the X rooms / the BEOs") ignores what was delivered; a
// closed loop ("hotel added the rooms / sent the BEOs") ignores the residual. The oracle: the commitment
// is open with residual N-k; in the rooms case the block now holds base+k on that night (the base block
// is superseded, base+X was never offered as a block) and is still short of Acme's need.
import type { ActionPolicy, Archetype, BenchAttachment, BenchCase, Checkpoint, OracleConflict, OracleState, OracleSuperseded, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, moneyShort, nextWeekday, pdf, reaskText, sayDate, seedOf, staleText } from '../../core/util.ts';
import {
  AGENT_SIGN, addParty, blockDisplay, dayOf, firstName, hotel, hotelBackground, hotelChatter, hotelDayStart, hotelDeal, night, plainName, setNeed,
  contractLines, plusMinutes, signoff, term, violation, type Lot,
} from './vertical.ts';

export const partial_fulfilment: Archetype = {
  id: 'partial_fulfilment',
  title: 'Hotel delivers part of a commitment',
  capabilities: ['partial_fulfilment', 'open_loops'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('hotel', 'partial_fulfilment', variant));
    const g = variant === 0;
    const d = hotelDeal(r, variant);
    const { self, sales, csm } = d.cast;
    const mode: 'rooms' | 'beo' = g ? 'rooms' : r.pick(['rooms', 'beo'] as const);
    const nBackground = g ? 2 : r.int(2, 7);
    const nChatter = g ? 0 : r.int(0, 3);
    const style = g ? 0 : r.int(0, 2);

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => hotelDayStart(d, day, hhmm);
    const signed = addDays(d.start, -r.int(10, 20));
    const contractFile = `${d.hotel.short.replace(/\s+/g, '')}-Executed-Contract-${d.contractRef}.pdf`;

    // the executed contract, summarised by the hotel (both modes start here)
    const executed = mb.add({
      direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(0, '09:15'),
      subject: `Fully executed contract — ${d.event} (${d.alias})`,
      body: body('Hi,', `Attached is the fully executed agreement for ${d.alias}, countersigned on ${sayDate(signed, 'month_day')}. Recap: ${blockDisplay(d.block).replace(/ \+ /g, ', ')} at ${moneyShort(d.rate)} per night, cutoff ${sayDate(d.cutoff, 'long')}.`,
        mode === 'beo' ? `I'm handing you over to ${plainName(csm)}, our convention services manager, for all event details from here.` : null, signoff(sales, d.hotel.name)),
      attachments: [pdf(contractFile, contractLines(d, { date: signed, extra: [`Signed for the Group: Acme Events, ${sayDate(signed, 'month_day')}, ${signed.slice(0, 4)}`] }))],
    });
    hotelBackground(r, d, mb, t(0, '10:00'), nBackground);

    let state: OracleState;
    let trigger: string;
    let judge: string[];
    let description: string;
    let params: Record<string, unknown>;
    let checkpointAction: ActionPolicy;
    const baseTerms = (blockEv: string[], block: Lot[]): OracleTerm[] => [
      term(sales, 'rate.group', d.rate, [executed], true),
      term(sales, 'block.rooms', block, blockEv, true),
      term(sales, 'cutoff.date', d.cutoff, [executed]),
    ];

    if (mode === 'rooms') {
      // ---- rooms: add X on the peak night, k loaded now, X-k pending
      const peak = Math.max(...d.block.map((l) => l.qty));
      const hit = d.block.find((l) => l.qty === peak)!;
      const X = g ? 15 : r.pick([10, 15, 20, 25, 30]);
      const k = g ? 9 : r.int(Math.ceil(X * 0.3), X - 3);
      const rest = X - k;
      setNeed(d, d.block.map((l) => (l.date === hit.date ? { qty: l.qty + X, date: l.date } : { ...l })));
      const releaseDay = g ? nextWeekday(dayOf(d, 3), 5) : addDays(dayOf(d, 3), r.pick([2, 4, 7, 9]));
      const promiseDay = nextWeekday(dayOf(d, 1), 4);
      const ask = mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [sales.address], at: t(1, '10:00'), subject: `Additional rooms — ${d.alias}`,
        body: body(`Hi ${firstName(sales)},`, [
          `Registration for ${d.event} is running ahead of plan. Could you add ${X} rooms to our block on ${sayDate(hit.date, 'weekday_long')}, at the group rate?`,
          `Good problem to have: we need ${X} more rooms on ${night(hit.date)} (${hit.qty + X} total that night). Can you add them to ${d.alias}?`,
          `Can we grow the ${sayDate(hit.date, 'month_day')} night by ${X} rooms? Attendance is up.`,
        ][style], AGENT_SIGN),
      });
      const commit = mb.add({
        direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(1, '15:30'), subject: mb.reSubject(ask), replyTo: ask,
        body: body('Hi,', [
          `Yes, we can do that. I'll get the ${X} additional rooms on ${sayDate(hit.date, 'weekday')} loaded into your block once revenue releases them, and confirm by ${sayDate(promiseDay, 'weekday')}.`,
          `Happy to help. We'll add ${X} rooms on ${night(hit.date)} at your group rate; I'll confirm once they're in the system (by ${sayDate(promiseDay, 'weekday')}).`,
          `Absolutely, we'll find you ${X} more rooms for ${sayDate(hit.date, 'month_day')}. I'll confirm by ${sayDate(promiseDay, 'weekday')}.`,
        ][style], signoff(sales, d.hotel.name)),
      });
      hotelChatter(r, d, mb, t(2, '09:00'), nChatter);
      const newBlock = d.block.map((l) => (l.date === hit.date ? { qty: l.qty + k, date: l.date } : { ...l }));
      const partial = mb.add({
        direction: 'inbound', from: sales.address, fromName: plainName(sales), to: [self.address], at: t(3, '11:40'), subject: mb.reSubject(ask), replyTo: commit,
        body: body('Hi,', [
          `Update: I've added ${k} of the ${X} rooms on ${sayDate(hit.date, 'weekday_long')}, so your block that night is now ${hit.qty + k}. The remaining ${rest} are pending: revenue will release them after another group's cutoff on ${sayDate(releaseDay, 'long')}, and I'll confirm then.`,
          `Partial good news: ${k} rooms are now in your block for ${night(hit.date)} (${hit.qty + k} total). The other ${rest} I can't confirm until ${sayDate(releaseDay, 'weekday_long')}, when a tentative group's hold expires.`,
          `${k} additional rooms are loaded for ${sayDate(hit.date, 'month_day')}, bringing that night to ${hit.qty + k}. The last ${rest} are still pending; I expect an answer by ${sayDate(releaseDay, 'month_day')}.`,
        ][style], g ? `Thanks for your patience,\n${firstName(sales)}` : signoff(sales, d.hotel.name)),
      });
      trigger = partial;
      const v = violation(d, 'block.rooms', newBlock)!;
      const superseded: OracleSuperseded[] = [{ party: sales.address, term: 'block.rooms', value: d.block, display: blockDisplay(d.block), evidence: [executed], superseded_by: partial }];
      const conflicts: OracleConflict[] = [{ kind: 'requirement_violation', term: 'block.rooms', party: sales.address, display: `${v} until the remaining ${rest} rooms are confirmed` }];
      state = {
        terms: baseTerms([partial], newBlock),
        superseded,
        open_loops: [{
          kind: 'commitment', debtor: sales.address, subject: 'block.remaining_rooms', alt_subjects: ['block.rooms'],
          display: `Hotel still owes ${rest} of the ${X} extra rooms on ${night(hit.date)} (answer expected ${sayDate(releaseDay, 'weekday_short_date')})`,
          evidence: [commit, partial], critical: true, residual: { qty: rest, display: `${rest} rooms on ${night(hit.date)}` },
        }],
        closed_loops: [],
        conflicts,
        documents: [{ filename: contractFile, status: 'partially_stale', stale_terms: ['block.rooms'], display: `${contractFile}: ${night(hit.date)} block superseded by the added rooms; other terms current` }],
        next_actor: 'them',
      };
      judge = [
        `The hotel committed to add ${X} rooms on ${night(hit.date)}. It has added ${k} (that night is now ${hit.qty + k} rooms) and the remaining ${rest} are pending until ${sayDate(releaseDay, 'long')}.`,
        `Current block: ${blockDisplay(newBlock)}; Acme needs ${hit.qty + X} on ${night(hit.date)}.`,
        `The hotel owes the next step (confirming the last ${rest}); nothing about the rate or other nights changed.`,
      ];
      description = `Hotel committed to +${X} rooms on ${night(hit.date)}; ${k} added, ${rest} pending until ${releaseDay}.`;
      params = { mode, X, k, rest, hit: hit.date, releaseDay, style, nBackground, nChatter };
      checkpointAction = {
        expect: 'any',
        required: [],
        optional: [
          { id: 'ack_partial', text: `Acknowledges the ${k} rooms already added and asks only about the remaining ${rest} (or about a backup plan for them)` },
        ],
        prohibited: [
          { id: 'reask_all', text: reaskText(`Asks the hotel again for all ${X} additional rooms as if none had been added`) },
          { id: 'treat_complete', text: `Says or implies all ${X} additional rooms are confirmed (the block on ${night(hit.date)} is ${hit.qty + k}, not ${hit.qty + X})` },
          { id: 'stale_block', text: staleText(`Treats the old ${hit.qty}-room ${night(hit.date)} block as current`), stale: true },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      };
    } else {
      // ---- beo: D banquet event orders promised, k delivered
      addParty(d, csm);
      const D = d.nights.length;
      const k = r.int(1, D - 1);
      const rest = D - k;
      const days = d.nights;
      const reviewBy = addDays(d.arrival, -45);
      const pendingBy = addDays(dayOf(d, 3), r.pick([3, 5, 7]));
      const ask = mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [csm.address], cc: [sales.address], at: t(0, '14:00'), subject: `BEOs — ${d.alias}`,
        body: body(`Hi ${firstName(csm)},`, [
          `Nice to meet you! Could you send banquet event orders for all ${D} days (${days.map((x) => sayDate(x, 'weekday')).join(', ')}) so we can review menus and room sets well before ${sayDate(reviewBy, 'month_day')}?`,
          `To get ahead on planning, please send the BEOs for each of our ${D} event days.`,
          `Could we get draft BEOs for every day of the program (${sayDate(days[0], 'month_day')}-${sayDate(days.at(-1)!, 'month_day')})?`,
        ][style], AGENT_SIGN),
      });
      const promiseDay = nextWeekday(dayOf(d, 1), 5);
      const commit = mb.add({
        direction: 'inbound', from: csm.address, fromName: plainName(csm), to: [self.address], at: t(1, '09:30'), subject: mb.reSubject(ask), replyTo: ask,
        body: body('Hi,', [
          `Lovely to meet you too. I'll send BEOs for all ${D} days by ${sayDate(promiseDay, 'weekday')}.`,
          `Of course. You'll have BEOs for each of the ${D} days by ${sayDate(promiseDay, 'weekday')}.`,
          `Happy to. I'll draft all ${D} BEOs and send them over by ${sayDate(promiseDay, 'weekday')}.`,
        ][style], signoff(csm, d.hotel.name)),
      });
      hotelChatter(r, d, mb, t(2, '09:00'), nChatter);
      const beos: BenchAttachment[] = days.slice(0, k).map((day, i) => pdf(`BEO-${d.alias}-Day${i + 1}.pdf`, [
        `${d.hotel.name.toUpperCase()} — BANQUET EVENT ORDER`,
        `Group: ${d.event} (${d.alias})    Day ${i + 1}: ${sayDate(day, 'long')}`,
        '07:30 Continental breakfast — Foyer — guarantee due 72 hours prior',
        '08:30 General session — Ballroom A — classroom for ' + d.attendees,
        '12:00 Plated lunch — Ballroom B',
        '15:00 Afternoon break — Foyer',
        'All food and beverage subject to 24% service charge and applicable tax.',
      ]));
      const partial = mb.add({
        direction: 'inbound', from: csm.address, fromName: plainName(csm), to: [self.address], at: t(3, '16:10'), subject: mb.reSubject(ask), replyTo: commit,
        body: body('Hi,', [
          `Attached are the BEOs for ${k === 1 ? 'Day 1' : `Days 1-${k}`}. ${rest === 1 ? `Day ${D}` : `Days ${k + 1}-${D}`} ${rest === 1 ? 'is' : 'are'} still pending while our chef finalizes the menus; I'll send ${rest === 1 ? 'it' : 'them'} by ${sayDate(pendingBy, 'weekday_long')}.`,
          `Here ${k === 1 ? 'is the first BEO' : `are the first ${k} BEOs`}. The remaining ${rest} will follow by ${sayDate(pendingBy, 'month_day')}; we're waiting on final menu pricing.`,
          `${k} of ${D} BEOs attached. I'm still working on the rest and expect to have ${rest === 1 ? 'it' : 'them'} to you by ${sayDate(pendingBy, 'long')}.`,
        ][style], signoff(csm, d.hotel.name)),
        attachments: beos,
      });
      trigger = partial;
      state = {
        terms: baseTerms([executed], d.block),
        superseded: [],
        open_loops: [{
          kind: 'commitment', debtor: csm.address, subject: 'document.banquet_event_order',
          display: `Hotel still owes ${rest} of ${D} BEOs (expected by ${sayDate(pendingBy, 'weekday_short_date')})`,
          evidence: [commit, partial], critical: true, residual: { qty: rest, display: `${rest} BEO${rest > 1 ? 's' : ''} (day${rest > 1 ? 's' : ''} ${Array.from({ length: rest }, (_, i) => k + 1 + i).join(', ')})` },
        }],
        closed_loops: [],
        conflicts: [],
        documents: [
          { filename: contractFile, status: 'current', stale_terms: [], display: `${contractFile}: executed, unchanged` },
          ...beos.map((b) => ({ filename: b.filename, status: 'current' as const, stale_terms: [], display: `${b.filename}: received` })),
        ],
        next_actor: 'them',
      };
      judge = [
        `The convention services manager committed to send BEOs for all ${D} event days. ${k} arrived; ${rest} ${rest === 1 ? 'is' : 'are'} still owed, expected by ${sayDate(pendingBy, 'long')}.`,
        `The contract is executed: ${blockDisplay(d.block)} at ${moneyShort(d.rate)}/night; nothing about it changed.`,
      ];
      description = `CSM committed to ${D} BEOs; ${k} delivered, ${rest} pending.`;
      params = { mode, D, k, rest, pendingBy, style, nBackground, nChatter };
      checkpointAction = {
        expect: 'any',
        required: [],
        optional: [
          { id: 'ack_partial', text: `Acknowledges the ${k} BEO${k > 1 ? 's' : ''} received and confirms the remaining ${rest} ${rest === 1 ? 'is' : 'are'} expected by ${sayDate(pendingBy, 'month_day')}` },
        ],
        prohibited: [
          { id: 'reask_all', text: reaskText(`Asks again for all ${D} BEOs as if none had been sent`) },
          { id: 'treat_complete', text: 'Says or implies all BEOs have been received' },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      };
    }

    const checkpoint: Checkpoint = {
      id: 'after_partial', after: trigger, now: plusMinutes(mb.get(trigger).at, 25),
      state,
      judge_facts: judge.join(' '),
      action: checkpointAction,
    };

    return {
      id: `hotel/partial_fulfilment/${variant}`,
      vertical: 'hotel',
      archetype: 'partial_fulfilment',
      variant,
      split: variant === 0 ? 'golden' : variant <= 10 ? 'dev' : 'eval',
      capabilities: partial_fulfilment.capabilities,
      description,
      task: d.task,
      events: mb.sorted(),
      trigger,
      checkpoints: [checkpoint],
      params,
    };
  },
};

export { hotel };
