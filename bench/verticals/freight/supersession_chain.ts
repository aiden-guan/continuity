// Archetype: supersession chain (P1). A → B → C.
//
// A: the carrier quotes with a rate con. B: the truck falls through and the dispatcher re-quotes with one of the
// carrier's leased owner-operators (same carrier and authority, so not a re-brokered load) — one bundled email changes three things at once: the linehaul (so the all-in), the pickup window (later the
// same day, still inside the shipper's window) and a third term (detention or payment terms). C: one of those
// three reverts to its original value ("talked to my manager, we'll keep the original rate"; "got my own truck
// back, pickup is back to the morning"; "scratch the detention change") and the rest of B stands.
//
// Trap: "newest wins" treats C as the whole state (losing B's other changes); a summary keeps B for everything (the
// reverted term stays at B's value); a naive superseded list includes the original value of the reverted term.
// Oracle: per term, the latest value is current; superseded lists exactly the dead values — A's values for the two
// terms that did not revert, and B's value for the term that did — never the reverted-to original; the rate con
// is stale on the changed, non-reverted terms only.
import type { Archetype, BenchCase, Checkpoint, OracleSuperseded, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, body, moneyShort, pdf, reaskText, seedOf, staleText } from '../../core/util.ts';
import {
  cur, dead, equipmentTerms, firstName, freight, freightBackground, freightCase, freightChatter, freightDayStart, freightDeal, hh, hourOf, personName,
  quoteText, rateConFile, rateConLines, rfqBody, sayWin, show, signDispatch, signUs, win,
} from './vertical.ts';

type Third = 'detention' | 'payment';
type Revert = 'rate' | 'pickup' | 'third';

export const supersessionChain: Archetype = {
  id: 'supersession_chain',
  title: 'Bundled re-quote changes three terms; one reverts',
  capabilities: ['supersession', 'document_validity'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('freight', 'supersession_chain', variant));
    const g = variant === 0;
    const d = freightDeal(r, variant);
    const { self, dispatcher } = d.cast;
    const disp = dispatcher.address;

    // ---- parameters
    const third: Third = g ? 'detention' : r.pick(['detention', 'payment'] as const);
    const revert: Revert = g ? 'rate' : r.pick(['rate', 'pickup', 'third'] as const);
    const inc = g ? 75 : r.pick([25, 50, 75].filter((x) => d.allIn + x <= d.budget));
    const lhB = d.linehaul + inc;
    const shift = hourOf(d.reqPickup.end) - hourOf(d.pickupWin.end); // keeps B inside the shipper's window
    const winB = win(d.pickupDay, hh(hourOf(d.pickupWin.start) + shift), hh(hourOf(d.pickupWin.end) + shift));
    const detB = r.pick([50, 60, 85].filter((x) => x !== d.detention));
    const payB = d.payTerms.startsWith('Quick') ? 'Net 30' : 'Quick pay 2%, 5 days';
    const k = g ? 0 : r.int(0, 3);
    const promise = g ? true : r.chance(0.5);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 3);
    const file = rateConFile(d);

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => freightDayStart(d, day, hhmm);

    // ---- A
    const rfq = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [disp], at: t(0, '08:00'), subject: `${d.alias} — ${d.lane.origin} to ${d.lane.dest}`, body: rfqBody(r, d, g, dispatcher) });
    const a = mb.add({
      direction: 'inbound', from: disp, fromName: personName(dispatcher), to: [self.address], at: t(0, '09:20'), subject: mb.reSubject(rfq), replyTo: rfq,
      body: body('Hi,', quoteText(r, d, g, k), `Detention ${moneyShort(d.detention)}/hr after 2, ${d.payTerms}.`, signDispatch(d)), attachments: [pdf(file, rateConLines(d, { date: d.start }))],
    });
    const hold = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [disp], at: t(0, '09:45'), subject: mb.reSubject(a), replyTo: a,
      body: body(`Thanks ${firstName(dispatcher)}, checking with the shipper and will confirm shortly.`, signUs(r, g)),
    });
    freightBackground(r, d, mb, t(0, '07:15'), nBackground);
    freightChatter(r, d, mb, t(0, '10:00'), nChatter, 15);

    // ---- B: one bundled re-quote
    const thirdB = third === 'detention' ? `detention on owner-op trucks is ${moneyShort(detB)}/hr after 2` : `owner-op loads pay ${payB}`;
    const b = mb.add({
      direction: 'inbound', from: disp, fromName: personName(dispatcher), to: [self.address], at: t(0, '11:30'), subject: mb.reSubject(rfq), replyTo: hold,
      body: body('Hi,', g
        ? `Change of plan on ${d.alias}: my truck fell through, so I'm putting it on one of our leased owner-operators. That means: linehaul ${moneyShort(lhB)} (so ${moneyShort(lhB + d.fuel)} all-in), pickup ${sayWin(winB, 0)}, and ${thirdB}.`
        : r.pick([
          `Need to re-quote ${d.alias} — moving it to one of our owner-operators. New numbers: ${moneyShort(lhB)} linehaul / ${moneyShort(lhB + d.fuel)} all-in, pickup ${sayWin(winB, k)}, and ${thirdB}.`,
          `Update on ${d.alias}: the original truck isn't going to work. I can cover with an owner-operator leased to us: ${moneyShort(lhB + d.fuel)} all-in (${moneyShort(lhB)} + ${moneyShort(d.fuel)} fuel), loading ${sayWin(winB, k)}; ${thirdB}.`,
          `Revised offer for ${d.alias} with a different truck: linehaul goes to ${moneyShort(lhB)}, all-in ${moneyShort(lhB + d.fuel)}; pickup ${sayWin(winB, k)}; ${thirdB}.`,
        ]), `Delivery stays ${show('delivery.eta', d.appt)}.`, firstName(dispatcher)),
    });

    // ---- C: one term reverts
    const revertText: Record<Revert, string> = {
      rate: g ? `Good news on ${d.alias}: talked to my manager and we'll eat the difference — rate goes back to the original ${moneyShort(d.linehaul)} linehaul, ${moneyShort(d.allIn)} all-in.` : r.pick([
        `Talked to my manager: we'll keep ${d.alias} at the original ${moneyShort(d.allIn)} all-in (${moneyShort(d.linehaul)} linehaul).`,
        `Scratch the rate increase on ${d.alias} — back to ${moneyShort(d.linehaul)} linehaul, ${moneyShort(d.allIn)} all-in.`,
      ]),
      pickup: r.pick([
        `Got my own truck back for ${d.alias}, so pickup is back to ${sayWin(d.pickupWin, k)}.`,
        `Pickup on ${d.alias} can go back to the original ${sayWin(d.pickupWin, k)} after all.`,
      ]),
      third: third === 'detention'
        ? r.pick([`Scratch the detention change on ${d.alias} — it stays ${moneyShort(d.detention)}/hr after 2 hours.`, `Detention on ${d.alias} is back to ${moneyShort(d.detention)} an hour, my mistake.`])
        : r.pick([`Accounting says ${d.alias} can stay on ${d.payTerms} after all.`, `Payment terms for ${d.alias} go back to ${d.payTerms}.`]),
    };
    const c = mb.add({
      direction: 'inbound', from: disp, fromName: personName(dispatcher), to: [self.address], at: t(0, '13:50'), subject: mb.reSubject(rfq), replyTo: b,
      body: body('Hi,', revertText[revert], `${g ? 'Everything else from my last email stands.' : r.pick(['Everything else from my last email stands.', 'The rest of my last email still applies.', 'Other changes stay as I sent them.'])}${promise ? " I'll send a revised rate con." : ''}`, firstName(dispatcher)),
    });

    // ---- oracle
    const changedKeys: Record<Revert, string[]> = {
      rate: ['rate.linehaul', 'rate.all_in'], pickup: ['pickup.window'], third: [third === 'detention' ? 'accessorial.detention_per_hour' : 'payment.terms'],
    };
    const A: Record<string, unknown> = { 'rate.linehaul': d.linehaul, 'rate.all_in': d.allIn, 'pickup.window': d.pickupWin, 'accessorial.detention_per_hour': d.detention, 'payment.terms': d.payTerms };
    const B: Record<string, unknown> = { 'rate.linehaul': lhB, 'rate.all_in': lhB + d.fuel, 'pickup.window': winB, 'accessorial.detention_per_hour': detB, 'payment.terms': payB };
    const changed = [...changedKeys.rate, ...changedKeys.pickup, ...changedKeys.third];
    const reverted = changedKeys[revert];
    const live = (key: string) => (reverted.includes(key) ? A[key] : B[key]);
    const ev = (key: string) => (reverted.includes(key) ? [a, c] : [b, c]);
    const thirdKey = changedKeys.third[0];
    const otherThird = third === 'detention' ? 'payment.terms' : 'accessorial.detention_per_hour';
    const terms: OracleTerm[] = [
      cur(disp, 'rate.linehaul', live('rate.linehaul'), ev('rate.linehaul')),
      cur(disp, 'rate.fuel_surcharge', d.fuel, [a]),
      cur(disp, 'rate.all_in', live('rate.all_in'), ev('rate.all_in'), true),
      cur(disp, 'pickup.window', live('pickup.window'), ev('pickup.window'), true),
      cur(disp, thirdKey, live(thirdKey), ev(thirdKey), true),
      cur(disp, otherThird, A[otherThird], [a]),
      cur(disp, 'delivery.eta', d.appt, [a, b]),
      ...equipmentTerms(d, disp, [a]),
    ];
    const superseded: OracleSuperseded[] = changed.map((key) => (reverted.includes(key) ? dead(disp, key, B[key], [b], c) : dead(disp, key, A[key], [a], b)));
    const stale = changed.filter((key) => !reverted.includes(key));
    const LABEL: Record<string, string> = { 'rate.linehaul': 'linehaul', 'rate.all_in': 'all-in', 'pickup.window': 'pickup', 'accessorial.detention_per_hour': 'detention', 'payment.terms': 'payment terms' };
    const currentWords = changed.filter((x) => x !== 'rate.linehaul').map((key) => `${LABEL[key]} ${show(key, live(key))}`).join(', ');
    const deadWords = superseded.filter((x) => x.term !== 'rate.linehaul').map((x) => `${LABEL[x.term]} ${x.display}`).join(', ');

    const checkpoint: Checkpoint = {
      id: 'after_revert', after: c, now: t(0, '14:05'),
      state: {
        terms,
        superseded,
        open_loops: promise ? [{ kind: 'commitment', debtor: disp, subject: 'document.rate_confirmation', display: 'Carrier owes a revised rate con', evidence: [c] }] : [],
        closed_loops: [
          { kind: 'ask', debtor: disp, subject: 'rate.all_in', display: 'All-in rate (answered)', evidence: [a] },
          { kind: 'ask', debtor: disp, subject: 'document.rate_confirmation', display: 'Rate con (received)', evidence: [a] },
        ],
        conflicts: [],
        documents: [{ filename: file, status: 'partially_stale', stale_terms: stale, display: `${file}: ${stale.map((x) => LABEL[x]).join(', ')} superseded; ${reverted.map((x) => LABEL[x]).join('/')} is back to the rate con value; delivery and equipment unchanged` }],
        next_actor: 'us',
      },
      judge_facts: [
        `Original quote: ${moneyShort(d.allIn)} all-in, pickup ${show('pickup.window', d.pickupWin)}, ${third === 'detention' ? `detention ${moneyShort(d.detention)}/hr` : d.payTerms}.`,
        `A bundled re-quote changed all three (${moneyShort(lhB + d.fuel)} all-in, pickup ${show('pickup.window', winB)}, ${third === 'detention' ? `detention ${moneyShort(detB)}/hr` : payB}); then the ${LABEL[reverted[reverted.length - 1]]} went back to the original and the rest of the re-quote stands.`,
        `Current: ${currentWords}. Dead: ${deadWords}. Delivery ${show('delivery.eta', d.appt)} and equipment are unchanged. All current terms meet the requirements; the load is not booked yet.${promise ? ' A revised rate con is owed.' : ''}`,
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_carrier', text: 'Sends a message to the carrier dispatcher', det: { type: 'message_to', party: disp } },
          { id: 'right_terms', text: `Does not state any term differently from the current ones (${currentWords}); a message that restates no terms meets this, and naming a dead value only to reject or correct it is not stating it differently` },
        ],
        optional: [
          { id: 'book', text: 'Books the load on the current terms' },
          { id: 'ask_ratecon', text: 'Asks for a rate con that reflects the current terms' },
        ],
        prohibited: [
          { id: 'stale', text: staleText(`States or relies on a dead value as current (${deadWords})`), stale: true },
          { id: 'reask', text: reaskText('Asks the carrier to state or confirm again terms it has just stated', true) },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return freightCase(supersessionChain, variant, {
      description: `A → B (rate +${moneyShort(inc)}, pickup ${show('pickup.window', winB)}, ${third}) → C (${revert} reverts).`,
      task: d.task, mb, trigger: c, checkpoints: [checkpoint],
      params: { third, revert, inc, winB, detB, payB, k, promise, nBackground, nChatter, allIn: d.allIn, budget: d.budget },
    });
  },
};

export { freight };
