// The data model. Communication events are immutable evidence. Everything derived from them
// (claims, obligations, document status, checks) is a projection that the resolver may revise.

export type Direction = 'inbound' | 'outbound';
export type PartyRole = 'self' | 'counterparty' | 'internal';

export interface Participant {
  address: string;
  name: string;
  role: PartyRole;
  /** Short name used in briefings ("supplier", "finance"). */
  label: string;
  /** Term-key prefixes this party may set, e.g. ["price.", "delivery."]. */
  authority: string[];
  /** Parties sharing a group talk about the same deal (a supplier and its forwarder). A disagreement
   *  inside a group is "contested" and never silently supersedes. Defaults to the party's address. */
  group?: string;
}

export interface Requirement {
  key: string; // e.g. requirement.deliver_all_by
  value: unknown;
  display: string;
  hard: boolean;
}

export interface TaskSpec {
  id: string;
  /** The explicit marker people write in mail, e.g. "PO-4817". */
  alias: string;
  goal: string;
  /** What is being bought, as written in correspondence ("AX-200 control boards"). */
  item?: string;
  self_address: string;
  participants: Participant[];
  requirements: Requirement[];
  /** Domain pack id. */
  domain: string;
  /**
   * Who may commit us. "human" (the default, and the safest): every commitment the agent drafts is held
   * for a human approver. "auto_when_clear": a commitment goes out on its own only when every check passes
   * and nothing is in a gray area; otherwise it is held too. Hard limits are never overridable either way.
   */
  approval?: { commitments: 'human' | 'auto_when_clear' };
}

export interface AttachmentMeta {
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  part_index: number;
  /** Raw bytes as base64, when the payload carries them (local simulator) or they were downloaded. */
  content_base64?: string;
  /** Already-extracted text (used when replaying from the store). */
  text?: string;
}

/** A transport-agnostic email, as handed to the engine. */
export interface EventInput {
  source: 'primitive' | 'local-sim';
  dedupe_key: string;
  primitive_event_id?: string | null;
  primitive_email_id?: string | null;
  reply_to_sent_email_id?: string | null;
  thread_id: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  direction: Direction;
  from: string;
  from_name?: string | null;
  to: string[];
  cc: string[];
  subject: string;
  body_text: string;
  occurred_at: string; // ISO
  received_at: string; // ISO
  auth_verdict?: string | null;
  attachments: AttachmentMeta[];
  raw?: unknown;
  /** Set by the caller when the task is already known (our own sends). */
  task_id?: string | null;
  /** With task_id: why the event belongs to it (replay keeps the original reason). */
  link_reason?: string | null;
  /** Import and replay only: keep the original event number so evidence ids stay valid. */
  preserve_seq?: number;
}

export interface StoredEvent extends Omit<EventInput, 'raw'> {
  id: string;
  seq: number;
  task_id: string | null;
  link_reason: string | null;
}

export type ClaimStatus = 'active' | 'superseded' | 'contested' | 'proposed' | 'retracted';
export type ClaimKind = 'offer' | 'requirement' | 'decision' | 'info';

export interface Claim {
  id: string;
  task_id: string;
  key: string;
  value: unknown;
  display: string;
  kind: ClaimKind;
  speaker: string;
  source_event_id: string;
  source_artifact_id: string | null;
  evidence: string;
  status: ClaimStatus;
  superseded_by: string | null;
  supersede_reason: string | null;
  learned_at: string;
  confidence: number;
  extractor: string;
}

export type ObligationKind = 'question' | 'request' | 'commitment';
/** `partially_fulfilled` is still open: part of the quantity arrived, the rest is outstanding. */
export type ObligationStatus = 'open' | 'partially_fulfilled' | 'answered' | 'fulfilled' | 'cancelled' | 'declined';

export function isOpenStatus(status: ObligationStatus): boolean {
  return status === 'open' || status === 'partially_fulfilled';
}

/** What a document must be to fulfil a promise to send it ("the revised quote", "invoice INV-1043"). */
export interface ArtifactMatch {
  /** The promise asks for a new revision: re-sending an earlier document does not count. */
  revision: boolean;
  /** A document reference named in the promise ("Q-2291"); the document has to carry it. */
  reference: string | null;
  /** sha256 of same-kind documents the debtor had already sent when the promise was made. */
  exclude_sha256: string[];
}

/** A promise that only becomes due once something happens ("pay on invoice"). */
export interface ObligationCondition {
  text: string;
  /** `artifact`: met when a document of `artifact_kind` arrives from the creditor. `other`: tracked, met by hand. */
  kind: 'artifact' | 'other';
  artifact_kind: string | null;
}

export interface Obligation {
  id: string;
  task_id: string;
  kind: ObligationKind;
  /** Who owes the answer or action. */
  debtor: string;
  /** Who is owed it. */
  creditor: string;
  text: string;
  topic_keys: string[];
  expects_artifact: string | null;
  status: ObligationStatus;
  source_event_id: string;
  evidence: string;
  resolved_by_event_id: string | null;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
  /** YYYY-MM-DD when the text names a deadline ("by tomorrow", "by Friday"). */
  due_at: string | null;
  confidence: number;
  notes: string[];
  /** A compound question becomes one obligation per issue; the siblings share `group_id`. */
  issue_key?: string | null;
  group_id?: string | null;
  /** Commitments with a quantity ("deliver all 500") track partial fulfilment. */
  quantity?: number | null;
  fulfilled_quantity?: number | null;
  artifact_match?: ArtifactMatch | null;
  condition?: ObligationCondition | null;
  condition_met_at?: string | null;
}

export type ArtifactStatus = 'current' | 'partially_stale' | 'superseded' | 'withdrawn';

export interface Artifact {
  id: string;
  task_id: string;
  event_id: string;
  filename: string;
  content_type: string;
  sha256: string;
  size_bytes: number;
  kind: string;
  version_label: string | null;
  text: string;
  status: ArtifactStatus;
  superseded_by: string | null;
  owner: string;
}

export interface Transition {
  seq: number;
  task_id: string;
  event_id: string | null;
  at: string;
  type: string;
  subject_id: string | null;
  summary: string;
  detail: Record<string, unknown>;
}

export interface CheckResult {
  /** Stable id, e.g. "delivery_deadline:supplier@x". */
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'unknown';
  detail: string;
  party: string | null;
  /** Claim ids the result was computed from. */
  evidence: string[];
  requirement_key: string;
}
