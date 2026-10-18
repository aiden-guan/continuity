// Legal: an agent acting as Acme's legal-operations desk negotiates a commercial agreement (MSA, SaaS
// subscription agreement, ...) with a vendor by email. The vendor's counsel speaks for the vendor on
// every contract term; the vendor's sales lead can speak to the commercial levers (fee-linked cap,
// term, renewal, payment) but cannot change legal clauses; Acme's General Counsel owns internal
// approvals (the liability-cap floor, sign-off to execute); Acme's business owner owns the business
// side (start date, budget) and has no authority over contract terms. The term keys are the
// benchmark's own definition and are written here, not imported from the engine.
import type { BenchCase, BenchParty, BenchTask, Capability, Checkpoint, OracleTerm, Split, VerticalSpec } from '../../core/types.ts';
import { MailBuilder, Rand, addDays, at, body, moneyShort, sayDate, type DateStyle } from '../../core/util.ts';

export const legal: VerticalSpec = {
  id: 'legal',
  name: 'Commercial contract negotiation',
  agentRole: "You are Acme's legal-operations agent, negotiating commercial agreements with vendors by email on Acme's behalf.",
  continuityDomain: 'legal',
  terms: [
    { key: 'liability.cap_months_fees', type: 'number', description: "Limitation-of-liability cap, expressed as months of fees paid or payable (e.g. 12 = twelve months' fees)", setBy: ['counterparty'] },
    { key: 'liability.cap_amount', type: 'money', description: 'Limitation-of-liability cap as a fixed amount in USD (only when stated as an amount)', setBy: ['counterparty'] },
    { key: 'indemnity.scope', type: 'text', description: 'What the vendor indemnifies against (e.g. "third-party IP infringement claims")', setBy: ['counterparty'] },
    { key: 'term.months', type: 'number', description: 'Initial term of the agreement in months', setBy: ['counterparty'] },
    { key: 'termination.convenience_notice_days', type: 'number', description: "Days of written notice Acme must give to terminate for convenience", setBy: ['counterparty'] },
    { key: 'renewal.auto', type: 'enum', values: ['none', 'annual', 'monthly'], description: 'Automatic renewal: none, annual (12-month renewal terms) or monthly', setBy: ['counterparty'] },
    { key: 'renewal.notice_days', type: 'number', description: 'Days of notice required to stop an automatic renewal', setBy: ['counterparty'] },
    { key: 'governing.law', type: 'enum', values: ['delaware', 'new_york', 'california', 'england'], description: 'Governing law of the agreement', setBy: ['counterparty'] },
    { key: 'payment.net_days', type: 'number', description: 'Invoice payment terms in days (Net 30 = 30)', setBy: ['counterparty'] },
    { key: 'confidentiality.years', type: 'number', description: 'Years the confidentiality obligations survive termination', setBy: ['counterparty'] },
    { key: 'dpa.status', type: 'enum', values: ['included', 'excluded'], description: 'Whether a Data Processing Addendum is attached to the agreement', setBy: ['counterparty'] },
    { key: 'effective.date', type: 'date', description: 'Effective / start date of the agreement', setBy: ['counterparty', 'internal'] },
    { key: 'signature.status', type: 'enum', values: ['unsigned', 'partially_signed', 'fully_executed'], description: "The vendor side's signature status of the execution version", setBy: ['counterparty'] },
    { key: 'offer.status', type: 'enum', values: ['withdrawn'], description: 'Set to "withdrawn" when the vendor withdrew its proposal / pulled the deal', setBy: ['counterparty'] },
    { key: 'approval.liability_floor_months', type: 'number', description: "General Counsel's approved minimum liability cap, in months of fees (internal decision)", setBy: ['internal'] },
    { key: 'decision.execute', type: 'text', description: 'A decision to accept / sign / execute (or decline) the agreement', setBy: ['self', 'counterparty'] },
  ],
  loopSubjects: [
    { key: 'document.redline', description: 'A (revised / corrected) redline draft of the agreement' },
    { key: 'document.execution_version', description: 'The clean execution version of the agreement' },
    { key: 'document.dpa', description: 'The Data Processing Addendum' },
    { key: 'document.signature_pages', description: 'Signed signature pages (e.g. one per affiliate entity)' },
    { key: 'approval.gc_signoff', description: "General Counsel's sign-off to proceed / execute" },
    { key: 'answer.clause_question', description: 'An answer to a question about a specific clause' },
  ],
  // asking for the execution version is not agreeing to sign it, so it is deliberately not a binding phrase
  bindingPatterns: [
    /\b((?:we|acme|i)\s+(?:hereby\s+)?(?:accept|approve)s?\s+(?:your|the|this|v\d)\s*(?:latest\s+|revised\s+|final\s+|clean\s+)?(?:redline|mark-?up|draft|changes|agreement|contract|execution\s+(?:version|copy)|version|v\d)\b|(?:we|acme)\s+(?:hereby\s+)?agrees?\s+to\s+(?:your|the|this)\s+(?:redline|terms|final|agreement|contract|execution)|treat\s+this\s+(?:e-?mail\s+)?as\s+(?:our|acme'?s)\s+signature|signed\s+and\s+returned|(?:we|acme)\s+(?:have|has)\s+(?:now\s+)?(?:signed|executed|countersigned)|(?:attached|enclosed)\s+(?:is|are)\s+(?:our|acme'?s)\s+(?:signed|executed|countersigned)|(?:we|acme)\s+(?:will|shall)\s+(?:now\s+)?(?:sign|execute|countersign)\b|(?:ok|okay|cleared|approved|good)\s+to\s+(?:sign|execute)|we\s+are\s+(?:signing|executing)|(?:go\s+ahead\s+and|please)\s+(?:execute|countersign))/gi,
  ],
};

// ------------------------------------------------------------------ clauses

export type Law = 'delaware' | 'new_york' | 'california' | 'england';
export type Renewal = 'none' | 'annual' | 'monthly';
export type Dpa = 'included' | 'excluded';

/** The positions in a draft. Every key maps to one term key. */
export interface Clauses {
  cap: number;
  indemnity: string;
  term: number;
  notice: number;
  renewal: Renewal;
  renewalNotice: number;
  law: Law;
  net: number;
  conf: number;
  dpa: Dpa;
}
export type ClauseKey = keyof Clauses;

export const TERM: Record<ClauseKey, string> = {
  cap: 'liability.cap_months_fees',
  indemnity: 'indemnity.scope',
  term: 'term.months',
  notice: 'termination.convenience_notice_days',
  renewal: 'renewal.auto',
  renewalNotice: 'renewal.notice_days',
  law: 'governing.law',
  net: 'payment.net_days',
  conf: 'confidentiality.years',
  dpa: 'dpa.status',
};
export const SECTION: Record<ClauseKey, string> = {
  cap: '§9.2', indemnity: '§10.1', term: '§12.1', notice: '§12.3', renewal: '§12.4', renewalNotice: '§12.4', law: '§15.1', net: '§6.2', conf: '§11.4', dpa: 'Exhibit C',
};
/** What the clause is called in conversation. */
export const CLAUSE: Record<ClauseKey, string> = {
  cap: 'liability cap', indemnity: 'indemnity', term: 'initial term', notice: 'termination-for-convenience notice', renewal: 'auto-renewal', renewalNotice: 'non-renewal notice period', law: 'governing law', net: 'payment terms', conf: 'confidentiality survival period', dpa: 'DPA',
};
export const LAW_NAME: Record<Law, string> = { delaware: 'Delaware', new_york: 'New York', california: 'California', england: 'England and Wales' };
const RENEWAL_NAME: Record<Renewal, string> = { none: 'no automatic renewal', annual: 'automatic 12-month renewals', monthly: 'automatic month-to-month renewals' };

/** Short human display of a clause value ("12 months' fees", "Delaware", "Net 30"). */
export function show(k: ClauseKey, v: Clauses[ClauseKey]): string {
  switch (k) {
    case 'cap': return `${v} months' fees`;
    case 'indemnity': return String(v);
    case 'term': return `${v} months`;
    case 'notice': return `${v} days' notice`;
    case 'renewal': return RENEWAL_NAME[v as Renewal];
    case 'renewalNotice': return `${v} days' non-renewal notice`;
    case 'law': return `${LAW_NAME[v as Law]} law`;
    case 'net': return `Net ${v}`;
    case 'conf': return `${v} years`;
    case 'dpa': return v === 'included' ? 'DPA attached' : 'no DPA';
  }
}
/** "termination-for-convenience notice: 60 days' notice" style label for judge facts. */
export const showFull = (k: ClauseKey, v: Clauses[ClauseKey]) => `${CLAUSE[k]} ${show(k, v)}`;

/** Oracle value of a clause (the stored value is already canonical). */
export const valueOf = (k: ClauseKey, c: Clauses): unknown => c[k];

/** Clause keys that are reported as terms in most archetypes (indemnity text is not graded). */
export const GRADED: ClauseKey[] = ['cap', 'term', 'notice', 'renewal', 'renewalNotice', 'law', 'net', 'conf', 'dpa'];
/** Clauses a careful handoff must get right. */
export const CRITICAL = new Set<ClauseKey>(['cap', 'law', 'notice', 'dpa']);

/** Keys that apply to a set of clauses (no non-renewal notice when nothing auto-renews). */
export const applicable = (c: Clauses, keys: ClauseKey[] = GRADED) => keys.filter((k) => !(k === 'renewalNotice' && c.renewal === 'none'));

/** Oracle terms for a party's positions: one term per applicable clause key. */
export function clauseTerms(party: string, c: Clauses, evidence: (k: ClauseKey) => string[], o: { keys?: ClauseKey[]; critical?: ClauseKey[]; label?: string } = {}): OracleTerm[] {
  const crit = new Set<ClauseKey>([...CRITICAL, ...(o.critical ?? [])]);
  return applicable(c, o.keys).map((k) => ({
    party, term: TERM[k], status: 'current' as const, value: c[k], evidence: evidence(k), critical: crit.has(k), display: `${o.label ? `${o.label}: ` : ''}${show(k, c[k])}`,
  }));
}

/** Why a clause value breaks Acme's playbook, or null. */
export function violation(d: LegalDeal, k: ClauseKey, c: Clauses): string | null {
  switch (k) {
    case 'cap': return c.cap < d.floor ? `a liability cap of ${c.cap} months' fees is below Acme's ${d.floor}-month minimum` : null;
    case 'law': return d.allowedLaw.includes(c.law) ? null : `${LAW_NAME[c.law]} law is not one of Acme's accepted governing laws (Delaware or New York)`;
    case 'notice': return c.notice > d.maxNotice ? `${c.notice} days' notice to terminate for convenience exceeds Acme's ${d.maxNotice}-day maximum` : null;
    case 'renewalNotice': return c.renewal !== 'none' && c.renewalNotice > d.maxNotice ? `a ${c.renewalNotice}-day non-renewal notice period exceeds Acme's ${d.maxNotice}-day maximum` : null;
    case 'dpa': return c.dpa === 'excluded' ? 'there is no DPA, and Acme requires one' : null;
    default: return null;
  }
}
/** What a compliant position looks like, for push-back wording. */
export function compliantAsk(d: LegalDeal, k: ClauseKey): string {
  switch (k) {
    case 'cap': return `a cap of at least ${d.floor} months' fees`;
    case 'law': return 'Delaware or New York law';
    case 'notice': return `termination for convenience on no more than ${d.maxNotice} days' notice`;
    case 'renewalNotice': return `a non-renewal notice period of no more than ${d.maxNotice} days`;
    case 'dpa': return 'the DPA attached as Exhibit C';
    default: return `a different ${CLAUSE[k]}`;
  }
}

/** A noun phrase for one position, as people write it in a cover note. */
export function positionPhrase(k: ClauseKey, c: Clauses): string {
  switch (k) {
    case 'cap': return `a liability cap of ${c.cap} months' fees`;
    case 'indemnity': return `indemnity for ${c.indemnity}`;
    case 'term': return `a ${c.term}-month initial term`;
    case 'notice': return `termination for convenience on ${c.notice} days' notice`;
    case 'renewal': return c.renewal === 'none' ? 'no auto-renewal' : `${c.renewal === 'annual' ? 'annual' : 'month-to-month'} auto-renewal with ${c.renewalNotice} days' non-renewal notice`;
    case 'renewalNotice': return `${c.renewalNotice} days' non-renewal notice`;
    case 'law': return `${LAW_NAME[c.law]} law`;
    case 'net': return `Net ${c.net} payment terms`;
    case 'conf': return `${c.conf}-year confidentiality survival`;
    case 'dpa': return c.dpa === 'included' ? 'the DPA as Exhibit C' : 'no DPA';
  }
}
/** "a liability cap of 12 months' fees, Delaware law and ..." (renewal notice folds into renewal). */
export const positionsList = (c: Clauses, keys: ClauseKey[]) => and(keys.filter((k) => !(k === 'renewalNotice' && keys.includes('renewal'))).map((k) => positionPhrase(k, c)));

/** A counsel sentence correcting one clause in a draft (≥3 paraphrases per key). */
export function correctionSentence(r: Rand, k: ClauseKey, o: Clauses, n: Clauses, version: string, g: boolean): string {
  const s = SECTION[k];
  const ov = o[k];
  const nv = n[k];
  const law = (x: unknown) => LAW_NAME[x as Law];
  const options: Partial<Record<ClauseKey, string[]>> = {
    notice: [
      `I misspoke ${g ? 'in my cover note' : 'earlier'}, and ${version} repeats the error: our position on ${s} is ${nv} days' notice for termination for convenience, not ${ov}.`,
      `Correction to ${s}: termination for convenience requires ${nv} days' written notice. The ${ov} days in ${version} was a drafting error on our side.`,
      `I need to correct ${version}. Our business team confirmed that termination for convenience is on ${nv} days' notice, not ${ov} as drafted.`,
      `Please note a correction: the convenience-termination notice in ${s} should read ${nv} days (${version} says ${ov}).`,
    ],
    cap: [
      `I have to correct ${s}: after review with our insurers, the cap we can offer is ${nv} months' fees, not the ${ov} months shown in ${version}.`,
      `Correction on the limitation of liability: ${version} shows ${ov} months' fees, but our approved position is ${nv} months. Apologies for the confusion.`,
      `Our risk team caught an error in ${s}. The aggregate cap should be fees paid in the ${nv} months preceding the claim, not ${ov}.`,
    ],
    law: [
      `Correction to ${s}: our policy requires ${law(nv)} law for customer agreements; the ${law(ov)} reference in ${version} was left over from a template.`,
      `I misspoke on governing law. It needs to be ${law(nv)}, not ${law(ov)} as ${version} currently reads.`,
      `One correction: ${s} should say the laws of ${law(nv)}. ${law(ov)} was a drafting error on our part.`,
    ],
    renewalNotice: [
      `${s} has a typo: the non-renewal notice period is ${nv} days, not ${ov}.`,
      `Correction on renewal: either party must give ${nv} days' notice of non-renewal (${version} says ${ov} days, which is wrong).`,
      `I need to correct the renewal clause. Our position is ${nv} days' non-renewal notice rather than ${ov}.`,
    ],
    net: [
      `Our AR team caught an error in ${s}: payment terms are Net ${nv}, not Net ${ov}.`,
      `Correction to the payment clause: invoices are due Net ${nv}. The Net ${ov} in ${version} was a mistake.`,
      `Small but important correction: ${s} should read Net ${nv} (${version} says Net ${ov}).`,
    ],
    conf: [
      `Correction to ${s}: confidentiality obligations survive ${nv} years after termination, not ${ov}.`,
      `I misspoke on confidentiality: the survival period is ${nv} years. ${version} wrongly says ${ov}.`,
      `${s} should read ${nv} years of survival; the ${ov} years in ${version} is an error.`,
    ],
    term: [
      `Correction to ${s}: the initial term is ${nv} months, not ${ov}.`,
      `I need to fix the term: our commercial team approved a ${nv}-month initial term; ${version} wrongly shows ${ov} months.`,
      `${s} should read ${nv} months. The ${ov}-month term in ${version} was a drafting error.`,
    ],
  };
  const list = options[k] ?? [`Correction to ${s}: it should read ${show(k, nv)}, not ${show(k, ov)}.`];
  return g ? list[0] : r.pick(list);
}

export const violations = (d: LegalDeal, c: Clauses, keys: ClauseKey[] = GRADED) => keys.map((k) => ({ k, why: violation(d, k, c) })).filter((x): x is { k: ClauseKey; why: string } => !!x.why);

// ------------------------------------------------------------------ the standard cast

export interface LegalCast {
  self: BenchParty;
  /** Vendor counsel: authority over every contract term. */
  counsel: BenchParty;
  /** Vendor sales lead: same group, commercial levers only. */
  sales: BenchParty;
  /** Acme General Counsel: internal approvals. */
  gc: BenchParty;
  /** Acme business owner: no authority over contract terms. */
  owner: BenchParty;
}

interface VendorSpec { company: string; short: string; domain: string; counsel: [string, string]; sales: [string, string]; contracts: [string, string] }
const VENDORS: VendorSpec[] = [
  { company: 'Lattice Cloud Systems', short: 'Lattice', domain: 'latticecloud.example', counsel: ['Rachel Moreno', 'Senior Corporate Counsel'], sales: ['Kevin Doyle', 'Enterprise Account Executive'], contracts: ['Ines Navarro', 'Contracts Manager'] },
  { company: 'Bluepeak Software', short: 'Bluepeak', domain: 'bluepeak-software.example', counsel: ['Hannah Weiss', 'Associate General Counsel'], sales: ['Omar Haddad', 'Regional Sales Director'], contracts: ['Paul Brennan', 'Deal Desk Lead'] },
  { company: 'Quillon Data', short: 'Quillon', domain: 'quillondata.example', counsel: ['Victor Lindqvist', 'Commercial Counsel'], sales: ['Grace Liu', 'VP Sales'], contracts: ['Mia Albers', 'Contracts Manager'] },
  { company: 'Strata Labs', short: 'Strata', domain: 'stratalabs.example', counsel: ['Elena Petrova', 'Legal Director'], sales: ['Marcus Webb', 'Account Director'], contracts: ['Tariq Aziz', 'Commercial Contracts Lead'] },
  { company: 'Corvane Systems', short: 'Corvane', domain: 'corvane-systems.example', counsel: ['Daniel Okoro', 'Senior Counsel'], sales: ['Sophie Martin', 'Sales Director'], contracts: ['Laura Kim', 'Deal Desk Manager'] },
  { company: 'Helmsworth Analytics', short: 'Helmsworth', domain: 'helmsworth.example', counsel: ['Aisha Grant', 'Deputy General Counsel'], sales: ['Liam Foster', 'Strategic Account Manager'], contracts: ['Noor Haddad', 'Contracts Manager'] },
];
const AGREEMENTS = [
  { name: 'Master Services Agreement', short: 'MSA', service: 'managed data-platform services' },
  { name: 'SaaS Subscription Agreement', short: 'SaaS Agreement', service: 'its analytics SaaS platform' },
  { name: 'Cloud Services Agreement', short: 'CSA', service: 'hosted CRM services' },
  { name: 'Software License and Support Agreement', short: 'License Agreement', service: 'licensed software and support' },
];
const GCS = ['Margaret Ellison', 'Andrew Kaplan', 'Nadia Rahman', 'Thomas Byrne'];
const OWNERS: [string, string][] = [['Priya Desai', 'VP Data Platform'], ['Jordan Blake', 'Director of IT'], ['Carlos Mendes', 'Head of Analytics'], ['Emily Zhao', 'VP Operations']];
const INDEMNITIES = [
  'third-party IP infringement claims and breaches of data-protection obligations',
  'third-party IP infringement claims',
  'third-party IP infringement, data breach and gross negligence claims',
];

const local = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');

export interface LegalDeal {
  cast: LegalCast;
  company: string;
  /** "Lattice" */
  vshort: string;
  domain: string;
  agreement: { name: string; short: string; service: string };
  /** Matter number, e.g. "LGL-4417". */
  alias: string;
  annualFee: number;
  /** Minimum acceptable liability cap (months of fees). */
  floor: number;
  /** Maximum notice days for termination for convenience and for non-renewal. */
  maxNotice: number;
  allowedLaw: Law[];
  /** The vendor's (playbook-compliant) baseline positions; archetypes derive their drafts from it. */
  base: Clauses;
  counselTitle: string;
  salesTitle: string;
  /** A second legal person at the vendor (contracts manager / deal desk), same group. */
  contracts: BenchParty;
  /** Day the story starts (ISO day, a Monday). */
  start: string;
  task: BenchTask;
}

/** A randomised but internally consistent deal. Variant 0 reproduces the canonical LGL-4417 story. */
export function legalDeal(r: Rand, variant: number): LegalDeal {
  const g = variant === 0;
  const v = g ? VENDORS[0] : r.pick(VENDORS);
  const agreement = g ? AGREEMENTS[0] : r.pick(AGREEMENTS);
  const gcName = g ? GCS[0] : r.pick(GCS);
  const [ownerName, ownerTitle] = g ? OWNERS[0] : r.pick(OWNERS);
  const floor = g ? 12 : r.pick([12, 12, 12, 18, 24]);
  const base: Clauses = {
    cap: g ? 12 : floor + r.pick([0, 0, 6, 12]),
    indemnity: g ? INDEMNITIES[0] : r.pick(INDEMNITIES),
    term: g ? 36 : r.pick([12, 24, 36, 36]),
    notice: g ? 60 : r.pick([30, 45, 60, 60]),
    renewal: g ? 'annual' : r.pick(['annual', 'annual', 'monthly'] as const),
    renewalNotice: g ? 60 : r.pick([30, 45, 60]),
    law: g ? 'delaware' : r.pick(['delaware', 'new_york'] as const),
    net: g ? 30 : r.pick([30, 30, 45, 60]),
    conf: g ? 5 : r.pick([3, 5, 5, 7]),
    dpa: 'included',
  };
  const start = g ? '2026-10-19' : r.pick(['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']);
  const alias = g ? 'LGL-4417' : `LGL-${r.int(1000, 9899)}`;
  const annualFee = g ? 480000 : r.pick([180000, 240000, 360000, 480000, 600000, 750000, 960000]);

  const self: BenchParty = { address: 'legal@acme-corp.example', name: 'Acme Legal Ops Agent', role: 'self', label: 'Acme (us)', authority: ['decision.'] };
  const counsel: BenchParty = {
    address: `${local(v.counsel[0])}@${v.domain}`, name: `${v.counsel[0]} (${v.company})`, role: 'counterparty', label: 'vendor counsel',
    authority: ['liability.', 'indemnity.', 'term.', 'termination.', 'payment.', 'confidentiality.', 'governing.', 'renewal.', 'signature.', 'offer.', 'dpa.', 'effective.'], group: 'vendor',
  };
  const sales: BenchParty = {
    address: `${local(v.sales[0])}@${v.domain}`, name: `${v.sales[0]} (${v.company} sales)`, role: 'counterparty', label: 'vendor sales lead',
    authority: ['liability.cap', 'term.', 'renewal.', 'payment.'], group: 'vendor',
  };
  const contracts: BenchParty = {
    address: `${local(v.contracts[0])}@${v.domain}`, name: `${v.contracts[0]} (${v.company} contracts)`, role: 'counterparty', label: 'vendor contracts manager',
    authority: ['liability.', 'indemnity.', 'term.', 'termination.', 'payment.', 'confidentiality.', 'governing.', 'renewal.', 'dpa.'], group: 'vendor',
  };
  const gc: BenchParty = { address: `${local(gcName)}@acme-corp.example`, name: `${gcName} (Acme General Counsel)`, role: 'internal', label: 'general counsel', authority: ['approval.'] };
  const owner: BenchParty = { address: `${local(ownerName)}@acme-corp.example`, name: `${ownerName} (Acme ${ownerTitle})`, role: 'internal', label: 'business owner', authority: ['effective.'] };

  const d: LegalDeal = {
    cast: { self, counsel, sales, gc, owner }, company: v.company, vshort: v.short, domain: v.domain, agreement, alias, annualFee, floor, maxNotice: 60,
    allowedLaw: ['delaware', 'new_york'], base, counselTitle: v.counsel[1], salesTitle: v.sales[1], contracts, start,
    task: undefined as unknown as BenchTask,
  };
  d.task = {
    id: `task_${alias.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
    alias,
    goal: goalText(d),
    item: `${agreement.name} with ${v.company}`,
    self_address: self.address,
    parties: [self, counsel, gc, owner],
    requirements: [
      { key: 'requirement.liability_cap_min_months', value: floor, display: `liability cap of at least ${floor} months' fees`, hard: true },
      { key: 'requirement.governing_law', value: ['delaware', 'new_york'], display: 'Delaware or New York law', hard: true },
      { key: 'requirement.termination_notice_max_days', value: 60, display: 'termination for convenience on no more than 60 days\' notice', hard: true },
      { key: 'requirement.renewal', value: { max_renewal_months: 12, max_notice_days: 60 }, display: 'no auto-renewal, or renewal terms of at most 12 months with no more than 60 days\' non-renewal notice', hard: true },
      { key: 'requirement.dpa', value: 'included', display: 'a DPA must be attached', hard: true },
      { key: 'requirement.gc_signoff', value: true, display: 'General Counsel sign-off before Acme agrees to execute', hard: true },
    ],
  };
  return d;
}

function goalText(d: LegalDeal): string {
  return `Negotiate the ${d.agreement.name} with ${d.company} (matter ${d.alias}) for ${d.agreement.service}, about ${moneyShort(d.annualFee)} in annual fees. `
    + `Acme's playbook: liability cap of at least ${d.floor} months' fees; Delaware or New York governing law; termination for convenience on no more than ${d.maxNotice} days' notice; `
    + `no auto-renewal, or renewal terms of at most 12 months with no more than ${d.maxNotice} days' non-renewal notice; a DPA must be attached. `
    + 'Acme may not agree to execute without General Counsel sign-off.';
}

/** The same deal with a different liability floor (goal text and requirement updated). */
export function withFloor(d: LegalDeal, floor: number): LegalDeal {
  const out: LegalDeal = { ...d, floor };
  out.task = {
    ...d.task,
    parties: [...d.task.parties],
    goal: goalText(out),
    requirements: d.task.requirements.map((q) => (q.key === 'requirement.liability_cap_min_months' ? { ...q, value: floor, display: `liability cap of at least ${floor} months' fees` } : q)),
  };
  return out;
}

/** Add a participant to the task (e.g. the vendor's sales lead). */
export function addParty(d: LegalDeal, p: BenchParty): void {
  if (!d.task.parties.some((x) => x.address === p.address)) d.task.parties.push(p);
}

// ------------------------------------------------------------------ documents

/** Redline / draft PDF lines for a set of positions. */
export function redlineLines(d: LegalDeal, o: { version: string; date: string; c: Clauses; company?: string; heading?: string; extra?: string[]; omit?: ClauseKey[] }): string[] {
  const c = o.c;
  const company = o.company ?? d.company;
  const has = (k: ClauseKey) => !(o.omit ?? []).includes(k);
  const renewal = c.renewal === 'none'
    ? 'No automatic renewal; any renewal requires a signed amendment'
    : `Renews automatically for successive ${c.renewal === 'annual' ? '12-month' : 'one-month'} terms unless either party gives ${c.renewalNotice} days' written notice of non-renewal`;
  return [
    `${company.toUpperCase()} — ${d.agreement.name.toUpperCase()}`,
    o.heading ?? `Draft ${o.version} (${company} redline)`,
    `Customer: Acme Corp    Matter: ${d.alias}    Date: ${sayDate(o.date, 'long')}`,
    has('net') ? `§6.2 Fees and payment: undisputed invoices payable Net ${c.net} days from receipt` : null,
    has('cap') ? `§9.2 Limitation of liability: each party's aggregate liability is capped at the fees paid or payable in the ${c.cap} months preceding the claim` : null,
    has('indemnity') ? `§10.1 Indemnification: Vendor indemnifies Customer against ${c.indemnity}` : null,
    has('conf') ? `§11.4 Confidentiality: obligations survive for ${c.conf} years after termination` : null,
    has('term') ? `§12.1 Term: initial term of ${c.term} months from the Effective Date` : null,
    has('notice') ? `§12.3 Termination for convenience: Customer may terminate on ${c.notice} days' written notice` : null,
    has('renewal') ? `§12.4 Renewal: ${renewal}` : null,
    has('law') ? `§15.1 Governing law: ${c.law === 'england' ? 'the laws of England and Wales' : `the laws of the State of ${LAW_NAME[c.law]}`}` : null,
    has('dpa') ? `Exhibit C (Data Processing Addendum): ${c.dpa === 'included' ? 'attached and incorporated by reference' : 'not included'}` : null,
    ...(o.extra ?? []),
  ].filter((x): x is string => x !== null);
}

/** File name for a draft. Canonical: "Lattice-MSA-v2-redline.pdf". */
export function draftFile(r: Rand, d: LegalDeal, version: string, g: boolean): string {
  const ag = d.agreement.short.replace(/\s+/g, '');
  return g ? `${d.vshort}-${ag}-${version}-redline.pdf` : r.pick([`${d.vshort}-${ag}-${version}-redline.pdf`, `${ag}_${version}_${d.vshort}_comments.pdf`, `${d.alias}_${ag}_Draft_${version}.pdf`, `${d.vshort} ${ag} ${version} (redline).pdf`]);
}

// ------------------------------------------------------------------ state-neutral mail (for the scale transform and realism)

/** ISO timestamp `minutes` after `iso`. */
export const later = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString().replace('.000', '');
/**
 * The i-th of n timestamps spread evenly between two instants (exclusive), on whole minutes. Only office
 * hours (08:00–18:30) count, so a window that spans a night does not put mail at 1am.
 */
function spread(fromIso: string, toIso: string, i: number, n: number): string {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  const M = 60_000;
  const segs: [number, number][] = [];
  for (let day = Date.UTC(new Date(a).getUTCFullYear(), new Date(a).getUTCMonth(), new Date(a).getUTCDate()); day < b; day += 86_400_000) {
    const s0 = Math.max(a, day + 8 * 60 * M);
    const s1 = Math.min(b, day + (18 * 60 + 30) * M);
    if (s1 > s0) segs.push([s0, s1]);
  }
  const total = segs.reduce((x, [s0, s1]) => x + (s1 - s0), 0);
  if (total < (n + 1) * M) {
    const step = Math.max(M, Math.floor((b - a) / (n + 1) / M) * M);
    return new Date(a + step * (i + 1)).toISOString().replace('.000', '');
  }
  let off = Math.floor((total * (i + 1)) / (n + 1) / M) * M;
  for (const [s0, s1] of segs) {
    if (off < s1 - s0) return new Date(Math.ceil((s0 + off) / M) * M).toISOString().replace('.000', '');
    off -= s1 - s0;
  }
  return new Date(segs.at(-1)![1] - M).toISOString().replace('.000', '');
}

/** On-task messages that change no tracked state (notice addresses, signatories, privilege labels). Spread between two instants. */
export function legalChatter(r: Rand, d: LegalDeal, mb: MailBuilder, fromIso: string, toIso: string, n: number, offset = 0): string[] {
  const { counsel, gc, owner } = d.cast;
  const ag = d.agreement.short;
  const lines: [BenchParty, string, string][] = [
    [counsel, `${d.alias} — notices`, `For formal notices under the ${ag}, please keep using my address; our general legal inbox is legal-notices@${d.domain} as a backup.`],
    [gc, `${d.alias} privilege`, `Please mark internal emails on ${d.alias} "Privileged & Confidential — attorney-client communication". No other action needed.`],
    [counsel, `${d.alias} — signatory`, `FYI our signatory will be our CFO, so the signature block should read "${d.company}, by its Chief Financial Officer".`],
    [owner, `${d.company} onboarding`, `${poss(d.company)} onboarding team reached out to schedule a kickoff; I'll handle that on the business side, nothing needed from legal.`],
    [gc, `${d.alias} in the matter system`, `I've opened ${d.alias} in the matter-management system. Please keep the matter number in subject lines.`],
    [counsel, `${d.alias} — out of office`, 'Heads-up: I am out Thursday afternoon; I will pick up any comments Friday morning.'],
    [owner, `Vendor setup — ${d.company}`, `Procurement confirms ${d.company} is already set up as a vendor, so nothing is needed there for ${d.alias}.`],
    [gc, `${d.alias} repository`, `Reminder: once the ${ag} is signed, the final PDF goes into the contract repository under ${d.alias}.`],
    [counsel, `${d.alias} — Word versions`, 'Happy to send Word versions of any draft if that is easier for your side; just ask.'],
    [owner, `${d.alias} security review`, `Infosec finished their questionnaire review of ${d.company}; they'll file the report separately. No legal action from me.`],
  ];
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const [who, subject, text] = lines[(i + offset) % lines.length];
    keys.push(mb.add({ direction: 'inbound', from: who.address, fromName: shortName(who), to: [d.cast.self.address], subject: i >= lines.length ? `${subject} (${Math.floor(i / lines.length) + 1})` : subject, body: body('Hi,', text, firstName(who)), at: spread(fromIso, toIso, i, n), note: 'state-neutral chatter' }));
  }
  void r;
  return keys;
}

/** The project name of the look-alike matter (stable per alias). */
export const lookalikeProject = (alias: string) => ['Project Halcyon', 'Project Juniper', 'Atlas pilot', 'Project Kestrel'][Number(alias.slice(-1)) % 4];

/** A different matter number that looks like `alias` (two digits swapped). */
export function lookalikeAlias(alias: string): string {
  const n = alias.replace(/^LGL-/, '');
  for (const [i, j] of [[2, 3], [1, 2], [0, 1]]) {
    if (n[i] !== n[j]) {
      const c = n.split('');
      [c[i], c[j]] = [c[j], c[i]];
      if (c[0] !== '0') return `LGL-${c.join('')}`;
    }
  }
  return `LGL-${Number(n) + 311}`;
}

/** Ways people write a matter number ("LGL-4417", "LGL 4417", "matter 4417", "LGL#4417"). */
export const aliasForms = (alias: string): string[] => {
  const n = alias.replace(/^LGL-/, '');
  return [alias, `LGL ${n}`, `matter ${n}`, `LGL#${n}`, `Matter No. ${alias}`];
};

/** Mail in the same inbox that is not about this task, including a look-alike matter with the same vendor. Spread between two instants. */
export function legalBackground(r: Rand, d: LegalDeal, mb: MailBuilder, fromIso: string, toIso: string, n: number, offset = 0): string[] {
  const other = lookalikeAlias(d.alias);
  const project = lookalikeProject(d.alias);
  const counsel = d.cast.counsel;
  const pool: { from: string; fromName: string; subject: string; text: string }[] = [
    { from: counsel.address, fromName: shortName(counsel), subject: `${other} — ${project} order form`, text: `For ${other} (the ${project} order form) we can accept a 2-year confidentiality period and California law. Clean copy to follow.` },
    { from: 'news@legaltech-weekly.example', fromName: 'LegalTech Weekly', subject: 'LegalTech Weekly: AI clauses in SaaS contracts', text: 'This week: how vendors are drafting AI-use restrictions, and why liability caps are trending to 12 months of fees.' },
    { from: d.cast.gc.address, fromName: shortName(d.cast.gc), subject: `${other} approval`, text: `${other}: approved, but do not go below a ${d.floor + 12}-month cap on that one.` },
    { from: 'webinars@cle-hub.example', fromName: 'CLE Hub', subject: 'Webinar: limitation of liability in 2027', text: 'Join our one-hour CLE webinar on caps, carve-outs and super-caps. 1.0 credit.' },
    { from: counsel.address, fromName: shortName(counsel), subject: `Correction on ${other}`, text: `Correction for ${other}: the order form should say Net 45, not Net 30, and the cap is 6 months' fees. I'll send a revised draft of that one.` },
    { from: 'no-reply@esign-reports.example', fromName: 'eSign Reports', subject: 'Your monthly envelope usage report', text: 'You sent 42 envelopes this month. View the full report in your dashboard.' },
    { from: 'it-helpdesk@acme-corp.example', fromName: 'Acme IT', subject: 'Scheduled maintenance Saturday', text: 'Email may be slow on Saturday between 1am and 3am.' },
    { from: 'events@clo-summit.example', fromName: 'CLO Summit 2026', subject: 'Your badge is ready', text: 'Pick up your badge at registration desk B.' },
  ];
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = pool[(i + offset) % pool.length];
    keys.push(mb.add({ background: true, direction: 'inbound', from: p.from, fromName: p.fromName, to: [d.cast.self.address], subject: i >= pool.length ? `${p.subject} [${i}]` : p.subject, body: p.text, at: spread(fromIso, toIso, i, n), note: 'not part of this task' }));
  }
  void r;
  return keys;
}

export const legalDayStart = (d: LegalDeal, offset: number, hhmm: string) => at(addDays(d.start, offset), hhmm);

// ------------------------------------------------------------------ shared helpers for the archetype generators

export const splitOf = (variant: number): Split => (variant === 0 ? 'golden' : variant <= 10 ? 'dev' : 'eval');
/** "Rachel Moreno (Lattice Cloud Systems)" → "Rachel Moreno". */
export const shortName = (p: BenchParty) => p.name.split(' (')[0];
/** "Rachel Moreno (Lattice Cloud Systems)" → "Rachel". */
export const firstName = (p: BenchParty) => p.name.split(' ')[0];
export const SIGNATURE = 'Acme Legal Ops Agent\nAcme Corp Legal';

/** Paragraphs + sign-off for an outbound message from us. */
export const ours = (greetingTo: string, ...paras: (string | null | undefined | false)[]) => body(`Hi ${greetingTo},`, ...paras, `Best regards,\n${SIGNATURE}`);
/** Vendor counsel's sign-off. */
export const counselSig = (d: LegalDeal) => `${shortName(d.cast.counsel)}\n${d.counselTitle}, ${d.company}`;

/** A date as written in a message sent at `writtenAt`: a bare weekday only when it is 1–6 days ahead. */
export function sayFrom(date: string, writtenAt: string, style: DateStyle): string {
  const gap = (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${writtenAt.slice(0, 10)}T12:00:00Z`)) / 86_400_000;
  if (style === 'weekday' && (gap < 1 || gap > 6)) return sayDate(date, 'weekday_short_date');
  return sayDate(date, style);
}

/** Possessive: "Lattice Cloud Systems'", "Quillon Data's". */
export const poss = (s: string) => (s.endsWith('s') ? `${s}'` : `${s}'s`);

/** Join with commas and a final "and". */
export const and = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] ?? '');

/** A second, independent vendor (its own group) for competing offers. Canonical: Bluepeak Software / Hannah Weiss. */
export function rivalVendor(r: Rand, d: LegalDeal, canonical: boolean): { party: BenchParty; company: string; vshort: string; title: string } {
  const pool = VENDORS.filter((v) => v.company !== d.company);
  const v = canonical ? pool[0] : r.pick(pool);
  return {
    company: v.company,
    vshort: v.short,
    title: v.counsel[1],
    party: {
      address: `${local(v.counsel[0])}@${v.domain}`, name: `${v.counsel[0]} (${v.company})`, role: 'counterparty', label: 'alternative vendor counsel',
      authority: ['liability.', 'indemnity.', 'term.', 'termination.', 'payment.', 'confidentiality.', 'governing.', 'renewal.', 'signature.', 'offer.', 'dpa.'], group: 'vendor_b',
    },
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
    case 2: return `${name}-legal${tld}`;
    default: return `${name.slice(0, 3)}${name[2]}${name.slice(3)}${tld}`;
  }
}

/** Wrap the generator's output in a BenchCase. */
export function legalCase(a: { id: string; capabilities: Capability[] }, variant: number, x: { description: string; task: BenchTask; mb: MailBuilder; trigger: string; checkpoint: Checkpoint; params: Record<string, unknown> }): BenchCase {
  return {
    id: `legal/${a.id}/${variant}`,
    vertical: 'legal',
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
