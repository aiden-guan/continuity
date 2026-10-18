// Archetype: stale document (P0).
//
// The vendor sends an invoice PDF carrying six to eight terms (number, total, billed quantity, terms,
// discount and its deadline, due date, remit-to). A later email from AR changes exactly one or two of
// them and says the rest stands: the due date is extended (late delivery), the payment terms move to a
// longer net period (with a new due date), the early-payment window is extended, or the total changes
// (a goodwill credit, or an expedite fee that is not on the PO).
//
// Trap: documents are graded per term. Calling the PDF "current" keeps the dead value alive (e.g. pay
// by the old due date, or the old total); calling it "superseded" throws away the still-valid remit-to,
// quantity and terms. The oracle marks the PDF partially_stale with exactly the changed terms, keeps
// the unchanged ones current (citing the PDF and, where restated, the email), and lists only the changed
// values as superseded. An expedite fee pushes the total above the PO amount (a requirement violation)
// and must be pushed back; otherwise any action is fine as long as it uses the new values.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleConflict, OracleLoop, OracleSuperseded, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, moneyShort, pdf, reaskText, sayDate, seedOf, staleText, type DateStyle } from '../../core/util.ts';
import { arSign, financeBackground, financeCase, financeChatter, financeDayStart, financeDeal, firstName, invoiceLines, later, ours, round2, sayFrom, shortName } from './vertical.ts';

type Change = 'due_date' | 'terms' | 'discount_deadline' | 'amount';
const TERM: Record<Change, string> = { due_date: 'invoice.due_date', terms: 'payment.terms', discount_deadline: 'discount.deadline', amount: 'invoice.amount' };
const NAME: Record<Change, string> = { due_date: 'due date', terms: 'payment terms', discount_deadline: 'discount deadline', amount: 'invoice total' };

export const stale_document: Archetype = {
  id: 'stale_document',
  title: 'One or two terms of an invoice PDF change by email',
  capabilities: ['document_validity', 'supersession'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('finance', 'stale_document', variant));
    const g = variant === 0;
    const d = financeDeal(r, variant);
    const { self, ar, controller } = d.cast;
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => financeDayStart(d, day, hhmm);
    const hasDiscount = d.terms.pct !== null;

    // ---- parameters
    const pool: Change[][] = [['due_date'], ['due_date'], ['amount'], ['terms', 'due_date'], ['amount', 'due_date'], ...(hasDiscount ? [['discount_deadline'], ['due_date', 'discount_deadline']] as Change[][] : [])];
    const changes: Change[] = g ? ['due_date'] : r.pick(pool);
    const amountUp = changes.includes('amount') && (g ? false : r.chance(0.4));
    const delta = amountUp ? r.pick([180, 275, 450, 600]) : r.pick([250, 400, 750, 1200]);
    const newAmount = changes.includes('amount') ? round2(d.amount + (amountUp ? delta : -delta)) : d.amount;
    const newNet = d.terms.net + 15;
    const newTermsText = d.terms.text.replace(`Net ${d.terms.net}`, `Net ${newNet}`);
    const newDue = changes.includes('terms') ? addDays(d.invoiceDate, newNet) : changes.includes('due_date') ? addDays(d.dueDate, g ? 14 : r.pick([7, 10, 14, 21])) : d.dueDate;
    const newDiscount = changes.includes('discount_deadline') ? addDays(d.discountDeadline!, r.pick([4, 5, 7])) : d.discountDeadline;
    const restateStyle = g ? 0 : r.int(0, 2);
    const followUp: 'none' | 'promise' | 'amendment' = g ? 'none' : r.pick(['none', 'promise', 'amendment'] as const);
    const ackInBetween = g ? true : r.chance(0.4);
    const sameThread = g ? true : r.chance(0.7);
    const withController = g ? false : r.chance(0.4);
    const dateStyle: DateStyle = g ? 'long' : r.pick(['long', 'month_day', 'weekday_long', 'weekday_short_date'] as const);
    const nBackground = g ? 2 : r.int(2, 7);
    const nChatter = g ? 0 : r.int(0, 3);
    const file = g ? 'INV-20417.pdf' : r.pick([`${d.alias}.pdf`, `${d.company.split(' ')[0]}_Invoice_${d.alias}.pdf`, `Invoice_${d.alias.replace('INV-', '')}_v1.pdf`]);
    const reason = g ? 'Because the shipment reached you a week late' : r.pick(['Because the shipment reached you late', 'As agreed with your purchasing team after the delayed delivery', 'Given the mix-up with the delivery paperwork', 'Per our account review']);

    // ---- history
    const inv = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: financeDayStart(d, -6, g ? '11:05' : r.pick(['09:30', '11:05', '15:40'])),
      subject: `Invoice ${d.alias} — ${d.po}`,
      body: body('Hi,', g
        ? `Please find attached invoice ${d.alias} for ${d.po}. The total, payment terms, due date and remittance details are on the invoice.`
        : r.pick([
          `Invoice ${d.alias} for ${d.po} is attached: ${moneyShort(d.amount)}, ${d.terms.text}, due ${sayDate(d.dueDate, dateStyle)}.`,
          `Attached is invoice ${d.alias}. Everything (total, terms, due date, bank details) is on the PDF.`,
          `Please see our invoice ${d.alias} attached for the ${d.qty} ${unit} shipped on ${d.po}.`,
        ]), arSign(d, g, r)),
      attachments: [pdf(file, invoiceLines(d))],
    });
    let appAsk: string | null = null;
    let approval: string | null = null;
    if (withController) {
      appAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [controller.address], at: t(0, '09:20'), subject: `Approval request — ${d.alias}`, body: ours(firstName(controller), `Please approve payment of ${d.company} invoice ${d.alias} (${moneyShort(d.amount)}, ${d.po}) up to ${moneyShort(d.approvalMax)}.`) });
      approval = mb.add({ direction: 'inbound', from: controller.address, fromName: shortName(controller), to: [self.address], at: t(0, '13:15'), subject: mb.reSubject(appAsk), replyTo: appAsk, body: body(r.pick([`Approved, up to ${moneyShort(d.approvalMax)}.`, `OK to pay ${d.alias}, ceiling ${moneyShort(d.approvalMax)}.`, `Approved for payment (max ${moneyShort(d.approvalMax)}).`]), firstName(controller)) });
    }
    financeBackground(r, d, mb, financeDayStart(d, -5, '10:00'), nBackground, g ? 0 : r.int(0, 7));
    if (ackInBetween || !withController) {
      mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ar.address], at: t(0, '10:05'), subject: mb.reSubject(inv), replyTo: inv, body: ours(firstName(ar), r.pick(['Thanks, received. It is in our payment queue.', 'Got it, thank you. We will process it in the normal run.', 'Received, thanks.'])), note: 'state-neutral acknowledgement' });
    }
    financeChatter(r, d, mb, t(0, '14:00'), nChatter, g ? 0 : r.int(0, 9));

    // ---- the change email
    const fixAt = t(g ? 1 : r.int(1, 2), g ? '10:12' : r.pick(['09:50', '10:12', '11:30', '14:05']));
    const say = (iso: string | null) => sayFrom(iso ?? d.dueDate, fixAt, dateStyle); // discount dates are null only when that sentence is unused
    const sentences: Record<Change, string[]> = {
      due_date: [`${reason}, we have extended the due date on ${d.alias} to ${say(newDue)}.`, `${reason}, the due date for ${d.alias} moves to ${say(newDue)} (was ${say(d.dueDate)}).`, `${reason}, you can pay ${d.alias} by ${say(newDue)} instead of ${say(d.dueDate)}.`],
      terms: [`${reason}, we are moving ${d.alias} to ${newTermsText} terms, so payment is now due ${say(newDue)}.`, `Our credit team approved ${newTermsText} for this invoice; the new due date is ${say(newDue)}.`, `Please note ${d.alias} is now on ${newTermsText} (due ${say(newDue)}) instead of ${d.terms.text}.`],
      discount_deadline: [`You can still take the ${d.terms.pct}% early-payment discount if payment reaches us by ${say(newDiscount)}.`, `We are extending the discount window: ${d.terms.pct}% off if paid by ${say(newDiscount)}.`, `The ${d.terms.pct}% discount now runs until ${say(newDiscount)} (was ${say(d.discountDeadline)}).`],
      amount: amountUp
        ? [`We have to add an expedite fee of ${moneyShort(delta)}, so the total on ${d.alias} is now ${moneyShort(newAmount)}.`, `Our logistics team charged ${moneyShort(delta)} for the rush shipment; ${d.alias} now totals ${moneyShort(newAmount)}.`, `Please note ${d.alias} is revised to ${moneyShort(newAmount)} to include a ${moneyShort(delta)} expedite charge.`]
        : [`As a goodwill gesture we have taken ${moneyShort(delta)} off ${d.alias}; the total is now ${moneyShort(newAmount)}.`, `We are reducing ${d.alias} by ${moneyShort(delta)}, so the invoice total is now ${moneyShort(newAmount)} (was ${moneyShort(d.amount)}).`, `The total on ${d.alias} is reduced to ${moneyShort(newAmount)} (${moneyShort(delta)} off for the inconvenience).`],
    };
    // a terms change already states the new due date
    const changeText = changes.filter((c) => !(c === 'due_date' && changes.includes('terms'))).map((c) => (g ? sentences[c][0] : r.pick(sentences[c]))).join(' ');
    const all: Change[] = ['amount', 'terms', 'due_date', ...(hasDiscount ? ['discount_deadline' as Change] : [])];
    const unchanged = all.filter((c) => !changes.includes(c));
    const named = unchanged.filter((c) => c !== 'discount_deadline').slice(0, 2);
    const restate = restateStyle === 0 && named.length
      ? `${named.map((c, i) => (i === 0 ? NAME[c][0].toUpperCase() + NAME[c].slice(1) : NAME[c])).join(' and ')}${named.length > 1 ? ' are' : ' is'} unchanged, as are the remittance details.`
      : restateStyle === 2 ? 'All other details as invoiced.' : 'Everything else on the invoice stands.';
    const follow = followUp === 'promise' ? r.pick(["I'll send an updated invoice tomorrow.", "I'll reissue the invoice shortly."]) : followUp === 'amendment' ? r.pick(['Please treat this email as the amendment to the invoice.', 'No new PDF will be issued; this email amends the invoice.']) : null;
    const fix = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: fixAt,
      subject: sameThread ? mb.reSubject(inv) : r.pick([`${d.alias} — update`, `Update to invoice ${d.alias} (${d.po})`]), replyTo: sameThread ? inv : null,
      body: body(g ? 'Hi,' : r.pick(['Hi,', 'Hi again,', 'Hello,']), changeText, restate, follow, arSign(d, g, r)),
    });

    // ---- oracle
    const evFor = (c: Change | null) => (c && changes.includes(c) ? [fix] : [inv, fix]);
    const cur: Record<Change, unknown> = { amount: newAmount, terms: changes.includes('terms') ? newTermsText : d.terms.text, due_date: newDue, discount_deadline: newDiscount };
    const old: Record<Change, unknown> = { amount: d.amount, terms: d.terms.text, due_date: d.dueDate, discount_deadline: d.discountDeadline };
    const show = (c: Change, v: unknown) => (c === 'amount' ? moneyShort(v as number) : c === 'terms' ? String(v) : sayDate(v as string, 'weekday_short_date'));
    const terms: OracleTerm[] = [
      { party: ar.address, term: 'invoice.amount', status: 'current', value: newAmount, evidence: evFor('amount'), critical: true, display: moneyShort(newAmount) },
      { party: ar.address, term: 'invoice.due_date', status: 'current', value: newDue, evidence: evFor('due_date'), critical: true, display: sayDate(newDue, 'weekday_short_date') },
      { party: ar.address, term: 'payment.terms', status: 'current', value: cur.terms, evidence: evFor('terms'), critical: changes.includes('terms'), display: String(cur.terms) },
      { party: ar.address, term: 'invoice.number', status: 'current', value: d.alias, evidence: [inv, fix], display: d.alias },
      { party: ar.address, term: 'invoice.quantity', status: 'current', value: d.qty, evidence: [inv], display: `${d.qty} ${unit}` },
      { party: ar.address, term: 'payment.remit_to', status: 'current', value: d.remitTo, evidence: restateStyle === 0 ? [inv, fix] : [inv], critical: true, display: d.remitTo },
    ];
    if (hasDiscount) {
      terms.push(
        { party: ar.address, term: 'discount.early_pay_pct', status: 'current', value: d.terms.pct, evidence: changes.includes('discount_deadline') ? [inv, fix] : [inv], display: `${d.terms.pct}%` },
        { party: ar.address, term: 'discount.deadline', status: 'current', value: newDiscount, evidence: evFor('discount_deadline'), critical: changes.includes('discount_deadline'), display: sayDate(newDiscount!, 'weekday_short_date') },
      );
    }
    if (approval) terms.push({ party: controller.address, term: 'approval.max_amount', status: 'current', value: d.approvalMax, evidence: [approval], display: moneyShort(d.approvalMax) });
    const superseded: OracleSuperseded[] = changes.map((c) => ({ party: ar.address, term: TERM[c], value: old[c], display: show(c, old[c]), evidence: [inv], superseded_by: fix }));

    const conflicts: OracleConflict[] = amountUp ? [{ kind: 'requirement_violation', term: 'invoice.amount', party: ar.address, display: `Revised total ${moneyShort(newAmount)} includes a ${moneyShort(delta)} expedite fee that is not on ${d.po} (PO amount ${moneyShort(d.amount)})`, critical: true }] : [];
    const violation = conflicts.length > 0;
    const open_loops: OracleLoop[] = followUp === 'promise' ? [{ kind: 'commitment', debtor: ar.address, subject: 'document.invoice', display: 'AR owes an updated invoice', evidence: [fix] }] : [];
    const closed_loops: OracleLoop[] = [];
    if (appAsk && approval) closed_loops.push({ kind: 'ask', debtor: controller.address, subject: 'approval.max_amount', alt_subjects: ['approval.payment'], display: 'Payment approval (given)', evidence: [appAsk, approval] });

    // "Net 30" / "2/10 Net 30" as written embeds the due date and the discount window, so when only the due date or the
    // discount deadline moved, a careful reader may fairly call the PDF's payment terms stale too: either answer is accepted
    const ambiguous = !changes.includes('terms') && (changes.includes('due_date') || changes.includes('discount_deadline')) ? ['payment.terms'] : [];
    const changedFacts = changes.map((c) => `${NAME[c]} changed from ${show(c, old[c])} to ${show(c, cur[c])}`).join('; ');
    const unchangedNames = [...unchanged.map((c) => NAME[c]), 'billed quantity', 'remit-to'].join(', ');
    const prohibited: ActionCond[] = [
      { id: 'stale_value', text: staleText(`Uses a superseded value from the PDF as current (${changes.map((c) => show(c, old[c])).join(' / ')})${amountUp ? `; disputing the fee and holding AR to the ${moneyShort(d.amount)} PO amount is not this` : ''}`), stale: true },
      { id: 'reask_unchanged', text: reaskText(`Asks AR to state or confirm again specific details that did not change (${unchangedNames})`, true) },
    ];
    if (violation) prohibited.push(
      { id: 'pays_fee', text: `Pays, schedules or agrees to the ${moneyShort(newAmount)} total including the expedite fee` },
      // judged, not binding_to: committing to the PO amount without the fee is legitimate and trips the same regex
      { id: 'binding_vendor', text: `Commits to paying the revised ${moneyShort(newAmount)} total or says it is scheduled for payment` },
    );
    if (followUp === 'promise') prohibited.push({ id: 'claims_pdf_arrived', text: 'Says or implies the updated invoice has already been received' });
    prohibited.push({ id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true });

    const checkpoint: Checkpoint = {
      id: 'after_change', after: fix, now: later(fixAt, 20),
      state: {
        terms, superseded, open_loops, closed_loops, conflicts,
        documents: [{ filename: file, status: 'partially_stale', stale_terms: changes.map((c) => TERM[c]), ...(ambiguous.length ? { ambiguous_terms: ambiguous } : {}), display: `${file}: ${changes.map((c) => NAME[c]).join(' and ')} superseded; ${unchangedNames} still current` }],
        next_actor: violation ? 'us' : followUp === 'promise' ? 'them' : 'us',
      },
      judge_facts: [
        `Invoice PDF ${file} (${d.alias}) said: total ${moneyShort(d.amount)} for ${d.qty} ${unit}, terms ${d.terms.text}${hasDiscount ? `, ${d.terms.pct}% discount if paid by ${sayDate(d.discountDeadline!, 'weekday_short_date')}` : ''}, due ${sayDate(d.dueDate, 'weekday_short_date')}, remit to ${d.remitTo}.`,
        `A later email from AR changed only this: ${changedFacts}. Everything else in the PDF (${unchangedNames}) is still valid.`,
        violation ? `The expedite fee is not on ${d.po}, so the revised total breaks the 3-way match and must not be paid as is.` : 'The current terms are within Acme\'s requirements.',
        followUp === 'promise' ? 'AR promised an updated invoice that has not arrived yet.' : null,
      ].filter(Boolean).join(' '),
      action: violation
        ? {
          expect: 'send',
          required: [
            { id: 'to_vendor', text: 'Sends a message to the vendor AR contact', det: { type: 'message_to', party: ar.address } },
            { id: 'raise_fee', text: `Tells AR the ${moneyShort(delta)} expedite fee is not on ${d.po} and asks for it to be removed or justified (e.g. by a PO change)` },
          ],
          optional: [{ id: 'ask_updated_invoice', text: 'Asks for (or mentions) an updated invoice' }],
          prohibited,
        }
        : {
          expect: 'any',
          required: [],
          optional: [
            { id: 'ack_change', text: `Acknowledges the change (${changes.map((c) => NAME[c]).join(' and ')}) to AR using the new value`, det: { type: 'message_to', party: ar.address } },
            { id: 'ask_updated_invoice', text: 'Asks for (or mentions) an updated invoice reflecting the change' },
          ],
          prohibited,
        },
    };

    return financeCase(stale_document, variant, {
      description: `Invoice PDF with ${terms.filter((x) => x.party === ar.address).length} terms; an email changes ${changes.join(' + ')} and keeps the rest${violation ? ' (now breaks the PO match)' : ''}.`,
      task: d.task, mb, trigger: fix, checkpoint,
      params: { changes, amountUp, delta, newAmount, newDue, newTermsText, newDiscount, restateStyle, followUp, ackInBetween, sameThread, withController, dateStyle, nBackground, nChatter, file, amount: d.amount, dueDate: d.dueDate, terms: d.terms.text },
    });
  },
};
