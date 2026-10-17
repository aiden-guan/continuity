// Archetype: late evidence (P1).
//
// AR sends the invoice (copying an Acme colleague: the controller or purchasing), then corrects one
// term in a follow-up sent only to us: the total (a rebate or billing error, lower) or the due date
// (the invoice date was mis-keyed, so the invoice is due a week EARLIER). A day or two later the
// colleague, who never saw the correction, forwards the ORIGINAL invoice email with its old date header
// and the old PDF and says they are acting on it ("approving $48,000 for Thursday's run", "accrued
// $48,000 for month-end", "scheduled for the Nov 12 run" — which would now be late).
//
// Trap: the forward is the newest message and repeats the old value verbatim, so recency-based state
// or a summary refreshed on the latest message resurrects it. The oracle keeps the corrected value
// current, the old value superseded (the forward is just a copy of the superseded evidence), the old
// PDF stale on that term, and an open ask: we owe the colleague a correction.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleDocument, OracleLoop, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, money, moneyShort, pdf, sayDate, seedOf, staleText } from '../../core/util.ts';
import { arSign, financeBackground, financeCase, financeChatter, financeDayStart, financeDeal, firstName, invoiceLines, invoiceTerms, later, ours, round2, shortName } from './vertical.ts';

export const late_evidence: Archetype = {
  id: 'late_evidence',
  title: 'An old copy of a corrected invoice is forwarded after the correction',
  capabilities: ['late_evidence', 'supersession', 'document_validity'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('finance', 'late_evidence', variant));
    const g = variant === 0;
    const corrected: 'amount' | 'due_date' = g ? 'amount' : r.pick(['amount', 'amount', 'due_date'] as const);
    const d = financeDeal(r, variant, { terms: corrected === 'due_date' ? 'net' : undefined });
    const { self, ar, controller, requester } = d.cast;
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => financeDayStart(d, day, hhmm);

    // ---- parameters
    const colleague = corrected === 'due_date' ? controller : g ? controller : r.chance(0.6) ? controller : requester;
    const pct = g ? 2.5 : r.pick([2, 2.5, 3, 4]);
    const newAmount = round2(d.amount * (1 - pct / 100));
    const newInvoiceDate = addDays(d.invoiceDate, -7);
    const newDue = addDays(d.dueDate, -7);
    const revised: 'attached' | 'promised' | 'none' = g ? 'attached' : r.pick(['attached', 'attached', 'promised', 'none'] as const);
    const withApproval = colleague === controller && corrected === 'amount' ? false : g ? false : r.chance(0.5);
    const ourAck = g ? true : !withApproval || r.chance(0.5);
    const fwdDay = g ? 2 : r.int(2, 3);
    const runDay = addDays(d.start, 3); // Thursday
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 3);
    const v1 = g ? `Northwind_Invoice_${d.alias}.pdf` : `${d.company.split(' ')[0]}_Invoice_${d.alias}.pdf`;
    const v2 = g ? `Northwind_Invoice_${d.alias}_REV1.pdf` : `${d.company.split(' ')[0]}_Invoice_${d.alias}_rev.pdf`;

    // ---- history
    const invAt = financeDayStart(d, -6, g ? '15:10' : r.pick(['10:20', '13:45', '15:10']));
    const invBody = body('Hi,', g
      ? `Please find attached invoice ${d.alias} for ${d.po}: ${d.qty} ${unit}, ${money(d.amount)}, due ${sayDate(d.dueDate, 'long')}. Copying ${firstName(colleague)} as requested.`
      : r.pick([
        `Attached is invoice ${d.alias} (${d.po}): ${moneyShort(d.amount)}, ${d.terms.text}, due ${sayDate(d.dueDate, 'month_day')}.`,
        `Invoice ${d.alias} for the ${d.qty} ${unit} on ${d.po} is attached. Total ${money(d.amount)}, payable by ${sayDate(d.dueDate, 'weekday_long')}.`,
        `Please see invoice ${d.alias} attached: ${moneyShort(d.amount)} due ${sayDate(d.dueDate, 'long')}.`,
      ]), arSign(d, g, r));
    const v1Lines = invoiceLines(d);
    const inv = mb.add({ direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], cc: [colleague.address], at: invAt, subject: `Invoice ${d.alias} — ${d.po}`, body: invBody, attachments: [pdf(v1, v1Lines)] });
    financeBackground(r, d, mb, financeDayStart(d, -5, '10:00'), nBackground, g ? 0 : r.int(0, 7));
    let appAsk: string | null = null;
    let approval: string | null = null;
    if (withApproval) {
      appAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [controller.address], at: t(0, '09:00'), subject: `Approval request — ${d.alias}`, body: ours(firstName(controller), `Please approve payment of ${d.company} ${d.alias} up to ${moneyShort(d.approvalMax)}.`) });
      approval = mb.add({ direction: 'inbound', from: controller.address, fromName: shortName(controller), to: [self.address], at: t(0, '10:40'), subject: mb.reSubject(appAsk), replyTo: appAsk, body: body(`Approved up to ${moneyShort(d.approvalMax)}.`, firstName(controller)) });
    }
    const fixAt = t(0, g ? '11:40' : r.pick(['11:40', '13:05', '15:20']));
    const fixText = corrected === 'amount'
      ? (g ? `Correction to ${d.alias}: we forgot to apply your ${pct}% volume rebate. The correct total is ${money(newAmount)}. Due date and remittance details are unchanged.`
        : r.pick([
          `Correction: ${d.alias} should have included your ${pct}% rebate, so the total is ${moneyShort(newAmount)}, not ${moneyShort(d.amount)}. Everything else stands.`,
          `Sorry, ${d.alias} went out without your ${pct}% discount. Correct amount: ${money(newAmount)}. Other details unchanged.`,
          `Please note ${d.alias} is corrected to ${moneyShort(newAmount)} (${pct}% rebate applied).`,
        ]))
      : r.pick([
        `Correction to ${d.alias}: the invoice date was keyed wrong. It should be ${sayDate(newInvoiceDate, 'month_day')} (the ship date), so the due date is ${sayDate(newDue, 'long')}, not ${sayDate(d.dueDate, 'month_day')}.`,
        `I need to correct ${d.alias}: invoice date ${sayDate(newInvoiceDate, 'month_day')}, which makes it due ${sayDate(newDue, 'weekday_long')} on ${d.terms.text}. The amount is unchanged.`,
        `Our system printed the wrong invoice date on ${d.alias}. With the correct date the invoice is due ${sayDate(newDue, 'long')}.`,
      ]);
    const v2Lines = invoiceLines(d, corrected === 'amount'
      ? { revision: 'Revised', credits: [{ desc: `Volume rebate ${pct}%`, amount: round2(d.amount - newAmount) }] }
      : { revision: 'Revised', date: newInvoiceDate, dueDate: newDue });
    const fix = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: fixAt,
      subject: mb.reSubject(inv), replyTo: inv,
      body: body('Hi,', fixText, revised === 'attached' ? 'Revised invoice attached.' : revised === 'promised' ? "I'll send a revised invoice shortly." : null, firstName(ar)),
      attachments: revised === 'attached' ? [pdf(v2, v2Lines)] : undefined,
      note: 'sent to us only; the colleague was not copied',
    });
    if (ourAck) mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ar.address], at: later(fixAt, 50), subject: mb.reSubject(inv), replyTo: fix, body: ours(firstName(ar), 'Thanks for letting me know, noted.'), note: 'state-neutral' });
    financeChatter(r, d, mb, t(1, '09:00'), nChatter, g ? 0 : r.int(0, 9));

    // ---- the late copy
    const fwdAt = t(fwdDay, g ? '10:05' : r.pick(['08:50', '10:05', '14:15']));
    const oldValue = corrected === 'amount' ? moneyShort(d.amount) : sayDate(d.dueDate, 'month_day');
    const comment = corrected === 'due_date'
      ? r.pick([
        `I've put ${d.alias} in the ${sayDate(d.dueDate, 'month_day')} payment run per the due date below. Shout if that's wrong.`,
        `Scheduling ${d.company} for ${sayDate(d.dueDate, 'month_day')} as per the invoice below, no need to rush it.`,
        `FYI I'm holding ${d.alias} until the ${sayDate(d.dueDate, 'month_day')} run, it isn't due before then.`,
      ])
      : colleague === controller
        ? (g ? `Approving ${d.alias} for ${moneyShort(d.amount)} per the invoice below. Please pay it in ${sayDate(runDay, 'weekday')}'s run.` : r.pick([
          `Approved for ${moneyShort(d.amount)} as per below; go ahead and pay it ${sayDate(runDay, 'weekday')}.`,
          `I've signed off ${d.alias} at ${moneyShort(d.amount)} (invoice below). Please release it in the next run.`,
          `Found this in my inbox. ${d.alias}, ${moneyShort(d.amount)}: approved, please pay.`,
        ]))
        : r.pick([
          `I've accrued ${moneyShort(d.amount)} against ${d.po} for month-end based on the invoice below. OK?`,
          `For the month-end accrual I'm using ${moneyShort(d.amount)} for ${d.alias} (below). Let me know if that's off.`,
          `Booking ${moneyShort(d.amount)} to the ${d.po} budget per the invoice below.`,
        ]);
    const hh = Number(invAt.slice(11, 13));
    const header = [
      '---------- Forwarded message ---------',
      `From: ${shortName(ar)} <${ar.address}>`,
      `Date: ${sayDate(invAt, 'weekday_short_date').replace(/^(\w{3}) (\w{3}) (\d+)$/, '$1, $2 $3')}, 2026 at ${hh % 12 || 12}:${invAt.slice(14, 16)} ${hh >= 12 ? 'PM' : 'AM'}`,
      `Subject: ${mb.get(inv).subject}`,
      `To: ${self.address}`,
      `Cc: ${colleague.address}`,
    ].join('\n');
    const fwd = mb.add({
      direction: 'inbound', from: colleague.address, fromName: shortName(colleague), to: [self.address], at: fwdAt,
      subject: `Fwd: ${mb.get(inv).subject}`,
      body: body('Hi,', comment, firstName(colleague), `${header}\n\n${invBody}`),
      attachments: [pdf(v1, v1Lines)],
      quoteParent: false,
      note: 'late copy of the original (pre-correction) invoice',
    });

    // ---- oracle
    const isA = corrected === 'amount';
    const term = isA ? 'invoice.amount' : 'invoice.due_date';
    const terms: OracleTerm[] = invoiceTerms(d, [inv, fwd], { skip: [term], critical: ['invoice.amount', 'invoice.due_date'] });
    terms.unshift({ party: ar.address, term, status: 'current', value: isA ? newAmount : newDue, evidence: [fix], critical: true, display: isA ? moneyShort(newAmount) : sayDate(newDue, 'weekday_short_date') });
    if (approval) terms.push({ party: controller.address, term: 'approval.max_amount', status: 'current', value: d.approvalMax, evidence: [approval], display: moneyShort(d.approvalMax) });
    if (colleague === controller && isA) terms.push({ party: controller.address, term: 'approval.max_amount', status: 'current', value: d.amount, evidence: [fwd], display: `${moneyShort(d.amount)} (the controller's sign-off, which covers the corrected total)` });
    const oldDisplay = isA ? moneyShort(d.amount) : sayDate(d.dueDate, 'weekday_short_date');
    const newDisplay = isA ? moneyShort(newAmount) : sayDate(newDue, 'weekday_short_date');
    const open_loops: OracleLoop[] = [
      { kind: 'ask', debtor: self.address, subject: term, display: `${firstName(colleague)} is acting on the old ${isA ? 'total' : 'due date'} (${oldDisplay}) and needs the corrected value`, evidence: [fwd], critical: true },
    ];
    if (revised === 'promised') open_loops.push({ kind: 'commitment', debtor: ar.address, subject: 'document.invoice', display: 'AR owes a revised invoice', evidence: [fix] });
    const closed_loops: OracleLoop[] = [];
    if (appAsk && approval) closed_loops.push({ kind: 'ask', debtor: controller.address, subject: 'approval.max_amount', alt_subjects: ['approval.payment'], display: 'Payment approval (given)', evidence: [appAsk, approval] });
    // a moved due date also makes the PDF's written terms ("Net 30") arguably stale: either answer is accepted
    const documents: OracleDocument[] = [{ filename: v1, status: 'partially_stale', stale_terms: [term], ...(isA ? {} : { ambiguous_terms: ['payment.terms'] }), display: `${v1}: ${isA ? 'total' : 'due date'} superseded by the correction; other terms current` }];
    if (revised === 'attached') documents.push({ filename: v2, status: 'current', stale_terms: [], display: `${v2}: current` });

    const prohibited: ActionCond[] = [
      { id: 'confirms_old', text: staleText(`Confirms or repeats ${oldValue} as the current ${isA ? 'invoice total' : 'due date'}, or pays / schedules on it`), stale: true },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    if (revised === 'promised') prohibited.push({ id: 'claims_revised_arrived', text: 'Says the revised invoice has already been received' });
    const checkpoint: Checkpoint = {
      id: 'after_late_copy', after: fwd, now: later(fwdAt, 20),
      state: { terms, superseded: [{ party: ar.address, term, value: isA ? d.amount : d.dueDate, display: oldDisplay, evidence: [inv, fwd], superseded_by: fix }], open_loops, closed_loops, conflicts: [], documents, next_actor: 'us' },
      judge_facts: [
        `${d.company} invoice ${d.alias} originally said ${isA ? `${moneyShort(d.amount)}` : `due ${sayDate(d.dueDate, 'weekday_short_date')}`}; AR later corrected it to ${newDisplay}${revised === 'attached' ? ' (with a revised PDF)' : ''}${isA ? '' : ' because the invoice date was mis-keyed'}.`,
        `${shortName(colleague)} has just forwarded the ORIGINAL invoice email (dated before the correction) and is acting on ${oldValue}; they never saw the correction.`,
        isA ? `The corrected total ${newDisplay} is current${colleague === controller ? ` and is covered by the controller's ${moneyShort(d.amount)} sign-off` : ''}.` : `Paying in the ${sayDate(d.dueDate, 'month_day')} run would now be late; the invoice is due ${newDisplay}.`,
        revised === 'promised' ? 'The revised invoice has not arrived yet.' : null,
      ].filter(Boolean).join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_colleague', text: `Replies to ${firstName(colleague)}`, det: { type: 'message_to', party: colleague.address } },
          { id: 'corrects_colleague', text: `Tells ${firstName(colleague)} the current ${isA ? 'total' : 'due date'} is ${newDisplay}, not ${oldValue} (the forwarded invoice is outdated)` },
        ],
        optional: [{ id: 'points_to_revision', text: revised === 'attached' ? 'Points them to (or forwards) the revised invoice' : 'Mentions that AR corrected the invoice by email' }],
        prohibited,
      },
    };
    void requester;

    return financeCase(late_evidence, variant, {
      description: `${isA ? 'Total' : 'Due date'} corrected ${oldDisplay} → ${newDisplay}; ${colleague.label} later forwards the pre-correction invoice and acts on it.`,
      task: d.task, mb, trigger: fwd, checkpoint,
      params: { corrected, colleague: colleague.label, pct, newAmount, newDue, revised, ourAck, withApproval, fwdDay, nBackground, nChatter, amount: d.amount, dueDate: d.dueDate },
    });
  },
};
