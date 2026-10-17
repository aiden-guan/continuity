// Archetype: cross-thread fact (P1).
//
// The supplier quotes in one thread; the decisive second fact arrives in a brand-new thread (not a
// reply) that is linked to the deal only by its reference, written in whatever form the sender likes
// ("PO-4817", "PO 4817", "PO#4817"). Usually it is finance approving the budget; in some variants it is
// the supplier's quote itself that arrives as a fresh email while the approval is threaded. The same
// supplier and the same finance person are also handling a look-alike deal (two digits swapped) with a
// higher price and a lower budget ceiling, mailed in the same hours.
//
// Trap: a thread-scoped agent never sees the approval ("waiting on finance") or never sees the quote;
// a keyword/RAG agent pulls the look-alike deal's numbers and concludes the offer is over budget. The
// oracle puts both facts in one task state, the offer within budget and nothing in conflict; the
// right action moves the order forward with the supplier without re-asking finance.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleLoop, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, moneyShort, pdf, reaskText, sayDate, seedOf, type DateStyle } from '../../core/util.ts';
import { SIGNATURE, aliasForms, firstName, later, lookalikeAlias, procurementBackground, procurementCase, procurementChatter, procurementDayStart, procurementDeal, quoteLines, round2, shortName } from './vertical.ts';

export const cross_thread: Archetype = {
  id: 'cross_thread',
  title: 'Key fact arrives in a new thread linked only by the deal reference',
  capabilities: ['cross_thread'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('procurement', 'cross_thread', variant));
    const g = variant === 0;
    const d = procurementDeal(r, variant);
    const { self, supplier, finance } = d.cast;
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => procurementDayStart(d, day, hhmm);

    // ---- parameters
    const crossFact: 'approval' | 'quote' = g ? 'approval' : r.pick(['approval', 'approval', 'quote'] as const);
    const askedFinance = g ? true : crossFact === 'quote' ? true : r.chance(0.6);
    const approvalFirst = g ? false : r.chance(0.4);
    const form = g ? d.alias : r.pick(aliasForms(d.alias).slice(1));
    const look = lookalikeAlias(d.alias);
    const lookPrice = round2(d.budget + r.pick([0.3, 0.6, 0.9])); // over our budget
    const lookBudget = round2(d.price - r.pick([0.2, 0.3, 0.5])); // under our price
    const lookQty = r.pick([120, 150, 200, 250]);
    const withPdf = g ? false : r.chance(0.5);
    const dateStyle: DateStyle = g ? 'weekday' : r.pick(['weekday', 'weekday_short_date', 'month_day', 'long'] as const);
    const nBackground = g ? 2 : r.int(2, 5);
    const nChatter = g ? 0 : r.int(0, 3);
    const ref = `Q-${r.int(1000, 9999)}`;
    const file = `${d.company.split(' ')[0]}-Quote-${ref}.pdf`;

    // ---- history
    const rfq = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: t(0, '09:00'),
      subject: `RFQ: ${d.qty} x ${d.item.sku} — ${d.alias}`,
      body: body(`Hi ${firstName(supplier)},`, `For ${d.alias} we need ${d.qty} ${d.item.name}, all delivered by ${sayDate(d.deadline, 'weekday_short_date')}. What is your unit price, and can you meet that date?`, `Thanks,\n${SIGNATURE}`),
    });
    let finAsk: string | null = null;
    if (askedFinance) {
      finAsk = mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [finance.address], at: t(0, '09:20'),
        subject: g ? `Budget approval request — ${d.alias}` : r.pick([`Budget approval request — ${d.alias}`, `Approval needed: ${d.alias}`, `${d.alias} budget`]),
        body: body(`Hi ${firstName(finance)},`, `Could you approve up to ${moneyShort(d.budget)} per unit for ${d.alias} (${d.qty} ${unit})?`, SIGNATURE),
      });
    }
    procurementBackground(r, d, mb, t(0, '10:00'), nBackground, g ? 0 : r.int(0, 6));

    const offerAt = approvalFirst ? t(1, r.pick(['10:40', '11:15'])) : t(0, g ? '14:10' : r.pick(['13:30', '14:10', '15:45']));
    const approvalAt = approvalFirst ? t(0, r.pick(['15:20', '16:40'])) : t(1, g ? '09:45' : r.pick(['09:45', '10:30', '11:50']));

    // the supplier's quote: threaded reply, or (crossFact = quote) a fresh email naming only the reference
    const offerBody = g
      ? body('Hi,', `${d.alias}: ${moneyShort(d.price)}/unit, ${d.qty} units, all delivered by ${sayDate(d.deadline, 'weekday')}.`, 'Happy to book it in once you confirm.', `${shortName(supplier)}\n${d.company}`)
      : body(r.pick(['Hi,', 'Hello,']), r.pick([
        `${crossFact === 'quote' ? `Re ${form}: ` : ''}${moneyShort(d.price)} per unit for ${d.qty} ${unit}, delivered by ${sayDate(d.deadline, dateStyle)}.`,
        `We can do the ${d.qty} at ${moneyShort(d.price)} each and have them with you by ${sayDate(d.deadline, dateStyle)}${crossFact === 'quote' ? ` (your ${form})` : ''}.`,
        `Pricing for ${form}: ${moneyShort(d.price)}/unit, ${d.qty} units, delivery ${sayDate(d.deadline, dateStyle)}. Payment Net 30.`,
      ]), withPdf ? 'Formal quote attached.' : null, r.pick(['Let me know if you want to go ahead.', 'Shall I book it?', 'Just confirm and we will schedule production.']), firstName(supplier));
    const offer = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: offerAt,
      subject: crossFact === 'quote' ? r.pick([`${form} quotation`, `Quote — ${form}`, `${form}: pricing`]) : mb.reSubject(rfq),
      replyTo: crossFact === 'quote' ? null : rfq,
      body: offerBody,
      attachments: withPdf ? [pdf(file, quoteLines(d, { ref, date: offerAt.slice(0, 10) }))] : undefined,
    });
    // the look-alike deal's quote, minutes earlier (it must be visible when the agent wakes)
    mb.add({
      background: true, direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: later(offerAt, -r.int(6, 25)),
      subject: `Quote ${look}`,
      body: body('Hi,', `${look}: ${moneyShort(lookPrice)}/unit, ${lookQty} units, delivery ${sayDate(addDays(d.deadline, 7), 'weekday_short_date')}.`, firstName(supplier)),
      note: 'look-alike deal with the same supplier (digits swapped): must not bleed in',
    });

    // finance: a fresh thread (crossFact = approval) or a threaded reply
    const approvalText = g
      ? `${d.alias}: Approved up to ${moneyShort(d.budget)}/unit.`
      : r.pick([
        `${form} is approved. Max ${moneyShort(d.budget)} per unit.`,
        `Approval for ${form}: up to ${moneyShort(d.budget)}/unit. Go ahead when ready.`,
        `Finance sign-off on ${form}, ceiling ${moneyShort(d.budget)} per unit.`,
      ]);
    const approval = mb.add({
      direction: 'inbound', from: finance.address, fromName: shortName(finance), to: [self.address], at: approvalAt,
      subject: crossFact === 'approval' ? (g ? `${d.alias} approval` : r.pick([`${form} approval`, `Approved: ${form}`, `Re ${form}`])) : mb.reSubject(finAsk!),
      replyTo: crossFact === 'approval' ? null : finAsk,
      body: body(approvalText, `${firstName(finance)}\nAcme Finance`),
    });
    mb.add({
      background: true, direction: 'inbound', from: finance.address, fromName: shortName(finance), to: [self.address], at: later(approvalAt, -r.int(4, 30)),
      subject: `${look} approval`,
      body: body(`${look}: approved up to ${moneyShort(lookBudget)}/unit.`, firstName(finance)),
      note: 'look-alike deal approval: lower ceiling, different reference',
    });
    procurementChatter(r, d, mb, later(offerAt < approvalAt ? offerAt : approvalAt, 15), nChatter, g ? 0 : r.int(0, 9)); // between the two facts

    const trigger = approvalFirst ? offer : approval;
    const trigAt = approvalFirst ? offerAt : approvalAt;

    // ---- oracle
    const terms: OracleTerm[] = [
      { party: supplier.address, term: 'price.unit', status: 'current', value: d.price, evidence: [offer], critical: true, display: moneyShort(d.price) },
      { party: supplier.address, term: 'delivery.schedule', status: 'current', value: [{ qty: d.qty, date: d.deadline }], evidence: [offer], critical: true, display: `${d.qty} units ${sayDate(d.deadline, 'weekday_short_date')}` },
      { party: finance.address, term: 'budget.max_unit_price', status: 'current', value: d.budget, evidence: [approval], critical: true, display: moneyShort(d.budget) },
    ];
    if (withPdf || /Net 30/.test(offerBody)) terms.push({ party: supplier.address, term: 'payment.terms', status: 'current', value: 'Net 30', evidence: [offer], display: 'Net 30' });
    const closed_loops: OracleLoop[] = [
      { kind: 'ask', debtor: supplier.address, subject: 'price.unit', display: 'Unit price (answered)', evidence: [rfq, offer] },
      { kind: 'ask', debtor: supplier.address, subject: 'delivery.schedule', display: 'Can they meet the date (answered: yes)', evidence: [rfq, offer] },
    ];
    if (finAsk) closed_loops.push({ kind: 'ask', debtor: finance.address, subject: 'budget.max_unit_price', alt_subjects: ['approval.budget'], display: 'Budget approval (given in a separate thread)', evidence: [finAsk, approval] });
    const open_loops: OracleLoop[] = [
      { kind: 'ask', debtor: self.address, subject: 'decision.order', display: 'Supplier is waiting for our go-ahead', evidence: [offer] },
    ];

    const prohibited: ActionCond[] = [
      { id: 'reask_budget', text: reaskText('Asks finance again to approve the budget (already approved)') },
      { id: 'claims_unapproved', text: 'Tells anyone that the budget is not yet approved or that Acme is waiting on finance' },
      { id: 'lookalike_bleed', text: `Uses figures from the other deal ${look} (${moneyShort(lookPrice)}/unit or a ${moneyShort(lookBudget)} ceiling) for ${d.alias}` },
      { id: 'over_budget_claim', text: `Claims the ${moneyShort(d.price)} offer is over budget` },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    const checkpoint: Checkpoint = {
      id: 'after_both_facts', after: trigger, now: later(trigAt, 20),
      state: {
        terms, superseded: [], open_loops, closed_loops, conflicts: [],
        documents: withPdf ? [{ filename: file, status: 'current', stale_terms: [], display: `${file}: current` }] : [],
        next_actor: 'us',
      },
      judge_facts: [
        `${d.company} offers ${d.qty} units at ${moneyShort(d.price)}/unit, all by ${sayDate(d.deadline, 'weekday_short_date')}, and is waiting for Acme's go-ahead.`,
        `Finance approved up to ${moneyShort(d.budget)}/unit for ${d.alias} in a ${crossFact === 'approval' ? 'separate, new' : 'separate'} email thread, so the offer is within budget and meets every requirement.`,
        `${look} is a different deal (${moneyShort(lookPrice)}/unit, ${moneyShort(lookBudget)} ceiling) and is irrelevant here.`,
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_supplier', text: 'Sends a message to the supplier', det: { type: 'message_to', party: supplier.address } },
          { id: 'proceed', text: `Moves the order forward with the supplier at ${moneyShort(d.price)}/unit for ${d.qty} units (confirms, accepts, or says Acme is ready to proceed)` },
        ],
        optional: [{ id: 'tell_finance', text: 'Lets finance know the order is going ahead' }],
        prohibited,
      },
    };

    return procurementCase(cross_thread, variant, {
      description: `Quote and budget approval for ${d.alias} sit in different threads (${crossFact} is a fresh thread, reference written "${form}"); look-alike ${look} in the same inbox.`,
      task: d.task, mb, trigger, checkpoint,
      params: { crossFact, askedFinance, approvalFirst, form, look, lookPrice, lookBudget, lookQty, withPdf, dateStyle, nBackground, nChatter, qty: d.qty, price: d.price, budget: d.budget, deadline: d.deadline },
    });
  },
};
