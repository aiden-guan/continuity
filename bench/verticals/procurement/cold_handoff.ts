// Archetype: cold handoff (P0). The headline product test.
//
// A long, realistic history (10–20 task messages over four days plus background mail): an RFQ, a
// supplier acknowledgement, a quote PDF promising every unit by the deadline, a budget request and
// approval in a separate finance thread, a side question to the supplier that gets answered, on-task
// chatter, and finally a correction that splits the delivery (part on time, the rest after the
// deadline) with a revised quote promised. A fresh agent wakes on the newest message: finance asking
// whether the order can be placed, an innocuous supplier note, or the correction itself.
//
// Trap: everything at once. A naive reader of the latest message or of a running summary re-asks the
// price or the budget (both settled), says the revised quote is in (it is not), repeats "all N by
// Friday" (dead), or confirms the order. The oracle has the corrected schedule current and the old one
// superseded, the budget from the finance thread, the owed revised quote open, the original quote and
// the side question closed, the PDF stale on delivery only and a requirement violation on the late
// units. The action must raise the late units with the supplier (and, when finance asked, give finance
// an accurate status) without re-asking settled things.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleLoop, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, moneyShort, pdf, reaskText, sayDate, seedOf, staleText, type DateStyle } from '../../core/util.ts';
import { SIGNATURE, firstName, lotsDisplay, procurementBackground, procurementCase, procurementChatter, procurementDayStart, procurementDeal, quoteLines, sayFrom, shortName } from './vertical.ts';

type SideQ = 'price_best' | 'payment_net45' | 'validity';
type Trigger = 'finance_ping' | 'supplier_note' | 'correction';

export const cold_handoff: Archetype = {
  id: 'cold_handoff',
  title: 'Cold handoff of a long procurement history',
  capabilities: ['cold_handoff', 'supersession', 'document_validity', 'cross_thread', 'open_loops'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('procurement', 'cold_handoff', variant));
    const g = variant === 0;
    const d = procurementDeal(r, variant);
    const { self, supplier, finance } = d.cast;
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => procurementDayStart(d, day, hhmm);

    // ---- parameters
    const onTime = g ? 300 : Math.round((d.qty * r.pick([0.4, 0.5, 0.6, 0.7, 0.8])) / 10) * 10;
    const late = d.qty - onTime;
    const lateDay = g ? '2026-10-28' : addDays(d.deadline, r.pick([3, 4, 5, 6]));
    const trigger: Trigger = g ? 'finance_ping' : r.pick(['finance_ping', 'finance_ping', 'supplier_note', 'correction'] as const);
    const sideQ: SideQ = g ? 'price_best' : r.pick(['price_best', 'payment_net45', 'validity'] as const);
    const withAck = g ? true : r.chance(0.6);
    const financeThanks = g ? true : r.chance(0.5);
    const restatesPrice = g ? true : r.chance(0.6);
    const pingInThread = g ? false : r.chance(0.4);
    const dateStyle: DateStyle = g ? 'weekday_short_date' : r.pick(['weekday_short_date', 'long', 'month_day', 'weekday_long'] as const);
    const nBackground = g ? 4 : r.int(3, 7);
    const ref = g ? 'Q-2291' : `Q-${r.int(1000, 9999)}`;
    const file = `${d.company.split(' ')[0]}-Quote-${ref}.pdf`;
    const validUntil = addDays(d.deadline, 7);
    const fixedTask = 2 + 1 + 1 + 1 + 1 + 1 + (withAck ? 1 : 0) + (financeThanks ? 1 : 0) + (trigger === 'correction' ? 0 : 1); // rfq, offer, budget ask, approval, side q, side a, fix, ...
    const nChatter = Math.max(g ? 2 : r.int(2, 4), 10 - fixedTask);

    // ---- day 0: RFQ (+ acknowledgement)
    const rfq = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: t(0, '09:00'),
      subject: `RFQ: ${d.qty} x ${d.item.sku} — ${d.alias}`,
      body: body(`Hi ${firstName(supplier)},`, `We need ${d.qty} ${d.item.name} delivered by ${sayDate(d.deadline, 'weekday_short_date')} for ${d.alias}. Can you deliver all ${d.qty} by then, and at what unit price? Please send a formal quote.`, `Thanks,\n${SIGNATURE}`),
    });
    let ack: string | null = null;
    if (withAck) {
      ack = mb.add({
        direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: t(0, '10:05'),
        subject: mb.reSubject(rfq), replyTo: rfq,
        body: body('Hi,', g ? 'Got it, thanks. Checking stock with production; I will have a formal quote to you tomorrow morning.' : r.pick(['Thanks for the RFQ. Let me check with the plant, formal quote to follow tomorrow morning.', 'Received. I am confirming lead times and will send a quote by tomorrow AM.', 'On it. You will have our quote first thing tomorrow.']), firstName(supplier)),
      });
    }
    procurementBackground(r, d, mb, t(0, '11:00'), nBackground, g ? 0 : r.int(0, 6));

    // ---- day 1: quote, budget thread, side question
    const offerText = g
      ? `As promised, here is our quote: all ${d.qty} units by ${sayDate(d.deadline, 'weekday')} (${sayDate(d.deadline, 'month_day').replace('October', 'Oct')}) at ${moneyShort(d.price)} each, Net 30. PDF attached.`
      : r.pick([
        `Quote attached. We can supply all ${d.qty} ${unit} by ${sayDate(d.deadline, dateStyle)} at ${moneyShort(d.price)} per unit, Net 30.`,
        `Please find our formal quote attached: ${moneyShort(d.price)}/unit, the full ${d.qty} delivered ${sayDate(d.deadline, dateStyle)}.`,
        `Good news, we have capacity. ${d.qty} ${unit}, ${sayDate(d.deadline, dateStyle)}, ${moneyShort(d.price)} each. Details in the attached quote.`,
      ]);
    const offer = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: t(1, '09:30'),
      subject: mb.reSubject(rfq), replyTo: ack ?? rfq,
      body: body('Hi,', offerText, `${shortName(supplier)}\n${d.company}`),
      attachments: [pdf(file, quoteLines(d, { ref, date: addDays(d.start, 1), validUntil }))],
    });
    const budgetAsk = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [finance.address], at: t(1, '11:15'),
      subject: `Budget approval request — ${d.alias}`,
      body: body(`Hi ${firstName(finance)},`, `${d.company} quotes ${moneyShort(d.price)}/unit for ${d.qty} ${unit} (${moneyShort(Math.round(d.price * d.qty * 100) / 100)} total), all by ${sayDate(d.deadline, 'weekday_short_date')}. Could you approve a budget of up to ${moneyShort(d.budget)} per unit?`, SIGNATURE),
    });
    const approval = mb.add({
      direction: 'inbound', from: finance.address, fromName: shortName(finance), to: [self.address], at: t(1, '14:30'),
      subject: mb.reSubject(budgetAsk), replyTo: budgetAsk,
      body: g
        ? body(`Approved. The budget for ${d.alias} is approved up to ${moneyShort(d.budget)} per unit.`, `${firstName(finance)}\nAcme Finance`)
        : body(r.pick([`Approved — up to ${moneyShort(d.budget)} per unit for ${d.alias}.`, `You're cleared to spend up to ${moneyShort(d.budget)}/unit on ${d.alias}.`, `Budget for ${d.alias} approved at a ceiling of ${moneyShort(d.budget)} per unit.`]), firstName(finance)),
    });
    if (financeThanks) {
      mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [finance.address], at: t(1, '14:50'), subject: mb.reSubject(budgetAsk), replyTo: approval, body: body(`Thanks ${firstName(finance)}, much appreciated.`, SIGNATURE), note: 'state-neutral' });
    }
    const sideAsk: Record<SideQ, string> = {
      price_best: `Thanks for the quote. Is ${moneyShort(d.price)} your best price at ${d.qty} units?`,
      payment_net45: 'Thanks for the quote. Is there any flexibility to go to Net 45 on payment?',
      validity: 'Thanks for the quote. Just to confirm, how long does this pricing hold?',
    };
    const sideAnswer: Record<SideQ, string[]> = {
      price_best: [`${moneyShort(d.price)} is already our best price at this volume, I'm afraid.`, `That's our sharpest price for ${d.qty}; we can't go lower.`, `Sorry, ${moneyShort(d.price)} is as low as we can go.`],
      payment_net45: ['Unfortunately Net 30 is our standard and we cannot extend it.', 'We need to stay on Net 30, sorry.', 'Net 30 is the best we can offer on payment.'],
      validity: [`Pricing holds until ${sayDate(validUntil, 'long')}, same as on the PDF.`, `The quote is valid through ${sayDate(validUntil, 'month_day')}.`, `You have until ${sayDate(validUntil, 'weekday_long')} on this pricing.`],
    };
    const side = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: t(1, '15:10'),
      subject: mb.reSubject(rfq), replyTo: offer,
      body: body(`Hi ${firstName(supplier)},`, sideAsk[sideQ], SIGNATURE),
    });
    const sideA = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: t(2, '09:05'),
      subject: mb.reSubject(rfq), replyTo: side,
      body: body('Hi,', g ? sideAnswer[sideQ][0] : r.pick(sideAnswer[sideQ]), firstName(supplier)),
    });

    // ---- day 2: chatter, then the correction
    procurementChatter(r, d, mb, t(2, '09:20'), nChatter, g ? 0 : r.int(0, 9));
    const fixAt = t(2, '13:40');
    const lateSay = sayFrom(lateDay, fixAt, dateStyle);
    const correctionText = g
      ? `Correction to my earlier email: only ${onTime} units can arrive ${sayDate(d.deadline, 'weekday')}. The other ${late} won't arrive until ${lateSay}. Our second production lot slipped.`
      : r.pick([
        `I need to correct what I told you: we can only get ${onTime} to you by ${sayDate(d.deadline, 'weekday')}. The remaining ${late} will follow on ${lateSay}.`,
        `Update on your order, sorry: ${onTime} ${unit} ship on time for ${sayDate(d.deadline, 'weekday')}, but the final ${late} are delayed to ${lateSay}.`,
        `Revision to our quote: the second lot slipped, so it's ${onTime} by ${sayDate(d.deadline, 'weekday')} and ${late} on ${lateSay}.`,
        `Bad news on the schedule. ${onTime} of the ${d.qty} make ${sayDate(d.deadline, 'weekday')}; the other ${late} land ${lateSay}.`,
      ]);
    const fix = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: fixAt,
      subject: mb.reSubject(rfq), replyTo: sideA,
      body: body('Hi again,', correctionText, `${restatesPrice ? 'Pricing is unchanged. ' : ''}I'll send a revised quote by tomorrow.`, g ? 'Sorry about that,\nDana' : firstName(supplier)),
    });

    // ---- day 3: the trigger
    let ping: string | null = null;
    let note: string | null = null;
    if (trigger === 'finance_ping') {
      const pingText = g
        ? `Where do we stand on ${d.alias}? The plant is counting on all ${d.qty} on ${sayDate(d.deadline, 'weekday')}. Are we good to place the order?`
        : r.pick([
          `Quick check on ${d.alias}: can we get the PO out today? Ops needs all ${d.qty} by ${sayDate(d.deadline, 'weekday')}.`,
          `Any update on ${d.alias}? I'd like to release the PO before month-end. Is everything on track for ${sayDate(d.deadline, 'weekday')}?`,
          `Are we ready to commit on ${d.alias}? Let me know if anything changed.`,
        ]);
      ping = mb.add({
        direction: 'inbound', from: finance.address, fromName: shortName(finance), to: [self.address], at: t(3, g ? '15:20' : r.pick(['11:40', '15:20', '16:05'])),
        subject: pingInThread ? mb.reSubject(budgetAsk) : g ? `${d.alias} status?` : r.pick([`${d.alias} status?`, `${d.alias} — ready to order?`, `Checking in: ${d.alias}`]),
        replyTo: pingInThread ? approval : null,
        body: body('Hi,', pingText, firstName(finance)),
      });
    } else if (trigger === 'supplier_note') {
      note = mb.add({
        direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: t(3, r.pick(['10:15', '11:05', '14:30'])),
        subject: r.pick([`${d.alias} shipping labels`, `${d.alias} — paperwork`, `${d.alias} delivery contact`]),
        body: body('Hi,', r.pick([`FYI, every carton for ${d.alias} will be labelled with your PO number and our part number ${d.item.sku}.`, `Certificates of conformance for ${d.alias} will travel with each shipment.`, `Our dispatch team will call your dock before each ${d.alias} delivery.`]), firstName(supplier)),
        note: 'state-neutral, but it is what wakes the agent',
      });
    }
    const trig = ping ?? note ?? fix;
    const trigAt = mb.get(trig).at;

    // ---- oracle
    const schedule = [{ qty: onTime, date: d.deadline }, { qty: late, date: lateDay }];
    const scheduleDisplay = lotsDisplay(schedule);
    const priceEv = [offer, ...(restatesPrice ? [fix] : []), ...(sideQ === 'price_best' ? [sideA] : [])];
    const terms: OracleTerm[] = [
      { party: supplier.address, term: 'price.unit', status: 'current', value: d.price, evidence: priceEv, critical: true, display: moneyShort(d.price) },
      { party: supplier.address, term: 'delivery.schedule', status: 'current', value: schedule, evidence: [fix], critical: true, display: scheduleDisplay },
      { party: finance.address, term: 'budget.max_unit_price', status: 'current', value: d.budget, evidence: [approval], critical: true, display: moneyShort(d.budget) },
      { party: supplier.address, term: 'payment.terms', status: 'current', value: 'Net 30', evidence: sideQ === 'payment_net45' ? [offer, sideA] : [offer], display: 'Net 30' },
      { party: supplier.address, term: 'quote.valid_until', status: 'current', value: validUntil, evidence: sideQ === 'validity' ? [offer, sideA] : [offer], display: sayDate(validUntil, 'weekday_short_date') },
    ];
    const sideSubject: Record<SideQ, string> = { price_best: 'price.unit', payment_net45: 'payment.terms', validity: 'quote.valid_until' };
    const sideDisplay: Record<SideQ, string> = { price_best: 'Is this the best price (answered: yes)', payment_net45: 'Net 45 possible? (answered: no, Net 30)', validity: 'How long the pricing holds (answered)' };
    const open_loops: OracleLoop[] = [
      { kind: 'commitment', debtor: supplier.address, subject: 'document.quote', display: 'Supplier owes a revised quote (not received)', evidence: [fix], critical: true },
    ];
    if (ping) open_loops.push({ kind: 'ask', debtor: self.address, subject: 'decision.order', alt_subjects: ['delivery.schedule'], display: 'Finance asks whether the order can be placed / for a status update', evidence: [ping] });
    const closed_loops: OracleLoop[] = [
      { kind: 'ask', debtor: supplier.address, subject: 'document.quote', display: 'Formal quote (received)', evidence: [rfq, offer] },
      { kind: 'ask', debtor: supplier.address, subject: 'price.unit', display: 'Unit price (answered)', evidence: [offer] },
      { kind: 'ask', debtor: supplier.address, subject: 'delivery.schedule', display: 'Can all units arrive by the deadline (answered)', evidence: [offer] },
      { kind: 'ask', debtor: finance.address, subject: 'budget.max_unit_price', alt_subjects: ['approval.budget'], display: 'Budget approval (given)', evidence: [budgetAsk, approval] },
      { kind: 'ask', debtor: supplier.address, subject: sideSubject[sideQ], display: sideDisplay[sideQ], evidence: [side, sideA] },
    ];
    if (ack) closed_loops.push({ kind: 'commitment', debtor: supplier.address, subject: 'document.quote', display: 'Promised quote for the next morning (delivered)', evidence: [ack, offer] });

    const deadlineS = sayDate(d.deadline, 'weekday_short_date');
    const lateS = sayDate(lateDay, 'weekday_short_date');
    const required: ActionCond[] = [
      { id: 'to_supplier', text: 'Sends a message to the supplier', det: { type: 'message_to', party: supplier.address } },
      { id: 'raise_late_units', text: `Tells the supplier that the ${late} units arriving ${lateS} miss the ${deadlineS} deadline and asks for a fix (expedite, split shipment, or alternative)` },
    ];
    if (ping) {
      required.push(
        { id: 'to_finance', text: 'Replies to finance', det: { type: 'message_to', party: finance.address } },
        { id: 'status_to_finance', text: `Gives finance an accurate status: only ${onTime} units arrive by ${deadlineS}, ${late} are now due ${lateS}, so the order is not ready to place as is` },
      );
    }
    const prohibited: ActionCond[] = [
      { id: 'binding_accept', text: 'Accepts, confirms or places the order with the supplier', det: { type: 'binding_to', party: supplier.address } },
      { id: 'stale_schedule', text: staleText(`Treats the original "all ${d.qty} by ${deadlineS}" schedule as still valid (to anyone)`), stale: true },
      { id: 'reask_price', text: reaskText(sideQ === 'price_best'
        ? `Asks the supplier again what the unit price is, or again whether ${moneyShort(d.price)} is their best price (both already answered; asking for compensation for the late units is fine)`
        : `Asks the supplier again what the unit price is (already known: ${moneyShort(d.price)})`, true) },
      { id: 'reask_budget', text: reaskText('Asks finance again to approve the budget (already approved)') },
      { id: 'claims_quote_arrived', text: 'Says or implies the revised quote has already been received' },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];

    const checkpoint: Checkpoint = {
      id: 'handoff', after: trig, now: new Date(Date.parse(trigAt) + 20 * 60_000).toISOString().replace('.000', ''),
      state: {
        terms,
        superseded: [{ party: supplier.address, term: 'delivery.schedule', value: [{ qty: d.qty, date: d.deadline }], display: `${d.qty} units ${deadlineS}`, evidence: [offer], superseded_by: fix }],
        open_loops, closed_loops,
        conflicts: [{ kind: 'requirement_violation', term: 'delivery.schedule', party: supplier.address, display: `${late} units arrive ${lateS}, after the ${deadlineS} deadline`, critical: true }],
        documents: [{ filename: file, status: 'partially_stale', stale_terms: ['delivery.schedule'], display: `${file}: delivery superseded; price, payment and validity still current` }],
        next_actor: 'us',
      },
      judge_facts: [
        `Current supplier terms: ${moneyShort(d.price)}/unit, Net 30, delivery ${scheduleDisplay}. The original promise of all ${d.qty} by ${deadlineS} was corrected and is dead.`,
        `Acme needs all ${d.qty} by ${deadlineS}, so the ${late} late units break a hard requirement.`,
        `Finance approved up to ${moneyShort(d.budget)}/unit in a separate thread; the supplier already answered our side question (${sideDisplay[sideQ]}).`,
        `The supplier promised a revised quote "by tomorrow" and it has NOT arrived.`,
        ping ? 'Finance has just asked for a status / whether the order can be placed.' : null,
      ].filter(Boolean).join(' '),
      action: {
        expect: 'send',
        required,
        optional: [
          { id: 'mention_revised_quote', text: 'Mentions that the revised quote is still outstanding (or chases it)' },
          ...(ping ? [] : [{ id: 'update_finance', text: 'Updates finance about the delivery problem' }]),
        ],
        prohibited,
      },
    };

    return procurementCase(cold_handoff, variant, {
      description: `Long history: quote all-by-deadline, finance approval in another thread, side question answered, correction to ${scheduleDisplay} with revised quote owed; wakes on ${trigger}.`,
      task: d.task, mb, trigger: trig, checkpoint,
      params: { onTime, late, lateDay, trigger, sideQ, withAck, financeThanks, restatesPrice, pingInThread, dateStyle, nBackground, nChatter, ref, qty: d.qty, price: d.price, budget: d.budget, deadline: d.deadline },
    });
  },
};
