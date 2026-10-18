// Archetype: cross-thread fact (P1).
//
// AR sends the invoice and later asks, in the same thread, when it will be paid. The decisive internal
// fact arrives in a brand-new thread (not a reply) linked only by the invoice reference, written in
// whatever form the sender likes ("INV-20417", "INV 20417", "invoice #20417"): usually the controller's
// approval, sometimes purchasing's receipt confirmation (the third leg of the match). The same vendor
// and the same controller are also handling a look-alike invoice (two digits swapped, another PO) with
// a lower approval ceiling than our invoice's total, mailed in the same hours.
//
// Trap: a thread-scoped agent never sees the approval ("still waiting on the controller") or the
// receipt; a keyword/RAG agent pulls the look-alike's ceiling and concludes our invoice is over its
// approval. The oracle puts every fact in one task state: invoice matched, received, approved, nothing
// in conflict; AR's question is ours to answer. The right action tells AR the invoice is approved and
// when it will be paid, without re-asking the controller or purchasing.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleLoop, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, body, money, moneyShort, pdf, reaskText, sayDate, seedOf } from '../../core/util.ts';
import { aliasForms, arSign, discountPhrase, financeBackground, financeCase, financeChatter, financeDayStart, financeDeal, firstName, invoiceLines, invoiceTerms, later, lookalikeFigures, ours, shortName } from './vertical.ts';

export const cross_thread: Archetype = {
  id: 'cross_thread',
  title: 'Approval or receipt arrives in a new thread linked only by the invoice number',
  capabilities: ['cross_thread'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('finance', 'cross_thread', variant));
    const g = variant === 0;
    const d = financeDeal(r, variant);
    const { self, ar, controller, requester } = d.cast;
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => financeDayStart(d, day, hhmm);

    // ---- parameters
    const crossFact: 'approval' | 'receipt' = g ? 'approval' : r.pick(['approval', 'approval', 'receipt'] as const);
    const askedController = g ? true : crossFact === 'receipt' ? true : r.chance(0.6);
    const form = g ? d.alias : r.pick(aliasForms(d.alias).slice(1));
    const lk = lookalikeFigures(d);
    const factLast = g ? true : r.chance(0.6); // the cross-thread fact is the newest message (else AR's question is)
    const nBackground = g ? 2 : r.int(2, 5);
    const nChatter = g ? 0 : r.int(0, 3);
    const file = g ? `Northwind_Invoice_${d.alias}.pdf` : `${d.company.split(' ')[0]}_Invoice_${d.alias}.pdf`;

    // ---- history
    const inv = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: financeDayStart(d, -6, g ? '15:10' : r.pick(['10:20', '13:45', '15:10'])),
      subject: `Invoice ${d.alias} — ${d.po}`,
      body: body('Hi,', g
        ? `Please find attached invoice ${d.alias} for ${d.po}: ${d.qty} ${unit}, total ${money(d.amount)}, terms ${d.terms.text}.`
        : r.pick([
          `Attached is invoice ${d.alias} for ${d.po} (${moneyShort(d.amount)}, ${d.terms.text}).`,
          `Invoice ${d.alias} attached: ${d.qty} ${unit} on ${d.po}, ${moneyShort(d.amount)}, due ${sayDate(d.dueDate, 'month_day')}.`,
          `Please see our invoice ${d.alias} (${d.po}) attached. Amount due ${money(d.amount)}.`,
        ]), arSign(d, g, r)),
      attachments: [pdf(file, invoiceLines(d))],
    });
    // the look-alike invoice from the same AR, a day later
    mb.add({
      background: true, direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: financeDayStart(d, -5, r.pick(['09:40', '11:15'])),
      subject: `Invoice ${lk.look} — ${lk.otherPo}`,
      body: body('Hi,', `Please find invoice ${lk.look} for ${lk.otherPo}: ${moneyShort(lk.amount)}, Net 45, due ${sayDate(lk.due, 'long')}.`, firstName(ar)),
      note: 'look-alike invoice with the same vendor (digits swapped, other PO): must not bleed in',
    });
    financeBackground(r, d, mb, financeDayStart(d, -4, '10:00'), nBackground, g ? 0 : r.int(0, 5), true);

    let appAsk: string | null = null;
    if (askedController) {
      appAsk = mb.add({
        direction: 'outbound', from: self.address, fromName: self.name, to: [controller.address], at: t(0, '09:10'),
        subject: g ? `Approval request — ${d.company} ${d.alias}` : r.pick([`Approval request — ${d.alias}`, `Please approve: ${d.company} ${d.alias}`, `${d.alias} approval`]),
        body: ours(firstName(controller), `Could you approve payment of ${d.company} invoice ${d.alias} (${moneyShort(d.amount)}, ${d.po}) up to ${moneyShort(d.approvalMax)}?`),
      });
    }
    const recAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [requester.address], at: t(0, '09:15'), subject: `Receipt check — ${d.po}`, body: ours(firstName(requester), `Can you confirm how many ${unit} were received on ${d.po}? ${d.company} billed ${d.qty}.`) });
    financeChatter(r, d, mb, t(0, '09:30'), nChatter, g ? 0 : r.int(0, 9)); // ends by 10:30

    const askText = g
      ? `Could you let me know when ${d.alias} is scheduled for payment? Our month-end is coming up.`
      : r.pick([
        `Just following up on ${d.alias}: do you have a payment date yet?`,
        `Can you tell me when we should expect payment on ${d.alias}?`,
        `Checking in on ${d.alias}. Has it been approved for payment?`,
      ]);
    const factAt = factLast ? t(1, g ? '09:45' : r.pick(['09:45', '10:30', '11:50'])) : t(0, r.pick(['14:20', '15:40']));
    const vendorAskAt = factLast ? t(0, g ? '16:05' : r.pick(['13:10', '16:05'])) : t(1, r.pick(['09:20', '10:40']));
    const vendorAsk = mb.add({ direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: vendorAskAt, subject: mb.reSubject(inv), replyTo: inv, body: body('Hi,', askText, arSign(d, g, r)) });

    // the threaded internal fact
    const otherAt = t(0, r.pick(['11:00', '11:40', '12:20']));
    let approval: string;
    let rec: string;
    const recText = r.pick([`All ${d.qty} received on ${d.po}, no issues.`, `Confirmed: ${d.qty} of ${d.qty} ${unit} received and inspected.`, `Full quantity (${d.qty}) came in against ${d.po}.`]);
    const approvalText = g
      ? `${d.alias}: approved for payment up to ${moneyShort(d.approvalMax)}.`
      : r.pick([
        `${form} is approved. Max ${moneyShort(d.approvalMax)}.`,
        `Approval for ${form} (${d.company}): up to ${moneyShort(d.approvalMax)}. Pay when ready.`,
        `Signed off on ${form}, ceiling ${moneyShort(d.approvalMax)}.`,
      ]);
    if (crossFact === 'approval') {
      rec = mb.add({ direction: 'inbound', from: requester.address, fromName: shortName(requester), to: [self.address], at: otherAt, subject: mb.reSubject(recAsk), replyTo: recAsk, body: body(recText, firstName(requester)) });
      approval = mb.add({
        direction: 'inbound', from: controller.address, fromName: shortName(controller), to: [self.address], at: factAt,
        subject: g ? `${d.alias} approval` : r.pick([`${form} approval`, `Approved: ${form}`, `Re ${form}`]), replyTo: null,
        body: body(approvalText, `${firstName(controller)}\nController, Acme Corp`),
        note: 'new thread, linked only by the invoice reference',
      });
    } else {
      approval = mb.add({ direction: 'inbound', from: controller.address, fromName: shortName(controller), to: [self.address], at: otherAt, subject: mb.reSubject(appAsk!), replyTo: appAsk, body: body(approvalText, firstName(controller)) });
      rec = mb.add({
        direction: 'inbound', from: requester.address, fromName: shortName(requester), to: [self.address], at: factAt,
        subject: r.pick([`${form} — goods received`, `Receiving: ${form}`, `${d.company} delivery (${form})`]), replyTo: null,
        body: body(r.pick([`For ${form}: we received all ${d.qty} ${unit}. Good to pay from our side.`, `Re ${d.company} ${form}: full ${d.qty} received and inspected.`, `Receiving confirms ${d.qty} ${unit} for ${form}, no damage.`]), firstName(requester)),
        note: 'new thread, linked only by the invoice reference',
      });
    }
    // the look-alike approval, minutes after ours
    mb.add({
      background: true, direction: 'inbound', from: controller.address, fromName: shortName(controller), to: [self.address], at: later(mb.get(approval).at, r.int(4, 25)),
      subject: `Approved: ${lk.look}`,
      body: body(`${lk.look} (${lk.otherPo}) is approved for payment up to ${moneyShort(lk.cap)}.`, firstName(controller)),
      note: 'look-alike approval: lower ceiling, different invoice',
    });
    const trigger = factLast ? (crossFact === 'approval' ? approval : rec) : vendorAsk;
    const trigAt = mb.get(trigger).at;

    // ---- oracle
    const terms: OracleTerm[] = invoiceTerms(d, [inv], { critical: ['invoice.amount', 'invoice.due_date'] });
    terms.push(
      { party: controller.address, term: 'approval.max_amount', status: 'current', value: d.approvalMax, evidence: [approval], critical: true, display: moneyShort(d.approvalMax) },
      { party: requester.address, term: 'receipt.quantity', status: 'current', value: d.qty, evidence: [rec], critical: true, display: `${d.qty} ${unit} received` },
    );
    const closed_loops: OracleLoop[] = [
      { kind: 'ask', debtor: requester.address, subject: 'receipt.quantity', alt_subjects: ['receipt.confirmation'], display: 'Receipt check (answered)', evidence: [recAsk, rec] },
    ];
    if (appAsk) closed_loops.push({ kind: 'ask', debtor: controller.address, subject: 'approval.max_amount', alt_subjects: ['approval.payment'], display: 'Payment approval (given)', evidence: [appAsk, approval] });
    const open_loops: OracleLoop[] = [{ kind: 'ask', debtor: self.address, subject: 'decision.payment', display: 'AR asks when the invoice will be paid', evidence: [vendorAsk], critical: true }];

    const payBy = d.discountDeadline && d.discountDeadline > trigAt.slice(0, 10) ? `by ${sayDate(d.discountDeadline, 'weekday_short_date')} to take the ${d.terms.pct}% discount (and in any case by the ${sayDate(d.dueDate, 'weekday_short_date')} due date)` : `on or before the ${sayDate(d.dueDate, 'weekday_short_date')} due date`;
    const prohibited: ActionCond[] = [
      { id: 'reask_approval', text: reaskText('Asks the controller again to approve the invoice (already approved)') },
      { id: 'reask_receipt', text: reaskText('Asks purchasing again to confirm receipt (already confirmed)') },
      { id: 'claims_unapproved', text: 'Tells anyone the invoice is not yet approved or that Acme is still waiting on internal sign-off' },
      { id: 'lookalike_bleed', text: `Uses figures from the other invoice ${lk.look} (${moneyShort(lk.amount)}, a ${moneyShort(lk.cap)} ceiling) for ${d.alias}` },
      { id: 'over_limit_claim', text: `Claims the ${moneyShort(d.amount)} invoice exceeds its approval` },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    const checkpoint: Checkpoint = {
      id: 'after_both_facts', after: trigger, now: later(trigAt, 20),
      state: {
        terms, superseded: [], open_loops, closed_loops, conflicts: [],
        documents: [{ filename: file, status: 'current', stale_terms: [], display: `${file}: current` }],
        next_actor: 'us',
      },
      judge_facts: [
        `${d.company} invoice ${d.alias}: ${moneyShort(d.amount)} for ${d.qty} ${unit} on ${d.po}, terms ${d.terms.text}, due ${sayDate(d.dueDate, 'weekday_short_date')} (${discountPhrase(d)}), remit to ${d.remitTo}.`,
        `Purchasing confirmed all ${d.qty} received and the controller approved payment up to ${moneyShort(d.approvalMax)}; the ${crossFact === 'approval' ? 'approval' : 'receipt confirmation'} came in a separate new thread that refers to the invoice as "${form}". The invoice is fully matched and approved.`,
        `AR asked when it will be paid. ${lk.look} is a different invoice (${moneyShort(lk.amount)}, ${moneyShort(lk.cap)} ceiling) and is irrelevant here.`,
      ].join(' '),
      action: {
        expect: 'send',
        required: [
          { id: 'to_vendor', text: 'Sends a message to the vendor AR contact', det: { type: 'message_to', party: ar.address } },
          { id: 'confirm_payment', text: `Tells AR that ${d.alias} is approved and will be paid ${payBy}` },
        ],
        optional: [{ id: 'tell_controller', text: 'Lets the controller know the payment is being scheduled' }],
        prohibited,
      },
    };

    return financeCase(cross_thread, variant, {
      description: `${d.alias}: ${crossFact} arrives in a fresh thread ("${form}"); AR asks for a payment date; look-alike ${lk.look} in the same inbox.`,
      task: d.task, mb, trigger, checkpoint,
      params: { crossFact, askedController, form, look: lk.look, lookAmount: lk.amount, lookCap: lk.cap, factLast, nBackground, nChatter, amount: d.amount, approvalMax: d.approvalMax, terms: d.terms.text, dueDate: d.dueDate },
    });
  },
};
