// The freight-brokerage pack (truckload): a broker's booking agent covers a load with carriers by email.
// The carrier's dispatcher quotes and commits (rate, pickup window, ETA, equipment, remit-to), its driver
// may report pickup and ETA, the receiver sets the delivery appointment, and Acme ops approves the
// carrier budget. Remit-to changes are the classic fraud: they count only from the authenticated carrier.
import type { CheckResult, Claim, TaskSpec } from '../types.ts';
import { findDates, prettyDate } from '../extract/dates.ts';
import { registerDomain, type DomainPack, type HeuristicSentence, type TermDef } from './pack.ts';
import { displayTyped, mergePartialLots, normalizeTyped, type Lot, type Window } from './values.ts';
import { amounts, datedTimes, fieldValue, labelAmount, leadOf, toNumber } from './text.ts';
import { claimCheck, expectedFrom, ownClaim, partiesFor, requirementOf, standardActions, withdrawalCheck } from './common.ts';

export const TERMS: TermDef[] = [
  { key: 'rate.linehaul', type: 'money', description: 'Carrier linehaul rate for the load in USD (excluding fuel and accessorials)', topics: ['linehaul', 'line haul'], events: { default: 'rate_stated' } },
  { key: 'rate.fuel_surcharge', type: 'money', description: 'Fuel surcharge for the load in USD (flat amount)', topics: ['fuel', 'fsc'], events: { default: 'rate_stated' } },
  { key: 'rate.all_in', type: 'money', description: 'All-in carrier rate for the load in USD (linehaul + fuel); for multi-load commitments, per load', topics: ['all-in', 'all in', 'your rate', 'best rate', 'best price', 'quote', 'per load', 'truck for', 'cover'], events: { self: 'rate_offered', counterparty: 'carrier_quote', default: 'rate_stated' } },
  { key: 'accessorial.detention_per_hour', type: 'money', description: 'Detention pay per hour after free time, USD', topics: ['detention', 'per hour', 'free time'], events: { default: 'accessorial_stated' } },
  { key: 'pickup.window', type: 'window', description: "Window in which the carrier's truck will be at the shipper to load, local time", topics: ['pickup', 'pick up', 'loading window', 'at the shipper', 'make the window', 'load window', 'shipper\'s window'], events: { default: 'pickup_window_set' } },
  { key: 'delivery.eta', type: 'datetime', description: "Carrier's committed or currently estimated arrival at the consignee, local time", topics: ['eta', 'deliver', 'arriv', 'on schedule', 'on time', 'where is', 'status'], events: { default: 'eta_updated' } },
  { key: 'delivery.appointment', type: 'datetime', description: "Delivery appointment at the consignee's dock, set by the receiver, local time", topics: ['appointment', 'appt', 'dock'], events: { default: 'appointment_set' } },
  { key: 'equipment.type', type: 'enum', values: ['dry_van', 'reefer', 'flatbed'], description: 'Trailer type the carrier will use', topics: ['equipment', 'reefer', 'dry van', 'flatbed', 'trailer'], events: { default: 'equipment_confirmed' } },
  { key: 'equipment.reefer_temp_f', type: 'number', range: 'any', description: 'Reefer set point in °F the carrier commits to run', topics: ['temp', 'set point', '°f', 'degrees'], events: { default: 'equipment_confirmed' } },
  { key: 'load.weight_lbs', type: 'number', description: 'Load weight in lbs', topics: ['weight', 'lbs'], events: { default: 'load_details_stated' } },
  { key: 'capacity.loads', type: 'schedule', unit: 'loads', description: 'Trucks/loads the carrier commits for a multi-load shipment, as {qty, date} with the pickup date of each group', topics: ['trucks', 'loads', 'capacity', 'how many', 'take all', 'cover all', 'all of them'], events: { default: 'capacity_committed' } },
  { key: 'carrier.mc_number', type: 'text', description: "Carrier's MC (operating authority) number", topics: ['mc number', 'mc#', 'authority'], events: { default: 'carrier_identified' } },
  { key: 'payment.remit_to', type: 'text', description: 'Where the carrier is paid (the carrier itself or its factoring company)', topics: ['remit', 'factoring', 'bank', 'payment to', 'pay to'], events: { default: 'remit_to_stated' }, sensitive: 'change' },
  { key: 'payment.terms', type: 'text', description: 'Carrier payment terms, e.g. "Net 30" or "Quick pay 2%, 5 days"', topics: ['payment terms', 'net 30', 'quick pay', 'quickpay'], events: { default: 'payment_terms_stated' } },
  { key: 'offer.status', type: 'enum', values: ['withdrawn'], lifecycle: true, description: 'The carrier cancelled / fell off the load or withdrew its quote (value "withdrawn")', topics: ['fell through', 'fall off', 'cancel', 'withdraw'], events: { default: 'carrier_fell_off' } },
  { key: 'budget.max_all_in', type: 'money', description: 'Internally approved maximum all-in carrier cost for the load (Acme ops decision)', topics: ['budget', 'approve', 'approval', 'ceiling', 'sign off', 'ok a carrier'], events: { internal: 'budget_approved', default: 'budget_approved' } },
  { key: 'decision.tender', type: 'text', description: 'A decision to book / tender / decline the load (e.g. "booked")', topics: ['book it', 'book the', 'tender', 'confirm the load', 'confirm by', 'still holding', 'want the truck', 'want my truck', 'still want', 'want it', 'are we covered', 'covered yet', 'is it covered'], events: { self: 'load_booked', default: 'tender_decision' } },
];

const termDef = (key: string) => TERMS.find((t) => t.key === key);

// --------------------------------------------------------------------------------- checks

const inWindow = (w: Window, outer: Window) => w.start >= outer.start && w.end <= outer.end;
const fmtWin = (w: Window) => displayTyped(termDef('pickup.window')!, w);
const fmtDT = (x: string) => displayTyped(termDef('delivery.eta')!, x);
const EQ: Record<string, string> = { dry_van: 'dry van', reefer: 'reefer', flatbed: 'flatbed' };

export function runChecks(task: TaskSpec, active: Claim[]): CheckResult[] {
  const results: CheckResult[] = [];
  const pickupReq = requirementOf(task, 'requirement.pickup_window');
  const deliverBy = requirementOf(task, 'requirement.deliver_by');
  const equipment = requirementOf(task, 'requirement.equipment');
  const temp = requirementOf(task, 'requirement.reefer_temp_f');
  const maxAllIn = requirementOf(task, 'requirement.max_all_in');
  const loads = requirementOf(task, 'requirement.loads');
  const pickedUpBy = requirementOf(task, 'requirement.all_picked_up_by');
  const budget = active.find((c) => c.key === 'budget.max_all_in');

  // carriers: every counterparty that quotes (rate authority)
  for (const party of partiesFor(task, 'rate.all_in')) {
    const who = party.address;
    const withdrawn = withdrawalCheck(party, active);
    if (withdrawn) {
      results.push(withdrawn);
      continue;
    }
    const own = (key: string) => ownClaim(active, key, who);

    if (pickupReq) {
      const w = pickupReq.value as Window;
      results.push(claimCheck({
        id: `pickup_window:${who}`, label: `Truck loads ${pickupReq.display}`, party, requirementKey: pickupReq.key, claim: own('pickup.window'),
        missing: `No pickup window from ${party.label} yet`, ok: (c) => inWindow(c.value as Window, w),
        detail: (c, ok) => `${party.label}'s pickup ${c.display} ${ok ? 'is inside' : 'is outside'} the shipper's window (${fmtWin(w)})`,
      }));
    }
    if (deliverBy) {
      results.push(claimCheck({
        id: `deliver_by:${who}`, label: `Delivers ${deliverBy.display}`, party, requirementKey: deliverBy.key, claim: own('delivery.eta'),
        missing: `No delivery time from ${party.label} yet`, ok: (c) => String(c.value) <= String(deliverBy.value),
        detail: (c, ok) => `${party.label}'s delivery ${c.display} ${ok ? 'makes' : 'misses'} the ${fmtDT(String(deliverBy.value))} appointment`,
      }));
    }
    if (equipment) {
      results.push(claimCheck({
        id: `equipment:${who}`, label: `Equipment ${equipment.display}`, party, requirementKey: equipment.key, claim: own('equipment.type'),
        missing: `Equipment not confirmed by ${party.label}`, ok: (c) => c.value === equipment.value,
        detail: (c, ok) => (ok ? `${party.label} confirms a ${EQ[String(c.value)]}` : `${party.label} offers a ${EQ[String(c.value)]}, the load needs a ${EQ[String(equipment.value)]}`),
      }));
    }
    if (temp) {
      results.push(claimCheck({
        id: `reefer_temp:${who}`, label: `Reefer at ${temp.display}`, party, requirementKey: temp.key, claim: own('equipment.reefer_temp_f'),
        missing: `Reefer set point not confirmed by ${party.label}`, ok: (c) => Number(c.value) === Number(temp.value),
        detail: (c, ok) => `${party.label} runs the reefer at ${c.value}°F${ok ? '' : `, the load needs ${temp.display}`}`,
      }));
    }
    if (maxAllIn || budget) {
      const cap = Math.min(...[maxAllIn ? Number(maxAllIn.value) : Infinity, budget ? Number(budget.value) : Infinity]);
      const capLabel = budget && Number(budget.value) <= Number(maxAllIn?.value ?? Infinity) ? `ops-approved ${budget.display}` : `the ${displayTyped(termDef('rate.all_in')!, cap)} maximum`;
      results.push(claimCheck({
        id: `max_all_in:${who}`, label: 'All-in within budget', party, requirementKey: maxAllIn?.key ?? 'budget.max_all_in', claim: own('rate.all_in'),
        missing: `No all-in rate from ${party.label} yet`, ok: (c) => Number(c.value) <= cap, extraEvidence: budget ? [budget.id] : [],
        detail: (c, ok) => `${c.display} all-in ${ok ? 'is within' : 'exceeds'} ${capLabel}`,
      }));
    }
    if (loads) {
      results.push(claimCheck({
        id: `loads:${who}`, label: `${loads.display} covered`, party, requirementKey: loads.key, claim: own('capacity.loads'),
        missing: `No truck count from ${party.label} yet`, ok: (c) => (c.value as Lot[]).reduce((n, l) => n + l.qty, 0) >= Number(loads.value),
        detail: (c, ok) => `${party.label} commits ${c.display}${ok ? '' : ` — short of ${loads.display}`}`,
      }));
    }
    if (pickedUpBy) {
      results.push(claimCheck({
        id: `all_picked_up_by:${who}`, label: `All loads picked up by ${pickedUpBy.display}`, party, requirementKey: pickedUpBy.key, claim: own('capacity.loads'),
        missing: `No pickup dates from ${party.label} yet`, ok: (c) => (c.value as Lot[]).every((l) => l.date <= String(pickedUpBy.value)),
        detail: (c, ok) => {
          const late = (c.value as Lot[]).filter((l) => l.date > String(pickedUpBy.value));
          return ok ? `${party.label}'s trucks (${c.display}) all load by ${pickedUpBy.display}` : `${late.map((l) => `${l.qty} load${l.qty === 1 ? '' : 's'} ${prettyDate(l.date)}`).join(', ')} — after ${pickedUpBy.display}`;
        },
      }));
    }
  }

  if (maxAllIn && partiesFor(task, 'budget.', 'internal').length) {
    results.push({
      id: 'budget_approval', label: 'Carrier budget approved', requirement_key: 'budget.max_all_in', party: budget?.speaker ?? null,
      status: !budget ? 'unknown' : Number(budget.value) >= Number(maxAllIn.value) ? 'pass' : 'fail',
      evidence: budget ? [budget.id] : [],
      detail: budget ? `Approved up to ${budget.display} all-in` : 'No budget approval from ops yet',
    });
  }
  return results;
}

// --------------------------------------------------------------------------------- offline extraction

const MONEY_LABELS: [string, RegExp][] = [
  ['rate.all_in', /\b(?:all[- ]?in|total)\b/i],
  ['rate.linehaul', /\bline[- ]?haul\b/i],
  ['rate.fuel_surcharge', /\b(?:fuel(?: surcharge)?|fsc)\b/i],
  ['accessorial.detention_per_hour', /(?:\/\s*h(?:ou)?r\b|per hour|an hour|\bdetention\b)/i],
];
const BUDGET = /\b(approv\w*|budget|ceiling|cap(?:ped)?|spend up to|up to|ok from me|good to spend|not to exceed|go (?:up )?to|book it)\b/i;
const NEGATED = /\b(?:no|not|cannot|can't|can not|don't|do not|won't|unable)\b[^.]{0,25}$/i;
const WITHDRAW = /\b(?:fell through|falls? through|falling through|fall(?:s|en)? off|fell off|(?:have|need) to (?:give|turn|hand) (?:it|the load|this load|\w+-\d+) back|can(?:no|')t (?:cover|take|run|do) (?:it|this|the load|this load|\w+-\d+) (?:after all|anymore|any more)|(?:withdraw\w*|pull\w*|cancel\w*|rescind\w*) (?:our|my|the) (?:quote|offer|truck|rate)|no longer (?:able to cover|available|have a truck)|(?:truck|driver) (?:is no longer|isn't|is not) available|lost (?:the|our|my) truck|disregard (?:our|my|the) (?:quote|rate con)|(?:have|need|got) to cancel(?: on)? (?:this|it|you|the load|this load)|(?:need to|have to|going to|will|must) pass on (?:this|it|the load|this load|[A-Z]{2,6}-\d+)|don't count on us|can(?:no|')t protect (?:it|yours|your load|the load|this load))\b/i;
const NOT_WITHDRAWN = /\b(?:not|never|haven't|hasn't)\s+(?:been\s+)?(?:withdraw|cancel|fall)/i;
const CONDITIONAL = /\b(if|unless|in case|would you|should we)\b/i;
const BOOKED = /\b(?:you(?:'re| are) (?:booked|confirmed)|(?:we|i) (?:hereby )?accept (?:your|the|this) (?:quote|rate|offer|rate con)|let's book|go ahead and book|book(?:ing)? (?:it|the load|this load|you)\b|tender(?:ing|ed)? (?:the|this) load to you|(?:signed|countersigned) (?:the )?rate con|load is (?:booked|yours))/i;
const PICKUP_CUE = /\b(?:pick ?up|pickup|pick-up|shipper|load(?:s|ing)?\b|be there|at the dock|truck at|on site|window)/i;
const DELIVERY_CUE = /\b(?:deliver\w*|appt|appointment|arriv\w*|eta|consignee|receiver|make the|on schedule|late|running)\b/i;
const OLD_VALUE = /\b(?:not|instead of|rather than|was|previously|originally|(?:moved?|changed?|moving) from)\s*(?:the\s+)?$/i;
const EQUIPMENT = /\b(reefers?|refrigerated|dry vans?|vans?|flatbeds?|flat beds?)\b/i;
/** What a truck count is counted in ("3 loads", "6 flatbeds", "4 reefers"). */
const TRUCKS = String.raw`(?:loads?|trucks?|reefers?|flatbeds?|dry vans?|vans?)`;
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const COUNT = String.raw`(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)`;
const asCount = (s: string) => WORDS[s.toLowerCase()] ?? Number(s);

interface PendingLots { lots: { qty: number; date: string; scope: 'plain' | 'all' | 'partial' }[]; evidence: string[]; hedged: boolean }
interface FreightState { withdraw: { evidence: string; hedged: boolean } | null; offered: boolean; loads: PendingLots }

const has = (auth: string[], key: string) => auth.some((a) => key.startsWith(a));

function freightSentence(x: HeuristicSentence, st: FreightState): void {
  const s = x.text;
  if (x.isQuestion || x.senderRole === 'self') {
    if (x.senderRole === 'self' && !x.isQuestion && !x.fromAttachment && BOOKED.test(s) && !NEGATED.test(s.slice(0, s.search(BOOKED)))) {
      x.claim({ key: 'decision.tender', value: 'booked', kind: 'decision', evidence: s, hedged: x.hedged });
    }
    return;
  }
  const { hedged } = x;
  const internal = x.senderRole === 'internal';
  const claim = (key: string, value: unknown, kind: 'offer' | 'decision' | 'info' = 'offer') => {
    if (kind === 'offer' && key !== 'decision.tender') st.offered = true;
    x.claim({ key, value, kind, evidence: s, hedged });
  };

  // withdrawal: kept until the end of the text (a re-quote in the same message is not a withdrawal)
  if (!internal && !x.fromAttachment && WITHDRAW.test(s) && !NOT_WITHDRAWN.test(s) && !CONDITIONAL.test(s)) {
    st.withdraw = { evidence: s, hedged };
  }

  // money: labelled amounts; an approver's amount is a budget decision
  const all = amounts(s);
  const labelled = all.map((a) => ({ a, key: labelAmount(s, a, all, MONEY_LABELS) }));
  if (internal) {
    if (BUDGET.test(s)) for (const { a, key } of labelled) if (!key || key === 'rate.all_in') claim('budget.max_all_in', a.value, 'decision');
  } else {
    const allIn = labelled.find((l) => l.key === 'rate.all_in')?.a.value;
    const fuel = labelled.find((l) => l.key === 'rate.fuel_surcharge')?.a.value;
    for (const { a, key } of labelled) {
      if (NEGATED.test(s.slice(Math.max(0, a.index - 30), a.index))) continue;
      let k = key;
      // "$2,225 + $315 fuel = $2,540 all-in": the unlabelled amount is the linehaul
      if (!k && allIn !== undefined && fuel !== undefined && Math.abs(allIn - fuel - a.value) < 0.01) k = 'rate.linehaul';
      if (k) claim(k, a.value);
    }
  }
  if (internal) return;

  // pickup window and delivery time
  for (const d of datedTimes(s, x.ref)) {
    const lead = leadOf(s, d.index, 70);
    if (OLD_VALUE.test(s.slice(Math.max(0, d.index - 25), d.index))) continue; // "…, not Wed 8am–12pm
    if (d.kind === 'window') {
      if (DELIVERY_CUE.test(lead) && !PICKUP_CUE.test(lead)) continue;
      if (has(x.senderAuthority, 'pickup.') || !x.senderAuthority.length) claim('pickup.window', d.value);
    } else if (has(x.senderAuthority, 'delivery.appointment') && !has(x.senderAuthority, 'delivery.eta')) {
      // the receiver only ever states its dock appointment ("Confirmed Thursday, Nov 5, 9am — #22468")
      if (!/\b(?:cancel\w*|no longer|not)\b/i.test(lead)) claim('delivery.appointment', d.value);
    } else {
      if (!DELIVERY_CUE.test(lead) && !DELIVERY_CUE.test(s.slice(d.end, d.end + 25))) continue;
      if (/\b(?:delivered|arrived|unloaded|received)\b/i.test(lead)) continue; // a delivery that happened is not an ETA
      if (PICKUP_CUE.test(lead) && !DELIVERY_CUE.test(lead)) continue;
      claim('delivery.eta', d.value);
    }
  }

  // equipment and reefer set point
  const eq = s.match(EQUIPMENT);
  if (eq && !NEGATED.test(s.slice(0, eq.index)) && (x.fromAttachment ? /^\s*equipment\b/i.test(s) : !/\b(?:carry|carries|rates?|demand|empty in)\b/i.test(s))) {
    const word = eq[1].toLowerCase();
    claim('equipment.type', /reefer|refrigerated/.test(word) ? 'reefer' : /flat/.test(word) ? 'flatbed' : 'dry_van');
  }
  const t = s.match(/(-?\d{1,3})\s*°\s*F\b/i);
  if (t && !NEGATED.test(s.slice(0, t.index))) claim('equipment.reefer_temp_f', Number(t[1]));

  // documents and forms: MC, weight, remit-to, payment terms
  const mc = s.match(/\bMC\s*#?\s*(\d{5,8})\b/);
  if (mc) claim('carrier.mc_number', mc[1], 'info');
  const remit = fieldValue(s, /remit(?:[- ]to| payment to)?/i)
    ?? s.match(/\b(?:(?:remit|send|direct|route|make|wire)(?: all| any)?(?: future)? (?:payments?|funds|remittances?)|remit|remittance|payments? (?:should|must|will) (?:now )?(?:go|be (?:sent|made|remitted|directed))|pay(?:ment)? (?:is )?to be (?:sent|made))(?: (?:for|on) [^.:]{0,60}?)?\s+to\s*:?\s+([^.;]+?)\s*(?:\.(?:\s|$)|;|$)/i)?.[1];
  if (remit && /\d|llc|inc|bank|factor|funding|capital|account|box/i.test(remit)) claim('payment.remit_to', remit.replace(/\s+/g, ' ').trim());
  const terms = fieldValue(s, /payment terms/i) ?? s.match(/\b(net\s?-?\d{1,3}(?:\s+days)?|quick\s?pay[^.;]*?\d+\s*days?)\b/i)?.[1];
  if (terms) claim('payment.terms', terms.replace(/^net\s?-?(\d+).*$/i, 'Net $1').trim());

  // numbered loads of a multi-load shipment ("ACM-50191-1 and ACM-50191-2 delivered", "ACM-50191-3 got pushed to Thu")
  const loadIds = (text: string) => new Set([...text.matchAll(/\b[A-Z]{2,6}-\d{3,}-\d{1,2}\b/g)].map((m) => m[0])).size;
  const dates = findDates(s, x.ref);
  if (!x.fromAttachment) {
    const delivered = s.match(/\b(?:delivered|have delivered|were delivered|got delivered|delivered clean|unloaded)\b/i);
    if (delivered && !/\b(?:will|to be|should|once)\b/i.test(s.slice(0, delivered.index))) {
      const n = loadIds(s.slice(0, delivered.index)) || asCount(s.slice(0, delivered.index).match(new RegExp(String.raw`\b${COUNT}\s+(?:\w+\s+)?${TRUCKS}\b`, 'i'))?.[1] ?? '0');
      if (n > 0) x.fulfillment({ quantity: n, evidence: s, term_key: 'capacity.loads', obligation_id: null });
    }
    const moved = s.match(/\b(?:pushed|moved?|moving|slipp(?:ed|ing)|slips?|rolled|rescheduled|bumped)\b[^.]{0,30}?\b(?:to|until|till)\b/i);
    if (moved && dates.some((d) => d.index > moved.index!)) {
      const n = loadIds(s.slice(0, moved.index)) || asCount(s.slice(0, moved.index).match(new RegExp(String.raw`\b${COUNT}\s+(?:\w+\s+)?${TRUCKS}\b`, 'i'))?.[1] ?? '0');
      const when = dates.find((d) => d.index > moved.index!)!;
      if (n > 0) {
        st.loads.lots.push({ qty: n, date: when.iso, scope: 'partial' });
        st.loads.evidence.push(s);
        return;
      }
    }
    // "Can do all 3 loads": a commitment to cover that many trucks
    const commit = s.match(new RegExp(String.raw`\b(?:can do|can cover|can take|will take|we'll take|will cover|we'll cover|have trucks for|got trucks for|good to go on|confirmed? on|committing)\b[^.]{0,20}?\b(?:all\s+)?${COUNT}\s+(?:\w+\s+)?${TRUCKS}\b`, 'i'));
    if (commit && asCount(commit[1]) > 1 && !hedged) x.obligation({ kind: 'commitment', debtor: 'sender', text: commit[0], topic_keys: ['capacity.loads'] });
  }

  // truck counts per pickup day ("all 3 loads Tue Dec 1", "the other 2 trucks Thursday")
  if (dates.length) {
    const counted = String.raw`\b(?:(all|the other|the remaining|remaining|other|the last|last|the rest of the)\s+${COUNT}\b(?:\s+(?:\w+\s+)?${TRUCKS}\b)?|${COUNT}\s+(?:\w+\s+)?${TRUCKS}\b)`;
    for (const raw of s.matchAll(new RegExp(counted, 'gi'))) {
      const m = [raw[0], raw[1], raw[2] ?? raw[3]] as const;
      const at = raw.index!;
      if (!raw[1] && /\b(?:of the|of)\s*$/i.test(s.slice(0, at))) continue;
      // a bare count ("the remaining 2") needs the sentence to be about trucks or numbered loads
      if (!new RegExp(TRUCKS, 'i').test(raw[0]) && !loadIds(s) && !new RegExp(`\\b${TRUCKS}\\b`, 'i').test(s)) continue;
      if (NEGATED.test(s.slice(Math.max(0, at - 30), at))) continue;
      const after = dates.find((d) => d.index > at) ?? dates[dates.length - 1];
      const scope = !m[1] ? 'plain' : /all/i.test(m[1]) ? 'all' : 'partial';
      st.loads.lots.push({ qty: asCount(m[2]), date: after.iso, scope });
      st.loads.evidence.push(s);
      st.loads.hedged ||= hedged;
    }
  }
}

function freightEnd(st: FreightState, emit: HeuristicSentence['claim']): void {
  if (st.withdraw && !st.offered) emit({ key: 'offer.status', value: 'withdrawn', kind: 'offer', evidence: st.withdraw.evidence, hedged: st.withdraw.hedged });
  const { lots } = st.loads;
  if (!lots.length) return;
  const restated = lots.filter((l) => l.scope === 'all');
  const chosen = restated.length ? [restated[restated.length - 1]] : lots;
  const partial = !restated.length && chosen.every((l) => l.scope === 'partial');
  const unique = chosen.filter((l, i) => chosen.findIndex((o) => o.qty === l.qty && o.date === l.date) === i);
  emit({ key: 'capacity.loads', value: unique.map(({ qty, date }) => ({ qty, date })), kind: 'offer', evidence: [...new Set(st.loads.evidence)].join(' … '), hedged: st.loads.hedged, partial });
}

export const BINDING_PATTERNS = [
  /\b((?:we|i)\s+(?:hereby\s+)?accept\b|accept(?:s|ed|ing)?\s+(?:your|the|this)\s+(?:offer|quote|rate|load|tender|rate con(?:firmation)?)\b|(?:you(?:'re| are)|you(?:'ve| have) been)\s+(?:booked|confirmed)\b|(?:load|it)(?:'s| is)\s+(?:booked|yours)\b|(?:let's|we(?:'ll| will)|go ahead and)\s+book\b|book(?:ing)?\s+(?:it|the load|this load|you)\b|tender(?:ing|ed)?\s+(?:the|this)\s+load\s+to\s+you|we\s+confirm\s+the\s+(?:rate|load|booking)|(?:signed|countersigned)\s+(?:the\s+)?rate con|release\s+(?:the\s+)?payment|(?:we(?:'ve| have)|i(?:'ve| have))\s+(?:updated|changed)\s+(?:the\s+|your\s+)?remit|approve\s+(?:the\s+)?payment|wire\s+(?:the\s+)?funds)/gi,
];

export const freight: DomainPack = {
  id: 'freight',
  agentRole: "You are Acme Logistics' booking agent: you cover truckload shipments for Acme's shipper customers by email with carriers, receivers and Acme operations.",
  terms: TERMS,
  llmGuidance: [
    '- Times are the deal\'s local time, exactly as written ("Wed 11/18 0600-1000" → pickup.window {"start":"2026-11-18T06:00","end":"2026-11-18T10:00"}; "Thu Nov 19 @ 1000" → "2026-11-19T10:00"). Resolve weekdays and dates without a year against the message date.',
    '- pickup.window is when the carrier\'s truck will be at the shipper; the shipper\'s own loading window in our request is not the carrier\'s claim. delivery.eta is the carrier\'s (dispatcher or driver) committed/estimated arrival at the consignee; a rate con\'s "Delivery: … (appointment)" line is the carrier committing to that time. delivery.appointment is set only by the receiver.',
    '- Rates: rate.all_in = linehaul + fuel for one load. Output rate.linehaul, rate.fuel_surcharge and rate.all_in separately whenever they are stated or follow from the numbers given ("$2,540 all in, $2,225 line haul" → fuel 315). A per-load rate on a multi-load commitment is the per-load all-in.',
    '- equipment.type: "reefer" for refrigerated, "dry_van" for a van, "flatbed" for flatbed/step deck. equipment.reefer_temp_f is the set point (can be negative).',
    '- capacity.loads is the carrier\'s full resulting set of trucks per pickup day: [{"qty":3,"date":"2026-12-01"}]. If some loads slip to another day, output the full new split (e.g. 2 on the original day + 1 on the new day). Loads already picked up/delivered with PODs are fulfillments (quantity = number of loads), not new lots.',
    '- payment.remit_to is the full payee as written on the rate con ("Remit to:" line), e.g. "Ridgeline Transport LLC, PO Box 2290, Fresno, CA 93745". A request to pay a different payee or bank is a payment.remit_to claim from that sender (the resolver decides whether it is trusted). payment.terms as written ("Net 30", "Quick pay 2%, 5 days").',
    '- budget.max_all_in only from Acme ops approving a ceiling ("approved up to $3,800 all-in"); kind=decision. Our own request for approval is not a budget.',
    '- offer.status="withdrawn" when the carrier falls off the load / the truck fell through / it withdraws its quote and does NOT re-quote in the same message. A re-quote (a different truck at new terms) is new rate/window claims with mode=correction, not a withdrawal.',
    '- decision.tender="booked" when we (Acme) book or tender the load to a carrier ("you\'re booked", "we accept your rate con").',
    '- A promise to send a (corrected/revised/signed) rate con → expects_artifact "rate_confirmation"; BOL → "bol"; POD → "pod"; W-9/COI/carrier packet → "w9_coi"; invoice → "invoice".',
  ].join('\n'),
  normalizeValue(key, value) {
    const def = termDef(key);
    if (!def) return null;
    if (key === 'equipment.type' && typeof value === 'string') {
      const v = value.toLowerCase();
      return normalizeTyped(def, /reefer|refrig/.test(v) ? 'reefer' : /flat|step/.test(v) ? 'flatbed' : /van/.test(v) ? 'dry_van' : v);
    }
    if (key === 'payment.terms' && typeof value === 'string') return normalizeTyped(def, value.replace(/^net\s?-?(\d+)$/i, 'Net $1'));
    return normalizeTyped(def, value);
  },
  displayValue(key, value) {
    const def = termDef(key);
    if (!def) return String(value);
    if (key === 'equipment.type') return EQ[String(value)] ?? String(value);
    if (key === 'equipment.reefer_temp_f') return `${value}°F`;
    if (key === 'accessorial.detention_per_hour') return `${displayTyped(def, value)}/hr`;
    if (key === 'load.weight_lbs') return `${Number(value).toLocaleString('en-US')} lbs`;
    return displayTyped(def, value);
  },
  mergePartial: (key, current, update) => (key === 'capacity.loads' ? mergePartialLots(current as Lot[], update as Lot[]) : null),
  runChecks,
  expectedTerms: expectedFrom(TERMS, new Set(['load.weight_lbs', 'carrier.mc_number', 'capacity.loads', 'decision.tender', 'rate.linehaul', 'rate.fuel_surcharge', 'accessorial.detention_per_hour', 'payment.terms', 'delivery.appointment'])),
  decisionKey: 'decision.tender',
  bindingPatterns: BINDING_PATTERNS,
  trackDocumentRequests: true,
  documentKinds: [
    { kind: 'pod', match: /\bPOD\b|proof of delivery|delivery receipt/i, promise: /\bPODs?\b|proof of delivery/i, multipart: true },
    { kind: 'bol', match: /\bBOL\b|bill of lading/i, promise: /\bBOLs?\b|bill of lading/i, multipart: true },
    { kind: 'invoice', match: /invoice/i, promise: /\binvoice\b/i },
    { kind: 'w9_coi', match: /\bW-?9\b|\bCOI\b|certificate of (?:liability )?insurance|carrier (?:setup )?packet/i, promise: /\bW-?9\b|\bCOI\b|certificate of insurance|(?:setup|carrier) packet|insurance cert/i },
    { kind: 'rate_confirmation', match: /rate\s?con|rate confirmation/i, promise: /\brate\s?con(?:firmation)?s?\b|\bconfirmation\b/i },
  ],
  loopSubject(o) {
    if (o.kind === 'commitment' && o.quantity != null) return 'delivery.remaining_loads';
    return null;
  },
  extraActions: (ctx) => standardActions(ctx, {
    approvalPrefix: 'budget.', approvalKey: 'budget.max_all_in', decisionKey: 'decision.tender', approvalAsk: 'approval of the carrier budget',
    commit: (who) => `${who}'s quote meets every requirement — book the load in writing, restating rate, pickup window, delivery and equipment`,
    waitForDocuments: false,
  }),
  heuristic: {
    begin: (): FreightState => ({ withdraw: null, offered: false, loads: { lots: [], evidence: [], hedged: false } }),
    sentence: (s, st) => freightSentence(s, st as FreightState),
    end: (st, emit) => freightEnd(st as FreightState, emit),
  },
  quantityOf(text) {
    const m = text.match(new RegExp(String.raw`\b(?:all\s+)?${COUNT}\s+(?:\w+\s+)?${TRUCKS}\b`, 'i'));
    if (!m) return null;
    const n = asCount(m[1]);
    return n > 1 ? n : null;
  },
  dueOf(text, ref) {
    if (!/\b(pick ?up|load|deliver|cover)\w*/i.test(text)) return null;
    return findDates(text, ref)[0]?.iso ?? null;
  },
};

registerDomain(freight);
