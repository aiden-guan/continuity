// The domain boundary. The engine (resolver, compiler, guard, extractors) is generic over evidence,
// claims, obligations and documents. A pack supplies what is specific to one kind of work:
//  - vocabulary: the typed terms that can be claimed, and how their values are validated and shown
//  - checks: pure functions from active claims to pass / fail / unknown results
//  - action prerequisites: which outbound phrases are binding, and what state must hold before them
//  - optionally, sentence patterns for the offline extractor (the LLM extractor reads the vocabulary)
import type { CheckResult, Claim, Obligation, Participant, TaskSpec } from '../types.ts';
import type { ProposedClaim, ProposedFulfillment, ProposedObligation } from '../extract/types.ts';

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
}

/** A kind of business document the pack recognises (attachments, and promises/requests to send one). */
export interface DocumentKind {
  kind: string;
  /** Matches the filename or the first lines of the document's text. */
  match: RegExp;
  /** Matches a sentence that talks about sending this kind of document ("I'll send the corrected rate con"). */
  mention: RegExp;
}

/** One sentence of message or document text, as the offline extractor sees it. */
export interface HeuristicSentence {
  text: string;
  isQuestion: boolean;
  hedged: boolean;
  senderRole: 'self' | 'counterparty' | 'internal' | 'unknown';
  /** Term-key prefixes the sender may set (empty for unknown senders). */
  senderAuthority: string[];
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
  openDebtors: { debtor: string; creditor: string; topic_keys: string[] }[];
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
  /** Term-key prefixes trusted only from an authenticated participant (payment and bank details): from
   *  anyone else, or from mail that fails sender authentication, they stay tentative. */
  verifiedSenderOnly?: string[];
  /** Term-key prefixes a withdrawal retracts (default: every offer term of the speaker). Withdrawing an
   *  early-payment offer does not withdraw the invoice it was made on. */
  withdrawable?: string[];
  /** Business documents this domain exchanges, checked in order before the generic kinds. */
  documents?: DocumentKind[];
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
