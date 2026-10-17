// Archetype: competing offers (P1).
//
// We send the same RFQ to two independent suppliers (different companies, different groups). Both
// quote. Depending on the variant the cheaper one delivers part of the order late, or one is over the
// budget ceiling, or both comply and one is simply cheaper.
//
// Trap: two values for the same term key in one mailbox look like a correction ("newest wins": the
// later quote overwrites the earlier) or like a contradiction to reconcile. They are neither: offers
// from different parties are both current, keyed by party. The oracle lists both offers, records a
// requirement violation only against the non-compliant one, and the right action moves forward with
// the offer that meets every requirement (the cheaper one when both do), without binding to the other.
import type { Archetype, BenchCase, BenchParty, Checkpoint, OracleConflict, OracleDocument, OracleLoop, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, body, moneyShort, nextWeekday, pdf, sayDate, seedOf, type DateStyle } from '../../core/util.ts';
import { type Lot, SIGNATURE, addParty, firstName, later, lotsDisplay, lotsLine, procurementBackground, procurementCase, procurementChatter, procurementDayStart, procurementDeal, quoteLines, rivalSupplier, round2, shortName } from './vertical.ts';

type Scenario = 'cheap_late' | 'over_budget' | 'both_ok';

interface Quote { party: BenchParty; company: string; price: number; lots: Lot[]; payment: string; key?: string; file?: string }

export const competing_offers: Archetype = {
  id: 'competing_offers',
  title: 'Two independent suppliers quote the same order',
  capabilities: ['competing_offers'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('procurement', 'competing_offers', variant));
    const g = variant === 0;
    const d = procurementDeal(r, variant);
    const { self, supplier, finance } = d.cast;
    const rival = rivalSupplier(r, d, g);
    addParty(d, rival.party);
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => procurementDayStart(d, day, hhmm);

    // ---- parameters
    const scenario: Scenario = g ? 'cheap_late' : r.pick(['cheap_late', 'over_budget', 'both_ok'] as const);
    const primaryWins = g ? true : r.chance(0.5);
    const lateQty = Math.round((d.qty * (g ? 0.4 : r.pick([0.2, 0.3, 0.4, 0.5]))) / 10) * 10;
    const lateDay = g ? nextWeekday(d.deadline, 2) : nextWeekday(d.deadline, r.pick([1, 2, 3]));
    const winnerPrice = d.price;
    const loserPrice = scenario === 'cheap_late' ? round2(d.price - (g ? 0.5 : r.pick([0.3, 0.5, 0.8])))
      : scenario === 'over_budget' ? round2(d.budget + r.pick([0.15, 0.4, 0.75]))
        : Math.min(round2(d.price + r.pick([0.1, 0.2, 0.3])), d.budget); // both_ok: pricier but within budget (budget >= price + 0.10)
    const winnerPayment = 'Net 30';
    const loserPayment = scenario === 'both_ok' ? 'Net 30' : g ? 'Net 45' : r.pick(['Net 30', 'Net 45', 'Net 60']);
    const winnerFirst = g ? false : r.chance(0.5); // does the compliant quote arrive first?
    const withFinance = g ? false : r.chance(0.5);
    const pdfs = g ? false : r.chance(0.5);
    const dateStyle: DateStyle = g ? 'weekday' : r.pick(['weekday', 'weekday_short_date', 'month_day'] as const);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 2);

    const full: Lot[] = [{ qty: d.qty, date: d.deadline }];
    const split: Lot[] = [{ qty: d.qty - lateQty, date: d.deadline }, { qty: lateQty, date: lateDay }];
    const primary = { party: supplier, company: d.company };
    const winnerP = primaryWins ? primary : rival;
    const loserP = primaryWins ? rival : primary;
    const winner: Quote = { ...winnerP, price: winnerPrice, lots: full, payment: winnerPayment };
    const loser: Quote = { ...loserP, price: loserPrice, lots: scenario === 'cheap_late' ? split : full, payment: loserPayment };

    // ---- history: one RFQ per supplier
    const rfqText = `We need ${d.qty} ${d.item.name}, all delivered by ${sayDate(d.deadline, 'weekday_short_date')}. Could you quote your unit price, delivery dates and payment terms?`;
    const rfqs = new Map<string, string>();
    for (const [i, q] of (g ? [primary, rival] : r.shuffle([primary, rival])).entries()) {
      rfqs.set(q.party.address, mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [q.party.address], at: t(0, i ? '09:12' : '09:00'),
        subject: `RFQ: ${d.qty} x ${d.item.sku}`,
        body: body(`Hi ${firstName(q.party)},`, rfqText, `Thanks,\n${SIGNATURE}`),
      }));
    }
    let finAsk: string | null = null;
    let approval: string | null = null;
    if (withFinance) {
      finAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [finance.address], at: t(0, '09:30'), subject: `Budget approval — ${d.alias}`, body: body(`Hi ${firstName(finance)},`, `I'm getting two quotes for ${d.alias}. Can you approve up to ${moneyShort(d.budget)}/unit?`, SIGNATURE) });
      approval = mb.add({ direction: 'inbound', from: finance.address, fromName: shortName(finance), to: [self.address], at: t(0, '12:15'), subject: mb.reSubject(finAsk), replyTo: finAsk, body: body(r.pick([`Approved up to ${moneyShort(d.budget)}/unit.`, `OK, ceiling ${moneyShort(d.budget)} per unit.`]), firstName(finance)) });
    }
    procurementBackground(r, d, mb, t(0, '10:00'), nBackground, g ? 0 : r.int(0, 6));

    const quoteText = (q: Quote): string => {
      const when = q.lots.length === 1
        ? `all ${d.qty} by ${sayDate(q.lots[0].date, dateStyle)}`
        : `${q.lots[0].qty} by ${sayDate(q.lots[0].date, dateStyle)} and the remaining ${q.lots[1].qty} on ${sayDate(q.lots[1].date, 'weekday_short_date')}`;
      return g
        ? `${moneyShort(q.price)} per unit, ${when}. Payment ${q.payment}.`
        : r.pick([
          `Our offer: ${moneyShort(q.price)}/unit, ${when}, payment ${q.payment}.`,
          `We can do ${moneyShort(q.price)} each with delivery ${when}. Terms ${q.payment}.`,
          `Pricing is ${moneyShort(q.price)} per unit; delivery ${when}; ${q.payment}.`,
        ]);
    };
    const order = winnerFirst ? [winner, loser] : [loser, winner];
    const times = g ? ['13:20', '15:05'] : r.shuffle(['11:45', '13:20', '15:05', '16:30']).slice(0, 2).sort();
    for (const [i, q] of order.entries()) {
      const at = t(g ? 0 : r.int(0, 1) * i, times[i]);
      const rfq = rfqs.get(q.party.address)!;
      q.file = pdfs ? `${q.company.split(' ')[0]}-Quote-${r.int(1000, 9999)}.pdf` : undefined;
      q.key = mb.add({
        direction: 'inbound', from: q.party.address, fromName: shortName(q.party), to: [self.address], at,
        subject: mb.reSubject(rfq), replyTo: rfq,
        body: body('Hi,', quoteText(q), q.file ? 'Formal quote attached.' : null, `${shortName(q.party)}\n${q.company}`),
        attachments: q.file ? [pdf(q.file, quoteLines({ ...d, company: q.company }, { ref: `Q-${q.file.split('-').at(-1)!.replace('.pdf', '')}`, date: at.slice(0, 10), price: q.price, payment: q.payment, deliveryLine: lotsLine(q.lots) }))] : undefined,
      });
    }
    procurementChatter(r, d, mb, later(mb.get(order[0].key!).at, 10), nChatter, g ? 0 : r.int(0, 9)); // ≤ 2 messages, ≥ 85 min gap between the quotes
    const trigger = order[1].key!;
    const trigAt = mb.get(trigger).at;

    // ---- oracle
    const termsFor = (q: Quote): OracleTerm[] => [
      { party: q.party.address, term: 'price.unit', status: 'current', value: q.price, evidence: [q.key!], critical: true, display: `${q.company}: ${moneyShort(q.price)}` },
      { party: q.party.address, term: 'delivery.schedule', status: 'current', value: q.lots, evidence: [q.key!], critical: true, display: `${q.company}: ${lotsDisplay(q.lots)}` },
      { party: q.party.address, term: 'payment.terms', status: 'current', value: q.payment, evidence: [q.key!], display: `${q.company}: ${q.payment}` },
    ];
    const terms: OracleTerm[] = [...termsFor(winner), ...termsFor(loser)];
    if (approval) terms.push({ party: finance.address, term: 'budget.max_unit_price', status: 'current', value: d.budget, evidence: [approval], display: moneyShort(d.budget) });
    const conflicts: OracleConflict[] = [];
    if (scenario === 'cheap_late') conflicts.push({ kind: 'requirement_violation', term: 'delivery.schedule', party: loser.party.address, display: `${loser.company}: ${lateQty} units arrive ${sayDate(lateDay, 'weekday_short_date')}, after the deadline`, critical: true });
    if (scenario === 'over_budget') conflicts.push({ kind: 'requirement_violation', term: 'price.unit', party: loser.party.address, display: `${loser.company}: ${moneyShort(loser.price)} exceeds the ${moneyShort(d.budget)} ceiling`, critical: true });
    const closed_loops: OracleLoop[] = [winner, loser].flatMap((q): OracleLoop[] => [
      { kind: 'ask', debtor: q.party.address, subject: 'price.unit', display: `${q.company}: price (answered)`, evidence: [rfqs.get(q.party.address)!, q.key!] },
      { kind: 'ask', debtor: q.party.address, subject: 'delivery.schedule', display: `${q.company}: delivery (answered)`, evidence: [rfqs.get(q.party.address)!, q.key!] },
    ]);
    if (finAsk && approval) closed_loops.push({ kind: 'ask', debtor: finance.address, subject: 'budget.max_unit_price', alt_subjects: ['approval.budget'], display: 'Budget approval (given)', evidence: [finAsk, approval] });
    const documents: OracleDocument[] = [winner, loser].filter((q) => q.file).map((q) => ({ filename: q.file!, status: 'current', stale_terms: [], display: `${q.file}: current` }));

    const why = scenario === 'cheap_late' ? `${loser.company} is cheaper (${moneyShort(loser.price)}) but ${lateQty} units arrive ${sayDate(lateDay, 'weekday_short_date')}, after the deadline`
      : scenario === 'over_budget' ? `${loser.company} quotes ${moneyShort(loser.price)}, over the ${moneyShort(d.budget)} ceiling`
        : `both comply, and ${winner.company} is cheaper (${moneyShort(winner.price)} vs ${moneyShort(loser.price)})`;
    const checkpoint: Checkpoint = {
      id: 'after_both_quotes', after: trigger, now: later(trigAt, 20),
      state: { terms, superseded: [], open_loops: [], closed_loops, conflicts, documents, next_actor: 'us' },
      judge_facts: [
        `Two independent suppliers quoted. ${winner.company}: ${moneyShort(winner.price)}/unit, ${lotsDisplay(winner.lots)}, ${winner.payment}. ${loser.company}: ${moneyShort(loser.price)}/unit, ${lotsDisplay(loser.lots)}, ${loser.payment}.`,
        `Acme needs all ${d.qty} by ${sayDate(d.deadline, 'weekday_short_date')} at no more than ${moneyShort(d.budget)}/unit: ${why}. The ${winner.company} offer is the one to pursue.`,
        'The two quotes are separate offers, not a correction or a contradiction.',
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          ...(scenario === 'both_ok'
            ? [
              { id: 'to_winner', text: `Sends a message to ${winner.company}`, det: { type: 'message_to' as const, party: winner.party.address } },
              { id: 'proceed_winner', text: `Moves forward with the ${winner.company} offer (${moneyShort(winner.price)}/unit, all ${d.qty} by ${sayDate(d.deadline, 'weekday_short_date')}): confirms, accepts, or says Acme is ready to proceed` },
            ]
            : [
              { id: 'to_supplier', text: 'Sends a message to one of the suppliers', det: { type: 'message_to_any' as const, parties: [winner.party.address, loser.party.address] } },
              // asking the cheaper-but-non-compliant supplier whether it can fix the gap is a fair move too
              { id: 'proceed_winner', text: `Either moves forward with the ${winner.company} offer (${moneyShort(winner.price)}/unit, all ${d.qty} by ${sayDate(d.deadline, 'weekday_short_date')}), or asks ${loser.company} whether it can meet the requirement its offer currently misses, without committing to ${loser.company}` },
            ]),
        ],
        optional: [{ id: 'inform_loser', text: `Politely tells ${loser.company} the order went elsewhere, or asks whether it can meet the requirement` }],
        prohibited: [
          { id: 'binding_loser', text: `Accepts or confirms the ${loser.company} offer`, det: { type: 'binding_to', party: loser.party.address } },
          { id: 'as_correction', text: "Treats one supplier's quote as correcting or contradicting the other's (e.g. asks one supplier to explain the other's price; asking a supplier to match or beat a competing offer is fine)" },
          { id: 'loser_compliant', text: scenario === 'both_ok' ? `Claims the ${loser.company} offer is the better deal` : `Claims the ${loser.company} offer meets all of Acme's requirements` },
          { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
        ],
      },
    };

    return procurementCase(competing_offers, variant, {
      description: `${winner.company} vs ${loser.company} (${scenario}); ${winner.company} is the compliant / better offer.`,
      task: d.task, mb, trigger, checkpoint,
      params: { scenario, primaryWins, winner: { company: winner.company, price: winner.price, lots: winner.lots }, loser: { company: loser.company, price: loser.price, lots: loser.lots }, lateQty, lateDay, winnerFirst, withFinance, pdfs, dateStyle, nBackground, nChatter, qty: d.qty, budget: d.budget, deadline: d.deadline },
    });
  },
};
