// Archetype: unanswered sub-question (P0).
//
// The vendor invoices N units; purchasing reports that only k were received (or m arrived damaged and
// were rejected). We email AR two or three things at once: a credit memo (or corrected invoice) for the
// shortfall, plus some of: a current W-9 for the vendor master, a statement of account, and whether
// the early-payment discount still holds on the net amount. AR replies, answering only some of them.
//
// Trap: thread-level state ("they replied, ball in our court") closes every request, and a summary
// tends to fold "we asked for a credit" into "credit agreed". The oracle keeps exactly the unanswered
// items open (owed by AR), the answered ones closed (re-asking them is a zombie loop), the credit amount
// `absent` while no credit has been stated, and, while the credit is missing, a 3-way-match violation
// (billed N, received k). The right action follows up on precisely the missing items and does not pay
// the full invoice while the shortfall credit is outstanding.
import type { ActionCond, Archetype, BenchAttachment, BenchCase, Checkpoint, OracleConflict, OracleDocument, OracleLoop, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, body, money, moneyShort, pdf, reaskText, sayDate, seedOf } from '../../core/util.ts';
import { arSign, creditMemoLines, financeBackground, financeCase, financeChatter, financeDayStart, financeDeal, firstName, invoiceLines, invoiceTerms, later, ours, round2, shortName, statementLines, w9Lines } from './vertical.ts';

type Q = 'fix' | 'w9' | 'statement' | 'discount';

const SUBJECT: Record<Q, string> = { fix: 'document.credit_memo', w9: 'document.w9', statement: 'document.statement', discount: 'discount.deadline' };
const ALT: Record<Q, string[]> = { fix: ['document.invoice', 'credit.memo_amount'], w9: [], statement: [], discount: ['discount.early_pay_pct'] };
const LABEL: Record<Q, string> = {
  fix: 'a credit memo (or corrected invoice) for the shortfall',
  w9: 'a current W-9',
  statement: 'a statement of account',
  discount: 'whether the early-payment discount still applies on the net amount',
};

export const unanswered_subquestion: Archetype = {
  id: 'unanswered_subquestion',
  title: 'AR answers only some of our requests',
  capabilities: ['open_loops'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('finance', 'unanswered_subquestion', variant));
    const g = variant === 0;
    const d = financeDeal(r, variant);
    const { self, ar, requester } = d.cast;
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => financeDayStart(d, day, hhmm);

    // ---- parameters
    const hasDiscount = d.terms.pct !== null;
    const extras: Q[] = r.shuffle<Q>(hasDiscount ? ['w9', 'statement', 'discount'] : ['w9', 'statement']);
    const asked: Q[] = g ? ['fix', 'w9'] : ['fix', ...extras.slice(0, r.pick([1, 1, 2]))];
    const nAnswered = g ? 1 : r.int(1, asked.length - 1);
    const answered: Q[] = g ? ['w9'] : r.shuffle(asked).slice(0, nAnswered);
    const missing: Q[] = asked.filter((q) => !answered.includes(q));
    const shortKind: 'short' | 'damaged' = g ? 'short' : r.pick(['short', 'damaged'] as const);
    const shortfall = g ? 10 : Math.max(2, Math.round(d.qty * r.pick([0.04, 0.05, 0.08, 0.1])));
    const received = d.qty - shortfall;
    const credit = round2(shortfall * d.unitPrice);
    const askStyle = g ? 0 : r.int(0, 2);
    const replyNextDay = g ? false : r.chance(0.4);
    const nBackground = g ? 2 : r.int(2, 7);
    const nChatter = g ? 0 : r.int(0, 3);
    const file = g ? `Northwind_Invoice_${d.alias}.pdf` : `${d.company.split(' ')[0]}_Invoice_${d.alias}.pdf`;
    const cmRef = g ? 'CM-3307' : `CM-${r.int(1000, 9999)}`;
    const cmFile = `${cmRef}.pdf`;
    const w9File = g ? 'Northwind_W-9_2026.pdf' : `${d.company.split(' ')[0]}_W9.pdf`;
    const stFile = `Statement_${d.company.split(' ')[0]}_Acme.pdf`;

    // ---- history
    const inv = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: financeDayStart(d, -6, g ? '14:30' : r.pick(['09:50', '14:30', '16:15'])),
      subject: `Invoice ${d.alias} — ${d.po}`,
      body: body('Hi,', g
        ? `Attached is invoice ${d.alias} for ${d.po}: ${d.qty} ${unit}, ${money(d.amount)}, ${d.terms.text}.`
        : r.pick([
          `Please find invoice ${d.alias} attached (${d.po}, ${d.qty} ${unit}). Total ${moneyShort(d.amount)}, terms ${d.terms.text}.`,
          `Invoice ${d.alias} for your ${d.po} is attached: ${moneyShort(d.amount)}, due ${sayDate(d.dueDate, 'month_day')}.`,
          `Here is our invoice ${d.alias} covering the ${d.qty} ${unit} on ${d.po}. Amount due ${money(d.amount)}.`,
        ]), arSign(d, g, r)),
      attachments: [pdf(file, invoiceLines(d))],
    });
    financeBackground(r, d, mb, financeDayStart(d, -5, '10:00'), nBackground, g ? 0 : r.int(0, 7));
    const recAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [requester.address], at: t(0, '09:00'), subject: `Receipt check — ${d.po}`, body: ours(firstName(requester), `${d.company} billed ${d.qty} ${unit} on ${d.alias}. Can you confirm what was received on ${d.po}?`) });
    const recText = shortKind === 'short'
      ? (g ? `We only received ${received} of the ${d.qty}. The packing slip says ${d.qty} but the pallet count was short by ${shortfall}.` : r.pick([
        `Only ${received} ${unit} arrived; the delivery was ${shortfall} short.`,
        `Receiving shows ${received} of ${d.qty}. ${shortfall} never showed up.`,
        `We got ${received}. The shipment was short ${shortfall} ${unit} against the packing slip.`,
      ]))
      : r.pick([
        `All ${d.qty} arrived but ${shortfall} were damaged and rejected at inspection, so we accepted ${received}.`,
        `${shortfall} of the ${d.qty} ${unit} failed inspection (crushed cartons) and were refused. ${received} accepted.`,
        `Accepted ${received}; ${shortfall} came in damaged and we rejected them.`,
      ]);
    const rec = mb.add({ direction: 'inbound', from: requester.address, fromName: shortName(requester), to: [self.address], at: t(0, g ? '10:20' : r.pick(['09:45', '10:20', '11:05'])), subject: mb.reSubject(recAsk), replyTo: recAsk, body: body(recText, firstName(requester)) });

    const qText: Record<Q, string[]> = {
      fix: [`a credit memo for the ${shortfall} ${shortKind === 'short' ? 'missing' : 'rejected'} ${unit} (${moneyShort(credit)})`, `a credit memo or a corrected invoice for the ${shortfall} ${unit} we ${shortKind === 'short' ? 'did not receive' : 'rejected'}`, `credit for the ${shortfall} ${unit} (${shortfall} x ${money(d.unitPrice)})`],
      w9: ['a current W-9 for our vendor file', 'an updated W-9 (ours on file is from 2023)', 'your current W-9, which our tax team needs before year-end'],
      statement: ['a statement of account for Acme', 'a current statement showing all open items', 'an up-to-date statement of our account'],
      discount: [`confirmation that we can still take the ${d.terms.pct}% early-payment discount on the net amount`, `whether the ${d.terms.pct}% discount still applies once the credit is netted off`, `whether the ${d.terms.pct}% early-pay discount holds on the reduced balance`],
    };
    const phrase = Object.fromEntries(asked.map((q) => [q, g ? qText[q][0] : r.pick(qText[q])])) as Record<Q, string>;
    const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] ?? '');
    const intro = shortKind === 'short'
      ? `On ${d.alias} (${d.po}) our receiving team counted ${received} ${unit}, not the ${d.qty} billed.`
      : `On ${d.alias} (${d.po}) ${shortfall} of the ${d.qty} ${unit} were rejected as damaged, so we accepted ${received}.`;
    const questions = askStyle === 0
      ? `Could you send us:\n${asked.map((q, i) => `${i + 1}. ${phrase[q]}${q === 'discount' ? '?' : ''}`).join('\n')}`
      : askStyle === 1
        ? `A few things we need from you:\n${asked.map((q) => `- ${phrase[q]}`).join('\n')}`
        : `Could you send ${and(asked.map((q) => phrase[q]))}?`;
    const ask = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [ar.address], at: t(0, '11:30'),
      subject: g ? mb.reSubject(inv) : r.pick([mb.reSubject(inv), `${d.alias} — short shipment`, `Questions on ${d.alias}`]),
      replyTo: inv,
      body: ours(firstName(ar), intro, questions),
    });
    financeChatter(r, d, mb, t(0, '12:10'), nChatter, g ? 0 : r.int(0, 9));

    // ---- the partial reply
    const replyAt = replyNextDay ? t(1, r.pick(['08:50', '09:35', '10:10'])) : t(0, g ? '16:42' : r.pick(['15:55', '16:42', '17:20']));
    const replyDay = replyAt.slice(0, 10);
    const attachments: BenchAttachment[] = [];
    const aText: Record<Q, string[]> = {
      fix: [`Credit memo ${cmRef} for ${money(credit)} (${shortfall} x ${money(d.unitPrice)}) is attached; you can deduct it from ${d.alias}.`, `I've issued credit memo ${cmRef} for the ${shortfall} ${unit}, ${moneyShort(credit)}. See attached.`, `Attached: ${cmRef}, crediting ${moneyShort(credit)} against ${d.alias}.`],
      w9: ['Our current W-9 is attached.', 'W-9 attached, signed this month.', 'Please find our updated W-9 attached.'],
      statement: ['A statement of account is attached.', 'I have attached your current statement.', 'Statement of account attached for your records.'],
      discount: hasDiscount ? [`Yes, you can take the ${d.terms.pct}% on the net amount as long as payment reaches us by ${sayDate(d.discountDeadline!, 'weekday_long')}.`, `The ${d.terms.pct}% early-pay discount still applies to the net balance if paid by ${sayDate(d.discountDeadline!, 'month_day')}.`, `Discount is fine: ${d.terms.pct}% off the net if we receive payment by ${sayDate(d.discountDeadline!, 'long')}.`] : [],
    };
    const fixAnswered = answered.includes('fix');
    for (const q of answered) {
      if (q === 'fix') attachments.push(pdf(cmFile, creditMemoLines(d, { ref: cmRef, date: replyDay, amount: credit, units: shortfall, reason: shortKind === 'short' ? `Short shipment: ${shortfall} ${unit} not delivered` : `${shortfall} ${unit} damaged in transit and rejected` })));
      if (q === 'w9') attachments.push(pdf(w9File, w9Lines(d, replyDay)));
      if (q === 'statement') attachments.push(pdf(stFile, statementLines(d, replyDay, fixAnswered ? [{ ref: d.alias, amount: d.amount }, { ref: cmRef, amount: -credit }] : [{ ref: d.alias, amount: d.amount }])));
    }
    const answers = (g ? answered : r.shuffle(answered)).map((q) => (g ? aText[q][0] : r.pick(aText[q])));
    const fluff = g ? null : r.pick([null, 'Thanks for flagging it.', 'Let me know if you need anything else.', 'Have a good evening.', 'Good to hear from you.']);
    const reply = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: replyAt,
      subject: mb.reSubject(ask), replyTo: ask,
      body: body(g ? 'Hi,' : r.pick(['Hi,', 'Hi there,', 'Hello,']), answers.join(' '), fluff, arSign(d, g, r)),
      attachments,
    });

    // ---- oracle
    const terms: OracleTerm[] = invoiceTerms(d, [inv], { critical: ['invoice.amount'] });
    if (answered.includes('discount')) for (const x of terms) if (x.term.startsWith('discount.')) x.evidence = [inv, reply];
    terms.push(
      { party: ar.address, term: 'invoice.quantity', status: 'current', value: d.qty, evidence: [inv], display: `${d.qty} ${unit} billed` },
      { party: requester.address, term: 'receipt.quantity', status: 'current', value: received, evidence: [rec], critical: true, display: `${received} ${unit} received / accepted` },
      fixAnswered
        ? { party: ar.address, term: 'credit.memo_amount', status: 'current', value: credit, evidence: [reply], critical: true, display: `${moneyShort(credit)} (${cmRef})` }
        : { party: ar.address, term: 'credit.memo_amount', status: 'absent', evidence: [], critical: true, display: 'not stated (we asked for a credit; no answer yet)' },
    );
    const open_loops: OracleLoop[] = missing.map((q) => ({ kind: 'ask', debtor: ar.address, subject: SUBJECT[q], alt_subjects: ALT[q].length ? ALT[q] : undefined, display: `Unanswered: ${LABEL[q]}`, evidence: [ask], critical: true }));
    const closed_loops: OracleLoop[] = [
      ...answered.map((q): OracleLoop => ({ kind: 'ask', debtor: ar.address, subject: SUBJECT[q], alt_subjects: ALT[q].length ? ALT[q] : undefined, display: `Answered: ${LABEL[q]}`, evidence: [ask, reply] })),
      { kind: 'ask', debtor: requester.address, subject: 'receipt.quantity', alt_subjects: ['receipt.confirmation'], display: 'Receipt check (answered)', evidence: [recAsk, rec] },
    ];
    const conflicts: OracleConflict[] = fixAnswered ? [] : [{ kind: 'requirement_violation', term: 'invoice.quantity', party: ar.address, display: `Billed ${d.qty} ${unit} but only ${received} received; no credit yet for the ${shortfall}`, critical: true }];
    const documents: OracleDocument[] = [
      { filename: file, status: 'current', stale_terms: [], display: `${file}: current (the shortfall is handled by a separate credit)` },
      ...(answered.includes('fix') ? [{ filename: cmFile, status: 'current' as const, stale_terms: [], display: `${cmFile}: current` }] : []),
      ...(answered.includes('w9') ? [{ filename: w9File, status: 'current' as const, stale_terms: [], display: `${w9File}: current` }] : []),
      ...(answered.includes('statement') ? [{ filename: stFile, status: 'current' as const, stale_terms: [], display: `${stFile}: current` }] : []),
    ];

    const list = (qs: Q[]) => and(qs.map((q) => LABEL[q]));
    const prohibited: ActionCond[] = [
      { id: 'reask_answered', text: reaskText(`Asks AR again about ${list(answered)}, which AR already ${answered.length > 1 ? 'provided' : 'provided / answered'}`) },
      { id: 'reask_receipt', text: reaskText('Asks purchasing again what was received (already confirmed)') },
    ];
    if (!fixAnswered) {
      prohibited.push(
        { id: 'assumes_credit', text: 'States or implies that AR has already agreed to or issued a credit for the shortfall (Acme deducting the unreceived units on its own, e.g. a short-payment with a note, is not this)' },
        { id: 'pays_full', text: `Pays, schedules or approves the full ${moneyShort(d.amount)} for ${d.qty} ${unit} while only ${received} were received` },
        // no binding_to check: short-paying the received units while the credit memo is outstanding is legitimate
      );
    }
    prohibited.push({ id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true });

    const answeredFacts = and(answered.map((q) => (q === 'fix' ? `credit memo ${cmRef} for ${moneyShort(credit)}` : q === 'w9' ? 'the W-9' : q === 'statement' ? 'the statement of account' : `the ${d.terms.pct}% discount still applies on the net amount`)));
    const checkpoint: Checkpoint = {
      id: 'after_partial_reply', after: reply, now: later(replyAt, 25),
      state: { terms, superseded: [], open_loops, closed_loops, conflicts, documents, next_actor: 'us' },
      judge_facts: [
        `${d.company} invoiced ${d.qty} ${unit} (${moneyShort(d.amount)}) on ${d.alias}; purchasing confirmed only ${received} were ${shortKind === 'short' ? 'received' : 'accepted'} (${shortfall} ${shortKind === 'short' ? 'short' : 'rejected as damaged'}).`,
        `We asked AR for ${list(asked)}. AR's reply provided ${answeredFacts} but did not address ${list(missing)}; ${missing.length > 1 ? 'those are' : 'that is'} still open.`,
        fixAnswered ? `With the ${moneyShort(credit)} credit the net payable is ${moneyShort(round2(d.amount - credit))}.` : `No credit has been issued yet, so the invoice still bills ${shortfall} ${unit} that Acme did not accept: paying the full ${moneyShort(d.amount)} is wrong, while holding or paying only the ${received} accepted (${moneyShort(round2(received * d.unitPrice))}) is fine.`,
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_vendor', text: 'Sends a message to the vendor AR contact', det: { type: 'message_to', party: ar.address } },
          { id: 'follow_up_missing', text: `Follows up on exactly what is still unanswered: ${list(missing)}` },
        ],
        optional: [{ id: 'ack_answered', text: `Acknowledges what AR did provide (${list(answered)})` }],
        prohibited,
      },
    };

    return financeCase(unanswered_subquestion, variant, {
      description: `Shortfall of ${shortfall} on ${d.alias}; we asked for ${asked.join(', ')}; AR answers only ${answered.join(', ')}.`,
      task: d.task, mb, trigger: reply, checkpoint,
      params: { asked, answered, missing, shortKind, shortfall, received, credit, askStyle, replyNextDay, nBackground, nChatter, amount: d.amount, terms: d.terms.text },
    });
  },
};
