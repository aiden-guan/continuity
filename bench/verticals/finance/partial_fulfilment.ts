// Archetype: partial fulfilment (P1).
//
// Two shapes of "a commitment of N, k fulfilled":
//   installments  (golden) AR agrees to let Acme pay a large invoice in three installments, and we
//                 commit to the plan. Installment 1 is paid (our remittance advice) and AR confirms
//                 it. Then the controller, looking at an aging report that still shows the invoice
//                 open, asks whether to put it in this week's run (or AR's receipt note is the trigger).
//   credits       purchasing reports N units short/damaged; AR commits to credit all N. A credit memo
//                 arrives for k of them; the other N−k are "still with the carrier" and promised later.
//
// Trap: a commitment tracker that only knows "open" and "fulfilled" either closes the loop (a payment /
// a credit memo happened) or keeps the whole N open (pay the full invoice again: a duplicate payment;
// ask for credit on all N units again). The oracle keeps ONE commitment open with the residual N−k:
// ours (two installments) or AR's (credit for the remaining units). For installments the original due
// date is replaced by the plan; for credits the uncredited units are still a 3-way-match violation.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleLoop, OracleSuperseded, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, money, moneyShort, pdf, sayDate, seedOf, staleText } from '../../core/util.ts';
import { arSign, creditMemoLines, financeBackground, financeCase, financeChatter, financeDayStart, financeDeal, firstName, invoiceLines, invoiceTerms, later, ours, round2, scheduleDisplay, shortName, type Lot } from './vertical.ts';

export const partial_fulfilment: Archetype = {
  id: 'partial_fulfilment',
  title: 'One installment paid / one credit memo issued, the rest still owed',
  capabilities: ['partial_fulfilment', 'open_loops', 'supersession'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('finance', 'partial_fulfilment', variant));
    const g = variant === 0;
    const mode: 'installments' | 'credits' = g ? 'installments' : r.pick(['installments', 'credits'] as const);
    const d = financeDeal(r, variant, { terms: mode === 'installments' ? 'net' : undefined });
    const { self, ar, controller, requester } = d.cast;
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => financeDayStart(d, day, hhmm);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 3);
    const file = g ? `Northwind_Invoice_${d.alias}.pdf` : `${d.company.split(' ')[0]}_Invoice_${d.alias}.pdf`;

    const inv = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: financeDayStart(d, -6, g ? '15:10' : r.pick(['10:20', '13:45', '15:10'])),
      subject: `Invoice ${d.alias} — ${d.po}`,
      body: body('Hi,', g
        ? `Please find attached invoice ${d.alias} for ${d.po}: ${d.qty} ${unit}, total ${money(d.amount)}, terms ${d.terms.text}.`
        : r.pick([
          `Attached is invoice ${d.alias} (${d.po}): ${moneyShort(d.amount)}, ${d.terms.text}.`,
          `Invoice ${d.alias} for the ${d.qty} ${unit} on ${d.po} is attached. Total ${money(d.amount)}.`,
          `Please see invoice ${d.alias} attached, ${moneyShort(d.amount)} due ${sayDate(d.dueDate, 'month_day')}.`,
        ]), arSign(d, g, r)),
      attachments: [pdf(file, invoiceLines(d))],
    });
    financeBackground(r, d, mb, financeDayStart(d, -5, '13:00'), nBackground, g ? 0 : r.int(0, 7));

    if (mode === 'installments') {
      // ---- parameters
      const inst = round2(Math.floor((d.amount / 3) * 100) / 100);
      const last = round2(d.amount - 2 * inst);
      const d1 = addDays(d.start, 1); // Tuesday
      const gap = g ? 28 : r.pick([14, 21, 28, 30]);
      const plan: Lot[] = [{ qty: inst, date: d1 }, { qty: inst, date: addDays(d1, gap) }, { qty: last, date: addDays(d1, 2 * gap) }];
      const trigger: 'controller_ask' | 'vendor_receipt' = g ? 'controller_ask' : r.pick(['controller_ask', 'vendor_receipt'] as const);
      const arConfirms = g ? true : trigger === 'vendor_receipt' ? true : r.chance(0.6);
      const remaining = round2(d.amount - inst);
      const reason = g ? 'a large quarter-end cash commitment' : r.pick(['a large quarter-end cash commitment', 'our capital budget timing', 'a delayed customer payment on our side']);

      const ask = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ar.address], at: financeDayStart(d, -5, '10:00'), subject: mb.reSubject(inv), replyTo: inv, body: ours(firstName(ar), `Because of ${reason}, could we pay ${d.alias} (${moneyShort(d.amount)}) in three monthly installments instead of in one payment by ${sayDate(d.dueDate, 'month_day')}? The first could go out ${sayDate(d1, 'weekday_long')}.`) });
      const planText = g
        ? `That works. We can accept three installments: ${money(inst)} on ${sayDate(plan[0].date, 'month_day')}, ${money(inst)} on ${sayDate(plan[1].date, 'month_day')} and ${money(last)} on ${sayDate(plan[2].date, 'month_day')}.`
        : r.pick([
          `Approved by our credit team: ${moneyShort(inst)} by ${sayDate(plan[0].date, 'month_day')}, ${moneyShort(inst)} by ${sayDate(plan[1].date, 'month_day')}, final ${moneyShort(last)} by ${sayDate(plan[2].date, 'month_day')}.`,
          `Yes, we can do three installments. Schedule: ${sayDate(plan[0].date, 'weekday_short_date')} ${money(inst)}; ${sayDate(plan[1].date, 'weekday_short_date')} ${money(inst)}; ${sayDate(plan[2].date, 'weekday_short_date')} ${money(last)}.`,
          `OK on our side. Please pay ${moneyShort(inst)} on ${sayDate(plan[0].date, 'long')}, the same on ${sayDate(plan[1].date, 'long')}, and the balance of ${moneyShort(last)} on ${sayDate(plan[2].date, 'long')}.`,
        ]);
      const agree = mb.add({ direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: financeDayStart(d, -4, g ? '11:30' : r.pick(['09:40', '11:30', '15:20'])), subject: mb.reSubject(inv), replyTo: ask, body: body('Hi,', planText, arSign(d, g, r)) });
      const confirm = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ar.address], cc: [controller.address], at: financeDayStart(d, -4, '16:00'), subject: mb.reSubject(inv), replyTo: agree, body: ours(firstName(ar), `Thank you. Confirmed: we will pay ${d.alias} per that schedule (${scheduleDisplay(plan)}).`) });
      financeChatter(r, d, mb, t(0, '09:00'), nChatter, g ? 0 : r.int(0, 9));
      const remit = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ar.address], at: t(1, '10:30'), subject: `Remittance advice — ${d.alias} installment 1 of 3`, body: ours(firstName(ar), `We have sent ${money(inst)} to ${d.remitTo} today: installment 1 of 3 on ${d.alias}. Remaining per plan: ${money(inst)} on ${sayDate(plan[1].date, 'month_day')} and ${money(last)} on ${sayDate(plan[2].date, 'month_day')}.`) });
      let arAck: string | null = null;
      if (arConfirms) {
        arAck = mb.add({
          direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: t(2, g ? '09:15' : r.pick(['09:15', '11:00', '14:40'])),
          subject: mb.reSubject(remit), replyTo: remit,
          body: body('Hi,', g ? `We received your first installment of ${money(inst)}, thank you. The remaining balance on ${d.alias} is ${money(remaining)}.` : r.pick([
            `Payment of ${moneyShort(inst)} received and applied to ${d.alias}. Open balance ${moneyShort(remaining)}, per the plan.`,
            `Thanks, installment 1 (${money(inst)}) is in. ${money(remaining)} remains on ${d.alias}.`,
            `Confirming receipt of ${moneyShort(inst)}. Balance outstanding: ${moneyShort(remaining)}.`,
          ]), arSign(d, g, r)),
        });
      }
      let ping: string | null = null;
      if (trigger === 'controller_ask') {
        ping = mb.add({
          direction: 'inbound', from: controller.address, fromName: shortName(controller), to: [self.address], at: t(3, g ? '10:05' : r.pick(['09:30', '10:05', '13:50'])),
          subject: g ? `${d.alias} on the aging report` : r.pick([`${d.alias} on the aging report`, `Payment run — ${d.company}`, `${d.alias}?`]),
          body: body('Hi,', g ? `The AP aging still shows ${d.company} ${d.alias} open at ${money(d.amount)}. Should I add it to Friday's payment run?` : r.pick([
            `Our aging report has ${d.alias} at ${moneyShort(d.amount)} open. Do you want it in this week's run?`,
            `Treasury flagged ${d.company} ${d.alias} (${moneyShort(d.amount)}) as unpaid. Shall we pay it Friday?`,
            `Is ${d.alias} ready to go out in full this week? The system shows ${moneyShort(d.amount)} open.`,
          ]), firstName(controller)),
          note: 'the ERP has not picked up the installment plan',
        });
      }
      const trig = ping ?? arAck!;
      const trigAt = mb.get(trig).at;
      const restPlan = plan.slice(1);

      // ---- oracle
      const terms: OracleTerm[] = invoiceTerms(d, [inv], { skip: ['invoice.due_date'], critical: ['invoice.amount'] });
      // invoice.due_date is deliberately unlabelled as a current/absent term: "no single due date any more" and
      // "the final installment date" are both fair readings. Only the old single due date is dead (superseded below).
      terms.push(
        { party: ar.address, term: 'payment.schedule', status: 'current', value: plan, evidence: [agree, confirm, remit], critical: true, display: `${scheduleDisplay(plan)} (installment 1 paid)` },
      );
      if (arAck) terms.push({ party: ar.address, term: 'balance.due', status: 'current', value: remaining, evidence: [arAck], critical: true, display: moneyShort(remaining) });
      const superseded: OracleSuperseded[] = [{ party: ar.address, term: 'invoice.due_date', value: d.dueDate, display: `${sayDate(d.dueDate, 'weekday_short_date')} (single payment, replaced by the plan)`, evidence: [inv], superseded_by: agree }];
      const open_loops: OracleLoop[] = [
        { kind: 'commitment', debtor: self.address, subject: 'payment.remaining_installments', alt_subjects: ['payment.schedule'], display: `Acme still owes installments 2 and 3 (${scheduleDisplay(restPlan)})`, evidence: [confirm, remit], critical: true, residual: { qty: remaining, display: `${moneyShort(remaining)} in 2 of 3 installments` } },
      ];
      if (ping) open_loops.push({ kind: 'ask', debtor: self.address, subject: 'decision.payment', display: 'Controller asks whether to pay the invoice in this week\'s run', evidence: [ping] });
      const closed_loops: OracleLoop[] = [{ kind: 'ask', debtor: ar.address, subject: 'payment.schedule', display: 'Request for an installment plan (agreed)', evidence: [ask, agree] }];
      const prohibited: ActionCond[] = [
        { id: 'pays_full', text: `Pays, schedules or recommends paying the full ${moneyShort(d.amount)} (or the whole remaining ${moneyShort(remaining)}) now: a duplicate / early payment outside the plan` },
        { id: 'claims_paid', text: `Says the invoice is paid in full or that nothing more is owed` },
        { id: 'full_outstanding', text: `Treats the full ${moneyShort(d.amount)} as still outstanding (ignores the ${moneyShort(inst)} already paid)` },
        { id: 'stale_due', text: staleText(`Treats ${sayDate(d.dueDate, 'weekday_short_date')} as the date the whole invoice is due`), stale: true },
        { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
      ];
      const checkpoint: Checkpoint = {
        id: 'after_first_installment', after: trig, now: later(trigAt, 20),
        state: { terms, superseded, open_loops, closed_loops, conflicts: [], documents: [{ filename: file, status: 'partially_stale', stale_terms: ['invoice.due_date'], ambiguous_terms: ['payment.terms'], display: `${file}: due date replaced by the installment plan; total and remit-to still current` }], next_actor: 'us' },
        judge_facts: [
          `${d.company} invoice ${d.alias} is ${moneyShort(d.amount)}. AR agreed to three installments (${scheduleDisplay(plan)}) in place of a single payment by ${sayDate(d.dueDate, 'weekday_short_date')}, and Acme committed to that plan.`,
          `Installment 1 (${moneyShort(inst)}) was paid on ${sayDate(d1, 'weekday_short_date')}${arAck ? ' and AR confirmed receipt' : ''}. ${moneyShort(remaining)} remains, due as installments 2 and 3 (${scheduleDisplay(restPlan)}); nothing else is due now.`,
          ping ? `The controller, looking at an aging report that does not reflect the plan, asks whether to pay the invoice (${moneyShort(d.amount)}) this week.` : null,
        ].filter(Boolean).join(' '),
        action: ping
          ? {
            expect: 'send',
            required: [
              { id: 'to_controller', text: 'Replies to the controller', det: { type: 'message_to', party: controller.address } },
              { id: 'explain_plan', text: `Tells the controller not to pay it now: installment 1 (${moneyShort(inst)}) is paid and the remaining ${moneyShort(remaining)} is due as installments on ${restPlan.map((l) => sayDate(l.date, 'weekday_short_date')).join(' and ')}` },
            ],
            optional: [{ id: 'fix_aging', text: 'Suggests updating the ERP / aging report to reflect the installment plan' }],
            prohibited,
          }
          : {
            expect: 'any',
            required: [],
            optional: [{ id: 'ack', text: `Acknowledges AR's confirmation and the remaining ${moneyShort(remaining)} schedule` }],
            prohibited,
          },
      };
      void requester;
      return financeCase(partial_fulfilment, variant, {
        description: `Installment plan ${scheduleDisplay(plan)} for ${d.alias}; installment 1 paid, ${moneyShort(remaining)} still owed; wakes on ${trigger}.`,
        task: d.task, mb, trigger: trig, checkpoint,
        params: { mode, plan, inst, last, remaining, trigger, arConfirms, gap, nBackground, nChatter, amount: d.amount, dueDate: d.dueDate },
      });
    }

    // ---- credits mode
    const shortfall = Math.max(4, Math.round(d.qty * r.pick([0.06, 0.08, 0.1, 0.12])));
    const k = Math.max(1, Math.round(shortfall * r.pick([0.4, 0.5, 0.6])));
    const rest = shortfall - k;
    const received = d.qty - shortfall;
    const memo = round2(k * d.unitPrice);
    const restAmount = round2(rest * d.unitPrice);
    const damaged = r.chance(0.5);
    const restBy = addDays(d.start, r.pick([7, 8, 9]));
    const reporter = r.chance(0.5) ? 'ar' : 'ar_new_thread';
    const cmRef = `CM-${r.int(1000, 9999)}`;
    const cmFile = `${cmRef}.pdf`;

    const recAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [requester.address], at: t(0, '09:00'), subject: `Receipt check — ${d.po}`, body: ours(firstName(requester), `${d.company} billed ${d.qty} ${unit} on ${d.alias}. What did we receive on ${d.po}?`) });
    const rec = mb.add({ direction: 'inbound', from: requester.address, fromName: shortName(requester), to: [self.address], at: t(0, '10:10'), subject: mb.reSubject(recAsk), replyTo: recAsk, body: body(damaged ? r.pick([`${shortfall} of the ${d.qty} arrived damaged and were rejected; ${received} accepted.`, `We accepted ${received}. ${shortfall} were crushed in transit and refused.`]) : r.pick([`Only ${received} arrived, ${shortfall} short.`, `Receiving counted ${received} of ${d.qty}; ${shortfall} missing.`]), firstName(requester)) });
    const creditAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ar.address], at: t(0, '11:00'), subject: mb.reSubject(inv), replyTo: inv, body: ours(firstName(ar), `On ${d.alias} we ${damaged ? `rejected ${shortfall} damaged ${unit}` : `received ${shortfall} ${unit} fewer than billed`} (${received} accepted). Please credit the ${shortfall} ${unit} (${moneyShort(round2(shortfall * d.unitPrice))}).`) });
    const promise = mb.add({ direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: t(0, '15:30'), subject: mb.reSubject(inv), replyTo: creditAsk, body: body('Hi,', r.pick([`Understood. We will credit all ${shortfall} ${unit}; I'm confirming the details with our carrier.`, `No problem, we'll issue credit for the ${shortfall} ${unit}.`, `Agreed: credit for ${shortfall} ${unit} (${moneyShort(round2(shortfall * d.unitPrice))}) is on its way.`]), arSign(d, g, r)) });
    financeChatter(r, d, mb, t(1, '09:00'), nChatter, r.int(0, 9));
    const reportAt = t(r.int(1, 2), r.pick(['11:20', '14:10', '16:30']));
    const report = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: reportAt,
      subject: reporter === 'ar' ? mb.reSubject(inv) : r.pick([`Credit memo ${cmRef} — ${d.alias}`, `${d.alias} credit`]), replyTo: reporter === 'ar' ? promise : null,
      body: body('Hi,', r.pick([
        `Credit memo ${cmRef} for ${k} ${unit} (${money(memo)}) is attached. The other ${rest} are still under review with the carrier; we'll credit them by ${sayDate(restBy, 'weekday_long')}.`,
        `Attached is ${cmRef}, crediting ${moneyShort(memo)} for ${k} of the ${shortfall} ${unit}. The remaining ${rest} will follow once the carrier claim closes, by ${sayDate(restBy, 'month_day')}.`,
        `First credit is done: ${cmRef}, ${moneyShort(memo)} (${k} ${unit}). Credit for the last ${rest} should be issued by ${sayDate(restBy, 'long')}.`,
      ]), arSign(d, g, r)),
      attachments: [pdf(cmFile, creditMemoLines(d, { ref: cmRef, date: reportAt.slice(0, 10), amount: memo, units: k, reason: damaged ? `${k} ${unit} damaged in transit` : `${k} ${unit} not delivered` }))],
    });
    const terms: OracleTerm[] = invoiceTerms(d, [inv], { critical: ['invoice.amount'] });
    terms.push(
      { party: ar.address, term: 'invoice.quantity', status: 'current', value: d.qty, evidence: [inv], display: `${d.qty} ${unit} billed` },
      { party: requester.address, term: 'receipt.quantity', status: 'current', value: received, evidence: [rec], critical: true, display: `${received} accepted` },
      { party: ar.address, term: 'credit.memo_amount', status: 'current', value: memo, evidence: [report], critical: true, display: `${moneyShort(memo)} (${cmRef}, ${k} ${unit})` },
    );
    const prohibited: ActionCond[] = [
      { id: 'claims_complete', text: `Says or implies that all ${shortfall} ${unit} have been credited` },
      { id: 'full_outstanding', text: `Asks for credit on all ${shortfall} ${unit} again, ignoring ${cmRef}` },
      { id: 'pays_uncredited', text: `Pays for the ${rest} ${unit} that were not received and not yet credited (e.g. pays ${moneyShort(round2(d.amount - memo))} or the full ${moneyShort(d.amount)})` },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    const checkpoint: Checkpoint = {
      id: 'after_partial_credit', after: report, now: later(reportAt, 20),
      state: {
        terms, superseded: [],
        open_loops: [{ kind: 'commitment', debtor: ar.address, subject: 'credit.remaining_units', alt_subjects: ['document.credit_memo'], display: `AR still owes credit for ${rest} ${unit} (${moneyShort(restAmount)}, by ${sayDate(restBy, 'weekday_short_date')})`, evidence: [promise, report], critical: true, residual: { qty: rest, display: `${rest} of ${shortfall} ${unit}` } }],
        closed_loops: [
          { kind: 'ask', debtor: requester.address, subject: 'receipt.quantity', alt_subjects: ['receipt.confirmation'], display: 'Receipt check (answered)', evidence: [recAsk, rec] },
        ],
        conflicts: [{ kind: 'requirement_violation', term: 'invoice.quantity', party: ar.address, display: `${rest} ${unit} are billed but neither received nor credited yet`, critical: true }],
        documents: [
          { filename: file, status: 'current', stale_terms: [], display: `${file}: current (shortfall handled by credit memos)` },
          { filename: cmFile, status: 'current', stale_terms: [], display: `${cmFile}: current` },
        ],
        next_actor: 'them',
      },
      judge_facts: [
        `${d.company} billed ${d.qty} ${unit} (${moneyShort(d.amount)}) on ${d.alias}; Acme accepted only ${received}. AR committed to credit all ${shortfall}.`,
        `Credit memo ${cmRef} for ${k} ${unit} (${moneyShort(memo)}) has arrived; credit for the remaining ${rest} (${moneyShort(restAmount)}) is promised by ${sayDate(restBy, 'weekday_short_date')}. Only those ${rest} are still owed.`,
        `Net of everything, Acme owes ${moneyShort(round2(d.amount - shortfall * d.unitPrice))} for what it received.`,
      ].join(' '),
      action: {
        expect: 'any',
        required: [],
        optional: [{ id: 'ack', text: `Acknowledges ${cmRef} and confirms Acme expects credit for the remaining ${rest} ${unit} by ${sayDate(restBy, 'weekday_short_date')}`, det: { type: 'message_to', party: ar.address } }],
        prohibited,
      },
    };
    return financeCase(partial_fulfilment, variant, {
      description: `AR committed to credit ${shortfall} ${unit}; ${cmRef} credits ${k}, ${rest} still owed.`,
      task: d.task, mb, trigger: report, checkpoint,
      params: { mode, shortfall, k, rest, memo, restBy, damaged, reporter, nBackground, nChatter, amount: d.amount },
    });
  },
};
