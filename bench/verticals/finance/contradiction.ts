// Archetype: contradiction within one group (P1).
//
// Two people on the vendor's side (same group, both allowed to speak about the account) disagree:
//   balance  (golden) after Acme rejects damaged units, the account manager says a credit was approved
//            and Acme owes the invoice total minus that credit; AR says no credit exists and the full
//            total is outstanding;
//   terms    the account manager says Acme's account is on "2/10 Net N" and the early-payment discount
//            applies; AR (and the invoice) say plain "Net N", no discount.
// The order varies: sometimes AR speaks first, sometimes the account manager.
//
// Trap: "newest wins" adopts whichever message came last (often the convenient one) and marks the
// other as superseded. But neither speaker retracted anything; a disagreement inside one group is a
// contradiction, not a correction, and the account manager's word is not a credit memo. The oracle
// has the term `contested` with both values (each with its own speaker and evidence), nothing
// superseded, and a contradiction conflict. The right action asks the vendor to reconcile (a credit
// memo, or AR's written confirmation of the terms) and treats neither figure as confirmed in the meantime
// (for "balance", holding or paying only the accepted units on Acme's own deduction stays legitimate).
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleConflict, OracleLoop, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, body, money, moneyShort, pdf, reaskText, sayDate, seedOf } from '../../core/util.ts';
import { ackInvoice, addParty, arSign, financeBackground, financeCase, financeChatter, financeDayStart, financeDeal, firstName, invoiceLines, invoiceTerms, later, ours, round2, shortName } from './vertical.ts';

export const contradiction: Archetype = {
  id: 'contradiction',
  title: 'Vendor AR and the account manager disagree on the balance or the terms',
  capabilities: ['conflict_vs_supersession'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('finance', 'contradiction', variant));
    const g = variant === 0;
    const kind: 'balance' | 'terms' = g ? 'balance' : r.pick(['balance', 'balance', 'terms'] as const);
    const d = financeDeal(r, variant, { terms: 'net' });
    const { self, ar, rep, requester } = d.cast;
    addParty(d, rep);
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => financeDayStart(d, day, hhmm);

    // ---- parameters
    const rejected = g ? 8 : Math.max(2, Math.round(d.qty * r.pick([0.03, 0.05, 0.08])));
    const accepted = d.qty - rejected;
    const credit = round2(rejected * d.unitPrice);
    const repBalance = round2(d.amount - credit);
    const repTerms = `2/10 Net ${d.terms.net}`;
    const repFirst = g ? true : r.chance(0.5);
    const repInThread = g ? false : r.chance(0.5);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 3);
    const file = g ? `Northwind_Invoice_${d.alias}.pdf` : `${d.company.split(' ')[0]}_Invoice_${d.alias}.pdf`;

    // ---- history
    const inv = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: financeDayStart(d, -6, g ? '15:10' : r.pick(['10:20', '13:45', '15:10'])),
      subject: `Invoice ${d.alias} — ${d.po}`,
      body: body('Hi,', g
        ? `Please find attached invoice ${d.alias} for ${d.po}: ${d.qty} ${unit}, ${money(d.amount)}, ${d.terms.text}.`
        : r.pick([
          `Attached is invoice ${d.alias} (${d.po}): ${moneyShort(d.amount)}, terms ${d.terms.text}.`,
          `Invoice ${d.alias} for the ${d.qty} ${unit} is attached; ${money(d.amount)} due ${sayDate(d.dueDate, 'month_day')}.`,
          `Please see our invoice ${d.alias} attached.`,
        ]), arSign(d, g, r)),
      attachments: [pdf(file, invoiceLines(d))],
    });
    financeBackground(r, d, mb, financeDayStart(d, -5, '10:00'), nBackground, g ? 0 : r.int(0, 7));

    let rec: string | null = null;
    let ask: string | null = null;
    if (kind === 'terms') ackInvoice(r, d, mb, inv, financeDayStart(d, -5, '09:20'));
    if (kind === 'balance') {
      rec = mb.add({ direction: 'inbound', from: requester.address, fromName: shortName(requester), to: [self.address], at: t(0, '09:10'), subject: `${d.po} — damaged ${unit}`, body: body(g ? `${rejected} of the ${d.qty} ${unit} on ${d.po} were damaged and we rejected them. ${accepted} accepted.` : r.pick([`FYI ${rejected} ${unit} from ${d.company} came in damaged and were refused; ${accepted} accepted.`, `We rejected ${rejected} of the ${d.qty} ${unit} (damaged in transit). ${accepted} are in stock.`]), firstName(requester)) });
      ask = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ar.address], cc: [rep.address], at: t(0, '10:00'), subject: mb.reSubject(inv), replyTo: inv, body: ours(firstName(ar), `On ${d.alias} we rejected ${rejected} damaged ${unit} (${accepted} accepted). Please credit the ${rejected} ${unit} (${moneyShort(credit)}) and confirm the balance we owe.`) });
    }
    financeChatter(r, d, mb, t(0, '11:00'), nChatter, g ? 0 : r.int(0, 9));

    const repAt = repFirst ? t(0, g ? '15:30' : r.pick(['13:40', '15:30', '16:20'])) : t(1, r.pick(['10:15', '11:30', '14:00']));
    const arAt = repFirst ? t(1, g ? '09:40' : r.pick(['09:40', '11:10', '13:55'])) : t(0, r.pick(['14:10', '15:50']));
    const repText = kind === 'balance'
      ? (g ? `I've approved a credit of ${money(credit)} for the ${rejected} damaged ${unit}, so you only owe ${money(repBalance)} on ${d.alias}.` : r.pick([
        `Sorry about the damage. I've signed off a ${moneyShort(credit)} credit, so the balance on ${d.alias} is ${moneyShort(repBalance)}.`,
        `Good news: the ${rejected} damaged ${unit} are credited (${moneyShort(credit)}). Please just pay ${moneyShort(repBalance)}.`,
        `I took care of it with our team: ${d.alias} comes down by ${moneyShort(credit)} to ${moneyShort(repBalance)}.`,
      ]))
      : r.pick([
        `Just a reminder that your account is on ${repTerms}: take 2% off ${d.alias} if you pay within 10 days.`,
        `Per our agreement Acme gets ${repTerms}, so feel free to take the 2% on ${d.alias}.`,
        `Quick note from your account manager: your terms are ${repTerms}, so the 2% early-payment discount applies to ${d.alias}.`,
      ]);
    const repMsg = mb.add({
      direction: 'inbound', from: rep.address, fromName: shortName(rep), to: [self.address], cc: [ar.address], at: repAt,
      subject: kind === 'balance' && repInThread && ask ? mb.reSubject(inv) : kind === 'balance' ? `${d.alias} — damaged ${unit}` : `${d.company} account — payment terms`,
      replyTo: kind === 'balance' && repInThread && ask ? ask : null,
      body: body('Hi,', repText, `${shortName(rep)}\nAccount Manager, ${d.company}`),
    });
    const arText = kind === 'balance'
      ? (g ? `Our records show the full ${money(d.amount)} outstanding on ${d.alias}; no credit has been issued or approved. Please remit the full amount by ${sayDate(d.dueDate, 'long')}.` : r.pick([
        `I don't see any credit on ${d.alias}. The balance is ${moneyShort(d.amount)}, due ${sayDate(d.dueDate, 'month_day')}.`,
        `No credit memo has been approved for ${d.alias}; ${moneyShort(d.amount)} remains due in full.`,
        `Our system shows ${money(d.amount)} open on ${d.alias} and no credits. Please pay the invoice as issued.`,
      ]))
      : r.pick([
        `Reminder: ${d.alias} is due ${sayDate(d.dueDate, 'long')} on ${d.terms.text} terms. Your account does not have an early-payment discount.`,
        `Just confirming ${d.alias} is ${d.terms.text}; there is no discount on your account, so please pay the full ${moneyShort(d.amount)}.`,
        `Please note your terms with us are ${d.terms.text}, no early-pay discount. ${d.alias} is payable in full.`,
      ]);
    const arMsg = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: arAt,
      subject: kind === 'balance' && ask ? mb.reSubject(inv) : `${d.alias} — payment reminder`,
      replyTo: kind === 'balance' && ask ? ask : null,
      body: body('Hi,', arText, arSign(d, g, r)),
    });
    const trigger = repFirst ? arMsg : repMsg;
    const trigAt = mb.get(trigger).at;

    // ---- oracle
    const terms: OracleTerm[] = invoiceTerms(d, [inv], { critical: ['invoice.amount'], skip: kind === 'terms' ? ['payment.terms'] : [] });
    let conflictDisplay: string;
    if (kind === 'balance') {
      terms.push({
        party: ar.address, term: 'balance.due', status: 'contested', critical: true,
        contested: [{ party: ar.address, value: d.amount, evidence: [arMsg] }, { party: rep.address, value: repBalance, evidence: [repMsg] }],
        evidence: [arMsg, repMsg],
        display: `contested: AR says ${moneyShort(d.amount)} (no credit); the account manager says ${moneyShort(repBalance)} after a ${moneyShort(credit)} credit`,
      });
      terms.push({ party: requester.address, term: 'receipt.quantity', status: 'current', value: accepted, evidence: [rec!], display: `${accepted} accepted (${rejected} rejected)` });
      conflictDisplay = `AR says ${moneyShort(d.amount)} is owed with no credit; the account manager says a ${moneyShort(credit)} credit was approved (${moneyShort(repBalance)} owed)`;
    } else {
      terms.push({
        party: ar.address, term: 'payment.terms', status: 'contested', critical: true,
        contested: [{ party: ar.address, value: d.terms.text, evidence: [inv, arMsg] }, { party: rep.address, value: repTerms, evidence: [repMsg] }],
        evidence: [inv, arMsg, repMsg],
        display: `contested: AR and the invoice say ${d.terms.text}; the account manager says ${repTerms}`,
      });
      conflictDisplay = `AR says ${d.terms.text} with no discount; the account manager says ${repTerms}`;
    }
    const conflicts: OracleConflict[] = [{ kind: 'contradiction', term: kind === 'balance' ? 'balance.due' : 'payment.terms', party: ar.address, display: conflictDisplay, critical: true }];
    if (kind === 'balance') conflicts.push({ kind: 'requirement_violation', term: 'invoice.quantity', party: ar.address, display: `Invoice bills ${d.qty} ${unit}; only ${accepted} were accepted and no credit memo exists` });
    const open_loops: OracleLoop[] = [];
    const closed_loops: OracleLoop[] = [];
    if (ask) open_loops.push({ kind: 'ask', debtor: ar.address, subject: 'document.credit_memo', alt_subjects: ['credit.memo_amount', 'balance.due'], display: 'Credit memo for the rejected units (not issued; the account manager says approved, AR says no)', evidence: [ask] });
    if (rec) terms.push({ party: ar.address, term: 'invoice.quantity', status: 'current', value: d.qty, evidence: [inv], display: `${d.qty} ${unit} billed` });

    const vA = kind === 'balance' ? moneyShort(d.amount) : d.terms.text;
    const vB = kind === 'balance' ? moneyShort(repBalance) : repTerms;
    const prohibited: ActionCond[] = [
      { id: 'settles_ar', text: kind === 'balance' ? `Accepts ${vA} (no credit) as what Acme owes, or pays it (it includes the ${rejected} rejected ${unit})` : `Accepts ${vA} (no discount) as final without raising the account manager's ${vB} claim with the vendor` },
      { id: 'settles_rep', text: kind === 'balance' ? `States or implies that the vendor has issued or confirmed the ${moneyShort(credit)} credit (it has not: AR denies it and there is no credit memo)` : `Takes the 2% discount or treats ${vB} as the confirmed terms` },
      // No binding_to check: in "balance" Acme may legitimately commit to paying only the accepted units
      // (its own deduction, which happens to equal the account manager's figure); in "terms" paying in full is safe.
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    if (rec) prohibited.push({ id: 'reask_receipt', text: reaskText('Asks purchasing again how many units were accepted (already reported)') });
    const checkpoint: Checkpoint = {
      id: 'after_contradiction', after: trigger, now: later(trigAt, 20),
      state: {
        terms, superseded: [], open_loops, closed_loops, conflicts,
        documents: [{ filename: file, status: 'current', stale_terms: [], display: `${file}: current (the disagreement is about ${kind === 'balance' ? 'a credit, not the invoice face amount' : 'the terms, and the invoice is one side of it'})` }],
        next_actor: 'us',
      },
      judge_facts: [
        kind === 'balance'
          ? `${d.company} invoice ${d.alias} is ${moneyShort(d.amount)} for ${d.qty} ${unit}; Acme rejected ${rejected} damaged ${unit}. The account manager (${shortName(rep)}) says a ${moneyShort(credit)} credit was approved and ${moneyShort(repBalance)} is owed; AR (${shortName(ar)}) says no credit exists and ${moneyShort(d.amount)} is owed.`
          : `${d.company} invoice ${d.alias} is ${moneyShort(d.amount)} on ${d.terms.text}. The account manager (${shortName(rep)}) says Acme's terms are ${repTerms} and the 2% discount applies; AR (${shortName(ar)}) says ${d.terms.text} with no discount.`,
        'Both work for the vendor; neither retracted. It is unresolved and no credit memo / written terms change exists.',
        kind === 'balance' ? `Independently of the dispute, Acme accepted only ${accepted} ${unit}: it must not pay the full ${moneyShort(d.amount)}, but it may hold payment or pay only for the accepted units (its own short-payment), while asking for the credit memo.` : null,
        `The invoice is due ${sayDate(d.dueDate, 'weekday_short_date')}, so there is time to reconcile.`,
      ].filter(Boolean).join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_vendor', text: 'Sends a message to the vendor (AR or the account manager)', det: { type: 'message_to_any', parties: [ar.address, rep.address] } },
          { id: 'reconcile', text: `Points out the discrepancy (${vA} from AR vs ${vB} from the account manager) and asks the vendor to reconcile it${kind === 'balance' ? ', e.g. by issuing the credit memo or confirming no credit applies' : ', e.g. by confirming the terms in writing'}` },
        ],
        optional: [{ id: 'hold_payment', text: 'Says Acme will pay once the vendor confirms the correct figure' }],
        prohibited,
      },
    };

    return financeCase(contradiction, variant, {
      description: `${kind === 'balance' ? `AR says ${vA} owed; account manager says ${vB} after a credit` : `AR says ${vA}; account manager says ${vB}`} (${repFirst ? 'account manager first' : 'AR first'}).`,
      task: d.task, mb, trigger, checkpoint,
      params: { kind, rejected, credit, repBalance, repTerms, repFirst, repInThread, nBackground, nChatter, amount: d.amount, terms: d.terms.text },
    });
  },
};
