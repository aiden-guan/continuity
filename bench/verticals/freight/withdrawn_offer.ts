// Archetype: withdrawn offer (P1).
//
// The dispatcher quotes the load with a rate con; ops may approve the budget; we tell the carrier we are checking
// with the customer. Then the carrier falls off the load: the truck broke down, the driver went home sick, the
// fleet rebooked the truck, or the dispatcher simply withdraws the quote.
//
// Trap: the rate con is still in the mailbox with a clean rate, pickup and equipment, and a summary written before
// the withdrawal says "carrier quoted $X, ready to book". Oracle: the carrier's rate, pickup, delivery and
// equipment are absent (history only), offer.status = withdrawn, the conflict is offer_unavailable and the rate con
// is withdrawn. The ops budget survives (it is not tied to that carrier). Booking or "confirming" the old quote is
// a stale violation; the right move is to treat the load as uncovered and start recovery. The quote's values are
// also listed as superseded by the withdrawal (as in procurement / hotel), so reporting one as current is a
// superseded-fact error as well as a CSA miss.
import type { Archetype, BenchCase, Checkpoint } from '../../core/types.ts';
import { MailBuilder, Rand, body, moneyShort, pdf, seedOf, staleText } from '../../core/util.ts';
import {
  absent, approvalBody, budgetAskBody, cur, dead, firstName, freight, freightBackground, freightCase, freightChatter, freightDayStart, freightDeal, personName,
  quoteText, rateConFile, rateConLines, rfqBody, show, signDispatch, signUs,
} from './vertical.ts';

export const withdrawnOffer: Archetype = {
  id: 'withdrawn_offer',
  title: 'Carrier falls off the load',
  capabilities: ['lifecycle'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('freight', 'withdrawn_offer', variant));
    const g = variant === 0;
    const d = freightDeal(r, variant);
    const { self, dispatcher, ops } = d.cast;
    const disp = dispatcher.address;

    // ---- parameters
    const withApproval = g ? true : r.chance(0.6);
    const holding = g ? true : r.chance(0.6);
    const style = g ? 0 : r.int(0, 3);
    const k = g ? 0 : r.int(0, 3);
    const nBackground = g ? 2 : r.int(2, 7);
    const nChatter = g ? 0 : r.int(0, 3);
    const file = rateConFile(d);
    const pOff = Math.round((Date.parse(d.pickupDay) - Date.parse(d.start)) / 86_400_000);

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => freightDayStart(d, day, hhmm);

    // ---- history
    const rfq = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [disp], at: t(0, '08:00'), subject: `${d.alias} — ${d.lane.origin} to ${d.lane.dest}`, body: rfqBody(r, d, g, dispatcher) });
    const ask = withApproval ? mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ops.address], at: t(0, '08:04'), subject: `Carrier budget approval — ${d.alias}`, body: budgetAskBody(r, d, g) }) : null;
    const quote = mb.add({
      direction: 'inbound', from: disp, fromName: personName(dispatcher), to: [self.address], at: t(0, '09:35'), subject: mb.reSubject(rfq), replyTo: rfq,
      body: body('Hi,', quoteText(r, d, g, k), signDispatch(d)),
      attachments: [pdf(file, rateConLines(d, { date: d.start }))],
    });
    const approval = ask ? mb.add({ direction: 'inbound', from: ops.address, fromName: personName(ops), to: [self.address], at: t(0, '11:10'), subject: mb.reSubject(ask), replyTo: ask, body: approvalBody(r, d, g) }) : null;
    let last = quote;
    if (holding) {
      last = mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [disp], at: t(0, '11:30'), subject: mb.reSubject(quote), replyTo: quote,
        body: body(`Thanks ${firstName(dispatcher)} — ${g ? 'looks good, I just need the customer to sign off. Will come back to you this afternoon.' : r.pick(['checking with the shipper, back to you shortly.', 'running it by my customer now.', 'give me a little time to confirm on our side.'])}`, signUs(r, g)),
      });
    }
    freightBackground(r, d, mb, t(0, '09:50'), nBackground);
    freightChatter(r, d, mb, t(0, '12:00'), nChatter);

    const text = [
      `Bad news on ${d.alias}: the truck I had for you broke down outside ${d.lane.origin.split(',')[0]} and needs a new injector. I have to cancel on this one, sorry — nothing else close by.`,
      `I have to fall off ${d.alias}. My driver went home sick and I don't have anyone to cover. Really sorry for the short notice.`,
      `We need to pass on ${d.alias} after all — our contract customer's load ran late and I can't protect yours. Please don't count on us for this one.`,
      `Please disregard my quote on ${d.alias}; our fleet manager rebooked that truck. We can't cover it.`,
    ][style];
    const withdrawal = mb.add({
      direction: 'inbound', from: disp, fromName: personName(dispatcher), to: [self.address], at: t(pOff - 1, pOff - 1 === 0 ? '15:20' : '08:15'), subject: mb.reSubject(rfq), replyTo: last,
      body: body('Hi,', text, g ? 'Carla' : firstName(dispatcher)),
    });

    // ---- oracle
    const checkpoint: Checkpoint = {
      id: 'after_withdrawal', after: withdrawal, now: t(pOff - 1, pOff - 1 === 0 ? '15:35' : '08:30'),
      state: {
        terms: [
          cur(disp, 'offer.status', 'withdrawn', [withdrawal], true),
          absent(disp, 'rate.all_in', `${moneyShort(d.allIn)} all-in (withdrawn; history only)`, [quote], true),
          absent(disp, 'rate.linehaul', `${moneyShort(d.linehaul)} (withdrawn)`, [quote]),
          absent(disp, 'rate.fuel_surcharge', `${moneyShort(d.fuel)} (withdrawn)`, [quote]),
          absent(disp, 'pickup.window', `${show('pickup.window', d.pickupWin)} (withdrawn)`, [quote], true),
          absent(disp, 'delivery.eta', `${show('delivery.eta', d.appt)} (withdrawn)`, [quote]),
          absent(disp, 'equipment.type', `${show('equipment.type', d.equipment)} (withdrawn)`, [quote]),
          ...(d.tempF !== null ? [absent(disp, 'equipment.reefer_temp_f', `${show('equipment.reefer_temp_f', d.tempF)} (withdrawn)`, [quote])] : []),
          ...(approval ? [cur(ops.address, 'budget.max_all_in', d.budget, [approval], true)] : []),
        ],
        // the withdrawn quote's values are dead: reporting one as current is also a superseded-fact error
        superseded: [
          dead(disp, 'rate.all_in', d.allIn, [quote], withdrawal),
          dead(disp, 'rate.linehaul', d.linehaul, [quote], withdrawal),
          dead(disp, 'rate.fuel_surcharge', d.fuel, [quote], withdrawal),
          dead(disp, 'pickup.window', d.pickupWin, [quote], withdrawal),
          dead(disp, 'delivery.eta', d.appt, [quote], withdrawal),
          dead(disp, 'equipment.type', d.equipment, [quote], withdrawal),
          ...(d.tempF !== null ? [dead(disp, 'equipment.reefer_temp_f', d.tempF, [quote], withdrawal)] : []),
        ],
        open_loops: [],
        closed_loops: [
          { kind: 'ask', debtor: disp, subject: 'rate.all_in', display: 'All-in rate (answered, then withdrawn)', evidence: [quote] },
          { kind: 'ask', debtor: disp, subject: 'document.rate_confirmation', display: 'Rate con (received, then withdrawn)', evidence: [quote] },
          ...(approval ? [{ kind: 'ask' as const, debtor: ops.address, subject: 'budget.max_all_in', alt_subjects: ['approval.budget'], display: 'Budget approval (given)', evidence: [approval] }] : []),
        ],
        conflicts: [{ kind: 'offer_unavailable', term: 'offer.status', party: disp, display: `${d.carrier.company} fell off ${d.alias}; its quote is no longer available`, critical: true }],
        documents: [{ filename: file, status: 'withdrawn', stale_terms: [], display: `${file}: withdrawn with the carrier's quote` }],
        next_actor: 'us',
      },
      judge_facts: [
        `${d.carrier.company} quoted ${moneyShort(d.allIn)} all-in for ${d.alias} but then cancelled / withdrew (falling off the load); the quote and its rate con are dead and the load is NOT covered.`,
        approval ? `The ops approval of up to ${moneyShort(d.budget)} all-in still stands for a replacement carrier.` : `The maximum all-in for the load is ${moneyShort(d.budget)}.`,
        `The shipper still needs pickup ${show('pickup.window', d.reqPickup)} and delivery by ${show('delivery.eta', d.appt)}.`,
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'recovery', text: "Treats the load as uncovered: tells Acme ops the carrier fell off and/or asks the carrier whether it has a replacement truck, or states that another carrier will be sourced" },
        ],
        optional: [
          { id: 'tell_ops', text: 'Tells ops the carrier fell off the load', det: { type: 'message_to', party: ops.address } },
          { id: 'ack_carrier', text: 'Acknowledges the cancellation to the carrier' },
        ],
        prohibited: [
          { id: 'binding_book', text: staleText('Books or confirms the cancelled load with the carrier'), det: { type: 'binding_to', party: disp }, stale: true },
          { id: 'claims_covered', text: staleText(`Says the load is covered by ${d.carrier.company} or treats the ${moneyShort(d.allIn)} quote as still available`), stale: true },
          { id: 'hold_to_ratecon', text: 'Insists the carrier is bound by the rate con it withdrew' },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return freightCase(withdrawnOffer, variant, {
      description: `Carrier quotes ${moneyShort(d.allIn)} all-in with a rate con, then falls off the load (style ${style}); ${withApproval ? 'ops budget approved' : 'no ops thread'}.`,
      task: d.task, mb, trigger: withdrawal, checkpoints: [checkpoint],
      params: { withApproval, holding, style, k, nBackground, nChatter, allIn: d.allIn, budget: d.budget },
    });
  },
};

export { freight };
