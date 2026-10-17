// The procurement domain pack: which terms the engine tracks, how their values are typed, the
// deterministic checks that turn terms into conflicts, and the offline extraction patterns.
import type { CheckResult, Claim, Participant, TaskSpec } from '../types.ts';
import { findDates, prettyDate } from '../extract/dates.ts';
import { registerDomain, sameValue, termOf, type DomainPack, type HeuristicSentence, type TermDef } from './pack.ts';

export interface Lot { qty: number; date: string }

export const TERMS: TermDef[] = [
  { key: 'price.unit', type: 'money', description: 'Offered unit price in USD', topics: ['price', 'pricing', 'unit cost', 'cost per', 'quote', '$', 'per unit'] },
  { key: 'delivery.schedule', type: 'schedule', description: 'Offered delivery schedule: list of {qty, date} lots', topics: ['deliver', 'delivery', 'arrive', 'ship', 'lead time', 'schedule', 'when', 'by friday', 'units'] },
  { key: 'order.quantity', type: 'number', description: 'Quantity offered/available in total', topics: ['quantity', 'how many', 'units', 'volume'] },
  { key: 'payment.terms', type: 'text', description: 'Payment terms, e.g. Net 30', topics: ['payment', 'terms', 'net 30', 'invoice'] },
  { key: 'quote.valid_until', type: 'date', description: 'Date the quote expires', topics: ['valid', 'expire', 'expiry'] },
  { key: 'offer.status', type: 'enum', values: ['withdrawn'], lifecycle: true, description: 'The counterparty withdrew/cancelled its offer or cannot supply (value "withdrawn"). History is kept; the offer is no longer available.', topics: ['withdraw', 'cancel', 'disregard', 'rescind'] },
  { key: 'budget.max_unit_price', type: 'money', description: 'Internally approved maximum unit price (a decision by finance/approver)', topics: ['budget', 'approve', 'approval', 'authoriz', 'sign off', 'sign-off'] },
  { key: 'decision.order', type: 'text', description: 'A party accepting/declining/placing the order', topics: ['accept', 'confirm the order', 'place the order', 'go ahead', 'po '] },
];

export const TERM_KEYS = new Set(TERMS.map((t) => t.key));

export function termDef(key: string): TermDef | undefined {
  return TERMS.find((t) => t.key === key);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a proposed value against its term and put it in canonical form; null when unusable. */
export function normalizeValue(key: string, value: unknown): unknown | null {
  const def = termDef(key);
  if (!def) return typeof value === 'string' || typeof value === 'number' ? value : null;
  return normalizeTyped(def, value);
}

export function normalizeTyped(def: TermDef, value: unknown): unknown | null {
  switch (def.type) {
    case 'money':
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
      return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
    }
    case 'date':
      return typeof value === 'string' && ISO_DAY.test(value) ? value : null;
    case 'enum': {
      const v = typeof value === 'string' ? value.trim().toLowerCase() : null;
      return v !== null && def.values?.includes(v) ? v : null;
    }
    case 'text':
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    case 'schedule': {
      if (!Array.isArray(value) || !value.length) return null;
      const byDate = new Map<string, number>();
      for (const lot of value as Record<string, unknown>[]) {
        const qty = Number(lot?.qty);
        const date = String(lot?.date ?? '');
        if (!Number.isFinite(qty) || qty <= 0 || !ISO_DAY.test(date)) return null;
        byDate.set(date, (byDate.get(date) ?? 0) + qty); // lots arriving the same day are one delivery
      }
      return [...byDate].map(([date, qty]) => ({ qty, date })).sort((a, b) => a.date.localeCompare(b.date));
    }
  }
}

/** How a value reads in briefings: "$11.40", "300 units Fri Oct 23 + 200 units Wed Oct 28". */
export function displayValue(key: string, value: unknown): string {
  const def = termDef(key);
  return def ? displayTyped(def, value) : String(value);
}

export function displayTyped(def: TermDef, value: unknown): string {
  switch (def.type) {
    case 'money': return `$${Number(value).toFixed(2)}`;
    case 'date': return prettyDate(String(value));
    case 'schedule': return (value as Lot[]).map((l) => `${l.qty} units ${prettyDate(l.date)}`).join(' + ');
    default: return String(value);
  }
}

/**
 * Apply a partial update ("the remaining 200 now arrive Fri") to a schedule. A lot of exactly that size
 * moves. Otherwise, if exactly one larger lot sits on another date, it is split ("of the 500 due Friday,
 * the remaining 200 arrive Monday" → 300 Friday + 200 Monday). Anything else is ambiguous: null.
 */
export function mergePartialSchedule(current: Lot[], update: Lot[]): Lot[] | null {
  const lots = current.map((l) => ({ ...l }));
  for (const u of update) {
    const same = lots.find((l) => l.qty === u.qty && l.date !== u.date);
    if (same) {
      same.date = u.date;
      continue;
    }
    const larger = lots.filter((l) => l.qty > u.qty && l.date !== u.date);
    if (larger.length !== 1) return null;
    larger[0].qty -= u.qty;
    lots.push({ qty: u.qty, date: u.date });
  }
  return normalizeValue('delivery.schedule', lots) as Lot[];
}

export { sameValue };

// Terms whose absence is never "missing information" worth chasing.
const NOT_CHASED = new Set(['quote.valid_until', 'decision.order', 'order.quantity', 'payment.terms', 'offer.status']);

/** Which terms each other party is expected to supply. */
export function expectedTerms(task: TaskSpec): { party: Participant; keys: string[] }[] {
  return task.participants
    .filter((p) => p.role !== 'self')
    .map((party) => ({
      party,
      keys: TERMS.map((t) => t.key).filter((k) => !NOT_CHASED.has(k) && party.authority.some((a) => k.startsWith(a))),
    }));
}

const requirement = (task: TaskSpec, key: string) => task.requirements.find((r) => r.key === key);

/**
 * Deterministic checks over *active* claims. Pure: the same state always gives the same conflicts, so a
 * conflict is never something a model has to remember.
 */
export function runChecks(task: TaskSpec, active: Claim[]): CheckResult[] {
  const results: CheckResult[] = [];
  const deadline = requirement(task, 'requirement.deliver_all_by');
  const quantity = requirement(task, 'requirement.quantity');
  const maxPrice = requirement(task, 'requirement.max_unit_price');
  const budget = active.find((c) => c.key === 'budget.max_unit_price');
  const term = (key: string, speaker: string) => active.find((c) => c.key === key && c.speaker === speaker);

  for (const party of task.participants.filter((p) => p.role === 'counterparty')) {
    const who = party.address;

    const withdrawn = active.find((c) => c.key === 'offer.status' && c.speaker === who && c.value === 'withdrawn');
    if (withdrawn) {
      // a withdrawn offer is history, not an option: nothing else is checked against it
      results.push({
        id: `offer_available:${who}`, label: `Offer from ${party.label} available`, status: 'fail', party: who, evidence: [withdrawn.id],
        requirement_key: 'offer.status', detail: `${party.label} withdrew its offer (${withdrawn.source_event_id}); earlier terms are no longer available`,
      });
      continue;
    }

    const schedule = term('delivery.schedule', who);
    const price = term('price.unit', who);
    const qtyClaim = term('order.quantity', who);

    if (deadline) {
      const label = `All units by ${deadline.display}`;
      const id = `delivery_deadline:${who}`;
      if (!schedule) {
        results.push({ id, label, status: 'unknown', detail: `No delivery schedule from ${party.label} yet`, party: who, evidence: [], requirement_key: deadline.key });
      } else {
        const late = (schedule.value as Lot[]).filter((l) => l.date > String(deadline.value));
        results.push({
          id, label, party: who, evidence: [schedule.id], requirement_key: deadline.key,
          status: late.length ? 'fail' : 'pass',
          detail: late.length
            ? `${late.map((l) => `${l.qty} units arrive ${prettyDate(l.date)}`).join(', ')} — after the ${deadline.display} deadline (${party.label}'s current schedule: ${schedule.display})`
            : `${party.label}'s schedule (${schedule.display}) meets the deadline`,
        });
      }
    }

    if (quantity) {
      const label = `Quantity ${quantity.display}`;
      const id = `quantity:${who}`;
      const source = schedule ?? qtyClaim;
      if (!source) {
        results.push({ id, label, status: 'unknown', detail: `Quantity not yet offered by ${party.label}`, party: who, evidence: [], requirement_key: quantity.key });
      } else {
        const offered = schedule ? (schedule.value as Lot[]).reduce((sum, l) => sum + l.qty, 0) : Number(qtyClaim!.value);
        const enough = offered >= Number(quantity.value);
        results.push({
          id, label, party: who, evidence: [source.id], requirement_key: quantity.key,
          status: enough ? 'pass' : 'fail',
          detail: enough ? `${offered} units offered` : `Only ${offered} of ${quantity.value} units offered`,
        });
      }
    }

    if (maxPrice || budget) {
      const label = 'Unit price within budget';
      const id = `price_budget:${who}`;
      const requirementKey = maxPrice?.key ?? 'budget.max_unit_price';
      const cap = budget ? Number(budget.value) : Number(maxPrice!.value);
      const capLabel = budget ? `approved budget ${budget.display}/unit` : `target max ${maxPrice!.display}/unit (finance approval pending)`;
      if (!price) {
        results.push({ id, label, status: 'unknown', detail: `No price from ${party.label} yet`, party: who, evidence: budget ? [budget.id] : [], requirement_key: requirementKey });
      } else {
        const within = Number(price.value) <= cap;
        results.push({
          id, label, party: who, evidence: budget ? [price.id, budget.id] : [price.id], requirement_key: requirementKey,
          status: within ? 'pass' : 'fail',
          detail: `${price.display}/unit ${within ? 'is within' : 'exceeds'} ${capLabel}`,
        });
      }
    }
  }

  const hasApprover = task.participants.some((p) => p.authority.some((a) => a.startsWith('budget')));
  if (maxPrice && hasApprover) {
    results.push({
      id: 'budget_approval', label: 'Budget approved', requirement_key: 'budget.max_unit_price', party: budget?.speaker ?? null,
      status: !budget ? 'unknown' : Number(budget.value) >= Number(maxPrice.value) ? 'pass' : 'fail',
      evidence: budget ? [budget.id] : [],
      detail: budget ? `Approved up to ${budget.display}/unit` : 'No budget approval recorded yet',
    });
  }
  return results;
}

// ==================================================================== offline extraction patterns

const BUDGET = /\b(approv\w*|budget\w*|authori[sz]\w*|sign(?:ed)?[- ]off|not to exceed|ceiling|cap(?:ped)?|maximum|max)\b/i;
const PER_UNIT = /(per\s+unit|\/\s*unit|each\b|\/\s*ea\b|per\s+piece|per\s+pc|a\s+unit|unit\s+price|price\s+per)/i;
const DELIVERY = /\b(deliver\w*|arriv\w*|ship\w*|dispatch\w*|in stock|available|lead time|land(?:s|ing)?|delay\w*)\b/i;
const NEGATED_DELIVERY = /\b(cannot|can't|can not|won't|will not|unable to|not able to)\b/i;
/** A completed delivery ("300 have been delivered", "the first 300 arrived"): fulfilment, not a schedule. */
const DELIVERED = /\b(?:ha(?:s|ve) (?:been |now )?(?:delivered|arrived|received|landed)|(?:was|were) (?:delivered|received)|(?:we )?delivered|(?:just |have )?arrived)\b/i;
const FUTURE = /\b(will|would|should|going to|expected|scheduled|planned|can|could|to be|until|by next)\b/i;
const WITHDRAW = new RegExp([
  String.raw`\b(?:withdraw(?:n|ing|s)?|rescind(?:ed|ing)?|retract(?:ed|ing)?|cancel+(?:ed|ing)?)\b[^.]{0,40}\b(?:offer|quote|quotation|proposal|bid)\b`,
  String.raw`\b(?:offer|quote|quotation|proposal|bid)\b[^.]{0,30}\b(?:withdrawn|rescinded|cancel+ed|void|no longer (?:valid|available|stands))\b`,
  String.raw`\bdisregard (?:the|our|my) (?:previous|earlier|last|prior) (?:offer|quote|quotation|proposal)\b`,
  String.raw`\bwe (?:have |are |hereby )?(?:withdrawn|withdrawing|withdraw|rescinded|retracted) (?:it|our offer|the offer|our quote|the quote)\b`,
  String.raw`\b(?:cannot|can't|can not|unable to|no longer able to|won't be able to|will not be able to) (?:supply|fulfil|fulfill|fill|take on) (?:this|the|your) (?:order|po|request|requirement)\b`,
].join('|'), 'i');
const NOT_WITHDRAWN = /\b(?:not|never|haven't|have not|hasn't|has not)\s+(?:been\s+)?(?:withdraw|withdrawn|rescind|cancel)/i;
const CONDITIONAL = /\b(if|unless|would you|should we)\b/i;
const PRICE = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
const LOT = /\b(?:(all|the other|the remaining|the final|the last|the rest of the|other|remaining|final|last|rest of the)\s+)?(\d{1,3}(?:,\d{3})+|\d+)\s*(units?|pcs|pieces|ea)?\b/gi;
const ACCEPTANCE = /\b(we (?:hereby )?accept|we confirm the order|please proceed with the order|go ahead with the order|we are placing the order|order (?:is )?confirmed)\b/i;

const toNumber = (s: string) => Number(s.replace(/,/g, ''));

interface PendingLot { qty: number; date: string; evidence: string; hedged: boolean; scope: 'plain' | 'all' | 'partial' }
interface ProcurementState { lots: PendingLot[] }

function procurementSentence(x: HeuristicSentence, state: ProcurementState): void {
  const s = x.text;
  const external = x.senderRole !== 'self';
  const { hedged } = x;
  if (x.isQuestion) return; // facts never come from questions

  // offer withdrawn or cancelled (lifecycle): history stays, availability ends
  if (external && !x.fromAttachment && WITHDRAW.test(s) && !NOT_WITHDRAWN.test(s) && !CONDITIONAL.test(s)) {
    x.claim({ key: 'offer.status', value: 'withdrawn', kind: 'offer', evidence: s, hedged });
    return;
  }

  // prices need per-unit context; budget language from an internal approver is a budget decision
  for (const m of s.matchAll(PRICE)) {
    const at = m.index!;
    const after = s.slice(at, at + m[0].length + 22);
    const before = s.slice(Math.max(0, at - 30), at);
    const perUnit = (PER_UNIT.test(after) && !/\btotal\b/i.test(after)) || /(unit price|price per unit|per[- ]unit price)\s*(?:of|is|at|:)?\s*$/i.test(before);
    if (!perUnit || /\b(total|in total|overall)\s*$/i.test(before)) continue;
    if (BUDGET.test(s) && (x.senderRole === 'internal' || /approv|budget|authori/i.test(s))) {
      if (x.senderRole === 'internal') x.claim({ key: 'budget.max_unit_price', value: toNumber(m[1]), kind: 'decision', evidence: s, hedged });
    } else if (external) {
      x.claim({ key: 'price.unit', value: toNumber(m[1]), kind: 'offer', evidence: s, hedged });
    }
  }

  // a completed delivery ("First shipment of 300 has been delivered") is fulfilment evidence, not a schedule
  if (external && !x.fromAttachment && DELIVERED.test(s) && !FUTURE.test(s.slice(0, s.search(DELIVERED) + 1)) && !NEGATED_DELIVERY.test(s)) {
    const q = s.match(/\b(\d{1,3}(?:,\d{3})+|\d+)\s*(?:units?|pcs|pieces|boards?|ea)?\b/);
    const firstClause = s.split(/[.;]|\b(?:but|and|while)\b/i)[0];
    if (q && DELIVERED.test(firstClause)) {
      x.fulfillment({ quantity: toNumber(q[1]), evidence: s, term_key: 'delivery.schedule', obligation_id: null });
      // the rest of the sentence may still hold a schedule ("…, the remaining 200 arrive Monday")
    }
  }

  // delivery lots: "<qty> units … <date>" in a delivery sentence
  if (external && DELIVERY.test(s)) {
    const qtys = [...s.matchAll(LOT)]
      .filter((m) => m[3] || m[1]) // a bare number needs a unit or a lot word ("the other 200")
      .map((m) => ({
        qty: toNumber(m[2]),
        index: m.index!,
        scope: (!m[1] ? 'plain' : m[1].toLowerCase() === 'all' ? 'all' : 'partial') as PendingLot['scope'],
      }))
      .filter((q) => q.qty > 0 && q.qty < 1e7 && !/^\$/.test(s.slice(Math.max(0, q.index - 1), q.index + 1)));
    const dates = findDates(s, x.ref).filter((d) => !/^(today)$/i.test(d.text));
    if (qtys.length && dates.length) {
      const pairs = qtys.length === dates.length
        ? qtys.map((q, i) => ({ q, d: dates[i] }))
        : qtys.map((q) => ({ q, d: dates.find((d) => d.index > q.index) ?? dates[dates.length - 1] }));
      // "200 won't arrive until Wednesday" names an arrival date; "can't arrive Friday" (no "until") does not
      const negatedArrival = NEGATED_DELIVERY.test(s) && !/\b(until|till|before|earliest)\b/i.test(s);
      for (const { q, d } of pairs) {
        if (negatedArrival) continue;
        // a quantity this sentence says was already delivered is not a future lot
        const lead = s.slice(0, q.index);
        if (DELIVERED.test(s.slice(q.index, q.index + 60).split(/[,;]/)[0]) && !/\b(remaining|other|rest)\s*$/i.test(lead)) continue;
        state.lots.push({ qty: q.qty, date: d.iso, evidence: s, hedged, scope: q.scope });
      }
    }
  }

  // payment terms, quote validity, an explicit quantity line
  if (external) {
    const net = s.match(/\bnet\s?-?(\d{1,3})\b/i);
    if (net) x.claim({ key: 'payment.terms', value: `Net ${net[1]}`, kind: 'offer', evidence: s, hedged });
    const valid = s.match(/\bvalid\s+(?:until|through|thru|till)\b/i);
    if (valid) {
      const d = findDates(s.slice(valid.index!), x.ref)[0];
      if (d) x.claim({ key: 'quote.valid_until', value: d.iso, kind: 'offer', evidence: s, hedged });
    }
    const qty = s.match(/^\s*(?:quantity|qty)\s*[:\-]\s*(\d{1,3}(?:,\d{3})+|\d+)/i);
    if (qty) x.claim({ key: 'order.quantity', value: toNumber(qty[1]), kind: 'offer', evidence: s, hedged });
  }

  // order decisions: our own acceptance, or the counterparty confirming the order
  if (!x.fromAttachment && ACCEPTANCE.test(s)) {
    x.claim({ key: 'decision.order', value: 'accepted', kind: 'decision', evidence: s, hedged });
  }
}

/** One schedule claim per text. "All 500 arrive Friday" restates the whole schedule; "the remaining 200 …"
 *  on its own is a partial update. */
function procurementEnd(state: ProcurementState, claim: HeuristicSentence['claim']): void {
  const { lots } = state;
  if (!lots.length) return;
  const restated = lots.filter((l) => l.scope === 'all');
  const chosen = restated.length ? [restated[restated.length - 1]] : lots;
  const partial = !restated.length && chosen.every((l) => l.scope === 'partial');
  const unique = chosen.filter((l, i) => chosen.findIndex((o) => o.qty === l.qty && o.date === l.date) === i);
  claim({
    key: 'delivery.schedule',
    value: unique.map(({ qty, date }) => ({ qty, date })),
    kind: 'offer',
    evidence: [...new Set(unique.map((l) => l.evidence))].join(' … '),
    hedged: unique.some((l) => l.hedged),
    partial,
  });
}

export const BINDING_PATTERNS = [
  /\b((?:we|i)\s+(?:hereby\s+)?accepts?\b|accept(?:s|ed)?\s+(?:it|your|the|this)\b(?:\s+(?:offer|quote|proposal|order|terms))?|confirm the order|place the order|we are placing|purchase order is confirmed|approve (?:the )?payment|authori[sz]e (?:the )?payment|wire (?:the )?funds)/gi,
  // "<Company> accepts …" (case-sensitive: a capitalised name as the subject)
  /\b[A-Z][A-Za-z]+\s+(?:hereby\s+)?accepts\b/g,
];

export const procurement: DomainPack = {
  id: 'procurement',
  agentRole: 'You are a procurement agent acting for Acme by email.',
  terms: TERMS,
  llmGuidance: [
    '- delivery.schedule must be the sender\'s full resulting schedule as lots of {qty, date}. Resolve relative dates against the message date and referents like "the other 200" against the current terms provided. If the message only changes some lots, still output the full resulting schedule and set partial=false; set partial=true only if you cannot determine the full schedule.',
    '- Units already delivered/received ("300 have been delivered") are a fulfillment (fulfillments[]), not a future delivery lot.',
    '- offer.status="withdrawn" when the sender withdraws/cancels its offer or says it cannot supply the order. Do not restate the withdrawn terms as claims.',
  ].join('\n'),
  normalizeValue,
  displayValue,
  mergePartial: (key, current, update) => (key === 'delivery.schedule' ? mergePartialSchedule(current as Lot[], update as Lot[]) : null),
  runChecks: (task, active) => runChecks(task, active),
  expectedTerms,
  decisionKey: 'decision.order',
  bindingPatterns: BINDING_PATTERNS,

  extraActions({ task, checks, live, contested, openDebtors }) {
    const actions: ReturnType<NonNullable<DomainPack['extraActions']>> = [];
    const self = task.self_address.toLowerCase();

    for (const c of checks.filter((x) => x.id.startsWith('offer_available:') && x.status === 'fail')) {
      const party = task.participants.find((p) => p.address === c.party);
      actions.push({
        priority: 1, kind: 'offer_withdrawn', to: null, to_address: null, check_id: c.id,
        action: `${party?.label ?? c.party} withdrew its offer — do not accept or rely on its earlier terms; find another source or escalate to the requester`,
        why: c.detail,
        evidence: c.evidence.map((id) => live.find((l) => l.id === id)?.source_event_id).filter((x): x is string => !!x),
      });
    }

    if (checks.some((c) => c.id === 'budget_approval' && c.status === 'unknown')) {
      const approver = task.participants.find((p) => p.authority.some((a) => a.startsWith('budget')));
      const asked = approver && openDebtors.some((o) => o.debtor === approver.address && o.topic_keys.includes('budget.max_unit_price'));
      if (approver && !asked) {
        const cap = task.requirements.find((r) => r.key === 'requirement.max_unit_price')?.display ?? 'target';
        actions.push({
          priority: 2, kind: 'request_approval', to: approver.label, to_address: approver.address, check_id: 'budget_approval',
          action: `Request budget approval from ${approver.label} (up to ${cap}/unit)`, why: 'No budget approval recorded', evidence: [],
        });
      }
    }

    const accepted = live.some((c) => c.key === 'decision.order' && c.speaker === self);
    const allPass = checks.length > 0 && checks.every((c) => c.status === 'pass') && !contested.length;
    if (allPass && !accepted) {
      const supplier = task.participants.find((p) => p.role === 'counterparty');
      actions.push({
        priority: 1, kind: 'accept_offer', to: supplier?.label ?? null, to_address: supplier?.address ?? null,
        action: `All requirements are met by ${supplier?.label}'s current offer — confirm/accept the order in writing, restating the agreed terms`,
        why: checks.map((c) => c.detail).join('; '), evidence: [],
      });
    }
    return actions;
  },

  heuristic: {
    begin: (): ProcurementState => ({ lots: [] }),
    sentence: (s, state) => procurementSentence(s, state as ProcurementState),
    end: (state, emit) => procurementEnd(state as ProcurementState, emit),
  },

  quantityOf(text) {
    if (!/\b(deliver|ship|supply|send)\b/i.test(text)) return null;
    const m = text.match(/\b(?:all\s+)?(\d{1,3}(?:,\d{3})+|\d+)\s*(?:units?|pcs|pieces|boards?)?\b/i);
    if (!m || /^\d{4}$/.test(m[1])) return null; // a year, not a quantity
    const n = toNumber(m[1]);
    return Number.isFinite(n) && n > 1 && n < 1e7 ? n : null;
  },

  dueOf(text, ref) {
    if (!/\b(deliver|ship|arrive)\b/i.test(text)) return null;
    return findDates(text, ref)[0]?.iso ?? null;
  },
};

registerDomain(procurement);

export function termDefOf(key: string): TermDef | undefined {
  return termOf(procurement, key);
}
