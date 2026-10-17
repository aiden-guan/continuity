// The benchmark's data model. Everything here is independent of the Continuity engine: a case is a
// mailbox history plus an oracle written by the scenario generator from its own parameters. Nothing
// in bench/verticals may import from src/engine, src/extract, src/compiler or src/domain (enforced by
// test/bench-leakage.test.ts), so the labels can never be produced by the code under test.

// ------------------------------------------------------------------ vertical vocabulary

/** Value types the scorer knows how to normalise and compare. */
export type ValueType =
  | 'money' // 11.4 (USD)
  | 'number' // 500
  | 'percent' // 80 (meaning 80%)
  | 'date' // "2026-10-23"
  | 'datetime' // "2026-10-23T14:00" (local time of the deal; no zone)
  | 'window' // {"start":"2026-10-23T08:00","end":"2026-10-23T12:00"}
  | 'lots' // [{"qty":300,"date":"2026-10-23"}]  (procurement deliveries, hotel nightly room blocks)
  | 'text' // "Net 30"  (compared case/space-insensitively)
  | 'enum'; // one of `values`

export interface VerticalTerm {
  key: string;
  type: ValueType;
  description: string;
  values?: string[];
  /** Which participant roles may set it ("counterparty", "internal"). Informational for actors. */
  setBy: string[];
}

/** Things an open loop can be about besides a term: documents, deliveries, approvals. */
export interface LoopSubject { key: string; description: string }

export interface VerticalSpec {
  id: 'procurement' | 'freight' | 'hotel' | 'finance' | 'legal';
  name: string;
  /** One sentence for the actor's system prompt: who the agent is. */
  agentRole: string;
  terms: VerticalTerm[];
  /** Non-term subjects of open loops, e.g. "document.quote", "delivery.remaining_units". */
  loopSubjects: LoopSubject[];
  /** The Continuity domain-pack id this vertical maps to, or null if no pack exists yet. */
  continuityDomain: string | null;
  /** Outbound phrases that bind us toward a counterparty (scored deterministically). */
  bindingPatterns: RegExp[];
}

// ------------------------------------------------------------------ parties and task

export interface BenchParty {
  address: string;
  name: string;
  role: 'self' | 'counterparty' | 'internal';
  label: string;
  /** Term-key prefixes this party may set. */
  authority: string[];
  /** Parties in one group talk about the same deal (supplier + its forwarder); disagreements are contradictions. */
  group?: string;
}

export interface BenchRequirement { key: string; value: unknown; display: string; hard: boolean }

export interface BenchTask {
  id: string;
  alias: string;
  goal: string;
  item?: string;
  self_address: string;
  parties: BenchParty[];
  requirements: BenchRequirement[];
}

// ------------------------------------------------------------------ mail

export interface BenchAttachment {
  filename: string;
  content_type: 'application/pdf' | 'text/plain';
  /** Text lines; PDFs are rendered with a real text layer. */
  lines: string[];
}

export interface BenchEvent {
  /** Stable key used by the oracle: "e1", "e2", … (background mail: "b1", …). */
  key: string;
  direction: 'inbound' | 'outbound';
  from: string;
  fromName: string;
  to: string[];
  cc?: string[];
  subject: string;
  /** Body as the author wrote it. Quoted reply history is added by the materialiser, like a mail client. */
  body: string;
  /** ISO timestamp, UTC. */
  at: string;
  /** Key of the message this replies to (threading, In-Reply-To/References). */
  replyTo?: string | null;
  /** Quote the parent message below the reply (default true for replies). */
  quoteParent?: boolean;
  attachments?: BenchAttachment[];
  /** True for mail that does not belong to the task (promos, other deals). Ground truth for linkage. */
  background?: boolean;
  /** Sender authentication as Primitive would report it; spoofed mail fails DMARC. */
  auth?: 'pass' | 'fail';
  /** Free-text note for auditors explaining why this event exists. Never shown to systems under test. */
  note?: string;
}

// ------------------------------------------------------------------ oracle

export type TermStatus = 'current' | 'contested' | 'absent';

export interface OracleTerm {
  /** Address of the party whose statement this is. Terms are keyed by (party, term). */
  party: string;
  term: string;
  status: TermStatus;
  /** current: the value. contested: unused (see `contested`). absent: unused. */
  value?: unknown;
  /** contested: every competing value (by its own speaker), all of which must survive as contested. */
  contested?: { party: string; value: unknown; evidence: string[] }[];
  /** Event keys allowed as evidence for this value (an attachment counts as the event that carried it). */
  evidence: string[];
  /** A critical item must be right for cold-handoff success. */
  critical?: boolean;
  /** Human-readable, for reports and the judge. */
  display: string;
}

export interface OracleSuperseded {
  party: string;
  term: string;
  value: unknown;
  display: string;
  evidence: string[];
  superseded_by: string; // event key
}

export type LoopKind = 'ask' | 'commitment'; // ask = question or request

export interface OracleLoop {
  kind: LoopKind;
  debtor: string;
  /** A term key or a vertical loop subject. */
  subject: string;
  /** Other subjects a correct report may use for the same loop (e.g. "approval.budget" for "budget.max_unit_price"). */
  alt_subjects?: string[];
  /** Other parties a correct report may name as debtor (e.g. the supplier's ops desk that reported the delay). */
  alt_debtors?: string[];
  display: string;
  evidence: string[];
  critical?: boolean;
  /** Partial fulfilment: what is still owed. */
  residual?: { qty: number; display: string };
}

export type ConflictKind =
  | 'requirement_violation' // a current term breaks a hard requirement
  | 'contradiction' // two parties of one group disagree; nothing supersedes
  | 'offer_unavailable' // the counterparty withdrew / cannot supply
  | 'unverified_change'; // a sensitive term was "changed" by an unauthenticated / unauthorised sender

export interface OracleConflict { kind: ConflictKind; term: string; party?: string; display: string; critical?: boolean }

export type DocStatus = 'current' | 'partially_stale' | 'superseded' | 'withdrawn';

export interface OracleDocument {
  filename: string;
  status: DocStatus;
  stale_terms: string[];
  /** Terms a careful reader could fairly call stale or not (e.g. payment terms when only the due date moved): either answer is accepted. */
  ambiguous_terms?: string[];
  display: string;
}

export interface OracleState {
  terms: OracleTerm[];
  superseded: OracleSuperseded[];
  open_loops: OracleLoop[];
  /** Loops that existed and are now closed; reporting one as open is a "zombie loop" false positive. */
  closed_loops: OracleLoop[];
  conflicts: OracleConflict[];
  documents: OracleDocument[];
  next_actor: 'us' | 'them';
  /** Safety: content that must be treated as untrusted / unverified. */
  flags?: { kind: 'prompt_injection' | 'unverified_sender'; event: string }[];
}

/** Deterministic checks the scorer can run on a decision without a model. */
export type DetCheck =
  | { type: 'binding_to'; party: string } // condition holds if a message to `party` contains binding language
  | { type: 'message_to'; party: string } // condition holds if any message goes to `party`
  | { type: 'message_to_any'; parties: string[] } // holds if any message goes to one of `parties`
  | { type: 'pattern'; party?: string; pattern: string; flags?: string } // regex over message bodies (optionally to one party)
  | { type: 'action'; action: 'send' | 'wait' }
  | { type: 'outsider' }; // a message goes to an address that is not a task participant

export interface ActionCond {
  id: string;
  /** What a reviewer checks, in plain words (the judge sees this, never the condition name or system name). */
  text: string;
  /** If present, decided by code; the judge is not asked. */
  det?: DetCheck;
  /** Prohibited conditions only: violating it means acting on a superseded / withdrawn fact. */
  stale?: boolean;
  /** Prohibited conditions only: a safety violation (counted separately; zero tolerance). */
  safety?: boolean;
}

export interface ActionPolicy {
  expect: 'send' | 'wait' | 'any';
  required: ActionCond[];
  optional: ActionCond[];
  prohibited: ActionCond[];
}

export interface Checkpoint {
  id: string;
  /** Events up to and including this key are visible. */
  after: string;
  /** Timestamp the agent wakes at. */
  now: string;
  state: OracleState;
  /** Only the final checkpoint of a case carries an action policy. */
  action?: ActionPolicy;
  /** Ground truth in plain language, given to the judge so it can tell e.g. which date is current. */
  judge_facts?: string;
}

// ------------------------------------------------------------------ cases

export type Split = 'golden' | 'dev' | 'eval';

/** Hypotheses each archetype isolates (used to group results). */
export type Capability =
  | 'supersession'
  | 'open_loops'
  | 'document_validity'
  | 'cross_thread'
  | 'partial_fulfilment'
  | 'lifecycle'
  | 'conflict_vs_supersession'
  | 'authority'
  | 'injection'
  | 'late_evidence'
  | 'competing_offers'
  | 'cold_handoff'
  | 'scale' | 'robustness';

export interface BenchCase {
  id: string; // "<vertical>/<archetype>/<variant>"
  vertical: VerticalSpec['id'];
  archetype: string;
  variant: number;
  split: Split;
  capabilities: Capability[];
  description: string;
  task: BenchTask;
  /** Every message in the mailbox, task and background, in chronological order. */
  events: BenchEvent[];
  /** Key of the event that wakes the agent (the newest task event at the final checkpoint). */
  trigger: string;
  checkpoints: Checkpoint[];
  /** Generator parameters, recorded so a reviewer can re-derive the oracle. */
  params: Record<string, unknown>;
  /** Number of extra backlog messages added by the scale transform (0 = none). */
  backlog?: number;
}

/** A scenario family: generates the golden case (variant 0) and any number of controlled variants. */
export interface Archetype {
  id: string;
  title: string;
  capabilities: Capability[];
  /** P0 archetypes are the headline set. */
  priority: 'P0' | 'P1';
  generate(variant: number): BenchCase;
}

// ------------------------------------------------------------------ what every acting agent returns

export interface ReportedTerm { party: string; term: string; value_json: string; status: 'current' | 'contested'; source_ids: string[] }
export interface ReportedLoop { kind: 'question' | 'request' | 'commitment'; owed_by: string; subject: string; description: string; source_ids: string[] }
export interface ReportedConflict { kind: ConflictKind; term: string; description: string }
export interface ReportedDocument { filename: string; status: DocStatus; stale_terms: string[] }
export interface ReportedMessage { to: string; subject: string | null; body: string }

export interface AgentOutput {
  current_terms: ReportedTerm[];
  superseded_terms: { party: string; term: string; value_json: string; source_ids: string[] }[];
  open_loops: ReportedLoop[];
  conflicts: ReportedConflict[];
  documents: ReportedDocument[];
  next_actor: 'us' | 'them';
  decision: { action: 'send' | 'wait'; messages: ReportedMessage[]; rationale: string };
}

// ------------------------------------------------------------------ vertical module contract

/** A state-neutral message for the scale transform: on-task chatter (background=false) or unrelated mail. */
export interface NeutralMail { background: boolean; from: string; fromName: string; subject: string; body: string }

/** What bench/verticals/<id>/index.ts exports. */
export interface VerticalModule {
  vertical: VerticalSpec;
  archetypes: Archetype[];
  /** The i-th neutral message for a case (must not change any oracle state). Random source is seeded per case. */
  neutral(c: BenchCase, i: number, r: import('./util.ts').Rand): NeutralMail;
}
