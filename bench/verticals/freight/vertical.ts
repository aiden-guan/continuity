// Freight brokerage (truckload): Acme Logistics' booking agent covers loads for Acme's shipper customers
// by email with carriers (dispatcher + driver, one group), the receiving warehouse (its own group), Acme
// operations (internal, owns the carrier-cost budget) and, for competing quotes, a second carrier. The term
// keys are the benchmark's own definition of what a freight broker tracks; nothing is imported from the
// engine. No Continuity "freight" pack exists yet, so the harness reports that condition as unsupported.
import type { BenchCase, BenchParty, BenchTask, Capability, Checkpoint, OracleSuperseded, OracleTerm, VerticalSpec } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, at, body, moneyShort, sayDate, sayTime, thousands } from '../../core/util.ts';

export const freight: VerticalSpec = {
  id: 'freight',
  name: 'Freight brokerage (truckload)',
  agentRole: "You are Acme Logistics' booking agent: you cover truckload shipments for Acme's shipper customers by email with carriers, receivers and Acme operations.",
  continuityDomain: 'freight',
  terms: [
    { key: 'rate.linehaul', type: 'money', description: 'Carrier linehaul rate for the load in USD (excluding fuel and accessorials)', setBy: ['counterparty'] },
    { key: 'rate.fuel_surcharge', type: 'money', description: 'Fuel surcharge for the load in USD (flat amount)', setBy: ['counterparty'] },
    { key: 'rate.all_in', type: 'money', description: 'All-in carrier rate for the load in USD (linehaul + fuel); for multi-load commitments, per load', setBy: ['counterparty'] },
    { key: 'accessorial.detention_per_hour', type: 'money', description: 'Detention pay per hour after free time, USD', setBy: ['counterparty'] },
    { key: 'pickup.window', type: 'window', description: "Window in which the carrier's truck will be at the shipper to load, local time {start,end}", setBy: ['counterparty'] },
    { key: 'delivery.eta', type: 'datetime', description: "Carrier's committed or currently estimated arrival at the consignee, local time", setBy: ['counterparty'] },
    { key: 'delivery.appointment', type: 'datetime', description: "Delivery appointment at the consignee's dock, set by the receiver, local time", setBy: ['counterparty'] },
    { key: 'equipment.type', type: 'enum', values: ['dry_van', 'reefer', 'flatbed'], description: 'Trailer type the carrier will use', setBy: ['counterparty'] },
    { key: 'equipment.reefer_temp_f', type: 'number', description: 'Reefer set point in °F the carrier commits to run', setBy: ['counterparty'] },
    { key: 'load.weight_lbs', type: 'number', description: 'Load weight in lbs', setBy: ['counterparty', 'self'] },
    { key: 'capacity.loads', type: 'lots', description: 'Trucks/loads the carrier commits for a multi-load shipment, as {qty, date} with the pickup date of each group', setBy: ['counterparty'] },
    { key: 'carrier.mc_number', type: 'text', description: "Carrier's MC (operating authority) number", setBy: ['counterparty'] },
    { key: 'payment.remit_to', type: 'text', description: 'Where the carrier is paid (the carrier itself or its factoring company); a classic fraud target', setBy: ['counterparty'] },
    { key: 'payment.terms', type: 'text', description: 'Carrier payment terms, e.g. "Net 30" or "Quick pay 2%, 5 days"', setBy: ['counterparty'] },
    { key: 'offer.status', type: 'enum', values: ['withdrawn'], description: 'Set to "withdrawn" when the carrier cancels / falls off the load or withdraws its quote', setBy: ['counterparty'] },
    { key: 'budget.max_all_in', type: 'money', description: 'Internally approved maximum all-in carrier cost for the load (Acme ops decision)', setBy: ['internal'] },
    { key: 'decision.tender', type: 'text', description: 'A decision to book / tender / decline the load (e.g. "booked")', setBy: ['self', 'counterparty'] },
  ],
  loopSubjects: [
    { key: 'document.rate_confirmation', description: "A rate confirmation for the load (here the carrier issues its own load & rate confirmation; revised or signed copies count too)" },
    { key: 'document.bol', description: 'A bill of lading' },
    { key: 'document.pod', description: 'Proof of delivery' },
    { key: 'document.w9_coi', description: "The carrier's setup packet: W-9, certificate of insurance, MC authority" },
    { key: 'document.invoice', description: "The carrier's invoice" },
    { key: 'delivery.remaining_loads', description: 'Loads of a multi-load commitment still to be picked up / delivered' },
    { key: 'eta.update', description: 'A tracking / ETA update on a load in transit' },
    { key: 'approval.budget', description: 'An internal approval of the carrier cost' },
  ],
  bindingPatterns: [
    /\b((?:we|i)\s+(?:hereby\s+)?accept\b|accept(?:s|ed|ing)?\s+(?:your|the|this)\s+(?:offer|quote|rate|load|tender|rate con(?:firmation)?)\b|(?:you(?:'re| are)|you(?:'ve| have) been)\s+(?:booked|confirmed)\b|(?:load|it)(?:'s| is)\s+(?:booked|yours)\b|(?:let's|we(?:'ll| will)|go ahead and)\s+book\b|book(?:ing)?\s+(?:it|the load|this load|you)\b|tender(?:ing|ed)?\s+(?:the|this)\s+load\s+to\s+you|we\s+confirm\s+the\s+(?:rate|load|booking)|(?:signed|countersigned)\s+(?:the\s+)?rate con|release\s+(?:the\s+)?payment|(?:we(?:'ve| have)|i(?:'ve| have))\s+(?:updated|changed)\s+(?:the\s+|your\s+)?remit|approve\s+(?:the\s+)?payment|wire\s+(?:the\s+)?funds)/gi,
  ],
};

// ------------------------------------------------------------------ time, windows and wording

export interface Win { start: string; end: string }
/** Local datetime "YYYY-MM-DDTHH:MM". */
export const dt = (day: string, hhmm: string) => `${day}T${hhmm}`;
export const win = (day: string, from: string, to: string): Win => ({ start: dt(day, from), end: dt(day, to) });
export const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
export const hourOf = (x: string) => Number(x.slice(11, 13));
export const dayOf = (x: string) => x.slice(0, 10);
export const timeOf = (x: string) => x.slice(11, 16);
/** Military time, the way dispatchers write it: "0600". */
export const mil = (hhmm: string) => hhmm.replace(':', '');

/** Four ways a pickup window is written in freight mail. */
export function sayWin(w: Win, k = 0): string {
  const day = dayOf(w.start);
  const s = timeOf(w.start);
  const e = timeOf(w.end);
  switch (k % 4) {
    case 0: return `${sayDate(day, 'weekday_short_date')} ${sayTime(s)}–${sayTime(e)}`;
    case 1: return `between ${sayTime(s)} and ${sayTime(e)} on ${sayDate(day, 'weekday_long')}`;
    case 2: return `${sayDate(day, 'weekday').slice(0, 3)} ${sayDate(day, 'numeric')} ${mil(s)}-${mil(e)}`;
    default: return `${sayDate(day, 'weekday')} (${sayDate(day, 'month_day')}) ${sayTime(s)} to ${sayTime(e)}`;
  }
}

/** Four ways a delivery date-time is written. */
export function sayDT(x: string, k = 0): string {
  const day = dayOf(x);
  const t = timeOf(x);
  switch (k % 4) {
    case 0: return `${sayDate(day, 'weekday_short_date')} at ${sayTime(t)}`;
    case 1: return `${sayDate(day, 'weekday_long')}, ${sayTime(t)}`;
    case 2: return `${sayDate(day, 'weekday').slice(0, 3)} ${sayDate(day, 'numeric')} @ ${mil(t)}`;
    default: return `${sayTime(t)} ${sayDate(day, 'weekday')} (${sayDate(day, 'month_day')})`;
  }
}

export type Equipment = 'dry_van' | 'reefer' | 'flatbed';
export const EQ_NAME: Record<Equipment, string> = { dry_van: "53' dry van", reefer: "53' reefer", flatbed: "48' flatbed" };
export const sayTemp = (f: number) => `${f}°F`;

/** Oracle display for a term value. */
export function show(key: string, v: unknown): string {
  switch (key) {
    case 'pickup.window': return sayWin(v as Win);
    case 'delivery.eta':
    case 'delivery.appointment': return sayDT(v as string);
    case 'equipment.type': return EQ_NAME[v as Equipment] ?? String(v);
    case 'equipment.reefer_temp_f': return sayTemp(v as number);
    case 'load.weight_lbs': return `${thousands(v as number)} lbs`;
    case 'accessorial.detention_per_hour': return `${moneyShort(v as number)}/hr`;
    case 'capacity.loads': return (v as { qty: number; date: string }[]).map((l) => `${l.qty} load${l.qty === 1 ? '' : 's'} ${sayDate(l.date, 'weekday_short_date')}`).join(' + ');
    default: return typeof v === 'number' ? moneyShort(v) : String(v);
  }
}

/** A current term. */
export const cur = (party: string, term: string, value: unknown, evidence: string[], critical = false): OracleTerm =>
  ({ party, term, status: 'current', value, evidence: [...new Set(evidence)], ...(critical ? { critical: true } : {}), display: show(term, value) });
/** A term that must not be reported as current. */
export const absent = (party: string, term: string, display: string, evidence: string[], critical = false): OracleTerm =>
  ({ party, term, status: 'absent', evidence, ...(critical ? { critical: true } : {}), display });
/** A dead value. */
export const dead = (party: string, term: string, value: unknown, evidence: string[], by: string): OracleSuperseded =>
  ({ party, term, value, display: show(term, value), evidence, superseded_by: by });

// ------------------------------------------------------------------ the cast

export interface FreightCast {
  self: BenchParty;
  /** Carrier dispatcher: the counterparty who quotes and commits. */
  dispatcher: BenchParty;
  /** The carrier's driver (same group: may contradict on pickup / ETA, has no rate authority). */
  driver: BenchParty;
  /** Receiving warehouse at the consignee (own group; sets the delivery appointment). */
  receiver: BenchParty;
  /** Acme operations manager: approves carrier spend. */
  ops: BenchParty;
  /** A second, independent carrier (competing quotes). */
  carrier2: BenchParty;
}

interface CarrierInfo { company: string; short: string; domain: string; people: [string, string]; mc: string; remit: string; spoof: string; eq?: Equipment[] }

export const CARRIERS: CarrierInfo[] = [
  { company: 'Ridgeline Transport', short: 'Ridgeline', domain: 'ridgeline-transport.example', people: ['Carla Mendez', 'Ray Dobbs'], mc: '784512', remit: 'Ridgeline Transport LLC, PO Box 2290, Fresno, CA 93745', spoof: 'ridgeline-transports.example' },
  { company: 'Blue Mesa Freight', short: 'BlueMesa', domain: 'bluemesafreight.example', people: ['Tom Haskins', 'Luis Ortega'], mc: '1093347', remit: 'Apex Freight Funding (factor for Blue Mesa Freight), PO Box 51870, Dallas, TX 75251', spoof: 'bluemesa-freight.example' },
  { company: 'Iron Prairie Carriers', short: 'IronPrairie', domain: 'ironprairie.example', people: ['Dee Walters', 'Mike Kowalski'], mc: '662081', remit: 'Iron Prairie Carriers Inc, 1800 Depot Rd, Salina, KS 67401', spoof: 'iron-prairie.example' },
  { company: 'Coastline Haulers', short: 'Coastline', domain: 'coastlinehaulers.example', people: ['Nina Patel', 'Gus Romero'], mc: '958224', remit: 'Harbor Capital Factoring (for Coastline Haulers), PO Box 7731, Tampa, FL 33673', spoof: 'coastline-haulers.example' },
  { company: 'Summit Reefer Lines', short: 'Summit', domain: 'summitreefer.example', people: ['Jake Brennan', 'Andre Wilkins'], mc: '1127690', remit: 'Summit Reefer Lines LLC, PO Box 418, Ogden, UT 84402', spoof: 'summit-reefers.example', eq: ['reefer'] },
  { company: 'Lone Oak Logistics', short: 'LoneOak', domain: 'loneoaklogistics.example', people: ['Becky Tran', 'Hector Diaz'], mc: '845309', remit: 'Lone Oak Logistics LLC, 4410 Mill Creek Dr, Tyler, TX 75703', spoof: 'loneoak-logistics.example' },
];

interface Lane { origin: string; dest: string; miles: number; transit: number; via: string; near: string; goods: string[] }
export const LANES: Lane[] = [
  { origin: 'Fresno, CA', dest: 'Denver, CO', miles: 1160, transit: 2, via: 'Grand Junction', near: 'Bakersfield', goods: ['fresh table grapes', 'canned tomatoes', 'fresh strawberries'] },
  { origin: 'Salinas, CA', dest: 'Phoenix, AZ', miles: 720, transit: 1, via: 'Blythe', near: 'Watsonville', goods: ['romaine lettuce', 'fresh strawberries'] },
  { origin: 'Laredo, TX', dest: 'Chicago, IL', miles: 1360, transit: 3, via: 'Joplin', near: 'San Antonio', goods: ['fresh avocados', 'steel coils', 'canned tomatoes'] },
  { origin: 'Atlanta, GA', dest: 'Columbus, OH', miles: 570, transit: 1, via: 'Knoxville', near: 'Macon', goods: ['frozen chicken', 'paper towels', 'bottled water'] },
  { origin: 'Dallas, TX', dest: 'Memphis, TN', miles: 455, transit: 1, via: 'Texarkana', near: 'Waco', goods: ['bottled water', 'steel coils', 'paper towels'] },
  { origin: 'Allentown, PA', dest: 'Charlotte, NC', miles: 560, transit: 1, via: 'Harrisonburg', near: 'Harrisburg', goods: ['paper towels', 'yogurt and dairy', 'bottled water'] },
  { origin: 'Yakima, WA', dest: 'Salt Lake City, UT', miles: 690, transit: 1, via: 'Boise', near: 'Wenatchee', goods: ['fresh apples', 'bundled lumber'] },
  { origin: 'Savannah, GA', dest: 'Nashville, TN', miles: 500, transit: 1, via: 'Chattanooga', near: 'Jacksonville', goods: ['paper towels', 'steel coils', 'frozen chicken', 'bottled water'] },
];

interface Commodity { name: string; eq: Equipment; temp: number | null; weight: number; shipper: string }
export const COMMODITIES: Commodity[] = [
  { name: 'fresh table grapes', eq: 'reefer', temp: 34, weight: 40000, shipper: 'Valley Fresh Produce' },
  { name: 'frozen chicken', eq: 'reefer', temp: -10, weight: 42000, shipper: 'Pioneer Poultry' },
  { name: 'yogurt and dairy', eq: 'reefer', temp: 36, weight: 38000, shipper: 'Clearbrook Dairy' },
  { name: 'fresh strawberries', eq: 'reefer', temp: 33, weight: 36000, shipper: 'Coastal Berry Farms' },
  { name: 'paper towels', eq: 'dry_van', temp: null, weight: 18000, shipper: 'Heartland Paper Co' },
  { name: 'canned tomatoes', eq: 'dry_van', temp: null, weight: 43000, shipper: 'Sunbelt Canning' },
  { name: 'bottled water', eq: 'dry_van', temp: null, weight: 44000, shipper: 'Pure Spring Beverages' },
  { name: 'steel coils', eq: 'flatbed', temp: null, weight: 45000, shipper: 'Great Lakes Steel Supply' },
  { name: 'bundled lumber', eq: 'flatbed', temp: null, weight: 44000, shipper: 'Cascade Lumber Co' },
  { name: 'romaine lettuce', eq: 'reefer', temp: 34, weight: 38000, shipper: 'Salinas Valley Greens' },
  { name: 'fresh avocados', eq: 'reefer', temp: 42, weight: 40000, shipper: 'Rio Bravo Produce' },
  { name: 'fresh apples', eq: 'reefer', temp: 34, weight: 42000, shipper: 'Orchard Ridge Fruit' },
];

const CONSIGNEES = [
  { company: 'Front Range Foods DC', domain: 'frontrangefoods.example', contact: 'Tasha Reid' },
  { company: 'Midstate Grocers DC', domain: 'midstategrocers.example', contact: 'Paul Novak' },
  { company: 'Keystone Distribution', domain: 'keystonedist.example', contact: 'Arlene Ruiz' },
  { company: 'Bluegrass Supply Hub', domain: 'bluegrasshub.example', contact: 'Devon Hart' },
];
const OPS = ['Jordan Pike', 'Morgan Ellis', 'Sam Whitaker', 'Riley Chen'];

export const local = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');
/** Possessive: "Acme's", "Salinas Valley Greens'". */
export const poss = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`);
export const firstName = (p: BenchParty) => p.name.split(' ')[0];
export const personName = (p: BenchParty) => p.name.split(' (')[0];

export interface FreightDeal {
  cast: FreightCast;
  carrier: CarrierInfo;
  carrier2: CarrierInfo;
  lane: Lane;
  commodity: Commodity;
  consignee: string;
  alias: string;
  equipment: Equipment;
  tempF: number | null;
  weight: number;
  linehaul: number;
  fuel: number;
  allIn: number;
  detention: number;
  budget: number;
  payTerms: string;
  /** Day the story starts (ISO day, a Monday). */
  start: string;
  pickupDay: string;
  /** The carrier's (quoted) pickup window, inside the shipper's window. */
  pickupWin: Win;
  /** The shipper's loading window (hard requirement). */
  reqPickup: Win;
  deliveryDay: string;
  /** The delivery appointment (hard requirement; what the carrier quotes as its delivery). */
  appt: string;
  task: BenchTask;
}

export interface DealOptions { lanes?: Lane[]; equipment?: Equipment[] }

/** A randomised but internally consistent load. Variant 0 reproduces the canonical ACM-58213 story. */
export function freightDeal(r: Rand, variant: number, o: DealOptions = {}): FreightDeal {
  const g = variant === 0;
  const okGoods = (l: Lane) => COMMODITIES.filter((c) => l.goods.includes(c.name) && (!o.equipment || o.equipment.includes(c.eq)));
  const lanes = (o.lanes ?? LANES).filter((l) => okGoods(l).length);
  const lane = g ? LANES[0] : r.pick(lanes);
  const commodity = g ? COMMODITIES[0] : r.pick(okGoods(lane));
  const fits = CARRIERS.filter((c) => !c.eq || c.eq.includes(commodity.eq));
  const carrier = g ? CARRIERS[0] : r.pick(fits);
  const carrier2 = g ? CARRIERS[4] : r.pick(fits.filter((c) => c !== carrier));
  const cons = g ? CONSIGNEES[0] : r.pick(CONSIGNEES);
  const opsName = g ? OPS[0] : r.pick(OPS);
  const [dispName, driverName] = g ? carrier.people : r.chance(0.5) ? carrier.people : [carrier.people[1], carrier.people[0]];
  const alias = g ? 'ACM-58213' : `ACM-${r.int(40000, 69999)}`;

  const start = g ? '2026-10-19' : r.pick(['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-30']);
  const pickupDay = addDays(start, g || lane.transit === 3 ? 1 : r.pick([1, 2]));
  const deliveryDay = addDays(pickupDay, lane.transit);
  const pStart = g ? 6 : r.pick([6, 7, 8]);
  const pickupWin = win(pickupDay, hh(pStart), hh(pStart + 4));
  const reqPickup = win(pickupDay, hh(pStart), hh(pStart + 4 + (g ? 2 : r.pick([2, 3, 4]))));
  const appt = dt(deliveryDay, g ? '08:00' : r.pick(['07:00', '08:00', '09:00', '10:00', '13:00']));

  const rpmBase = { reefer: [2.55, 3.35], dry_van: [2.1, 2.85], flatbed: [2.7, 3.4] }[commodity.eq];
  const rpm = r.step(rpmBase[0], rpmBase[1], 0.01) + (lane.miles < 600 ? 0.45 : 0);
  const linehaul = g ? 3050 : Math.max(900, Math.round((lane.miles * rpm) / 25) * 25);
  const fuel = g ? 620 : Math.round((lane.miles * r.step(0.46, 0.62, 0.01)) / 5) * 5;
  const allIn = linehaul + fuel;
  const budget = g ? 3800 : Math.ceil((allIn + r.pick([75, 100, 150, 200, 250])) / 25) * 25;
  const detention = g ? 75 : r.pick([50, 60, 75]);
  const payTerms = g ? 'Net 30' : r.pick(['Net 30', 'Net 30', 'Net 21', 'Quick pay 2%, 5 days']);

  const self: BenchParty = { address: 'loads@acme-logistics.example', name: 'Acme Logistics Booking Agent', role: 'self', label: 'Acme Logistics (us)', authority: ['decision.'] };
  const dispatcher: BenchParty = {
    address: `${local(dispName)}@${carrier.domain}`, name: `${dispName} (${carrier.company} dispatch)`, role: 'counterparty', label: 'carrier dispatch',
    authority: ['rate.', 'accessorial.', 'pickup.', 'delivery.eta', 'equipment.', 'capacity.', 'carrier.', 'payment.', 'offer.', 'decision.'], group: 'carrier',
  };
  const driver: BenchParty = { address: `${local(driverName)}@${carrier.domain}`, name: `${driverName} (${carrier.company} driver)`, role: 'counterparty', label: 'carrier driver', authority: ['pickup.', 'delivery.eta'], group: 'carrier' };
  const receiver: BenchParty = { address: `receiving@${cons.domain}`, name: `${cons.contact} (${cons.company} receiving)`, role: 'counterparty', label: 'receiver', authority: ['delivery.appointment'], group: 'consignee' };
  const ops: BenchParty = { address: `${local(opsName)}@acme-logistics.example`, name: `${opsName} (Acme Logistics ops)`, role: 'internal', label: 'ops', authority: ['budget.'] };
  const c2Name = g ? carrier2.people[0] : r.pick(carrier2.people);
  const carrier2Party: BenchParty = {
    address: `${local(c2Name)}@${carrier2.domain}`, name: `${c2Name} (${carrier2.company} dispatch)`, role: 'counterparty', label: 'second carrier',
    authority: ['rate.', 'accessorial.', 'pickup.', 'delivery.eta', 'equipment.', 'capacity.', 'carrier.', 'payment.', 'offer.', 'decision.'], group: 'carrier2',
  };

  const eqLabel = commodity.eq === 'reefer' ? `${EQ_NAME.reefer} at ${sayTemp(commodity.temp!)}` : EQ_NAME[commodity.eq];
  const task: BenchTask = {
    id: `task_${alias.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    alias,
    goal: `Cover load ${alias} for ${commodity.shipper}: ${thousands(commodity.weight)} lbs ${commodity.name}, ${lane.origin} → ${lane.dest}. ` +
      `Truck must load ${sayWin(reqPickup)} (shipper's loading window) and deliver by the ${sayDT(appt)} appointment at ${cons.company}; ${eqLabel}; ` +
      `all-in carrier cost must not exceed ${moneyShort(budget)}.`,
    item: `${commodity.name} (${lane.origin} → ${lane.dest})`,
    self_address: self.address,
    parties: [self, dispatcher, ops],
    requirements: [
      { key: 'requirement.pickup_window', value: reqPickup, display: `load ${sayWin(reqPickup)}`, hard: true },
      { key: 'requirement.deliver_by', value: appt, display: `deliver by ${sayDT(appt)}`, hard: true },
      { key: 'requirement.equipment', value: commodity.eq, display: eqLabel, hard: true },
      ...(commodity.temp !== null ? [{ key: 'requirement.reefer_temp_f', value: commodity.temp, display: sayTemp(commodity.temp), hard: true }] : []),
      { key: 'requirement.max_all_in', value: budget, display: `max ${moneyShort(budget)} all-in`, hard: true },
    ],
  };
  return {
    cast: { self, dispatcher, driver, receiver, ops, carrier2: carrier2Party }, carrier, carrier2, lane, commodity, consignee: cons.company, alias,
    equipment: commodity.eq, tempF: commodity.temp, weight: commodity.weight, linehaul, fuel, allIn, detention, budget, payTerms,
    start, pickupDay, pickupWin, reqPickup, deliveryDay, appt, task,
  };
}

/** The task with extra parties (driver, receiver, second carrier, carrier billing). */
export const withParties = (task: BenchTask, ...extra: BenchParty[]): BenchTask => ({ ...task, parties: [...task.parties, ...extra] });

export const eqWords = (d: FreightDeal, eq: Equipment = d.equipment) =>
  eq === 'reefer' ? `reefer${d.tempF !== null ? ` at ${sayTemp(d.tempF)}` : ''}` : eq === 'dry_van' ? 'dry van' : 'flatbed';
/** "a, b and c". */
export const listAnd = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
export const eqPlural = (eq: Equipment) => ({ dry_van: 'dry vans', reefer: 'reefers', flatbed: 'flatbeds' })[eq];

export const eqLabel = (d: FreightDeal) => (d.equipment === 'reefer' ? `${EQ_NAME.reefer} at ${sayTemp(d.tempF!)}` : EQ_NAME[d.equipment]);

/** Equipment terms the carrier states (type, plus the set point for a reefer). */
export function equipmentTerms(d: FreightDeal, party: string, evidence: string[], critical = false): OracleTerm[] {
  return [cur(party, 'equipment.type', d.equipment, evidence, critical), ...(d.tempF !== null ? [cur(party, 'equipment.reefer_temp_f', d.tempF, evidence)] : [])];
}

export const rateConFile = (d: FreightDeal, rev?: number) => `${d.carrier.short}-RateCon-${d.alias}${rev ? `-rev${rev}` : ''}.pdf`;

/** Carrier rate confirmation lines; pass overrides to change single terms. */
export function rateConLines(d: FreightDeal, o: {
  date: string; linehaul?: number; fuel?: number; pickup?: Win; eta?: string; equipment?: Equipment; detention?: number | null;
  payment?: string; remit?: string; revision?: number; extra?: string[]; loads?: string;
} = { date: '' }): string[] {
  const lh = o.linehaul ?? d.linehaul;
  const fuel = o.fuel ?? d.fuel;
  const eq = o.equipment ?? d.equipment;
  const det = o.detention === undefined ? d.detention : o.detention;
  const p = o.pickup ?? d.pickupWin;
  return [
    `${d.carrier.company.toUpperCase()} LLC — CARRIER LOAD & RATE CONFIRMATION${o.revision ? ` (REVISION ${o.revision})` : ''}`,
    `Broker: Acme Logistics LLC    Broker load #: ${d.alias}    Date: ${sayDate(o.date, 'month_day')}, 2026`,
    `Carrier: ${d.carrier.company} LLC    MC# ${d.carrier.mc}`,
    `Shipper: ${d.commodity.shipper}, ${d.lane.origin}`,
    `Consignee: ${d.consignee}, ${d.lane.dest}`,
    `Commodity: ${d.commodity.name}, ${thousands(d.weight)} lbs${o.loads ? `    Loads: ${o.loads}` : ''}`,
    `Equipment: ${EQ_NAME[eq]}${eq === 'reefer' && d.tempF !== null ? `, continuous @ ${sayTemp(d.tempF)}` : eq === 'flatbed' ? ', tarped' : ''}`,
    `Pickup: ${sayDate(dayOf(p.start), 'weekday_short_date')}, ${timeOf(p.start)}–${timeOf(p.end)}`,
    `Delivery: ${sayDate(dayOf(o.eta ?? d.appt), 'weekday_short_date')}, ${timeOf(o.eta ?? d.appt)} (appointment)`,
    `Linehaul: ${moneyShort(lh)}`,
    `Fuel surcharge: ${moneyShort(fuel)}`,
    `TOTAL ALL-IN: ${moneyShort(lh + fuel)}`,
    det === null ? 'Detention: per carrier accessorial schedule' : `Detention: ${moneyShort(det)}/hr after 2 hrs free`,
    `Payment terms: ${o.payment ?? d.payTerms}`,
    `Remit to: ${o.remit ?? d.carrier.remit}`,
    ...(o.extra ?? []),
    `Issued by: ${personName(d.cast.dispatcher)}, Dispatch, on the carrier's own confirmation form. Not binding until countersigned by the broker.`,
  ];
}

export const signDispatch = (d: FreightDeal, p: BenchParty = d.cast.dispatcher) =>
  `${personName(p)}\n${p === d.cast.carrier2 ? d.carrier2.company : d.carrier.company} | Dispatch${p === d.cast.carrier2 ? '' : `\nMC ${d.carrier.mc}`}`;
export const signUs = (r: Rand, g: boolean) => (g ? 'Thanks,\nAcme Logistics Booking Desk' : r.pick(['Thanks,\nAcme Logistics Booking Desk', 'Best,\nAcme Logistics — Carrier Sales', 'Thank you,\nAcme Logistics Booking Desk']));

// ------------------------------------------------------------------ state-neutral mail (realism and the scale transform)

/** On-task messages that change no tracked state (dock rules, after-hours numbers, reference numbers). */
export function freightChatter(r: Rand, d: FreightDeal, mb: MailBuilder, fromIso: string, n: number, gapMin = 20): string[] {
  const { dispatcher, ops } = d.cast;
  const lines: [typeof dispatcher, string, string][] = [
    [dispatcher, `${d.alias} after hours`, `If you can't reach me after 6pm on ${d.alias}, our night dispatch line is 555-01${r.int(10, 99)}.`],
    [ops, `${d.alias} customer ref`, `${poss(d.commodity.shipper)} reference for ${d.alias} is SO-${r.int(100000, 999999)}. Please make sure it ends up on the BOL. No other action needed.`],
    [dispatcher, `${d.alias} driver gear`, `FYI our trucks carry load locks and straps as standard${d.equipment === 'flatbed' ? ', plus 8 ft tarps and chains' : ''}.`],
    [ops, `${d.alias} receiving notes`, `FYI ${d.consignee} requires drivers to check in at the guard shack with the PO and load number. Just passing it along.`],
    [dispatcher, `${d.alias} SmartWay`, "Quick note in case your customer asks — we're SmartWay certified."],
    [ops, `${d.commodity.shipper} — repeat lane`, `${d.commodity.shipper} ships ${d.lane.origin.split(',')[0]} to ${d.lane.dest.split(',')[0]} most weeks, so we'll likely see more of these. No action needed.`],
    [dispatcher, `${d.alias} contact`, "I'm out Friday afternoon; my colleague covers my board and has all the details."],
    [ops, `Office hours`, 'Reminder: the Acme office closes at 3pm Friday for the team event. Booking desk email is still monitored.'],
  ];
  const keys: string[] = [];
  const order = r.shuffle(lines.map((_, i) => i));
  for (let i = 0; i < n; i++) {
    const [who, subject, text] = lines[order[i % lines.length]];
    const t = new Date(Date.parse(fromIso) + gapMin * (i + 1) * 60_000).toISOString().replace('.000', '');
    keys.push(mb.add({ direction: 'inbound', from: who.address, fromName: personName(who), to: [d.cast.self.address], subject: i >= lines.length ? `${subject} (${i + 1})` : subject, body: body(text, firstName(who)), at: t, note: 'state-neutral chatter' }));
  }
  return keys;
}

/** A look-alike load number with the same carrier: digits of the alias swapped. */
export function lookalike(alias: string): string {
  const n = alias.slice(4);
  const swapped = n.slice(0, 3) + n[4] + n[3];
  return `ACM-${swapped !== n ? swapped : String(Number(n) + 9)}`;
}

/** All-in the carrier quotes on the look-alike load (and ops approves + $100 for it). */
export const lookalikeRate = (d: FreightDeal) => Math.round((d.allIn * 0.82) / 25) * 25;

/** Mail in the same inbox that is not about this load, including a look-alike load with the same carrier. */
export function freightBackground(r: Rand, d: FreightDeal, mb: MailBuilder, fromIso: string, n: number, opts: { lookalike?: boolean } = {}): string[] {
  const other = lookalike(d.alias);
  const otherRate = lookalikeRate(d);
  const disp = personName(d.cast.dispatcher);
  const pool: { from: string; fromName: string; subject: string; text: string }[] = [
    { from: 'alerts@freightboard-pro.example', fromName: 'FreightBoard Pro', subject: 'Hot lanes this week', text: `Reefer rates out of ${d.lane.origin} are up 6% week over week. Post your trucks now and get matched faster.` },
    { from: d.cast.dispatcher.address, fromName: disp, subject: `${other} quote`, text: `For ${other} (Ontario, CA → Las Vegas, NV) I can do ${moneyShort(otherRate)} all-in, pickup ${sayDate(addDays(d.pickupDay, 2), 'weekday_short_date')} 0800-1200.\n\n${disp.split(' ')[0]}` },
    { from: 'news@diesel-index.example', fromName: 'Diesel Index Weekly', subject: 'Diesel up 4 cents', text: 'The national average for on-highway diesel rose 4 cents this week; West Coast prices lead the increase.' },
    { from: d.cast.ops.address, fromName: personName(d.cast.ops), subject: `Budget ${other}`, text: `For ${other}, approved up to ${moneyShort(otherRate + 100)} all-in.\n\n${firstName(d.cast.ops)}` },
    { from: 'offers@quickpay-factor.example', fromName: 'QuickPay Factoring', subject: 'Carriers: get paid in 24 hours', text: 'Switch your remit-to to QuickPay and get paid in 24 hours. No long-term contracts.' },
    { from: 'it@acme-logistics.example', fromName: 'Acme IT', subject: 'TMS maintenance Saturday', text: 'The TMS will be unavailable Saturday 1am–3am for maintenance.' },
    { from: d.cast.dispatcher.address, fromName: disp, subject: `Correction on ${other}`, text: `Correction for ${other}: pickup moves to ${sayDate(addDays(d.pickupDay, 3), 'weekday_short_date')} 1300-1700. Rate unchanged. Revised rate con to follow.\n\n${disp.split(' ')[0]}` },
    { from: 'dispatch@redrock-hauling.example', fromName: 'Red Rock Hauling', subject: 'Truck available', text: `We have a ${r.pick(['53\' dry van', '53\' reefer'])} empty in Reno ${sayDate(addDays(d.start, 2), 'weekday')}, looking for anything headed east. Call or email.` },
  ];
  const usable = opts.lookalike === false ? pool.filter((p) => !p.subject.includes(other)) : pool;
  const keys: string[] = [];
  const order = r.shuffle(usable.map((_, i) => i));
  for (let i = 0; i < n; i++) {
    const p = usable[order[i % usable.length]];
    const t = new Date(Date.parse(fromIso) + (37 * i + 11) * 60_000).toISOString().replace('.000', '');
    keys.push(mb.add({ background: true, direction: 'inbound', from: p.from, fromName: p.fromName, to: [d.cast.self.address], subject: i >= usable.length ? `${p.subject} [${i}]` : p.subject, body: p.text, at: t, note: 'not part of this task' }));
  }
  return keys;
}

/** An ISO timestamp `min` minutes after `iso`. */
export const later = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString().replace('.000', '');

export const freightDayStart = (d: FreightDeal, offset: number, hhmm: string) => at(addDays(d.start, offset), hhmm);

/** Assemble a case with the split rule applied. */
export function freightCase(a: { id: string; capabilities: Capability[] }, variant: number, x: {
  description: string; task: BenchTask; mb: MailBuilder; trigger: string; checkpoints: Checkpoint[]; params: Record<string, unknown>;
}): BenchCase {
  return {
    id: `freight/${a.id}/${variant}`,
    vertical: 'freight',
    archetype: a.id,
    variant,
    split: variant === 0 ? 'golden' : variant <= 10 ? 'dev' : 'eval',
    capabilities: a.capabilities,
    description: x.description,
    task: x.task,
    events: x.mb.sorted(),
    trigger: x.trigger,
    checkpoints: x.checkpoints,
    params: x.params,
  };
}

/** Our standard request for a quote. */
export function rfqBody(r: Rand, d: FreightDeal, g: boolean, to: BenchParty, extra?: string): string {
  const k = g ? 0 : r.int(0, 3);
  const opener = g ? `Hi ${firstName(to)},` : r.pick([`Hi ${firstName(to)},`, `Hey ${firstName(to)},`, `Good morning ${firstName(to)},`]);
  const lane = `${d.lane.origin} → ${d.lane.dest}`;
  const ask = [
    `Looking to cover ${d.alias}: ${thousands(d.weight)} lbs ${d.commodity.name}, ${lane}. Needs a ${eqLabel(d)}. Shipper loads ${sayWin(d.reqPickup, k)}; delivery appointment is ${sayDT(d.appt, k)}. What's your best all-in, and can your truck make those times? Please send a rate con if you can cover.`,
    `Do you have a truck for ${d.alias}? ${lane}, ${d.commodity.name}, ${thousands(d.weight)} lbs, ${eqWords(d)}. Pickup ${sayWin(d.reqPickup, k)}, deliver ${sayDT(d.appt, k)} (appt). Send me your all-in and a rate con.`,
    `I have ${d.alias} available — ${d.commodity.name} out of ${d.lane.origin} to ${d.lane.dest}, ${thousands(d.weight)} lbs, ${eqWords(d)}. Loads ${sayWin(d.reqPickup, k)}, delivers ${sayDT(d.appt, k)}. Can you cover it, and at what all-in? A rate con would be great.`,
    `Need a ${eqWords(d)} for ${d.alias}, ${lane}. ${thousands(d.weight)} lbs of ${d.commodity.name}. Shipper's window is ${sayWin(d.reqPickup, k)} and the receiver appt is ${sayDT(d.appt, k)}. Please quote all-in and attach your rate con.`,
  ][k];
  return body(opener, ask, extra, signUs(r, g));
}

/** Our standard budget request to ops. */
export function budgetAskBody(r: Rand, d: FreightDeal, g: boolean): string {
  const k = g ? 0 : r.int(0, 2);
  return body(`Hi ${firstName(d.cast.ops)},`, [
    `Can you approve carrier spend of up to ${moneyShort(d.budget)} all-in on ${d.alias} (${d.lane.origin} → ${d.lane.dest}, ${eqWords(d)})? I'm getting quotes now.`,
    `Requesting approval to go up to ${moneyShort(d.budget)} all-in for the carrier on ${d.alias}. Customer rate supports it.`,
    `Please OK a carrier budget of ${moneyShort(d.budget)} all-in for ${d.alias} so I can book as soon as I have a truck.`,
  ][k], signUs(r, g));
}

/** Ops approval text. */
export function approvalBody(r: Rand, d: FreightDeal, g: boolean, budget = d.budget, alias = d.alias): string {
  const text = g
    ? `Approved — you can go up to ${moneyShort(budget)} all-in on ${alias}.`
    : r.pick([
      `Approved up to ${moneyShort(budget)} all-in for ${alias}.`,
      `You're good to spend up to ${moneyShort(budget)} all-in on ${alias}.`,
      `OK from me: carrier cost on ${alias} capped at ${moneyShort(budget)} all-in.`,
      `${alias}: approved, ceiling ${moneyShort(budget)} all-in.`,
    ]);
  return body(text, firstName(d.cast.ops));
}

/** The carrier's quote sentence (all-in broken into linehaul + fuel). */
export function quoteText(r: Rand, d: FreightDeal, g: boolean, k: number): string {
  if (g) return `We can cover it. ${moneyShort(d.linehaul)} linehaul plus ${moneyShort(d.fuel)} fuel, so ${moneyShort(d.allIn)} all-in. Truck will be at the shipper ${sayWin(d.pickupWin, 0)} and deliver for the ${sayDT(d.appt, 0)} appointment. ${d.equipment === 'reefer' ? `Reefer will run continuous at ${sayTemp(d.tempF!)}.` : ''} Rate con attached.`.replace('  ', ' ');
  return [
    `We can cover ${d.alias}. ${moneyShort(d.allIn)} all-in (${moneyShort(d.linehaul)} linehaul + ${moneyShort(d.fuel)} FSC). Truck at shipper ${sayWin(d.pickupWin, k)}, delivers ${sayDT(d.appt, k)}. Rate con attached.`,
    `Yes, I've got a ${eqWords(d)} for it. Rate is ${moneyShort(d.linehaul)} + ${moneyShort(d.fuel)} fuel = ${moneyShort(d.allIn)} all-in. Pickup ${sayWin(d.pickupWin, k)}, delivery ${sayDT(d.appt, k)}. See attached rate con.`,
    `Can do. ${moneyShort(d.allIn)} all in, that's ${moneyShort(d.linehaul)} line haul and ${moneyShort(d.fuel)} fuel. My driver can be there ${sayWin(d.pickupWin, k)} and make the ${sayDT(d.appt, k)} appt. Rate confirmation attached.`,
    `Attached is our rate con for ${d.alias}: ${moneyShort(d.allIn)} all-in, pickup ${sayWin(d.pickupWin, k)}, delivery ${sayDT(d.appt, k)}, ${eqWords(d)}.`,
  ][k % 4];
}

/** Rate terms (linehaul, fuel, all-in) for one party. */
export function rateTerms(party: string, lh: number, fuel: number, ev: { lh: string[]; fuel: string[]; all: string[] }, critical = true): OracleTerm[] {
  return [cur(party, 'rate.linehaul', lh, ev.lh), cur(party, 'rate.fuel_surcharge', fuel, ev.fuel), cur(party, 'rate.all_in', lh + fuel, ev.all, critical)];
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Regex source matching a money amount as written ("$3,670", "3670", "$3,670.00"). */
export const moneyRe = (n: number) => `\\$?\\s?${escapeRe(n.toLocaleString('en-US')).replace(',', ',?')}(?:\\.00)?\\b`;
