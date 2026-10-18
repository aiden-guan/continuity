// The contract between interpretation (a model or rules) and state management (the resolver).
// Extractors only *propose*; the resolver decides what actually changes.
import type { Claim, ClaimKind, Obligation, ObligationKind, StoredEvent, TaskSpec } from '../types.ts';

export interface ProposedClaim {
  key: string;
  value: unknown;
  kind: ClaimKind;
  /** assert: a plain statement. correction: the speaker revises an earlier statement. retraction: withdraws it. */
  mode: 'assert' | 'correction' | 'retraction';
  /** Verbatim quote. */
  evidence: string;
  /** 0..1 */
  confidence: number;
  hedged: boolean;
  /** Filename when the claim comes from an attachment. */
  from_attachment: string | null;
  /** delivery.schedule only: these lots update part of the existing schedule ("the remaining 200 …"). */
  partial?: boolean;
}

export interface ProposedObligation {
  kind: ObligationKind;
  /** Who owes: the sender of this message, or its (first) recipient. */
  debtor: 'sender' | 'recipient';
  text: string;
  topic_keys: string[];
  /** e.g. "quote" when the promise is to send a document. */
  expects_artifact: string | null;
  /** YYYY-MM-DD when the text states a deadline; the resolver also derives one from the text. */
  due?: string | null;
  evidence: string;
  confidence: number;
}

export interface ProposedResolution {
  obligation_id: string;
  resolution: 'answered' | 'fulfilled' | 'cancelled' | 'declined';
  evidence: string;
  confidence: number;
}

/** Evidence that (part of) a promised quantity was delivered: "300 have been delivered". */
export interface ProposedFulfillment {
  /** The open commitment this counts against, when the extractor can tell; otherwise the resolver matches by debtor and term. */
  obligation_id: string | null;
  quantity: number | null;
  /** The term the delivered quantity counts against (e.g. delivery.schedule). */
  term_key: string | null;
  evidence: string;
  confidence: number;
}

export interface ProposedArtifact {
  filename: string;
  /** quote | invoice | po | document | … */
  kind: string;
  version_label: string | null;
}

export interface Proposal {
  claims: ProposedClaim[];
  obligations: ProposedObligation[];
  resolutions: ProposedResolution[];
  artifacts: ProposedArtifact[];
  injection_flags: { evidence: string }[];
  /** Missing from proposals saved by earlier versions. */
  fulfillments?: ProposedFulfillment[];
  /** Provenance of the interpretation itself (model, provider-reported token usage). */
  meta?: { model?: string; usage?: unknown };
}

export interface ExtractInput {
  task: TaskSpec;
  event: StoredEvent;
  attachments: { filename: string; content_type: string; text: string }[];
  senderRole: 'self' | 'counterparty' | 'internal' | 'unknown';
  openObligations: Obligation[];
  activeClaims: Claim[];
  /** Every quote supporting each active claim (a term stated in an email and again in a document has both). */
  claimQuotes?: Record<string, string[]>;
}

export interface Extractor {
  name: string;
  /** Changes whenever the way this extractor reads mail changes (prompt, schema, settings): caches of its output key on it. */
  fingerprint?: string;
  /** `signal` aborts when the engine's deadline passes; extractors doing I/O should pass it on. */
  extract(input: ExtractInput, opts?: { signal?: AbortSignal }): Promise<Proposal>;
}

export function emptyProposal(): Proposal {
  return { claims: [], obligations: [], resolutions: [], artifacts: [], injection_flags: [], fulfillments: [] };
}
