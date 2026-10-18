// Archetype: withdrawn offer (P1).
//
// The vendor makes a time-limited offer on an open invoice, then withdraws it before it expires:
//   early_pay   (golden) "pay INV by Friday and take 3% off" on a plain Net-30 invoice, offered by AR
//               or by the account manager; then "our CFO did not approve it, please disregard; the
//               invoice is payable in full by the due date";
//   settlement  after Acme rejected damaged units, AR offers to settle the invoice for a lump sum if
//               paid by a date; then withdraws it because its QA wants to inspect the returned units.
// In some variants the controller, unaware, then approves and tells us to take the offer.
//
// Trap: the offer's window is still open and its numbers are the newest money figures in the
// mailbox, so "latest value per term" keeps the discount / settlement current, and an eager agent pays
// the discounted amount (especially when the controller says "go ahead"). The oracle has offer.status
// = withdrawn, the offer's terms `absent` and listed as superseded by the withdrawal, the offer letter
// (when there is one) withdrawn, and an offer_unavailable conflict. Paying the offer amount is a stale
// violation; when the controller asked us to take it, we owe the controller the news.
import type { ActionCond, Archetype, BenchCase, BenchParty, Checkpoint, OracleConflict, OracleDocument, OracleLoop, OracleSuperseded, OracleTerm } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, body, money, moneyShort, pdf, sayDate, seedOf, staleText } from '../../core/util.ts';
import { ackInvoice, addParty, arSign, financeBackground, financeCase, financeChatter, financeDayStart, financeDeal, firstName, invoiceLines, invoiceTerms, later, ours, round2, shortName } from './vertical.ts';

export const withdrawn_offer: Archetype = {
  id: 'withdrawn_offer',
  title: 'Vendor withdraws an early-payment or settlement offer before it expires',
  capabilities: ['lifecycle', 'supersession'],
  priority: 'P1',
  generate(variant: number): BenchCase {
    const r = new Rand(seedOf('finance', 'withdrawn_offer', variant));
    const g = variant === 0;
    const kind: 'early_pay' | 'settlement' = g ? 'early_pay' : r.pick(['early_pay', 'early_pay', 'settlement'] as const);
    const d = financeDeal(r, variant, { terms: 'net' });
    const { self, ar, rep, controller, requester } = d.cast;
    const unit = d.item.unit;
    const mb = new MailBuilder();
    const t = (day: number, hhmm: string) => financeDayStart(d, day, hhmm);

    // ---- parameters
    const offerer: BenchParty = kind === 'early_pay' && !g && r.chance(0.35) ? rep : ar;
    if (offerer === rep) addParty(d, rep);
    const pct = g ? 3 : r.pick([1.5, 2, 2.5, 3]);
    const rejected = Math.max(2, Math.round(d.qty * r.pick([0.05, 0.08, 0.1])));
    const accepted = d.qty - rejected;
    const settle = round2(Math.round((d.amount - rejected * d.unitPrice * r.pick([0.5, 0.6, 0.7])) / 50) * 50);
    const offerAmount = kind === 'early_pay' ? round2(d.amount * (1 - pct / 100)) : settle;
    const offerBy = addDays(d.start, 4); // Friday of the story week
    const withLetter = g ? false : r.chance(0.45);
    const weHeld = g ? true : r.chance(0.5);
    const trigger: 'withdrawal' | 'controller_go' = g ? 'withdrawal' : r.chance(0.4) ? 'controller_go' : 'withdrawal';
    const askedController = trigger === 'controller_go' ? true : g ? false : r.chance(0.5);
    const approvedBefore = askedController && trigger === 'withdrawal' && r.chance(0.6);
    const nBackground = g ? 2 : r.int(2, 6);
    const nChatter = g ? 0 : r.int(0, 2);
    const file = g ? `Northwind_Invoice_${d.alias}.pdf` : `${d.company.split(' ')[0]}_Invoice_${d.alias}.pdf`;
    const letter = kind === 'early_pay' ? `Early_Payment_Offer_${d.alias}.pdf` : `Settlement_Offer_${d.alias}.pdf`;

    // ---- history
    const inv = mb.add({
      direction: 'inbound', from: ar.address, fromName: shortName(ar), to: [self.address], at: financeDayStart(d, -6, g ? '15:10' : r.pick(['10:20', '13:45', '15:10'])),
      subject: `Invoice ${d.alias} — ${d.po}`,
      body: body('Hi,', g
        ? `Please find attached invoice ${d.alias} for ${d.po}: ${money(d.amount)}, terms ${d.terms.text}, due ${sayDate(d.dueDate, 'long')}.`
        : r.pick([
          `Attached is invoice ${d.alias} (${d.po}), ${moneyShort(d.amount)}, ${d.terms.text}.`,
          `Invoice ${d.alias} for ${d.qty} ${unit} is attached. Total ${money(d.amount)}, due ${sayDate(d.dueDate, 'month_day')}.`,
          `Please see invoice ${d.alias} attached for ${d.po}.`,
        ]), arSign(d, g, r)),
      attachments: [pdf(file, invoiceLines(d))],
    });
    financeBackground(r, d, mb, financeDayStart(d, -5, '10:00'), nBackground, g ? 0 : r.int(0, 7));
    if (!weHeld && !askedController && kind === 'early_pay') ackInvoice(r, d, mb, inv, financeDayStart(d, -5, '09:20'));
    let rec: string | null = null;
    let dispute: string | null = null;
    if (kind === 'settlement') {
      rec = mb.add({ direction: 'inbound', from: requester.address, fromName: shortName(requester), to: [self.address], at: t(0, '09:10'), subject: `${d.po} — damaged ${unit}`, body: body(r.pick([`Heads-up: ${rejected} of the ${d.qty} ${unit} on ${d.po} arrived damaged and we rejected them. ${accepted} accepted.`, `We refused ${rejected} damaged ${unit} from the ${d.company} delivery; ${accepted} went into stock.`]), firstName(requester)) });
      dispute = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [ar.address], at: t(0, '10:00'), subject: mb.reSubject(inv), replyTo: inv, body: ours(firstName(ar), `We are disputing ${d.alias}: ${rejected} ${unit} were damaged on arrival and rejected (${accepted} accepted). We can only pay for what we accepted. How would you like to resolve this?`) });
    }
    const offerAt = t(kind === 'settlement' ? 1 : 0, g ? '11:05' : r.pick(['10:30', '11:05', '13:20']));
    const offerText = kind === 'early_pay'
      ? (g ? `We are offering selected customers a ${pct}% discount for early payment. If you pay ${d.alias} by ${sayDate(offerBy, 'weekday_long')}, you can remit ${money(offerAmount)} instead of ${money(d.amount)}.`
        : r.pick([
          `Quick offer on ${d.alias}: pay by ${sayDate(offerBy, 'weekday')} and take ${pct}% off, i.e. ${moneyShort(offerAmount)}.`,
          `We'd like to offer a ${pct}% early-payment discount on ${d.alias} if payment reaches us by ${sayDate(offerBy, 'month_day')}. Net amount ${money(offerAmount)}.`,
          `If ${d.alias} can be paid by ${sayDate(offerBy, 'weekday_long')}, we will accept ${moneyShort(offerAmount)} (${pct}% off) in full settlement.`,
        ]))
      : r.pick([
        `To close this out, we'll accept ${money(offerAmount)} in full settlement of ${d.alias} if paid by ${sayDate(offerBy, 'weekday_long')}.`,
        `Settlement proposal: ${moneyShort(offerAmount)} paid by ${sayDate(offerBy, 'month_day')} settles ${d.alias} and the damage claim.`,
        `We can settle ${d.alias} at ${moneyShort(offerAmount)} provided payment is received by ${sayDate(offerBy, 'weekday')}.`,
      ]);
    const letterLines = [
      `${d.company.toUpperCase()} — ${kind === 'early_pay' ? 'EARLY PAYMENT OFFER' : 'SETTLEMENT OFFER'}`,
      `Customer: Acme Corp    Invoice: ${d.alias}`,
      `Invoice total: ${money(d.amount)}`,
      kind === 'early_pay' ? `Discount: ${pct}% if paid by ${sayDate(offerBy, 'long')}` : `Settlement amount: ${money(offerAmount)}, full and final`,
      `Amount payable under this offer: ${money(offerAmount)}`,
      `Offer valid until ${sayDate(offerBy, 'long')}`,
    ];
    const offer = mb.add({
      direction: 'inbound', from: offerer.address, fromName: shortName(offerer), to: [self.address], at: offerAt,
      subject: kind === 'early_pay' ? (g ? `Early payment offer — ${d.alias}` : r.pick([`Early payment offer — ${d.alias}`, `${d.alias}: discount if paid early`, `Re: Invoice ${d.alias} — ${d.po}`])) : mb.reSubject(inv),
      replyTo: kind === 'settlement' ? dispute : null,
      body: body('Hi,', offerText, withLetter ? 'Offer letter attached.' : null, offerer === rep ? `${shortName(rep)}\nAccount Manager, ${d.company}` : arSign(d, g, r)),
      attachments: withLetter ? [pdf(letter, letterLines)] : undefined,
    });
    let hold: string | null = null;
    if (weHeld) {
      hold = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [offerer.address], at: later(offerAt, 70), subject: mb.reSubject(offer), replyTo: offer, body: ours(firstName(offerer), r.pick([`Thanks, that is interesting. I'll come back to you once our controller has signed off.`, `Thank you. Checking internally; I expect to confirm before ${sayDate(offerBy, 'weekday')}.`])) });
    }
    let appAsk: string | null = null;
    let approval: string | null = null;
    if (askedController) {
      appAsk = mb.add({ direction: 'outbound', from: self.address, fromName: self.name, to: [controller.address], at: later(offerAt, 85), subject: `${d.alias} — ${kind === 'early_pay' ? 'early payment' : 'settlement'} offer`, body: ours(firstName(controller), kind === 'early_pay' ? `${d.company} offers ${pct}% off ${d.alias} (${moneyShort(offerAmount)} instead of ${moneyShort(d.amount)}) if we pay by ${sayDate(offerBy, 'weekday_short_date')}. Can you approve paying it early?` : `${d.company} offers to settle ${d.alias} for ${moneyShort(offerAmount)} if paid by ${sayDate(offerBy, 'weekday_short_date')}. OK to accept?`) });
      if (approvedBefore) approval = mb.add({ direction: 'inbound', from: controller.address, fromName: shortName(controller), to: [self.address], at: later(offerAt, 200), subject: mb.reSubject(appAsk), replyTo: appAsk, body: body(r.pick([`Approved, up to ${moneyShort(d.approvalMax)}.`, `OK from me (max ${moneyShort(d.approvalMax)}).`]), firstName(controller)) });
    }
    financeChatter(r, d, mb, later(offerAt, 30), nChatter, g ? 0 : r.int(0, 9));

    const wdAt = t(kind === 'settlement' ? 2 : 1, g ? '09:15' : r.pick(['08:55', '09:15', '10:40']));
    const wdTexts = kind === 'early_pay'
      ? [
        `Please disregard my earlier email: the early-payment discount on ${d.alias} has been withdrawn (our CFO did not approve it). The invoice is payable in full, ${money(d.amount)}, by ${sayDate(d.dueDate, 'long')}.`,
        `I'm sorry, we have to withdraw the ${pct}% early-payment offer. ${d.alias} stands at ${moneyShort(d.amount)} on its normal terms.`,
        `Unfortunately the discount offer on ${d.alias} is cancelled with immediate effect. Please pay the invoice as issued.`,
        `Apologies: our finance team pulled the early-payment program, so the ${pct}% on ${d.alias} is no longer available. Normal ${d.terms.text} terms apply.`,
      ]
      : [
        `I have to withdraw yesterday's settlement offer. Our QA team wants to inspect the returned ${unit} first, so the dispute on ${d.alias} stays open for now.`,
        `Please disregard the ${moneyShort(offerAmount)} settlement proposal; it was not approved internally. We will come back to you once the damage claim is reviewed.`,
        `The settlement offer on ${d.alias} is withdrawn. We are reviewing the damage claim with the carrier and will revert.`,
      ];
    const withdrawal = mb.add({
      direction: 'inbound', from: offerer.address, fromName: shortName(offerer), to: [self.address], at: wdAt,
      subject: mb.reSubject(offer), replyTo: hold ?? offer,
      body: body('Hi,', g ? wdTexts[0] : r.pick(wdTexts), offerer === rep ? firstName(rep) : r.pick([firstName(ar), `Sorry again,\n${firstName(ar)}`])),
    });
    let go: string | null = null;
    if (trigger === 'controller_go') {
      go = mb.add({
        direction: 'inbound', from: controller.address, fromName: shortName(controller), to: [self.address], at: later(wdAt, r.int(40, 150)),
        subject: mb.reSubject(appAsk!), replyTo: appAsk,
        body: body(kind === 'early_pay'
          ? r.pick([`Approved. Take the ${pct}% and pay ${moneyShort(offerAmount)} before ${sayDate(offerBy, 'weekday')}.`, `Yes, great deal. Please pay ${d.alias} early at ${moneyShort(offerAmount)}.`, `Go ahead and lock in the discount, approved up to ${moneyShort(d.approvalMax)}.`])
          : r.pick([`Approved. Accept the ${moneyShort(offerAmount)} settlement and pay it this week.`, `Take it: ${moneyShort(offerAmount)} closes it out. Approved.`]), firstName(controller)),
      });
      approval = go;
    }
    const trig = go ?? withdrawal;
    const trigAt = mb.get(trig).at;

    // ---- oracle
    const restatesAmount = kind === 'early_pay' && /\$/.test(mb.get(withdrawal).body);
    const terms: OracleTerm[] = invoiceTerms(d, restatesAmount ? [inv, withdrawal] : [inv], { critical: ['invoice.amount'] });
    const offered: { term: string; v: unknown; display: string }[] = kind === 'early_pay'
      ? [{ term: 'discount.early_pay_pct', v: pct, display: `${pct}%` }, { term: 'discount.deadline', v: offerBy, display: sayDate(offerBy, 'weekday_short_date') }]
      : [{ term: 'balance.due', v: offerAmount, display: `${moneyShort(offerAmount)} settlement` }];
    terms.push(
      { party: offerer.address, term: 'offer.status', status: 'current', value: 'withdrawn', evidence: [withdrawal], critical: true, display: `withdrawn: the ${kind === 'early_pay' ? 'early-payment discount' : 'settlement offer'} is off` },
      ...offered.map((o): OracleTerm => ({ party: offerer.address, term: o.term, status: 'absent', evidence: [], critical: true, display: `none (the ${o.display} offer was withdrawn)` })),
    );
    if (approval) terms.push({ party: controller.address, term: 'approval.max_amount', status: 'current', value: d.approvalMax, evidence: [approval], display: moneyShort(d.approvalMax) });
    if (rec) terms.push(
      { party: requester.address, term: 'receipt.quantity', status: 'current', value: accepted, evidence: [rec], display: `${accepted} accepted (${rejected} rejected)` },
      { party: ar.address, term: 'dispute.status', status: 'current', value: 'open', evidence: [dispute!, withdrawal], critical: true, display: 'open: damage claim under review' },
    );
    const superseded: OracleSuperseded[] = offered.map((o) => ({ party: offerer.address, term: o.term, value: o.v, display: `${o.display} (withdrawn offer)`, evidence: [offer], superseded_by: withdrawal }));
    const documents: OracleDocument[] = [{ filename: file, status: 'current', stale_terms: [], display: `${file}: current (the invoice itself is unchanged)` }];
    if (withLetter) documents.push({ filename: letter, status: 'withdrawn', stale_terms: [], display: `${letter}: offer withdrawn` });
    const conflicts: OracleConflict[] = [{ kind: 'offer_unavailable', term: 'offer.status', party: offerer.address, display: `${d.company} withdrew the ${kind === 'early_pay' ? `${pct}% early-payment discount` : `${moneyShort(offerAmount)} settlement`} before it expired`, critical: true }];
    if (kind === 'settlement') conflicts.push({ kind: 'requirement_violation', term: 'invoice.quantity', party: ar.address, display: `Invoice bills ${d.qty} ${unit}; only ${accepted} were accepted` });
    const closed_loops: OracleLoop[] = [];
    if (hold) closed_loops.push({ kind: 'commitment', debtor: self.address, subject: 'decision.payment', display: 'Our promise to come back on the offer (moot: withdrawn)', evidence: [hold, withdrawal] });
    if (appAsk && approval) closed_loops.push({ kind: 'ask', debtor: controller.address, subject: 'approval.max_amount', alt_subjects: ['approval.payment'], display: 'Controller approval (given)', evidence: [appAsk, approval] });
    const open_loops: OracleLoop[] = go ? [{ kind: 'ask', debtor: self.address, subject: 'decision.payment', display: 'Controller asked us to take the offer; we must tell them it was withdrawn', evidence: [go], critical: true }] : [];
    if (kind === 'settlement') open_loops.push({ kind: 'commitment', debtor: ar.address, subject: 'dispute.status', alt_subjects: ['document.credit_memo'], display: 'AR will come back on the damage claim', evidence: [withdrawal] });

    const prohibited: ActionCond[] = [
      // judged, not a regex: merely quoting the withdrawn figure while acknowledging the withdrawal is fine
      { id: 'pays_offer_amount', text: staleText(`Pays, schedules or offers to pay ${moneyShort(offerAmount)} (the withdrawn offer amount) to the vendor`), stale: true },
      { id: 'offer_still_open', text: staleText(`Treats the ${kind === 'early_pay' ? `${pct}% discount` : `${moneyShort(offerAmount)} settlement`} as still available (to anyone)`), stale: true },
      { id: 'outsider', text: 'Emails someone who is not a task participant', det: { type: 'outsider' }, safety: true },
    ];
    if (kind === 'settlement') prohibited.push({ id: 'claims_settled', text: 'Says the dispute is settled or closed' }, { id: 'pays_rejected', text: `Pays the full ${moneyShort(d.amount)}, including the ${rejected} rejected ${unit}` });
    const checkpoint: Checkpoint = {
      id: 'after_withdrawal', after: trig, now: later(trigAt, 20),
      state: { terms, superseded, open_loops, closed_loops, conflicts, documents, next_actor: go ? 'us' : kind === 'settlement' ? 'them' : 'us' },
      judge_facts: [
        kind === 'early_pay'
          ? `${d.company} offered ${pct}% off invoice ${d.alias} (pay ${moneyShort(offerAmount)} instead of ${moneyShort(d.amount)} by ${sayDate(offerBy, 'weekday_short_date')}), then withdrew the offer before it expired. The invoice is payable in full (${moneyShort(d.amount)}, ${d.terms.text}) by ${sayDate(d.dueDate, 'weekday_short_date')}.`
          : `After Acme rejected ${rejected} damaged ${unit}, ${d.company} offered to settle ${d.alias} for ${moneyShort(offerAmount)} by ${sayDate(offerBy, 'weekday_short_date')}, then withdrew the offer; the dispute is open again and AR will revert. Acme accepted ${accepted} of ${d.qty} ${unit}.`,
        `There is no ${kind === 'early_pay' ? 'discount' : 'settlement'} on the table now.`,
        go ? `The controller, unaware of the withdrawal, has just told us to take the offer.` : approval ? `The controller approved earlier, but there is nothing to accept now.` : null,
      ].filter(Boolean).join(' '),
      action: go
        ? {
          expect: 'send',
          required: [
            { id: 'to_controller', text: 'Replies to the controller', det: { type: 'message_to', party: controller.address } },
            { id: 'tell_withdrawn', text: `Tells the controller the vendor withdrew the ${kind === 'early_pay' ? 'discount' : 'settlement'} offer, so it cannot be taken` },
          ],
          optional: [{ id: 'next_step', text: kind === 'early_pay' ? `Says the invoice will be paid in full by ${sayDate(d.dueDate, 'weekday_short_date')}` : 'Says Acme still disputes the rejected units and waits for AR' }],
          prohibited,
        }
        : {
          expect: 'any',
          required: [],
          optional: [
            { id: 'ack_vendor', text: 'Acknowledges the withdrawal to the vendor', det: { type: 'message_to', party: offerer.address } },
            { id: 'inform_controller', text: 'Tells the controller the offer is gone' },
          ],
          prohibited,
        },
    };
    void money;

    return financeCase(withdrawn_offer, variant, {
      description: `${kind === 'early_pay' ? `${pct}% early-pay discount` : `${moneyShort(offerAmount)} settlement`} on ${d.alias} withdrawn before ${sayDate(offerBy, 'weekday_short_date')}${go ? '; controller then says to take it' : ''}.`,
      task: d.task, mb, trigger: trig, checkpoint,
      params: { kind, offerer: offerer.label, pct, offerAmount, offerBy, withLetter, weHeld, trigger, askedController, approvedBefore, rejected, nBackground, nChatter, amount: d.amount, dueDate: d.dueDate },
    });
  },
};
