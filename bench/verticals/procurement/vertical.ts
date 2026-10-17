// Procurement: an agent buys goods for Acme from a supplier, with an internal finance approver.
// The term keys deliberately match the vocabulary a procurement system would track; they are the
// benchmark's own definition and are written here, not imported from the engine.
import type { BenchCase, BenchParty, BenchTask, Capability, Checkpoint, Split, VerticalSpec } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, at, body, moneyShort, sayDate, type DateStyle } from '../../core/util.ts';

export const procurement: VerticalSpec = {
  id: 'procurement',
  name: 'Procurement & sourcing',
  agentRole: 'You are a procurement agent acting for Acme by email.',
  continuityDomain: 'procurement',
  terms: [
    { key: 'price.unit', type: 'money', description: 'Offered unit price in USD', setBy: ['counterparty'] },
    { key: 'delivery.schedule', type: 'lots', description: 'Offered delivery schedule: every lot as {qty, date}', setBy: ['counterparty'] },
    { key: 'order.quantity', type: 'number', description: 'Total quantity offered / available', setBy: ['counterparty'] },
    { key: 'payment.terms', type: 'text', description: 'Payment terms, e.g. "Net 30"', setBy: ['counterparty'] },
    { key: 'quote.valid_until', type: 'date', description: 'Date the quote expires', setBy: ['counterparty'] },
    { key: 'offer.status', type: 'enum', values: ['withdrawn'], description: 'Set to "withdrawn" when the supplier withdrew its offer or cannot supply', setBy: ['counterparty'] },
    { key: 'budget.max_unit_price', type: 'money', description: 'Internally approved maximum unit price (finance decision)', setBy: ['internal'] },
    { key: 'decision.order', type: 'text', description: 'A decision to accept / place / decline the order', setBy: ['self', 'counterparty'] },
  ],
  loopSubjects: [
    { key: 'document.quote', description: 'A (revised) quote document' },
    { key: 'document.invoice', description: 'An invoice' },
    { key: 'delivery.remaining_units', description: 'Delivery of units still outstanding' },
    { key: 'approval.budget', description: 'An internal budget approval' },
  ],
  bindingPatterns: [
    /\b((?:we|i)\s+(?:hereby\s+)?accepts?\b|accept(?:s|ed)?\s+(?:it|your|the|this)\b(?:\s+(?:offer|quote|proposal|order|terms))?|confirm the order|place the order|we are placing|purchase order is confirmed|approve (?:the )?payment|authori[sz]e (?:the )?payment|wire (?:the )?funds)/gi,
  ],
};

// ------------------------------------------------------------------ the standard cast

export interface ProcurementCast {
  self: BenchParty;
  supplier: BenchParty;
  finance: BenchParty;
  /** Someone else at the supplier (same group: can contradict, cannot be ignored). */
  supplierOps: BenchParty;
  /** The supplier's freight forwarder (same group). */
  forwarder: BenchParty;
}

const SUPPLIERS = [
  { company: 'Northwind Components', domain: 'northwind-components.example', people: ['Dana Ruiz', 'Marcus Lee'] },
  { company: 'Helix Parts Co', domain: 'helixparts.example', people: ['Ana Sousa', 'Tom Becker'] },
  { company: 'Brightline Supply', domain: 'brightline-supply.example', people: ['Kenji Ito', 'Rosa Vidal'] },
  { company: 'Corvid Electronics', domain: 'corvid-elec.example', people: ['Sam Okafor', 'Lena Park'] },
  { company: 'Meridian Industrial', domain: 'meridian-ind.example', people: ['Priya Nair', 'Jon Hale'] },
];
const ITEMS = [
  { name: 'AX-200 control boards', unit: 'boards', sku: 'AX-200' },
  { name: 'M8 stainless hex bolts (box of 100)', unit: 'boxes', sku: 'HB-M8' },
  { name: 'LX-40 LED driver modules', unit: 'modules', sku: 'LX-40' },
  { name: 'PX-9 pressure sensors', unit: 'sensors', sku: 'PX-9' },
  { name: 'R-12 relay assemblies', unit: 'assemblies', sku: 'R-12' },
];
const FINANCE = ['Priya Shah', 'Owen Grant', 'Mei Chen', 'Luis Romero'];

const local = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');

export interface ProcurementDeal {
  cast: ProcurementCast;
  company: string;
  item: { name: string; unit: string; sku: string };
  alias: string;
  qty: number;
  price: number;
  budget: number;
  /** Hard deadline (ISO day) for every unit. */
  deadline: string;
  /** Day the story starts (ISO day, a Monday or Tuesday). */
  start: string;
  task: BenchTask;
}

/** A randomised but internally consistent deal. Variant 0 reproduces the canonical PO-4817 story. */
export function procurementDeal(r: Rand, variant: number): ProcurementDeal {
  const canonical = variant === 0;
  const s = canonical ? SUPPLIERS[0] : r.pick(SUPPLIERS);
  const item = canonical ? ITEMS[0] : r.pick(ITEMS);
  const [repName, opsName] = canonical ? s.people : r.shuffle(s.people);
  const financeName = canonical ? FINANCE[0] : r.pick(FINANCE);
  const qty = canonical ? 500 : r.pick([200, 300, 400, 500, 600, 750, 800, 1000, 1200]);
  const price = canonical ? 11.4 : r.step(4, 40, 0.05);
  const budget = canonical ? 11.5 : Math.round((price + r.pick([0.1, 0.25, 0.5, 1, 1.5])) * 100) / 100;
  // the story starts on a Monday; the hard deadline is that week's Friday
  const start = canonical ? '2026-10-19' : r.pick(['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']);
  const deadline = addDays(start, 4);
  const alias = canonical ? 'PO-4817' : `PO-${r.int(1000, 9899)}`;

  const self: BenchParty = { address: 'procurement@acme-buyer.example', name: 'Acme Procurement Agent', role: 'self', label: 'Acme (us)', authority: ['decision.'] };
  const supplier: BenchParty = { address: `${local(repName)}@${s.domain}`, name: `${repName} (${s.company})`, role: 'counterparty', label: 'supplier', authority: ['price.', 'delivery.', 'order.', 'payment.', 'quote.', 'offer.'], group: 'supplier' };
  const supplierOps: BenchParty = { address: `${local(opsName)}@${s.domain}`, name: `${opsName} (${s.company} operations)`, role: 'counterparty', label: 'supplier operations', authority: ['delivery.'], group: 'supplier' };
  const forwarder: BenchParty = { address: 'ops@fastfreight.example', name: 'FastFreight Ops', role: 'counterparty', label: 'freight forwarder', authority: ['delivery.'], group: 'supplier' };
  const finance: BenchParty = { address: `${local(financeName)}@acme-buyer.example`, name: `${financeName} (Acme Finance)`, role: 'internal', label: 'finance', authority: ['budget.'] };

  const task: BenchTask = {
    id: `task_${alias.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    alias,
    goal: `Buy ${qty} ${item.name} for ${alias}. All ${qty} must arrive by ${sayDate(deadline, 'weekday_short_date')}; unit price must not exceed ${moneyShort(budget)}.`,
    item: item.name,
    self_address: self.address,
    parties: [self, supplier, finance],
    requirements: [
      { key: 'requirement.quantity', value: qty, display: `${qty} units`, hard: true },
      { key: 'requirement.deliver_all_by', value: deadline, display: sayDate(deadline, 'weekday_short_date'), hard: true },
      { key: 'requirement.max_unit_price', value: budget, display: moneyShort(budget), hard: true },
    ],
  };
  return { cast: { self, supplier, finance, supplierOps, forwarder }, company: s.company, item, alias, qty, price, budget, deadline, start, task };
}

/** Quote PDF lines; pass overrides to change single terms. */
export function quoteLines(d: ProcurementDeal, o: { ref: string; date: string; price?: number; deliveryLine?: string; payment?: string; validUntil?: string; revision?: string; extra?: string[] }): string[] {
  const price = o.price ?? d.price;
  return [
    `${d.company.toUpperCase()} — QUOTATION${o.revision ? ` (${o.revision})` : ''}`,
    `Quote #: ${o.ref}${o.revision ? ` ${o.revision}` : ''}    Date: ${sayDate(o.date, 'month_day')}, 2026`,
    `Customer: Acme Corp (ref ${d.alias})`,
    `Item: ${d.item.name} (${d.item.sku})`,
    `Quantity: ${d.qty} units`,
    `Unit price: ${moneyShort(price)} per unit`,
    `Delivery: ${o.deliveryLine ?? `${d.qty} units by ${sayDate(d.deadline, 'long')}`}`,
    `Payment terms: ${o.payment ?? 'Net 30'}`,
    `Total: ${moneyShort(Math.round(price * d.qty * 100) / 100)}`,
    `Valid until ${sayDate(o.validUntil ?? addDays(d.deadline, 7), 'long')}`,
    ...(o.extra ?? []),
  ];
}

// ------------------------------------------------------------------ state-neutral mail (for the scale transform and realism)

/** On-task messages that change no tracked state (packaging notes, cost centres, office closures). */
export function procurementChatter(r: Rand, d: ProcurementDeal, mb: MailBuilder, fromIso: string, n: number, offset = 0): string[] {
  const { supplier, finance } = d.cast;
  const lines: [string, string, string][] = [
    [supplier.address, `${d.alias} packaging`, `FYI for ${d.alias}: ${d.item.unit} ship in ESD trays, 50 per tray.`],
    [finance.address, `${d.alias} cost center`, `Reminder: please use cost center ${r.int(4000, 4999)} on the ${d.alias} paperwork.`],
    [supplier.address, `${d.alias} invoicing contact`, `For ${d.alias} invoices, our billing contact is ar@${supplier.address.split('@')[1]}.`],
    [supplier.address, `${d.alias} certificates`, `RoHS and conformance certificates for ${d.alias} will be included in the shipment.`],
    [finance.address, `${d.alias} vendor setup`, `${d.company} is already an approved vendor, no action needed for ${d.alias}.`],
    [supplier.address, `${d.alias} office hours`, 'Heads-up: our office closes early on Thursday; email is monitored.'],
    [supplier.address, `${d.alias} labels`, `Each carton for ${d.alias} will carry your PO number on the label.`],
    [finance.address, `${d.alias} receiving`, 'Receiving dock 3 is open 7am-3pm for inbound freight.'],
    [supplier.address, `${d.alias} account manager`, 'Quick note: I will be your account manager going forward.'],
    [finance.address, `${d.alias} audit`, `Internal audit asked us to keep all ${d.alias} correspondence on file. No action needed.`],
  ];
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const [from, subject, text] = lines[(i + offset) % lines.length];
    const who = from === supplier.address ? supplier : finance;
    const minutes = 20 * (i + 1);
    const t = new Date(Date.parse(fromIso) + minutes * 60_000).toISOString().replace('.000', '');
    keys.push(mb.add({ direction: 'inbound', from, fromName: who.name.split(' (')[0], to: [d.cast.self.address], subject: i >= lines.length ? `${subject} (${Math.floor(i / lines.length) + 1})` : subject, body: body(text, who.name.split(' ')[0]), at: t, note: 'state-neutral chatter' }));
  }
  return keys;
}

/** Mail in the same inbox that is not about this task, including a look-alike deal with the same supplier. */
export function procurementBackground(r: Rand, d: ProcurementDeal, mb: MailBuilder, fromIso: string, n: number, offset = 0): string[] {
  const other = `PO-${Number(d.alias.slice(3)) + 311}`;
  const otherPrice = Math.round((d.price * 0.9) * 100) / 100;
  const pool: { from: string; fromName: string; subject: string; text: string }[] = [
    { from: 'deals@bulk-electronics.example', fromName: 'Bulk Electronics Deals', subject: `Flash sale: ${d.item.unit} from ${moneyShort(Math.round(d.price * 0.8 * 100) / 100)} each!`, text: `This week only: ${d.item.name} from ${moneyShort(Math.round(d.price * 0.8 * 100) / 100)} per unit. Reply to order.` },
    { from: d.cast.supplier.address, fromName: d.cast.supplier.name.split(' (')[0], subject: `Quote for ${other}`, text: `For ${other} we can deliver 120 units on ${sayDate(addDays(d.deadline, 10), 'weekday_short_date')} at ${moneyShort(otherPrice)} each. Payment Net 45.` },
    { from: 'news@industry-weekly.example', fromName: 'Industry Weekly', subject: 'Industry Weekly: supply outlook', text: 'This week: lead times stabilise; freight rates ease slightly.' },
    { from: d.cast.finance.address, fromName: d.cast.finance.name.split(' (')[0], subject: `Budget for ${other}`, text: `Approved up to ${moneyShort(otherPrice + 0.5)} per unit for ${other}.` },
    { from: 'it-helpdesk@acme-buyer.example', fromName: 'Acme IT', subject: 'Scheduled maintenance Saturday', text: 'Email may be slow on Saturday between 1am and 3am.' },
    { from: d.cast.supplier.address, fromName: d.cast.supplier.name.split(' (')[0], subject: `Correction on ${other}`, text: `Correction for ${other}: the 120 units will now arrive ${sayDate(addDays(d.deadline, 12), 'weekday_short_date')}. I'll send a revised quote for ${other}.` },
    { from: 'events@tradeshow.example', fromName: 'TradeShow 2026', subject: 'Your badge is ready', text: 'Pick up your badge at hall B.' },
  ];
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = pool[(i + offset) % pool.length];
    const t = new Date(Date.parse(fromIso) + (37 * i + 11) * 60_000).toISOString().replace('.000', '');
    keys.push(mb.add({ background: true, direction: 'inbound', from: p.from, fromName: p.fromName, to: [d.cast.self.address], subject: i >= pool.length ? `${p.subject} [${i}]` : p.subject, body: p.text, at: t, note: 'not part of this task' }));
  }
  void r;
  return keys;
}

export const procurementDayStart = (d: ProcurementDeal, offset: number, hhmm: string) => at(addDays(d.start, offset), hhmm);

// ------------------------------------------------------------------ shared helpers for the archetype generators

export const splitOf = (variant: number): Split => (variant === 0 ? 'golden' : variant <= 10 ? 'dev' : 'eval');
/** "Dana Ruiz (Northwind Components)" → "Dana Ruiz". */
export const shortName = (p: BenchParty) => p.name.split(' (')[0];
/** "Dana Ruiz (Northwind Components)" → "Dana". */
export const firstName = (p: BenchParty) => p.name.split(' ')[0];
export const SIGNATURE = 'Acme Procurement Agent';

export interface Lot { qty: number; date: string }
export const lotsDisplay = (lots: Lot[]) => lots.map((l) => `${l.qty} units ${sayDate(l.date, 'weekday_short_date')}`).join(' + ');
/** The "Delivery:" line of a quote PDF for a lot list. */
export const lotsLine = (lots: Lot[]) => lots.map((l) => `${l.qty} units by ${sayDate(l.date, 'long')}`).join('; ');
export const round2 = (n: number) => Math.round(n * 100) / 100;
/** ISO timestamp `minutes` after `iso`. */
export const later = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString().replace('.000', '');

/** A date as written in a message sent at `writtenAt`: a bare weekday only when it is 1–6 days ahead (otherwise it is ambiguous). */
export function sayFrom(date: string, writtenAt: string, style: DateStyle): string {
  const gap = (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${writtenAt.slice(0, 10)}T12:00:00Z`)) / 86_400_000;
  if (style === 'weekday' && (gap < 1 || gap > 6)) return sayDate(date, 'weekday_short_date');
  return sayDate(date, style);
}

/** The same deal with a different hard deadline (goal text and requirement updated). */
export function withDeadline(d: ProcurementDeal, deadline: string): ProcurementDeal {
  const task: BenchTask = {
    ...d.task,
    parties: [...d.task.parties],
    goal: `Buy ${d.qty} ${d.item.name} for ${d.alias}. All ${d.qty} must arrive by ${sayDate(deadline, 'weekday_short_date')}; unit price must not exceed ${moneyShort(d.budget)}.`,
    requirements: d.task.requirements.map((q) => (q.key === 'requirement.deliver_all_by' ? { ...q, value: deadline, display: sayDate(deadline, 'weekday_short_date') } : q)),
  };
  return { ...d, deadline, task };
}

/** Add a participant to the task (e.g. the forwarder for a contradiction). */
export function addParty(d: ProcurementDeal, p: BenchParty): void {
  if (!d.task.parties.some((x) => x.address === p.address)) d.task.parties.push(p);
}

/** A second, independent supplier (its own group) for competing offers. Canonical: Helix Parts Co / Ana Sousa. */
export function rivalSupplier(r: Rand, d: ProcurementDeal, canonical: boolean): { party: BenchParty; company: string } {
  const pool = SUPPLIERS.filter((s) => s.company !== d.company);
  const s = canonical ? pool[0] : r.pick(pool);
  const rep = canonical ? s.people[0] : r.pick(s.people);
  return {
    company: s.company,
    party: { address: `${local(rep)}@${s.domain}`, name: `${rep} (${s.company})`, role: 'counterparty', label: 'alternative supplier', authority: ['price.', 'delivery.', 'order.', 'payment.', 'quote.', 'offer.'], group: 'supplier_b' },
  };
}

/** A look-alike of a supplier domain: other TLD, rn-for-m (or 1-for-l), an added suffix, or a doubled letter. */
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

/** Ways people write a deal reference ("PO-4817", "PO 4817", "PO#4817", "po4817"). */
export const aliasForms = (alias: string): string[] => {
  const n = alias.replace(/^PO-/, '');
  return [alias, `PO ${n}`, `PO#${n}`, `po${n}`, `P.O. ${n}`];
};

/** A different deal reference that looks like `alias` (two digits swapped). */
export function lookalikeAlias(alias: string): string {
  const n = alias.replace(/^PO-/, '');
  for (const [i, j] of [[2, 3], [1, 2], [0, 1]]) {
    if (n[i] !== n[j]) {
      const c = n.split('');
      [c[i], c[j]] = [c[j], c[i]];
      if (c[0] !== '0') return `PO-${c.join('')}`;
    }
  }
  return `PO-${Number(n) + 311}`;
}

/** Wrap the generator's output in a BenchCase. */
export function procurementCase(a: { id: string; capabilities: Capability[] }, variant: number, x: { description: string; task: BenchTask; mb: MailBuilder; trigger: string; checkpoint: Checkpoint; params: Record<string, unknown> }): BenchCase {
  return {
    id: `procurement/${a.id}/${variant}`,
    vertical: 'procurement',
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

/** Paragraphs + sign-off for an outbound message from us. */
export const ours = (greetingTo: string, ...paras: (string | null | undefined | false)[]) => body(`Hi ${greetingTo},`, ...paras, `Thanks,\n${SIGNATURE}`);
