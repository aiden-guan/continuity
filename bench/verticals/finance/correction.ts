// Archetype: correction / supersession (P0).
//
// The vendor's AR emails an invoice PDF (amount, terms, due date, remit-to). Purchasing confirms the
// goods were received and the controller approves payment in a separate thread. Then AR corrects the
// invoice total and promises a revised invoice:
//   up    the invoice "left off" freight, or billed an old unit price: the corrected total now exceeds
//         the PO amount and the controller's approval (a requirement violation);
//   down  a volume rebate / promotional discount was not applied: the total drops (still within limits).
// Everything else on the invoice stands.
//
// Trap: a naive reader pays the approved PDF amount (the approval and the PDF agree with each other,
// and both are older than the correction), or treats the correction email as the invoice itself. The
// oracle: the original total is superseded, the corrected total is current, the PDF is stale on the
// amount only (terms, due date, remit-to still current), the revised invoice is an open commitment owed
// by the vendor, and for "up" the corrected total violates the PO/approval limit. The right action for
// "up" raises the overage (with the vendor and/or the controller) without paying either figure; for
// "down" it never pays the old total (waiting for the revised invoice, or paying the corrected total now with a
// remittance note citing AR's correction, are both fine).
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleConflict, OracleLoop, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, body, money, moneyShort, pdf, reaskText, sayDate, seedOf, staleText } from '../../core/util.ts';
import { SIGNATURE, arSign, discountPhrase, financeBackground, financeCase, financeChatter, financeDayStart, financeDeal, firstName, invoiceLines, invoiceTerms, later, ours, round2, shortName } from './vertical.ts';

type Kind = 'up' | 'down';
type Reason = 'freight' | 'price' | 'rebate' | 'promo';

export const correction: Archetype = {
  id: 'correction',
  title: 'Vendor corrects the invoice total after it was approved',
  capabilities: ['supersession', 'document_validity', 'cross_thread', 'open_loops', 'cold_handoff'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('finance', 'correction', variant));
    const g = variant === 0;
    const d = financeDeal(r, variant);
    const { self, ar, controller, requester } = d.cast;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => financeDayStart(d, day, hhmm);

    // ---- parameters
    const kind: Kind = g ? 'up' : r.pick(['up', 'down'] as const);
    let reason: Reason = g ? 'freight' : kind === 'up' ? r.pick(['freight', 'price'] as const) : r.pick(['rebate', 'promo'] as const);
    let newAmount = d.amount;
    let freight = 0;
    let newUnit = d.unitPrice;
    const pct = g ? 2.5 : r.pick([2, 2.5, 3, 5]);
    if (reason === 'price') {
      newUnit = d.unitPrice + r.pick([5, 10, 15, 20]);
      newAmount = round2(d.qty * newUnit);
      if (newAmount <= d.approvalMax) reason = 'freight';
    }
    if (reason === 'freight') {
      freight = g ? 1350 : r.pick([385, 640, 975, 1350, 1820]);
      if (d.amount + freight <= d.approvalMax) freight += d.approvalMax - d.amount;
      newAmount = round2(d.amount + freight);
      newUnit = d.unitPrice;
    }
    if (reason === 'rebate' || reason === 'promo') newAmount = round2(d.amount * (1 - pct / 100));
    const withReceipt = g ? true : r.chance(0.6);
    const weAcked = g ? false : r.chance(0.5);
    const restates = g ? true : r.chance(0.6);
    const revisedDue = g ? 'by tomorrow' : r.pick(['by tomorrow', 'later today', 'by end of day tomorrow', 'shortly', '']);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 3);
    const file = g ? `Northwind_Invoice_${d.alias}.pdf` : r.pick([`${d.company.split(' ')[0]}_Invoice_${d.alias}.pdf`, `${d.alias}.pdf`, `Invoice-${d.alias.replace('INV-', '')}.pdf`]);

    // ---- history: the invoice
    const invText = g
      ? `Please find attached invoice ${d.alias} for ${d.po} (${d.qty} ${d.item.unit}), total ${money(d.amount)}, terms ${d.terms.text}. Payment is due ${sayDate(d.dueDate, 'long')}.`
      : r.pick([
        `Attached is our invoice ${d.alias} against your ${d.po}: ${moneyShort(d.amount)}, ${d.terms.text}, due ${sayDate(d.dueDate, 'month_day')}.`,
        `Please see invoice ${d.alias} attached for the ${d.qty} ${d.item.unit} shipped on ${d.po}. Amount due ${money(d.amount)}; terms ${d.terms.text}.`,
        `Invoice ${d.alias} (${d.po}) is attached. Total ${moneyShort(d.amount)}, payable by ${sayDate(d.dueDate, 'weekday_long')}. Remittance details are on the invoice.`,
      ]);
    const inv = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: financeDayStart(d, -6, g ? '15:10' : r.pick(['10:20', '13:45', '15:10'])),
      subject: `Invoice ${d.alias} — ${d.po}`,
      body: body('Hi,', invText, 'Let me know if you have any questions.', arSign(d, g, r)),
      attachments: [pdf(file, invoiceLines(d))],
    });
    if (weAcked) {
      mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ar.address], at: t(0, '08:40'), subject: mb.reSubject(inv), replyTo: inv, body: ours(firstName(ar), r.pick(['Received, thank you. It is in our approval queue.', 'Thanks, got it. Routing for approval now.', 'Thanks — logged and with our controller for approval.'])), note: 'state-neutral acknowledgement' });
    }
    let recAsk: string | null = null;
    let rec: string | null = null;
    if (withReceipt) {
      recAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [requester.address], at: t(0, '09:00'), subject: `Receipt check — ${d.po}`, body: ours(firstName(requester), `Before I pay ${d.company} invoice ${d.alias}: can you confirm how many ${d.item.unit} were received on ${d.po}? They billed ${d.qty}.`) });
      rec = mb.add({
        direction: 'inbound', from: requester.address, fromName: shortName(requester), to: [self.address], at: t(0, g ? '10:35' : r.pick(['09:50', '10:35', '11:20'])),
        subject: mb.reSubject(recAsk), replyTo: recAsk,
        body: body(g ? `All ${d.qty} received and inspected on ${d.po}, no issues.` : r.pick([`Confirmed: ${d.qty} of ${d.qty} received, all good.`, `Yes, the full ${d.qty} ${d.item.unit} came in and passed inspection.`, `Receiving shows ${d.qty} received against ${d.po}. No damage reported.`]), firstName(requester)),
      });
    }
    const appAsk = mb.add({
      direction: 'outbound', from: self.address, fromName: self.name, to: [controller.address], at: t(0, '11:10'),
      subject: `Approval request — ${d.company} ${d.alias}`,
      body: ours(firstName(controller), `${d.company} invoice ${d.alias} for ${moneyShort(d.amount)} on ${d.po}${withReceipt ? ' matches the PO and receiving' : ' matches the PO'}. Terms ${d.terms.text}, due ${sayDate(d.dueDate, 'weekday_short_date')}. Could you approve payment up to ${moneyShort(d.approvalMax)}?`),
    });
    const approval = mb.add({
      direction: 'inbound', from: controller.address, fromName: shortName(controller), to: [self.address], at: t(0, g ? '14:20' : r.pick(['13:30', '14:20', '16:05'])),
      subject: mb.reSubject(appAsk), replyTo: appAsk,
      body: g
        ? body(`Approved. You can pay ${d.alias} up to ${moneyShort(d.approvalMax)}.`, `${firstName(controller)}\nController, Acme Corp`)
        : body(r.pick([
          `Approved for payment, up to ${moneyShort(d.approvalMax)}.`,
          `OK to pay ${d.alias}: approved up to ${moneyShort(d.approvalMax)}.`,
          `${d.alias} is approved. Ceiling ${moneyShort(d.approvalMax)}.`,
        ]), firstName(controller)),
    });
    financeBackground(r, d, mb, financeDayStart(d, -5, '09:00'), nBackground, g ? 0 : r.int(0, 7));
    financeChatter(r, d, mb, t(0, '15:00'), nChatter, g ? 0 : r.int(0, 9));

    // ---- the correction
    const fixAt = t(1, g ? '10:12' : r.pick(['09:40', '10:12', '11:30', '14:50']));
    const fixText: Record<Reason, string[]> = {
      freight: [
        `Correction to invoice ${d.alias}: we left the freight charge of ${money(freight)} off. The correct total is ${money(newAmount)}.`,
        `I need to correct ${d.alias}: freight (${moneyShort(freight)}) was not included, so the amount due is ${moneyShort(newAmount)}, not ${moneyShort(d.amount)}.`,
        `Our billing system dropped the freight line on ${d.alias}. With freight of ${moneyShort(freight)} the invoice total is ${moneyShort(newAmount)}.`,
        `Revision to ${d.alias}: please add ${moneyShort(freight)} freight; the corrected total is ${money(newAmount)}.`,
      ],
      price: [
        `Correction to invoice ${d.alias}: it was billed at the old price. The unit price should be ${money(newUnit)}, so the total is ${money(newAmount)}.`,
        `I'm afraid ${d.alias} went out at last quarter's price. At the current ${moneyShort(newUnit)}/unit the correct total is ${moneyShort(newAmount)}.`,
        `Please note a correction on ${d.alias}: unit price ${moneyShort(newUnit)} (not ${moneyShort(d.unitPrice)}), total ${moneyShort(newAmount)}.`,
      ],
      rebate: [
        `Correction to invoice ${d.alias}: we forgot to apply your ${pct}% volume rebate. The correct total is ${money(newAmount)}.`,
        `Apologies, ${d.alias} should have included your ${pct}% rebate. The amount due is ${moneyShort(newAmount)}, not ${moneyShort(d.amount)}.`,
        `I need to correct ${d.alias}: with the ${pct}% volume rebate applied the invoice total comes to ${moneyShort(newAmount)}.`,
      ],
      promo: [
        `Correction to ${d.alias}: the ${pct}% promotional discount from your account agreement was not applied. Correct total: ${money(newAmount)}.`,
        `Our mistake on ${d.alias}: it should reflect the ${pct}% promo discount, bringing the total to ${moneyShort(newAmount)}.`,
        `Revision to invoice ${d.alias}: total is ${moneyShort(newAmount)} after the ${pct}% promotional discount we missed.`,
      ],
    };
    const promise = `I'll send a revised invoice${revisedDue ? ` ${revisedDue}` : ''}.`;
    const restate = restates ? r.pick([`Terms and due date are unchanged.`, `Everything else on the invoice stands.`, `Due date and remittance details stay the same.`]) : null;
    const fix = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: fixAt,
      subject: mb.reSubject(inv), replyTo: inv,
      body: body(g ? 'Hi again,' : r.pick(['Hi,', 'Hi again,', 'Hello,']), g ? fixText.freight[0] : r.pick(fixText[reason]), `${g ? 'Terms and due date are unchanged. ' : restate ? `${restate} ` : ''}${promise}`, g ? 'Sorry for the confusion,\nDana' : firstName(ar)),
    });

    // ---- oracle
    const ev = restates || g ? [inv, fix] : [inv];
    const terms: OracleTerm[] = invoiceTerms(d, ev, { skip: ['invoice.amount', 'invoice.number'] });
    terms.unshift(
      { party: ar.address, term: 'invoice.amount', status: 'current', value: newAmount, evidence: [fix], critical: true, display: moneyShort(newAmount) },
      { party: ar.address, term: 'invoice.number', status: 'current', value: d.alias, evidence: [inv, fix], display: d.alias },
    );
    terms.push({ party: controller.address, term: 'approval.max_amount', status: 'current', value: d.approvalMax, evidence: [approval], critical: true, display: moneyShort(d.approvalMax) });
    if (rec) terms.push({ party: requester.address, term: 'receipt.quantity', status: 'current', value: d.qty, evidence: [rec], display: `${d.qty} ${d.item.unit} received` });

    const closed_loops: OracleLoop[] = [
      { kind: 'ask', debtor: controller.address, subject: 'approval.max_amount', alt_subjects: ['approval.payment'], display: 'Payment approval (given)', evidence: [appAsk, approval] },
    ];
    if (recAsk && rec) closed_loops.push({ kind: 'ask', debtor: requester.address, subject: 'receipt.quantity', alt_subjects: ['receipt.confirmation'], display: 'Receipt confirmation (given)', evidence: [recAsk, rec] });
    const conflicts: OracleConflict[] = kind === 'up'
      ? [{ kind: 'requirement_violation', term: 'invoice.amount', party: ar.address, display: `Corrected total ${moneyShort(newAmount)} exceeds the PO amount (${moneyShort(d.amount)}) and the ${moneyShort(d.approvalMax)} approval`, critical: true }]
      : [];
    const why = reason === 'freight' ? `freight of ${moneyShort(freight)} that is not on the PO` : reason === 'price' ? `a unit price of ${moneyShort(newUnit)} instead of the PO's ${moneyShort(d.unitPrice)}` : `a ${pct}% ${reason === 'rebate' ? 'volume rebate' : 'promotional discount'}`;

    const prohibited: ActionCond[] = [
      kind === 'up'
        // holding the vendor to the PO amount while disputing the increase is legitimate pushback, not reliance on the dead total
        ? { id: 'pays_old', text: staleText(`Pays or schedules the original ${moneyShort(d.amount)}, or treats it as the invoice total as if no correction had been made (disputing the increase and holding the vendor to the PO ${reason === 'freight' ? 'amount' : 'price'} is not this)`), stale: true }
        : { id: 'pays_old', text: staleText(`Pays, schedules or confirms the original ${moneyShort(d.amount)} as the amount due`), stale: true },
      { id: 'reask_approval', text: reaskText(`Asks the controller to approve the original ${moneyShort(d.amount)} again (already approved)`) },
      { id: 'claims_revised_arrived', text: 'Says or implies the revised invoice has already been received' },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    if (rec) prohibited.push({ id: 'reask_receipt', text: reaskText('Asks purchasing again how many units were received (already confirmed)') });
    if (kind === 'up') {
      prohibited.unshift(
        // judged, not binding_to: "we will pay the PO amount once you reissue at it" is legitimate push-back but trips the regex
        { id: 'binding_vendor', text: 'Tells the vendor that Acme will pay now (any amount) or that payment is scheduled, while the overage is unresolved (offering to pay the PO amount once the vendor reissues at it is not this)' },
        { id: 'pays_new_unapproved', text: `Pays, schedules or approves the corrected ${moneyShort(newAmount)} without a new approval and PO cover` },
      );
    }
    // "down": paying the corrected (lower) total now, short-paying the original with a remittance note that cites
    // AR's written correction, is a legitimate AP move (AR has authority over the amount, and it is within the PO,
    // receipt and approval), so it is not prohibited; waiting for the revised invoice is equally fine.

    const checkpoint: Checkpoint = {
      id: 'after_correction', after: fix, now: later(fixAt, 20),
      state: {
        terms,
        superseded: [{ party: ar.address, term: 'invoice.amount', value: d.amount, display: `${moneyShort(d.amount)} (original invoice total)`, evidence: [inv], superseded_by: fix }],
        open_loops: [{ kind: 'commitment', debtor: ar.address, subject: 'document.invoice', display: 'Vendor owes a revised invoice', evidence: [fix], critical: true }],
        closed_loops, conflicts,
        documents: [{ filename: file, status: 'partially_stale', stale_terms: ['invoice.amount'], display: `${file}: total superseded by the correction; terms, due date and remit-to still current` }],
        next_actor: kind === 'up' ? 'us' : 'them',
      },
      judge_facts: [
        `${d.company} invoice ${d.alias} (${d.po}) originally totalled ${moneyShort(d.amount)}; AR has corrected the total to ${moneyShort(newAmount)} (${why}) and promised a revised invoice that has NOT arrived yet.`,
        `The ${moneyShort(d.amount)} figure is dead. Terms ${d.terms.text}, due ${sayDate(d.dueDate, 'weekday_short_date')}, ${discountPhrase(d)}, remit-to ${d.remitTo} are unchanged.`,
        `The controller already approved payment up to ${moneyShort(d.approvalMax)} in a separate thread${rec ? `, and purchasing confirmed all ${d.qty} units were received` : ''}.`,
        kind === 'up' ? `The corrected ${moneyShort(newAmount)} exceeds both the PO amount and the approval, so it cannot be paid as is; nothing should be paid until the overage is resolved (disputing it and holding the vendor to the PO is legitimate).` : `The corrected ${moneyShort(newAmount)} is within the PO and the approval; Acme may pay it once the revised invoice arrives, or now with a remittance note citing AR's correction.`,
      ].join(' '),
      action: kind === 'up'
        ? {
          expect: 'send',
          required: [
            { id: 'to_vendor_or_controller', text: 'Sends a message to the vendor AR contact or to the controller', det: { type: 'message_to_any', parties: [ar.address, controller.address] } },
            { id: 'raise_overage', text: `Raises that the corrected ${moneyShort(newAmount)} is above the PO amount / the ${moneyShort(d.approvalMax)} approval: questions the ${reason === 'freight' ? 'freight charge' : 'price change'} with the vendor and/or asks the controller whether to approve the higher amount, without paying` },
          ],
          optional: [
            { id: 'to_vendor', text: 'Sends a message to the vendor', det: { type: 'message_to', party: ar.address } },
            { id: 'to_controller', text: 'Sends a message to the controller', det: { type: 'message_to', party: controller.address } },
            { id: 'mention_revised', text: 'Mentions that the revised invoice is still expected' },
          ],
          prohibited,
        }
        : {
          expect: 'any',
          required: [],
          optional: [
            { id: 'ack_vendor', text: `Acknowledges the corrected ${moneyShort(newAmount)} to the vendor`, det: { type: 'message_to', party: ar.address } },
          ],
          prohibited,
        },
    };
    void SIGNATURE;

    return financeCase(correction, variant, {
      description: `${d.alias} total corrected ${moneyShort(d.amount)} → ${moneyShort(newAmount)} (${reason}); approval ${moneyShort(d.approvalMax)} in another thread; revised invoice owed.`,
      task: d.task, mb, trigger: fix, checkpoint,
      params: { kind, reason, newAmount, freight, newUnit, pct, withReceipt, weAcked, restates, revisedDue, nBackground, nChatter, file, amount: d.amount, approvalMax: d.approvalMax, terms: d.terms.text, dueDate: d.dueDate },
    });
  },
};
