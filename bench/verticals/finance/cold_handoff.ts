// Archetype: cold handoff (P0). The headline product test.
//
// A long, realistic AP history (10–20 task messages over ten days plus background mail): the vendor's
// invoice PDF, our acknowledgement, a receipt check with purchasing (answered: all units received), an
// approval request and approval in a separate controller thread, a side question to AR that gets
// answered (does the discount apply to the full total / is the remit-to unchanged / W-9 / statement),
// on-task chatter, and then AR corrects the invoice total and promises a revised invoice. A fresh agent
// wakes on the newest message: the controller asking whether the invoice can go in this week's run,
// an innocuous AR note, or the correction itself.
//
// Trap: everything at once. A naive reader of the latest message or of a running summary pays the old
// total (the approval and the PDF agree on it), re-asks purchasing or the controller (both settled),
// says the revised invoice is in (it is not), or drops the still-valid terms/discount/remit-to. The
// oracle has the corrected total current and the old one superseded, the approval and the receipt
// from their own threads, the revised invoice open, the side question closed, the PDF stale on the
// total only, and (when the correction goes up) a requirement violation. The action must give the
// controller an accurate status when asked and never pay the dead figure (when the correction goes down,
// paying the corrected total before the revised invoice, with a remittance note, is acceptable).
import type { ActionCond, Archetype, BenchAttachment, BenchCase, Checkpoint, OracleDocument, OracleLoop, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, body, money, moneyShort, pdf, reaskText, sayDate, seedOf, staleText } from '../../core/util.ts';
import { arSign, discountPhrase, financeBackground, financeCase, financeChatter, financeDayStart, financeDeal, firstName, invoiceLines, invoiceTerms, later, ours, round2, shortName, statementLines, w9Lines } from './vertical.ts';

type SideQ = 'discount_base' | 'remit_confirm' | 'w9' | 'statement';
type Trigger = 'controller_ping' | 'vendor_note' | 'correction';

export const cold_handoff: Archetype = {
  id: 'cold_handoff',
  title: 'Cold handoff of a long AP history',
  capabilities: ['cold_handoff', 'supersession', 'document_validity', 'cross_thread', 'open_loops'],
  priority: 'P0',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('finance', 'cold_handoff', variant));
    const g = variant === 0;
    const d = financeDeal(r, variant);
    const { self, ar, controller, requester } = d.cast;
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => financeDayStart(d, day, hhmm);
    const hasDiscount = d.terms.pct !== null;

    // ---- parameters
    const kind: 'up' | 'down' = g ? 'down' : r.pick(['up', 'down'] as const);
    const pct = g ? 2.5 : r.pick([2, 2.5, 3, 4]);
    let freight = r.pick([420, 650, 980, 1340]);
    if (d.amount + freight <= d.approvalMax) freight += d.approvalMax - d.amount;
    const newAmount = kind === 'up' ? round2(d.amount + freight) : round2(d.amount * (1 - pct / 100));
    const trigger: Trigger = g ? 'controller_ping' : r.pick(['controller_ping', 'controller_ping', 'vendor_note', 'correction'] as const);
    const sideQ: SideQ = g ? 'discount_base' : r.pick((hasDiscount ? ['discount_base', 'remit_confirm', 'w9', 'statement'] : ['remit_confirm', 'w9', 'statement']) as SideQ[]);
    const withAck = g ? true : r.chance(0.6);
    const controllerThanks = g ? true : r.chance(0.5);
    const pingInThread = g ? false : r.chance(0.4);
    const nBackground = g ? 4 : r.int(3, 7);
    const file = g ? `Northwind_Invoice_${d.alias}.pdf` : r.pick([`${d.alias}.pdf`, `${d.company.split(' ')[0]}_Invoice_${d.alias}.pdf`]);
    const sideFile = sideQ === 'w9' ? `${d.company.split(' ')[0]}_W9.pdf` : sideQ === 'statement' ? `Statement_${d.company.split(' ')[0]}.pdf` : null;
    const fixedTask = 1 + (withAck ? 1 : 0) + 2 + 2 + (controllerThanks ? 1 : 0) + 2 + 1 + (trigger === 'correction' ? 0 : 1);
    const nChatter = Math.max(g ? 2 : r.int(2, 4), 10 - fixedTask);

    // ---- day -6: the invoice
    const inv = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: financeDayStart(d, -6, g ? '15:10' : r.pick(['10:20', '13:45', '15:10'])),
      subject: `Invoice ${d.alias} — ${d.po}`,
      body: body('Hi,', g
        ? `Please find attached invoice ${d.alias} for ${d.po} (${d.qty} ${unit}), total ${money(d.amount)}, terms ${d.terms.text}.`
        : r.pick([
          `Attached is invoice ${d.alias} against ${d.po}: ${moneyShort(d.amount)}, ${d.terms.text}, due ${sayDate(d.dueDate, 'month_day')}.`,
          `Invoice ${d.alias} (${d.po}) attached. Total ${moneyShort(d.amount)}; remittance details on the PDF.`,
          `Please see invoice ${d.alias} for the ${d.qty} ${unit} shipped on ${d.po}. Amount due ${money(d.amount)}.`,
        ]), arSign(d, g, r)),
      attachments: [pdf(file, invoiceLines(d))],
    });
    financeBackground(r, d, mb, financeDayStart(d, -5, '09:00'), nBackground, g ? 0 : r.int(0, 7));
    let ack: string | null = null;
    if (withAck) ack = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ar.address], at: financeDayStart(d, -5, '09:30'), subject: mb.reSubject(inv), replyTo: inv, body: ours(firstName(ar), g ? 'Received, thanks. It is in our approval queue.' : r.pick(['Thanks, got it. Routing for approval.', 'Received, thank you.', 'Thanks — logged and in the approval queue.'])), note: 'state-neutral acknowledgement' });

    // ---- day 0: receipt check, approval
    const recAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [requester.address], at: t(0, '09:00'), subject: `Receipt check — ${d.po}`, body: ours(firstName(requester), `Can you confirm how many ${unit} were received on ${d.po}? ${d.company} billed ${d.qty} on ${d.alias}.`) });
    const rec = mb.add({ direction: 'inbound', from: requester.address, fromName: shortName(requester), to: [self.address], at: t(0, '10:35'), subject: mb.reSubject(recAsk), replyTo: recAsk, body: body(g ? `All ${d.qty} received and inspected, no issues.` : r.pick([`Confirmed: ${d.qty} of ${d.qty} received.`, `Full ${d.qty} came in and passed inspection.`, `Receiving shows ${d.qty} against ${d.po}, all good.`]), firstName(requester)) });
    const appAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [controller.address], at: t(0, '11:15'), subject: `Approval request — ${d.company} ${d.alias}`, body: ours(firstName(controller), `${d.alias} from ${d.company}: ${moneyShort(d.amount)} on ${d.po}, matches PO and receiving (${d.qty} ${unit}). Terms ${d.terms.text}${hasDiscount ? `; the ${d.terms.pct}% discount runs to ${sayDate(d.discountDeadline!, 'weekday_short_date')}` : ''}. Could you approve payment up to ${moneyShort(d.approvalMax)}?`) });
    const approval = mb.add({
      direction: 'inbound', from: controller.address, fromName: shortName(controller), to: [self.address], at: t(0, '14:30'), subject: mb.reSubject(appAsk), replyTo: appAsk,
      body: g ? body(`Approved — up to ${moneyShort(d.approvalMax)} for ${d.alias}.`, `${firstName(controller)}\nController, Acme Corp`) : body(r.pick([`Approved for payment, up to ${moneyShort(d.approvalMax)}.`, `OK to pay ${d.alias}, ceiling ${moneyShort(d.approvalMax)}.`, `${d.alias} approved (max ${moneyShort(d.approvalMax)}).`]), firstName(controller)),
    });
    if (controllerThanks) mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [controller.address], at: t(0, '14:50'), subject: mb.reSubject(appAsk), replyTo: approval, body: ours(firstName(controller), 'Thanks, much appreciated.'), note: 'state-neutral' });

    // ---- day 0/1: side question to AR
    const sideAsk: Record<SideQ, string> = {
      discount_base: `Quick one on ${d.alias}: does the ${d.terms.pct}% early-payment discount apply to the full invoice total?`,
      remit_confirm: `Before we schedule ${d.alias}: can you confirm the remit-to on the invoice (${d.remitTo}) is unchanged from what we have on file?`,
      w9: 'Could you send a current W-9 for our vendor file? Ours is from 2023.',
      statement: 'Could you send a current statement of account for Acme?',
    };
    const side = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ar.address], at: t(0, '15:20'), subject: mb.reSubject(inv), replyTo: ack ?? inv, body: ours(firstName(ar), sideAsk[sideQ]) });
    const sideAnswer: Record<SideQ, string[]> = {
      discount_base: [`Yes, the ${d.terms.pct}% applies to the full invoice total if paid by ${sayDate(d.discountDeadline ?? d.dueDate, 'weekday_long')}.`, `It does: ${d.terms.pct}% of the whole invoice, as long as payment reaches us by ${sayDate(d.discountDeadline ?? d.dueDate, 'month_day')}.`, `Correct, the discount is on the full total.`],
      remit_confirm: [`Confirmed, ${d.remitTo} is unchanged.`, `Yes, no change: please keep paying to ${d.remitTo}.`, `That's right, our bank details have not changed.`],
      w9: ['Current W-9 attached.', 'Please find our updated W-9 attached.', 'Attached, signed this month.'],
      statement: ['Statement of account attached.', 'Here is your current statement.', 'Attached is the statement you asked for.'],
    };
    const sideAt = t(1, '09:05');
    const sideAttach: BenchAttachment[] = sideFile ? [pdf(sideFile, sideQ === 'w9' ? w9Lines(d, sideAt.slice(0, 10)) : statementLines(d, sideAt.slice(0, 10), [{ ref: d.alias, amount: d.amount }]))] : [];
    const sideA = mb.add({ direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: sideAt, subject: mb.reSubject(inv), replyTo: side, body: body('Hi,', g ? sideAnswer[sideQ][0] : r.pick(sideAnswer[sideQ]), firstName(ar)), attachments: sideAttach.length ? sideAttach : undefined });

    // ---- day 1/2: chatter, then the correction
    financeChatter(r, d, mb, t(1, '09:30'), nChatter, g ? 0 : r.int(0, 9));
    const fixAt = t(2, '13:40');
    const fixText = kind === 'up'
      ? (g ? '' : r.pick([
        `Correction to ${d.alias}: freight of ${money(freight)} was left off. The correct total is ${money(newAmount)}.`,
        `I need to correct ${d.alias}: with the ${moneyShort(freight)} freight charge it comes to ${moneyShort(newAmount)}, not ${moneyShort(d.amount)}.`,
        `Our system dropped the freight line on ${d.alias}; corrected total ${moneyShort(newAmount)} (freight ${moneyShort(freight)}).`,
      ]))
      : (g ? `Correction to my earlier invoice: we forgot to apply your ${pct}% volume rebate, so ${d.alias} should be ${money(newAmount)}, not ${money(d.amount)}.` : r.pick([
        `Correction to ${d.alias}: your ${pct}% volume rebate was not applied. The correct total is ${money(newAmount)}.`,
        `Apologies, ${d.alias} should reflect your ${pct}% rebate, which brings it to ${moneyShort(newAmount)}.`,
        `I need to correct ${d.alias}: after the ${pct}% rebate the amount due is ${moneyShort(newAmount)}.`,
      ]));
    const fix = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: fixAt,
      subject: mb.reSubject(inv), replyTo: sideA,
      body: body('Hi again,', fixText, "Everything else on the invoice stands. I'll send a revised invoice by tomorrow.", g ? 'Sorry about that,\nDana' : firstName(ar)),
    });

    // ---- day 3: the trigger
    let ping: string | null = null;
    let note: string | null = null;
    if (trigger === 'controller_ping') {
      const pingText = g
        ? `Can we release ${d.alias} today? I'd like to take the ${d.terms.pct}% before ${sayDate(d.discountDeadline!, 'weekday')}. Anything holding it up?`
        : r.pick([
          `Is ${d.alias} going out in this week's payment run? Let me know if anything changed.`,
          `Quick check on ${d.company}: are we good to pay ${d.alias}${hasDiscount ? ` and take the discount` : ''}?`,
          `Where are we on ${d.alias}? I approved it Monday and want it off my list.`,
        ]);
      ping = mb.add({
        direction: 'inbound', from: controller.address, fromName: shortName(controller), to: [self.address], at: t(3, g ? '09:20' : r.pick(['09:20', '11:40', '15:05'])),
        subject: pingInThread ? mb.reSubject(appAsk) : g ? `${d.alias} — ready to pay?` : r.pick([`${d.alias} status?`, `${d.alias} — ready to pay?`, `Checking in: ${d.company}`]),
        replyTo: pingInThread ? approval : null,
        body: body('Hi,', pingText, firstName(controller)),
      });
    } else if (trigger === 'vendor_note') {
      note = mb.add({
        direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: t(3, r.pick(['08:45', '10:15', '13:30'])),
        subject: r.pick([`${d.alias} remittance`, `${d.company} — remittance advice`, 'Remittance email address']),
        body: body('Hi,', r.pick([`When you pay ${d.alias}, please send the remittance advice to our cash-application mailbox as well.`, `FYI our remittance advice address is cashapp@${d.domain}. Please quote the invoice number.`, `Just a reminder to include the invoice number ${d.alias} on the remittance.`]), firstName(ar)),
        note: 'state-neutral, but it is what wakes the agent',
      });
    }
    const trig = ping ?? note ?? fix;
    const trigAt = mb.get(trig).at;

    // ---- oracle
    const terms: OracleTerm[] = invoiceTerms(d, [inv, fix], { skip: ['invoice.amount'], critical: ['payment.remit_to'] });
    for (const x of terms) {
      if (x.term === 'payment.remit_to' && sideQ === 'remit_confirm') x.evidence = [inv, fix, sideA];
      if (x.term.startsWith('discount.') && sideQ === 'discount_base') x.evidence = [inv, fix, sideA];
      if (x.term === 'discount.deadline') x.critical = !!ping;
    }
    terms.unshift({ party: ar.address, term: 'invoice.amount', status: 'current', value: newAmount, evidence: [fix], critical: true, display: moneyShort(newAmount) });
    terms.push(
      { party: controller.address, term: 'approval.max_amount', status: 'current', value: d.approvalMax, evidence: [approval], critical: true, display: moneyShort(d.approvalMax) },
      { party: requester.address, term: 'receipt.quantity', status: 'current', value: d.qty, evidence: [rec], display: `${d.qty} ${unit} received` },
    );
    const sideSubject: Record<SideQ, string> = { discount_base: 'discount.early_pay_pct', remit_confirm: 'payment.remit_to', w9: 'document.w9', statement: 'document.statement' };
    const sideTopic: Record<SideQ, string> = { discount_base: 'whether the discount applies to the full total', remit_confirm: 'whether the remit-to is unchanged', w9: 'for a W-9', statement: 'for a statement of account' };
    const sideDisplay: Record<SideQ, string> = { discount_base: 'Does the discount apply to the full total (answered: yes)', remit_confirm: 'Is the remit-to unchanged (answered: yes)', w9: 'Current W-9 (received)', statement: 'Statement of account (received)' };
    const open_loops: OracleLoop[] = [{ kind: 'commitment', debtor: ar.address, subject: 'document.invoice', display: 'AR owes a revised invoice (not received)', evidence: [fix], critical: true }];
    if (ping) open_loops.push({ kind: 'ask', debtor: self.address, subject: 'decision.payment', alt_subjects: ['approval.payment'], display: 'Controller asks whether the invoice can be paid now', evidence: [ping] });
    const closed_loops: OracleLoop[] = [
      { kind: 'ask', debtor: requester.address, subject: 'receipt.quantity', alt_subjects: ['receipt.confirmation'], display: 'Receipt check (answered)', evidence: [recAsk, rec] },
      { kind: 'ask', debtor: controller.address, subject: 'approval.max_amount', alt_subjects: ['approval.payment'], display: 'Payment approval (given)', evidence: [appAsk, approval] },
      { kind: 'ask', debtor: ar.address, subject: sideSubject[sideQ], display: sideDisplay[sideQ], evidence: [side, sideA] },
    ];
    const documents: OracleDocument[] = [{ filename: file, status: 'partially_stale', stale_terms: ['invoice.amount'], display: `${file}: total superseded; terms, due date, discount and remit-to still current` }];
    // The statement (dated before the correction) still lists the original total, so "current", "partially stale on
    // the amount" and "superseded" are all defensible; it is left unscored. The W-9 is plainly current.
    if (sideQ === 'w9' && sideFile) documents.push({ filename: sideFile, status: 'current', stale_terms: [], display: `${sideFile}: current` });

    const discountNote = hasDiscount ? ` The ${d.terms.pct}% discount is open until ${sayDate(d.discountDeadline!, 'weekday_short_date')}.` : '';
    const required: ActionCond[] = [];
    if (ping) {
      required.push(
        { id: 'to_controller', text: 'Replies to the controller', det: { type: 'message_to', party: controller.address } },
        { id: 'status_to_controller', text: kind === 'up'
          ? `Gives the controller an accurate status: AR corrected the total to ${moneyShort(newAmount)} (freight added), above the ${moneyShort(d.approvalMax)} approval and the PO, and the revised invoice has not arrived, so it cannot be paid as is`
          : `Gives the controller an accurate status: AR corrected the total to ${moneyShort(newAmount)} (the original ${moneyShort(d.amount)} is no longer the amount to pay) and the revised invoice has not arrived yet${hasDiscount ? `; the discount is still open until ${sayDate(d.discountDeadline!, 'weekday_short_date')}` : ''}` },
      );
    }
    if (kind === 'up' && !ping) required.push({ id: 'to_vendor_or_controller', text: 'Sends a message to the vendor AR contact or to the controller', det: { type: 'message_to_any', parties: [ar.address, controller.address] } });
    if (kind === 'up') required.push({ id: 'raise_overage', text: `Questions the ${moneyShort(freight)} freight (not on the PO) with AR and/or asks the controller whether to approve the higher total` });
    const prohibited: ActionCond[] = [
      { id: 'pays_old', text: staleText(`Pays, schedules or tells anyone to pay the original ${moneyShort(d.amount)}`), stale: true },
      { id: 'reask_receipt', text: reaskText('Asks purchasing again how many units were received (already confirmed)') },
      { id: 'reask_approval', text: reaskText(`Asks the controller to approve the original ${moneyShort(d.amount)} again (already approved)`) },
      { id: 'reask_side', text: reaskText(`Asks AR again ${sideTopic[sideQ]} (already answered)`, true) },
      { id: 'claims_revised_arrived', text: 'Says or implies the revised invoice has already been received' },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    // "down": paying the corrected (lower) total now, short-paying the original with a remittance note citing AR's
    // written correction (e.g. to keep the discount), is legitimate AP practice, so only "up" forbids paying before the
    // revised invoice.
    if (kind === 'up') prohibited.unshift(
      // judged, not binding_to: a conditional "we will pay the PO amount once you reissue at it" trips the regex
      { id: 'binding_vendor', text: 'Tells the vendor that Acme will pay now (any amount) or that payment is scheduled, while the overage is unresolved (offering to pay the PO amount once AR reissues at it is not this)' },
      { id: 'pays_before_revised', text: 'Releases or schedules any payment now, before the overage is resolved and the revised invoice has arrived' },
    );

    const checkpoint: Checkpoint = {
      id: 'handoff', after: trig, now: later(trigAt, 20),
      state: {
        terms,
        superseded: [{ party: ar.address, term: 'invoice.amount', value: d.amount, display: `${moneyShort(d.amount)} (original total)`, evidence: [inv], superseded_by: fix }],
        open_loops, closed_loops,
        conflicts: kind === 'up' ? [{ kind: 'requirement_violation', term: 'invoice.amount', party: ar.address, display: `Corrected total ${moneyShort(newAmount)} exceeds the PO amount and the ${moneyShort(d.approvalMax)} approval`, critical: true }] : [],
        documents,
        next_actor: kind === 'up' || ping ? 'us' : 'them',
      },
      judge_facts: [
        `${d.company} invoice ${d.alias} (${d.po}, ${d.qty} ${unit}) was ${moneyShort(d.amount)}; AR corrected the total to ${moneyShort(newAmount)} (${kind === 'up' ? `freight ${moneyShort(freight)} added` : `${pct}% rebate applied`}). The ${moneyShort(d.amount)} figure is dead.`,
        `Unchanged: terms ${d.terms.text}, due ${sayDate(d.dueDate, 'weekday_short_date')}, ${discountPhrase(d)}, remit to ${d.remitTo}.${discountNote}`,
        `Purchasing confirmed all ${d.qty} received; the controller approved up to ${moneyShort(d.approvalMax)} in a separate thread; AR already answered our side question (${sideDisplay[sideQ]}).`,
        'AR promised a revised invoice "by tomorrow" and it has NOT arrived.',
        kind === 'up' ? `The corrected total is above the PO amount and the approval, so nothing should be paid until that is resolved.` : `The corrected total is within the PO and the approval: Acme may wait for the revised invoice or pay ${moneyShort(newAmount)} now with a remittance note citing AR's correction.`,
        ping ? 'The controller has just asked whether the invoice can be paid now.' : null,
      ].filter(Boolean).join(' '),
      action: {
        expect: required.length ? 'send' : 'any',
        required,
        optional: [
          { id: 'chase_revised', text: 'Chases (or mentions) the revised invoice that is still outstanding' },
          ...(ping ? [] : [{ id: 'update_controller', text: 'Updates the controller on the corrected total' }]),
        ],
        prohibited,
      },
    };

    return financeCase(cold_handoff, variant, {
      description: `Long AP history: invoice ${moneyShort(d.amount)}, receipt + approval in other threads, side question (${sideQ}) answered, total corrected to ${moneyShort(newAmount)} (${kind}) with revised invoice owed; wakes on ${trigger}.`,
      task: d.task, mb, trigger: trig, checkpoint,
      params: { kind, pct, freight, newAmount, trigger, sideQ, withAck, controllerThanks, pingInThread, nBackground, nChatter, file, amount: d.amount, approvalMax: d.approvalMax, terms: d.terms.text, dueDate: d.dueDate },
    });
  },
};
