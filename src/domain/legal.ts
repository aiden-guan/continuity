// The legal (commercial contracts) pack: a legal-ops agent negotiates an agreement with a vendor by
// email. Vendor counsel speaks for every clause; the vendor's sales lead only for the commercial levers
// (fee-linked cap, term, renewal, payment); its contracts manager for legal clauses. Acme's General
// Counsel approves the liability floor and signs off; the business owner owns the start date. Clause
// positions are tracked one by one, so a redline is stale only on the clauses that moved since.
import type { CheckResult, Claim, TaskSpec } from '../types.ts';
import { findDates, prettyDate } from '../extract/dates.ts';
import { registerDomain, type DomainPack, type HeuristicSentence, type TermDef } from './pack.ts';
import { displayTyped, normalizeTyped } from './values.ts';
import { amounts } from './text.ts';
import { claimCheck, expectedFrom, ownClaim, partiesFor, requirementOf, standardActions, withdrawalCheck } from './common.ts';

export const TERMS: TermDef[] = [
  { key: 'liability.cap_months_fees', type: 'number', description: "Limitation-of-liability cap, expressed as months of fees paid or payable (12 = twelve months' fees)", topics: ['liability cap', 'the cap', 'cap on liability', 'limitation of liability', '§9.2', "months' fees"], events: { self: 'position_proposed', counterparty: 'clause_position', default: 'clause_position' } },
  { key: 'liability.cap_amount', type: 'money', description: 'Limitation-of-liability cap as a fixed amount in USD (only when stated as an amount)', topics: ['cap amount'], events: { default: 'clause_position' } },
  { key: 'indemnity.scope', type: 'text', description: 'What the vendor indemnifies against (e.g. "third-party IP infringement claims")', topics: ['indemn', '§10.1'], events: { default: 'clause_position' } },
  { key: 'term.months', type: 'number', description: 'Initial term of the agreement in months', topics: ['initial term', 'term length', '§12.1', '-month term'], events: { default: 'clause_position' } },
  { key: 'termination.convenience_notice_days', type: 'number', description: 'Days of written notice Acme must give to terminate for convenience', topics: ['termination for convenience', 'terminate for convenience', 'termination notice', '§12.3'], events: { default: 'clause_position' } },
  { key: 'renewal.auto', type: 'enum', values: ['none', 'annual', 'monthly'], description: 'Automatic renewal: none, annual (12-month renewal terms) or monthly', topics: ['auto-renewal', 'automatic renewal', 'renews', 'renewal term', '§12.4'], events: { default: 'clause_position' } },
  { key: 'renewal.notice_days', type: 'number', description: 'Days of notice required to stop an automatic renewal', topics: ['non-renewal', 'renewal notice'], events: { default: 'clause_position' } },
  { key: 'governing.law', type: 'enum', values: ['delaware', 'new_york', 'california', 'england'], description: 'Governing law of the agreement', topics: ['governing law', 'choice of law', '§15.1', 'which law'], events: { default: 'clause_position' } },
  { key: 'payment.net_days', type: 'number', range: 'nonnegative', description: 'Invoice payment terms in days (Net 30 = 30)', topics: ['payment terms', 'net 30', 'net 45', 'net 60', '§6.2'], events: { default: 'clause_position' } },
  { key: 'confidentiality.years', type: 'number', description: 'Years the confidentiality obligations survive termination', topics: ['confidentiality', '§11.4', 'survive'], events: { default: 'clause_position' } },
  { key: 'dpa.status', type: 'enum', values: ['included', 'excluded'], description: 'Whether a Data Processing Addendum is attached to the agreement', topics: ['dpa', 'data processing'], events: { default: 'dpa_position' } },
  { key: 'effective.date', type: 'date', description: 'Effective / start date of the agreement', topics: ['effective date', 'start date', 'go-live', 'go live'], events: { default: 'effective_date_set' }, deadline: true },
  { key: 'signature.status', type: 'enum', values: ['unsigned', 'partially_signed', 'fully_executed'], description: "The vendor side's signature status of the execution version", topics: ['countersign', 'signature page', 'signed pages', 'fully executed'], events: { counterparty: 'vendor_signed', default: 'signature_updated' } },
  { key: 'signature.remaining_by', type: 'date', description: 'Date by which the vendor promises its outstanding signature pages (when it has signed only partly)', topics: [], events: { default: 'signature_pages_promised' } },
  { key: 'offer.status', type: 'enum', values: ['withdrawn'], lifecycle: true, description: 'The vendor withdrew its proposal / pulled the deal (value "withdrawn")', topics: ['withdraw', 'pull the deal', 'not proceed'], events: { default: 'deal_withdrawn' } },
  { key: 'approval.liability_floor_months', type: 'number', description: "General Counsel's approved minimum liability cap, in months of fees (internal decision)", topics: ['sign-off', 'sign off', 'signoff', 'approve', 'approval', 'comfortable', 'ok to sign', 'green light'], events: { internal: 'gc_signed_off', default: 'gc_signed_off' } },
  { key: 'decision.execute', type: 'text', description: 'A decision to accept / sign / execute (or decline) the agreement', topics: ['can we sign', 'ready to sign', 'sign this week', 'execute'], events: { self: 'agreement_signed', default: 'execution_decision' } },
];

const termDef = (key: string) => TERMS.find((t) => t.key === key);
const LAW_NAME: Record<string, string> = { delaware: 'Delaware', new_york: 'New York', california: 'California', england: 'England and Wales' };

// --------------------------------------------------------------------------------- checks

export function runChecks(task: TaskSpec, active: Claim[]): CheckResult[] {
  const results: CheckResult[] = [];
  const floor = requirementOf(task, 'requirement.liability_cap_min_months');
  const law = requirementOf(task, 'requirement.governing_law');
  const notice = requirementOf(task, 'requirement.termination_notice_max_days');
  const renewal = requirementOf(task, 'requirement.renewal');
  const dpa = requirementOf(task, 'requirement.dpa');
  const executedBy = requirementOf(task, 'requirement.fully_executed_by');
  const gcSignoff = requirementOf(task, 'requirement.gc_signoff');
  const gcFloor = active.find((c) => c.key === 'approval.liability_floor_months');

  // vendors: every counterparty that speaks for the legal clauses (counsel, contracts manager, a second vendor)
  for (const party of partiesFor(task, 'governing.law')) {
    const who = party.address;
    const withdrawn = withdrawalCheck(party, active);
    if (withdrawn) {
      results.push(withdrawn);
      continue;
    }
    const own = (key: string) => ownClaim(active, key, who);
    if (floor || gcFloor) {
      const min = Math.max(floor ? Number(floor.value) : 0, gcFloor ? Number(gcFloor.value) : 0);
      results.push(claimCheck({
        id: `liability_cap:${who}`, label: `Liability cap at least ${min} months' fees`, party, requirementKey: floor?.key ?? 'approval.liability_floor_months', claim: own('liability.cap_months_fees'),
        missing: `No liability cap from ${party.label} yet`, ok: (c) => Number(c.value) >= min, extraEvidence: gcFloor ? [gcFloor.id] : [],
        detail: (c, ok) => `cap of ${c.value} months' fees ${ok ? 'meets' : 'is below'} the ${min}-month floor`,
      }));
    }
    if (law) {
      const allowed = (Array.isArray(law.value) ? law.value : [law.value]).map(String);
      results.push(claimCheck({
        id: `governing_law:${who}`, label: `Governing law: ${law.display}`, party, requirementKey: law.key, claim: own('governing.law'),
        missing: `Governing law not stated by ${party.label}`, ok: (c) => allowed.includes(String(c.value)),
        detail: (c, ok) => `${LAW_NAME[String(c.value)] ?? c.value} law${ok ? '' : ` is not one of ${law.display}`}`,
      }));
    }
    if (notice) {
      results.push(claimCheck({
        id: `termination_notice:${who}`, label: `Termination for convenience on at most ${notice.value} days' notice`, party, requirementKey: notice.key,
        claim: own('termination.convenience_notice_days'), missing: `No termination notice period from ${party.label} yet`,
        ok: (c) => Number(c.value) <= Number(notice.value), detail: (c, ok) => `${c.value} days' notice${ok ? '' : ` exceeds ${notice.value}`}`,
      }));
    }
    if (renewal) {
      const limits = renewal.value as { max_renewal_months?: number; max_notice_days?: number };
      const auto = own('renewal.auto');
      if (auto) {
        const months = auto.value === 'annual' ? 12 : auto.value === 'monthly' ? 1 : 0;
        const ok = auto.value === 'none' || months <= (limits.max_renewal_months ?? 12);
        results.push({ id: `renewal_term:${who}`, label: 'Renewal terms within playbook', party: who, requirement_key: renewal.key, status: ok ? 'pass' : 'fail', evidence: [auto.id], detail: `renewal: ${auto.display}` });
        if (auto.value !== 'none') {
          results.push(claimCheck({
            id: `renewal_notice:${who}`, label: `Non-renewal notice at most ${limits.max_notice_days ?? 60} days`, party, requirementKey: renewal.key, claim: own('renewal.notice_days'),
            missing: `No non-renewal notice period from ${party.label} yet`, ok: (c) => Number(c.value) <= (limits.max_notice_days ?? 60),
            detail: (c, ok) => `${c.value} days' non-renewal notice${ok ? '' : ` exceeds ${limits.max_notice_days ?? 60}`}`,
          }));
        }
      } else {
        results.push({ id: `renewal_term:${who}`, label: 'Renewal terms within playbook', party: who, requirement_key: renewal.key, status: 'unknown', evidence: [], detail: `Renewal not stated by ${party.label}` });
      }
    }
    if (dpa) {
      results.push(claimCheck({
        id: `dpa:${who}`, label: 'DPA attached', party, requirementKey: dpa.key, claim: own('dpa.status'),
        missing: `DPA not confirmed by ${party.label}`, ok: (c) => c.value === dpa.value, detail: (c, ok) => (ok ? 'DPA included' : `${party.label} will not include a DPA`),
      }));
    }
    if (executedBy) {
      const status = own('signature.status');
      const remainingBy = own('signature.remaining_by');
      const done = status?.value === 'fully_executed';
      const late = !done && remainingBy && String(remainingBy.value) > String(executedBy.value);
      results.push({
        id: `fully_executed_by:${who}`, label: `Fully executed ${executedBy.display}`, party: who, requirement_key: executedBy.key,
        status: done ? 'pass' : late ? 'fail' : 'unknown', evidence: [status, remainingBy].filter((c): c is Claim => !!c).map((c) => c.id),
        detail: done ? 'fully executed' : late ? `outstanding signature pages only by ${remainingBy!.display}, after ${prettyDate(String(executedBy.value))}` : 'not yet fully executed',
      });
    }
  }

  if (gcSignoff && partiesFor(task, 'approval.', 'internal').length) {
    results.push({
      id: 'gc_signoff', label: 'General Counsel sign-off', requirement_key: gcSignoff.key, party: gcFloor?.speaker ?? null,
      status: gcFloor ? 'pass' : 'unknown', evidence: gcFloor ? [gcFloor.id] : [], detail: gcFloor ? `GC signed off (floor ${gcFloor.value} months)` : 'No GC sign-off yet',
    });
  }
  return results;
}

// --------------------------------------------------------------------------------- offline extraction

const NUM_WORDS: Record<string, number> = { thirty: 30, sixty: 60, ninety: 90, 'forty-five': 45, twelve: 12, six: 6, eighteen: 18, 'twenty-four': 24, three: 3, five: 5, seven: 7, two: 2, four: 4 };
const N = String.raw`(\d{1,3}|thirty|sixty|ninety|forty-five|twelve|six|eighteen|twenty-four|three|five|seven|two|four)`;
const num = (s: string) => NUM_WORDS[s.toLowerCase()] ?? Number(s);
const NEGATED = /\b(?:no|not|cannot|can't|can not|don't|do not|won't|unable|never)\b[^.]{0,20}$/i;
const OLD = /\b(?:not|instead of|rather than|was|from|previously|originally)\s*(?:the\s+)?$/i;
const WITHDRAW = /\b(?:withdraw\w*|pull\w*|rescind\w*) (?:our|the|my|this|its) (?:proposal|offer|redline|deal|package|draft)|\b(?:pull(?:ing|ed)? (?:out of )?the deal|(?:decided|decision) not to (?:proceed|move forward)|(?:will not|won't|cannot|can't) (?:proceed|move forward|sign|deliver the services)|no longer (?:able to )?(?:proceed|offer|pursue|move forward)|froze (?:all )?new (?:enterprise )?contracts|(?:freeze|hold) on (?:all )?new (?:enterprise )?(?:contracts|deals)|(?:offer|proposal|package|deal) (?:is |has been )?(?:withdrawn|off the table|no longer available)|treat [^.]{0,50}\bas withdrawn|(?:decided|decision) not to (?:pursue|continue))\b/i;
const CONDITIONAL = /\b(if|unless|in case|would you|should we)\b/i;
const AGREE_EXECUTE = /\b(?:(?:we|acme|i) (?:hereby )?(?:accept|approve)s? (?:your|the|this) (?:\w+ )?(?:redline|draft|agreement|contract|execution version)|(?:we|acme) (?:have|has) (?:now )?(?:signed|executed|countersigned)|(?:attached|enclosed) (?:is|are) (?:our|acme'?s) (?:signed|executed|countersigned)|signed for acme)\b/i;

interface LegalState { withdraw: { evidence: string; hedged: boolean } | null; offered: boolean }

const has = (auth: string[], key: string) => auth.some((a) => key.startsWith(a));

/** The clause value a sentence states for each key, from redline lines (§…) and from prose. */
function clauses(s: string, known: { key: string; evidence: string }[] = []): [string, unknown][] {
  const out: [string, unknown][] = [];
  const at = (rx: RegExp) => {
    const m = s.match(rx);
    if (!m || OLD.test(s.slice(Math.max(0, m.index! - 14), m.index!))) return null;
    return m;
  };
  out.push(...numericClauses(s, sectionsOf(known)));
  // fees "payable on signature" are Net 0
  if (/\b(?:payable|due|paid) (?:up)?on signature\b/i.test(s) && !out.some(([k]) => k === 'payment.net_days')) out.push(['payment.net_days', 0]);
  const capAmount = at(/\b(?:capped at|cap of|cap at)\s+\$/i);
  if (capAmount) {
    const a = amounts(s.slice(capAmount.index!))[0];
    if (a) out.push(['liability.cap_amount', a.value]);
  }
  const indem = s.match(/\bindemnifies (?:Customer|Acme|you|the customer) against (.*\S)\s*$/i);
  if (indem) out.push(['indemnity.scope', indem[1].replace(/\.$/, '').trim()]);
  if (/\bno (?:automatic|auto)[- ]?renewal\b|\bdoes not (?:auto(?:matically)?[- ]?)?renew\b|\bwithout (?:auto|automatic)[- ]?renewal\b/i.test(s)) out.push(['renewal.auto', 'none']);
  else if (/\brenews? automatically\b|\bauto[- ]?renew/i.test(s)) {
    if (/\b(?:12-month|twelve-month|annual|one-year|1-year|yearly)\b/i.test(s)) out.push(['renewal.auto', 'annual']);
    else if (/\b(?:one-month|1-month|monthly|month-to-month)\b/i.test(s)) out.push(['renewal.auto', 'monthly']);
  }
  const lawM = s.match(/\b(?:laws? of (?:the state of )?|governing law[^.]{0,20}?\b(?:is|will be|to|be|:)\s*(?:the laws of (?:the state of )?)?)?(Delaware|New York|California|England(?: and Wales)?|English)\b(?:\s+law)?/i);
  if (lawM && (/\blaw\b|§15\.1/i.test(s)) && !OLD.test(s.slice(Math.max(0, lawM.index! - 14), lawM.index!)) && !/\bnot\s+(?:the\s+)?$/i.test(s.slice(Math.max(0, lawM.index! - 6), lawM.index!))) {
    const v = lawM[1].toLowerCase();
    out.push(['governing.law', v.startsWith('new york') ? 'new_york' : v.startsWith('engl') ? 'england' : v]);
  }
  if (/\b(?:DPA|data processing addendum)\b/i.test(s)) {
    if (/\b(?:not (?:be )?included|won't (?:sign|include|attach)|will not (?:sign|include|attach)|cannot (?:sign|include|attach)|no DPA|without (?:a |the )?DPA|excluded|decline)\b/i.test(s)) out.push(['dpa.status', 'excluded']);
    else if (/\b(?:attached|included|incorporated|is in|will be in|as Exhibit|exhibit [a-z]|we(?:'ll| will) (?:sign|attach|include))\b/i.test(s)) out.push(['dpa.status', 'included']);
  }
  return out;
}

/** The unit each numeric clause is written in. */
const UNIT_OF: Record<string, string> = {
  'liability.cap_months_fees': 'month', 'term.months': 'month', 'termination.convenience_notice_days': 'day', 'renewal.notice_days': 'day',
  'payment.net_days': 'day', 'confidentiality.years': 'year',
};

/** Section numbers mapped to the clause the redline on record states under them ("§12.1 Term: …" → term.months). */
function sectionsOf(known: { key: string; evidence: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  // a redline line names its clause: "§12.1 Term: initial term of 24 months"
  for (const k of known) {
    const m = k.evidence.match(/^\s*§\s*(\d+(?:\.\d+)?)/);
    if (m && UNIT_OF[k.key]) map.set(m[1], k.key);
  }
  // a counter that cites sections names them by what it says ("§9.2 at 30 months' fees, §12.1 at 36 months")
  for (const k of known) {
    for (const m of k.evidence.matchAll(/§\s*(\d+(?:\.\d+)?)([^§]{0,60})/g)) {
      if (map.has(m[1])) continue;
      const t = m[2].toLowerCase();
      const key = /\bdays?\b/.test(t) ? (/renewal/.test(t) ? 'renewal.notice_days' : /terminat|convenience/.test(t) ? 'termination.convenience_notice_days' : /net|pay/.test(t) ? 'payment.net_days' : null)
        : /\bmonths?(?:'|’)?s?\s*(?:of\s+)?fees/.test(t) ? 'liability.cap_months_fees'
          : /\bmonths?\b/.test(t) ? 'term.months'
            : /\byears?\b/.test(t) ? 'confidentiality.years' : null;
      if (key) map.set(m[1], key);
    }
  }
  return map;
}

/** Old values in a correction ("120 days, not 45", "(was 60 days' notice)", "instead of 6 months' fees", "(v2 says 60)"). */
const OLD_MARK = /(?:\bnot|\bwas|\binstead of|\brather than|\bfrom|\bsays|\bpreviously|\boriginally|\bformerly|\breplacing)\s*(?:the\s+)?$/i;

/**
 * Clause values that are numbers with a unit, value first: each "N days / N months / N years / Net N" is
 * assigned to the clause its segment talks about (or its unit implies), skipping values marked as old.
 */
function numericClauses(s: string, sections: Map<string, string> = new Map()): [string, unknown][] {
  const out: [string, unknown][] = [];
  const seen = new Set<string>();
  const add = (key: string, value: number) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push([key, value]);
  };
  const segments = s.split(/;|,(?=\s+(?:and\s+)?(?:termination|the |a |an |initial|annual|auto|payment|net|confidentiality|governing|renewal|liability|cap|no |dpa|its|our|in exchange))|(?<!\s)\s+and\s+(?=(?:the\s+)?(?:termination|initial|confidentiality|renewal|liability|cap|payment|net|governing|dpa)\b)/i);
  for (const seg of segments) {
    let prevEnd = 0;
    for (const m of seg.matchAll(new RegExp(String.raw`\b${N}[- ](?:calendar\s+)?(days?|months?|years?)\b|\bnet\s?-?(\d{2,3})\b`, 'gi'))) {
      const start = m.index!;
      const end = start + m[0].length;
      // what this number is about: the words since the previous number, plus what follows it
      const local = seg.slice(prevEnd, Math.min(seg.length, end + 45)).toLowerCase();
      const lead = seg.slice(prevEnd, start);
      prevEnd = end;
      if (OLD_MARK.test(seg.slice(Math.max(0, start - 22), start)) || /\(\s*(?:was|v\d says|previously)\b[^)]*$/i.test(seg.slice(0, start))) continue;
      if (/\b(?:won't|will not|cannot|can't|refuses? to|not)\b[^,;.]{0,30}$/i.test(lead)) continue; // "won't sign up to a 48-month term"
      // "The Net 30 in v2 was a mistake": the value named is the one being corrected away
      if (/^[^,;.]{0,25}?\b(?:was|is) (?:a |an |just )?(?:mistake|error|wrong|typo|incorrect|left over|leftover|a slip)/i.test(seg.slice(end))) continue;
      if (m[3]) {
        add('payment.net_days', Number(m[3]));
        continue;
      }
      const n = num(m[1]);
      const unit = m[2].toLowerCase();
      const after = seg.slice(end, end + 30).toLowerCase();
      // "§12.1 at 36 months": the section names the clause, as the redline (or an earlier counter) on record does
      const section = [...seg.slice(0, start).matchAll(/§\s*(\d+(?:\.\d+)?)/g)].pop()?.[1];
      const named = section ? sections.get(section) : undefined;
      if (named && UNIT_OF[named] && unit.startsWith(UNIT_OF[named])) {
        add(named, n);
        continue;
      }
      if (unit.startsWith('day')) {
        if (/non-?renewal|renewal notice/.test(local)) add('renewal.notice_days', n);
        else if (/terminat|convenience/.test(local)) add('termination.convenience_notice_days', n);
        else if (/\bpay|invoice|payable/.test(local)) add('payment.net_days', n);
      } else if (unit.startsWith('month')) {
        const before = lead.toLowerCase();
        if (/^\s*(?:'|’)?s?\s*(?:of\s+)?fees|^\s*preceding the claim/.test(after) || (/\bcap\b|liabilit|fees paid/.test(before) && !/initial term|term of/.test(before) && !/^-?\s*month (?:initial )?term/.test(after))) add('liability.cap_months_fees', n);
        else if (/renew/.test(local) && /^\s*terms?\b|^-?month terms/.test(after)) continue; // "successive 12-month terms" is the renewal, not the initial term
        else add('term.months', n); // months that are not months of fees are the term
      } else if (/confidential|surviv/.test(local) || !/\bterm\b/.test(local)) add('confidentiality.years', n);
      else add('term.months', n * 12);
    }
  }
  return out;
}

function legalSentence(x: HeuristicSentence, st: LegalState): void {
  const s = x.text;
  if (x.isQuestion) return;
  const { hedged } = x;
  if (x.senderRole === 'self') {
    if (!x.fromAttachment && AGREE_EXECUTE.test(s) && !NEGATED.test(s.slice(0, s.search(AGREE_EXECUTE)))) x.claim({ key: 'decision.execute', value: 'signed', kind: 'decision', evidence: s, hedged });
    return;
  }
  const internal = x.senderRole === 'internal';
  const claim = (key: string, value: unknown, kind: 'offer' | 'decision' | 'info' = 'offer') => {
    if (kind === 'offer') st.offered = true;
    x.claim({ key, value, kind, evidence: s, hedged });
  };

  if (internal) {
    // General Counsel's sign-off with a floor: "Signed off, subject to a liability cap of at least 18 months of fees"
    if (has(x.senderAuthority, 'approval.')) {
      const f = s.match(new RegExp(String.raw`\b(?:at least|minimum(?: of)?|floor(?: on the cap)?(?: (?:is|of|at))?|no less than|no lower than|not (?:go |drop )?below|(?:go|drop|goes|drops) below|nothing below|or above|or more|≥)\s*(?:a\s+|the\s+)?${N}[- ]?months?\b|\b${N}[- ]?months?(?:'|’)?\s*(?:of\s+)?(?:fees?\s+)?(?:is (?:my|the|our) floor|floor|minimum|or (?:more|above|higher))`, 'i'));
      if (f) claim('approval.liability_floor_months', num(f[1] ?? f[2]), 'decision');
    }
    if (has(x.senderAuthority, 'effective.')) {
      const eff = s.match(/\b(?:effective date|start date|go[- ]live|start)\b[^.]{0,30}/i);
      const d = eff ? findDates(s.slice(eff.index!), x.ref)[0] : undefined;
      if (d) claim('effective.date', d.iso, 'info');
    }
    // hearsay from a colleague ("their sales rep said the cap is now 6 months") is recorded, never applied
    for (const [key, value] of clauses(s, x.known)) if (/\b(?:said|says|told|mentioned|heard|on the call)\b/i.test(s)) claim(key, value, 'info');
    return;
  }

  if (!x.fromAttachment && WITHDRAW.test(s) && !/\b(?:not|never|haven't|hasn't)\s+(?:been\s+)?withdraw/i.test(s) && !CONDITIONAL.test(s)) {
    st.withdraw = { evidence: s, hedged };
  }

  // clause positions; a party with a narrower remit (the sales lead) states only what it speaks for
  for (const [key, value] of clauses(s, x.known)) {
    if (x.senderAuthority.length && !has(x.senderAuthority, key)) {
      // a party outside its remit is still recorded (tentatively) when it says it is changing the clause
      if (!/\b(?:agree|fix|change|move|cleared|ok|okay|can do|will update)\w*\b/i.test(s)) continue;
    }
    claim(key, value);
  }

  // signatures: fully executed, or some pages signed and the rest promised by a date
  if (/\bfully executed\b|\ball (?:\d+ |the )?(?:signature pages|pages) (?:are )?(?:attached|signed|enclosed)\b|\bcountersigned (?:copy|agreement|execution version) (?:is )?attached\b/i.test(s) && !NEGATED.test(s.slice(0, s.search(/fully executed|all|countersigned/i)))) {
    claim('signature.status', 'fully_executed', 'info');
  } else if (!x.fromAttachment && /\b(?:signed|signature) pages?\b|\bpages? (?:is |are )?attached\b|\bhas signed\b/i.test(s) && /\b(?:attached|enclosed|here (?:are|is))\b/i.test(s)) {
    claim('signature.status', 'partially_signed', 'info');
  }
  // the outstanding pages and when they come ("…, so it will sign on Thu Nov 12", "will follow by Thursday, Oct 22")
  if (!x.fromAttachment && /\b(?:will|to|should|would) (?:sign|follow|be signed|countersign)\b|\bwill be with you\b/i.test(s) && !/\ball (?:\d+ )?(?:signature )?pages\b/i.test(s)) {
    const d = findDates(s, x.ref).at(-1);
    if (d) claim('signature.remaining_by', d.iso, 'info');
  }

}

function legalEnd(st: LegalState, emit: HeuristicSentence['claim']): void {
  if (st.withdraw && !st.offered) emit({ key: 'offer.status', value: 'withdrawn', kind: 'offer', evidence: st.withdraw.evidence, hedged: st.withdraw.hedged });
}

export const BINDING_PATTERNS = [
  /\b((?:we|acme|i)\s+(?:hereby\s+)?(?:accept|approve)s?\s+(?:your|the|this|v\d)\s*(?:latest\s+|revised\s+|final\s+|clean\s+)?(?:redline|mark-?up|draft|changes|agreement|contract|execution\s+(?:version|copy)|version|v\d)\b|(?:we|acme)\s+(?:hereby\s+)?agrees?\s+to\s+(?:your|the|this)\s+(?:redline|terms|final|agreement|contract|execution)|treat\s+this\s+(?:e-?mail\s+)?as\s+(?:our|acme'?s)\s+signature|signed\s+and\s+returned|(?:we|acme)\s+(?:have|has)\s+(?:now\s+)?(?:signed|executed|countersigned)|(?:attached|enclosed)\s+(?:is|are)\s+(?:our|acme'?s)\s+(?:signed|executed|countersigned)|(?:we|acme)\s+(?:will|shall)\s+(?:now\s+)?(?:sign|execute|countersign)\b|(?:ok|okay|cleared|approved|good)\s+to\s+(?:sign|execute)|we\s+are\s+(?:signing|executing)|(?:go\s+ahead\s+and|please)\s+(?:execute|countersign))/gi,
];

export const legal: DomainPack = {
  id: 'legal',
  agentRole: "You are Acme's legal-operations agent, negotiating commercial agreements with vendors by email on Acme's behalf.",
  terms: TERMS,
  llmGuidance: [
    '- Track each clause separately. A redline/draft states every clause it contains; a later email that changes one or two clauses ("§9.2: the cap will be 12 months\' fees; all other provisions of v2 stand") is a claim on those clauses only (mode=correction when it corrects the sender\'s own earlier position).',
    '- liability.cap_months_fees is a number of months of fees ("fees paid or payable in the 12 months preceding the claim" → 12). liability.cap_amount only when the cap is a dollar figure.',
    '- renewal.auto: "none" for no automatic renewal, "annual" for successive 12-month renewal terms, "monthly" for one-month terms. renewal.notice_days is the non-renewal notice period. termination.convenience_notice_days is the notice for termination for convenience.',
    '- governing.law: delaware | new_york | california | england ("England and Wales" → england). payment.net_days: Net 45 → 45. dpa.status included/excluded.',
    '- Positions Acme proposes in its own emails are not the vendor\'s positions. Hearsay relayed by an Acme colleague, or a vendor person outside their remit (the sales lead on governing law), is still a claim by that sender; the resolver decides whether it counts.',
    '- approval.liability_floor_months only from Acme\'s General Counsel signing off ("signed off, subject to a cap of at least 18 months") ; kind=decision.',
    '- signature.status: partially_signed when only some signature pages are returned, fully_executed when all are; signature.remaining_by is the date the outstanding pages are promised for. A promise to return N signature pages is a commitment expecting "signature_pages"; each signed page attached counts toward it.',
    '- offer.status="withdrawn" when the vendor pulls the deal / withdraws its proposal / will not proceed.',
    '- Documents: a (revised/corrected) redline or draft → expects_artifact "redline"; the clean execution version → "execution_version"; the DPA → "dpa"; signed signature pages → "signature_pages".',
  ].join('\n'),
  normalizeValue(key, value) {
    const def = termDef(key);
    if (!def) return null;
    if (key === 'governing.law' && typeof value === 'string') {
      const v = value.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
      return normalizeTyped(def, /new york/.test(v) ? 'new_york' : /engl|wales|english/.test(v) ? 'england' : /delaware/.test(v) ? 'delaware' : /california/.test(v) ? 'california' : v.replace(/ /g, '_'));
    }
    return normalizeTyped(def, value);
  },
  displayValue(key, value) {
    const def = termDef(key);
    if (!def) return String(value);
    if (key === 'liability.cap_months_fees' || key === 'approval.liability_floor_months') return `${value} months' fees`;
    if (key.endsWith('_days')) return `${value} days`;
    if (key === 'term.months') return `${value} months`;
    if (key === 'confidentiality.years') return `${value} years`;
    if (key === 'governing.law') return LAW_NAME[String(value)] ?? String(value);
    return displayTyped(def, value);
  },
  runChecks,
  expectedTerms: expectedFrom(TERMS, new Set(['liability.cap_amount', 'indemnity.scope', 'effective.date', 'signature.status', 'signature.remaining_by', 'decision.execute', 'confidentiality.years', 'payment.net_days', 'term.months'])),
  decisionKey: 'decision.execute',
  bindingPatterns: BINDING_PATTERNS,
  trackDocumentRequests: true,
  documentKinds: [
    { kind: 'signature_pages', match: /signature page|signed page/i, promise: /signature pages?|signed pages?|\b(?:all )?\d+ pages\b/i, multipart: true },
    { kind: 'execution_version', match: /execution (?:version|copy)|clean (?:version|copy)/i, promise: /execution (?:version|copy)|clean (?:version|copy)|signature version/i },
    { kind: 'redline', match: /redline|mark-?up|draft\s*v?\d|_draft_|comments|\bv\d\b/i, promise: /\bredline\b|mark-?up|\bdraft\b|\bv\d\b/i },
    { kind: 'dpa', match: /data processing addendum|\bDPA\b/i, promise: /\bDPA\b|data processing addendum/i },
  ],
  loopSubject(o) {
    if (o.expects_artifact) return `document.${o.expects_artifact}`;
    if (o.topic_keys.includes('approval.liability_floor_months')) return 'approval.gc_signoff';
    return null;
  },
  extraActions: (ctx) => standardActions(ctx, {
    approvalPrefix: 'approval.', approvalKey: 'approval.liability_floor_months', decisionKey: 'decision.execute', approvalAsk: "General Counsel's sign-off",
    commit: (who) => `${who}'s positions meet the playbook and GC has signed off — ask for the execution version (do not sign until it arrives)`,
  }),
  heuristic: {
    begin: (): LegalState => ({ withdraw: null, offered: false }),
    sentence: (s, st) => legalSentence(s, st as LegalState),
    end: (st, emit) => legalEnd(st as LegalState, emit),
  },
  quantityOf(text) {
    const m = text.match(/\b(?:all\s+)?(\d{1,2}|two|three|four|five|six)\s+(?:countersigned\s+|signed\s+)?(?:[A-Z][\w&.,-]*\s+){0,4}(?:signature pages|pages|entities)\b/i);
    if (!m) return null;
    const n = NUM_WORDS[m[1].toLowerCase()] ?? Number(m[1]);
    return n > 1 ? n : null;
  },
};

registerDomain(legal);
