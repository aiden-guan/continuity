// The vendor-onboarding pack: a second, deliberately small workflow on the same engine. The vendor sends
// an insurance certificate and a tax form; the requester sets coverage and validity requirements.
// Corrections, authority, document staleness, obligations and the send guard work unchanged; only the
// vocabulary, the checks and the extraction patterns are new.
import type { CheckResult, Claim, TaskSpec } from '../types.ts';
import { findDates, prettyDate } from '../extract/dates.ts';
import { normalizeTyped, displayTyped } from './procurement.ts';
import { registerDomain, termOf, type DomainPack, type HeuristicSentence, type TermDef } from './pack.ts';

const TERMS: TermDef[] = [
  { key: 'insurance.expires', type: 'date', description: 'Expiry date of the vendor\'s liability insurance policy', topics: ['insurance', 'coi', 'certificate', 'policy', 'expire', 'expiry', 'valid'], events: { default: 'insurance_expiry_stated' }, deadline: true },
  { key: 'insurance.coverage', type: 'money', description: 'Per-occurrence liability coverage in USD', topics: ['coverage', 'insurance', 'liability', 'limit'], events: { default: 'coverage_stated' } },
  { key: 'tax_form.status', type: 'enum', values: ['submitted'], description: 'The vendor submitted its tax form (W-9)', topics: ['w-9', 'w9', 'tax form', 'tax id', 'tin'], events: { default: 'tax_form_submitted' } },
  { key: 'vendor.status', type: 'enum', values: ['withdrawn'], lifecycle: true, description: 'The vendor withdrew from onboarding', topics: ['withdraw', 'no longer', 'cancel'], events: { default: 'vendor_withdrew' } },
  { key: 'decision.vendor', type: 'text', description: 'Our decision to approve/activate the vendor', topics: ['approve', 'activate', 'onboard'], events: { self: 'vendor_approved', default: 'vendor_decision' } },
];

const termDef = (key: string) => TERMS.find((t) => t.key === key);
const requirement = (task: TaskSpec, key: string) => task.requirements.find((r) => r.key === key);

function runChecks(task: TaskSpec, active: Claim[]): CheckResult[] {
  const results: CheckResult[] = [];
  const validThrough = requirement(task, 'requirement.insurance_valid_through');
  const minCoverage = requirement(task, 'requirement.min_coverage');
  const taxForm = requirement(task, 'requirement.tax_form');

  for (const vendor of task.participants.filter((p) => p.role === 'counterparty')) {
    const who = vendor.address;
    const own = (key: string) => active.find((c) => c.key === key && c.speaker === who);

    const withdrawn = own('vendor.status');
    if (withdrawn) {
      results.push({
        id: `vendor_active:${who}`, label: `${vendor.label} still onboarding`, status: 'fail', party: who, evidence: [withdrawn.id],
        requirement_key: 'vendor.status', detail: `${vendor.label} withdrew (${withdrawn.source_event_id})`,
      });
      continue;
    }

    if (validThrough) {
      const id = `insurance_valid:${who}`;
      const label = `Insurance valid through ${validThrough.display}`;
      const expires = own('insurance.expires');
      if (!expires) {
        results.push({ id, label, status: 'unknown', party: who, evidence: [], requirement_key: validThrough.key, detail: `No insurance expiry from ${vendor.label} yet` });
      } else {
        const ok = String(expires.value) >= String(validThrough.value);
        results.push({
          id, label, party: who, evidence: [expires.id], requirement_key: validThrough.key, status: ok ? 'pass' : 'fail',
          detail: ok ? `Policy valid until ${expires.display}` : `Policy expires ${expires.display}, before ${validThrough.display}`,
        });
      }
    }

    if (minCoverage) {
      const id = `insurance_coverage:${who}`;
      const label = `Coverage ≥ ${minCoverage.display}`;
      const coverage = own('insurance.coverage');
      if (!coverage) {
        results.push({ id, label, status: 'unknown', party: who, evidence: [], requirement_key: minCoverage.key, detail: `No coverage amount from ${vendor.label} yet` });
      } else {
        const ok = Number(coverage.value) >= Number(minCoverage.value);
        results.push({
          id, label, party: who, evidence: [coverage.id], requirement_key: minCoverage.key, status: ok ? 'pass' : 'fail',
          detail: `${coverage.display} coverage${ok ? '' : ` is below ${minCoverage.display}`}`,
        });
      }
    }

    if (taxForm) {
      const form = own('tax_form.status');
      results.push({
        id: `tax_form:${who}`, label: 'Tax form (W-9) received', party: who, evidence: form ? [form.id] : [], requirement_key: taxForm.key,
        status: form ? 'pass' : 'unknown', detail: form ? `W-9 submitted (${form.source_event_id})` : `No W-9 from ${vendor.label} yet`,
      });
    }
  }
  return results;
}

const toMoney = (s: string) => Number(s.replace(/[,$]/g, ''));

function sentence(x: HeuristicSentence): void {
  const s = x.text;
  if (x.isQuestion || x.senderRole === 'self') return;

  if (/\b(withdraw(?:n|ing)?|no longer (?:wish|want|able) to (?:proceed|onboard|work))\b/i.test(s) && !/\bnot\b/i.test(s)) {
    x.claim({ key: 'vendor.status', value: 'withdrawn', kind: 'offer', evidence: s, hedged: x.hedged });
    return;
  }

  const expiry = s.match(/\b(?:expir\w*|valid (?:until|through|thru)|effective (?:until|through))\b/i);
  if (expiry && /\b(polic|insurance|coi|certificate|coverage)/i.test(s + (x.fromAttachment ?? ''))) {
    const d = findDates(s.slice(expiry.index!), x.ref)[0];
    if (d) x.claim({ key: 'insurance.expires', value: d.iso, kind: 'offer', evidence: s, hedged: x.hedged });
  }

  const amount = s.match(/\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(m(?:illion)?\b)?/i);
  if (amount && /\b(coverage|liability|per occurrence|each occurrence|limit)\b/i.test(s)) {
    const value = toMoney(amount[1]) * (amount[2] ? 1_000_000 : 1);
    x.claim({ key: 'insurance.coverage', value, kind: 'offer', evidence: s, hedged: x.hedged });
  }

  if (/\b(w-?9|tax form)\b/i.test(s) && /\b(attached|enclosed|submitted|here is|signed|completed|uploaded)\b/i.test(s)) {
    x.claim({ key: 'tax_form.status', value: 'submitted', kind: 'offer', evidence: s, hedged: x.hedged });
  }
}

export const vendorOnboarding: DomainPack = {
  id: 'vendor_onboarding',
  agentRole: 'You are a vendor-onboarding agent acting for Acme by email.',
  terms: TERMS,
  llmGuidance: '- insurance.expires is the policy expiry date (YYYY-MM-DD). insurance.coverage is the per-occurrence limit in USD. tax_form.status="submitted" only if the W-9 is attached or explicitly submitted.',
  normalizeValue(key, value) {
    const def = termDef(key);
    return def ? normalizeTyped(def, value) : null;
  },
  displayValue(key, value) {
    const def = termDef(key);
    if (!def) return String(value);
    return def.type === 'date' ? prettyDate(String(value)) : displayTyped(def, value);
  },
  runChecks,
  expectedTerms: (task) => task.participants
    .filter((p) => p.role === 'counterparty')
    .map((party) => ({ party, keys: ['insurance.expires', 'insurance.coverage', 'tax_form.status'] })),
  decisionKey: 'decision.vendor',
  bindingPatterns: [/\b((?:we|i) (?:hereby )?(?:approve|activate) (?:you|your (?:company|account))|you are (?:now )?(?:approved|activated|onboarded)|onboarding is complete)\b/gi],
  extraActions({ task, checks, contested, live }) {
    const self = task.self_address.toLowerCase();
    const approved = live.some((c) => c.key === 'decision.vendor' && c.speaker === self);
    const vendor = task.participants.find((p) => p.role === 'counterparty');
    const ready = checks.length > 0 && checks.every((c) => c.status === 'pass') && !contested.length;
    if (!ready || approved || !vendor) return [];
    return [{
      priority: 1, kind: 'approve_vendor', to: vendor.label, to_address: vendor.address,
      action: `All onboarding requirements are met by ${vendor.label} — confirm activation in writing`,
      why: checks.map((c) => c.detail).join('; '), evidence: [],
    }];
  },
  heuristic: { begin: () => null, sentence: (s) => sentence(s), end: () => undefined },
};

registerDomain(vendorOnboarding);

export function vendorTerm(key: string): TermDef | undefined {
  return termOf(vendorOnboarding, key);
}
