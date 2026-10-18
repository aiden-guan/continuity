// Archetype: stale document (P0).
//
// The supplier sends a quote PDF that carries five terms (unit price, quantity, delivery lots, payment
// terms, validity). A later email changes exactly one or two of them and says the rest stands ("Price
// and payment terms remain unchanged" / "everything else as quoted").
//
// Trap: documents are graded per term. Calling the PDF "current" keeps the dead value alive; calling it
// "superseded" throws away terms that are still valid and makes the agent re-ask them. The oracle marks
// the PDF partially_stale with exactly the changed terms, keeps the unchanged ones current (citing both
// the PDF and the email that restated them) and lists only the changed values as superseded. When the
// change breaks a hard requirement (a lot now lands after the deadline, or the price goes over budget)
// the agent must push back; otherwise any action is fine as long as it uses the new values.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleConflict, OracleLoop, OracleSuperseded, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addBusinessDays, addDays, body, moneyShort, nextWeekday, pdf, reaskText, sayDate, seedOf, staleText, type DateStyle } from '../../core/util.ts';
import { type Lot, SIGNATURE, firstName, lotsDisplay, lotsLine, procurementBackground, procurementCase, procurementChatter, procurementDayStart, procurementDeal, quoteLines, round2, sayFrom, shortName, withDeadline } from './vertical.ts';

type Change = 'delivery' | 'price' | 'payment' | 'validity';
const TERM: Record<Change, string> = { delivery: 'delivery.schedule', price: 'price.unit', payment: 'payment.terms', validity: 'quote.valid_until' };
const NAME: Record<Change, string> = { delivery: 'delivery', price: 'price', payment: 'payment terms', validity: 'validity' };

export const stale_document: Archetype = {
  id: 'stale_document',
  title: 'One or two terms of a quote PDF change by email',
  capabilities: ['document_validity', 'supersession'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('procurement', 'stale_document', variant));
    const g = variant === 0;
    const base = procurementDeal(r, variant);
    const { self, supplier, finance } = base.cast;
    const unit = base.item.unit;
    const fri = base.deadline; // first lot lands on the Friday of the first week
    const mon = addDays(base.start, 7);

    // ---- parameters
    const twoLots = g ? true : r.chance(0.7);
    const firstQty = g ? 300 : Math.round((base.qty * r.pick([0.5, 0.6, 0.7, 0.8])) / 10) * 10;
    const lots0: Lot[] = twoLots ? [{ qty: firstQty, date: fri }, { qty: base.qty - firstQty, date: mon }] : [{ qty: base.qty, date: fri }];
    const lastDate = lots0.at(-1)!.date;
    const changes: Change[] = g ? ['delivery'] : r.pick<Change[]>([['delivery'], ['delivery'], ['delivery'], ['price'], ['payment'], ['validity'], ['delivery', 'validity'], ['price', 'payment'], ['delivery', 'payment']]);
    const slip = g ? 2 : r.int(1, 3); // business days the last lot moves
    const newLast = addBusinessDays(lastDate, slip);
    const tight = g ? true : variant % 3 !== 0; // balanced across variants // requirement = original last-lot date (any slip breaks it) vs a later Friday
    const reqDeadline = tight ? lastDate : nextWeekday(addDays(newLast, 1), 5);
    const d = withDeadline(base, reqDeadline);
    const payment0 = g ? 'Net 30' : r.pick(['Net 30', 'Net 30', 'Net 45', 'Net 60']);
    const payment1 = r.pick(['Net 15', 'Net 30', 'Net 45'].filter((p) => Number(p.slice(4)) < Number(payment0.slice(4)))); // suppliers shorten terms
    const price1 = round2(d.price + r.pick([-0.35, -0.2, 0.15, 0.3, 0.6]));
    const fixDay = g ? 1 : r.int(1, 2);
    const valid0 = addDays(fri, g ? 7 : r.pick([7, 10, 14]));
    const valid1 = addBusinessDays(addDays(d.start, fixDay), r.int(1, 2)); // shortened, always a weekday
    const restateStyle = g ? 0 : r.int(0, 2); // 0: names the unchanged terms, 1: "everything else stands", 2: "all other terms as quoted"
    const quoteFollowUp: 'none' | 'promise' | 'amendment' = g ? 'none' : r.pick(['none', 'promise', 'amendment'] as const);
    const ackInBetween = g ? false : r.chance(0.4);
    const sameThread = g ? true : r.chance(0.7);
    const withFinance = g ? false : r.chance(0.35);
    const dateStyle: DateStyle = g ? 'weekday' : r.pick(['weekday', 'weekday_short_date', 'month_day', 'weekday_long'] as const);
    const nBackground = g ? 2 : r.int(2, 7);
    const nChatter = g ? 0 : r.int(0, 3);
    const ref = g ? 'Q-2291' : `Q-${r.int(1000, 9999)}`;
    const file = g ? 'quote-v1.pdf' : r.pick(['quote-v1.pdf', `${d.company.split(' ')[0]}-Quote-${ref}.pdf`, `Quotation_${ref}.pdf`, `${ref}_v1.pdf`]);

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => procurementDayStart(d, day, hhmm);

    // ---- history
    const rfq = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: t(0, '09:10'),
      subject: `RFQ: ${d.qty} x ${d.item.sku} — ${d.alias}`,
      body: body(`Hi ${firstName(supplier)},`, `Please quote ${d.qty} ${d.item.name} for ${d.alias}. Everything needs to be on site by ${sayDate(d.deadline, 'weekday_short_date')}. A formal quote with price, delivery dates and payment terms would be great.`, `Thanks,\n${SIGNATURE}`),
    });
    let finAsk: string | null = null;
    let approval: string | null = null;
    if (withFinance) {
      finAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [finance.address], at: t(0, '09:25'), subject: `Budget approval — ${d.alias}`, body: body(`Hi ${firstName(finance)},`, `Can you approve up to ${moneyShort(d.budget)}/unit for ${d.alias}?`, SIGNATURE) });
      approval = mb.add({ direction: 'inbound', from: finance.address, fromName: shortName(finance), to: [self.address], at: t(0, '15:30'), subject: mb.reSubject(finAsk), replyTo: finAsk, body: body(r.pick([`Approved, up to ${moneyShort(d.budget)} per unit.`, `Fine by finance: max ${moneyShort(d.budget)}/unit for ${d.alias}.`, `Go ahead, ceiling is ${moneyShort(d.budget)} per unit.`]), firstName(finance)) });
    }
    const offerText = g
      ? `Please find our quote attached: ${moneyShort(d.price)} per unit, ${lots0[0].qty} units ${sayDate(fri, 'weekday')} and the remaining ${lots0[1].qty} the following Monday (${sayDate(mon, 'month_day').replace('October', 'Oct')}), payment ${payment0}.`
      : r.pick([
        `Our quote is attached. Summary: ${moneyShort(d.price)}/unit, ${twoLots ? `${lots0[0].qty} on ${sayDate(fri, dateStyle)} and ${lots0[1].qty} on ${sayFrom(mon, t(0, '13:00'), dateStyle)}` : `all ${d.qty} on ${sayDate(fri, dateStyle)}`}, ${payment0}.`,
        `Attached is quote ${ref}. Everything (price, delivery split, payment terms) is in the PDF.`,
        `Thanks for the RFQ — formal quotation attached for your review.`,
      ]);
    const quote = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: t(0, g ? '13:05' : r.pick(['11:40', '13:05', '14:20'])),
      subject: mb.reSubject(rfq), replyTo: rfq,
      body: body('Hi,', offerText, `${shortName(supplier)}\n${d.company}`),
      attachments: [pdf(file, quoteLines(d, { ref, date: d.start, deliveryLine: lotsLine(lots0), payment: payment0, validUntil: valid0 }))],
    });
    procurementBackground(r, base, mb, t(0, '10:00'), nBackground, g ? 0 : r.int(0, 6)); // base: its Friday deadline keeps the look-alike dates on weekdays
    if (ackInBetween) {
      mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: t(0, '16:30'), subject: mb.reSubject(quote), replyTo: quote, body: body(`Hi ${firstName(supplier)},`, r.pick(['Thanks, got it. Reviewing internally.', 'Received, thank you. We will review and revert.', 'Thanks for the quick turnaround, looking at it now.']), SIGNATURE), note: 'state-neutral acknowledgement' });
    }
    procurementChatter(r, d, mb, t(1, '08:00'), nChatter, g ? 0 : r.int(0, 9));

    // ---- the change email
    const fixAt = t(fixDay, g ? '10:12' : r.pick(['09:50', '10:12', '11:30', '14:05']));
    const late = lots0.at(-1)!;
    const newLots: Lot[] = changes.includes('delivery') ? [...lots0.slice(0, -1), { qty: late.qty, date: newLast }] : lots0;
    const newPrice = changes.includes('price') ? price1 : d.price;
    const newPayment = changes.includes('payment') ? payment1 : payment0;
    const newValid = changes.includes('validity') ? valid1 : valid0;
    const say = (iso: string) => sayFrom(iso, fixAt, dateStyle);
    const sentences: Record<Change, string[]> = {
      delivery: twoLots
        ? [`Correction: the final ${late.qty} are now ${say(newLast)}.`, `One change to the quote: the second lot of ${late.qty} ${unit} will arrive ${say(newLast)} instead of ${say(late.date)}.`, `Our plant moved the last ${late.qty} to ${say(newLast)} (was ${say(late.date)}).`]
        : [`Correction: delivery of all ${d.qty} is now ${say(newLast)}, not ${say(late.date)}.`, `One change to the quote: the ${d.qty} ${unit} will arrive ${say(newLast)} instead of ${say(late.date)}.`, `Our carrier pushed the delivery to ${say(newLast)} (was ${say(late.date)}).`],
      price: [`We have to adjust the unit price to ${moneyShort(price1)} (from ${moneyShort(d.price)}).`, `Correction on pricing: it should read ${moneyShort(price1)} per unit, not ${moneyShort(d.price)}.`, `The unit price is revised to ${moneyShort(price1)}.`],
      payment: [`Our finance team asked me to change the payment terms to ${payment1}.`, `Payment terms on this order need to be ${payment1} instead of ${payment0}.`, `One amendment: payment is ${payment1}, not ${payment0}.`],
      validity: [`Please note the quote now only holds until ${sayDate(valid1, 'weekday_long')}.`, `Validity is shortened: pricing is good through ${sayDate(valid1, 'month_day')}.`, `We can only keep this quote open until ${sayDate(valid1, 'long')}.`],
    };
    // "One change to the quote: ..." only reads right when exactly one term changes
    const changeText = changes.map((c) => (g ? sentences[c][0] : r.pick(changes.length > 1 ? sentences[c].filter((x) => !x.startsWith('One ')) : sentences[c]))).join(' ');
    const unchanged = (['price', 'payment', 'delivery', 'validity'] as Change[]).filter((c) => !changes.includes(c));
    const named = unchanged.filter((c) => c !== 'validity').slice(0, 2);
    const restate = restateStyle === 0 && named.length
      ? `${named.map((c, i) => (i === 0 ? NAME[c][0].toUpperCase() + NAME[c].slice(1) : NAME[c])).join(' and ')} ${named.length > 1 || named[0] === 'payment' ? 'remain' : 'remains'} unchanged.`
      : restateStyle === 2 ? 'All other terms as quoted.' : 'Everything else in the quote stands.';
    const follow = quoteFollowUp === 'promise' ? r.pick(["I'll send an updated PDF tomorrow.", "I'll issue a revised quote shortly."]) : quoteFollowUp === 'amendment' ? r.pick(['Please treat this email as the amendment to the quote.', 'No new PDF needed; this email amends the quote.']) : null;
    const fix = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: fixAt,
      subject: sameThread ? mb.reSubject(rfq) : r.pick([`${d.alias} — quote update`, `Update to quote ${ref} (${d.alias})`]), replyTo: sameThread ? quote : null,
      body: body(g ? 'Hi,' : r.pick(['Hi,', `Hi again,`, 'Hello,']), changeText, restate, follow, g ? `${firstName(supplier)}` : r.pick([firstName(supplier), `Sorry for the back and forth,\n${firstName(supplier)}`, `Best,\n${shortName(supplier)}`])),
    });

    // ---- oracle
    const dispPrice = (p: number) => moneyShort(p);
    const evFor = (c: Change) => (changes.includes(c) ? [fix] : [quote, fix]);
    const terms: OracleTerm[] = [
      { party: supplier.address, term: 'price.unit', status: 'current', value: newPrice, evidence: evFor('price'), critical: true, display: dispPrice(newPrice) },
      { party: supplier.address, term: 'delivery.schedule', status: 'current', value: newLots, evidence: evFor('delivery'), critical: true, display: lotsDisplay(newLots) },
      { party: supplier.address, term: 'payment.terms', status: 'current', value: newPayment, evidence: evFor('payment'), critical: changes.includes('payment'), display: newPayment },
      { party: supplier.address, term: 'quote.valid_until', status: 'current', value: newValid, evidence: evFor('validity'), display: sayDate(newValid, 'weekday_short_date') },
      { party: supplier.address, term: 'order.quantity', status: 'current', value: d.qty, evidence: [quote, fix], display: `${d.qty} units` },
    ];
    if (approval) terms.push({ party: finance.address, term: 'budget.max_unit_price', status: 'current', value: d.budget, evidence: [approval], display: moneyShort(d.budget) });
    const old: Record<Change, { v: unknown; display: string }> = {
      delivery: { v: lots0, display: lotsDisplay(lots0) },
      price: { v: d.price, display: moneyShort(d.price) },
      payment: { v: payment0, display: payment0 },
      validity: { v: valid0, display: sayDate(valid0, 'weekday_short_date') },
    };
    const superseded: OracleSuperseded[] = changes.map((c) => ({ party: supplier.address, term: TERM[c], value: old[c].v, display: old[c].display, evidence: [quote], superseded_by: fix }));

    const conflicts: OracleConflict[] = [];
    const lateViolation = newLast > d.deadline && changes.includes('delivery');
    const priceViolation = newPrice > d.budget;
    if (lateViolation) conflicts.push({ kind: 'requirement_violation', term: 'delivery.schedule', party: supplier.address, display: `${late.qty} units now arrive ${sayDate(newLast, 'weekday_short_date')}, after the ${sayDate(d.deadline, 'weekday_short_date')} deadline`, critical: true });
    if (priceViolation) conflicts.push({ kind: 'requirement_violation', term: 'price.unit', party: supplier.address, display: `Revised price ${moneyShort(newPrice)} exceeds the ${moneyShort(d.budget)} ceiling`, critical: true });
    const violation = conflicts.length > 0;

    const open_loops: OracleLoop[] = quoteFollowUp === 'promise' ? [{ kind: 'commitment', debtor: supplier.address, subject: 'document.quote', display: 'Supplier owes an updated quote PDF', evidence: [fix] }] : [];
    const closed_loops: OracleLoop[] = [
      { kind: 'ask', debtor: supplier.address, subject: 'document.quote', display: 'Formal quote (received)', evidence: [rfq, quote] },
      { kind: 'ask', debtor: supplier.address, subject: 'price.unit', display: 'Unit price (answered in the quote)', evidence: [quote] },
      { kind: 'ask', debtor: supplier.address, subject: 'delivery.schedule', display: 'Delivery dates (answered in the quote)', evidence: [quote] },
    ];
    if (finAsk && approval) closed_loops.push({ kind: 'ask', debtor: finance.address, subject: 'budget.max_unit_price', alt_subjects: ['approval.budget'], display: 'Budget approval (given)', evidence: [finAsk, approval] });

    const changedFacts = changes.map((c) => `${NAME[c]} changed from ${old[c].display} to ${c === 'delivery' ? lotsDisplay(newLots) : c === 'price' ? moneyShort(newPrice) : c === 'payment' ? newPayment : sayDate(newValid, 'weekday_short_date')}`).join('; ');
    const unchangedNames = unchanged.map((c) => NAME[c]).join(', ');
    const prohibited: ActionCond[] = [
      { id: 'stale_value', text: staleText(`Uses a superseded value from the PDF as current (${changes.map((c) => old[c].display).join(' / ')})`), stale: true },
      { id: 'reask_unchanged', text: reaskText(`Asks the supplier to state or confirm again specific terms that did not change (${unchangedNames})`, true) },
    ];
    if (violation) prohibited.push({ id: 'binding_accept', text: 'Accepts or confirms the order on the changed terms', det: { type: 'binding_to', party: supplier.address } });
    if (quoteFollowUp === 'promise') prohibited.push({ id: 'claims_pdf_arrived', text: 'Says or implies the updated quote PDF has already been received' });
    prohibited.push({ id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true });

    const issue = [
      lateViolation ? `the ${late.qty} units now due ${sayDate(newLast, 'weekday_short_date')} miss the ${sayDate(d.deadline, 'weekday_short_date')} deadline` : null,
      priceViolation ? `the revised ${moneyShort(newPrice)} unit price is over the ${moneyShort(d.budget)} budget` : null,
    ].filter(Boolean).join(' and ');
    // what we tell the supplier: pushing back on the price does not require disclosing our ceiling
    const issueToSupplier = [
      lateViolation ? `the ${late.qty} units now due ${sayDate(newLast, 'weekday_short_date')} miss the ${sayDate(d.deadline, 'weekday_short_date')} deadline` : null,
      priceViolation ? `the revised ${moneyShort(newPrice)} unit price is not acceptable (it is above what Acme can pay; the draft need not disclose the ${moneyShort(d.budget)} ceiling)` : null,
    ].filter(Boolean).join(' and ');

    const checkpoint: Checkpoint = {
      id: 'after_change', after: fix, now: new Date(Date.parse(fixAt) + 20 * 60_000).toISOString().replace('.000', ''),
      state: {
        terms, superseded, open_loops, closed_loops, conflicts,
        documents: [{ filename: file, status: 'partially_stale', stale_terms: changes.map((c) => TERM[c]), display: `${file}: ${changes.map((c) => NAME[c]).join(' and ')} superseded; ${unchangedNames} and quantity still current` }],
        next_actor: 'us',
      },
      judge_facts: [
        `The quote PDF ${file} originally said: ${moneyShort(d.price)}/unit, ${d.qty} units, delivery ${lotsDisplay(lots0)}, payment ${payment0}, valid until ${sayDate(valid0, 'weekday_short_date')}.`,
        `A later email changed only this: ${changedFacts}. Everything else in the PDF (${unchangedNames}) is still valid.`,
        violation ? `This breaks a hard requirement: ${issue}.` : `The current terms still meet Acme's requirements (all by ${sayDate(d.deadline, 'weekday_short_date')}, max ${moneyShort(d.budget)}/unit).`,
        quoteFollowUp === 'promise' ? 'The supplier promised an updated PDF that has not arrived yet.' : null,
      ].filter(Boolean).join(' '),
      action: violation
        ? {
          expect: 'send',
          required: [
            { id: 'to_supplier', text: 'Sends a message to the supplier', det: { type: 'message_to', party: supplier.address } },
            { id: 'raise_issue', text: `Tells the supplier that ${issueToSupplier} and asks for a fix` },
          ],
          optional: [{ id: 'ask_updated_pdf', text: 'Asks for (or mentions) an updated quote document reflecting the change' }],
          prohibited,
        }
        : {
          expect: 'any',
          required: [],
          optional: [
            { id: 'ack_change', text: `Acknowledges the change (${changes.map((c) => NAME[c]).join(' and ')}) to the supplier using the new value`, det: { type: 'message_to', party: supplier.address } },
            { id: 'ask_updated_pdf', text: 'Asks for (or mentions) an updated quote document reflecting the change' },
          ],
          prohibited,
        },
    };

    return procurementCase(stale_document, variant, {
      description: `Quote PDF with 5 terms; an email changes ${changes.join(' + ')} and keeps the rest${violation ? ' (now breaks a requirement)' : ''}.`,
      task: d.task, mb, trigger: fix, checkpoint,
      params: { twoLots, lots0, changes, newLots, newPrice, newPayment, newValid, tight, reqDeadline, payment0, restateStyle, quoteFollowUp, ackInBetween, sameThread, withFinance, dateStyle, nBackground, nChatter, ref, file, qty: d.qty, price: d.price, budget: d.budget },
    });
  },
};
