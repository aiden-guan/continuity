// The domain boundary. The engine (resolver, compiler, guard, extractors) is generic over evidence,
// claims, obligations and documents. A pack supplies what is specific to one kind of work:
//  - vocabulary: the typed terms that can be claimed, and how their values are validated and shown
//  - checks: pure functions from active claims to pass / fail / unknown results
//  - action prerequisites: which outbound phrases are binding, and what state must hold before them
//  - optionally, sentence patterns for the offline extractor (the LLM extractor reads the vocabulary),
//    document kinds, typed-timeline event names, and the offline policy agent's wording
import type { CheckResult, Claim, Obligation, Participant, TaskSpec } from '../types.ts';
import type { ProposedClaim, ProposedFulfillment, ProposedObligation } from '../extract/types.ts';
import type { CompiledContext } from '../compiler/compile.ts';

/** Value types; canonical forms and display live in values.ts. `schedule` is a list of {qty, date} lots
 *  (delivery lots, nightly room blocks, installment plans). */
export type TermType = 'money' | 'number' | 'percent' | 'schedule' | 'date' | 'datetime' | 'window' | 'text' | 'enum';

export interface TermDef {
  key: string;
  type: TermType;
  description: string;
  /** Words that make a question or request "about" this term. */
  topics: string[];
  /** Enum terms only. */
  values?: string[];
  /** The value means "the counterparty's offer is withdrawn / unavailable" (offer lifecycle). */
  lifecycle?: boolean;
  /** Numeric terms: which values are valid (default: positive; percent: zero or more). */
  range?: 'positive' | 'nonnegative' | 'any';
  /** Schedule terms: what a lot's qty counts ("units", "rooms", "loads", "$" for amounts). */
  unit?: string;
  /**
   * Money or identity details where fraud happens (wire / bank details, payment terms). A new value from
   * email is never applied on its own: it is held until a human verifies it ("always": even the first
   * statement; "change": only a change from the speaker's current value).
   */
  sensitive?: 'always' | 'change';
  /**
   * Typed-timeline event names for a change to this term, by the speaker's role (a price from us is
   * `offer_made`, from the seller's side `counter_offer`). Without one the event is `<key>_stated`.
   */
  events?: Partial<Record<'self' | 'counterparty' | 'internal' | 'default', string>>;
  /** A date term the deal must act by: Signal warns as it approaches. */
  deadline?: boolean;
}

/**
 * A document kind of the domain: `match` classifies an attachment (filename + text), `promise` spots a
 * promise or request to send one.
 */
export interface DocumentKind {
  kind: string;
  match: RegExp;
  promise: RegExp;
  /** Separate parts of one set (a BEO per day, a POD per load, a signature page per entity): a newer one
   *  does not supersede an older one, and a promise of N of them is fulfilled one document at a time. */
  multipart?: boolean;
}

type PolicyParty = CompiledContext['task']['parties'][number];

/** Wording for the offline policy agent (src/agent/policy.ts). A hook returning null keeps the default wording. */
export interface PolicyWriter {
  raiseConflict?(a: SuggestedAction, ctx: CompiledContext): string[] | null;
  askForTerms?(asks: SuggestedAction[], party: PolicyParty, ctx: CompiledContext): { subject?: string; lines: string[] } | null;
  requestApproval?(a: SuggestedAction, party: PolicyParty, ctx: CompiledContext): { subject?: string; lines: string[] } | null;
  accept?(party: PolicyParty, ctx: CompiledContext): string[] | null;
  /** Appended to "we're still expecting the <x>" when a conflict is raised in the same email. */
  reminderSuffix?: string;
  /** The sign-off name. */
  signature?: string;
}

/** One sentence of message or document text, as the offline extractor sees it. */
export interface HeuristicSentence {
  text: string;
  isQuestion: boolean;
  hedged: boolean;
  senderRole: 'self' | 'counterparty' | 'internal' | 'unknown';
  /** Term-key prefixes the sender may set (empty for unknown senders). */
  senderAuthority: string[];
  /** Live claims on record, with their evidence (to resolve references like "§12.1" to the clause they name). */
  known: { key: string; evidence: string }[];
  fromAttachment: string | null;
  /** The message date; relative dates resolve against it. */
  ref: string;
  claim(c: Omit<ProposedClaim, 'mode' | 'from_attachment' | 'confidence'> & { confidence?: number; mode?: ProposedClaim['mode'] }): void;
  fulfillment(f: Omit<ProposedFulfillment, 'confidence'> & { confidence?: number }): void;
  /** A domain speech act the generic patterns miss ("Can do all 3 loads" commits to 3 loads). */
  obligation(o: Omit<ProposedObligation, 'confidence' | 'evidence' | 'expects_artifact'> & { confidence?: number; expects_artifact?: string | null }): void;
}

export interface SuggestedAction {
  priority: number;
  kind: string;
  to: string | null;
  to_address: string | null;
  check_id?: string;
  obligation_id?: string;
  action: string;
  why: string;
  evidence: string[];
}

export interface ActionContext {
  task: TaskSpec;
  checks: CheckResult[];
  /** Active and contested claims. */
  live: Claim[];
  /** Claims recorded but not applied (unauthorised or unauthenticated speakers, hedges). */
  tentative?: Claim[];
  contested: Claim[];
  openDebtors: { debtor: string; creditor: string; topic_keys: string[]; kind?: string; expects_artifact?: string | null }[];
  label: (address: string) => string;
}

export interface DomainPack {
  id: string;
  /** One line for agent prompts: who the agent acts for. */
  agentRole: string;
  terms: TermDef[];
  /** Term-specific conventions for the LLM extractor. */
  llmGuidance: string;
  normalizeValue(key: string, value: unknown): unknown | null;
  displayValue(key: string, value: unknown): string;
  /** Merge a partial update of a structured term ("the remaining 200 arrive Monday") into its current value. */
  mergePartial?(key: string, current: unknown, update: unknown): unknown | null;
  /** Deterministic checks over active claims. */
  runChecks(task: TaskSpec, active: Claim[]): CheckResult[];
  /** The terms each party is expected to supply (drives "missing information"). */
  expectedTerms?(task: TaskSpec): { party: Participant; keys: string[] }[];
  /** The term that records a decision of ours (acceptance, approval). */
  decisionKey: string | null;
  /** Term-key prefixes a withdrawal retracts (default: every offer term of the speaker). Withdrawing an
   *  early-payment offer does not withdraw the invoice it was made on. */
  withdrawable?: string[];
  /** What an open loop is about, in the domain's own loop vocabulary (null: its term or document). */
  loopSubject?(o: Obligation): string | null;
  /** Outbound phrases that commit us toward a counterparty; the guard holds them back until checks pass. */
  bindingPatterns: RegExp[];
  /** Domain-specific next actions (accept, request approval, replace a withdrawn offer, ...). */
  extraActions?(ctx: ActionContext): SuggestedAction[];
  /** Offline extractor hooks: per-text state, per-sentence patterns, end-of-text flush. */
  heuristic?: {
    begin(): unknown;
    sentence(s: HeuristicSentence, state: unknown): void;
    end(state: unknown, emit: HeuristicSentence['claim']): void;
  };
  /** The quantity a commitment promises ("deliver all 500"). */
  quantityOf?(text: string): number | null;
  /** When a commitment is due, by domain rules (e.g. its delivery date). */
  dueOf?(text: string, refIso: string): string | null;
  /** Domain document kinds, checked before the generic ones (quote, invoice, po, ...). */
  documentKinds?: DocumentKind[];
  /** A request for one of documentKinds opens a loop even when it names no term ("Please send the contract."). */
  trackDocumentRequests?: boolean;
  /** The offline policy agent's wording for this domain; without it the procurement wording is used. */
  writer?: PolicyWriter;
}

const registry = new Map<string, DomainPack>();

export function registerDomain(pack: DomainPack): void {
  registry.set(pack.id, pack);
}

export function domainFor(taskOrId: TaskSpec | string): DomainPack {
  const id = typeof taskOrId === 'string' ? taskOrId : taskOrId.domain;
  const pack = registry.get(id);
  if (!pack) throw new Error(`unknown domain pack "${id}" (registered: ${[...registry.keys()].join(', ')})`);
  return pack;
}

export function registeredDomains(): string[] {
  return [...registry.keys()];
}

// ------------------------------------------------------------------ helpers shared by packs

export function termKeys(pack: DomainPack): Set<string> {
  return new Set(pack.terms.map((t) => t.key));
}

export function termOf(pack: DomainPack, key: string): TermDef | undefined {
  return pack.terms.find((t) => t.key === key);
}

/** The pack's term keys a sentence talks about. */
export function topicKeysFor(pack: DomainPack, text: string): string[] {
  const lower = text.toLowerCase();
  return pack.terms.filter((t) => t.topics.some((word) => lower.includes(word))).map((t) => t.key);
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Where a task stands: accepted (our decision is on record), fell_through (we withdrew, or every
 * counterparty withdrew its offer) or open. Shared by Signal and the portfolio.
 */
export function outcomeOf(pack: DomainPack, task: TaskSpec, active: Claim[]): 'accepted' | 'fell_through' | 'open' {
  const self = task.self_address.toLowerCase();
  const lifecycle = new Set(pack.terms.filter((t) => t.lifecycle).map((t) => t.key));
  const ended = new Set(active.filter((c) => lifecycle.has(c.key)).map((c) => c.speaker));
  const counterparties = task.participants.filter((p) => p.role === 'counterparty').map((p) => p.address.toLowerCase());
  if (ended.has(self) || (counterparties.length > 0 && counterparties.every((a) => ended.has(a)))) return 'fell_through';
  if (pack.decisionKey && active.some((c) => c.key === pack.decisionKey && c.speaker === self && c.value !== 'declined')) return 'accepted';
  return 'open';
}

/** The pack's document kind for an attachment, or null (the extractor then falls back to the generic kinds). */
export function documentKindOf(pack: DomainPack | undefined, filename: string, text: string): string | null {
  const hay = `${filename}\n${text.slice(0, 2000)}`;
  return pack?.documentKinds?.find((d) => d.match.test(hay))?.kind ?? null;
}

/** The pack's document kind a promise or request is about (the one named first), or null. */
export function promisedDocumentOf(pack: DomainPack | undefined, text: string): string | null {
  let best: { kind: string; at: number } | null = null;
  for (const d of pack?.documentKinds ?? []) {
    const m = text.match(d.promise);
    if (m && (best === null || m.index! < best.at)) best = { kind: d.kind, at: m.index! };
  }
  return best?.kind ?? null;
}
