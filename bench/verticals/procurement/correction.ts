// Archetype: correction / supersession (P0). The reference archetype: other archetypes follow its shape.
//
// The supplier offers every unit by the deadline (with a quote PDF), finance approves the budget in a
// separate thread, then the supplier corrects the schedule: only part arrives by the deadline, the rest
// later, and a revised quote is promised. At the checkpoint a fresh agent must know the corrected
// schedule (and that the original "all by Friday" is dead), the unchanged price, the budget from the
// other thread, the conflict with the hard deadline, the owed revised quote, and that the quote PDF is
// stale on delivery only.
import type { Archetype, BenchCase, Checkpoint } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, moneyShort, pdf, reaskText, sayDate, seedOf, staleText, type DateStyle } from '../../core/util.ts';
import { procurement, procurementBackground, procurementChatter, procurementDayStart, procurementDeal, quoteLines } from './vertical.ts';

export const correction: Archetype = {
  id: 'correction',
  title: 'Supplier corrects the delivery schedule',
  capabilities: ['supersession', 'document_validity', 'cross_thread', 'open_loops', 'cold_handoff'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('procurement', 'correction', variant));
    const g = variant === 0;
    const d = procurementDeal(r, variant);
    const { self, supplier, finance } = d.cast;
    const first = supplier.name.split(' ')[0];
    const unit = d.item.unit;

    // ---- parameters
    const onTime = g ? 300 : Math.round((d.qty * r.pick([0.4, 0.5, 0.6, 0.7, 0.8])) / 10) * 10;
    const late = d.qty - onTime;
    const lateDay = g ? '2026-10-28' : addDays(d.deadline, r.pick([3, 4, 5, 6])); // always after the deadline
    const dateStyle: DateStyle = g ? 'weekday_short_date' : r.pick(['weekday_short_date', 'long', 'month_day', 'weekday_long'] as const);
    const correctionStyle = g ? 0 : r.int(0, 3);
    const restatesPrice = g ? true : r.chance(0.6);
    const quoteDue = g ? 'by tomorrow' : r.pick(['by tomorrow', 'later today', 'by end of day tomorrow', '']);
    const nBackground = g ? 1 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 3);
    const quoteRef = g ? 'Q-2291' : `Q-${r.int(1000, 9999)}`;
    const quoteFile = `${d.company.split(' ')[0]}-Quote-${quoteRef}.pdf`;

    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => procurementDayStart(d, day, hhmm);

    // ---- history
    const rfq = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: t(0, '09:00'),
      subject: `RFQ: ${d.qty} x ${d.item.sku} — ${d.alias}`,
      body: body(`Hi ${first},`, `We need ${d.qty} ${d.item.name} delivered by ${sayDate(d.deadline, 'weekday_short_date')}. Can you deliver all ${d.qty} by then, and what is your unit price? Please send a formal quote.`, 'Acme Procurement Agent'),
    });
    const ask = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [finance.address], at: t(0, '09:01'),
      subject: `Budget approval request — ${d.alias}`,
      body: body(`Hi ${finance.name.split(' ')[0]},`, `Could you approve a budget of up to ${moneyShort(d.budget)} per unit for ${d.alias}?`, 'Acme Procurement Agent'),
    });
    const offerText = g
      ? `Thanks for reaching out. We can deliver ${d.qty} units ${sayDate(d.deadline, 'weekday')} (${sayDate(d.deadline, 'month_day').replace('October', 'Oct')}) at ${moneyShort(d.price)} each. I've attached the quote.`
      : r.pick([
        `Thanks for the RFQ. All ${d.qty} ${unit} can be with you by ${sayDate(d.deadline, dateStyle)} at ${moneyShort(d.price)} per unit. Quote attached.`,
        `We can supply the full ${d.qty} by ${sayDate(d.deadline, dateStyle)}. Unit price is ${moneyShort(d.price)}. Our formal quote is attached.`,
        `Good news: we have stock. ${d.qty} ${unit}, delivered ${sayDate(d.deadline, dateStyle)}, ${moneyShort(d.price)} each. Please find the quote attached.`,
      ]);
    const offer = mb.add({
      direction: 'inbound', from: supplier.address, fromName: supplier.name.split(' (')[0], to: [self.address], at: t(0, '11:20'),
      subject: mb.reSubject(rfq), replyTo: rfq,
      body: body('Hi,', offerText, 'Let me know if you have any questions.', `${supplier.name.split(' (')[0]}\n${d.company}`),
      attachments: [pdf(quoteFile, quoteLines(d, { ref: quoteRef, date: d.start }))],
    });
    const approval = mb.add({
      direction: 'inbound', from: finance.address, fromName: finance.name.split(' (')[0], to: [self.address], at: t(0, '15:05'),
      subject: mb.reSubject(ask), replyTo: ask,
      body: g
        ? body(`Approved. The budget for ${d.alias} is approved up to ${moneyShort(d.budget)} per unit (${d.qty} units, ${moneyShort(d.budget * d.qty)} max).`, `${finance.name.split(' ')[0]}\nAcme Finance`)
        : body(r.pick([
          `Approved — up to ${moneyShort(d.budget)} per unit for ${d.alias}.`,
          `You're cleared to spend up to ${moneyShort(d.budget)}/unit on ${d.alias}.`,
          `Budget for ${d.alias} approved at a ceiling of ${moneyShort(d.budget)} per unit.`,
        ]), finance.name.split(' ')[0]),
    });
    procurementBackground(r, d, mb, t(0, '12:00'), nBackground);
    procurementChatter(r, d, mb, t(0, '16:00'), nChatter);

    const lateSay = sayDate(lateDay, dateStyle);
    const correctionText = [
      `Correction to my earlier email: only ${onTime} ${g ? 'units' : unit} can arrive ${sayDate(d.deadline, 'weekday')}. The other ${late} won't arrive until ${g ? 'Wednesday, Oct 28' : lateSay} — our second production lot slipped.`,
      `I need to correct what I told you: we can only get ${onTime} to you by ${sayDate(d.deadline, 'weekday')}. The remaining ${late} will follow on ${lateSay}.`,
      `Update on your order, sorry: ${onTime} ${unit} ship on time for ${sayDate(d.deadline, 'weekday')}, but the final ${late} are delayed to ${lateSay}.`,
      `Revision to our offer — our second lot slipped, so it's ${onTime} by ${sayDate(d.deadline, 'weekday')} and ${late} on ${lateSay}.`,
    ][correctionStyle];
    const quotePromise = `I'll send a revised quote${quoteDue ? ` ${quoteDue}` : ''}.`;
    const fix = mb.add({
      direction: 'inbound', from: supplier.address, fromName: supplier.name.split(' (')[0], to: [self.address], at: t(1, '10:12'),
      subject: mb.reSubject(rfq), replyTo: offer,
      body: body(g ? 'Hi again,' : 'Hi,', correctionText, `${restatesPrice ? 'Pricing is unchanged. ' : ''}${quotePromise}`, g ? 'Sorry about that,\nDana' : first),
    });

    // ---- oracle
    const schedule = [{ qty: onTime, date: d.deadline }, { qty: late, date: lateDay }];
    const scheduleDisplay = `${onTime} units ${sayDate(d.deadline, 'weekday_short_date')} + ${late} units ${sayDate(lateDay, 'weekday_short_date')}`;
    const checkpoint: Checkpoint = {
      id: 'after_correction', after: fix, now: t(1, '10:30'),
      state: {
        terms: [
          { party: supplier.address, term: 'price.unit', status: 'current', value: d.price, evidence: restatesPrice ? [offer, fix] : [offer], critical: true, display: moneyShort(d.price) },
          { party: supplier.address, term: 'delivery.schedule', status: 'current', value: schedule, evidence: [fix], critical: true, display: scheduleDisplay },
          { party: finance.address, term: 'budget.max_unit_price', status: 'current', value: d.budget, evidence: [approval], critical: true, display: moneyShort(d.budget) },
          { party: supplier.address, term: 'payment.terms', status: 'current', value: 'Net 30', evidence: [offer], display: 'Net 30' },
        ],
        superseded: [
          { party: supplier.address, term: 'delivery.schedule', value: [{ qty: d.qty, date: d.deadline }], display: `${d.qty} units ${sayDate(d.deadline, 'weekday_short_date')}`, evidence: [offer], superseded_by: fix },
        ],
        open_loops: [
          { kind: 'commitment', debtor: supplier.address, subject: 'document.quote', display: 'Supplier owes a revised quote', evidence: [fix], critical: true },
        ],
        closed_loops: [
          { kind: 'ask', debtor: supplier.address, subject: 'price.unit', display: 'Unit price (answered)', evidence: [offer] },
          { kind: 'ask', debtor: supplier.address, subject: 'delivery.schedule', display: 'Can all units arrive by the deadline (answered)', evidence: [offer] },
          { kind: 'ask', debtor: supplier.address, subject: 'document.quote', display: 'Formal quote (received)', evidence: [offer] },
          { kind: 'ask', debtor: finance.address, subject: 'budget.max_unit_price', alt_subjects: ['approval.budget'], display: 'Budget approval (given)', evidence: [approval] },
        ],
        conflicts: [
          { kind: 'requirement_violation', term: 'delivery.schedule', party: supplier.address, display: `${late} units arrive ${sayDate(lateDay, 'weekday_short_date')}, after the ${sayDate(d.deadline, 'weekday_short_date')} deadline`, critical: true },
        ],
        documents: [
          { filename: quoteFile, status: 'partially_stale', stale_terms: ['delivery.schedule'], display: `${quoteFile}: delivery superseded, price and payment still current` },
        ],
        next_actor: 'us',
      },
      judge_facts: [
        `Current supplier terms: unit price ${moneyShort(d.price)}; delivery ${scheduleDisplay}.`,
        `The supplier's earlier promise of all ${d.qty} by ${sayDate(d.deadline, 'weekday_short_date')} was corrected and is no longer valid.`,
        `Acme requires all ${d.qty} units by ${sayDate(d.deadline, 'weekday_short_date')}, so the ${late} late units violate a hard requirement.`,
        `Finance already approved up to ${moneyShort(d.budget)}/unit. The supplier promised a revised quote that has NOT arrived yet.`,
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_supplier', text: 'Sends a message to the supplier', det: { type: 'message_to', party: supplier.address } },
          { id: 'raise_late_units', text: `Tells the supplier that the ${late} units arriving ${sayDate(lateDay, 'weekday_short_date')} miss the ${sayDate(d.deadline, 'weekday_short_date')} deadline and asks for a fix (expedite, split shipment, or alternative)` },
        ],
        optional: [
          { id: 'mention_revised_quote', text: 'Mentions that the revised quote is still expected' },
        ],
        prohibited: [
          { id: 'binding_accept', text: 'Accepts or confirms the order with the supplier', det: { type: 'binding_to', party: supplier.address } },
          { id: 'stale_schedule', text: staleText(`Treats the original "all ${d.qty} by ${sayDate(d.deadline, 'weekday_short_date')}" schedule as still valid`), stale: true },
          { id: 'reask_price', text: reaskText(`Asks the supplier again what the unit price is (already known: ${moneyShort(d.price)}; asking them to keep that price in the revised quote is fine)`, true) },
          { id: 'reask_budget', text: reaskText('Asks finance again to approve the budget (already approved)') },
          { id: 'claims_quote_arrived', text: 'Says or implies the revised quote has already been received' },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return {
      id: `procurement/correction/${variant}`,
      vertical: 'procurement',
      archetype: 'correction',
      variant,
      split: variant === 0 ? 'golden' : variant <= 10 ? 'dev' : 'eval',
      capabilities: correction.capabilities,
      description: `Supplier corrects ${d.qty}-by-deadline to ${scheduleDisplay}; budget approved in a separate thread; revised quote owed.`,
      task: d.task,
      events: mb.sorted(),
      trigger: fix,
      checkpoints: [checkpoint],
      params: { onTime, late, lateDay, dateStyle, correctionStyle, restatesPrice, quoteDue, nBackground, nChatter, quoteRef, qty: d.qty, price: d.price, budget: d.budget, deadline: d.deadline },
    };
  },
};

export { procurement };
