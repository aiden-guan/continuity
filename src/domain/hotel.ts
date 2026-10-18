// The hotel group-sales pack: a meeting planner books a room block and meeting space by email. The
// hotel's group sales manager (with its revenue manager in the same group) quotes the rate, the nightly
// block, attrition, cutoff, F&B minimum and the deposit wire; convention services owns F&B and meeting
// space; the reservations desk has no say over contract terms; Acme finance approves the rate cap.
// Wire instructions are a classic fraud target: they count only from the authenticated hotel.
import type { CheckResult, Claim, TaskSpec } from '../types.ts';
import { findDates, prettyDate, type DateMention } from '../extract/dates.ts';
import { registerDomain, type DomainPack, type HeuristicSentence, type TermDef } from './pack.ts';
import { displayTyped, mergeNights, normalizeTyped, type Lot } from './values.ts';
import { amounts, bankAccount, fieldValue, labelAmount } from './text.ts';
import { claimCheck, expectedFrom, ownClaim, partiesFor, requirementOf, standardActions, withdrawalCheck } from './common.ts';

export const TERMS: TermDef[] = [
  { key: 'rate.group', type: 'money', description: 'Group room rate in USD per room, per night (before tax)', topics: ['your group rate', 'room rate', 'your rate', 'what rate', 'per night', 'per room-night', 'rate?'] },
  { key: 'block.rooms', type: 'schedule', unit: 'rooms', description: 'Contracted / offered room block: one {qty: rooms, date: night} entry per night', topics: ['room block', 'block', 'rooms on', 'availability', 'add rooms', 'additional rooms', 'more rooms'] },
  { key: 'attrition.allowance', type: 'percent', description: 'Share of the room block (in %) the group may release without penalty', topics: ['attrition'] },
  { key: 'cutoff.date', type: 'date', description: 'Reservation cutoff date: unreserved block rooms return to general inventory after it', topics: ['cutoff', 'cut-off', 'cut off'] },
  { key: 'fnb.minimum', type: 'money', description: 'Food & beverage minimum spend in USD (before service charge and tax)', topics: ['f&b', 'food and beverage', 'food & beverage', 'catering minimum'] },
  { key: 'meeting.room_rental', type: 'money', range: 'nonnegative', description: 'Meeting-space rental in USD, total for the program', topics: ['meeting room', 'meeting space', 'room rental', 'breakout', 'general session'] },
  { key: 'deposit.amount', type: 'money', description: 'Deposit amount in USD', topics: ['deposit'] },
  { key: 'deposit.due', type: 'date', description: 'Date the deposit is due', topics: ['deposit due', 'when is the deposit'] },
  { key: 'payment.wire_instructions', type: 'text', description: 'Bank account the hotel asks deposits to be wired to, e.g. "Harbor National Bank account ending 4471"', topics: ['wire', 'bank', 'account ending', 'banking'] },
  { key: 'cancellation.terms', type: 'text', description: 'Cancellation clause (liquidated damages schedule)', topics: ['cancellation', 'cancel policy'] },
  { key: 'concession.comp_ratio', type: 'text', description: 'Complimentary room ratio, e.g. "1 per 40" (one comp room-night per 40 paid)', topics: ['comp', 'complimentary', 'concession'] },
  { key: 'offer.hold_until', type: 'date', description: 'Date until which the hotel holds the space on option for the group', topics: ['hold', 'option', 'first option'] },
  { key: 'offer.status', type: 'enum', values: ['withdrawn'], lifecycle: true, description: 'The hotel released the space or can no longer offer the block (value "withdrawn")', topics: ['release the space', 'no longer available'] },
  { key: 'budget.max_rate', type: 'money', description: 'Internally approved maximum group rate per room-night (finance decision)', topics: ['budget', 'approve', 'approval', 'sign off', 'ceiling', 'cleared'] },
  { key: 'decision.contract', type: 'text', description: 'A decision to accept / sign / decline the proposal or contract', topics: ['sign the contract', 'move forward', 'accept the proposal', 'decision'] },
];

const termDef = (key: string) => TERMS.find((t) => t.key === key);

// --------------------------------------------------------------------------------- checks

export function runChecks(task: TaskSpec, active: Claim[]): CheckResult[] {
  const results: CheckResult[] = [];
  const need = requirementOf(task, 'requirement.block');
  const maxRate = requirementOf(task, 'requirement.max_rate');
  const minAttrition = requirementOf(task, 'requirement.min_attrition');
  const cutoffReq = requirementOf(task, 'requirement.cutoff_not_before');
  const maxFnb = requirementOf(task, 'requirement.max_fnb_minimum');
  const budget = active.find((c) => c.key === 'budget.max_rate');

  for (const party of partiesFor(task, 'rate.group')) {
    const who = party.address;
    const withdrawn = withdrawalCheck(party, active);
    if (withdrawn) {
      results.push(withdrawn);
      continue;
    }
    const own = (key: string) => ownClaim(active, key, who);
    if (need) {
      const wanted = need.value as Lot[];
      results.push(claimCheck({
        id: `block:${who}`, label: `Room block ${need.display}`, party, requirementKey: need.key, claim: own('block.rooms'),
        missing: `No room block from ${party.label} yet`,
        ok: (c) => wanted.every((n) => ((c.value as Lot[]).find((l) => l.date === n.date)?.qty ?? 0) >= n.qty),
        detail: (c, ok) => {
          if (ok) return `${party.label}'s block (${c.display}) covers every night`;
          const short = wanted.filter((n) => ((c.value as Lot[]).find((l) => l.date === n.date)?.qty ?? 0) < n.qty);
          return short.map((n) => `only ${(c.value as Lot[]).find((l) => l.date === n.date)?.qty ?? 0} rooms on ${prettyDate(n.date)} (we need ${n.qty})`).join('; ');
        },
      }));
    }
    if (maxRate || budget) {
      const cap = Math.min(maxRate ? Number(maxRate.value) : Infinity, budget ? Number(budget.value) : Infinity);
      results.push(claimCheck({
        id: `max_rate:${who}`, label: 'Group rate within the cap', party, requirementKey: maxRate?.key ?? 'budget.max_rate', claim: own('rate.group'),
        missing: `No group rate from ${party.label} yet`, ok: (c) => Number(c.value) <= cap, extraEvidence: budget ? [budget.id] : [],
        detail: (c, ok) => `${c.display} ${ok ? 'is within' : 'exceeds'} the ${displayTyped(termDef('rate.group')!, cap)}/night cap`,
      }));
    }
    if (minAttrition) {
      results.push(claimCheck({
        id: `min_attrition:${who}`, label: `Attrition at least ${minAttrition.display}`, party, requirementKey: minAttrition.key, claim: own('attrition.allowance'),
        missing: `No attrition allowance from ${party.label} yet`, ok: (c) => Number(c.value) >= Number(minAttrition.value),
        detail: (c, ok) => `${c.display} attrition${ok ? '' : ` is below the required ${minAttrition.display}`}`,
      }));
    }
    if (cutoffReq) {
      results.push(claimCheck({
        id: `cutoff:${who}`, label: `Cutoff no earlier than ${cutoffReq.display}`, party, requirementKey: cutoffReq.key, claim: own('cutoff.date'),
        missing: `No cutoff date from ${party.label} yet`, ok: (c) => String(c.value) >= String(cutoffReq.value),
        detail: (c, ok) => `cutoff ${c.display}${ok ? '' : ` is earlier than ${prettyDate(String(cutoffReq.value))}`}`,
      }));
    }
    if (maxFnb) {
      results.push(claimCheck({
        id: `max_fnb_minimum:${who}`, label: `F&B minimum at most ${maxFnb.display}`, party, requirementKey: maxFnb.key, claim: own('fnb.minimum'),
        missing: `No F&B minimum from ${party.label} yet`, ok: (c) => Number(c.value) <= Number(maxFnb.value),
        detail: (c, ok) => `F&B minimum ${c.display}${ok ? '' : ` exceeds the ${maxFnb.display} cap`}`,
      }));
    }
  }

  if (maxRate && partiesFor(task, 'budget.', 'internal').length) {
    results.push({
      id: 'budget_approval', label: 'Rate cap approved by finance', requirement_key: 'budget.max_rate', party: budget?.speaker ?? null,
      status: !budget ? 'unknown' : Number(budget.value) >= Number(maxRate.value) ? 'pass' : 'fail',
      evidence: budget ? [budget.id] : [],
      detail: budget ? `Approved up to ${budget.display}/night` : 'No rate approval from finance yet',
    });
  }
  return results;
}

// --------------------------------------------------------------------------------- offline extraction

const MONEY_LABELS: [string, RegExp][] = [
  ['rate.group', /(?:\bper (?:room[, ]*)?(?:per )?night\b|\/\s*night\b|\bper room-night\b|\ba night\b|\bnightly\b|\bgroup rate\b|\broom rate\b|\brate\b)/i],
  ['fnb.minimum', /\b(?:f&b|food (?:&|and) beverage|catering)(?: minimum)?\b/i],
  ['meeting.room_rental', /\bmeeting (?:room|space)(?: rental)?\b|\broom rental\b/i],
  ['deposit.amount', /\bdeposit\b/i],
];
const BUDGET = /\b(approv\w*|budget|ceiling|cap(?:ped)?|up to|cleared|ok from finance|sign(?:ed)? off|max(?:imum)?|not to exceed)\b/i;
const NEGATED = /\b(?:no|not|cannot|can't|can not|don't|do not|won't|unable)\b[^.]{0,25}$/i;
const WITHDRAW = /\b(?:(?:have|need|had) to release (?:the|your|our) (?:space|hold|dates|block|option)|releas(?:e|ed|ing) (?:the|your) (?:space|hold|option|dates|block)|(?:space|dates|block|inventory) (?:is|are) no longer available|no longer (?:able to )?(?:offer|hold|accommodate)|can(?:no|')t (?:offer|hold|accommodate) (?:your|the) (?:group|block|dates|program)|(?:withdraw\w*|rescind\w*) (?:our|the|my) (?:proposal|offer)|lost the (?:space|dates)|(?:offer|proposal) (?:is )?(?:withdrawn|off the table))\b/i;
const NOT_WITHDRAWN = /\b(?:not|never|haven't|hasn't)\s+(?:been\s+)?(?:releas|withdraw)/i;
const CONDITIONAL = /\b(if|unless|in case|would you|should we)\b/i;
const SIGNED = /\b(?:(?:we|i) (?:hereby )?accept (?:the|your|this) (?:proposal|offer|contract|agreement|terms|block)|(?:here is|attached is|attaching|enclosed is|please find) (?:the|our) (?:signed|countersigned|executed)|(?:we|i)(?:'ve| have) (?:signed|countersigned|executed)|we (?:hereby )?confirm the (?:room )?(?:block|booking|contract)|go ahead and (?:book|contract|confirm))\b/i;
const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** Nights named with a range ("(nights of Mar 8-Mar 10)", "for 3 nights (Mar 8-Mar 10)"). */
function nightRange(s: string, ref: string): string[] {
  const dates = findDates(s, ref).filter((d) => d.explicit);
  const m = s.match(/\b(?:nights? of|for \d+ nights)\b[^)]*?\(?\s*/i) ? dates.slice(0, 2) : [];
  const pair = m.length === 2 ? m : (() => {
    const range = s.match(/\(([^)]*?)\)/);
    if (!range) return [];
    const inner = findDates(range[1], ref).filter((d) => d.explicit);
    return inner.length >= 2 ? inner.slice(0, 2) : [];
  })();
  if (pair.length !== 2) return [];
  const out: string[] = [];
  for (let d = pair[0].iso; d <= pair[1].iso && out.length < 14; d = new Date(Date.parse(`${d}T12:00:00Z`) + 864e5).toISOString().slice(0, 10)) out.push(d);
  return out;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const weekdayOf = (iso: string) => WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()];

/** Rooms per night in a sentence: "40 rooms Mon Mar 8, 50 rooms Tue Mar 9", "Mar 8: 40 rooms", "3/8: 30, 3/9: 60 rooms",
 *  "60 rooms a night for 3 nights (Mar 8-Mar 10)", "Monday 30 / Tuesday 60 (nights of Mar 8-Mar 10)". */
export function nightlyRooms(s: string, ref: string): { lots: Lot[]; perNight: boolean } {
  const lots: Lot[] = [];
  const dates: DateMention[] = findDates(s, ref).filter((d) => d.explicit);
  // "60 rooms a night for 3 nights (Mar 8-Mar 10)"
  const flat = s.match(/\b(\d{1,4})\s+rooms?\s+(?:a|per|each)\s+night\b/i);
  if (flat) {
    const nights = nightRange(s, ref);
    if (nights.length) return { lots: nights.map((date) => ({ qty: Number(flat[1]), date })), perNight: true };
  }
  // "Monday 30 / Tuesday 60 / Wednesday 60 (nights of Mar 8-Mar 10)"
  const byWeekday = [...s.matchAll(/\b(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\s+(\d{1,4})\b(?!\s*(?:am|pm|:)|\/\d)/gi)];
  if (byWeekday.length >= 2) {
    const nights = nightRange(s, ref);
    for (const m of byWeekday) {
      const date = nights.find((n) => weekdayOf(n) === m[1].slice(0, 3).toLowerCase());
      if (date) lots.push({ qty: Number(m[2]), date });
    }
    if (lots.length) return { lots, perNight: true };
  }
  // "<date>: <N> rooms" (proposal tables) or "3/8: 30, 3/9: 60 rooms"
  const roomsInSentence = /\brooms?\b/i.test(s);
  for (const d of dates) {
    const after = s.slice(d.index + d.text.length, d.index + d.text.length + 18);
    const table = after.match(/^,?\s*(?:\d{4})?\s*:\s*(\d{1,4})\b(?:\s*rooms?\b)?/i);
    if (table && roomsInSentence) lots.push({ qty: Number(table[1]), date: d.iso });
  }
  if (lots.length) return { lots, perNight: true };
  // "<N> rooms <date>" / "<N> rooms on <date>"
  for (const m of s.matchAll(/\b(\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:additional|extra|more|guest|sleeping)\s+)?rooms?\b(?:\s+(?:on|for)(?:\s+the\s+night\s+of)?)?\s*(?:the\s+)?/gi)) {
    const at = m.index! + m[0].length;
    if (/\b(?:of the|of|by|another|added|add|loaded)\s*$/i.test(s.slice(Math.max(0, m.index! - 8), m.index!))) continue; // "4 of the 10 rooms", "grow by 25 rooms"
    if (/^\s*(?:additional|extra|more)\b/i.test(s.slice(m.index! + m[1].length, m.index! + m[1].length + 12))) continue; // an increment, not the night's total
    const d = dates.find((x) => x.index >= at - 1 && x.index <= at + 12);
    if (!d) continue;
    if (/\bnot\s*$/i.test(s.slice(Math.max(0, m.index! - 5), m.index!))) continue;
    lots.push({ qty: WORD_NUM[m[1].toLowerCase()] ?? Number(m[1]), date: d.iso });
  }
  // a change to one night: "February 23 is now 50 rooms rather than 80", "Wednesday night (March 17) has to come down from 80 rooms to 65"
  if (!lots.length && roomsInSentence) {
    for (const d of dates) {
      const tail = s.slice(d.index + d.text.length, d.index + d.text.length + 90).split(/[;]|\.\s/)[0];
      const total = tail.match(/\b(?:(?:is|are) now|bringing (?:that night|the night|it|the block|your block)(?: up| down)? to|(?:block|total) (?:that night |for that night )?(?:is|are) now)\s+(\d{1,4})\b(?!\s*(?:%|am|pm|days?))/i);
      if (total) {
        lots.push({ qty: Number(total[1]), date: d.iso });
        continue;
      }
      const m = tail.match(/^\)?\s*(?:night\s*)?(?:\([^)]*\)\s*)?(?:is now|now|will be|becomes?|(?:has to |will |needs to )?(?:come|comes|go|goes|drop|drops|move|moves|be cut|be reduced|reduce|increase|go up|come down)\b[^.;\d]{0,12}(?:from\s+\d{1,4}\s*(?:rooms?)?\s*)?to)\s+(\d{1,4})\b/i);
      if (m) lots.push({ qty: Number(m[1]), date: d.iso });
    }
  }
  return { lots, perNight: lots.length > 0 };
}

interface HotelState { withdraw: { evidence: string; hedged: boolean } | null; offered: boolean; block: { lots: Lot[]; evidence: string[]; hedged: boolean; whole: boolean } }

const has = (auth: string[], key: string) => auth.some((a) => key.startsWith(a));

function hotelSentence(x: HeuristicSentence, st: HotelState): void {
  const s = x.text;
  if (x.isQuestion) return;
  if (x.senderRole === 'self') {
    if (!x.fromAttachment && SIGNED.test(s) && !NEGATED.test(s.slice(0, s.search(SIGNED)))) {
      x.claim({ key: 'decision.contract', value: 'accepted', kind: 'decision', evidence: s, hedged: x.hedged });
    }
    return;
  }
  const { hedged } = x;
  const internal = x.senderRole === 'internal';
  const claim = (key: string, value: unknown, kind: 'offer' | 'decision' | 'info' = 'offer') => {
    if (kind === 'offer') st.offered = true;
    x.claim({ key, value, kind, evidence: s, hedged });
  };

  if (!internal && !x.fromAttachment && /\b(?:fully executed|countersigned|signed by both parties)\b/i.test(s) && !NEGATED.test(s.slice(0, s.search(/\b(?:fully executed|countersigned|signed by both)/i)))) {
    x.claim({ key: 'decision.contract', value: 'executed', kind: 'decision', evidence: s, hedged });
  }
  if (!internal && !x.fromAttachment && WITHDRAW.test(s) && !NOT_WITHDRAWN.test(s) && !CONDITIONAL.test(s)) {
    st.withdraw = { evidence: s, hedged };
  }

  // money
  const all = amounts(s);
  if (internal) {
    if (BUDGET.test(s)) {
      for (const a of all) {
        const key = labelAmount(s, a, all, MONEY_LABELS);
        if (!key || key === 'rate.group') claim('budget.max_rate', a.value, 'decision');
      }
    }
    return;
  }
  for (const a of all) {
    if (NEGATED.test(s.slice(Math.max(0, a.index - 30), a.index))) continue;
    if (/\b(?:not|instead of|rather than|was|from)\s*$/i.test(s.slice(Math.max(0, a.index - 12), a.index))) continue;
    const key = labelAmount(s, a, all, MONEY_LABELS, 34);
    // a party with a say states terms in its remit; anyone else (reservations desk, outsiders) is recorded tentatively
    if (key && (!x.senderAuthority.length || has(x.senderAuthority, key))) claim(key, a.value);
  }

  // percent: attrition
  const att = s.match(/\battrition\b[^.%]{0,60}?(\d{1,2}(?:\.\d+)?)\s*%|(\d{1,2}(?:\.\d+)?)\s*%[^.]{0,40}\b(?:attrition|of the (?:total )?(?:room )?block may be released|without penalty)\b/i);
  if (att && !NEGATED.test(s.slice(0, att.index))) {
    const v = att[1] ?? att[2];
    const lead = s.slice(Math.max(0, att.index! - 14), att.index!);
    if (!/\b(?:not|instead of|from)\s*$/i.test(lead)) claim('attrition.allowance', Number(v));
  }

  // dates: cutoff, deposit due, option hold
  const dates = findDates(s, x.ref);
  const dateAfter = (rx: RegExp) => {
    const m = s.match(rx);
    if (!m) return null;
    const from = m.index! + m[0].length;
    const candidates = dates.filter((d) => d.index >= from - 1 && d.index <= from + 60 && !/\bnot\s*$/i.test(s.slice(Math.max(0, d.index - 5), d.index)));
    return candidates[0] ?? null;
  };
  const cutoff = dateAfter(/\b(?:cut-?\s?off|reservations must be received by)\b/i);
  if (cutoff && !/\b(?:another|other|their|its) group(?:'s)?\s+(?:cut-?\s?off)/i.test(s)) claim('cutoff.date', cutoff.iso);
  const deposit = dateAfter(/\bdeposit\b[^.]{0,40}?\bdue\b/i);
  if (deposit) claim('deposit.due', deposit.iso);
  const hold = dateAfter(/\b(?:held|hold(?:ing)?)\b[^.]{0,50}?\buntil\b/i);
  if (hold) claim('offer.hold_until', hold.iso);

  // wire instructions, cancellation clause, comp ratio
  const wire = bankAccount(s);
  if (wire && !NEGATED.test(s.slice(0, wire.index))) {
    const lead = s.slice(Math.max(0, wire.index - 16), wire.index);
    if (!/\b(?:not|old|previous|instead of|from)\s*(?:the\s+)?$/i.test(lead)) claim('payment.wire_instructions', wire.value);
  }
  const cancel = fieldValue(s, /\d*\.?\s*cancellation(?: terms| policy)?/i);
  if (cancel) claim('cancellation.terms', cancel.replace(/\.$/, ''));
  const comp = s.match(/\b(?:one|1)(?:\s*\(1\))?\s+(?:complimentary|comp)(?:\s+room(?:-night)?)?\s+(?:room-night\s+)?(?:per|for every)\s+(\d{2,3})\b|\bcomp(?:\s+ratio)?\b[^.\d]{0,20}?\b1\s*(?:per|:|\/|for every)\s*(\d{2,3})\b/i);
  if (comp) claim('concession.comp_ratio', `1 per ${comp[1] ?? comp[2]}`);

  // rooms added against a promise to add some ("14 additional rooms are loaded", "I've added 4 of the 10 rooms")
  if (!x.fromAttachment) {
    const added = s.match(/\b(?:(?:i|we)(?:'ve| have)? (?:added|loaded|released|picked up)\s+(\d{1,3})\b|(\d{1,3})\s+(?:additional |more |extra )?rooms?\s+(?:are|have been|were)\s+(?:now )?(?:loaded|added|in the block|released to (?:you|the block)))/i);
    if (added) x.fulfillment({ quantity: Number(added[1] ?? added[2]), evidence: s, term_key: 'block.rooms', obligation_id: null });
  }

  // the room block
  const nightly = nightlyRooms(s, x.ref);
  if (nightly.lots.length && (has(x.senderAuthority, 'block.') || !x.senderAuthority.length)) {
    st.block.lots.push(...nightly.lots);
    st.block.evidence.push(s);
    st.block.hedged ||= hedged;
    // a full block names every night in one go (a table, a list or a range); a single night is a change to one night
    if (nightly.lots.length >= 2 || x.fromAttachment) st.block.whole = true;
  }
}

function hotelEnd(st: HotelState, emit: HeuristicSentence['claim']): void {
  if (st.withdraw && !st.offered) emit({ key: 'offer.status', value: 'withdrawn', kind: 'offer', evidence: st.withdraw.evidence, hedged: st.withdraw.hedged });
  const { lots } = st.block;
  if (!lots.length) return;
  const byDate = new Map<string, number>();
  for (const l of lots) byDate.set(l.date, l.qty); // a later mention of a night wins within one text
  emit({
    key: 'block.rooms', value: [...byDate].map(([date, qty]) => ({ qty, date })), kind: 'offer',
    evidence: [...new Set(st.block.evidence)].join(' … '), hedged: st.block.hedged, partial: !st.block.whole,
  });
}

export const BINDING_PATTERNS = [
  /\b(?:(?:we|i)\s+(?:hereby\s+)?accept\b(?!\s+(?:that|your\s+point))|(?<!\b(?:not|cannot|can't|won't|unable\s+to|able\s+to)\s)accept(?:s|ed|ing)?\s+(?:the|your|this)\s+(?:proposal|offer|contract|agreement|terms|block|rate)\b|consider\s+this\s+(?:our|my|the)\s+(?:signed|acceptance)|(?:here\s+is|attached\s+is|attaching|enclosed\s+is|please\s+find)\s+(?:the|our)\s+(?:signed|countersigned|executed)\b|(?:we|i)(?:'ve|\s+have)\s+(?:signed|countersigned|executed)\b|we\s+(?:hereby\s+)?confirm\s+the\s+(?:room\s+)?(?:block|booking|contract)\b|go\s+ahead\s+and\s+(?:book|contract|confirm)\b|(?:we|i)(?:'ll|\s+will|'ve|\s+have)\s+(?:wire|wired|pay|paid|send|sent|release|released)\s+the\s+deposit|deposit\s+(?:has\s+been|was|is\s+being)\s+(?:wired|sent|paid|released)|(?:approve|authori[sz]e)\s+(?:the\s+)?(?:payment|deposit|wire)\b)/gi,
];

export const hotel: DomainPack = {
  id: 'hotel',
  agentRole: "You are Acme's meeting-planner agent, booking hotel room blocks and meeting space for company events by email.",
  terms: TERMS,
  llmGuidance: [
    '- block.rooms is the full resulting block: one {"qty": rooms, "date": night} per night (the date the guests check in for that night). If the message changes only some nights ("we can only offer 40 rooms on Wednesday"), output the full resulting block with the other nights unchanged and partial=false; set partial=true only when you cannot know the other nights. Rooms the hotel has added only partly ("added 10 of the 15, the other 5 pending") count as the block it now actually holds.',
    '- Event dates are months away: resolve "Mar 8" / weekday names against the event dates in the task or the hotel\'s documents, not the message date.',
    '- rate.group is per room, per night, before tax. attrition.allowance is a percent number (20 for 20%). concession.comp_ratio as "1 per 40". payment.wire_instructions as "<Bank> account ending <last 4>". cancellation.terms is the clause text as written.',
    '- budget.max_rate only from Acme finance approving a ceiling per room-night; kind=decision. Our own request for approval is not a budget.',
    '- A request or change of wire/bank details is a payment.wire_instructions claim from its sender whoever it is (the resolver decides whether it is trusted). The reservations desk reporting a different loaded rate is a rate.group claim from the desk.',
    '- offer.status="withdrawn" when the hotel releases the space / can no longer offer the dates or block (another group took them, a citywide, a renovation). An offer to quote other dates is not a new offer until it states terms.',
    '- decision.contract="accepted" when we (Acme) accept or sign the proposal/contract.',
    '- Documents: proposal → expects_artifact "proposal"; contract / amended contract / addendum → "contract"; BEOs → "banquet_event_order"; deposit or master-account invoice → "invoice"; rooming list → "rooming_list".',
  ].join('\n'),
  normalizeValue(key, value) {
    const def = termDef(key);
    if (!def) return null;
    if (key === 'concession.comp_ratio' && typeof value === 'string') {
      const n = value.match(/(\d{2,3})/);
      return n ? `1 per ${n[1]}` : normalizeTyped(def, value);
    }
    return normalizeTyped(def, value);
  },
  displayValue(key, value) {
    const def = termDef(key);
    if (!def) return String(value);
    if (key === 'rate.group' || key === 'budget.max_rate') return `${displayTyped(def, value)}/night`;
    return displayTyped(def, value);
  },
  mergePartial: (key, current, update) => (key === 'block.rooms' ? mergeNights(current as Lot[], update as Lot[]) : null),
  runChecks,
  expectedTerms: expectedFrom(TERMS, new Set(['decision.contract', 'offer.hold_until', 'cancellation.terms', 'concession.comp_ratio', 'meeting.room_rental', 'deposit.amount', 'deposit.due', 'payment.wire_instructions'])),
  decisionKey: 'decision.contract',
  bindingPatterns: BINDING_PATTERNS,
  documentKinds: [
    { kind: 'banquet_event_order', match: /\bBEOs?\b|banquet event order/i, promise: /\bBEOs?\b|banquet event orders?/i, multipart: true },
    { kind: 'rooming_list', match: /rooming list/i, promise: /rooming list/i },
    { kind: 'invoice', match: /invoice/i, promise: /\binvoice\b/i },
    { kind: 'proposal', match: /\bproposal\b(?! is not)/i, promise: /\bproposal\b/i },
    { kind: 'contract', match: /\bcontract\b|agreement|addendum|amendment/i, promise: /\bcontract\b|\bagreement\b|addendum|amendment/i },
  ],
  loopSubject(o) {
    if (o.expects_artifact === 'rooming_list') return 'rooming_list';
    if (o.kind === 'commitment' && o.quantity != null) return o.expects_artifact ? `document.${o.expects_artifact}` : 'block.remaining_rooms';
    return null;
  },
  extraActions: (ctx) => standardActions(ctx, {
    approvalPrefix: 'budget.', approvalKey: 'budget.max_rate', decisionKey: 'decision.contract', approvalAsk: 'approval of the group rate cap',
    commit: (who) => `${who}'s terms meet every requirement — ask for the contract (or confirm it in writing), restating rate, block, attrition and cutoff`,
  }),
  heuristic: {
    begin: (): HotelState => ({ withdraw: null, offered: false, block: { lots: [], evidence: [], hedged: false, whole: false } }),
    sentence: (s, st) => hotelSentence(s, st as HotelState),
    end: (st, emit) => hotelEnd(st as HotelState, emit),
  },
  quantityOf(text) {
    const m = text.match(/\b(?:add|another|additional|extra|all)\s+(\d{1,3})\s+(?:more\s+)?(?:rooms?|beos?|banquet event orders?)\b|\b(\d{1,3})\s+(?:more|additional|extra)\s+rooms?\b|\bBEOs? for (?:all )?(\d{1,2}|two|three|four|five)\b/i);
    if (!m) return null;
    const raw = m[1] ?? m[2] ?? m[3];
    const n = WORD_NUM[raw.toLowerCase()] ?? Number(raw);
    return n > 1 ? n : null;
  },
};

registerDomain(hotel);
