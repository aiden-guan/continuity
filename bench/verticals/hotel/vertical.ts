// Hotel group sales / venue booking: Acme's meeting-planner agent books a room block and meeting space
// for a company event by email. The counterparty is the hotel's group sales manager (with the hotel's
// revenue manager / director of sales in the same group); Acme finance approves the rate cap. The term
// keys are the benchmark's own definition of what an experienced meeting planner tracks; nothing here
// is imported from the engine.
import type { BenchParty, BenchTask, OracleTerm, VerticalSpec } from '../../core/types.ts';
import { MailBuilder, Rand, addBusinessDays, addDays, at, body, money, moneyShort, nextWeekday, sayDate, thousands } from '../../core/util.ts';

export const hotel: VerticalSpec = {
  id: 'hotel',
  name: 'Hotel group sales & venue booking',
  agentRole: "You are Acme's meeting-planner agent, booking hotel room blocks and meeting space for company events by email.",
  continuityDomain: 'hotel',
  terms: [
    { key: 'rate.group', type: 'money', description: 'Group room rate in USD per room, per night (before tax)', setBy: ['counterparty'] },
    { key: 'block.rooms', type: 'lots', description: 'Contracted / offered room block: one {qty: rooms, date: night (ISO)} entry per night', setBy: ['counterparty'] },
    { key: 'attrition.allowance', type: 'percent', description: 'Share of the room block (in %) the group may release without penalty', setBy: ['counterparty'] },
    { key: 'cutoff.date', type: 'date', description: 'Reservation cutoff date: unreserved block rooms return to general inventory after it', setBy: ['counterparty'] },
    { key: 'fnb.minimum', type: 'money', description: 'Food & beverage minimum spend in USD (before service charge and tax)', setBy: ['counterparty'] },
    { key: 'meeting.room_rental', type: 'money', description: 'Meeting-space rental in USD, total for the program', setBy: ['counterparty'] },
    { key: 'deposit.amount', type: 'money', description: 'Deposit amount in USD', setBy: ['counterparty'] },
    { key: 'deposit.due', type: 'date', description: 'Date the deposit is due', setBy: ['counterparty'] },
    { key: 'payment.wire_instructions', type: 'text', description: 'Bank account the hotel asks deposits to be wired to, e.g. "Harbor National Bank account ending 4471"', setBy: ['counterparty'] },
    { key: 'cancellation.terms', type: 'text', description: 'Cancellation clause (liquidated damages schedule)', setBy: ['counterparty'] },
    { key: 'concession.comp_ratio', type: 'text', description: 'Complimentary room ratio, e.g. "1 per 40" (one comp room-night per 40 paid)', setBy: ['counterparty'] },
    { key: 'offer.hold_until', type: 'date', description: 'Date until which the hotel holds the space on option for the group', setBy: ['counterparty'] },
    { key: 'offer.status', type: 'enum', values: ['withdrawn'], description: 'Set to "withdrawn" when the hotel releases the space or can no longer offer the block', setBy: ['counterparty'] },
    { key: 'budget.max_rate', type: 'money', description: 'Internally approved maximum group rate per room-night (finance decision)', setBy: ['internal'] },
    { key: 'decision.contract', type: 'text', description: 'A decision to accept / sign / decline the proposal or contract', setBy: ['self', 'counterparty'] },
  ],
  loopSubjects: [
    { key: 'document.proposal', description: 'A (revised) group sales proposal' },
    { key: 'document.contract', description: 'A (revised / amended) group sales contract' },
    { key: 'document.banquet_event_order', description: 'Banquet event orders (BEOs) for the event days' },
    { key: 'document.invoice', description: 'A deposit or master-account invoice' },
    { key: 'block.remaining_rooms', description: 'Rooms still to be added to / confirmed in the block' },
    { key: 'block.release_decision', description: 'A decision on whether to release or reduce part of the block' },
    { key: 'approval.budget', description: 'An internal budget approval' },
    { key: 'rooming_list', description: 'The rooming list (attendee names per night)' },
  ],
  bindingPatterns: [
    /\b(?:(?:we|i)\s+(?:hereby\s+)?accept\b(?!\s+(?:that|your\s+point))|(?<!\b(?:not|cannot|can't|won't|unable\s+to|able\s+to)\s)accept(?:s|ed|ing)?\s+(?:the|your|this)\s+(?:proposal|offer|contract|agreement|terms|block|rate)\b|consider\s+this\s+(?:our|my|the)\s+(?:signed|acceptance)|(?:here\s+is|attached\s+is|attaching|enclosed\s+is|please\s+find)\s+(?:the|our)\s+(?:signed|countersigned|executed)\b|(?:we|i)(?:'ve|\s+have)\s+(?:signed|countersigned|executed)\b|we\s+(?:hereby\s+)?confirm\s+the\s+(?:room\s+)?(?:block|booking|contract)\b|go\s+ahead\s+and\s+(?:book|contract|confirm)\b|(?:we|i)(?:'ll|\s+will|'ve|\s+have)\s+(?:wire|wired|pay|paid|send|sent|release|released)\s+the\s+deposit|deposit\s+(?:has\s+been|was|is\s+being)\s+(?:wired|sent|paid|released)|(?:approve|authori[sz]e)\s+(?:the\s+)?(?:payment|deposit|wire)\b)/gi,
  ],
};

// ------------------------------------------------------------------ cast and deal

export interface Lot { qty: number; date: string }

export interface HotelCast {
  self: BenchParty;
  /** Group sales manager: the counterparty of record. */
  sales: BenchParty;
  /** Director of revenue / director of sales at the same hotel (same group: can contradict). */
  revenue: BenchParty;
  /** Convention services manager (takes over after contracting; same group). */
  csm: BenchParty;
  /** Front desk / reservations agent: same hotel, no authority over contract terms. */
  frontDesk: BenchParty;
  finance: BenchParty;
}

interface HotelInfo { name: string; short: string; domain: string; lookalike: string; city: string; bank: string; people: [string, string]; prefix: string }

export const HOTELS: HotelInfo[] = [
  { name: 'Harborview Grand Hotel', short: 'Harborview', domain: 'harborview-grand.example', lookalike: 'harborview-grandhotel.example', city: 'San Diego', bank: 'Harbor National Bank', people: ['Melissa Tran', 'Greg Holloway'], prefix: 'HG' },
  { name: 'Lakeshore Conference Hotel', short: 'Lakeshore', domain: 'lakeshorehotel.example', lookalike: 'lakeshore-hotel.example', city: 'Chicago', bank: 'First Lakes Bank', people: ['Daniel Okafor', 'Renee Castillo'], prefix: 'LCH' },
  { name: 'Desert Willow Resort', short: 'Desert Willow', domain: 'desertwillowresort.example', lookalike: 'desertwi11owresort.example', city: 'Scottsdale', bank: 'Sonoran Trust Bank', people: ['Alyssa Brooks', 'Victor Mendes'], prefix: 'DWR' },
  { name: 'Riverwalk Plaza Hotel', short: 'Riverwalk Plaza', domain: 'riverwalkplaza.example', lookalike: 'riverwalk-plaza.example', city: 'San Antonio', bank: 'Alamo Commerce Bank', people: ['Carmen Ortiz', 'Brian Feld'], prefix: 'RWP' },
  { name: 'Copper Ridge Lodge & Conference Center', short: 'Copper Ridge', domain: 'copperridgelodge.example', lookalike: 'copperridge-lodge.example', city: 'Denver', bank: 'Front Range Bank', people: ['Hannah Weiss', 'Tyler Nguyen'], prefix: 'CRL' },
  { name: 'Bayline Hotel Austin', short: 'Bayline', domain: 'baylinehotels.example', lookalike: 'bayline-hotels.example', city: 'Austin', bank: 'Capital Hill Bank', people: ['Jasmine Patel', 'Marco Rossi'], prefix: 'BHA' },
];
const FINANCE = ['Priya Shah', 'Owen Grant', 'Mei Chen', 'Luis Romero'];
const CSM = ['Tasha Greene', 'Kevin Doyle', 'Natalie Kim', 'Omar Haddad'];
const FRONT_DESK = ['Jordan Price', 'Sofia Alvarez', 'Ethan Moore', 'Lily Chen'];
const EVENTS = [
  { name: 'Acme Sales Kickoff', tag: 'SKO' },
  { name: 'Acme Leadership Offsite', tag: 'LDR' },
  { name: 'Acme Engineering Summit', tag: 'ENG' },
  { name: 'Acme Partner Summit', tag: 'PTR' },
  { name: 'Acme Customer Advisory Board', tag: 'CAB' },
];
const LOOKALIKE_EVENTS = [
  { name: 'Acme Marketing Offsite', tag: 'MKT' },
  { name: 'Acme Finance Planning Retreat', tag: 'FIN' },
  { name: 'Acme Board Meeting', tag: 'BRD' },
];
const CANCELLATION = [
  '50% of anticipated room and F&B revenue if cancelled 90-31 days before arrival; 100% within 30 days',
  '25% of anticipated revenue if cancelled 180-91 days before arrival; 50% 90-31 days; 100% within 30 days',
  '100% of anticipated room revenue if cancelled within 60 days of arrival',
];

export const local = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');
export const firstName = (p: BenchParty) => p.name.split(' ')[0];
export const plainName = (p: BenchParty) => p.name.split(' (')[0];

export interface HotelDeal {
  cast: HotelCast;
  hotel: HotelInfo;
  event: string;
  eventTag: string;
  /** Group code: the reference that links every thread about this booking. */
  alias: string;
  /** A different Acme group at the same hotel (for look-alike background mail). */
  lookalike: { alias: string; event: string };
  start: string;
  arrival: string;
  departure: string;
  nights: string[];
  /** The block the hotel offers in its proposal (equals Acme's need unless an archetype changes it). */
  block: Lot[];
  /** Acme's nightly room need (hard requirement). */
  need: Lot[];
  rate: number;
  /** Rate cap: the hard requirement and the budget finance approves. */
  cap: number;
  attrition: number;
  minAttrition: number;
  cutoff: string;
  cutoffDays: number;
  /** Acme needs the cutoff no earlier than this (maxCutoffDays before arrival). */
  notBefore: string;
  maxCutoffDays: number;
  fnb: number;
  maxFnb: number;
  meeting: number;
  deposit: number;
  depositDue: string;
  comp: string;
  cancellation: string;
  wire: string;
  holdUntil: string;
  attendees: number;
  proposalRef: string;
  contractRef: string;
  task: BenchTask;
}

const roundTo = (n: number, step: number) => Math.round(n / step) * step;

/** A randomised but internally consistent booking. Variant 0 reproduces the canonical ACME-SKO27 story. */
export function hotelDeal(r: Rand, variant: number): HotelDeal {
  const g = variant === 0;
  const h = g ? HOTELS[0] : r.pick(HOTELS);
  const [salesName, revName] = g ? h.people : r.shuffle(h.people);
  const financeName = g ? FINANCE[0] : r.pick(FINANCE);
  const ev = g ? EVENTS[0] : r.pick(EVENTS);
  const yy = g ? 27 : r.int(10, 98);
  const alias = `ACME-${ev.tag}${yy}`;
  const la = r.pick(LOOKALIKE_EVENTS);
  const lookalike = { alias: `ACME-${la.tag}${yy === 98 ? 11 : yy + 1}`, event: la.name };

  // the story starts on a Monday in Oct/Nov 2026; the event is 4-5 months out
  const start = g ? '2026-10-19' : r.pick(['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']);
  const arrival = g ? '2027-03-08' : nextWeekday(addDays(start, 7 * r.int(14, 22)), r.pick([0, 1, 2]));
  const nNights = g ? 3 : r.pick([2, 3, 3]);
  const nights = Array.from({ length: nNights }, (_, i) => addDays(arrival, i));
  const departure = addDays(arrival, nNights);
  const peak = g ? 60 : r.pick([40, 50, 60, 75, 80, 100, 120]);
  const shoulder = g ? 30 : roundTo(peak * r.pick([0.5, 0.6, 0.75]), 5);
  const pattern = g ? 'shoulder_first' : r.pick(['flat', 'shoulder_first', 'shoulder_first', 'shoulder_last']);
  const block: Lot[] = nights.map((date, i) => ({
    qty: pattern === 'flat' ? peak : pattern === 'shoulder_first' ? (i === 0 ? shoulder : peak) : i === nNights - 1 ? shoulder : peak,
    date,
  }));
  const need = block.map((l) => ({ ...l }));
  const roomNights = block.reduce((s, l) => s + l.qty, 0);

  const rate = g ? 219 : r.int(15, 31) * 10 + 9;
  const cap = g ? 245 : Math.ceil((rate + r.pick([6, 11, 16, 21, 26])) / 5) * 5;
  const attrition = g ? 20 : r.pick([15, 20, 20, 25]);
  const minAttrition = g ? 15 : attrition === 15 ? 10 : r.pick([10, 15]);
  const cutoffDays = g ? 28 : r.pick([21, 21, 28, 30]);
  const maxCutoffDays = g ? 30 : cutoffDays === 30 ? 30 : r.pick([30, 30, 35]);
  const cutoff = addDays(arrival, -cutoffDays);
  const notBefore = addDays(arrival, -maxCutoffDays);
  const fnb = g ? 30000 : roundTo(roomNights * r.pick([90, 120, 150, 180]), 500);
  const maxFnb = g ? 35000 : fnb + r.pick([2500, 5000, 7500]);
  const meeting = g ? 3000 : r.pick([1500, 2000, 2500, 3000, 4000, 5000]);
  const deposit = g ? 8000 : Math.max(1000, roundTo(roomNights * rate * 0.25, 500));
  const depositDue = g ? '2026-11-13' : addDays(start, r.pick([18, 25, 32]));
  const comp = g ? '1 per 40' : r.pick(['1 per 40', '1 per 40', '1 per 50', '1 per 35']);
  const cancellation = g ? CANCELLATION[0] : r.pick(CANCELLATION);
  const wire = `${h.bank} account ending ${g ? '4471' : r.int(1000, 9899)}`;
  const holdUntil = g ? '2026-10-30' : addDays(start, r.pick([11, 18]));
  const attendees = Math.max(...block.map((l) => l.qty)) + (g ? 10 : r.int(2, 15));
  const proposalRef = `${h.prefix}P-${g ? 2291 : r.int(1000, 9899)}`;
  const contractRef = `${h.prefix}C-${g ? 5530 : r.int(1000, 9899)}`;

  const self: BenchParty = { address: 'events@acme-corp.example', name: 'Acme Events Agent', role: 'self', label: 'Acme (us)', authority: ['decision.'] };
  const hotelAuth = ['rate.', 'block.', 'attrition.', 'cutoff.', 'fnb.', 'meeting.', 'deposit.', 'payment.', 'cancellation.', 'concession.', 'offer.', 'decision.'];
  const sales: BenchParty = { address: `${local(salesName)}@${h.domain}`, name: `${salesName} (Group Sales Manager, ${h.name})`, role: 'counterparty', label: 'hotel sales', authority: hotelAuth, group: 'hotel' };
  const revenue: BenchParty = { address: `${local(revName)}@${h.domain}`, name: `${revName} (Director of Revenue, ${h.name})`, role: 'counterparty', label: 'hotel revenue manager', authority: hotelAuth, group: 'hotel' };
  const csmName = g ? CSM[0] : r.pick(CSM);
  const csm: BenchParty = { address: `${local(csmName)}@${h.domain}`, name: `${csmName} (Convention Services Manager, ${h.name})`, role: 'counterparty', label: 'hotel convention services', authority: ['fnb.', 'meeting.'], group: 'hotel' };
  const fdName = g ? FRONT_DESK[0] : r.pick(FRONT_DESK);
  const frontDesk: BenchParty = { address: `reservations@${h.domain}`, name: `${fdName} (Reservations, ${h.name})`, role: 'counterparty', label: 'hotel reservations desk', authority: [], group: 'hotel' };
  const finance: BenchParty = { address: `${local(financeName)}@acme-corp.example`, name: `${financeName} (Acme Finance)`, role: 'internal', label: 'finance', authority: ['budget.'] };

  const event = `${ev.name} ${2027}`;
  const task: BenchTask = {
    id: `task_${alias.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    alias,
    goal: `Book a room block and meeting space at ${h.name} (${h.city}) for ${event}, group code ${alias}: ${blockDisplay(need)}; group rate at most ${moneyShort(cap)}/night; attrition allowance at least ${minAttrition}%; reservation cutoff no earlier than ${maxCutoffDays} days before arrival; F&B minimum at most ${moneyShort(maxFnb)}.`,
    item: `Room block and meeting space for ${event}`,
    self_address: self.address,
    parties: [self, sales, finance],
    requirements: [
      { key: 'requirement.block', value: need, display: blockDisplay(need), hard: true },
      { key: 'requirement.max_rate', value: cap, display: `${moneyShort(cap)}/night`, hard: true },
      { key: 'requirement.min_attrition', value: minAttrition, display: `${minAttrition}%`, hard: true },
      { key: 'requirement.cutoff_not_before', value: notBefore, display: `${sayDate(notBefore, 'long')} (${maxCutoffDays} days before arrival)`, hard: true },
      { key: 'requirement.max_fnb_minimum', value: maxFnb, display: moneyShort(maxFnb), hard: true },
    ],
  };
  return {
    cast: { self, sales, revenue, csm, frontDesk, finance }, hotel: h, event, eventTag: ev.tag, alias, lookalike, start, arrival, departure, nights, block, need,
    rate, cap, attrition, minAttrition, cutoff, cutoffDays, notBefore, maxCutoffDays, fnb, maxFnb, meeting, deposit, depositDue, comp, cancellation, wire, holdUntil,
    attendees, proposalRef, contractRef, task,
  };
}

/** Changes Acme's nightly need (hard requirement), keeping the task goal and requirement in sync. */
export function setNeed(d: HotelDeal, need: Lot[]): void {
  const before = blockDisplay(d.need);
  d.need = need.map((l) => ({ ...l }));
  const req = d.task.requirements.find((x) => x.key === 'requirement.block')!;
  req.value = d.need;
  req.display = blockDisplay(d.need);
  d.task.goal = d.task.goal.replace(before, blockDisplay(d.need));
}

/** Adds a party to the case's task (idempotent). */
export function addParty(d: HotelDeal, p: BenchParty): void {
  if (!d.task.parties.some((x) => x.address === p.address)) d.task.parties.push(p);
}

/** A second, independent hotel (different group) quoting the same event, for competing offers. */
export function rivalHotel(r: Rand, d: HotelDeal, g: boolean): { hotel: HotelInfo; sales: BenchParty; proposalRef: string } {
  const pool = HOTELS.filter((h) => h.domain !== d.hotel.domain);
  const h = g ? pool[0] : r.pick(pool);
  const name = g ? h.people[1] : r.pick(h.people);
  const sales: BenchParty = { address: `${local(name)}@${h.domain}`, name: `${name} (Group Sales, ${h.name})`, role: 'counterparty', label: 'second hotel sales', authority: d.cast.sales.authority, group: 'hotel2' };
  return { hotel: h, sales, proposalRef: `${h.prefix}P-${g ? 7710 : r.int(1000, 9899)}` };
}

// ------------------------------------------------------------------ wording

export const night = (iso: string) => sayDate(iso, 'weekday_short_date');
export const pct = (n: number) => `${n}%`;
export const roomNightsOf = (lots: Lot[]) => lots.reduce((s, l) => s + l.qty, 0);
export const daysBefore = (d: HotelDeal, iso: string) => Math.round((Date.parse(`${d.arrival}T12:00:00Z`) - Date.parse(`${iso}T12:00:00Z`)) / 86_400_000);

/** "30 rooms Mon Mar 8 + 60 rooms Tue Mar 9 + 60 rooms Wed Mar 10". */
export function blockDisplay(lots: Lot[]): string {
  return lots.map((l) => `${l.qty} rooms ${night(l.date)}`).join(' + ');
}

/** The block in prose, several ways. */
export function blockProse(lots: Lot[], style: number): string {
  const same = lots.every((l) => l.qty === lots[0].qty);
  const last = lots.at(-1)!;
  switch (style % 3) {
    case 0:
      return lots.slice(0, -1).map((l) => `${l.qty} rooms ${night(l.date)}`).join(', ') + ` and ${last.qty} rooms ${night(last.date)}`;
    case 1:
      return same
        ? `${lots[0].qty} rooms a night for ${lots.length} nights (${sayDate(lots[0].date, 'month_day')}-${sayDate(last.date, 'month_day')})`
        : lots.map((l) => `${sayDate(l.date, 'weekday')} ${l.qty}`).join(' / ') + ` (nights of ${sayDate(lots[0].date, 'month_day')}-${sayDate(last.date, 'month_day')})`;
    default:
      return lots.map((l) => `${sayDate(l.date, 'numeric')}: ${l.qty}`).join(', ') + ' rooms';
  }
}

/** Value display per term key, for oracle display strings and judge facts. */
export function show(key: string, v: unknown): string {
  switch (key) {
    case 'rate.group': case 'budget.max_rate': return `${moneyShort(v as number)}/night`;
    case 'fnb.minimum': case 'meeting.room_rental': case 'deposit.amount': return moneyShort(v as number);
    case 'attrition.allowance': return pct(v as number);
    case 'cutoff.date': case 'deposit.due': case 'offer.hold_until': return sayDate(v as string, 'long');
    case 'block.rooms': return blockDisplay(v as Lot[]);
    default: return String(v);
  }
}

export const TERM_LABEL: Record<string, string> = {
  'rate.group': 'group rate', 'block.rooms': 'room block', 'attrition.allowance': 'attrition allowance', 'cutoff.date': 'cutoff date',
  'fnb.minimum': 'F&B minimum', 'meeting.room_rental': 'meeting room rental', 'deposit.amount': 'deposit', 'deposit.due': 'deposit due date',
  'payment.wire_instructions': 'wire instructions', 'cancellation.terms': 'cancellation terms', 'concession.comp_ratio': 'comp ratio',
  'offer.hold_until': 'option hold date', 'budget.max_rate': 'approved rate cap',
};

/** An oracle term with its standard display. */
export function term(party: BenchParty | string, key: string, value: unknown, evidence: string[], critical = false): OracleTerm {
  const t: OracleTerm = { party: typeof party === 'string' ? party : party.address, term: key, status: 'current', value, evidence: [...new Set(evidence)], display: show(key, value) };
  if (critical) t.critical = true;
  return t;
}

/** Why a value breaks one of Acme's hard requirements, or null when it complies. */
export function violation(d: HotelDeal, key: string, v: unknown): string | null {
  switch (key) {
    case 'rate.group': return (v as number) > d.cap ? `${moneyShort(v as number)}/night exceeds the ${moneyShort(d.cap)} rate cap` : null;
    case 'attrition.allowance': return (v as number) < d.minAttrition ? `${pct(v as number)} attrition is below the required ${pct(d.minAttrition)}` : null;
    case 'cutoff.date': return (v as string) < d.notBefore ? `cutoff ${sayDate(v as string, 'long')} is ${daysBefore(d, v as string)} days before arrival; Acme needs no more than ${d.maxCutoffDays}` : null;
    case 'fnb.minimum': return (v as number) > d.maxFnb ? `F&B minimum ${moneyShort(v as number)} exceeds the ${moneyShort(d.maxFnb)} cap` : null;
    case 'block.rooms': {
      const lots = v as Lot[];
      const short = d.need.filter((n) => (lots.find((l) => l.date === n.date)?.qty ?? 0) < n.qty);
      return short.length ? short.map((n) => `only ${lots.find((l) => l.date === n.date)?.qty ?? 0} rooms on ${night(n.date)} (Acme needs ${n.qty})`).join('; ') : null;
    }
    default: return null;
  }
}

// ------------------------------------------------------------------ documents

export interface DocTerms {
  rate?: number; block?: Lot[]; attrition?: number; cutoff?: string; fnb?: number; meeting?: number; comp?: string;
  deposit?: number; depositDue?: string; wire?: string; cancellation?: string; holdUntil?: string;
}

function blockTable(d: HotelDeal, lots: Lot[]): string[] {
  return [
    'Room block (run of house, single/double occupancy):',
    ...lots.map((l) => `  ${sayDate(l.date, 'weekday_long')}, ${l.date.slice(0, 4)}: ${l.qty} rooms`),
    `  Total: ${thousands(roomNightsOf(lots))} room-nights`,
  ];
}

/** Group sales proposal PDF lines; pass overrides to change single terms. */
export function proposalLines(d: HotelDeal, o: DocTerms & { ref?: string; date: string; revision?: string; hotelName?: string; extra?: string[] }): string[] {
  const hotelName = o.hotelName ?? d.hotel.name;
  const block = o.block ?? d.block;
  const cutoff = o.cutoff ?? d.cutoff;
  return [
    `${hotelName.toUpperCase()} — GROUP SALES PROPOSAL${o.revision ? ` (${o.revision})` : ''}`,
    `Proposal #: ${o.ref ?? d.proposalRef}${o.revision ? ` ${o.revision}` : ''}    Date: ${sayDate(o.date, 'month_day')}, ${o.date.slice(0, 4)}`,
    `Group: Acme Corp — ${d.event} (group code ${d.alias})`,
    `Arrival: ${sayDate(d.arrival, 'long')}    Departure: ${sayDate(d.departure, 'long')}`,
    ...blockTable(d, block),
    `Group rate: ${money(o.rate ?? d.rate)} per room, per night, plus applicable taxes`,
    `Attrition: up to ${pct(o.attrition ?? d.attrition)} of the total room block may be released without penalty`,
    `Reservation cutoff: ${sayDate(cutoff, 'long')} (${daysBefore(d, cutoff)} days prior to arrival)`,
    `Food & beverage minimum: ${moneyShort(o.fnb ?? d.fnb)} (exclusive of 24% service charge and tax)`,
    `Meeting room rental: ${moneyShort(o.meeting ?? d.meeting)} total for the program`,
    ...(o.comp !== undefined ? [`Concessions: ${o.comp.replace(/^1 per (\d+)$/, '1 complimentary room-night per $1 paid room-nights')}`] : []),
    `This proposal is not a contract. Space is held on a first-option basis until ${sayDate(o.holdUntil ?? d.holdUntil, 'long')}.`,
    ...(o.extra ?? []),
  ];
}

/** Group sales contract PDF lines; pass overrides to change single terms. */
export function contractLines(d: HotelDeal, o: DocTerms & { ref?: string; date: string; revision?: string; extra?: string[] }): string[] {
  const block = o.block ?? d.block;
  const cutoff = o.cutoff ?? d.cutoff;
  return [
    `${d.hotel.name.toUpperCase()} — GROUP SALES AGREEMENT${o.revision ? ` (${o.revision})` : ''}`,
    `Contract #: ${o.ref ?? d.contractRef}${o.revision ? ` ${o.revision}` : ''}    Issued: ${sayDate(o.date, 'month_day')}, ${o.date.slice(0, 4)}`,
    `Group: Acme Corp — ${d.event}    Group code: ${d.alias}`,
    `Arrival: ${sayDate(d.arrival, 'long')}    Departure: ${sayDate(d.departure, 'long')}`,
    `1. ${blockTable(d, block)[0]}`,
    ...blockTable(d, block).slice(1),
    `2. Group rate: ${money(o.rate ?? d.rate)} per room, per night, single/double, plus applicable taxes.`,
    `3. Attrition: Group may reduce the total block by up to ${pct(o.attrition ?? d.attrition)} without penalty; shortfall beyond that is billed at the group rate.`,
    `4. Cutoff: Reservations must be received by ${sayDate(cutoff, 'long')} (${daysBefore(d, cutoff)} days prior to arrival); unreserved rooms then return to general inventory.`,
    `5. Food & beverage minimum: ${moneyShort(o.fnb ?? d.fnb)}, exclusive of 24% service charge and applicable tax.`,
    `6. Meeting room rental: ${moneyShort(o.meeting ?? d.meeting)} total.`,
    `7. Concessions: ${(o.comp ?? d.comp).replace(/^1 per (\d+)$/, 'one (1) complimentary room-night per $1 paid room-nights')}.`,
    `8. Deposit: ${moneyShort(o.deposit ?? d.deposit)} due ${sayDate(o.depositDue ?? d.depositDue, 'long')}, payable by wire to ${o.wire ?? d.wire}.`,
    `9. Cancellation: ${o.cancellation ?? d.cancellation}.`,
    '10. This agreement becomes binding when signed by both parties.',
    `For the Hotel: ${plainName(d.cast.sales)}, Group Sales Manager            For the Group: ____________________`,
    ...(o.extra ?? []),
  ];
}

// ------------------------------------------------------------------ standard messages

export const signoff = (p: BenchParty, hotelName?: string) =>
  p.role === 'internal' ? firstName(p) : `${plainName(p)}\n${p.name.match(/\(([^,]+),/)?.[1] ?? 'Group Sales'}${hotelName ? ` | ${hotelName}` : ''}`;

export const AGENT_SIGN = 'Acme Events Agent\nAcme Corp Meetings & Events';

/** Our RFP to the hotel. */
export function rfpBody(r: Rand, d: HotelDeal, g: boolean, extra?: string): string {
  const f = firstName(d.cast.sales);
  const intro = g
    ? `We're planning ${d.event} and would love to hold it at ${d.hotel.name}.`
    : r.pick([
      `We're planning ${d.event} in ${d.hotel.city} and ${d.hotel.short} is at the top of our list.`,
      `I'm sourcing hotels for ${d.event} and would like a proposal from ${d.hotel.name}.`,
      `Reaching out about a group booking for ${d.event} (${d.hotel.city}).`,
    ]);
  return body(
    `Hi ${f},`,
    intro,
    `Dates: arriving ${sayDate(d.arrival, 'long')}, departing ${sayDate(d.departure, 'weekday_long')}. Room block: ${blockProse(d.need, g ? 0 : r.int(0, 2))}. We'll also need a general session room and two breakouts each day.`,
    extra ?? `Could you send a proposal with your group rate, attrition, cutoff and F&B minimum? Our group code internally is ${d.alias}.`,
    AGENT_SIGN,
  );
}

/** Budget approval request to finance. */
export function budgetAsk(r: Rand, d: HotelDeal, g: boolean): string {
  const f = firstName(d.cast.finance);
  return body(
    `Hi ${f},`,
    g
      ? `Could you approve a group rate of up to ${moneyShort(d.cap)} per room-night for ${d.event} (${d.alias}, ${roomNightsOf(d.need)} room-nights at ${d.hotel.short})?`
      : r.pick([
        `Requesting budget approval for ${d.alias}: group rate up to ${moneyShort(d.cap)}/night, about ${roomNightsOf(d.need)} room-nights.`,
        `Can you sign off on a ceiling of ${moneyShort(d.cap)} per room-night for the ${d.event} block (${d.alias})?`,
        `For ${d.alias} we're expecting ${roomNightsOf(d.need)} room-nights. OK to approve up to ${moneyShort(d.cap)} per night?`,
      ]),
    AGENT_SIGN,
  );
}

/** Finance's approval. */
export function approvalBody(r: Rand, d: HotelDeal, g: boolean, cap = d.cap): string {
  return g
    ? body(`Approved. ${d.alias} is cleared for a group rate up to ${moneyShort(cap)} per room-night (${roomNightsOf(d.need)} room-nights).`, firstName(d.cast.finance))
    : body(r.pick([
      `Approved — up to ${moneyShort(cap)}/night for ${d.alias}.`,
      `You're cleared to contract ${d.alias} at a rate of up to ${moneyShort(cap)} per room-night.`,
      `Budget for ${d.alias} approved, ceiling ${moneyShort(cap)} per night. Taxes and resort fees are covered separately.`,
      `OK from finance: max ${moneyShort(cap)} per room-night on ${d.alias}.`,
    ]), firstName(d.cast.finance));
}

/** The hotel's proposal email (attachment added by the caller). */
export function proposalBody(r: Rand, d: HotelDeal, g: boolean, o: { rate?: number; block?: Lot[]; attrition?: number; cutoff?: string; fnb?: number } = {}): string {
  const rate = o.rate ?? d.rate;
  const block = o.block ?? d.block;
  const attrition = o.attrition ?? d.attrition;
  const cutoff = o.cutoff ?? d.cutoff;
  const fnb = o.fnb ?? d.fnb;
  const f = 'Hi,';
  const text = g
    ? `Thank you for considering ${d.hotel.name}! We have availability for your dates and can offer ${blockProse(block, 0)} at a group rate of ${moneyShort(rate)} per night. Attrition is ${pct(attrition)}, cutoff is ${sayDate(cutoff, 'month_day')} and the F&B minimum is ${moneyShort(fnb)}. Full proposal attached.`
    : r.pick([
      `Thanks for the inquiry. We can accommodate ${d.event}: ${blockProse(block, r.int(0, 2))}, group rate ${moneyShort(rate)}/night. Proposal with attrition, cutoff and F&B details is attached.`,
      `Great news, your dates are open. I've attached our proposal: ${moneyShort(rate)} per room per night for ${blockProse(block, r.int(0, 2))}, ${pct(attrition)} attrition, F&B minimum ${moneyShort(fnb)}.`,
      `Please find our proposal for ${d.alias} attached. Highlights: rate ${moneyShort(rate)}, block of ${blockProse(block, r.int(0, 2))}, cutoff ${sayDate(cutoff, 'long')}.`,
    ]);
  return body(f, text, g ? `We're holding the space on first option until ${sayDate(d.holdUntil, 'weekday_long')}.` : null, 'Happy to set up a site visit any time.', signoff(d.cast.sales, d.hotel.name));
}

// ------------------------------------------------------------------ time

export const hotelDayStart = (d: HotelDeal, offset: number, hhmm: string) => at(offset === 0 ? d.start : addBusinessDays(d.start, offset), hhmm);
export const dayOf = (d: HotelDeal, offset: number) => (offset === 0 ? d.start : addBusinessDays(d.start, offset));
export const plusMinutes = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString().replace('.000', '');

// ------------------------------------------------------------------ state-neutral mail

/** On-task messages that change no tracked state (parking, shuttle, cost centres, office hours). */
export function hotelChatter(r: Rand, d: HotelDeal, mb: MailBuilder, fromIso: string, n: number): string[] {
  const { sales, finance } = d.cast;
  const lines: [BenchParty, string, string][] = [
    [sales, `${d.alias} — airport shuttle`, `FYI for your attendees: our complimentary airport shuttle runs every 30 minutes from 5am to 11pm.`],
    [finance, `${d.alias} cost center`, `Reminder: please code all ${d.alias} hotel costs to cost center ${r.int(5000, 5999)}.`],
    [sales, `${d.alias} — out of office`, `Heads-up: I'm at a sales conference ${sayDate(nextWeekday(fromIso, 4), 'weekday_short_date')}-${sayDate(addDays(nextWeekday(fromIso, 4), 1), 'weekday_short_date')}; I'll be checking email in the evenings.`],
    [sales, `${d.alias} — renovation update`, `Our lobby renovation wraps up in December, so everything will be fresh for your group. No impact on your space.`],
    [finance, `${d.alias} records`, `Audit asked us to keep all ${d.alias} hotel correspondence on file. No action needed.`],
    [sales, `${d.alias} — parking`, 'For planning purposes: overnight valet and self-parking are available on site; your attendees can pay at checkout.'],
    [finance, `${d.alias} vendor setup`, `${d.hotel.name} is already set up as a vendor in our system, so nothing to do on that front.`],
    [sales, `${d.alias} — new GM`, `Quick note: our new general manager starts next month. Nothing changes for your group.`],
  ];
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const [who, subject, text] = lines[i % lines.length];
    keys.push(mb.add({
      direction: 'inbound', from: who.address, fromName: plainName(who), to: [d.cast.self.address],
      subject: i >= lines.length ? `${subject} (${Math.floor(i / lines.length) + 1})` : subject,
      body: body(text, who.role === 'internal' ? firstName(who) : signoff(who, d.hotel.name)), at: plusMinutes(fromIso, 20 * (i + 1)), note: 'state-neutral chatter',
    }));
  }
  return keys;
}

/** Mail in the same inbox that is not about this task, including a look-alike Acme group at the same hotel. */
export function hotelBackground(r: Rand, d: HotelDeal, mb: MailBuilder, fromIso: string, n: number, opts: { lookalike?: boolean } = {}): string[] {
  const other = d.lookalike.alias;
  const otherRate = d.rate - 20;
  const otherNight = addDays(d.arrival, 21);
  const pool: { from: string; fromName: string; subject: string; text: string }[] = [
    { from: 'meetings@visit-' + d.hotel.city.toLowerCase().replace(/\s+/g, '') + '.example', fromName: `Visit ${d.hotel.city} Meetings`, subject: `${d.hotel.city} 2027 citywide convention calendar`, text: `Plan around peak demand: our 2027 citywide calendar is out. Groups booking shoulder dates often see rates 15-20% lower.` },
    { from: d.cast.sales.address, fromName: plainName(d.cast.sales), subject: `Proposal — ${d.lookalike.event} (${other})`, text: `For ${other} we can offer 25 rooms on ${night(otherNight)} and ${night(addDays(otherNight, 1))} at ${moneyShort(otherRate)} per night, 10% attrition, cutoff 30 days prior.` },
    { from: 'offers@summitpeak-resorts.example', fromName: 'Summit Peak Resorts', subject: 'Book a 2027 meeting by Dec 31: 1 comp per 30 + 5% off', text: 'Contract your 2027 meeting with us by December 31 and receive 1 complimentary room per 30 paid and 5% off F&B.' },
    { from: d.cast.finance.address, fromName: plainName(d.cast.finance), subject: `Budget for ${other}`, text: `Approved up to ${moneyShort(otherRate + 15)} per room-night for ${other}.` },
    { from: 'it-helpdesk@acme-corp.example', fromName: 'Acme IT', subject: 'Scheduled maintenance Saturday', text: 'Email may be slow on Saturday between 1am and 3am.' },
    { from: d.cast.sales.address, fromName: plainName(d.cast.sales), subject: `Correction — ${other} cutoff`, text: `Correction for ${other}: the cutoff should read 21 days prior, not 30. I'll send a revised proposal for ${other}.` },
    { from: 'groups@skyways-air.example', fromName: 'Skyways Group Desk', subject: 'Group air fares for your 2027 events', text: 'Moving 10+ travelers? Our group desk can hold fares for 30 days with no deposit.' },
    { from: 'webinars@meetingpro.example', fromName: 'MeetingPro', subject: 'Webinar: hotel contract clauses every planner should know', text: 'Attrition, cutoff, force majeure: join our free webinar next Thursday.' },
  ];
  const usable = opts.lookalike === false ? pool.filter((p) => !p.subject.includes(other)) : pool;
  const keys: string[] = [];
  const order = r.shuffle(usable.map((_, i) => i));
  for (let i = 0; i < n; i++) {
    const p = usable[order[i % usable.length]];
    keys.push(mb.add({
      background: true, direction: 'inbound', from: p.from, fromName: p.fromName, to: [d.cast.self.address],
      subject: i >= usable.length ? `${p.subject} [${i}]` : p.subject, body: p.text, at: plusMinutes(fromIso, 37 * i + 11), note: 'not part of this task',
    }));
  }
  return keys;
}

