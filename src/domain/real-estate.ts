// The real-estate pack: a buyer's agent negotiating a home purchase with the listing agent, against the
// buyer's hard requirements (a price ceiling the buyer approves, a closing deadline) and the lender's
// appraisal (the loan only covers the appraised value).
//
// Parties: the listing agent is the counterparty (seller side); the buyer, the lender and the inspector
// are on our side (internal). The vocabulary follows a deal's life: offer → counter → acceptance,
// inspection booked, contingency deadline, appraisal, closing date — or the deal falling through.
// Ported from samrocksnature's b615ab7, reimplemented against this repo's DomainPack.
import type { CheckResult, Claim, TaskSpec } from '../types.ts';
import { findDates, isoDate, prettyDate } from '../extract/dates.ts';
import { normalizeTyped } from './procurement.ts';
import { registerDomain, type DomainPack, type HeuristicSentence, type PolicyWriter, type SuggestedAction, type TermDef } from './pack.ts';

const TERMS: TermDef[] = [
  { key: 'price.purchase', type: 'money', description: 'Purchase price the speaker currently offers, counters with or agrees to (whole USD)', topics: ['price', 'offer', 'counter', 'asking', 'purchase price', '$'], events: { self: 'offer_made', counterparty: 'counter_offer', default: 'price_stated' } },
  { key: 'closing.date', type: 'date', description: 'Closing date the speaker proposes or agrees to', topics: ['closing', 'close of escrow', 'close on', 'close by', 'settlement'], events: { default: 'closing_set' }, deadline: true },
  { key: 'contingency.inspection_until', type: 'date', description: 'Last day of the inspection contingency', topics: ['contingency', 'contingencies'], events: { default: 'contingency_deadline_set' }, deadline: true },
  { key: 'inspection.date', type: 'date', description: 'Scheduled home inspection date', topics: ['inspection', 'inspector'], events: { default: 'inspection_scheduled' } },
  { key: 'appraisal.value', type: 'money', description: "Appraised value from the lender's appraisal (whole USD)", topics: ['appraisal', 'appraised', 'valuation'], events: { default: 'appraisal_received' } },
  { key: 'budget.max_price', type: 'money', description: "The buyer's approved maximum purchase price (the buyer's decision)", topics: ['approve', 'approval', 'comfortable', 'go up to', 'ceiling', 'max'], events: { default: 'price_ceiling_approved' } },
  { key: 'decision.accept', type: 'text', description: 'A party accepting the current offer or counter', topics: ['accept', 'agree to'], events: { self: 'offer_accepted', default: 'accepted' } },
  { key: 'deal.fell_through', type: 'text', lifecycle: true, description: 'The deal ended without closing (withdrawn, terminated, another offer accepted): the reason', topics: ['withdraw', 'walk away', 'terminate', 'another offer', 'off the market'], events: { self: 'deal_withdrawn', default: 'fell_through' } },
];

const termDef = (key: string) => TERMS.find((t) => t.key === key);
const requirement = (task: TaskSpec, key: string) => task.requirements.find((r) => r.key === key);

/** Whole dollars: "$845,000". */
export const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

function runChecks(task: TaskSpec, active: Claim[]): CheckResult[] {
  const results: CheckResult[] = [];
  const self = task.self_address.toLowerCase();
  const maxPrice = requirement(task, 'requirement.max_price');
  const closeBy = requirement(task, 'requirement.close_by');
  const ceiling = active.find((c) => c.key === 'budget.max_price');
  const appraisal = active.find((c) => c.key === 'appraisal.value');
  const lender = task.participants.find((p) => p.authority.some((a) => a.startsWith('appraisal')));
  const ourExit = active.find((c) => c.key === 'deal.fell_through' && c.speaker === self);

  for (const party of task.participants.filter((p) => p.role === 'counterparty')) {
    const who = party.address;
    const own = (key: string) => active.find((c) => c.key === key && c.speaker === who);

    // a deal that ended is history, not an option: nothing else is checked against it
    const ended = ourExit ?? own('deal.fell_through');
    if (ended) {
      results.push({
        id: `deal_available:${who}`, label: `Deal with ${party.label} still on`, status: 'fail', party: who, evidence: [ended.id],
        requirement_key: 'deal.fell_through', detail: `The deal fell through (${ended.source_event_id}): ${ended.display}`,
      });
      continue;
    }

    const price = own('price.purchase');
    const closing = own('closing.date');

    if (maxPrice || ceiling) {
      const id = `price_budget:${who}`;
      const label = "Price within the buyer's maximum";
      const requirementKey = maxPrice?.key ?? 'budget.max_price';
      const cap = ceiling ? Number(ceiling.value) : Number(maxPrice!.value);
      const capLabel = ceiling ? `the buyer's approved maximum of ${ceiling.display}` : `the target maximum of ${maxPrice!.display} (buyer approval pending)`;
      if (!price) {
        results.push({ id, label, status: 'unknown', detail: `No price from ${party.label} yet`, party: who, evidence: ceiling ? [ceiling.id] : [], requirement_key: requirementKey });
      } else {
        const ok = Number(price.value) <= cap;
        results.push({
          id, label, party: who, evidence: ceiling ? [price.id, ceiling.id] : [price.id], requirement_key: requirementKey, status: ok ? 'pass' : 'fail',
          detail: `${price.display} is ${ok ? 'within' : 'above'} ${capLabel}`,
        });
      }
    }

    if (closeBy) {
      const id = `closing_deadline:${who}`;
      const label = `Closing by ${closeBy.display}`;
      if (!closing) {
        results.push({ id, label, status: 'unknown', detail: `No closing date from ${party.label} yet`, party: who, evidence: [], requirement_key: closeBy.key });
      } else {
        const late = String(closing.value) > String(closeBy.value);
        results.push({
          id, label, party: who, evidence: [closing.id], requirement_key: closeBy.key, status: late ? 'fail' : 'pass',
          detail: late
            ? `Closing ${closing.display} — after the ${closeBy.display} deadline (${party.label}'s current closing date)`
            : `${party.label}'s closing date (${closing.display}) meets the deadline`,
        });
      }
    }

    if (lender) {
      const id = `appraisal_gap:${who}`;
      const label = 'Appraisal covers the price';
      // before an appraisal exists the lender is who to ask; once it is in, a gap is the seller's to close
      if (!appraisal) {
        results.push({ id, label, status: 'unknown', detail: `No appraisal from ${lender.label} yet`, party: lender.address, evidence: [], requirement_key: 'appraisal.value' });
      } else if (!price) {
        results.push({ id, label, status: 'unknown', detail: `Appraisal ${appraisal.display}; no price from ${party.label} yet`, party: who, evidence: [appraisal.id], requirement_key: 'appraisal.value' });
      } else {
        const gap = Number(price.value) - Number(appraisal.value);
        results.push({
          id, label, party: who, evidence: [price.id, appraisal.id], requirement_key: 'appraisal.value', status: gap > 0 ? 'fail' : 'pass',
          detail: gap > 0
            ? `Appraisal ${appraisal.display} is ${usd(gap)} below the ${price.display} price — the loan only covers the appraised value`
            : `Appraisal ${appraisal.display} covers the ${price.display} price`,
        });
      }
    }
  }

  const hasApprover = task.participants.some((p) => p.authority.some((a) => a.startsWith('budget')));
  if (maxPrice && hasApprover && !ourExit) {
    results.push({
      id: 'price_approval', label: 'Buyer approved the maximum price', requirement_key: 'budget.max_price', party: ceiling?.speaker ?? null,
      status: !ceiling ? 'unknown' : Number(ceiling.value) >= Number(maxPrice.value) ? 'pass' : 'fail',
      evidence: ceiling ? [ceiling.id] : [],
      detail: ceiling ? `Buyer approved up to ${ceiling.display}` : 'No price approval from the buyer recorded yet',
    });
  }
  return results;
}

// ==================================================================== offline extraction patterns

const AMOUNT = /\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m|million)?\b/gi;
const APPROVE = /\b(approv\w*|comfortable|go(?:ing)? up to|up to|ceiling|max(?:imum)?|authori[sz]\w*|ok with|okay with|fine with)\b/i;
const APPRAISAL = /\bapprais\w*/i;
const PRICE = /\b(offer\w*|counter\w*|price|asking|accepts?|agrees?|agreed|propos\w*|bid)\b/i;
const CLOSING = /\b(clos(?:e|ing)|close of escrow|settlement)\b/i;
const MOVE = /\b(move[sd]?|moving|push(?:ed)?|now|instead|new|slip\w*|delay\w*|extend\w*)\b/i;
const NEGATED = /\b(cannot|can't|can no longer|won't|will not|unable to|not able to|no longer)\b/i;
const ENDED = /\b(?:withdraw(?:ing|n)?|walk(?:ing)? away|terminat\w*|cancel(?:l?ing|l?ed)?|accepted another offer|off the market)\b/i;
const OUR_OFFER = /\b(?:offer(?:ing)?|propos\w*|counter(?:ing)?(?: at)?|bring the price (?:down )?to|come down to)\s+(?:of\s+)?(\$\s?(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(?:k|m|million)?)/i;

function amountOf(m: RegExpMatchArray): number {
  const n = Number(m[1].replace(/,/g, ''));
  const unit = (m[2] ?? '').toLowerCase();
  return unit === 'k' ? n * 1_000 : unit === 'm' || unit === 'million' ? n * 1_000_000 : n;
}
const plusDays = (iso: string, days: number) => isoDate(new Date(Date.parse(iso) + days * 86_400_000));

function sentence(x: HeuristicSentence): void {
  const s = x.text;
  const { hedged } = x;
  if (x.isQuestion) return; // facts never come from questions

  // amounts: an appraisal, the buyer's ceiling, or a price (offer / counter / agreement). One claim per
  // sentence: the amount it moves TO ("from $845,000 to $830,000"), else the last one.
  const amounts = [...s.matchAll(AMOUNT)].filter((m) => amountOf(m) >= 50_000); // deposits, credits and fees are not prices
  if (amounts.length) {
    const to = amounts.find((m) => /\b(?:to|at|of)\s*$/i.test(s.slice(Math.max(0, m.index! - 12), m.index!)));
    const value = amountOf(to ?? amounts[amounts.length - 1]);
    if (x.senderRole === 'self') {
      // our own mail quotes their numbers; only an amount WE put forward is our offer
      const ours = s.match(OUR_OFFER);
      if (ours) x.claim({ key: 'price.purchase', value: amountOf([...ours[1].matchAll(AMOUNT)][0]), kind: 'decision', evidence: s, hedged });
    } else if (APPRAISAL.test(s)) {
      x.claim({ key: 'appraisal.value', value, kind: 'info', evidence: s, hedged });
    } else if (x.senderRole === 'internal' && APPROVE.test(s)) {
      // whether this sender may set the ceiling is the resolver's call (participant authority)
      x.claim({ key: 'budget.max_price', value, kind: 'decision', evidence: s, hedged });
    } else if (PRICE.test(s)) {
      x.claim({ key: 'price.purchase', value, kind: 'offer', evidence: s, hedged });
    }
  }

  // the deal ending without closing: our withdrawal, or the seller side's
  const ended = s.match(ENDED);
  if (ended && !x.fromAttachment && !NEGATED.test(s.slice(0, ended.index)) && /\b(?:we|our buyer|seller|my client|the deal|this deal)\b/i.test(s)) {
    const reason = (s.split(/:\s+/)[1] ?? s).replace(/[.!]\s*$/, '');
    x.claim({ key: 'deal.fell_through', value: reason.slice(0, 160), kind: 'decision', evidence: s, hedged });
  }

  if (x.senderRole === 'self') {
    if (!x.fromAttachment && /\bwe (?:hereby )?accept\b/i.test(s)) x.claim({ key: 'decision.accept', value: 'accepted', kind: 'decision', evidence: s, hedged });
    return; // our own dates restate requirements; they are not claims
  }

  const dates = findDates(s, x.ref).filter((d) => !/^today$/i.test(d.text));
  // closing date: the new date when the sentence moves it ("closing needs to move to Dec 4")
  const c = s.match(CLOSING);
  if (c && dates.length && !/\bcontingenc/i.test(s)) {
    const after = dates.filter((d) => d.index > c.index!);
    const pick = MOVE.test(s) || NEGATED.test(s) ? dates[dates.length - 1] : after[0] ?? dates[0];
    if (!(NEGATED.test(s) && dates.length === 1 && !MOVE.test(s))) x.claim({ key: 'closing.date', value: pick.iso, kind: 'offer', evidence: s, hedged });
  }
  // inspection contingency: "runs until Fri Oct 30", "a 10-day inspection contingency"
  if (/\binspection contingency\b/i.test(s)) {
    const days = s.match(/\b(\d{1,2})[- ]day inspection contingency\b/i);
    const until = dates.find((d) => d.index > s.search(/inspection contingency/i));
    const value = until?.iso ?? (days ? plusDays(x.ref, Number(days[1])) : null);
    if (value) x.claim({ key: 'contingency.inspection_until', value, kind: 'offer', evidence: s, hedged });
  }
  // the inspection date (the inspector booking it)
  if (/\binspection\b/i.test(s) && /\b(scheduled|booked|set for)\b/i.test(s) && !/\breport\b/i.test(s) && dates.length) {
    x.claim({ key: 'inspection.date', value: dates[0].iso, kind: 'info', evidence: s, hedged });
  }
  // the seller side accepting
  if (!x.fromAttachment && /\b(?:seller|my client|our client|we)\s+(?:hereby\s+)?(?:accepts?|agrees? to)\b/i.test(s) && !NEGATED.test(s)) {
    x.claim({ key: 'decision.accept', value: 'accepted', kind: 'decision', evidence: s, hedged });
  }
}

// ==================================================================== the offline agent's wording

type Ctx = Parameters<NonNullable<PolicyWriter['accept']>>[1];
const reqDisplay = (ctx: Ctx, key: string) => ctx.requirements.find((r) => r.key === key)?.value as string | undefined;
const termValue = (ctx: Ctx, term: string, party?: string | null) =>
  ctx.current_terms.find((t) => t.term === term && t.status === 'active' && (!party || t.party === party))?.value;
const what = (ctx: Ctx) => ctx.task.item ?? ctx.meta.alias;

const writer: PolicyWriter = {
  signature: "Buyer's Agent",
  reminderSuffix: ', reflecting the points above',
  raiseConflict(a, ctx) {
    const check = a.check_id ?? '';
    const closeBy = reqDisplay(ctx, 'requirement.close_by');
    if (check.startsWith('closing_deadline')) {
      const closing = termValue(ctx, 'closing.date', a.to);
      return [
        `The new closing date (${closing}) doesn't work for our buyer: closing has to happen by ${closeBy} — that is a hard requirement for ${what(ctx)}.`,
        `Can the seller keep the ${closeBy} closing? If not, please tell us the earliest date they can close so our buyer can decide how to proceed.`,
      ];
    }
    if (check.startsWith('appraisal_gap')) {
      const appraisal = termValue(ctx, 'appraisal.value');
      const price = termValue(ctx, 'price.purchase', a.to);
      return [
        `The appraisal came in at ${appraisal}, below the ${price} price. Our buyer's loan only covers the appraised value, so we're asking the seller to bring the price down to ${appraisal}.`,
        'Would the seller agree?',
      ];
    }
    if (check.startsWith('price_budget')) {
      const max = termValue(ctx, 'budget.max_price') ?? reqDisplay(ctx, 'requirement.max_price');
      return [`${a.why}. Could the seller come down to ${max} or below?`];
    }
    return null;
  },
  askForTerms(asks, party, ctx) {
    const subject = (s: string) => (party.last_message ? undefined : s);
    if (asks.every((a) => a.check_id?.startsWith('appraisal_gap'))) {
      return { subject: subject(`Appraisal — ${what(ctx)} (${ctx.meta.alias})`), lines: [`Could you order the appraisal for ${what(ctx)} and let us know the appraised value as soon as it's in?`] };
    }
    const offer = reqDisplay(ctx, 'requirement.opening_offer');
    const closeBy = reqDisplay(ctx, 'requirement.close_by');
    return {
      subject: subject(`Offer: ${what(ctx)} — ${ctx.meta.alias}`),
      lines: [
        `On behalf of our buyer, we would like to offer ${offer ?? 'a price'} for ${what(ctx)}${closeBy ? `, with closing by ${closeBy}` : ''}.`,
        "Please let us know the seller's response, and send a written counter if they'd like to adjust the terms.",
      ],
    };
  },
  requestApproval(_a, party, ctx) {
    const max = reqDisplay(ctx, 'requirement.max_price');
    return {
      subject: party.last_message ? undefined : `Approval needed — ${what(ctx)} (${ctx.meta.alias})`,
      lines: [`To keep negotiating on ${what(ctx)}, can you confirm you're comfortable going up to ${max} if needed?`],
    };
  },
  accept(party, ctx) {
    const price = termValue(ctx, 'price.purchase', party.label);
    const closing = termValue(ctx, 'closing.date', party.label);
    return [
      `Thank you — the seller's current terms meet all of our buyer's requirements, and we accept for ${what(ctx)}: purchase price ${price}${closing ? `, closing ${closing}` : ''}.`,
      'Please send the updated purchase agreement for signature.',
    ];
  },
};

export const realEstate: DomainPack = {
  id: 'real_estate',
  agentRole: "You are a buyer's agent negotiating a home purchase by email on behalf of your buyer.",
  terms: TERMS,
  llmGuidance: [
    '- price.purchase and appraisal.value are whole-dollar amounts (845000). A price only from an offer, counter or agreement; deposits, credits and fees are not prices. From our own mail, only an amount we put forward is our offer.',
    '- budget.max_price is the buyer approving a maximum price. closing.date and contingency.inspection_until are YYYY-MM-DD; when closing moves, the new date.',
    '- deal.fell_through (a short reason) when a party withdraws, terminates, or the seller accepts another offer.',
  ].join('\n'),
  normalizeValue(key, value) {
    const def = termDef(key);
    return def ? normalizeTyped(def, value) : null;
  },
  displayValue(key, value) {
    const def = termDef(key);
    if (!def) return String(value);
    if (def.type === 'money') return usd(Number(value));
    if (def.type === 'date') return prettyDate(String(value));
    return String(value);
  },
  runChecks,
  expectedTerms: (task) => task.participants
    .filter((p) => p.role === 'counterparty')
    .map((party) => ({ party, keys: ['price.purchase', 'closing.date'] })),
  decisionKey: 'decision.accept',
  bindingPatterns: [
    /\b((?:we|our buyer) (?:hereby )?accepts?\b|accept(?:s|ed)? (?:the|your|this) (?:counter|offer|price|terms)\b|we agree to (?:the|your) (?:counter|price|terms)|(?:wire|release) (?:the )?(?:earnest money|deposit|funds)|waive (?:the )?(?:inspection |appraisal )?contingenc(?:y|ies))/gi,
  ],

  extraActions({ task, checks, live, contested, openDebtors }) {
    const actions: SuggestedAction[] = [];
    const self = task.self_address.toLowerCase();

    const ended = checks.find((c) => c.id.startsWith('deal_available:') && c.status === 'fail');
    if (ended) {
      return [{
        priority: 3, kind: 'deal_ended', to: null, to_address: null, check_id: ended.id,
        action: 'The deal fell through — do not negotiate or accept on it any further', why: ended.detail,
        evidence: ended.evidence.map((id) => live.find((l) => l.id === id)?.source_event_id).filter((x): x is string => !!x),
      }];
    }

    if (checks.some((c) => c.id === 'price_approval' && c.status === 'unknown')) {
      const approver = task.participants.find((p) => p.authority.some((a) => a.startsWith('budget')));
      const asked = approver && openDebtors.some((o) => o.debtor === approver.address && o.topic_keys.includes('budget.max_price'));
      if (approver && !asked) {
        const max = task.requirements.find((r) => r.key === 'requirement.max_price')?.display ?? 'the target';
        actions.push({
          priority: 2, kind: 'request_approval', to: approver.label, to_address: approver.address, check_id: 'price_approval',
          action: `Ask ${approver.label} to approve going up to ${max} if needed`, why: 'No price approval from the buyer recorded', evidence: [],
        });
      }
    }

    const accepted = live.some((c) => c.key === 'decision.accept' && c.speaker === self);
    const allPass = checks.length > 0 && checks.every((c) => c.status === 'pass') && !contested.length;
    const seller = task.participants.find((p) => p.role === 'counterparty');
    if (allPass && !accepted && seller) {
      actions.push({
        priority: 1, kind: 'accept_offer', to: seller.label, to_address: seller.address,
        action: `All of the buyer's requirements are met by ${seller.label}'s current terms — accept in writing, restating price and closing date`,
        why: checks.map((c) => c.detail).join('; '), evidence: [],
      });
    }
    return actions;
  },

  heuristic: { begin: () => null, sentence: (s) => sentence(s), end: () => undefined },

  dueOf(text, ref) {
    if (!/\b(send|deliver|share|get you|provide)\b/i.test(text)) return null;
    return findDates(text, ref)[0]?.iso ?? null;
  },

  documentKinds: [
    { kind: 'counter_offer', match: /counter/i, promise: /\bcounter(?:[- ]?offer)?\b/i },
    { kind: 'appraisal', match: /apprais/i, promise: /\bappraisal(?: report)?\b/i },
    { kind: 'inspection_report', match: /inspection[\s_-]*report/i, promise: /\binspection report\b/i },
    { kind: 'agreement', match: /purchase (?:agreement|contract)/i, promise: /\b(?:purchase )?(?:agreement|contract)\b/i },
  ],

  writer,
};

registerDomain(realEstate);
