// Archetype: late evidence (P1).
//
// The supplier quotes (cc'ing an Acme colleague), then corrects one term in a follow-up sent only to
// us: the delivery date moves (still inside the deadline) or the unit price was mis-keyed. A day or two
// later the colleague, who never saw the correction, forwards the ORIGINAL quote email with its old
// date header and the old PDF, and says they are acting on it ("scheduling the line for Wednesday",
// "raising the PO at $11.40").
//
// Trap: the forward is the newest message and repeats the old value verbatim, so recency-based state
// or a summary refreshed on the latest message resurrects it. The oracle keeps the corrected value
// current, the old value superseded (the forward is just a copy of the superseded evidence), the old
// PDF stale on that term, and an open ask: we owe the colleague a correction.
import type { ActionCond, Archetype, BenchCase, BenchParty, Checkpoint, OracleDocument, OracleLoop, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, moneyShort, pdf, sayDate, seedOf, staleText } from '../../core/util.ts';
import { SIGNATURE, firstName, later, lotsDisplay, procurementBackground, procurementCase, procurementChatter, procurementDayStart, procurementDeal, quoteLines, round2, shortName } from './vertical.ts';

const REQUESTERS = ['Tom Reyes', 'Alicia Moreno', 'Ben Carter', 'Hana Kim'];

export const late_evidence: Archetype = {
  id: 'late_evidence',
  title: 'An old copy of a corrected quote is forwarded after the correction',
  capabilities: ['late_evidence', 'supersession', 'document_validity'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('procurement', 'late_evidence', variant));
    const g = variant === 0;
    const d = procurementDeal(r, variant);
    const { self, supplier, finance } = d.cast;
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => procurementDayStart(d, day, hhmm);

    // ---- parameters
    const corrected: 'delivery' | 'price' = g ? 'delivery' : r.pick(['delivery', 'price'] as const);
    const reqName = g ? REQUESTERS[0] : r.pick(REQUESTERS);
    const requester: BenchParty = { address: `${reqName.toLowerCase().replace(' ', '.')}@acme-buyer.example`, name: `${reqName} (Acme Plant Ops)`, role: 'internal', label: 'requester', authority: [] };
    const colleague = corrected === 'price' ? finance : g ? requester : r.chance(0.6) ? requester : finance;
    if (colleague === requester) d.task.parties.push(requester);
    const origOffset = g ? 3 : r.pick([2, 3]); // original promise: Wednesday or Thursday of the first week
    const day0 = addDays(d.start, origOffset);
    const day1 = origOffset === 3 || g ? d.deadline : r.pick([addDays(d.deadline, -1), d.deadline]); // corrected: later, still on time
    const price0 = d.price;
    const delta = r.pick([-0.3, -0.2, 0.1, 0.2]);
    const price1 = round2(price0 + delta <= d.budget ? price0 + delta : price0 - 0.2);
    const revised: 'attached' | 'promised' | 'none' = g ? 'attached' : r.pick(['attached', 'attached', 'promised', 'none'] as const);
    const ourAck = g ? false : r.chance(0.5);
    const withApproval = colleague === finance && (g ? false : r.chance(0.6));
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 3);
    const ref = g ? 'Q-2291' : `Q-${r.int(1000, 9999)}`;
    const v1 = `${d.company.split(' ')[0]}-Quote-${ref}.pdf`;
    const v2 = `${d.company.split(' ')[0]}-Quote-${ref}-rev1.pdf`;

    // ---- history
    const rfq = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], cc: [colleague.address], at: t(0, '08:30'),
      subject: `RFQ: ${d.qty} x ${d.item.sku} — ${d.alias}`,
      body: body(`Hi ${firstName(supplier)},`, `Please quote ${d.qty} ${d.item.name} for ${d.alias}; we need them by ${sayDate(d.deadline, 'weekday_short_date')} at the latest. Copying ${firstName(colleague)} from our ${colleague === finance ? 'finance' : 'plant'} team.`, `Thanks,\n${SIGNATURE}`),
    });
    let finAsk: string | null = null;
    let approval: string | null = null;
    if (withApproval) {
      finAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [finance.address], at: t(0, '08:45'), subject: `Budget approval — ${d.alias}`, body: body(`Hi ${firstName(finance)},`, `Can you approve up to ${moneyShort(d.budget)}/unit for ${d.alias}?`, SIGNATURE) });
      approval = mb.add({ direction: 'inbound', from: finance.address, fromName: shortName(finance), to: [self.address], at: t(0, '10:40'), subject: mb.reSubject(finAsk), replyTo: finAsk, body: body(`Approved up to ${moneyShort(d.budget)} per unit.`, firstName(finance)) });
    }
    const offerAt = t(0, g ? '11:20' : r.pick(['11:20', '13:05', '14:40']));
    const offerText = g
      ? `Happy to confirm: all ${d.qty} units ${sayDate(day0, 'weekday')} (${sayDate(day0, 'month_day').replace('October', 'Oct')}) at ${moneyShort(price0)} each, Net 30. Quote attached.`
      : r.pick([
        `We can deliver all ${d.qty} ${unit} on ${sayDate(day0, 'weekday')} at ${moneyShort(price0)}/unit, Net 30. Quote attached.`,
        `Quote attached: ${moneyShort(price0)} per unit, the full ${d.qty} delivered ${sayDate(day0, 'weekday_short_date')}, payment Net 30.`,
        `${d.qty} x ${d.item.sku}: ${moneyShort(price0)} each, delivery ${sayDate(day0, 'weekday')}, Net 30. Formal quote attached.`,
      ]);
    const offerBody = body('Hi,', offerText, `${shortName(supplier)}\n${d.company}`);
    const v1Lines = quoteLines(d, { ref, date: d.start, price: price0, deliveryLine: `${d.qty} units by ${sayDate(day0, 'long')}` });
    const offer = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], cc: [colleague.address], at: offerAt,
      subject: mb.reSubject(rfq), replyTo: rfq, body: offerBody,
      attachments: [pdf(v1, v1Lines)],
    });
    procurementBackground(r, d, mb, t(0, '09:30'), nBackground, g ? 0 : r.int(0, 6));

    const fixAt = t(1, g ? '09:40' : r.pick(['09:10', '09:40', '13:25']));
    const fixText = corrected === 'delivery'
      ? (g
        ? `Correction: delivery will be ${sayDate(day1, 'weekday')}, not ${sayDate(day0, 'weekday')}. Our carrier can't make the earlier slot. Price and payment terms are unchanged.`
        : r.pick([
          `Correction to yesterday's quote: the ${d.qty} ${unit} will arrive ${sayDate(day1, 'weekday')} instead of ${sayDate(day0, 'weekday')}. Everything else stands.`,
          `Sorry, I need to correct the delivery date: it's ${sayDate(day1, 'weekday_short_date')}, not ${sayDate(day0, 'weekday_short_date')}. Price unchanged.`,
          `Our carrier moved us: delivery is now ${sayDate(day1, 'weekday')} (was ${sayDate(day0, 'weekday')}). Other terms as quoted.`,
        ]))
      : r.pick([
        `Correction: the unit price on our quote was mis-keyed. It should be ${moneyShort(price1)}, not ${moneyShort(price0)}. Delivery and payment are unchanged.`,
        `Apologies, our quote had the wrong price. The correct unit price is ${moneyShort(price1)} (not ${moneyShort(price0)}). Everything else stands.`,
        `Please note a correction: ${moneyShort(price1)}/unit is the right price for ${d.alias}; the ${moneyShort(price0)} on the PDF was a typo.`,
      ]);
    const v2Lines = quoteLines(d, { ref, date: addDays(d.start, 1), revision: 'Rev 1', price: corrected === 'price' ? price1 : price0, deliveryLine: `${d.qty} units by ${sayDate(corrected === 'delivery' ? day1 : day0, 'long')}` });
    const fix = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: fixAt,
      subject: mb.reSubject(rfq), replyTo: offer,
      body: body('Hi,', fixText, revised === 'attached' ? 'Revised quote attached.' : revised === 'promised' ? "I'll send a revised quote shortly." : null, firstName(supplier)),
      attachments: revised === 'attached' ? [pdf(v2, v2Lines)] : undefined,
      note: 'sent to us only; the colleague was not copied',
    });
    if (ourAck) mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: later(fixAt, 50), subject: mb.reSubject(rfq), replyTo: fix, body: body(`Hi ${firstName(supplier)},`, 'Thanks for letting me know, noted.', SIGNATURE), note: 'state-neutral' });
    procurementChatter(r, d, mb, t(1, '14:30'), nChatter, g ? 0 : r.int(0, 9));

    // ---- the late copy
    // the late copy always arrives before the old date it repeats (otherwise the old date would be moot)
    const fwdAt = g ? t(2, '10:05') : origOffset === 2 ? t(1, r.pick(['16:20', '17:05'])) : r.pick([t(1, '16:40'), t(2, '08:50'), t(2, '10:05')]);
    const oldValue = corrected === 'delivery' ? sayDate(day0, 'weekday_short_date') : moneyShort(price0);
    const newValue = corrected === 'delivery' ? sayDate(day1, 'weekday_short_date') : moneyShort(price1);
    const comment = corrected === 'price'
      ? r.pick([
        `Raising the PO in the system now at ${moneyShort(price0)} x ${d.qty} per the quote below. Correct?`,
        `Attaching ${d.company}'s quote for the PO file. I'll book the spend at ${moneyShort(price0)}/unit unless you tell me otherwise.`,
        `Found this in my inbox. Are we still at ${moneyShort(price0)}? I'd like to commit the spend today.`,
      ])
      : colleague === requester
        ? (g
          ? `Great news below. I'm scheduling the line to start ${sayDate(day0, 'weekday')} when all ${d.qty} arrive. Can you confirm?`
          : r.pick([
            `Planning the build for ${sayDate(day0, 'weekday')} based on this. Shout if anything changed.`,
            `Just to double-check: we're getting all ${d.qty} on ${sayDate(day0, 'weekday')}, right? Need to book the crew.`,
            `Per the email below I've told the line to expect everything ${sayDate(day0, 'weekday')}.`,
          ]))
        : r.pick([
          `Booking receiving dock 3 for ${sayDate(day0, 'weekday')} per the quote below. OK?`,
          `For the PO file. I'll set the receiving date to ${sayDate(day0, 'weekday')} as per below unless you say otherwise.`,
        ]);
    const header = [
      '---------- Forwarded message ---------',
      `From: ${shortName(supplier)} <${supplier.address}>`,
      `Date: ${sayDate(offerAt, 'weekday').slice(0, 3)}, ${sayDate(offerAt, 'month_day').replace(/^(\w{3})\w*/, '$1')}, 2026 at ${Number(offerAt.slice(11, 13)) % 12 || 12}:${offerAt.slice(14, 16)} ${Number(offerAt.slice(11, 13)) >= 12 ? 'PM' : 'AM'}`,
      `Subject: ${mb.get(offer).subject}`,
      `To: ${self.address}`,
      `Cc: ${colleague.address}`,
    ].join('\n');
    const fwd = mb.add({
      direction: 'inbound', from: colleague.address, fromName: shortName(colleague), to: [self.address], at: fwdAt,
      subject: `Fwd: ${mb.get(offer).subject}`,
      body: body('Hi,', comment, firstName(colleague), `${header}\n\n${offerBody}`),
      attachments: [pdf(v1, v1Lines)],
      quoteParent: false,
      note: 'late copy of the original (pre-correction) quote',
    });

    // ---- oracle
    const sched0 = [{ qty: d.qty, date: day0 }];
    const sched1 = [{ qty: d.qty, date: day1 }];
    const isD = corrected === 'delivery';
    const term = isD ? 'delivery.schedule' : 'price.unit';
    const terms: OracleTerm[] = [
      { party: supplier.address, term: 'price.unit', status: 'current', value: isD ? price0 : price1, evidence: isD ? [offer, fix, fwd] : [fix], critical: true, display: moneyShort(isD ? price0 : price1) },
      { party: supplier.address, term: 'delivery.schedule', status: 'current', value: isD ? sched1 : sched0, evidence: isD ? [fix] : [offer, fix, fwd], critical: true, display: lotsDisplay(isD ? sched1 : sched0) },
      { party: supplier.address, term: 'payment.terms', status: 'current', value: 'Net 30', evidence: [offer, fix, fwd], display: 'Net 30' },
    ];
    if (approval) terms.push({ party: finance.address, term: 'budget.max_unit_price', status: 'current', value: d.budget, evidence: [approval], display: moneyShort(d.budget) });
    const oldDisplay = isD ? lotsDisplay(sched0) : moneyShort(price0);
    const newDisplay = isD ? lotsDisplay(sched1) : moneyShort(price1);
    const open_loops: OracleLoop[] = [
      { kind: 'ask', debtor: self.address, subject: term, display: `${firstName(colleague)} is acting on the old ${isD ? 'delivery date' : 'price'} (${oldDisplay}) and needs the corrected value`, evidence: [fwd], critical: true },
    ];
    if (revised === 'promised') open_loops.push({ kind: 'commitment', debtor: supplier.address, subject: 'document.quote', display: 'Supplier owes a revised quote', evidence: [fix] });
    const closed_loops: OracleLoop[] = [
      { kind: 'ask', debtor: supplier.address, subject: 'document.quote', alt_subjects: ['price.unit'], display: 'Quote (received)', evidence: [rfq, offer] },
    ];
    if (finAsk && approval) closed_loops.push({ kind: 'ask', debtor: finance.address, subject: 'budget.max_unit_price', alt_subjects: ['approval.budget'], display: 'Budget approval (given)', evidence: [finAsk, approval] });
    const documents: OracleDocument[] = [{ filename: v1, status: 'partially_stale', stale_terms: [term], display: `${v1}: ${isD ? 'delivery date' : 'unit price'} superseded by the correction; other terms current` }];
    if (revised === 'attached') documents.push({ filename: v2, status: 'current', stale_terms: [], display: `${v2}: current` });

    const prohibited: ActionCond[] = [
      { id: 'confirms_old', text: staleText(`Confirms or repeats ${oldValue} as the current ${isD ? 'delivery date' : 'unit price'}`), stale: true },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    if (revised === 'promised') prohibited.push({ id: 'claims_revised_arrived', text: 'Says the revised quote has already been received' });
    const checkpoint: Checkpoint = {
      id: 'after_late_copy', after: fwd, now: later(fwdAt, 20),
      state: { terms, superseded: [{ party: supplier.address, term, value: isD ? sched0 : price0, display: oldDisplay, evidence: [offer, fwd], superseded_by: fix }], open_loops, closed_loops, conflicts: [], documents, next_actor: 'us' },
      judge_facts: [
        `The original quote from ${d.company} said ${isD ? `all ${d.qty} on ${sayDate(day0, 'weekday_short_date')}` : `${moneyShort(price0)}/unit`}; the supplier later corrected it to ${newDisplay}${revised === 'attached' ? ' (with a revised PDF)' : ''}.`,
        `${shortName(colleague)} has just forwarded the ORIGINAL quote (dated before the correction) and is acting on ${oldValue}; they never saw the correction.`,
        `The corrected value ${newDisplay} is current and still meets Acme's requirements.`,
        revised === 'promised' ? 'The revised quote document has not arrived yet.' : null,
      ].filter(Boolean).join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_colleague', text: `Replies to ${firstName(colleague)}`, det: { type: 'message_to', party: colleague.address } },
          { id: 'corrects_colleague', text: `Tells ${firstName(colleague)} the current ${isD ? 'delivery date' : 'unit price'} is ${newValue}, not ${oldValue} (the forwarded quote is outdated)` },
        ],
        optional: [{ id: 'points_to_revision', text: revised === 'attached' ? 'Points them to (or forwards) the revised quote' : 'Mentions that the supplier corrected the quote by email' }],
        prohibited,
      },
    };

    return procurementCase(late_evidence, variant, {
      description: `${isD ? 'Delivery' : 'Price'} corrected ${oldDisplay} → ${newDisplay}; ${colleague.label} later forwards the pre-correction quote and acts on it.`,
      task: d.task, mb, trigger: fwd, checkpoint,
      params: { corrected, colleague: colleague.label, day0, day1, price0, price1, revised, ourAck, withApproval, origOffset, nBackground, nChatter, ref, qty: d.qty, budget: d.budget, deadline: d.deadline },
    });
  },
};
