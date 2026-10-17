// Archetype: unanswered sub-question (P0).
//
// We ask the supplier two or three things in one email (unit price, whether every unit can arrive by
// the deadline, payment terms, how long the quote holds, a formal quote document). The reply answers
// only some of them and is silent on the rest.
//
// Trap: thread-level state ("they replied, so the ball is in our court and the thread is answered")
// marks every question closed. A running summary tends to merge our question into a fact ("all 500 by
// Friday"). The oracle keeps exactly the unanswered items open (asks owed by the supplier), marks the
// answered ones closed (re-asking them is a zombie loop), and lists unanswered terms as `absent`: the
// supplier never stated them, so reporting e.g. "all 500 by Friday" as a current term is wrong. The
// right action follows up on precisely the missing items and does not commit to the order while
// price, delivery or payment is still unknown.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleLoop, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, moneyShort, reaskText, sayDate, seedOf, type DateStyle } from '../../core/util.ts';
import { SIGNATURE, firstName, procurementBackground, procurementCase, procurementChatter, procurementDayStart, procurementDeal, shortName } from './vertical.ts';

type Q = 'price' | 'delivery' | 'payment' | 'validity' | 'quote';

const SUBJECT: Record<Q, string> = {
  price: 'price.unit', delivery: 'delivery.schedule', payment: 'payment.terms', validity: 'quote.valid_until', quote: 'document.quote',
};
const LABEL: Record<Q, string> = {
  price: 'the unit price', delivery: 'whether all units arrive by the deadline', payment: 'the payment terms', validity: 'how long the quote is valid', quote: 'a formal quote document',
};

export const unanswered_subquestion: Archetype = {
  id: 'unanswered_subquestion',
  title: 'Reply answers only some of our questions',
  capabilities: ['open_loops'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('procurement', 'unanswered_subquestion', variant));
    const g = variant === 0;
    const d = procurementDeal(r, variant);
    const { self, supplier, finance } = d.cast;
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => procurementDayStart(d, day, hhmm);

    // ---- parameters
    const asked: Q[] = g ? ['price', 'delivery'] : r.shuffle<Q>(['price', 'delivery', 'payment', 'validity', 'quote']).slice(0, r.pick([2, 2, 3]));
    if (!g && !asked.includes('price') && !asked.includes('delivery')) asked[0] = r.pick(['price', 'delivery'] as const);
    // nobody asks how long a price holds without asking for the price
    if (asked.includes('validity') && !asked.includes('price')) asked[asked.indexOf('validity')] = 'price';
    const answerable = asked.filter((q) => q !== 'quote'); // a formal quote would answer everything, so it is only ever the missing item
    const nAnswered = g ? 1 : r.int(1, Math.min(answerable.length, asked.length - 1));
    const answered: Q[] = g ? ['price'] : r.shuffle(answerable).slice(0, nAnswered);
    // a supplier that states how long its price holds also states the price
    if (answered.includes('validity') && !answered.includes('price')) answered[answered.indexOf('validity')] = 'price';
    const missing: Q[] = asked.filter((q) => !answered.includes(q));
    const askStyle = g ? 0 : r.int(0, 2); // numbered list, bullets, prose
    const afterCall = g ? true : r.chance(0.5); // "following up on our call" (explains "final" price)
    const withFinance = g ? false : r.chance(0.4);
    const replyNextDay = g ? false : r.chance(0.4);
    const payment = g ? 'Net 30' : r.pick(['Net 30', 'Net 45', 'Net 60']);
    const validUntil = addDays(d.deadline, g ? 7 : r.pick([3, 7, 10, 14]));
    const dateStyle: DateStyle = g ? 'weekday' : r.pick(['weekday', 'weekday_short_date', 'month_day', 'long'] as const);
    const nBackground = g ? 2 : r.int(2, 7);
    const nChatter = g ? 0 : r.int(0, 3);

    const deadlineSay = sayDate(d.deadline, dateStyle); // the story starts on Monday, so a bare weekday is this Friday

    // ---- history
    const intro = afterCall ? `Following up on our call${g ? '' : r.pick([' this morning', '', ' earlier'])} about ${d.qty} ${d.item.name} for ${d.alias}.` : `We are sourcing ${d.qty} ${d.item.name} for ${d.alias}.`;
    const qText: Record<Q, string[]> = {
      price: [afterCall ? 'final unit price' : 'your unit price', 'the unit price you can offer', 'the price per unit'],
      delivery: [`whether all ${d.qty} can arrive ${deadlineSay}`, `whether all ${d.qty} ${unit} can be delivered by ${deadlineSay}`, `whether the full ${d.qty} will be with us no later than ${deadlineSay}`],
      payment: ['your payment terms', 'which payment terms apply', 'the payment terms you would invoice on'],
      validity: ['how long the price is valid', 'until when the quote holds', 'the validity date of your pricing'],
      quote: ['a formal quote (PDF)', 'a formal quote document for our records', 'a written quote on your letterhead'],
    };
    const phrase = Object.fromEntries(asked.map((q) => [q, g ? qText[q][0] : r.pick(qText[q])])) as Record<Q, string>;
    const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] ?? '');
    const facts = asked.filter((q) => q !== 'quote').map((q) => phrase[q]);
    const questions = askStyle === 0
      ? `${asked.includes('quote') ? 'Could you get back to me on:' : 'Can you confirm:'}\n${asked.map((q, i) => `${i + 1}. ${phrase[q]}?`).join('\n')}`
      : askStyle === 1
        ? `A few things I need from you:\n${asked.map((q) => `- ${phrase[q]}`).join('\n')}`
        : facts.length
          ? `Could you let me know ${and(facts)}${asked.includes('quote') ? `, and send ${phrase.quote}` : ''}?`
          : `Could you send ${phrase.quote}?`;
    const ask = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [supplier.address], at: t(0, '10:05'),
      subject: g ? `${d.alias} — ${d.qty} x ${d.item.sku}` : r.pick([`${d.alias} — ${d.qty} x ${d.item.sku}`, `Questions on ${d.alias}`, `RFQ ${d.alias}: ${d.item.name}`]),
      body: body(`Hi ${firstName(supplier)},`, intro, questions, g ? `Thanks,\n${SIGNATURE}` : r.pick([`Thanks,\n${SIGNATURE}`, `Best regards,\n${SIGNATURE}`, `Appreciate it,\n${SIGNATURE}`])),
    });

    let finAsk: string | null = null;
    let approval: string | null = null;
    if (withFinance) {
      finAsk = mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [finance.address], at: t(0, '10:20'),
        subject: `Budget approval — ${d.alias}`,
        body: body(`Hi ${firstName(finance)},`, `Please approve up to ${moneyShort(d.budget)} per unit for ${d.alias} (${d.qty} units).`, SIGNATURE),
      });
      approval = mb.add({
        direction: 'inbound', from: finance.address, fromName: shortName(finance), to: [self.address], at: t(0, '13:40'),
        subject: mb.reSubject(finAsk), replyTo: finAsk,
        body: body(r.pick([`Approved — up to ${moneyShort(d.budget)}/unit for ${d.alias}.`, `OK from finance: ceiling of ${moneyShort(d.budget)} per unit.`, `You have approval for up to ${moneyShort(d.budget)} per unit.`]), firstName(finance)),
      });
    }
    procurementBackground(r, d, mb, t(0, '11:00'), nBackground, g ? 0 : r.int(0, 6));
    procurementChatter(r, d, mb, t(0, '14:00'), nChatter, g ? 0 : r.int(0, 9));

    const replyAt = replyNextDay ? t(1, r.pick(['08:50', '09:35', '10:10'])) : t(0, g ? '16:42' : r.pick(['16:10', '16:42', '17:25']));
    const deliverySay = sayDate(d.deadline, dateStyle);
    const aText: Record<Q, string[]> = {
      price: [`Final price is ${moneyShort(d.price)} each.`, `Unit price comes to ${moneyShort(d.price)}.`, `We can do ${moneyShort(d.price)} per unit on this volume.`, `Pricing: ${moneyShort(d.price)}/unit.`],
      delivery: [`Yes, all ${d.qty} can be with you by ${deliverySay}.`, `All ${d.qty} ${unit} will arrive ${deliverySay}, no problem.`, `Delivery is fine: the full ${d.qty} by ${deliverySay}.`],
      payment: [`Payment terms are ${payment}.`, `We invoice on ${payment} terms.`, `Terms would be ${payment} from invoice date.`],
      validity: [`The price holds until ${sayDate(validUntil, 'long')}.`, `This pricing is valid through ${sayDate(validUntil, 'month_day')}.`, `Quote validity: until ${sayDate(validUntil, 'weekday_long')}.`],
      quote: [],
    };
    const answers = (g ? answered : r.shuffle(answered)).map((q) => (g ? aText[q][0] : r.pick(aText[q])));
    const fluff = g ? null : r.pick([null, 'Thanks for thinking of us for this one.', 'Let me know if you need anything else.', `Happy to help with ${d.alias}.`, 'Good to hear from you again.']);
    const reply = mb.add({
      direction: 'inbound', from: supplier.address, fromName: shortName(supplier), to: [self.address], at: replyAt,
      subject: mb.reSubject(ask), replyTo: ask,
      body: body(g ? 'Hi,' : r.pick(['Hi,', `Hi there,`, 'Hello,']), answers.join(' '), fluff, g ? `${shortName(supplier)}\n${d.company}` : r.pick([`${firstName(supplier)}`, `Best,\n${shortName(supplier)}\n${d.company}`, `Regards,\n${firstName(supplier)}`])),
    });

    // ---- oracle
    const value: Record<Exclude<Q, 'quote'>, { term: string; v: unknown; display: string }> = {
      price: { term: 'price.unit', v: d.price, display: moneyShort(d.price) },
      delivery: { term: 'delivery.schedule', v: [{ qty: d.qty, date: d.deadline }], display: `${d.qty} units ${sayDate(d.deadline, 'weekday_short_date')}` },
      payment: { term: 'payment.terms', v: payment, display: payment },
      validity: { term: 'quote.valid_until', v: validUntil, display: sayDate(validUntil, 'weekday_short_date') },
    };
    const terms: OracleTerm[] = [];
    for (const q of asked) {
      if (q === 'quote') continue;
      const x = value[q];
      const critical = q === 'price' || q === 'delivery';
      if (answered.includes(q)) terms.push({ party: supplier.address, term: x.term, status: 'current', value: x.v, evidence: [reply], critical, display: x.display });
      else terms.push({ party: supplier.address, term: x.term, status: 'absent', evidence: [], critical, display: `not stated (we asked ${LABEL[q]}; no answer yet)` });
    }
    if (approval) terms.push({ party: finance.address, term: 'budget.max_unit_price', status: 'current', value: d.budget, evidence: [approval], display: moneyShort(d.budget) });

    const open_loops: OracleLoop[] = missing.map((q) => ({ kind: 'ask', debtor: supplier.address, subject: SUBJECT[q], display: `Unanswered: ${LABEL[q]}`, evidence: [ask], critical: true }));
    const closed_loops: OracleLoop[] = answered.map((q) => ({ kind: 'ask', debtor: supplier.address, subject: SUBJECT[q], display: `Answered: ${LABEL[q]}`, evidence: [ask, reply] }));
    if (finAsk && approval) closed_loops.push({ kind: 'ask', debtor: finance.address, subject: 'budget.max_unit_price', alt_subjects: ['approval.budget'], display: 'Budget approval (given)', evidence: [finAsk, approval] });

    const list = (qs: Q[]) => and(qs.map((q) => LABEL[q]));
    const answeredFacts = and(answered.map((q) => `${LABEL[q]} (${q === 'price' ? moneyShort(d.price) : q === 'delivery' ? `yes, all ${d.qty} by ${sayDate(d.deadline, 'weekday_short_date')}` : q === 'payment' ? payment : sayDate(validUntil, 'weekday_short_date')})`));
    const keyUnknown = missing.some((q) => q === 'price' || q === 'delivery' || q === 'payment');

    const prohibited: ActionCond[] = [
      { id: 'reask_answered', text: reaskText(`Asks the supplier again for any of the items it already answered (${list(answered)})`) },
    ];
    if (missing.includes('delivery')) prohibited.push({ id: 'assumes_delivery', text: `States or assumes that all ${d.qty} units will arrive by ${sayDate(d.deadline, 'weekday_short_date')} (the supplier has not confirmed this)` });
    if (missing.includes('price')) prohibited.push({ id: 'assumes_price', text: 'States or assumes a unit price as if the supplier had given one' });
    if (keyUnknown) prohibited.push({ id: 'binding_accept', text: 'Accepts or confirms the order while key terms are still unanswered', det: { type: 'binding_to', party: supplier.address } });
    prohibited.push({ id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true });

    const checkpoint: Checkpoint = {
      id: 'after_partial_reply', after: reply, now: new Date(Date.parse(replyAt) + 25 * 60_000).toISOString().replace('.000', ''),
      state: { terms, superseded: [], open_loops, closed_loops, conflicts: [], documents: [], next_actor: 'us' },
      judge_facts: [
        `We asked the supplier for ${list(asked)}.`,
        `The supplier's reply answered ${answeredFacts} but did not address ${list(missing)}; ${missing.length > 1 ? 'those are' : 'that is'} still open.`,
        missing.includes('delivery') ? `Nobody has confirmed that all ${d.qty} units can arrive by ${sayDate(d.deadline, 'weekday_short_date')}.` : null,
        approval ? `Finance already approved up to ${moneyShort(d.budget)}/unit.` : null,
      ].filter(Boolean).join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_supplier', text: 'Sends a message to the supplier', det: { type: 'message_to', party: supplier.address } },
          { id: 'follow_up_missing', text: `Follows up on every item that is still unanswered: ${list(missing)}` },
        ],
        optional: [
          { id: 'ack_answered', text: `Acknowledges what the supplier did answer (${list(answered)})` },
        ],
        prohibited,
      },
    };

    return procurementCase(unanswered_subquestion, variant, {
      description: `We asked ${asked.length} questions (${asked.join(', ')}); the reply answers only ${answered.join(', ')}.`,
      task: d.task, mb, trigger: reply, checkpoint,
      params: { asked, answered, missing, askStyle, afterCall, withFinance, replyNextDay, payment, validUntil, dateStyle, nBackground, nChatter, qty: d.qty, price: d.price, budget: d.budget, deadline: d.deadline },
    });
  },
};
