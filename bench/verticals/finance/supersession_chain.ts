// Archetype: supersession chain (P1).
//
// A → B → C. The invoice PDF (A) bills N units with an early-payment discount and a due date.
// Purchasing reports only R were accepted, and we ask AR to bill the R units only. AR answers with a
// bundled restatement B that changes three terms at once: the total drops to the R units, but the
// early-payment discount shrinks and the due date moves earlier. Then exactly one term reverts to its
// A value in C: we say our payment runs cannot make the earlier date and AR keeps the original due
// date; or we ask to keep the full discount and AR agrees; or AR's manager refuses the reduction and
// the total goes back to the N-unit amount. The other two B values stand.
//
// Trap: per-term history. "Latest message wins" for the whole bundle loses the two B values that C
// only restates implicitly; "first value wins" or a summary keeps A. And a value that is current again
// must not be reported as superseded. The oracle has, per term, the latest value current (with every
// event that stated it), superseded = exactly the dead values (with the event that killed each), the
// PDF stale on exactly the terms whose current value differs from it, and a requirement violation
// when the total ends up billing units that were not accepted.
import type { ActionCond, Archetype, BenchCase, Checkpoint, OracleConflict, OracleDocument, OracleLoop, OracleSuperseded, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, money, moneyShort, pdf, sayDate, seedOf, staleText } from '../../core/util.ts';
import { arSign, financeBackground, financeCase, financeChatter, financeDayStart, financeDeal, firstName, invoiceLines, later, ours, round2, shortName } from './vertical.ts';

type Key = 'amount' | 'pct' | 'due';
const TERM: Record<Key, string> = { amount: 'invoice.amount', pct: 'discount.early_pay_pct', due: 'invoice.due_date' };

export const supersession_chain: Archetype = {
  id: 'supersession_chain',
  title: 'Bundled restatement, then one term reverts',
  capabilities: ['supersession', 'document_validity'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('finance', 'supersession_chain', variant));
    const g = variant === 0;
    const d = financeDeal(r, variant, { terms: 'discount' });
    const { self, ar, requester } = d.cast;
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => financeDayStart(d, day, hhmm);

    // ---- parameters
    const revert: Key = g ? 'due' : r.pick(['due', 'pct', 'amount'] as const);
    const rejected = g ? 5 : Math.max(2, Math.round(d.qty * r.pick([0.025, 0.05, 0.08])));
    const accepted = d.qty - rejected;
    const matched = round2(accepted * d.unitPrice);
    const pctA = d.terms.pct!;
    const pctB = pctA >= 2 ? 1 : 0.5;
    const dueB = addDays(d.dueDate, -(g ? 10 : r.pick([7, 10, 14])));
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 3);
    const file = g ? `Northwind_Invoice_${d.alias}.pdf` : `${d.company.split(' ')[0]}_Invoice_${d.alias}.pdf`;
    const A: Record<Key, unknown> = { amount: d.amount, pct: pctA, due: d.dueDate };
    const B: Record<Key, unknown> = { amount: matched, pct: pctB, due: dueB };
    const show = (k: Key, v: unknown) => (k === 'amount' ? moneyShort(v as number) : k === 'pct' ? `${v}% discount` : `due ${sayDate(v as string, 'weekday_short_date')}`);

    // ---- A
    const inv = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: financeDayStart(d, -6, g ? '15:10' : r.pick(['10:20', '13:45', '15:10'])),
      subject: `Invoice ${d.alias} — ${d.po}`,
      body: body('Hi,', g
        ? `Please find attached invoice ${d.alias} for ${d.po}: ${d.qty} ${unit}, ${money(d.amount)}, terms ${d.terms.text} (${pctA}% if paid by ${sayDate(d.discountDeadline!, 'month_day')}), due ${sayDate(d.dueDate, 'long')}.`
        : r.pick([
          `Attached is invoice ${d.alias} (${d.po}): ${moneyShort(d.amount)}, ${d.terms.text}, due ${sayDate(d.dueDate, 'month_day')}.`,
          `Invoice ${d.alias} for the ${d.qty} ${unit} is attached; ${pctA}% discount if paid by ${sayDate(d.discountDeadline!, 'weekday_long')}.`,
          `Please see our invoice ${d.alias} attached for ${d.po}.`,
        ]), arSign(d, g, r)),
      attachments: [pdf(file, invoiceLines(d))],
    });
    financeBackground(r, d, mb, financeDayStart(d, -5, '10:00'), nBackground, g ? 0 : r.int(0, 7));
    const rec = mb.add({ direction: 'inbound', from: requester.address, fromName: shortName(requester), to: [self.address], at: t(0, '08:50'), subject: `${d.po} receiving`, body: body(g ? `${rejected} of the ${d.qty} ${unit} were damaged and rejected; we accepted ${accepted}.` : r.pick([`We accepted ${accepted} of ${d.qty}; ${rejected} failed inspection.`, `${rejected} ${unit} from ${d.company} were damaged, so only ${accepted} were accepted.`]), firstName(requester)) });
    const dispute = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ar.address], at: t(0, '10:00'), subject: mb.reSubject(inv), replyTo: inv, body: ours(firstName(ar), `We rejected ${rejected} damaged ${unit} on ${d.po} and accepted ${accepted}. Please bill ${d.alias} for the ${accepted} accepted units only (${moneyShort(matched)}).`) });

    // ---- B: three terms change at once
    const bAt = t(0, g ? '15:20' : r.pick(['13:40', '15:20', '16:45']));
    const b = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: bAt,
      subject: mb.reSubject(inv), replyTo: dispute,
      body: body('Hi,', g
        ? `We can bill ${money(matched)} for the ${accepted} accepted ${unit}, but then the early-payment discount drops to ${pctB}% and we need payment by ${sayDate(dueB, 'long')}.`
        : r.pick([
          `OK: ${moneyShort(matched)} for the ${accepted} ${unit}. In return the discount goes to ${pctB}% and the due date moves up to ${sayDate(dueB, 'month_day')}.`,
          `Our credit team agreed to ${money(matched)}, on condition that payment is due ${sayDate(dueB, 'weekday_long')} and the discount is ${pctB}% instead of ${pctA}%.`,
          `Revised position on ${d.alias}: total ${moneyShort(matched)}, ${pctB}% early-pay discount, due ${sayDate(dueB, 'long')}.`,
        ]), firstName(ar)),
    });
    financeChatter(r, d, mb, later(bAt, 15), nChatter, g ? 0 : r.int(0, 9));

    // ---- C: one term reverts
    let push: string | null = null;
    const pushAt = t(1, '09:30');
    if (revert === 'due') push = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ar.address], at: pushAt, subject: mb.reSubject(inv), replyTo: b, body: ours(firstName(ar), g ? `The ${moneyShort(matched)} and the ${pctB}% work, but our payment runs can't make ${sayDate(dueB, 'month_day')}. Can we keep the original ${sayDate(d.dueDate, 'month_day')} due date?` : r.pick([`${moneyShort(matched)} is fine, and we can live with ${pctB}%, but ${sayDate(dueB, 'month_day')} doesn't fit our payment calendar. Could the due date stay at ${sayDate(d.dueDate, 'month_day')}?`, `Could we keep the original due date (${sayDate(d.dueDate, 'month_day')})? The rest of your proposal works.`])) });
    // amount: Acme accepts the whole restatement first, so the 0.5%/earlier due date are agreed terms (not just a
    // conditional counteroffer Acme never took) when AR's manager later walks back the reduction alone
    if (revert === 'amount') push = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ar.address], at: pushAt, subject: mb.reSubject(inv), replyTo: b, body: ours(firstName(ar), r.pick([`Thanks, that works: ${moneyShort(matched)}, ${pctB}% and due ${sayDate(dueB, 'month_day')}. Please reissue ${d.alias} on that basis.`, `Agreed on all three (${moneyShort(matched)}, ${pctB}%, ${sayDate(dueB, 'month_day')}). Could you send the reissued invoice?`])) });
    if (revert === 'pct') push = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ar.address], at: pushAt, subject: mb.reSubject(inv), replyTo: b, body: ours(firstName(ar), r.pick([`We can meet ${sayDate(dueB, 'month_day')}. Could you keep the ${pctA}% discount though?`, `Fine on the amount and the date; is there any way to stay at ${pctA}%?`])) });
    const cAt = t(1, g ? '14:10' : r.pick(['11:05', '14:10', '16:20']));
    const cText: Record<Key, string[]> = {
      due: [
        `No problem, we'll keep the due date at ${sayDate(d.dueDate, 'long')}. ${moneyShort(matched)} and ${pctB}% as discussed. Shall I reissue the invoice on that basis?`,
        `OK, ${sayDate(d.dueDate, 'month_day')} it is. The rest of my last email stands. Want me to reissue?`,
        `Agreed, due date back to ${sayDate(d.dueDate, 'weekday_long')}; still ${moneyShort(matched)} with ${pctB}%. Confirm and I'll send the revised invoice.`,
      ],
      pct: [
        `Fine, we'll honour the ${pctA}% after all. ${moneyShort(matched)} and the ${sayDate(dueB, 'month_day')} due date stand. Shall I reissue?`,
        `We can keep ${pctA}%. Everything else as in my last email. Confirm and I'll reissue the invoice.`,
        `Agreed on ${pctA}%; total ${moneyShort(matched)}, due ${sayDate(dueB, 'long')}. OK to reissue?`,
      ],
      amount: [
        `Apologies, my manager would not approve the reduction, so ${d.alias} stays at ${money(d.amount)}. The ${pctB}% and the ${sayDate(dueB, 'month_day')} due date stand.`,
        `I have to walk back the ${moneyShort(matched)}: the invoice remains ${moneyShort(d.amount)}. The ${pctB}% discount and ${sayDate(dueB, 'long')} due date are unchanged from my last email.`,
        `Sorry, the credit for the rejected ${unit} was not signed off. Total is ${moneyShort(d.amount)} again; the rest of my last email still applies.`,
      ],
    };
    const c = mb.add({ direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: cAt, subject: mb.reSubject(inv), replyTo: push ?? b, body: body('Hi,', g ? cText.due[0] : r.pick(cText[revert]), firstName(ar)) });

    // ---- oracle: per-term history
    const keys: Key[] = ['amount', 'pct', 'due'];
    const C: Record<Key, unknown> = { ...B, [revert]: A[revert] };
    const terms: OracleTerm[] = [];
    const superseded: OracleSuperseded[] = [];
    for (const k of keys) {
      const reverted = k === revert;
      terms.push({ party: ar.address, term: TERM[k], status: 'current', value: C[k], evidence: reverted ? [inv, c] : [b, c], critical: k !== 'pct', display: show(k, C[k]) });
      if (reverted) superseded.push({ party: ar.address, term: TERM[k], value: B[k], display: `${show(k, B[k])} (restatement)`, evidence: [b], superseded_by: c });
      else superseded.push({ party: ar.address, term: TERM[k], value: A[k], display: `${show(k, A[k])} (original invoice)`, evidence: [inv], superseded_by: b });
    }
    terms.push(
      { party: ar.address, term: 'invoice.number', status: 'current', value: d.alias, evidence: [inv, b, c], display: d.alias },
      { party: ar.address, term: 'discount.deadline', status: 'current', value: d.discountDeadline, evidence: [inv], display: sayDate(d.discountDeadline!, 'weekday_short_date') },
      { party: ar.address, term: 'payment.remit_to', status: 'current', value: d.remitTo, evidence: [inv], display: d.remitTo },
      { party: requester.address, term: 'receipt.quantity', status: 'current', value: accepted, evidence: [rec], critical: true, display: `${accepted} accepted` },
    );
    const finalBad = revert === 'amount';
    const conflicts: OracleConflict[] = finalBad ? [{ kind: 'requirement_violation', term: 'invoice.amount', party: ar.address, display: `${moneyShort(d.amount)} bills ${d.qty} ${unit}; only ${accepted} were accepted (${moneyShort(matched)})`, critical: true }] : [];
    const stale = keys.filter((k) => k !== revert).map((k) => TERM[k]);
    // the PDF's written terms ("2/10 Net 30") embed the discount and the due date, so calling them stale is fair too
    const documents: OracleDocument[] = [{ filename: file, status: 'partially_stale', stale_terms: stale, ambiguous_terms: ['payment.terms'], display: `${file}: ${stale.join(', ')} superseded; ${TERM[revert]} matches the current value again` }];
    const closed_loops: OracleLoop[] = [{ kind: 'ask', debtor: ar.address, subject: 'invoice.amount', alt_subjects: ['document.invoice', 'document.credit_memo'], display: 'Bill only the accepted units (answered with the restatement)', evidence: [dispute, b] }];
    // (amount: our reissue request was refused by the walk-back; whether that loop is "closed" or "open" is debatable, so it is unlabelled)
    if (push && revert !== 'amount') closed_loops.push({ kind: 'ask', debtor: ar.address, subject: TERM[revert], display: `Our push-back on the ${revert === 'due' ? 'due date' : 'discount'} (answered)`, evidence: [push, c] });
    const open_loops: OracleLoop[] = finalBad ? [] : [{ kind: 'ask', debtor: self.address, subject: 'decision.payment', alt_subjects: ['document.invoice'], display: 'AR asks whether to reissue the invoice on these terms', evidence: [c] }];

    const current = keys.map((k) => show(k, C[k])).join(', ');
    const dead = superseded.map((x) => x.display).join('; ');
    const prohibited: ActionCond[] = [
      { id: 'stale_value', text: staleText(`Uses a superseded value as current (${superseded.map((x) => show(keys.find((k) => TERM[k] === x.term)!, x.value)).join(' / ')})${revert === 'amount' ? `; asking AR to bill ${moneyShort(matched)} for the accepted units is not this` : ''}`), stale: true },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    // judged, not binding_to: committing to pay only the accepted units is legitimate and uses the same binding language
    if (finalBad) prohibited.unshift({ id: 'binding_vendor', text: `Accepts the ${moneyShort(d.amount)} total or commits to paying it (offering to pay ${moneyShort(matched)} for the accepted units is fine)` });
    const checkpoint: Checkpoint = {
      id: 'after_chain', after: c, now: later(cAt, 20),
      state: { terms, superseded, open_loops, closed_loops, conflicts, documents, next_actor: 'us' },
      judge_facts: [
        `Original invoice: ${moneyShort(d.amount)} for ${d.qty} ${unit}, ${pctA}% discount if paid by ${sayDate(d.discountDeadline!, 'weekday_short_date')}, due ${sayDate(d.dueDate, 'weekday_short_date')}. Acme accepted only ${accepted} (${moneyShort(matched)}).`,
        `AR's restatement: ${moneyShort(matched)}, ${pctB}% discount, due ${sayDate(dueB, 'weekday_short_date')}.${revert === 'amount' ? ' Acme accepted it.' : ''} Then the ${revert === 'due' ? 'due date' : revert === 'pct' ? 'discount' : 'total'} reverted to the original.`,
        `Current: ${current}. Dead values: ${dead}.`,
        finalBad ? `The ${moneyShort(d.amount)} total bills ${rejected} ${unit} Acme rejected, so it cannot be accepted.` : `These terms match what Acme received; AR asks whether to reissue the invoice.`,
      ].join(' '),
      action: finalBad
        ? {
          expect: 'send',
          required: [
            { id: 'to_vendor', text: 'Sends a message to the vendor AR contact', det: { type: 'message_to', party: ar.address } },
            { id: 'raise_amount', text: `Tells AR that ${moneyShort(d.amount)} still bills the ${rejected} rejected ${unit} and asks for ${moneyShort(matched)} (or a credit memo for the rejected units)` },
          ],
          optional: [{ id: 'restate_current', text: `Restates the current discount and due date correctly (${pctB}%, ${sayDate(dueB, 'weekday_short_date')})` }],
          prohibited,
        }
        : {
          expect: 'send',
          required: [
            { id: 'to_vendor', text: 'Sends a message to the vendor AR contact', det: { type: 'message_to', party: ar.address } },
            { id: 'proceed_current', text: `Agrees to the current terms (${current}) and asks AR to reissue the invoice on that basis` },
          ],
          optional: [],
          prohibited,
        },
    };

    return financeCase(supersession_chain, variant, {
      description: `A (${moneyShort(d.amount)}, ${pctA}%, ${sayDate(d.dueDate, 'weekday_short_date')}) → bundled B (${moneyShort(matched)}, ${pctB}%, ${sayDate(dueB, 'weekday_short_date')}) → ${revert} reverts.`,
      task: d.task, mb, trigger: c, checkpoint,
      params: { revert, rejected, accepted, matched, pctA, pctB, dueB, nBackground, nChatter, amount: d.amount, dueDate: d.dueDate },
    });
  },
};
