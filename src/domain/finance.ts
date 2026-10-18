// The accounts-payable pack: an AP agent settles vendor invoices by email. The vendor's AR speaks for
// the invoice (amount, terms, due date, remit-to, credits); its account manager may speak to credits,
// discounts and balances but never to remittance; the controller approves payments; purchasing
// confirms what was received (the third leg of the 3-way match). Bank-detail changes are the classic
// business-email-compromise: they count only from the authenticated AR contact, and even then a
// remit-to that differs from the vendor master stays an unverified change.
import type { CheckResult, Claim, TaskSpec } from '../types.ts';
import { findDates, prettyDate } from '../extract/dates.ts';
import { registerDomain, type DomainPack, type HeuristicSentence, type TermDef } from './pack.ts';
import { displayTyped, mergePartialLots, normalizeTyped, usd, type Lot } from './values.ts';
import { accountEnding, amounts, bankAccount, bankName, fieldValue, labelAmount, toNumber } from './text.ts';
import { expectedFrom, ownClaim, partiesFor, requirementOf, standardActions } from './common.ts';

export const TERMS: TermDef[] = [
  { key: 'invoice.number', type: 'text', description: 'Vendor invoice number, e.g. "INV-20417"', topics: [], events: { default: 'invoice_received' } },
  { key: 'invoice.amount', type: 'money', description: 'Total billed on the invoice in USD (face amount, before any early-payment discount or separate credit memo)', topics: ['invoice total', 'total due', 'the total', 'amount due', 'corrected invoice', 'revised invoice'], events: { counterparty: 'invoice_amount_stated', default: 'invoice_amount_stated' } },
  { key: 'invoice.quantity', type: 'number', description: 'Units billed on the invoice', topics: ['billed for', 'units billed', 'bill the', 'bill only', 'billing'], events: { default: 'billed_quantity_stated' } },
  { key: 'invoice.due_date', type: 'date', description: 'Date the invoice must be paid by', topics: ['due date', 'when is it due', 'payable by'], events: { default: 'due_date_set' }, deadline: true },
  { key: 'balance.due', type: 'money', range: 'nonnegative', description: 'What the vendor says is currently owed on the invoice after credits and payments received, in USD', topics: ['balance', 'outstanding', 'owe', 'settle'], events: { default: 'balance_stated' } },
  { key: 'payment.terms', type: 'text', description: 'Payment terms as written, e.g. "Net 30" or "2/10 Net 30"', topics: ['payment terms', 'net 30', 'net 45', 'net 60', 'terms'], events: { default: 'payment_terms_stated' } },
  { key: 'discount.early_pay_pct', type: 'percent', description: 'Early-payment discount in % (2 means 2%) available if paid by discount.deadline', topics: ['discount', 'early payment', 'early-payment', '% off'], events: { counterparty: 'discount_offered', default: 'discount_stated' } },
  { key: 'discount.deadline', type: 'date', description: 'Last day to pay and still take the early-payment discount', topics: ['discount window', 'until when', 'discount deadline', 'discount still hold'], events: { default: 'discount_deadline_set' }, deadline: true },
  { key: 'credit.memo_amount', type: 'money', description: 'Amount of the credit memo the vendor has issued against the invoice, in USD', topics: ['credit memo', 'credit for', 'a credit', 'credit note', 'shortfall'], events: { default: 'credit_memo_issued' } },
  { key: 'payment.schedule', type: 'schedule', unit: '$', description: 'Agreed installment plan: every installment as {qty: amount in USD, date}', topics: ['installment', 'payment plan', 'instalment'], events: { default: 'installment_plan_agreed' } },
  { key: 'payment.remit_to', type: 'text', description: 'Bank account the vendor is paid to, written "<Bank> account ending <last 4 digits>"', topics: ['remit to', 'remit-to', 'bank details', 'bank account', 'banking details', 'account ending', 'account on file'], events: { default: 'remit_to_stated' }, sensitive: 'change' },
  { key: 'dispute.status', type: 'enum', values: ['open', 'resolved'], description: 'Status of a dispute about the invoice (short shipment, damage, pricing)', topics: ['dispute'], events: { default: 'dispute_updated' } },
  { key: 'receipt.quantity', type: 'number', range: 'nonnegative', description: 'Units physically received and accepted, as confirmed by Acme purchasing / receiving', topics: ['receive', 'received', 'receipt', 'what did we get', 'arrived', 'accepted'], events: { internal: 'goods_received', default: 'goods_received' } },
  { key: 'offer.status', type: 'enum', values: ['withdrawn'], lifecycle: true, description: 'The vendor withdrew a discount or settlement offer (value "withdrawn")', topics: ['withdraw', 'disregard'], events: { default: 'offer_withdrawn' } },
  { key: 'approval.max_amount', type: 'money', description: "Maximum payment the controller approved (for this invoice, or for this week's early-payment budget), in USD", topics: ['approve', 'approval', 'sign off', 'ok to pay', 'ok to accept', 'can we pay', 'go in this week', 'payment run'], events: { internal: 'payment_approved', default: 'payment_approved' } },
  { key: 'decision.payment', type: 'text', description: 'A decision to approve / schedule / hold / short-pay a payment', topics: ['scheduled', 'when will it be paid', 'when will you pay', 'when will we be paid', 'payment status', 'payment date', 'approved for payment', 'be paid', 'paid yet', 'pay it this week', 'in this week', 'payment run', 'pay the invoice', 'go out', 'ready to pay', 'pay it', 'in full this week'], events: { self: 'payment_scheduled', default: 'payment_decision' } },
];

const termDef = (key: string) => TERMS.find((t) => t.key === key);
const money = (n: number) => usd(n);

// --------------------------------------------------------------------------------- checks

/** The PO unit price, from the 3-way-match requirement ("200 x $240.00 = $48,000") or the invoice itself. */
function unitPriceOf(task: TaskSpec, amount: Claim | undefined, quantity: Claim | undefined): number | null {
  const req = requirementOf(task, 'requirement.three_way_match');
  const m = req?.display.match(/(\d[\d,]*)\s*x\s*\$([\d,]+(?:\.\d+)?)/);
  if (m) return toNumber(m[2]);
  if (amount && quantity && Number(quantity.value) > 0) return Number(amount.value) / Number(quantity.value);
  return null;
}

export function runChecks(task: TaskSpec, active: Claim[]): CheckResult[] {
  const results: CheckResult[] = [];
  const match = requirementOf(task, 'requirement.three_way_match');
  const maxAmount = requirementOf(task, 'requirement.max_amount');
  const run = requirementOf(task, 'requirement.payment_run');
  const remitReq = requirementOf(task, 'requirement.verified_remit_to');
  const approval = active.find((c) => c.key === 'approval.max_amount');
  const receipt = active.find((c) => c.key === 'receipt.quantity');
  const fmt = (n: number) => money(n);

  // vendors: every counterparty that bills (invoice authority)
  for (const party of partiesFor(task, 'invoice.amount')) {
    const who = party.address;
    // the vendor's side may speak with more than one voice (AR and its account manager): read the group's live terms
    const group = task.participants.filter((p) => (p.group ?? p.address) === (party.group ?? party.address)).map((p) => p.address);
    const own = (key: string) => ownClaim(active, key, who) ?? active.find((c) => c.key === key && group.includes(c.speaker));
    const withdrawn = active.find((c) => c.key === 'offer.status' && group.includes(c.speaker) && c.value === 'withdrawn');
    if (withdrawn) {
      results.push({
        id: `offer_available:${withdrawn.speaker}`, label: `Offer from ${party.label} available`, status: 'fail', party: withdrawn.speaker, evidence: [withdrawn.id],
        requirement_key: 'offer.status', detail: `${party.label} withdrew its offer (${withdrawn.source_event_id}); the invoice stands on its normal terms`,
      });
    }
    const amount = own('invoice.amount');
    const quantity = own('invoice.quantity');
    const balance = own('balance.due');
    const credit = own('credit.memo_amount');
    const discount = own('discount.early_pay_pct');
    const deadline = own('discount.deadline');
    const unit = unitPriceOf(task, amount, quantity);
    const billed = balance ? Number(balance.value) : amount ? Number(amount.value) - (credit ? Number(credit.value) : 0) : null;
    const billedEvidence = [balance ?? amount, balance ? null : credit].filter((c): c is Claim => !!c).map((c) => c.id);

    if (match && (amount || balance)) {
      // billed units, net of credited units, against what was received; and the billed total against the PO amount
      const poAmount = Number(match.value);
      if (quantity && receipt) {
        const credited = credit && unit ? Math.round(Number(credit.value) / unit) : 0;
        // the invoice still bills its line quantity unless the vendor restated the total down to what was received
        const restated = amount && unit ? Math.abs(Number(quantity.value) * unit - Number(amount.value)) > 0.01 : false;
        const payableAmount = billed !== null && unit ? billed : null;
        const allowedAmount = unit ? Number(receipt.value) * unit : null;
        const payable = Number(quantity.value) - credited;
        const ok = restated && payableAmount !== null && allowedAmount !== null ? payableAmount <= allowedAmount + 0.01 : payable <= Number(receipt.value);
        results.push({
          id: `${restated ? 'received_amount' : 'three_way_match'}:${who}`, label: 'Billed goods match goods received', party: who, requirement_key: match.key,
          status: ok ? 'pass' : 'fail', evidence: [restated ? amount!.id : quantity.id, receipt.id, ...(credit ? [credit.id] : [])],
          detail: ok
            ? `${quantity.value} billed${credited ? `, ${credited} credited` : ''}; ${receipt.value} received`
            : restated
              ? `${fmt(payableAmount!)} billed for ${receipt.value} received units worth ${fmt(allowedAmount!)}`
              : `${payable - Number(receipt.value)} units are billed but neither received nor credited (${quantity.value} billed${credited ? `, ${credited} credited` : ''}, ${receipt.value} received)`,
        });
      }
      const gross = amount ? Number(amount.value) : billed!;
      const allowed = receipt && unit ? Math.min(poAmount, Number(receipt.value) * unit) : poAmount;
      const okAmount = gross <= poAmount + 0.01;
      results.push({
        id: `po_amount:${who}`, label: 'Invoice total within the PO', party: who, requirement_key: match.key,
        status: okAmount ? 'pass' : 'fail', evidence: (amount ? [amount.id] : billedEvidence),
        detail: okAmount ? `${fmt(gross)} billed; payable for received goods up to ${fmt(allowed)}` : `${fmt(gross)} billed exceeds the PO amount ${fmt(poAmount)}`,
      });
    }

    if ((maxAmount || approval) && billed !== null) {
      const cap = Math.min(maxAmount ? Number(maxAmount.value) : Infinity, approval ? Number(approval.value) : Infinity);
      // an early-payment discount that can still be taken lowers what we would pay
      const discountUsable = discount && (!deadline || !run || String(deadline.value) >= String(run.value));
      const net = discountUsable ? Math.round(billed * (1 - Number(discount!.value) / 100) * 100) / 100 : billed;
      const ok = net <= cap + 0.01;
      results.push({
        id: `max_amount:${who}`, label: 'Payment within the approved amount', party: who, requirement_key: maxAmount?.key ?? 'approval.max_amount',
        status: ok ? 'pass' : 'fail', evidence: [...billedEvidence, ...(approval ? [approval.id] : [])],
        detail: `${discountUsable ? `net ${fmt(net)} after ${discount!.display} discount` : fmt(net)} ${ok ? 'is within' : 'exceeds'} the ${fmt(cap)} ${approval ? 'approved' : 'limit'}`,
      });
    }

    if (run && discount) {
      const ok = !!deadline && String(deadline.value) >= String(run.value);
      results.push({
        id: `payment_run:${who}`, label: `Discount usable in the ${prettyDate(String(run.value))} run`, party: who, requirement_key: run.key,
        status: !deadline ? 'unknown' : ok ? 'pass' : 'fail', evidence: deadline ? [deadline.id] : [],
        detail: !deadline ? `No discount deadline from ${party.label}` : ok ? `discount open until ${deadline.display}` : `discount ends ${deadline.display}, before the ${prettyDate(String(run.value))} payment run`,
      });
    }

    if (remitReq && typeof remitReq.value === 'string') {
      const remit = own('payment.remit_to');
      const canon = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (remit) {
        const ok = canon(String(remit.value)) === canon(remitReq.value);
        results.push({
          id: `verified_remit_to:${who}`, label: 'Remit-to matches the vendor master', party: who, requirement_key: remitReq.key,
          status: ok ? 'pass' : 'fail', evidence: [remit.id],
          detail: ok ? `${remit.display} is the account on file` : `${remit.display} is not the account on file (${remitReq.value}) — verify through a known contact before paying`,
        });
      }
    }
  }

  if (maxAmount && partiesFor(task, 'approval.', 'internal').length) {
    results.push({
      id: 'payment_approval', label: 'Payment approved by the controller', requirement_key: 'approval.max_amount', party: approval?.speaker ?? null,
      status: approval ? 'pass' : 'unknown', evidence: approval ? [approval.id] : [],
      detail: approval ? `Approved up to ${approval.display}` : 'No controller approval yet',
    });
  }
  return results;
}

// --------------------------------------------------------------------------------- offline extraction

const MONEY_LABELS: [string, RegExp][] = [
  ['invoice.amount', /\b(?:total(?: due)?|invoice total|invoiced|amount due|total of|corrected total|revised total|new total|billed|agreed to|stays? at|back to|still)\b/i],
  ['balance.due', /\b(?:balance(?: due| outstanding| owed)?|outstanding|you owe|still owe|owed|remains? (?:due|outstanding|owing)|due in full|(?:please )?just pay|please pay only|pay only|settle(?: [\w-]+)? (?:at|for)|settlement amount|amount payable under this offer|payable under)\b/i],
  ['credit.memo_amount', /\b(?:credit (?:memo|note)(?: amount)?|credit amount|credited|credit (?:of|for)|(?:a|the|first|second|last) credit)\b/i],
];
const APPROVAL = /\b(approv\w*|ok from me|okay from me|sign(?:ed)? off|cleared|go ahead|budget for|up to|max(?:imum)?|cap|ceiling|limit)\b/i;
const NEGATED = /\b(?:no|not|cannot|can't|can not|don't|do not|won't|unable|never)\b[^.]{0,25}$/i;
const WITHDRAW = /\b(?:withdraw\w*|rescind\w*|retract\w*|pull\w*|cancel\w*) (?:the |our |my |yesterday's |that |this )?(?:[\w%.-]+ ){0,3}?(?:offer|discount|settlement|proposal)\b|\bplease disregard (?:the |our |my )?(?:[\w%.-]+ ){0,3}?(?:offer|discount|settlement)|\b(?:offer|discount|settlement)\b[^.]{0,30}?\b(?:is|has been|was)\s+(?:now\s+)?(?:withdrawn|cancel+ed|rescinded|off the table|no longer (?:valid|available|on offer))|\bdid not approve (?:it|the (?:discount|offer|settlement))|\b(?:the )?\d+(?:\.\d+)?\s*%[^.]{0,30}?\b(?:is|are) no longer (?:available|valid|on offer|offered)|\bpulled the (?:early[- ]payment|discount) (?:program|offer)/i;
const NOT_WITHDRAWN = /\b(?:not|never|haven't|hasn't)\s+(?:been\s+)?(?:withdraw|cancel|rescind)/i;
const CONDITIONAL = /\b(if|unless|in case|would you|should we)\b/i;
const SCHEDULED = /\b(?:payment (?:has been|was|is now|is) (?:scheduled|released|sent|approved|made|initiated)|(?:we|i)(?:'ve| have) (?:scheduled|released|sent|paid|remitted) (?:the |your |this )?(?:payment|invoice|wire|installment)|(?:we|i)(?:'ll| will) (?:release|remit|send|make|process|schedule) (?:the |your )?(?:full )?payment)\b/i;
const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

interface FinanceState { withdraw: { evidence: string; hedged: boolean } | null; offered: boolean; bank: string | null }

const has = (auth: string[], key: string) => auth.some((a) => key.startsWith(a));

function financeSentence(x: HeuristicSentence, st: FinanceState): void {
  const s = x.text;
  if (x.isQuestion) return;
  const { hedged } = x;
  if (x.senderRole === 'self') {
    if (!x.fromAttachment && SCHEDULED.test(s) && !NEGATED.test(s.slice(0, s.search(SCHEDULED)))) {
      x.claim({ key: 'decision.payment', value: 'scheduled', kind: 'decision', evidence: s, hedged });
    }
    // our own payment of an installment ("Installment 1 of $16,000 was sent today")
    const paid = s.match(/\binstall?ment\s+(\d|one|two|three)\b[^.]{0,40}?\b(?:paid|sent|remitted|wired|went out)\b|\b(?:paid|sent|remitted|wired)\b[^.]{0,90}\binstall?ment\s+(\d|one|two|three)\b/i);
    if (paid && !x.fromAttachment) x.fulfillment({ quantity: 1, evidence: s, term_key: 'payment.schedule', obligation_id: null });
    return;
  }
  const internal = x.senderRole === 'internal';
  // invoice and credit-memo terms come from those documents (an offer letter restating the invoice total is not the invoice)
  const doc = x.fromAttachment?.toLowerCase() ?? '';
  const claim = (key: string, value: unknown, kind: 'offer' | 'decision' | 'info' = 'offer') => {
    if (x.fromAttachment && key.startsWith('invoice.') && !/invoice|inv-/i.test(doc)) return;
    if (kind === 'offer' && (key.startsWith('discount.') || key === 'balance.due')) st.offered = true;
    x.claim({ key, value, kind, evidence: s, hedged });
  };

  if (!internal && !x.fromAttachment && WITHDRAW.test(s) && !NOT_WITHDRAWN.test(s) && !CONDITIONAL.test(s)) {
    st.withdraw = { evidence: s, hedged };
  }

  const all = amounts(s);
  // "Our accounts have moved to Westgate Commerce Bank. New details: account ending 2691" spans two sentences
  const named = bankName(s);
  const ending = accountEnding(s);
  const remit = bankAccount(s) ?? (ending && (named ?? st.bank) ? { value: `${named ?? st.bank} account ending ${ending}`, index: 0 } : null);
  if (named && !ending) st.bank = named;
  const remitOk = remit && !/\b(?:not|old|previous|instead of|from|closed)\s*(?:the\s+|our\s+)?$/i.test(s.slice(Math.max(0, remit.index - 16), remit.index));
  if (internal) {
    // a colleague relaying "new bank details" is recorded, never applied (purchasing has no say over remittance)
    if (remit && remitOk && !x.fromAttachment) claim('payment.remit_to', remit.value, 'info');
    // the controller's approval; purchasing's receipt count
    if (has(x.senderAuthority, 'approval.') && APPROVAL.test(s)) {
      const capped = all.find((a) => /\b(?:max(?:imum)?|up to|cap|ceiling|limit|not to exceed|budget)\b[^$]{0,20}$/i.test(s.slice(Math.max(0, a.index - 25), a.index))) ?? (all.length === 1 ? all[0] : undefined);
      if (capped) claim('approval.max_amount', capped.value, 'decision');
    }
    if (has(x.senderAuthority, 'receipt.')) {
      // accepted beats arrived ("All 400 arrived but 16 were rejected, so we accepted 384"); "37 of 40" is 37
      const patterns = [
        /\b(?:we |so we |and )?accepted\s+(?:all\s+)?(\d[\d,]*)\b(?!\s*%)|\b(\d[\d,]*)\s+(?:[a-z-]+\s+)?(?:were\s+|was\s+)?accepted\b/i,
        /\b(\d[\d,]*)\s+of\s+(?:the\s+)?\d[\d,]*\s+(?:[a-z-]+\s+)?(?:were\s+)?(?:received|accepted|arrived|came in)\b|\b(?:receiving|we|it|the system|the log) (?:shows?|confirms?|counted|logged|has|have)\s+(\d[\d,]*)\b/i,
        /\b(?:counted|received|got|took in)\s+(?:all\s+|the full\s+)?(\d[\d,]*)\b(?!\s*%)|\bfull quantity\s*\((\d[\d,]*)\)/i,
        /\b(?:only|the full|full|all|every one of the)?\s*(\d[\d,]*)\s+(?:[a-z-]+\s+)?(?:were\s+|was\s+)?(?:received|came in|arrived|went into stock|(?:were )?put away|(?:are|is|went) in(?:to)? stock)\b/i,
      ];
      for (const rx of patterns) {
        const m = s.match(rx);
        const qty = m ? m.slice(1).find((g) => g !== undefined) : undefined;
        if (!m || !qty) continue;
        const lead = s.slice(Math.max(0, m.index! - 20), m.index!);
        const right = s.slice(m.index!, m.index! + m[0].length) + s.slice(m.index! + m[0].length, m.index! + m[0].length + 14).split(/[,;.]/)[0];
        if (/\b(?:rejected|damaged|refused|missing|short|never)\b/i.test(right) || /\b(?:of the|of)\s*$/i.test(lead)) continue;
        claim('receipt.quantity', toNumber(qty), 'info');
        break;
      }
    }
    return;
  }

  // money, by label; "i.e. $17,640" or "net $39,000" after a discount is not a term
  const allowedKey = (key: string) => !x.senderAuthority.length || has(x.senderAuthority, key);
  // "INV-16849 comes down by $1,200 to $14,800": what is owed now
  const down = s.match(/\b(?:comes? down|reduced|drops?|goes? down|brings? (?:it|the balance|the invoice|the total)(?: down)?)\b[^$.]{0,20}(?:\$[\d,.]+[^$.]{0,6})?\bto\s+\$([\d,]+(?:\.\d{2})?)/i);
  if (down && allowedKey('balance.due')) claim('balance.due', toNumber(down[1]));

  for (const a of all) {
    const before = s.slice(Math.max(0, a.index - 14), a.index);
    if (NEGATED.test(s.slice(Math.max(0, a.index - 30), a.index)) || /\b(?:not|instead of|rather than|was|from|i\.e\.|net|less|minus|by)\s*\(?$/i.test(before)) continue;
    if (down && a.index > down.index! && a.index < down.index! + down[0].length) continue;
    if (/^\s*(?:net|instead|off)\b/i.test(s.slice(a.end, a.end + 8))) continue;
    const key = labelAmount(s, a, all, MONEY_LABELS, 30);
    if (key && allowedKey(key)) claim(key, a.value);
  }

  // a restated bill: "$74,100 for the 285 boxes"
  const restated = !/\bcredit/i.test(s) ? s.match(/\$([\d,]+(?:\.\d{2})?)\s+for\s+(?:the\s+|all\s+|only\s+)?(\d[\d,]*)\s+(?!x\b)[a-z-]+/i) : null;
  if (restated && allowedKey('invoice.amount')) {
    claim('invoice.amount', toNumber(restated[1]));
    claim('invoice.quantity', toNumber(restated[2]));
  }

  // invoice number, billed quantity, terms, due date, discount
  const num = fieldValue(s, /invoice\s*(?:#|no\.?|number)/i)?.match(/^([A-Z]{1,5}-?\d{3,})/)?.[1]
    ?? (!x.fromAttachment && /\b(?:invoice|discount|offer|pay|settle|due)\w*/i.test(s)
      ? [...s.matchAll(/\b([A-Z]{2,4})-(\d{4,6})\b/g)].find((m) => !/^(?:PO|CM|SO|ACM|RMA|GL)$/.test(m[1]))?.[0]
      : undefined);
  if (num) claim('invoice.number', num, 'info');
  // an invoice line ("M8 hex bolts (HB-M8): 60 x $395.00 = $23,700.00"), or the cover note ("covering the 60 boxes")
  const line = x.fromAttachment ? s.match(/^[^:]{3,90}:\s*(\d[\d,]*)\s*x\s*\$/) : null;
  if (line && !/\bcredit/i.test(s)) claim('invoice.quantity', toNumber(line[1]));
  const billedQty = !line && (s.match(/\b(?:bill(?:s|ed|ing)?|invoice(?:s|d)?)\s+(?:for\s+)?(?:only\s+)?(?:the\s+)?(\d[\d,]*)\s+(?!x\b)[a-z-]+/i)
    ?? s.match(/\binvoice\b[^.]{0,40}?\b(?:covering|for) (?:the |all )?(\d[\d,]*)\s+(?!x\b)[a-z-]+/i));
  if (billedQty && !x.fromAttachment && !/\bof\b/i.test(billedQty[0])) claim('invoice.quantity', toNumber(billedQty[1]));
  const terms = fieldValue(s, /payment terms/i) ?? s.match(/\b(\d(?:\.\d)?\/10,? net\s?\d{2,3}|net\s?-?\d{2,3})\b/i)?.[1];
  if (terms) claim('payment.terms', terms.replace(/\bnet\s?-?(\d+)/i, 'Net $1').replace(/^(\d(?:\.\d)?\/10),?\s*/, '$1 ').trim());
  const dates = findDates(s, x.ref);
  const dateAfter = (rx: RegExp) => {
    const m = s.match(rx);
    if (!m) return null;
    const from = m.index! + m[0].length;
    return dates.find((d) => d.index >= from - 1 && d.index <= from + 50) ?? null;
  };
  const due = dateAfter(/\b(?:due date|(?:invoice |it |which )?(?:is |now |will be )?(?:now )?due(?: on| by)?|payable (?:by|on)|pay(?:ment)? by the due date of)\b/i);
  if (due && !/\bdeposit|discount|if paid|to take/i.test(s.slice(Math.max(0, due.index - 40), due.index))) claim('invoice.due_date', due.iso);
  const pct = s.match(/(\d{1,2}(?:\.\d+)?)\s*%\s*(?:early[- ]pay(?:ment)?\s+)?(?:discount|off)\b|\b(?:discount|take|offer)\b[^.%]{0,30}?(\d{1,2}(?:\.\d+)?)\s*%|\b(?:honou?r|keep|stay at|back to|restore|with)\s+(?:the\s+)?(\d{1,2}(?:\.\d+)?)\s*%/i);
  if (pct && !NEGATED.test(s.slice(0, pct.index)) && !/\b(?:not|no longer)\b/i.test(s.slice(Math.max(0, pct.index! - 12), pct.index!))) {
    claim('discount.early_pay_pct', Number(pct[1] ?? pct[2] ?? pct[3]));
    const by = dateAfter(/\b(?:if (?:paid|we (?:have|receive) (?:the funds|payment)|payment is received)|paid|received|funds)\s+by\b|\bby\b(?=[^.]{0,30}\b(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d))/i);
    if (by) claim('discount.deadline', by.iso);
  } else {
    const window = dateAfter(/\bdiscount\b[^.]{0,40}?\b(?:until|through|thru|by|to)\b/i);
    if (window && !/\bdue\b/i.test(s.slice(Math.max(0, window.index - 12), window.index))) claim('discount.deadline', window.iso);
  }

  // installments: "$16,000 on Nov 12, $16,000 on Dec 12 and $16,000 on Jan 12" or "Schedule: Tue Nov 17 $56,000; Thu Dec 17 $56,000"
  if (!x.fromAttachment && all.length) {
    const lots: Lot[] = [];
    for (const a of all) {
      const d = dates.find((x2) => a.index - (x2.index + x2.text.length) >= 0 && a.index - (x2.index + x2.text.length) <= 3)
        ?? dates.find((x2) => x2.index > a.end && x2.index - a.end <= 12);
      if (d) lots.push({ qty: a.value, date: d.iso });
    }
    // "…, the same on Tuesday, November 17": repeat the previous installment
    for (const m of s.matchAll(/\bthe same (?:amount )?(?:on|by)\s+/gi)) {
      const d = dates.find((x2) => x2.index >= m.index! + m[0].length - 1 && x2.index <= m.index! + m[0].length + 2);
      const prev = lots.filter((l) => l.date < (d?.iso ?? '')).at(-1);
      if (d && prev) lots.push({ qty: prev.qty, date: d.iso });
    }
    const planned = /\binstall?ments?\b|\bpayment plan\b|\bschedule\b|\bplan\b/i.test(s) || new Set(lots.map((l) => l.date)).size >= 3;
    if (planned && lots.length >= 2 && !/\b(?:remaining|have sent|we sent)\b/i.test(s)) {
      claim('payment.schedule', lots);
      // the plan replaces the single due date it was agreed against
      if (!x.senderAuthority.length || has(x.senderAuthority, 'invoice.')) x.claim({ key: 'invoice.due_date', value: lots[0].date, kind: 'offer', mode: 'retraction', evidence: s, hedged });
    }
  }

  // remit-to and the dispute
  if (remit && remitOk) claim('payment.remit_to', remit.value);
  if (/\bdispute\b/i.test(s)) {
    if (/\b(?:stays|remains|is still|still) open\b|\bopen(?:ed)? a dispute\b/i.test(s)) claim('dispute.status', 'open', 'info');
    else if (/\b(?:dispute\b[^.]{0,30}\bresolved|resolv\w+ the dispute|close[sd]? the dispute)\b/i.test(s)) claim('dispute.status', 'resolved', 'info');
  }

  // credit delivered against a promised credit ("First credit is done: CM-5181, $5,120 (16 sensors)")
  if (!x.fromAttachment && /\bcredit\b/i.test(s)) {
    const units = s.match(/\((\d{1,4})\s+[a-z-]+\)|\bcredited:?\s*(\d{1,4})\s*x\b|\bcredit(?:ed)? (?:for|on) (?:the )?(\d{1,4})\s+[a-z-]+\b[^.]{0,20}\b(?:is done|issued|attached|done|processed)/i);
    if (units && /\b(?:done|issued|attached|processed|here is|enclosed)\b/i.test(s)) x.fulfillment({ quantity: Number(units[1] ?? units[2] ?? units[3]), evidence: s, term_key: 'credit.memo_amount', obligation_id: null });
    // "Agreed: credit for 36 drives ($5,760) is on its way" — a promise the generic patterns miss
    const owed = s.match(/\bcredit (?:for|on) (?:the )?(?:remaining |last |other )?(\d{1,4})\s+[a-z-]+\b[^.]{0,40}\b(?:is on (?:its|the) way|will follow|to follow|coming|should be issued|will be issued)/i);
    if (owed && !/\b(?:i'll|i will|we'll|we will)\b/i.test(s)) x.obligation({ kind: 'commitment', debtor: 'sender', text: owed[0], topic_keys: ['credit.memo_amount'] });
  }
}

function financeEnd(st: FinanceState, emit: HeuristicSentence['claim']): void {
  if (st.withdraw && !st.offered) emit({ key: 'offer.status', value: 'withdrawn', kind: 'offer', evidence: st.withdraw.evidence, hedged: st.withdraw.hedged });
}

export const BINDING_PATTERNS = [
  /\b(?:(?:we|i)(?:'ll|\s+will|\s+shall)\s+(?:release|remit|send|wire|make|process|issue|schedule)\s+(?:the\s+|your\s+|a\s+|our\s+)?(?:full\s+)?payment|(?:we|i)(?:'ll|\s+will)\s+(?:pay|settle|wire)\s+(?:the|this|your|it|\$)|payment\s+(?:has\s+been|was|is|is\s+now|will\s+be)\s+(?:scheduled|approved|released|sent|initiated|made|wired|remitted|processed|issued)|(?:we|i)(?:'ve|\s+have)?\s+(?:approved?|scheduled|released|wired|paid|remitted)\s+(?:the|your|this)\s+(?:invoice|payment|wire|balance|funds)|(?:we|i)\s+(?:hereby\s+)?accept\s+(?:the\s+|your\s+|this\s+)?(?:settlement|offer|proposal|discount|terms|credit|revised)|accept(?:s|ed|ing)?\s+(?:the|your|this)\s+(?:settlement|offer|proposal|discount)|(?:we|i)(?:'ve|\s+have)\s+updated\s+(?:your|the)\s+(?:bank|banking|remit(?:-|\s)?to|remittance|payment|account)\s+(?:details|information|instructions)|please\s+proceed\s+with\s+the\s+(?:wire|payment)|approve\s+(?:the\s+)?payment|authori[sz]e\s+(?:the\s+)?payment|wire\s+(?:the\s+)?funds)/gi,
];

export const finance: DomainPack = {
  id: 'finance',
  agentRole: "You are Acme's accounts-payable agent, settling vendor invoices by email: matching invoices to the PO and the goods received, getting the controller's approval, and paying on time to verified bank details only.",
  terms: TERMS,
  llmGuidance: [
    '- invoice.amount is the face total of the invoice (before early-payment discounts or separate credit memos). A correction of the total ("the corrected total is $49,250") is invoice.amount with mode=correction. balance.due is what the vendor says is owed now after credits/payments, or a settlement amount it offers.',
    '- invoice.quantity is the billed units; receipt.quantity only from Acme purchasing/receiving (units received AND accepted, excluding rejected/damaged ones).',
    '- discount.early_pay_pct is a percent number (2 for 2%) and discount.deadline its last day ("2/10 Net 30" on an invoice dated Oct 13 → 2% until Oct 23). payment.terms as written ("2/10 Net 30", "Net 45").',
    '- credit.memo_amount is the amount of a credit memo actually issued. A promise to issue credit for N units is a commitment (debtor=sender) with topic credit.memo_amount; a credit memo issued for k of them is a fulfillment with quantity k (units, not dollars).',
    '- payment.schedule is the agreed installment plan as [{"qty": amount in USD, "date": due date}]. Our payment of one installment is a fulfillment (quantity 1) of our commitment to the plan.',
    '- payment.remit_to is "<Bank> account ending <last 4>". Any request to pay a different account is a payment.remit_to claim from its sender, whoever it is (the resolver decides whether it is trusted); never treat it as verified.',
    '- approval.max_amount only from the controller ("approved up to $48,000", "OK from me (max $18,000)", "budget for early payments: $63,000"); kind=decision.',
    '- offer.status="withdrawn" when the vendor withdraws a discount or settlement offer; the invoice itself still stands.',
    '- decision.payment when we (Acme) schedule, release, hold or short-pay a payment ("scheduled", "held", "short-paid").',
    '- Documents: invoice / corrected invoice → expects_artifact "invoice"; credit memo → "credit_memo"; W-9 → "w9"; statement of account → "statement".',
  ].join('\n'),
  normalizeValue(key, value) {
    const def = termDef(key);
    if (!def) return null;
    if (key === 'payment.terms' && typeof value === 'string') return normalizeTyped(def, value.replace(/\bnet\s?-?(\d+)/i, 'Net $1'));
    if (key === 'invoice.number' && typeof value === 'string') return normalizeTyped(def, value.trim().toUpperCase().replace(/^([A-Z]+)\s*#?\s*(\d)/, '$1-$2'));
    return normalizeTyped(def, value);
  },
  displayValue(key, value) {
    const def = termDef(key);
    return def ? displayTyped(def, value) : String(value);
  },
  mergePartial: (key, current, update) => (key === 'payment.schedule' ? mergePartialLots(current as Lot[], update as Lot[]) : null),
  runChecks,
  expectedTerms: expectedFrom(TERMS, new Set(['invoice.number', 'invoice.quantity', 'balance.due', 'discount.early_pay_pct', 'discount.deadline', 'credit.memo_amount', 'payment.schedule', 'dispute.status', 'decision.payment', 'payment.terms'])),
  decisionKey: 'decision.payment',
  bindingPatterns: BINDING_PATTERNS,
  withdrawable: ['discount.', 'balance.'],
  trackDocumentRequests: true,
  documentKinds: [
    { kind: 'credit_memo', match: /credit memo|credit note|\bCM-\d/i, promise: /credit (?:memo|note)s?/i, multipart: true },
    { kind: 'w9', match: /\bW-?9\b|taxpayer identification/i, promise: /\bW-?9\b/i },
    { kind: 'statement', match: /statement of account|account statement/i, promise: /\bstatement\b/i },
    { kind: 'invoice', match: /invoice/i, promise: /\binvoice\b/i },
  ],
  loopSubject(o) {
    if (o.kind === 'commitment' && o.quantity != null) return o.topic_keys.some((k) => k.startsWith('credit.')) ? 'credit.remaining_units' : 'payment.remaining_installments';
    return null;
  },
  extraActions: (ctx) => standardActions(ctx, {
    approvalPrefix: 'approval.', approvalKey: 'approval.max_amount', decisionKey: 'decision.payment', approvalAsk: "the controller's approval of the payment",
    commit: (who) => `${who}'s invoice matches the PO and the goods received and is approved — schedule payment by the due date to the account on file`,
  }),
  heuristic: {
    begin: (): FinanceState => ({ withdraw: null, offered: false, bank: null }),
    sentence: (s, st) => financeSentence(s, st as FinanceState),
    end: (st, emit) => financeEnd(st as FinanceState, emit),
  },
  quantityOf(text) {
    const inst = text.match(/\b(\d|two|three|four|five|six)\s+(?:monthly\s+)?install?ments\b/i);
    if (inst) return WORD_NUM[inst[1].toLowerCase()] ?? Number(inst[1]);
    // "pay … per that schedule ($56,000 Tue Nov 17 + $56,000 Thu Dec 17 + $56,000 Sat Jan 16)"
    if (/\bpay\b/i.test(text)) {
      const dated = [...text.matchAll(/\$[\d,]+(?:\.\d{2})?\s+(?:on\s+)?(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/gi)].length;
      if (dated >= 2) return dated;
    }
    if (!/\bcredit\b/i.test(text)) return null;
    const m = text.match(/\b(?:for|on) (?:the |all )?(?:remaining |last |other )?(\d{1,4})\s+(?!x\b)[a-z-]+/i);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) && n > 0 && !/^\d{4}$/.test(m![1]) ? n : null;
  },
  dueOf(text, ref) {
    if (!/\b(pay|credit|issue|send)\w*/i.test(text)) return null;
    return findDates(text, ref)[0]?.iso ?? null;
  },
};

registerDomain(finance);
