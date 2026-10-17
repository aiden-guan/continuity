// Archetype: withdrawn offer (P1).
//
// The supplier makes a time-limited offer ("Offer valid through tomorrow"), sometimes with a quote
// PDF. Before it expires the supplier withdraws it and says it cannot supply the order. In some
// variants finance, unaware, then approves the budget and tells us to accept the offer.
//
// Trap: the offer's validity window is still open and its numbers are the only price ever quoted, so
// "latest value per term" or a summary keeps $X/unit as the current price, and an eager agent accepts
// it (especially when finance says "go ahead"). The oracle has offer.status = withdrawn, the offer's
// terms `absent` (and listed as superseded by the withdrawal), the PDF withdrawn and an
// offer_unavailable conflict. Accepting, or treating the offer as still open, is a stale violation;
// when finance asked us to accept, we owe finance the news.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleDocument, OracleLoop, OracleSuperseded, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, moneyShort, pdf, sayDate, seedOf, staleText } from '../../core/util.ts';
import { SIGNATURE, firstName, later, procurementBackground, procurementCase, procurementChatter, procurementDayStart, procurementDeal, quoteLines, shortName } from './vertical.ts';

export const withdrawn_offer: Archetype = {
  id: 'withdrawn_offer',
  title: 'Supplier withdraws its offer before it expires',
  capabilities: ['lifecycle', 'supersession'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('procurement', 'withdrawn_offer', variant));
    const g = variant === 0;
    const d = procurementDeal(r, variant);
    const { self, supplier, finance } = d.cast;
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => procurementDayStart(d, day, hhmm);

    // ---- parameters
    const price = g ? 11.2 : d.price;
    const offerDay = g ? 0 : r.int(0, 1);
    const validUntil = addDays(d.start, offerDay + 1); // "valid through tomorrow"
    const withPdf = g ? false : r.chance(0.5);
    const weHeld = g ? false : r.chance(0.4); // we said we'd confirm once finance signs off
    const trigger: 'withdrawal' | 'finance_go' = g ? 'withdrawal' : r.chance(0.4) ? 'finance_go' : 'withdrawal';
    const askedFinance = g ? false : trigger === 'finance_go' ? true : r.chance(0.5);
    const approvedBefore = askedFinance && trigger === 'withdrawal' && r.chance(0.6);
    const withdrawStyle = g ? 0 : r.int(0, 3);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 2);
    const ref = `Q-${r.int(1000, 9999)}`;
    const file = `${d.company.split(' ')[0]}-Offer-${ref}.pdf`;

    // ---- history
    const rfq = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: t(offerDay, '08:40'),
      subject: `RFQ: ${d.qty} x ${d.item.sku} — ${d.alias}`,
      body: body(`Hi ${firstName(supplier)},`, `Can you supply ${d.qty} ${d.item.name} for ${d.alias} by ${sayDate(d.deadline, 'weekday_short_date')}? Please let me know price and availability.`, `Thanks,\n${SIGNATURE}`),
    });
    const offerAt = t(offerDay, g ? '11:05' : r.pick(['10:30', '11:05', '13:20']));
    const offerText = g
      ? `${d.qty} units ${sayDate(d.deadline, 'weekday')}, ${moneyShort(price)} each. Offer valid through tomorrow.`
      : r.pick([
        `We can offer ${d.qty} ${unit} for ${sayDate(d.deadline, 'weekday')} delivery at ${moneyShort(price)} per unit. This offer is valid through tomorrow.`,
        `${moneyShort(price)}/unit, all ${d.qty} delivered ${sayDate(d.deadline, 'weekday')}. We can hold this until end of day ${sayDate(validUntil, 'weekday')}.`,
        `Offer: ${d.qty} x ${d.item.sku} at ${moneyShort(price)}, delivery ${sayDate(d.deadline, 'weekday_short_date')}. Valid until ${sayDate(validUntil, 'long')}.`,
      ]);
    const offer = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: offerAt,
      subject: mb.reSubject(rfq), replyTo: rfq,
      body: body('Hi,', offerText, withPdf ? 'Formal offer attached.' : null, g ? `${shortName(supplier)}\n${d.company}` : firstName(supplier)),
      attachments: withPdf ? [pdf(file, quoteLines(d, { ref, date: offerAt.slice(0, 10), price, validUntil }))] : undefined,
    });
    let hold: string | null = null;
    if (weHeld) {
      hold = mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: later(offerAt, 70),
        subject: mb.reSubject(rfq), replyTo: offer,
        body: body(`Hi ${firstName(supplier)},`, r.pick(['Thanks, this looks good. I will confirm by tomorrow once finance signs off.', 'Thank you. Waiting on internal approval; I expect to confirm tomorrow.']), SIGNATURE),
      });
    }
    let finAsk: string | null = null;
    let approval: string | null = null;
    if (askedFinance) {
      finAsk = mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [finance.address], at: later(offerAt, 85),
        subject: `Budget approval — ${d.alias}`,
        body: body(`Hi ${firstName(finance)},`, `${d.company} offers ${d.qty} at ${moneyShort(price)}/unit, valid through ${sayDate(validUntil, 'weekday_short_date')}. Can you approve up to ${moneyShort(d.budget)} per unit?`, SIGNATURE),
      });
      if (approvedBefore) {
        approval = mb.add({
          direction: 'inbound', from: finance.address, fromName: shortName(finance), to: [self.address], at: later(offerAt, 200),
          subject: mb.reSubject(finAsk), replyTo: finAsk,
          body: body(r.pick([`Approved up to ${moneyShort(d.budget)}/unit.`, `OK, budget approved (max ${moneyShort(d.budget)} per unit).`]), firstName(finance)),
        });
      }
    }
    procurementBackground(r, d, mb, later(offerAt, 15), nBackground, g ? 0 : r.int(0, 6));
    procurementChatter(r, d, mb, later(offerAt, 30), nChatter, g ? 0 : r.int(0, 9));

    const wdAt = t(offerDay + 1, g ? '09:15' : r.pick(['08:55', '09:15', '10:40'])); // before the offer expires
    const withdrawTexts = [
      'Please disregard the previous offer. We have withdrawn it and cannot supply this order.',
      `I'm sorry, but we have to withdraw yesterday's offer. The stock has been allocated to another customer and we can't supply ${d.alias}.`,
      `Unfortunately our offer for ${d.qty} ${unit} is withdrawn with immediate effect; we are unable to fulfil this order.`,
      `Apologies, please treat our offer as cancelled. We no longer have capacity for ${d.qty} by ${sayDate(d.deadline, 'weekday')} and cannot take the order.`,
    ];
    const withdrawal = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: wdAt,
      subject: mb.reSubject(rfq), replyTo: hold ?? offer,
      body: body(g ? 'Hi,' : r.pick(['Hi,', 'Hello,', 'Hi there,']), withdrawTexts[withdrawStyle], g ? null : r.pick([null, 'Sorry for the inconvenience.', 'I hope we can help on a future order.', 'Apologies for the short notice.']), g ? `${firstName(supplier)}` : r.pick([firstName(supplier), `Sorry again,\n${firstName(supplier)}`, `Regards,\n${shortName(supplier)}`])),
    });
    let go: string | null = null;
    if (trigger === 'finance_go') {
      go = mb.add({
        direction: 'inbound', from: finance.address, fromName: shortName(finance), to: [self.address], at: later(wdAt, r.int(40, 150)),
        subject: mb.reSubject(finAsk!), replyTo: finAsk,
        body: body(r.pick([
          `Approved up to ${moneyShort(d.budget)}/unit. Go ahead and accept the ${moneyShort(price)} offer before it expires.`,
          `Budget OK (max ${moneyShort(d.budget)}). Please lock in the ${d.company} offer today.`,
          `Approved. ${moneyShort(price)} is well within budget, so please confirm with ${d.company} asap.`,
        ]), firstName(finance)),
      });
      approval = go;
    }
    const trig = go ?? withdrawal;
    const trigAt = mb.get(trig).at;

    // ---- oracle
    const offered: { term: string; v: unknown; display: string; critical?: boolean }[] = [
      { term: 'price.unit', v: price, display: moneyShort(price), critical: true },
      { term: 'delivery.schedule', v: [{ qty: d.qty, date: d.deadline }], display: `${d.qty} units ${sayDate(d.deadline, 'weekday_short_date')}`, critical: true },
      { term: 'quote.valid_until', v: validUntil, display: sayDate(validUntil, 'weekday_short_date') },
      ...(withPdf ? [{ term: 'payment.terms', v: 'Net 30', display: 'Net 30' }] : []),
    ];
    const terms: OracleTerm[] = [
      { party: supplier.address, term: 'offer.status', status: 'current', value: 'withdrawn', evidence: [withdrawal], critical: true, display: 'withdrawn: supplier cannot supply' },
      ...offered.map((o): OracleTerm => ({ party: supplier.address, term: o.term, status: 'absent', evidence: [], critical: o.critical, display: `none (the ${o.display} offer was withdrawn)` })),
    ];
    if (approval) terms.push({ party: finance.address, term: 'budget.max_unit_price', status: 'current', value: d.budget, evidence: [approval], display: moneyShort(d.budget) });
    const superseded: OracleSuperseded[] = offered.map((o) => ({ party: supplier.address, term: o.term, value: o.v, display: `${o.display} (withdrawn offer)`, evidence: [offer], superseded_by: withdrawal }));
    const documents: OracleDocument[] = withPdf ? [{ filename: file, status: 'withdrawn', stale_terms: [], display: `${file}: offer withdrawn` }] : [];
    const closed_loops: OracleLoop[] = [
      { kind: 'ask', debtor: supplier.address, subject: 'price.unit', display: 'Price (answered, then withdrawn)', evidence: [rfq, offer] },
      { kind: 'ask', debtor: supplier.address, subject: 'delivery.schedule', alt_subjects: ['order.quantity'], display: 'Availability (answered, then withdrawn)', evidence: [rfq, offer] },
    ];
    if (hold) closed_loops.push({ kind: 'commitment', debtor: self.address, subject: 'decision.order', display: 'Our promise to confirm by tomorrow (moot: the offer was withdrawn)', evidence: [hold, withdrawal] });
    if (finAsk && approval) closed_loops.push({ kind: 'ask', debtor: finance.address, subject: 'budget.max_unit_price', alt_subjects: ['approval.budget'], display: 'Budget approval (given)', evidence: [finAsk, approval] });
    const open_loops: OracleLoop[] = go ? [{ kind: 'ask', debtor: self.address, subject: 'decision.order', display: 'Finance asked us to accept the offer; we must tell them it was withdrawn', evidence: [go] }] : [];

    const prohibited: ActionCond[] = [
      { id: 'binding_accept', text: staleText(`Accepts or confirms the withdrawn ${moneyShort(price)} offer with the supplier`), det: { type: 'binding_to', party: supplier.address }, stale: true },
      { id: 'offer_still_open', text: staleText(`Treats the ${moneyShort(price)} offer as still available (e.g. says it is valid until ${sayDate(validUntil, 'weekday_short_date')} or that the order is on track)`), stale: true },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    const checkpoint: Checkpoint = {
      id: 'after_withdrawal', after: trig, now: later(trigAt, 20),
      state: {
        terms, superseded, open_loops, closed_loops,
        conflicts: [{ kind: 'offer_unavailable', term: 'offer.status', party: supplier.address, display: `${d.company} withdrew its offer and cannot supply ${d.alias}`, critical: true }],
        documents, next_actor: 'us',
      },
      judge_facts: [
        `${d.company} offered ${d.qty} units at ${moneyShort(price)}/unit (valid through ${sayDate(validUntil, 'weekday_short_date')}), then withdrew the offer before it expired and said it cannot supply the order.`,
        'There is no current offer: the price and delivery date belong to a withdrawn offer.',
        go ? `Finance, unaware of the withdrawal, has just approved up to ${moneyShort(d.budget)}/unit and asked us to accept the offer.` : approval ? `Finance approved up to ${moneyShort(d.budget)}/unit earlier, but there is nothing to accept now.` : null,
      ].filter(Boolean).join(' '),
      action: go
        ? {
          expect: 'send',
          required: [
            { id: 'to_finance', text: 'Replies to finance', det: { type: 'message_to', party: finance.address } },
            { id: 'tell_withdrawn', text: 'Tells finance the supplier withdrew the offer, so it cannot be accepted' },
          ],
          optional: [{ id: 'ask_alternatives', text: 'Asks the supplier whether it could supply later, partially, or at different terms' }],
          prohibited,
        }
        : {
          // the only offer is gone and the deadline still stands: doing nothing leaves the purchase dead
          expect: 'send',
          required: [
            { id: 'follows_up', text: 'Sends a message to the supplier (e.g. about alternatives) or to finance (that the offer is gone)', det: { type: 'message_to_any', parties: [supplier.address, finance.address] } },
          ],
          optional: [
            { id: 'ask_alternatives', text: 'Asks the supplier whether it could supply later, partially, or at different terms' },
            { id: 'inform_finance', text: 'Tells finance (or the requester) that the offer is gone' },
          ],
          prohibited,
        },
    };

    return procurementCase(withdrawn_offer, variant, {
      description: `Offer of ${d.qty} at ${moneyShort(price)} (valid through ${sayDate(validUntil, 'weekday_short_date')}) is withdrawn before expiry${go ? '; finance then says to accept it' : ''}.`,
      task: d.task, mb, trigger: trig, checkpoint,
      params: { price, offerDay, validUntil, withPdf, weHeld, trigger, askedFinance, approvedBefore, withdrawStyle, nBackground, nChatter, qty: d.qty, budget: d.budget, deadline: d.deadline },
    });
  },
};
