// Archetype: stale document (P0).
//
// The carrier sends a rate con with eight-plus terms (linehaul, fuel, all-in, pickup, delivery, equipment,
// detention, payment terms, remit-to). A later email changes exactly one or two of them — fuel surcharge (which
// moves the all-in with it), linehaul (ditto), detention, payment terms, or detention + payment terms — and says
// everything else on the rate con stands.
//
// Trap: document-level reasoning marks the rate con either "current" (keeps the old fuel / detention) or
// "replaced" (forgets the pickup window, equipment and delivery it still carries). Oracle: graded per term — the
// changed terms are current from the email and their rate-con values are superseded; every other term is still
// current from the rate con; the rate con is partially stale with exactly the changed terms.
import type { Archetype, BenchCase, Checkpoint, OracleSuperseded, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, body, moneyShort, pdf, reaskText, seedOf, staleText } from '../../core/util.ts';
import {
  cur, dead, equipmentTerms, firstName, freight, freightBackground, freightCase, freightChatter, freightDayStart, freightDeal, personName, quoteText,
  rateConFile, rateConLines, rfqBody, show, signDispatch, signUs,
} from './vertical.ts';

type Change = 'fuel' | 'linehaul' | 'detention' | 'payment' | 'detention_payment';

const LABEL: Record<string, string> = {
  'rate.linehaul': 'linehaul', 'rate.fuel_surcharge': 'fuel surcharge', 'rate.all_in': 'all-in rate',
  'accessorial.detention_per_hour': 'detention rate', 'payment.terms': 'payment terms',
};

export const staleDocument: Archetype = {
  id: 'stale_document',
  title: 'An email changes one or two terms of the rate con',
  capabilities: ['document_validity', 'supersession'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('freight', 'stale_document', variant));
    const g = variant === 0;
    const d = freightDeal(r, variant);
    const { self, dispatcher } = d.cast;
    const disp = dispatcher.address;

    // ---- parameters
    const change: Change = g ? 'fuel' : r.pick(['fuel', 'linehaul', 'detention', 'payment', 'detention_payment'] as const);
    const fuel2 = d.fuel + (g ? 45 : r.pick([35, 45, 60]));
    const lh2 = d.linehaul + (g ? 50 : r.pick([25, 50, 75].filter((x) => d.linehaul + d.fuel + x <= d.budget)));
    const det2 = r.pick([50, 60, 85, 100].filter((x) => x !== d.detention));
    const pay2 = d.payTerms === 'Net 30' ? 'Quick pay 2%, 5 days' : 'Net 30';
    const k = g ? 0 : r.int(0, 3);
    const thanks = g ? true : r.chance(0.6);
    const promises = g ? false : r.chance(0.5);
    const standsStyle = g ? 0 : r.int(0, 2);
    const nBackground = g ? 2 : r.int(2, 7);
    const nChatter = g ? 1 : r.int(0, 3);
    const file = rateConFile(d);

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => freightDayStart(d, day, hhmm);

    // ---- history
    const rfq = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [disp], at: t(0, '08:05'), subject: `${d.alias} — ${d.lane.origin} to ${d.lane.dest}`, body: rfqBody(r, d, g, dispatcher) });
    const quote = mb.add({
      direction: 'inbound', from: disp, fromName: personName(dispatcher), to: [self.address], at: t(0, '09:50'), subject: mb.reSubject(rfq), replyTo: rfq,
      body: body('Hi,', quoteText(r, d, g, k), `Detention is ${moneyShort(d.detention)}/hr after 2 hours, terms ${d.payTerms}.`, signDispatch(d)),
      attachments: [pdf(file, rateConLines(d, { date: d.start }))],
    });
    let last = quote;
    if (thanks) {
      last = mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [disp], at: t(0, '10:20'), subject: mb.reSubject(quote), replyTo: quote,
        body: body(`Thanks ${firstName(dispatcher)},`, g ? 'Running it by my customer now, will get back to you shortly.' : r.pick(['Running it by my customer now, will get back to you shortly.', 'Got it, reviewing on our side. Back to you soon.', 'Thanks for the quick turn. Checking with the shipper and will circle back.']), signUs(r, g)),
      });
    }
    freightBackground(r, d, mb, t(0, '10:30'), nBackground);
    freightChatter(r, d, mb, t(0, '11:00'), nChatter);

    const stands = ['Everything else on the rate con stands.', 'All other terms are as per the rate con.', 'Rest of the rate con is unchanged.'][standsStyle];
    const text: Record<Change, string> = {
      fuel: g
        ? `Quick update on ${d.alias}: diesel jumped this morning, so our fuel surcharge goes to ${moneyShort(fuel2)}. That makes it ${moneyShort(d.linehaul + fuel2)} all-in.`
        : r.pick([
          `Fuel update on ${d.alias}: with the new DOE index our FSC is ${moneyShort(fuel2)}, so ${moneyShort(d.linehaul + fuel2)} all-in.`,
          `Need to adjust fuel on ${d.alias} — diesel's up. Fuel surcharge ${moneyShort(fuel2)}, new all-in ${moneyShort(d.linehaul + fuel2)}.`,
          `Heads up, our fuel surcharge on ${d.alias} is now ${moneyShort(fuel2)} (was ${moneyShort(d.fuel)}). All-in comes to ${moneyShort(d.linehaul + fuel2)}.`,
        ]),
      linehaul: r.pick([
        `My manager needs ${moneyShort(lh2 - d.linehaul)} more on the linehaul for ${d.alias} because of the tolls on that route: linehaul ${moneyShort(lh2)}, ${moneyShort(lh2 + d.fuel)} all-in.`,
        `Small change on ${d.alias}: linehaul has to be ${moneyShort(lh2)}, so all-in is ${moneyShort(lh2 + d.fuel)}.`,
        `Re-priced ${d.alias} with the deadhead: ${moneyShort(lh2)} linehaul, ${moneyShort(lh2 + d.fuel)} all in.`,
      ]),
      detention: r.pick([
        `Correction on the ${d.alias} rate con: our detention is ${moneyShort(det2)}/hr after 2 hours, not ${moneyShort(d.detention)}.`,
        `One fix for ${d.alias}: detention should read ${moneyShort(det2)} per hour (2 hrs free). The rate con has the old number.`,
        `Accounting flagged the detention on ${d.alias} — it's ${moneyShort(det2)}/hr after two hours.`,
      ]),
      payment: r.pick([
        `Our accounting tells me ${d.alias} needs to be on ${pay2} instead of ${d.payTerms}.`,
        `One change on ${d.alias}: payment terms are ${pay2}.`,
        `Please note payment terms for ${d.alias} are ${pay2}, not what the rate con says.`,
      ]),
      detention_payment: r.pick([
        `Two fixes on ${d.alias}: detention is ${moneyShort(det2)}/hr after 2 hours, and payment terms are ${pay2}.`,
        `Accounting corrected two things on ${d.alias}: ${pay2} for payment, and ${moneyShort(det2)}/hr detention.`,
        `Please update ${d.alias}: detention ${moneyShort(det2)} per hour (2 free), terms ${pay2}.`,
      ]),
    };
    const update = mb.add({
      direction: 'inbound', from: disp, fromName: personName(dispatcher), to: [self.address], at: t(0, '15:35'), subject: mb.reSubject(rfq), replyTo: last,
      body: body('Hi,', text[change], `${stands}${promises ? ` ${r.pick(["I'll send an updated rate con.", "Updated rate con to follow.", "I'll get you a revised rate con shortly."])}` : ''}`, firstName(dispatcher)),
    });

    // ---- oracle
    const lh = change === 'linehaul' ? lh2 : d.linehaul;
    const fuel = change === 'fuel' ? fuel2 : d.fuel;
    const det = change === 'detention' || change === 'detention_payment' ? det2 : d.detention;
    const pay = change === 'payment' || change === 'detention_payment' ? pay2 : d.payTerms;
    const changed: string[] = {
      fuel: ['rate.fuel_surcharge', 'rate.all_in'], linehaul: ['rate.linehaul', 'rate.all_in'], detention: ['accessorial.detention_per_hour'],
      payment: ['payment.terms'], detention_payment: ['accessorial.detention_per_hour', 'payment.terms'],
    }[change];
    const ev = (key: string) => (changed.includes(key) ? [update] : [quote, update]);
    const oldValue: Record<string, unknown> = { 'rate.linehaul': d.linehaul, 'rate.fuel_surcharge': d.fuel, 'rate.all_in': d.allIn, 'accessorial.detention_per_hour': d.detention, 'payment.terms': d.payTerms };
    const newValue: Record<string, unknown> = { 'rate.linehaul': lh, 'rate.fuel_surcharge': fuel, 'rate.all_in': lh + fuel, 'accessorial.detention_per_hour': det, 'payment.terms': pay };
    const terms: OracleTerm[] = [
      cur(disp, 'rate.linehaul', lh, ev('rate.linehaul')),
      cur(disp, 'rate.fuel_surcharge', fuel, ev('rate.fuel_surcharge')),
      cur(disp, 'rate.all_in', lh + fuel, ev('rate.all_in'), true),
      cur(disp, 'pickup.window', d.pickupWin, ev('pickup.window'), true),
      cur(disp, 'delivery.eta', d.appt, ev('delivery.eta'), true),
      ...equipmentTerms(d, disp, ev('equipment.type'), true),
      cur(disp, 'accessorial.detention_per_hour', det, ev('accessorial.detention_per_hour'), changed.includes('accessorial.detention_per_hour')),
      cur(disp, 'payment.terms', pay, ev('payment.terms'), changed.includes('payment.terms')),
      cur(disp, 'payment.remit_to', d.carrier.remit, ev('payment.remit_to')),
    ];
    const superseded: OracleSuperseded[] = changed.map((key) => dead(disp, key, oldValue[key], [quote], update));
    const changeWords = changed.map((key) => `${LABEL[key]} ${show(key, newValue[key])} (was ${show(key, oldValue[key])})`).join(' and ');

    const checkpoint: Checkpoint = {
      id: 'after_update', after: update, now: t(0, '15:50'),
      state: {
        terms,
        superseded,
        open_loops: promises ? [{ kind: 'commitment', debtor: disp, subject: 'document.rate_confirmation', display: 'Carrier owes an updated rate con', evidence: [update] }] : [],
        closed_loops: [
          { kind: 'ask', debtor: disp, subject: 'rate.all_in', display: 'All-in rate (answered)', evidence: [quote] },
          { kind: 'ask', debtor: disp, subject: 'document.rate_confirmation', display: 'Rate con (received)', evidence: [quote] },
        ],
        conflicts: [],
        documents: [{ filename: file, status: 'partially_stale', stale_terms: changed, display: `${file}: ${changed.map((x) => LABEL[x]).join(' and ')} superseded; pickup, delivery, equipment and the rest still current` }],
        next_actor: 'us',
      },
      judge_facts: [
        `The carrier changed ${changeWords} by email and said the rest of the rate con stands.`,
        `Still current from the rate con: pickup ${show('pickup.window', d.pickupWin)}, delivery ${show('delivery.eta', d.appt)}, ${show('equipment.type', d.equipment)}${d.tempF !== null ? ` at ${show('equipment.reefer_temp_f', d.tempF)}` : ''}${changed.includes('accessorial.detention_per_hour') ? '' : `, detention ${show('accessorial.detention_per_hour', d.detention)}`}${changed.includes('payment.terms') ? '' : `, ${d.payTerms}`}${changed.includes('rate.all_in') ? '' : `, ${moneyShort(d.allIn)} all-in`}.`,
        `The current all-in (${moneyShort(lh + fuel)}) is within the ${moneyShort(d.budget)} maximum. The load is not booked yet.${promises ? ' The carrier promised an updated rate con, not yet received.' : ''}`,
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_carrier', text: 'Sends a message to the carrier dispatcher', det: { type: 'message_to', party: disp } },
          { id: 'ack_change', text: `Acknowledges or works from the updated ${changed.map((x) => `${LABEL[x]} (${show(x, newValue[x])})`).join(' and ')}` },
        ],
        optional: [
          { id: 'book', text: `Books the load at the updated terms (${moneyShort(lh + fuel)} all-in)` },
          { id: 'ask_ratecon', text: 'Asks for an updated rate con that reflects the change' },
        ],
        prohibited: [
          { id: 'stale_terms', text: staleText(`States or relies on the rate con's original ${changed.map((x) => `${LABEL[x]} (${show(x, oldValue[x])})`).join(' or ')} as current`), stale: true },
          { id: 'void_doc', text: reaskText('Treats the rate con as void: asks the carrier to re-quote the whole load, or to state or confirm again the unchanged pickup, delivery or equipment terms', true) },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return freightCase(staleDocument, variant, {
      description: `Rate con with ${terms.length} terms; an email changes ${changed.join(' + ')}; the rest stands.`,
      task: d.task, mb, trigger: update, checkpoints: [checkpoint],
      params: { change, changed, fuel2, lh2, det2, pay2, k, thanks, promises, standsStyle, nBackground, nChatter, allIn: d.allIn, budget: d.budget },
    });
  },
};

export { freight };
