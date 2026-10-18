// Finance / accounts payable: Acme's AP agent settles a vendor's invoice by email. The counterparty is
// the vendor's AR / billing specialist (with the vendor's account manager in the same group); Acme's
// controller approves payments and Acme purchasing confirms what was received (the third leg of the
// 3-way match). The term keys are the benchmark's own definition of what an experienced AP manager
// tracks; nothing here is imported from the engine.
import type { BenchCase, BenchParty, BenchTask, Capability, Checkpoint, Split, VerticalSpec } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, at, body, money, moneyShort, sayDate, type DateStyle } from '../../core/util.ts';

export const finance: VerticalSpec = {
  id: 'finance',
  name: 'Accounts payable & vendor invoicing',
  agentRole: "You are Acme's accounts-payable agent, settling vendor invoices by email: matching invoices to the PO and the goods received, getting the controller's approval, and paying on time to verified bank details only.",
  continuityDomain: 'finance',
  terms: [
    { key: 'invoice.number', type: 'text', description: 'Vendor invoice number, e.g. "INV-20417"', setBy: ['counterparty'] },
    { key: 'invoice.amount', type: 'money', description: 'Total billed on the invoice in USD (face amount, before any early-payment discount or separate credit memo)', setBy: ['counterparty'] },
    { key: 'invoice.quantity', type: 'number', description: 'Units billed on the invoice', setBy: ['counterparty'] },
    { key: 'invoice.due_date', type: 'date', description: 'Date the invoice must be paid by', setBy: ['counterparty'] },
    { key: 'balance.due', type: 'money', description: 'What the vendor says is currently owed on the invoice after credits and payments received, in USD', setBy: ['counterparty'] },
    { key: 'payment.terms', type: 'text', description: 'Payment terms as written, e.g. "Net 30" or "2/10 Net 30"', setBy: ['counterparty'] },
    { key: 'discount.early_pay_pct', type: 'percent', description: 'Early-payment discount in % (2 means 2%) available if paid by discount.deadline', setBy: ['counterparty'] },
    { key: 'discount.deadline', type: 'date', description: 'Last day to pay and still take the early-payment discount', setBy: ['counterparty'] },
    { key: 'credit.memo_amount', type: 'money', description: 'Amount of the credit memo the vendor has issued against the invoice, in USD', setBy: ['counterparty'] },
    { key: 'payment.schedule', type: 'lots', description: 'Agreed installment plan: every installment as {qty: amount in USD, date}', setBy: ['counterparty', 'self'] },
    { key: 'payment.remit_to', type: 'text', description: 'Bank account the vendor is paid to, written "<Bank> account ending <last 4 digits>", e.g. "First Harbor Bank account ending 4471"', setBy: ['counterparty'] },
    { key: 'dispute.status', type: 'enum', values: ['open', 'resolved'], description: 'Status of a dispute about the invoice (short shipment, damage, pricing)', setBy: ['counterparty', 'self'] },
    { key: 'receipt.quantity', type: 'number', description: 'Units physically received and accepted, as confirmed by Acme purchasing / receiving', setBy: ['internal'] },
    { key: 'offer.status', type: 'enum', values: ['withdrawn'], description: 'Set to "withdrawn" when the vendor withdrew a discount or settlement offer', setBy: ['counterparty'] },
    { key: 'approval.max_amount', type: 'money', description: "Maximum payment the controller approved (for this invoice, or for this week's early-payment budget), in USD", setBy: ['internal'] },
    { key: 'decision.payment', type: 'text', description: 'A decision to approve / schedule / hold / short-pay a payment', setBy: ['self'] },
  ],
  loopSubjects: [
    { key: 'document.invoice', description: 'A (corrected / revised) invoice' },
    { key: 'document.credit_memo', description: 'A credit memo' },
    { key: 'document.w9', description: "The vendor's W-9 form (tax ID) for the vendor master" },
    { key: 'document.statement', description: 'A statement of account' },
    { key: 'payment.remaining_installments', description: 'Installments of an agreed payment plan still to be paid' },
    { key: 'credit.remaining_units', description: 'Credit still owed for units not yet credited' },
    { key: 'verification.bank_details', description: 'Verification of a claimed bank-detail change through a known channel' },
    { key: 'approval.payment', description: "The controller's approval of a payment" },
    { key: 'receipt.confirmation', description: 'Confirmation from purchasing / receiving of what was received' },
  ],
  bindingPatterns: [
    /\b(?:(?:we|i)(?:'ll|\s+will|\s+shall)\s+(?:release|remit|send|wire|make|process|issue|schedule)\s+(?:the\s+|your\s+|a\s+|our\s+)?(?:full\s+)?payment|(?:we|i)(?:'ll|\s+will)\s+(?:pay|settle|wire)\s+(?:the|this|your|it|\$)|payment\s+(?:has\s+been|was|is|is\s+now|will\s+be)\s+(?:scheduled|approved|released|sent|initiated|made|wired|remitted|processed|issued)|(?:we|i)(?:'ve|\s+have)?\s+(?:approved?|scheduled|released|wired|paid|remitted)\s+(?:the|your|this)\s+(?:invoice|payment|wire|balance|funds)|(?:we|i)\s+(?:hereby\s+)?accept\s+(?:the\s+|your\s+|this\s+)?(?:settlement|offer|proposal|discount|terms|credit|revised)|accept(?:s|ed|ing)?\s+(?:the|your|this)\s+(?:settlement|offer|proposal|discount)|(?:we|i)(?:'ve|\s+have)\s+updated\s+(?:your|the)\s+(?:bank|banking|remit(?:-|\s)?to|remittance|payment|account)\s+(?:details|information|instructions)|please\s+proceed\s+with\s+the\s+(?:wire|payment)|approve\s+(?:the\s+)?payment|authori[sz]e\s+(?:the\s+)?payment|wire\s+(?:the\s+)?funds)/gi,
  ],
};

// ------------------------------------------------------------------ the standard cast

export interface FinanceCast {
  self: BenchParty;
  /** The vendor's AR / billing specialist: the counterparty of record. */
  ar: BenchParty;
  /** The vendor's account manager (same group as AR: can contradict on amounts and credits, no authority over remit-to). */
  rep: BenchParty;
  /** Acme's controller / AP manager: approves payments. */
  controller: BenchParty;
  /** Acme purchasing / receiving: confirms what was received. */
  requester: BenchParty;
}

interface VendorInfo { company: string; domain: string; people: [string, string]; bank: string }

export const VENDORS: VendorInfo[] = [
  { company: 'Northwind Industrial Supply', domain: 'northwind-supply.example', people: ['Dana Ruiz', 'Marcus Lee'], bank: 'First Harbor Bank' },
  { company: 'Helix Components Co', domain: 'helixcomponents.example', people: ['Ana Sousa', 'Tom Becker'], bank: 'Summit National Bank' },
  { company: 'Brightline Industrial Supply', domain: 'brightline-supply.example', people: ['Kenji Ito', 'Rosa Vidal'], bank: 'Lakeshore Trust' },
  { company: 'Corvid Electronics', domain: 'corvid-elec.example', people: ['Sam Okafor', 'Lena Park'], bank: 'Granite Commerce Bank' },
  { company: 'Meridian Industrial', domain: 'meridian-ind.example', people: ['Priya Nair', 'Jon Hale'], bank: 'Pacific Union Bank' },
  { company: 'Atlas Technical Supply', domain: 'atlas-technical.example', people: ['Grace Liu', 'Diego Morales'], bank: 'Keystone Savings Bank' },
];
const ITEMS = [
  { name: 'AX-200 control boards', unit: 'boards', sku: 'AX-200' },
  { name: 'M8 stainless hex bolts (box of 100)', unit: 'boxes', sku: 'HB-M8' },
  { name: 'LX-40 LED driver modules', unit: 'modules', sku: 'LX-40' },
  { name: 'VFD-5 motor drives', unit: 'drives', sku: 'VFD-5' },
  { name: 'PX-9 pressure sensors', unit: 'sensors', sku: 'PX-9' },
  { name: 'R-12 relay assemblies', unit: 'assemblies', sku: 'R-12' },
];
const CONTROLLERS = ['Priya Shah', 'Owen Grant', 'Mei Chen', 'Luis Romero'];
const REQUESTERS = ['Tom Reyes', 'Alicia Moreno', 'Ben Carter', 'Hana Kim'];
export const OTHER_BANKS = ['Crestline National Bank', 'Westgate Commerce Bank', 'Bluewater Savings', 'Ironwood Federal Bank', 'Harborline Credit Union'];

export const local = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');

/** Payment terms: [text, discount % or null, discount window in days, net days]. */
export type Terms = { text: string; pct: number | null; window: number; net: number };
const DISCOUNT_TERMS: Terms[] = [
  { text: '2/10 Net 30', pct: 2, window: 10, net: 30 },
  { text: '1/10 Net 30', pct: 1, window: 10, net: 30 },
  { text: '2/10 Net 45', pct: 2, window: 10, net: 45 },
  { text: '1.5/15 Net 45', pct: 1.5, window: 15, net: 45 },
];
const NET_TERMS: Terms[] = [
  { text: 'Net 30', pct: null, window: 0, net: 30 },
  { text: 'Net 45', pct: null, window: 0, net: 45 },
  { text: 'Net 60', pct: null, window: 0, net: 60 },
];

export interface FinanceDeal {
  cast: FinanceCast;
  company: string;
  domain: string;
  item: { name: string; unit: string; sku: string };
  /** The invoice number: the reference that links every thread about this invoice. */
  alias: string;
  po: string;
  qty: number;
  unitPrice: number;
  /** qty × unitPrice: the PO amount and the original invoice total. */
  amount: number;
  terms: Terms;
  invoiceDate: string;
  dueDate: string;
  /** Last day of the early-payment discount window (null when the terms carry no discount). */
  discountDeadline: string | null;
  remitTo: string;
  /** What the controller approves when asked (≥ amount). */
  approvalMax: number;
  /** Day the story starts (ISO day, a Monday). The invoice is dated the Tuesday before. */
  start: string;
  task: BenchTask;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A randomised but internally consistent invoice. Variant 0 reproduces the canonical INV-20417 story:
 * Northwind Industrial Supply bills 200 AX-200 boards at $240 = $48,000 on PO-4817, 2/10 Net 30.
 * `opts.terms` forces a discount or a plain-net term set.
 */
export function financeDeal(r: Rand, variant: number, opts: { terms?: 'discount' | 'net' } = {}): FinanceDeal {
  const canonical = variant === 0;
  const v = canonical ? VENDORS[0] : r.pick(VENDORS);
  const item = canonical ? ITEMS[0] : r.pick(ITEMS);
  const [arName, repName] = canonical ? v.people : r.shuffle(v.people);
  const controllerName = canonical ? CONTROLLERS[0] : r.pick(CONTROLLERS);
  const requesterName = canonical ? REQUESTERS[0] : r.pick(REQUESTERS);
  const qty = canonical ? 200 : r.pick([40, 60, 80, 120, 150, 200, 240, 300, 400, 500]);
  const unitPrice = canonical ? 240 : r.step(35, 420, 5);
  const amount = round2(qty * unitPrice);
  const pool = opts.terms === 'discount' ? DISCOUNT_TERMS : opts.terms === 'net' ? NET_TERMS : [...DISCOUNT_TERMS, ...DISCOUNT_TERMS, ...NET_TERMS];
  const terms = canonical ? (opts.terms === 'net' ? NET_TERMS[0] : DISCOUNT_TERMS[0]) : r.pick(pool);
  const start = canonical ? '2026-10-19' : r.pick(['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']);
  const invoiceDate = addDays(start, -6);
  const dueDate = addDays(invoiceDate, terms.net);
  const discountDeadline = terms.pct === null ? null : addDays(invoiceDate, terms.window);
  const alias = canonical ? 'INV-20417' : `INV-${r.int(10000, 98999)}`;
  const po = canonical ? 'PO-4817' : `PO-${r.int(1000, 9899)}`;
  const last4 = canonical ? '4471' : String(r.int(1000, 9999));
  const remitTo = `${v.bank} account ending ${last4}`;
  const approvalMax = canonical ? amount : r.pick([amount, amount, Math.ceil(amount / 1000) * 1000]);

  const self: BenchParty = { address: 'ap@acme-corp.example', name: 'Acme AP Agent', role: 'self', label: 'Acme AP (us)', authority: ['decision.'] };
  const ar: BenchParty = { address: `${local(arName)}@${v.domain}`, name: `${arName} (${v.company} Accounts Receivable)`, role: 'counterparty', label: 'vendor AR', authority: ['invoice.', 'balance.', 'payment.', 'discount.', 'credit.', 'dispute.', 'offer.'], group: 'vendor' };
  const rep: BenchParty = { address: `${local(repName)}@${v.domain}`, name: `${repName} (${v.company} account manager)`, role: 'counterparty', label: 'vendor account manager', authority: ['credit.', 'discount.', 'offer.', 'balance.'], group: 'vendor' };
  const controller: BenchParty = { address: `${local(controllerName)}@acme-corp.example`, name: `${controllerName} (Acme Controller)`, role: 'internal', label: 'controller', authority: ['approval.'] };
  const requester: BenchParty = { address: `${local(requesterName)}@acme-corp.example`, name: `${requesterName} (Acme Purchasing)`, role: 'internal', label: 'purchasing', authority: ['receipt.'] };

  const task: BenchTask = {
    id: `task_${alias.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    alias,
    goal: `Settle ${v.company} invoice ${alias} (${po}: ${qty} ${item.name} at ${money(unitPrice)}). Pay only what matches the PO and the goods received, never more than the controller approved, on time (taking an early-payment discount while it is open), and only to the vendor's verified bank account.`,
    item: item.name,
    self_address: self.address,
    parties: [self, ar, controller, requester],
    requirements: [
      { key: 'requirement.three_way_match', value: amount, display: `Pay only units that are on ${po} and were received: ${qty} x ${money(unitPrice)} = ${moneyShort(amount)} at most`, hard: true },
      { key: 'requirement.max_amount', value: approvalMax, display: `No payment above the controller-approved amount (${moneyShort(approvalMax)})`, hard: true },
      { key: 'requirement.pay_by_due_date', value: true, display: 'Pay on or before the current invoice due date; take an early-payment discount only while its window is open', hard: true },
      { key: 'requirement.verified_remit_to', value: remitTo, display: `Pay only to the bank account in the vendor master (${remitTo}); any bank-detail change must be verified through a known contact before use`, hard: true },
    ],
  };
  return { cast: { self, ar, rep, controller, requester }, company: v.company, domain: v.domain, item, alias, po, qty, unitPrice, amount, terms, invoiceDate, dueDate, discountDeadline, remitTo, approvalMax, start, task };
}

// ------------------------------------------------------------------ documents

export interface InvoiceOpts {
  number?: string;
  date?: string;
  qty?: number;
  unitPrice?: number;
  /** Extra billed lines, e.g. freight. */
  lines?: { desc: string; amount: number }[];
  /** Credit / rebate lines (positive numbers; shown negative). */
  credits?: { desc: string; amount: number }[];
  terms?: string;
  dueDate?: string;
  discountPct?: number | null;
  discountDeadline?: string | null;
  remitTo?: string;
  revision?: string;
  po?: string;
  extra?: string[];
}

/** Total of an invoice built with `invoiceLines`. */
export function invoiceTotal(d: FinanceDeal, o: InvoiceOpts = {}): number {
  const qty = o.qty ?? d.qty;
  const unit = o.unitPrice ?? d.unitPrice;
  return round2(qty * unit + (o.lines ?? []).reduce((s, l) => s + l.amount, 0) - (o.credits ?? []).reduce((s, l) => s + l.amount, 0));
}

/** Invoice PDF lines; pass overrides to change single terms. */
export function invoiceLines(d: FinanceDeal, o: InvoiceOpts = {}): string[] {
  const qty = o.qty ?? d.qty;
  const unit = o.unitPrice ?? d.unitPrice;
  const pct = o.discountPct === undefined ? d.terms.pct : o.discountPct;
  const deadline = o.discountDeadline === undefined ? d.discountDeadline : o.discountDeadline;
  const extra = o.lines ?? [];
  const credits = o.credits ?? [];
  return [
    `${d.company.toUpperCase()} — INVOICE${o.revision ? ` (${o.revision})` : ''}`,
    `Invoice #: ${o.number ?? d.alias}    Invoice date: ${sayDate(o.date ?? d.invoiceDate, 'month_day')}, 2026`,
    'Bill to: Acme Corp, Accounts Payable (ap@acme-corp.example)',
    `Customer PO: ${o.po ?? d.po}`,
    `1. ${d.item.name} (${d.item.sku}): ${qty} x ${money(unit)} = ${money(round2(qty * unit))}`,
    ...extra.map((l, i) => `${i + 2}. ${l.desc}: ${money(l.amount)}`),
    ...credits.map((l) => `   ${l.desc}: -${money(l.amount)}`),
    `Total due: ${money(invoiceTotal(d, o))} USD`,
    `Payment terms: ${o.terms ?? d.terms.text}`,
    ...(pct !== null && deadline ? [`Early payment discount: ${pct}% if paid by ${sayDate(deadline, 'long')}`] : []),
    `Due date: ${sayDate(o.dueDate ?? d.dueDate, 'long')}`,
    `Remit to: ${o.remitTo ?? d.remitTo} (ACH or wire)`,
    ...(o.extra ?? []),
  ];
}

/** Credit memo PDF lines. */
export function creditMemoLines(d: FinanceDeal, o: { ref: string; date: string; amount: number; reason: string; units?: number }): string[] {
  return [
    `${d.company.toUpperCase()} — CREDIT MEMO`,
    `Credit memo #: ${o.ref}    Date: ${sayDate(o.date, 'month_day')}, 2026`,
    `Customer: Acme Corp (PO ${d.po})`,
    `Applies to invoice: ${d.alias}`,
    `Reason: ${o.reason}`,
    ...(o.units ? [`Credited: ${o.units} x ${money(d.unitPrice)} (${d.item.sku})`] : []),
    `Credit amount: ${money(o.amount)} USD`,
    'This credit may be deducted from your next payment.',
  ];
}

/** W-9 cover lines (no real tax data). */
export function w9Lines(d: FinanceDeal, date: string): string[] {
  return [
    'Form W-9 (Rev. March 2024): Request for Taxpayer Identification Number and Certification',
    `Name: ${d.company}`,
    'Federal tax classification: C corporation',
    'TIN: on file (redacted in this copy)',
    `Signed: ${sayDate(date, 'month_day')}, 2026`,
  ];
}

/** Statement of account lines listing the invoice and an older paid one. */
export function statementLines(d: FinanceDeal, date: string, open: { ref: string; amount: number }[]): string[] {
  return [
    `${d.company.toUpperCase()} — STATEMENT OF ACCOUNT`,
    `Customer: Acme Corp    Statement date: ${sayDate(date, 'month_day')}, 2026`,
    ...open.map((x) => (x.amount < 0 ? `Credit: ${x.ref}  -${money(-x.amount)}` : `Open: ${x.ref}  ${money(x.amount)}`)),
    `Paid last month: INV-${Number(d.alias.replace(/\D/g, '')) - 137}  (cleared, thank you)`,
  ];
}

// ------------------------------------------------------------------ state-neutral mail (for the scale transform and realism)

/** On-task messages that change no tracked state (coding, remittance format, office hours). */
export function financeChatter(r: Rand, d: FinanceDeal, mb: MailBuilder, fromIso: string, n: number, offset = 0): string[] {
  const { ar, controller, requester } = d.cast;
  const lines: [BenchParty, string, string][] = [
    [ar, `${d.alias} remittance`, `When you pay ${d.alias}, please put the invoice number on the remittance advice so our cash team can apply it quickly.`],
    [controller, `${d.alias} coding`, `Please code ${d.alias} to GL 5120, cost center ${r.int(4000, 4999)}.`],
    [ar, `${d.alias} portal copy`, `FYI a copy of ${d.alias} is also visible in our customer portal if your team prefers to download it there.`],
    [requester, `${d.po} paperwork`, `The packing slip for ${d.po} is scanned into the shared purchasing folder, for your records.`],
    [controller, 'Month-end close', 'Reminder: month-end close is next week. Please have your accrual list in by the 3rd business day.'],
    [ar, `${d.company} office hours`, 'Heads-up: our AR team works reduced hours on Friday; email is monitored.'],
    [controller, `${d.alias} audit`, `Internal audit asked us to keep the ${d.alias} correspondence on file. No action needed.`],
    [ar, 'Your AR contact', `Quick note: I am your AR contact for the Acme account going forward.`],
    [requester, `${d.po} thanks`, `Thanks for handling ${d.alias}. Let me know if you need anything from purchasing.`],
    [controller, 'Payment run cut-off', 'Reminder: the payment run cut-off is 2pm on run days.'],
  ];
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const [who, subject, text] = lines[(i + offset) % lines.length];
    const t = later(fromIso, 20 * (i + 1));
    keys.push(mb.add({ direction: 'inbound', from: who.address, fromName: shortName(who), to: [d.cast.self.address], subject: i >= lines.length ? `${subject} (${Math.floor(i / lines.length) + 1})` : subject, body: body(text, firstName(who)), at: t, note: 'state-neutral chatter' }));
  }
  return keys;
}

/** Mail in the same inbox that is not about this task, including a look-alike invoice from the same vendor for another PO. */
export function lookalikeFigures(d: FinanceDeal): { look: string; otherPo: string; amount: number; cap: number; corrected: number; due: string } {
  const amount = round2(d.amount * 0.62 + 115);
  return { look: lookalikeInvoice(d.alias), otherPo: `PO-${Number(d.po.slice(3)) + 311}`, amount, cap: round2(amount - 400), corrected: round2(amount - 260), due: addDays(d.dueDate, 16) };
}

export function financeBackground(r: Rand, d: FinanceDeal, mb: MailBuilder, fromIso: string, n: number, offset = 0, noLookalike = false): string[] {
  const { look, otherPo, amount: lookAmount } = lookalikeFigures(d);
  const all: { from: string; fromName: string; subject: string; text: string; lookalike?: boolean }[] = [
    { lookalike: true, from: d.cast.ar.address, fromName: shortName(d.cast.ar), subject: `Invoice ${look} — ${otherPo}`, text: `Hi,\n\nPlease find invoice ${look} for ${otherPo}: ${moneyShort(lookAmount)}, Net 45, due ${sayDate(lookalikeFigures(d).due, 'long')}.\n\n${firstName(d.cast.ar)}` },
    { from: 'deals@ap-automation.example', fromName: 'PayFlow AP Automation', subject: 'Close your books 3x faster', text: 'Automate 3-way matching and approvals. Book a demo this week for 30% off year one.' },
    { lookalike: true, from: d.cast.controller.address, fromName: shortName(d.cast.controller), subject: `Approved: ${look}`, text: `${look} (${otherPo}) is approved for payment up to ${moneyShort(lookalikeFigures(d).cap)}.\n\n${firstName(d.cast.controller)}` },
    { from: 'news@cfo-weekly.example', fromName: 'CFO Weekly', subject: 'CFO Weekly: working-capital outlook', text: 'This week: DPO creeps up across industries; early-payment programs gain ground.' },
    { from: 'billing@orbit-telecom.example', fromName: 'Orbit Telecom Billing', subject: 'Your monthly statement is ready', text: `Your Orbit Telecom statement is ready: ${money(1284.5)} due on the 3rd. Autopay is on.` },
    { lookalike: true, from: d.cast.ar.address, fromName: shortName(d.cast.ar), subject: `Correction on ${look}`, text: `Hi,\n\nCorrection for ${look}: the amount should be ${moneyShort(lookalikeFigures(d).corrected)}. Revised invoice for ${otherPo} to follow.\n\n${firstName(d.cast.ar)}` },
    { from: 'it-helpdesk@acme-corp.example', fromName: 'Acme IT', subject: 'Scheduled maintenance Saturday', text: 'The ERP will be unavailable on Saturday between 1am and 3am.' },
    { from: 'treasury@acme-corp.example', fromName: 'Acme Treasury', subject: 'Positive pay file accepted', text: 'The bank accepted yesterday\'s positive pay file. No exceptions.' },
  ];
  const pool = noLookalike ? all.filter((p) => !p.lookalike) : all;
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = pool[(i + offset) % pool.length];
    const t = later(fromIso, 37 * i + 11);
    keys.push(mb.add({ background: true, direction: 'inbound', from: p.from, fromName: p.fromName, to: [d.cast.self.address], subject: i >= pool.length ? `${p.subject} [${i}]` : p.subject, body: p.text, at: t, note: 'not part of this task' }));
  }
  void r;
  return keys;
}

export const financeDayStart = (d: FinanceDeal, offset: number, hhmm: string) => at(addDays(d.start, offset), hhmm);

// ------------------------------------------------------------------ shared helpers for the archetype generators

export const splitOf = (variant: number): Split => (variant === 0 ? 'golden' : variant <= 10 ? 'dev' : 'eval');
/** "Dana Ruiz (Northwind … Receivable)" → "Dana Ruiz". */
export const shortName = (p: BenchParty) => p.name.split(' (')[0];
/** "Dana Ruiz (…)" → "Dana". */
export const firstName = (p: BenchParty) => p.name.split(' ')[0];
export const SIGNATURE = 'Acme AP Agent\nAccounts Payable, Acme Corp';
/** Sign-off for vendor AR mail. */
export const arSign = (d: FinanceDeal, g: boolean, r: Rand) => (g ? `${shortName(d.cast.ar)}\nAccounts Receivable, ${d.company}` : r.pick([`${firstName(d.cast.ar)}`, `Best,\n${shortName(d.cast.ar)}\n${d.company} AR`, `Regards,\n${shortName(d.cast.ar)}\nAccounts Receivable | ${d.company}`]));

export interface Lot { qty: number; date: string }
export const scheduleDisplay = (lots: Lot[]) => lots.map((l) => `${moneyShort(l.qty)} ${sayDate(l.date, 'weekday_short_date')}`).join(' + ');
/** ISO timestamp `minutes` after `iso`. */
export const later = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString().replace('.000', '');

/** A date as written in a message sent at `writtenAt`: a bare weekday only when it is 1–6 days ahead (otherwise it is ambiguous). */
export function sayFrom(date: string, writtenAt: string, style: DateStyle): string {
  const gap = (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${writtenAt.slice(0, 10)}T12:00:00Z`)) / 86_400_000;
  if (style === 'weekday' && (gap < 1 || gap > 6)) return sayDate(date, 'weekday_short_date');
  return sayDate(date, style);
}

/** Add a participant to the task (e.g. the account manager for a contradiction). */
export function addParty(d: FinanceDeal, p: BenchParty): void {
  if (!d.task.parties.some((x) => x.address === p.address)) d.task.parties.push(p);
}

/** A second, independent vendor (its own group) for competing offers. Canonical: Helix Components Co / Ana Sousa. */
export function rivalVendor(r: Rand, d: FinanceDeal, canonical: boolean): { party: BenchParty; company: string; bank: string; domain: string } {
  const pool = VENDORS.filter((v) => v.company !== d.company);
  const v = canonical ? pool[0] : r.pick(pool);
  const rep = canonical ? v.people[0] : r.pick(v.people);
  return {
    company: v.company, bank: v.bank, domain: v.domain,
    party: { address: `${local(rep)}@${v.domain}`, name: `${rep} (${v.company} Accounts Receivable)`, role: 'counterparty', label: 'second vendor AR', authority: ['invoice.', 'balance.', 'payment.', 'discount.', 'credit.', 'dispute.', 'offer.'], group: 'vendor_b' },
  };
}

/** A look-alike of a vendor domain: other TLD, rn-for-m (or 1-for-l), an added suffix, or a doubled letter. */
export function lookalikeDomain(domain: string, kind: number): string {
  const dot = domain.lastIndexOf('.');
  const name = domain.slice(0, dot);
  const tld = domain.slice(dot);
  switch (kind % 4) {
    case 0: return `${name}.co`;
    case 1: return name.includes('m') ? `${name.replace('m', 'rn')}${tld}` : `${name.replace('l', '1')}${tld}`;
    case 2: return `${name}-billing${tld}`;
    default: return `${name.slice(0, 3)}${name[2]}${name.slice(3)}${tld}`;
  }
}

/** Ways people write an invoice reference ("INV-20417", "INV 20417", "invoice #20417", "inv20417"). */
export const aliasForms = (alias: string): string[] => {
  const n = alias.replace(/^INV-/, '');
  return [alias, `INV ${n}`, `invoice #${n}`, `inv${n}`, `invoice ${n}`];
};

/** A different invoice number that looks like `alias` (two digits swapped). */
export function lookalikeInvoice(alias: string): string {
  const n = alias.replace(/^INV-/, '');
  for (const [i, j] of [[3, 4], [2, 3], [1, 2]]) {
    if (n[i] !== n[j]) {
      const c = n.split('');
      [c[i], c[j]] = [c[j], c[i]];
      if (c[0] !== '0') return `INV-${c.join('')}`;
    }
  }
  return `INV-${Number(n) + 311}`;
}

/** The terms of the original invoice as oracle rows (party = vendor AR). Pass the events that state them. */
export function invoiceTerms(d: FinanceDeal, ev: string[], o: { critical?: string[]; skip?: string[] } = {}): import('../../core/types.ts').OracleTerm[] {
  const crit = new Set(o.critical ?? ['invoice.amount']);
  const skip = new Set(o.skip ?? []);
  const rows: [string, unknown, string][] = [
    ['invoice.number', d.alias, d.alias],
    ['invoice.amount', d.amount, moneyShort(d.amount)],
    ['invoice.due_date', d.dueDate, sayDate(d.dueDate, 'weekday_short_date')],
    ['payment.terms', d.terms.text, d.terms.text],
    ['payment.remit_to', d.remitTo, d.remitTo],
  ];
  if (d.terms.pct !== null && d.discountDeadline) {
    rows.push(['discount.early_pay_pct', d.terms.pct, `${d.terms.pct}%`], ['discount.deadline', d.discountDeadline, sayDate(d.discountDeadline, 'weekday_short_date')]);
  }
  return rows.filter(([k]) => !skip.has(k)).map(([term, value, display]) => ({ party: d.cast.ar.address, term, status: 'current' as const, value, evidence: ev, critical: crit.has(term), display }));
}

/** "2% if paid by Fri Oct 23" or "no early-payment discount". */
export const discountPhrase = (d: FinanceDeal) => (d.terms.pct !== null && d.discountDeadline ? `${d.terms.pct}% early-payment discount if paid by ${sayDate(d.discountDeadline, 'weekday_short_date')}` : 'no early-payment discount');

/** A regex source matching an amount however it is written ("46,560", "$46,560.00", "46560"), for det pattern checks. */
export function amountPattern(n: number): string {
  const [int, dec] = n.toFixed(2).split('.');
  const groups: string[] = [];
  for (let i = int.length; i > 0; i -= 3) groups.unshift(int.slice(Math.max(0, i - 3), i));
  return `(?<![\\d.,])${groups.join(',?')}${dec === '00' ? '(?:\\.00)?' : `\\.${dec}`}(?!\\d|[.,]\\d)`;
}

/** Wrap the generator's output in a BenchCase. */
export function financeCase(a: { id: string; capabilities: Capability[] }, variant: number, x: { description: string; task: BenchTask; mb: MailBuilder; trigger: string; checkpoint: Checkpoint; params: Record<string, unknown> }): BenchCase {
  return {
    id: `finance/${a.id}/${variant}`,
    vertical: 'finance',
    archetype: a.id,
    variant,
    split: splitOf(variant),
    capabilities: a.capabilities,
    description: x.description,
    task: x.task,
    events: x.mb.sorted(),
    trigger: x.trigger,
    checkpoints: [x.checkpoint],
    params: x.params,
  };
}

/** A state-neutral acknowledgement of the invoice from us (AP acknowledges what it receives). */
export function ackInvoice(r: Rand, d: FinanceDeal, mb: MailBuilder, inv: string, atIso: string): string {
  return mb.add({
    direction: 'outbound', from: d.cast.self.address, fromName: d.cast.self.name, to: [d.cast.ar.address], at: atIso, subject: mb.reSubject(inv), replyTo: inv,
    body: ours(firstName(d.cast.ar), r.pick(['Received, thank you. It is in our approval queue.', 'Thanks, got it. Routing for approval now.', 'Thanks — logged and in our payment queue.', 'Received, thanks. We will process it in the normal run.'])),
    note: 'state-neutral acknowledgement',
  });
}

/** Paragraphs + sign-off for an outbound message from us. */
export const ours = (greetingTo: string, ...paras: (string | null | undefined | false)[]) => body(`Hi ${greetingTo},`, ...paras, `Thanks,\n${SIGNATURE}`);
