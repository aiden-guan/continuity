// The application service: every operation the HTTP API exposes, also callable in-process (tests).
// Operations always run inside one organization; the HTTP layer derives it from the authenticated
// principal making the call.
import { createHash, randomUUID } from 'node:crypto';
import { PRIMITIVE_SIGNATURE_HEADER, safeValidateEmailReceivedEvent, verifyWebhookSignature } from '@primitivedotdev/sdk';
import type { ActionRow, Backend, JobRow, Principal, TaskSnapshot } from './store/backend.ts';
import type { MemoryStore } from './store/state.ts';
import { Engine } from './engine/engine.ts';
import type { Extractor } from './extract/types.ts';
import { guardSend, taskBindingPhrases, SEND_INTENTS, type GuardResult, type SendIntent } from './engine/guard.ts';
import { modelBindingPhrases, type SendClassifier } from './engine/send-check.ts';
import { applyVerifiedClaim, buildCard, notifyApproval, optionsFor, rejectHeldClaim, renderCard, approvalLink, sendTitle, type OptionId } from './approvals.ts';
import {
  approvalsForTask, openApprovals, recordDecision, recordExpired, requestApproval, stateFingerprint,
  type Approval, type ApprovalDraft, type ApprovalStatus,
} from './engine/approval-log.ts';
import { compileContext, estimateTokens, artifactSummary, TOKEN_UNIT, type ContextPurpose } from './compiler/compile.ts';
import { renderWithBudget } from './compiler/render.ts';
import { replayTask } from './engine/replay.ts';
import { fromPrimitiveEmailDetail, fromPrimitiveWebhook } from './ingest/normalize.ts';
import { parseSenderAuth, SENDER_AUTH_POLICIES } from './ingest/sender-auth.ts';
import { labelOf } from './engine/resolver.ts';
import { nowIso } from './clock.ts';
import { PermanentSendError, type Transport, type SendOutcome } from './transport/transport.ts';
import { registeredDomains } from './domain/index.ts';
import type { EventInput, Participant, Requirement, TaskSpec } from './types.ts';

/** An error that carries the HTTP status (and optional JSON detail) the API should answer with. */
export class HttpError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export interface SendInput {
  agent_id: string;
  to: string;
  subject?: string;
  body: string;
  reply_to_event?: string | null;
  /** state version of the context the agent based its decision on; if the task moved on, context must be refreshed */
  based_on_version?: number | null;
  /** client retry key; when absent one is derived from (task, agent, version, recipient, body) */
  idempotency_key?: string | null;
  /** what the email is meant to do; "commit" for anything that accepts, confirms, orders or approves payment */
  intent?: SendIntent | null;
}

/** A human's decision on a held approval. */
export interface DecisionInput {
  option?: string;
  /** who decided (logged; defaults to the approver token's label) */
  by?: string;
  note?: string;
  edited_body?: string;
  reply_body?: string;
}

export interface ContextOptions { agentId?: string; party?: string; maxTokens?: number; asOf?: string; purpose?: ContextPurpose; historyLimit?: number }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** provider keys of sends a human approved: continuity:<instance>:<task>:approval:<ap_n>:... */
const APPROVAL_KEY = /:approval:ap_\d+:/;
/** an ambiguous send is retried at most this many attempts before reconciliation gives up */
const RECONCILE_ATTEMPTS = 4;
/** how many times a task note / flag commit is retried on a version race */
const COMMIT_RETRIES = 3;
/** emails whose sender authentication is waiting out a temporary DNS error, remembered at most */
const AUTH_ATTEMPTS_KEPT = 1000;

type Store = MemoryStore;

export class Continuity {
  backend: Backend;
  engine: Engine;
  transport: Transport;
  /** accepted webhook signing secrets (several during a rotation); empty = the webhook route is disabled */
  webhookSecrets: string[];
  /** the agent's own inbox (CONTINUITY_SELF_ADDRESS); when set, tasks must use it */
  selfAddress: string;
  /** hosted mode: every send must say which state version it was decided on */
  requireStateVersion: boolean;
  /** org used for ingress with no principal attached (webhooks): one inbox maps to one org */
  ingestOrg: string;
  /** deliveries (or re-fetches) tried while sender auth reports a temporary DNS error, before storing as unknown */
  authRetries = Math.max(1, Number(process.env.CONTINUITY_AUTH_TEMPERROR_RETRIES || 3));
  /** pause between re-fetches where there is no redelivery (the pull receiver) */
  authRetryDelayMs = Number(process.env.CONTINUITY_AUTH_RETRY_DELAY_MS || 5000);
  /** attempts seen per email, in case a redelivery does not carry an incremented attempt number */
  #authAttempts = new Map<string, number>();

  /** Claude's second opinion on counterparty wording (null: tripwire + declared intent only) */
  sendClassifier: SendClassifier | null;
  /** new approval cards are posted here (Slack-style {"text": ...}); CONTINUITY_APPROVAL_WEBHOOK */
  approvalWebhook: string | undefined;
  /** verification cards already posted by this process */
  #notified = new Set<string>();

  constructor(opts: {
    backend: Backend; extractor: Extractor; transport: Transport; webhookSecret: string | null; selfAddress?: string; requireStateVersion?: boolean; ingestOrg?: string; engine?: Engine;
    sendClassifier?: SendClassifier | null; approvalWebhook?: string;
  }) {
    this.backend = opts.backend;
    this.transport = opts.transport;
    this.webhookSecrets = (opts.webhookSecret ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    this.selfAddress = (opts.selfAddress ?? '').toLowerCase();
    this.requireStateVersion = opts.requireStateVersion ?? false;
    this.ingestOrg = opts.ingestOrg ?? 'org_local';
    this.sendClassifier = opts.sendClassifier ?? null;
    this.approvalWebhook = opts.approvalWebhook ?? process.env.CONTINUITY_APPROVAL_WEBHOOK;
    this.engine = opts.engine ?? new Engine(this.backend, opts.extractor, (ev, i, signal) => this.transport.fetchAttachment(ev, i, signal));
    this.engine.handlers.set('reconcile_action', (job) => this.#reconcileJob(job));
    // verification cards are raised by the resolver while interpreting mail; post the new ones
    this.engine.listeners.add((org, taskId) => {
      if (this.approvalWebhook) void this.#notifyVerifications(org, taskId).catch(() => undefined);
    });
  }

  /** Resolve a task by id or alias, or fail with 404. */
  async task(org: string, id: string): Promise<TaskSpec> {
    const found = await this.backend.getTask(org, id);
    if (!found) throw new HttpError(404, `unknown task ${id}`);
    return found;
  }

  async snapshot(org: string, taskId: string) {
    const task = await this.task(org, taskId);
    const snap = await this.backend.loadTask(org, task.id);
    return { task, snap };
  }

  async createTask(org: string, input: unknown) {
    const spec = validateTaskSpec(input, this.selfAddress);
    const clash = (await this.backend.getTask(org, spec.id)) || (await this.backend.getTask(org, spec.alias));
    if (clash) throw new HttpError(409, `task ${spec.id} exists`);
    // who may commit us: a human approves every commitment unless the task explicitly says otherwise
    if (spec.approval !== undefined && !['human', 'auto_when_clear'].includes(spec.approval?.commitments)) {
      throw new HttpError(400, 'approval.commitments must be "human" or "auto_when_clear"');
    }
    await this.engine.createTask(org, spec, nowIso());
    return spec;
  }

  /**
   * Primitive webhook: check the signature with the SDK (any configured secret, for rotation), validate the
   * schema, normalize, then receive durably. With no secret configured the route is disabled: unsigned
   * mail is never accepted.
   */
  async ingestWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, opts: { org?: string; wait?: boolean } = {}) {
    if (!this.webhookSecrets.length) throw new HttpError(503, 'webhook receiver disabled: set PRIMITIVE_WEBHOOK_SECRET (or use the long-poll receiver, `npm run receive`)');
    const signature = String(headers[PRIMITIVE_SIGNATURE_HEADER.toLowerCase()] ?? headers['primitive-signature'] ?? '');
    let rejection: unknown = null;
    const verified = this.webhookSecrets.some((secret) => {
      try {
        verifyWebhookSignature({ rawBody, signatureHeader: signature, secret });
        return true;
      } catch (err) {
        rejection = err;
        return false;
      }
    });
    if (!verified) throw new HttpError(401, `webhook signature rejected: ${(rejection as Error | null)?.message ?? 'no signature'}`);
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new HttpError(400, 'webhook body is not JSON');
    }
    // the event type comes from the signed body, never from an unsigned header
    const eventType = String(payload.event ?? '');
    if (eventType !== 'email.received') return { ignored: true, event: eventType };
    // schema problems do not reject the mail; they are recorded on the task as a flag
    const validation = safeValidateEmailReceivedEvent(payload) as { success: boolean; error?: { message?: string } };
    const warning = validation.success ? null : validation.error?.message ?? 'payload failed SDK schema validation';
    const org = opts.org ?? this.ingestOrg;
    let input: EventInput;
    try {
      input = fromPrimitiveWebhook(payload);
    } catch (err) {
      // never answer a signed delivery with an error Primitive would retry forever: keep what we can
      input = minimalWebhookEvent(payload, (err as Error).message);
    }
    // DMARC hit a temporary DNS error: ask Primitive to redeliver (it re-evaluates), up to a limit; after
    // that, store the email with an "unknown" sender rather than retrying forever
    const key = `${org}:${payload.email?.id ?? payload.id ?? input.dedupe_key}`;
    const attempt = Math.max(Number(payload.delivery?.attempt) || 1, (this.#authAttempts.get(key) ?? 0) + 1);
    if (!this.settleTransientAuth(input, key, attempt)) {
      throw new HttpError(503, `sender authentication hit a temporary DNS error (attempt ${attempt} of ${this.authRetries}); please redeliver`);
    }
    return this.#receive(org, input, opts.wait ?? false, warning);
  }

  /**
   * false: the sender check hit a transient failure and retries remain (the caller asks for redelivery or
   * re-fetches). Otherwise true; once the retries are used up the verdict stays "unknown" (not retryable)
   * and records how many attempts were made.
   */
  settleTransientAuth(input: EventInput, key: string, attempt: number): boolean {
    const auth = parseSenderAuth(input.auth_verdict);
    if (!auth?.retryable) {
      this.#authAttempts.delete(key);
      return true;
    }
    if (attempt < this.authRetries) {
      this.#authAttempts.delete(key); // re-insert: the map stays ordered oldest first
      this.#authAttempts.set(key, attempt);
      if (this.#authAttempts.size > AUTH_ATTEMPTS_KEPT) this.#authAttempts.delete(this.#authAttempts.keys().next().value!);
      return false;
    }
    this.#authAttempts.delete(key);
    const detail = [...auth.detail, `temporary DNS error persisted after ${attempt} attempt(s); stored as unknown`];
    input.auth_verdict = JSON.stringify({ ...auth, retryable: false, detail });
    return true;
  }

  /**
   * Live receiver path. The caller names a Primitive email id and nothing else: the server fetches the
   * email itself with its own Primitive key, so a caller cannot forge the sender, the auth verdict or
   * the thread, or poison the dedupe key of a real email id.
   */
  async ingestEmailById(org: string, body: unknown, opts: { wait?: boolean } = {}) {
    const id = (body as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new HttpError(400, 'body must be {"id": "<primitive email id>"}');
    if (!this.transport.fetchEmailDetail) throw new HttpError(501, 'this transport cannot fetch emails');
    let detail = await this.transport.fetchEmailDetail(id);
    if (!detail) throw new HttpError(404, `email ${id} not found at Primitive`);
    // no redelivery on this path: re-fetch a few times while DMARC reports a temporary DNS error
    for (let attempt = 1; attempt < this.authRetries && parseSenderAuth(fromPrimitiveEmailDetail(detail).auth_verdict)?.retryable; attempt++) {
      await new Promise((r) => setTimeout(r, this.authRetryDelayMs * attempt));
      detail = (await this.transport.fetchEmailDetail(id)) ?? detail;
    }
    // Primitive's email API is org-wide: only mail to one of our agent inboxes is task communication
    const to = String(detail.to_email ?? detail.recipient ?? '').toLowerCase();
    const inboxes = new Set([this.selfAddress, ...(await this.backend.listTasks(org)).map((t) => t.spec.self_address.toLowerCase())].filter(Boolean));
    if (!inboxes.has(to)) return { ignored: true, reason: `addressed to ${to || '(unknown)'}, not to an agent inbox` };
    const input = fromPrimitiveEmailDetail(detail);
    this.settleTransientAuth(input, `${org}:${id}`, this.authRetries);
    return this.#receive(org, input, opts.wait ?? false, null);
  }

  /** An EmailDetail as Primitive's REST API returns it (GET /v1/emails/{id}), fetched by us, never by a caller. */
  async ingestEmailDetail(org: string, detail: Record<string, unknown>, opts: { wait?: boolean } = {}) {
    return this.#receive(org, fromPrimitiveEmailDetail(detail), opts.wait ?? false, null);
  }

  async #receive(org: string, input: EventInput, wait: boolean, schemaWarning: string | null) {
    const r = await this.engine.receive(org, input);
    const ev = r.event;
    let extractor: string | null = null;
    if (r.linked && (wait || r.requeued)) extractor = await this.engine.settle(org, ev.task_id!, ev.id);
    if (schemaWarning && !r.duplicate && ev.task_id) {
      // the warning is part of task state (a flag), so it is committed like any other change
      const taskId = ev.task_id;
      for (let i = 0; i < COMMIT_RETRIES; i++) {
        const snap = await this.backend.loadTask(org, taskId);
        const c = await this.backend.commit(snap, (s) => s.addFlag(taskId, ev.id, 'schema_warning', schemaWarning, nowIso()));
        if (c.ok) break;
      }
    }
    const interpreted = (await this.backend.extractionsFor(org, ev.id)).length > 0;
    let interpretation: string;
    if (!r.linked) interpretation = 'not_linked';
    else if (interpreted) interpretation = 'done';
    else interpretation = 'queued';
    return {
      event_id: ev.id, task_id: ev.task_id, duplicate: r.duplicate, linked: r.linked, link_reason: ev.link_reason,
      interpretation, extractor, requeued: r.requeued,
    };
  }

  // ------------------------------------------------------------------ outbound actions
  /**
   * An agent's send: guarded, threaded and checked against the state version it was decided on.
   *  1. refuse while state is incomplete (interpretation pending or failed) or stale (based_on_version)
   *  2. run the guard against state, with the declared intent. block (409): a hard limit (recipients,
   *     credentials, a commitment while a requirement fails) — nothing is sent. hold (202): a human
   *     decides (commitments, money details, gray areas) — the draft waits as an approval card.
   *  3. persist a durable pending action carrying a stable provider idempotency key
   *  4. try delivery, record the outbound event, and reconcile ambiguous failures under the same key
   */
  async send(org: string, taskId: string, s: SendInput, principal?: Principal | null) {
    if (s.intent != null && !SEND_INTENTS.includes(s.intent)) throw new HttpError(400, `intent must be one of ${SEND_INTENTS.join(', ')}`, { code: 'bad_intent' });
    const { task, snap } = await this.snapshot(org, taskId);
    const store = snap.store;
    const to = s.to.toLowerCase();

    // the provider key names *this decision*: the same agent, the same state it saw, the same message
    const instance = await this.backend.instanceId(org);
    const decidedOn = s.based_on_version ?? snap.version;
    const contentHash = sha256(`${s.subject ?? ''}\n${s.body}`).slice(0, 16);
    const key = s.idempotency_key || `continuity:${instance}:${task.id}:${s.agent_id}:v${decidedOn}:${to}:${contentHash}`;

    const existing = await this.backend.getActionByKey(org, key);
    if (existing) {
      if (existing.status === 'delivered' || existing.status === 'replayed') return { ...this.#sendResult(existing, task), idempotent_replay: true };
      if (existing.status === 'failed') throw new HttpError(409, `this send already failed: ${existing.last_error}`, { code: 'action_failed', action_id: existing.id });
      // still pending/attempted: same decision under the same key, so retrying is safe
      return this.#attempt(org, task, existing);
    }

    this.#assertComplete(store, task, snap.version);
    this.#assertFresh(store, task, s, snap.version);

    const guard = await this.#guard(task, store, to, s.body, s.intent ?? null);
    if (guard.outcome === 'block') {
      const summary = `Blocked send from ${s.agent_id} to ${labelOf(task, to)}: ${guard.reasons.join('; ')}`;
      await this.backend.commit(snap, (w) => w.addTransition({ task_id: task.id, event_id: null, at: nowIso(), type: 'send_blocked', subject_id: null, summary, detail: { body: s.body, intent: s.intent ?? null } })).catch(() => undefined);
      throw new HttpError(409, 'send blocked by guard', { ...guard, code: 'blocked_by_guard' });
    }
    if (guard.outcome === 'hold') return this.#hold(org, task, snap, s, to, guard);

    const row = this.#actionRow(org, task, store, snap.version, { ...s, to }, key, principal?.id ?? null);
    const c = await this.backend.commit(snap, () => undefined, { actions: [row] });
    if (!c.ok) {
      if (c.reason === 'stale') throw new HttpError(409, 'stale context: the task changed while the send was being prepared', { code: 'stale_context', state_version: c.version });
      throw new HttpError(409, c.detail ?? 'another send for this task is in flight — wait for it to settle', { code: 'send_in_flight', state_version: c.version });
    }
    return this.#attempt(org, task, row);
  }

  /** The guard with everything it needs from state, including the model's second opinion where it can matter. */
  async #guard(task: TaskSpec, store: Store, to: string, body: string, intent: SendIntent | null): Promise<GuardResult> {
    const party = task.participants.find((p) => p.address.toLowerCase() === to);
    let modelBinding: string[] = [];
    let modelError: string | null = null;
    // ask the model only where its answer can change the outcome: counterparty mail, not declared a
    // commitment (that goes to a human anyway), and not already caught by the tripwire
    if (this.sendClassifier && party?.role === 'counterparty' && intent !== 'commit' && !taskBindingPhrases(task, body).length) {
      const r = await modelBindingPhrases(this.sendClassifier, body);
      if (r.check.error) modelError = r.check.error;
      else modelBinding = r.phrases;
    }
    return guardSend(task, to, body, store.getChecks(task.id), store.claimsForTask(task.id), intent, { modelBinding, modelError, flags: store.flagsForTask(task.id) });
  }

  /** A held send: the draft becomes an approval card in the task's log (one open card per decision); nothing is sent. */
  async #hold(org: string, task: TaskSpec, snap: TaskSnapshot, s: SendInput, to: string, guard: GuardResult) {
    const at = nowIso();
    const draft: ApprovalDraft = { agent_id: s.agent_id, to, subject: s.subject ?? null, body: s.body, intent: s.intent ?? null, reply_to_event: s.reply_to_event ?? null };
    const c = await this.backend.commit(snap, (w) => {
      recordExpired(w, task.id, at);
      // the same draft, or a second commitment to the same party, returns the card already open
      const open = openApprovals(w, task.id, at).find((a) => a.kind === 'send' && a.draft?.to === to
        && (a.draft.body === s.body || (guard.commitment && a.reasons.some((r) => r.startsWith('commitment')))));
      if (open) return { approval: open, existing: true };
      const id = requestApproval(w, task.id, at, { kind: 'send', title: sendTitle(task, to, guard.hold_reasons), reasons: guard.hold_reasons, gray_areas: guard.gray_areas, draft, claim_id: null });
      return { approval: approvalsForTask(w, task.id, at).find((a) => a.id === id)!, existing: false };
    });
    if (!c.ok) throw new HttpError(409, 'stale context: the task changed while the send was being prepared', { code: 'stale_context', state_version: c.version });
    const { approval, existing } = c.value;
    this.engine.notify(org, task.id);
    if (!existing && this.approvalWebhook) {
      const fresh = await this.backend.loadTask(org, task.id);
      void notifyApproval(this.approvalWebhook, approval, buildCard(fresh.store, task, approval));
    }
    return {
      __status: 202, held: true, status: 'held' as const, action_id: null, event_id: null, idempotent_replay: false,
      approval_id: approval.id, title: approval.title, reasons: approval.reasons, gray_areas: approval.gray_areas,
      expires_at: approval.expires_at, existing, link: approvalLink(task.id, approval.id), state_version: c.version,
    };
  }

  /** A durable outbound action for a draft: threaded under its parent, keyed for the provider. */
  #actionRow(org: string, task: TaskSpec, store: Store, version: number, d: { agent_id: string; to: string; subject?: string | null; body: string; reply_to_event?: string | null }, key: string, principalId: string | null): ActionRow {
    const parent = this.#replyParent(store, task, d.reply_to_event, d.to);
    let subject: string;
    if (d.subject != null) subject = d.subject;
    else if (parent) subject = /^re:/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`;
    else subject = `${task.alias}`;
    const inReplyTo = parent?.message_id ?? null;
    const references = parent ? [...parent.references, ...(parent.message_id ? [parent.message_id] : [])] : [];
    const at = nowIso();
    return {
      id: `act_${randomUUID().slice(0, 12)}`, org, task_id: task.id, agent_id: d.agent_id, principal_id: principalId, idempotency_key: key,
      based_on_version: version, to_addr: d.to, subject, body: d.body, body_sha256: sha256(d.body), in_reply_to: inReplyTo, references,
      status: 'pending', attempts: 0, provider: null, primitive_email_id: null, event_id: null, last_error: null, created_at: at, updated_at: at,
    };
  }

  /** No send while any email of the task is still being interpreted or failed interpretation. */
  #assertComplete(store: Store, task: TaskSpec, version: number) {
    const pending = store.pendingEventIds(task.id);
    const failed = store.failedEventIds(task.id);
    if (pending.length) throw new HttpError(409, 'state incomplete: email still being interpreted — refresh context after it settles', { code: 'state_incomplete', pending_events: pending, state_version: version });
    if (failed.length) throw new HttpError(409, 'state incomplete: an email could not be interpreted — needs operator attention', { code: 'interpretation_failed', failed_events: failed, state_version: version });
  }

  /** Refuse a send decided on a context that something other than this agent's own actions has since changed. */
  #assertFresh(store: Store, task: TaskSpec, s: SendInput, version: number) {
    if (s.based_on_version == null) {
      if (this.requireStateVersion) throw new HttpError(428, 'based_on_version is required: send the state_version of the context you decided on', { code: 'version_required', state_version: version });
      return;
    }
    const basis = Number(s.based_on_version);
    if (basis === version) return;
    // changes produced only by this agent's own sends (earlier steps of the same plan) are already known to it;
    // anything else — new mail, another agent's send, a deadline firing — may make the decision obsolete
    const sentByThisAgent = (eventId: string) => {
      const e = store.getEvent(eventId);
      if (!e || e.direction !== 'outbound') return false;
      return (store.getEventRaw(eventId) as { sent_by_agent?: string } | null)?.sent_by_agent === s.agent_id;
    };
    const isOwn = (t: { event_id: string | null; type: string; summary: string; detail: Record<string, unknown> }) => {
      if (t.event_id) return sentByThisAgent(t.event_id);
      // this agent's own held drafts are known to it, like its blocked ones
      if (t.type === 'approval_requested') return (t.detail as { draft?: { agent_id?: string } | null }).draft?.agent_id === s.agent_id;
      return t.type === 'send_blocked' && String(t.summary).includes(`from ${s.agent_id} `);
    };
    const foreign = store.transitionsForTask(task.id, basis).filter((t) => !isOwn(t));
    if (basis > version || foreign.length) {
      throw new HttpError(409, 'stale context: the task changed since you read it — fetch fresh context and decide again', {
        code: 'stale_context', based_on_version: s.based_on_version, state_version: version,
        changes: foreign.map((t) => ({ seq: t.seq, type: t.type, summary: t.summary })),
      });
    }
  }

  /** The email a send replies to: the one named, else the latest inbound from the recipient, else our latest to them. */
  #replyParent(store: Store, task: TaskSpec, replyToEvent: string | null | undefined, to: string) {
    if (replyToEvent) return store.getEvent(replyToEvent);
    const newestFirst = [...store.eventsForTask(task.id)].reverse();
    return newestFirst.find((e) => e.direction === 'inbound' && e.from === to)
      ?? newestFirst.find((e) => e.direction === 'outbound' && e.to.includes(to))
      ?? null;
  }

  async #attempt(org: string, task: TaskSpec, action: ActionRow) {
    const priorAttempts = action.attempts;
    action = await this.backend.updateAction(org, action.id, { status: 'attempted', attempts: priorAttempts + 1, last_error: null });
    let out: SendOutcome;
    try {
      out = await this.transport.send({ from: task.self_address, to: action.to_addr, subject: action.subject, body: action.body, inReplyTo: action.in_reply_to, references: action.references }, action.idempotency_key);
    } catch (err) {
      const msg = (err as Error).message;
      if (err instanceof PermanentSendError) {
        await this.backend.updateAction(org, action.id, { status: 'failed', last_error: msg });
        await this.#taskNote(org, task, 'send_failed', `Send to ${labelOf(task, action.to_addr)} was rejected by the provider: ${msg}`, { action_id: action.id });
        throw new HttpError(502, `provider rejected the send: ${msg}`, { code: 'send_rejected', action_id: action.id });
      }
      // unknown outcome (timeout, reset connection): the provider may or may not have sent it. Retry later
      // under the same idempotency key — the provider deduplicates, so mail is never doubled.
      await this.backend.updateAction(org, action.id, { status: 'attempted', last_error: msg });
      await this.backend.enqueue(org, [{
        kind: 'reconcile_action', task_id: task.id, dedupe_key: `reconcile:${action.id}:${action.attempts}`, payload: { action_id: action.id },
        run_after: new Date(Date.now() + 1000 * action.attempts).toISOString(), max_attempts: 1,
      }]);
      throw new HttpError(502, `delivery outcome unknown (${msg}); Continuity will reconcile with the same idempotency key`, { code: 'delivery_unknown', action_id: action.id });
    }

    if (out.replayed && priorAttempts === 0) {
      // a replay on our very first attempt means the key was used by some other send: never claim it as ours
      await this.backend.updateAction(org, action.id, { status: 'failed', last_error: `idempotency key collision: provider replayed ${out.primitive_email_id}`, provider: out as never });
      await this.#taskNote(org, task, 'send_failed', `Send to ${labelOf(task, action.to_addr)} was not delivered: Primitive replayed earlier send ${out.primitive_email_id} (idempotency key collision)`, { idempotencyKey: action.idempotency_key });
      throw new HttpError(502, 'Primitive replayed an earlier send for this idempotency key; nothing was sent', { code: 'idempotency_collision', idempotencyKey: action.idempotency_key, replayed_email_id: out.primitive_email_id });
    }

    // either delivered now, or (a replay after an earlier ambiguous attempt) delivered by that attempt
    const status = out.replayed ? 'replayed' : 'delivered';
    action = await this.backend.updateAction(org, action.id, { status, provider: out as never, primitive_email_id: out.primitive_email_id, last_error: null });
    const at = nowIso();
    // a send a human approved records who approved it
    const approval = APPROVAL_KEY.test(action.idempotency_key) ? await this.#approvalOfAction(org, task, action.id) : null;
    const input: EventInput = {
      source: out.mode, dedupe_key: `outbound:${out.primitive_email_id ?? out.message_id ?? action.id}`, primitive_email_id: out.primitive_email_id,
      thread_id: out.thread_id ?? null, message_id: out.message_id, in_reply_to: action.in_reply_to, references: action.references, direction: 'outbound',
      from: task.self_address.toLowerCase(), to: [action.to_addr], cc: [], subject: action.subject, body_text: action.body, occurred_at: at, received_at: at, attachments: [], task_id: task.id,
      raw: { sent_by_agent: action.agent_id, action_id: action.id, transport: out, ...(approval ? { approved_by: approval.decided_by, approval_id: approval.id } : {}) },
    };
    if (!input.thread_id) {
      // provider gave no thread id: inherit the parent's thread when we know the parent
      const parent = action.in_reply_to ? (await this.backend.loadTask(org, task.id)).store.eventByMessageId(action.in_reply_to) : null;
      input.thread_id = parent?.thread_id ?? null;
    }
    const ingested = await this.engine.ingest(org, input);
    action = await this.backend.updateAction(org, action.id, { event_id: ingested.event.id });
    const version = (await this.backend.loadTask(org, task.id)).version;
    return this.#sendResult(action, task, version);
  }

  #sendResult(a: ActionRow, task: TaskSpec, version?: number) {
    return {
      action_id: a.id, status: a.status, event_id: a.event_id, transport: a.provider, subject: a.subject, in_reply_to: a.in_reply_to,
      to: a.to_addr, to_label: labelOf(task, a.to_addr), based_on_version: a.based_on_version, attempts: a.attempts, idempotent_replay: false,
      ...(version != null ? { state_version: version } : {}),
    };
  }

  /** Background reconciliation of an ambiguous send (same idempotency key; gives up once new mail arrives). */
  async #reconcileJob(job: JobRow) {
    const id = String(job.payload.action_id);
    const action = await this.backend.getAction(job.org, id);
    if (!action || action.status !== 'attempted') {
      await this.backend.finishJob(job.id, { status: 'done' });
      return;
    }
    const task = await this.task(job.org, action.task_id);
    const snap = await this.backend.loadTask(job.org, task.id);
    const transitions = snap.store.transitionsForTask(task.id);
    const ingestedAt = (eventId: string) => transitions.find((t) => t.event_id === eventId && t.type === 'event_ingested')?.seq ?? 0;
    const newInbound = snap.store.eventsForTask(task.id).filter((e) => e.direction === 'inbound' && ingestedAt(e.id) > action.based_on_version);
    if (action.attempts >= RECONCILE_ATTEMPTS || newInbound.length) {
      const why = newInbound.length ? `new mail (${newInbound.map((e) => e.id).join(', ')}) arrived since the decision` : `${action.attempts} attempts`;
      await this.backend.updateAction(job.org, id, { status: 'failed', last_error: `delivery unknown; reconciliation stopped: ${why}` });
      await this.#taskNote(job.org, task, 'send_unreconciled', `Send ${id} to ${labelOf(task, action.to_addr)}: delivery could not be confirmed (${why}); check the provider's sent mail before re-sending`, { action_id: id });
      await this.backend.finishJob(job.id, { status: 'done' });
      return;
    }
    await this.backend.finishJob(job.id, { status: 'done' });
    // a further API-level failure is already recorded (and re-enqueued) by #attempt
    await this.#attempt(job.org, task, action).catch((e) => {
      if (!(e instanceof HttpError)) throw e;
    });
  }

  /** Append a task-level transition (no event), retrying on version races, then wake listeners. */
  async #taskNote(org: string, task: TaskSpec, type: string, summary: string, detail: Record<string, unknown>) {
    for (let i = 0; i < COMMIT_RETRIES; i++) {
      const snap = await this.backend.loadTask(org, task.id);
      const r = await this.backend.commit(snap, (s) => s.addTransition({ task_id: task.id, event_id: null, at: nowIso(), type, subject_id: null, summary, detail }));
      if (r.ok) {
        this.engine.notify(org, task.id);
        return;
      }
    }
  }

  // ------------------------------------------------------------------ human approval
  /** Approvals with their cards: open ones (pending, or held to verify), or all with `all`. */
  async approvals(org: string, opts: { taskId?: string; all?: boolean; allowTask?: (taskId: string) => boolean } = {}) {
    const allow = opts.allowTask ?? (() => true);
    const tasks = opts.taskId ? [await this.task(org, opts.taskId)] : (await this.backend.listTasks(org)).map((t) => t.spec);
    const out: ReturnType<Continuity['approvalView']>[] = [];
    for (const task of tasks.filter((t) => allow(t.id))) {
      const snap = await this.backend.loadTask(org, task.id);
      const list = approvalsForTask(snap.store, task.id).filter((a) => opts.all || a.status === 'pending' || a.status === 'held');
      if (!list.length) continue;
      const actions = await this.backend.listActions(org, task.id);
      for (const a of list) out.push(this.approvalView(snap.store, task, a, actions));
    }
    return out;
  }

  async approval(org: string, taskId: string, id: string) {
    const { task, snap } = await this.snapshot(org, taskId);
    const a = approvalsForTask(snap.store, task.id).find((x) => x.id === id);
    if (!a) throw new HttpError(404, `no approval ${id} on task ${task.alias}`);
    return this.approvalView(snap.store, task, a, await this.backend.listActions(org, task.id));
  }

  /** An approval as the API shows it: its record, the card compiled from current state, and the card as text. */
  approvalView(store: Store, task: TaskSpec, a: Approval, actions: ActionRow[]) {
    const card = buildCard(store, task, a);
    const link = approvalLink(task.id, a.id);
    return {
      ...a, task_alias: task.alias,
      // false once the deal changed under a send card: deciding it re-issues a fresh card
      current: a.kind !== 'send' || a.fingerprint === stateFingerprint(store, task.id),
      result_event_id: a.action_id ? actions.find((x) => x.id === a.action_id)?.event_id ?? null : null,
      link, card, text: renderCard(a.id, card, link),
    };
  }

  /**
   * A human's decision on an approval. Refused if the card expired (410), was already decided (409), or
   * the deal changed after it was made (409; a fresh card replaces it, or the draft is now blocked). Hard
   * limits are re-checked before anything is sent, also on the human's own edits. Every decision is a
   * logged transition: who, which option, when; an approved send carries approved_by.
   */
  async decide(org: string, taskId: string, approvalId: string, d: DecisionInput, principal?: Principal | null) {
    const { task, snap } = await this.snapshot(org, taskId);
    const store = snap.store;
    const at = nowIso();
    const a = approvalsForTask(store, task.id, at).find((x) => x.id === approvalId);
    if (!a) throw new HttpError(404, `no approval ${approvalId} on task ${task.alias}`);
    if (a.status === 'expired') {
      if (!a.decided_at) await this.backend.commit(snap, (w) => recordExpired(w, task.id, at)).then((c) => c.ok && this.engine.notify(org, task.id));
      throw new HttpError(410, `approval ${a.id} expired at ${a.expires_at}`, { code: 'approval_expired' });
    }
    if (a.status !== 'pending' && a.status !== 'held') throw new HttpError(409, `approval ${a.id} was already decided (${a.status})`, { code: 'approval_decided', status: a.status });
    const option = String(d.option ?? '') as OptionId;
    const options = optionsFor(a.kind);
    if (!options.some((o) => o.id === option)) throw new HttpError(400, `option must be one of: ${options.map((o) => o.id).join(', ')}`, { code: 'bad_option' });

    const by = `approver:${String(d.by || principal?.label || principal?.id || 'unnamed').slice(0, 80)}`;
    const extras = {
      ...(d.note ? { note: String(d.note).slice(0, 500) } : {}),
      ...(d.edited_body ? { edited_body: String(d.edited_body) } : {}),
      ...(d.reply_body ? { reply_body: String(d.reply_body) } : {}),
    };
    const decision = (status: ApprovalStatus, extra: Record<string, unknown> = {}) => ({ approval_id: a.id, status, option, by, ...extras, ...extra });
    const commit = async <T>(mutate: (w: Store) => T, opts?: Parameters<Backend['commit']>[2]) => {
      const c = await this.backend.commit(snap, mutate, opts);
      if (!c.ok) {
        if (c.reason === 'stale') throw new HttpError(409, 'the task changed while deciding — reload the card and decide again', { code: 'stale_context', state_version: c.version });
        throw new HttpError(409, c.detail ?? 'another send for this task is in flight — wait for it to settle', { code: 'send_in_flight', state_version: c.version });
      }
      this.engine.notify(org, task.id);
      return c.value;
    };
    const to = a.draft ? labelOf(task, a.draft.to) : null;

    // never decide on a stale picture: the facts changed under the card
    const acts = option === 'approve' || option === 'approve_with_edits' || option === 'reject_with_reply' || option === 'verified';
    if (acts && a.kind === 'send' && a.draft && a.fingerprint !== stateFingerprint(store, task.id)) {
      const g = await this.#guard(task, store, a.draft.to, a.draft.body, (a.draft.intent as SendIntent | null) ?? null);
      const fresh = await commit((w) => {
        recordDecision(w, task.id, at, decision('stale', { by: 'system: state changed' }), `${a.id} not decided: the deal changed since the card was made`);
        if (g.outcome === 'block') {
          w.addTransition({ task_id: task.id, event_id: null, at, type: 'send_blocked', subject_id: a.id, summary: `Held draft ${a.id} to ${to} is now blocked: ${g.reasons.join('; ')}`, detail: { body: a.draft!.body, intent: a.draft!.intent } });
          return null;
        }
        const reasons = g.hold_reasons.length ? g.hold_reasons : ['re-issued: the deal changed since the earlier card'];
        return requestApproval(w, task.id, at, { kind: 'send', title: sendTitle(task, a.draft!.to, reasons), reasons, gray_areas: g.gray_areas, draft: a.draft, claim_id: null, replaces: a.id });
      });
      const why = fresh ? `review the new card ${fresh}` : 'the draft is now blocked by a hard limit';
      throw new HttpError(409, `the deal changed since this card was made; ${why}`, { code: 'approval_stale', stale: true, new_approval_id: fresh, reasons: g.reasons });
    }
    if (acts && a.kind === 'verify_change') {
      // a later change to the same detail from the same party replaces this one
      const claim = store.getClaim(a.claim_id!)!;
      const newer = openApprovals(store, task.id, at).find((x) => x.kind === 'verify_change' && x.requested_seq > a.requested_seq
        && store.getClaim(x.claim_id!)?.key === claim.key && store.getClaim(x.claim_id!)?.speaker === claim.speaker);
      if (newer) {
        await commit((w) => recordDecision(w, task.id, at, decision('stale', { by: 'system: superseded', new_approval_id: newer.id }), `${a.id} not decided: ${labelOf(task, claim.speaker)} sent a newer ${claim.key} (${newer.id})`));
        throw new HttpError(409, `a newer change replaced this one; review ${newer.id}`, { code: 'approval_stale', stale: true, new_approval_id: newer.id });
      }
    }

    switch (option) {
      case 'approve':
      case 'approve_with_edits':
      case 'reject_with_reply': {
        const draft = a.draft!;
        const field = option === 'approve_with_edits' ? 'edited_body' : 'reply_body';
        const body = option === 'approve' ? draft.body : d[field];
        if (!body?.trim()) throw new HttpError(400, `${field} is required`, { code: 'bad_decision' });
        const intent: SendIntent | null = option === 'reject_with_reply' ? 'negotiate' : (draft.intent as SendIntent | null) ?? null;
        // a human approves what a hold asks about; hard limits still apply, to the human's own words too
        const g = await this.#guard(task, store, draft.to, body, intent);
        if (g.outcome === 'block') throw new HttpError(409, 'still blocked by a hard limit — nothing was sent', { ...g, code: 'blocked_by_guard' });
        if (option === 'reject_with_reply' && g.commitment) {
          throw new HttpError(409, 'a reply sent instead of the draft must not commit us; approve the draft (or an edit) for that', { ...g, code: 'reply_commits' });
        }
        const status: ApprovalStatus = option === 'approve' ? 'approved' : option === 'approve_with_edits' ? 'edited' : 'replied';
        const instance = await this.backend.instanceId(org);
        const key = `continuity:${instance}:${task.id}:approval:${a.id}:${option}:${sha256(body).slice(0, 16)}`;
        const row = this.#actionRow(org, task, store, snap.version, { ...draft, body }, key, principal?.id ?? null);
        const summary = {
          approved: `approved and sent the draft to ${to}`, edited: `approved with edits and sent to ${to}`, replied: `rejected the draft and sent a reply to ${to} instead`,
        }[status as 'approved' | 'edited' | 'replied'];
        await commit((w) => recordDecision(w, task.id, at, decision(status, { action_id: row.id }), `${by} decided ${a.id}: ${summary}`), { actions: [row] });
        return { approval_id: a.id, status, sent: await this.#attempt(org, task, row) };
      }
      case 'reject':
        await commit((w) => {
          if (a.kind === 'verify_change') rejectHeldClaim(w, task, a.claim_id!, by, at);
          recordDecision(w, task.id, at, decision('rejected'), `${by} decided ${a.id}: ${a.kind === 'send' ? 'rejected the draft; nothing sent' : 'rejected the detail as not genuine'}`);
        });
        return { approval_id: a.id, status: 'rejected' };
      case 'hold_verify':
        await commit((w) => recordDecision(w, task.id, at, decision('held'), `${by} decided ${a.id}: holding to verify by phone${d.note ? ` (${String(d.note).slice(0, 120)})` : ''}`));
        return { approval_id: a.id, status: 'held' };
      case 'verified':
        await commit((w) => {
          applyVerifiedClaim(w, task, a.claim_id!, by, at);
          recordDecision(w, task.id, at, decision('verified'), `${by} decided ${a.id}: verified by phone with a number on file; detail applied`);
        });
        return { approval_id: a.id, status: 'verified' };
      case 'take_over':
        await commit((w) => recordDecision(w, task.id, at, decision('taken_over'), `${by} decided ${a.id}: a human took over this decision`));
        return { approval_id: a.id, status: 'taken_over' };
    }
    throw new HttpError(400, 'unknown option');
  }

  /** The approval whose decision created this outbound action (for approved_by on the sent email). */
  async #approvalOfAction(org: string, task: TaskSpec, actionId: string): Promise<Approval | null> {
    const snap = await this.backend.loadTask(org, task.id);
    return approvalsForTask(snap.store, task.id).find((a) => a.action_id === actionId) ?? null;
  }

  /** Post verification cards the resolver raised while interpreting mail (each once per process). */
  async #notifyVerifications(org: string, taskId: string) {
    const { task, snap } = await this.snapshot(org, taskId);
    for (const a of openApprovals(snap.store, task.id)) {
      const key = `${org}\u0000${a.id}`;
      if (a.kind !== 'verify_change' || this.#notified.has(key)) continue;
      this.#notified.add(key);
      await notifyApproval(this.approvalWebhook, a, buildCard(snap.store, task, a));
    }
  }

  // ------------------------------------------------------------------ context
  async context(org: string, taskId: string, opts: ContextOptions = {}) {
    const { task, snap } = await this.snapshot(org, taskId);
    const inflight = (await this.backend.listActions(org, task.id))
      .filter((a) => a.status === 'pending' || a.status === 'attempted')
      .map((a) => ({ id: a.id, to: labelOf(task, a.to_addr), status: a.status }));
    // as_of: rebuild state from the event log up to that event — what we believed at the time
    let store: Store = snap.store;
    const historical = !!opts.asOf;
    if (opts.asOf) {
      const at = store.getEvent(opts.asOf);
      if (!at || at.task_id !== task.id) throw new HttpError(404, `no event ${opts.asOf} in task ${task.alias}`);
      store = await replayTask(snap.store, task.id, { uptoEventId: opts.asOf });
    }
    const context = compileContext(store, task.id, {
      agentId: historical ? undefined : opts.agentId, party: opts.party, purpose: opts.purpose, historyLimit: opts.historyLimit, asOf: opts.asOf ?? null,
      processing: historical ? undefined : { actions_in_flight: inflight },
    });
    const { text: briefing, budget } = renderWithBudget(context, { maxTokens: opts.maxTokens });
    return {
      context, briefing, budget, state_version: context.meta.state_version, processing_complete: context.processing.complete,
      context_digest: sha256(briefing), token_unit: TOKEN_UNIT,
      briefing_tokens: estimateTokens(briefing), json_tokens: estimateTokens(JSON.stringify(context)), transcript_tokens: context.meta.transcript_token_estimate,
    };
  }

  async timeline(org: string, taskId: string) {
    const { task, snap } = await this.snapshot(org, taskId);
    const store = snap.store;
    const transitions = store.transitionsForTask(task.id);
    const events = store.eventsForTask(task.id).map((e) => ({
      ...e,
      from_label: labelOf(task, e.from),
      to_labels: e.to.map((t) => labelOf(task, t)),
      transitions: transitions.filter((t) => t.event_id === e.id && t.type !== 'event_ingested'),
      extractions: store.extractionsFor(e.id).map((x) => x.extractor),
      processing: processingOf(store, e.id),
    }));
    const unlinked = (await this.backend.unlinkedEvents(org)).map((e) => ({ id: e.id, from: e.from, subject: e.subject, at: e.occurred_at }));
    return {
      task,
      threads: store.threadsForTask(task.id),
      events,
      task_transitions: transitions.filter((t) => !t.event_id),
      unlinked,
    };
  }

  async state(org: string, taskId: string) {
    const { task, snap } = await this.snapshot(org, taskId);
    const store = snap.store;
    const actions = (await this.backend.listActions(org, task.id)).map((a) => ({
      id: a.id, agent_id: a.agent_id, to: a.to_addr, status: a.status, attempts: a.attempts, based_on_version: a.based_on_version,
      event_id: a.event_id, last_error: a.last_error, created_at: a.created_at,
    }));
    return {
      task,
      claims: store.claimsForTask(task.id).map((c) => ({ ...c, speaker_label: labelOf(task, c.speaker), sources: store.claimEvidence(c.id) })),
      obligations: store.obligationsForTask(task.id).map((o) => ({ ...o, debtor_label: labelOf(task, o.debtor), creditor_label: labelOf(task, o.creditor) })),
      artifacts: store.artifactsForTask(task.id).map((a) => artifactSummary(store, task, a)),
      checks: store.getChecks(task.id),
      flags: store.flagsForTask(task.id),
      actions,
      pending_events: store.pendingEventIds(task.id),
      state_version: snap.version,
    };
  }

  async openLoops(org: string, taskId: string) {
    const { task, snap } = await this.snapshot(org, taskId);
    const ctx = compileContext(snap.store, task.id);
    return {
      next_actor: ctx.next_actor, reason: ctx.next_actor_reason, waiting_on_them: ctx.waiting_on_them, we_owe: ctx.we_owe,
      conflicts: ctx.conflicts, already_answered: ctx.already_answered_do_not_reask, state_version: ctx.meta.state_version,
    };
  }

  async changes(org: string, taskId: string, since: number) {
    const { task, snap } = await this.snapshot(org, taskId);
    return { since, state_version: snap.version, changes: snap.store.transitionsForTask(task.id, since) };
  }

  /** "Why does the system believe X?" — the whole history of one term, with its evidence. */
  async explain(org: string, taskId: string, term: string) {
    const { task, snap } = await this.snapshot(org, taskId);
    const store = snap.store;
    const chain = store.claimsForTask(task.id).filter((c) => c.key === term).map((c) => ({
      claim_id: c.id, speaker: labelOf(task, c.speaker), value: c.display, status: c.status, reason: c.supersede_reason, superseded_by: c.superseded_by,
      confidence: c.confidence, extractor: c.extractor, learned_at: c.learned_at,
      evidence: store.claimEvidence(c.id).map((e) => ({ ...e, event: this.#eventBrief(store, e.event_id), artifact: e.artifact_id ? store.getArtifact(e.artifact_id)?.filename : null })),
    }));
    type Link = (typeof chain)[number];
    const withStatus = (status: string) => chain.filter((c) => c.status === status);
    const plainList = (links: Link[]) => links.map((c) => `${c.speaker} ${c.value} (${c.reason})`).join('; ');
    const withdrawn = withStatus('retracted');
    const withdrawnNote = withdrawn.length ? ` Withdrawn: ${plainList(withdrawn)}.` : '';

    const current = chain.filter((c) => c.status === 'active' || c.status === 'contested');
    let explanation: string;
    if (current.length) {
      const sources = (c: Link) => c.evidence.map((e) => e.event_id + (e.artifact ? ` / ${e.artifact}` : '')).join(', ');
      explanation = current.map((c) => `${c.speaker} currently says ${c.value} (${c.claim_id}), stated in ${sources(c)}.`).join(' ');
      const superseded = withStatus('superseded');
      if (superseded.length) {
        explanation += ` History: ${superseded.map((c) => `${c.speaker} said ${c.value} [${c.claim_id}, ${c.evidence.map((e) => e.event_id).join('/')}] — superseded: ${c.reason}`).join('; ')}.`;
      }
      explanation += withdrawnNote;
      const proposed = withStatus('proposed');
      if (proposed.length) explanation += ` Not applied: ${plainList(proposed)}.`;
    } else {
      explanation = `No current value for ${term}.${withdrawnNote}`;
    }
    return {
      term,
      current: current.map((c) => `${c.speaker}: ${c.value} (${c.status})`),
      explanation,
      chain,
    };
  }

  /** Provenance for one item id; it must belong to the caller's org (and to a task the caller may see). */
  async provenance(org: string, itemId: string, allowTask: (taskId: string) => boolean = () => true) {
    const prefix = itemId.split('_')[0];
    if (!['cl', 'ob', 'ar', 'ev'].includes(prefix)) throw new HttpError(400, 'unknown item id prefix');
    const taskId = await this.backend.findItemTask(org, itemId);

    if (prefix === 'ev' && !taskId) {
      // an unlinked event: only principals not restricted to tasks may see it
      const e = await this.backend.getEvent(org, itemId);
      if (!e) throw new HttpError(404, 'no such event');
      if (!allowTask('')) throw new HttpError(404, 'no such event');
      return { type: 'event', item: e, raw: await this.backend.getEventRaw(org, itemId), extractions: [] };
    }
    if (!taskId || !allowTask(taskId)) throw new HttpError(404, `no such item ${itemId}`);

    const { task, snap } = await this.snapshot(org, taskId);
    const store = snap.store;
    switch (prefix) {
      case 'cl': {
        const c = store.getClaim(itemId)!;
        const supersedes = store.claimsForTask(c.task_id).filter((x) => x.superseded_by === c.id).map((x) => x.id);
        return {
          type: 'claim', item: c, speaker: labelOf(task, c.speaker),
          evidence: store.claimEvidence(c.id).map((e) => ({ ...e, event: this.#eventBrief(store, e.event_id) })),
          supersedes, superseded_by: c.superseded_by ? store.getClaim(c.superseded_by) : null, extraction: store.extractionsFor(c.source_event_id),
        };
      }
      case 'ob': {
        const o = store.getObligation(itemId)!;
        const siblings = o.group_id
          ? store.obligationsForTask(task.id).filter((x) => x.group_id === o.group_id && x.id !== o.id).map((x) => ({ id: x.id, issue: x.issue_key, status: x.status }))
          : [];
        return {
          type: 'obligation', item: o, opened_by: this.#eventBrief(store, o.source_event_id),
          resolved_by: o.resolved_by_event_id ? this.#eventBrief(store, o.resolved_by_event_id) : null, sibling_issues: siblings,
        };
      }
      case 'ar': {
        const a = store.getArtifact(itemId)!;
        return { type: 'artifact', item: { ...a, text: a.text }, summary: artifactSummary(store, task, a), received_in: this.#eventBrief(store, a.event_id) };
      }
    }
    return {
      type: 'event', item: store.getEvent(itemId), raw: await this.backend.getEventRaw(org, itemId),
      extractions: store.extractionsFor(itemId), processing: processingOf(store, itemId),
    };
  }

  /** Attachment bytes from the private cache (evidence access, limited to the caller's org and tasks). */
  async attachment(org: string, eventId: string, part: number, allowTask: (taskId: string) => boolean) {
    const e = await this.backend.getEvent(org, eventId);
    if (!e || !e.task_id || !allowTask(e.task_id)) throw new HttpError(404, 'no such attachment');
    const meta = e.attachments.find((a) => a.part_index === part);
    if (!meta) throw new HttpError(404, 'no such attachment');
    let bytes = await this.backend.getBlob(org, { event_id: eventId, part_index: part });
    if (!bytes) {
      // cache miss: fetch from the transport and cache it best-effort
      bytes = await this.transport.fetchAttachment(e, part).catch(() => null);
      if (bytes) {
        await this.backend.putBlob(org, {
          event_id: eventId, part_index: part, sha256: meta.sha256, content_type: meta.content_type, size_bytes: bytes.length, bytes,
          primitive_email_id: e.primitive_email_id ?? null,
        }).catch(() => undefined);
      }
    }
    if (!bytes) throw new HttpError(404, 'attachment bytes unavailable');
    const actual = sha256Bytes(bytes);
    if (meta.sha256 && actual !== meta.sha256) throw new HttpError(502, 'attachment content hash mismatch', { expected: meta.sha256, actual });
    return { bytes, content_type: meta.content_type, filename: meta.filename, sha256: actual };
  }

  #eventBrief(store: Store, id: string) {
    const e = store.getEvent(id);
    if (!e) return null;
    return {
      id: e.id, at: e.occurred_at, direction: e.direction, from: e.from, to: e.to, subject: e.subject, thread_id: e.thread_id,
      message_id: e.message_id, link_reason: e.link_reason, attachments: e.attachments.map((a) => a.filename),
    };
  }

  /** Long-poll until the task's version passes `since`. In-process notifications wake it early; polling covers other workers. */
  async waitForChange(org: string, taskId: string, since: number, timeoutMs: number): Promise<number> {
    const readVersion = async () => (await this.backend.loadTask(org, taskId)).version;
    let current = await readVersion();
    if (current > since) return current;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.#nextNotification(org, taskId, Math.min(1000, Math.max(0, deadline - Date.now())));
      current = await readVersion();
      if (current > since) return current;
    }
    return current;
  }

  /** Resolve on the next engine notification for this task, or after `ms`, whichever comes first. */
  #nextNotification(org: string, taskId: string, ms: number): Promise<void> {
    const listeners = this.engine.listeners;
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        listeners.delete(listener);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      const listener = (o: string, tid: string) => {
        if (o === org && tid === taskId) finish();
      };
      listeners.add(listener);
    });
  }
}

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Interpretation status of one event, as the timeline and provenance views report it. */
function processingOf(store: Store, eventId: string): 'interpreted' | 'failed' | 'pending' {
  if (store.isInterpreted(eventId)) return 'interpreted';
  if (store.failed.has(eventId)) return 'failed';
  return 'pending';
}

const ID = /^[A-Za-z0-9._-]{1,64}$/;
const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/**
 * Server-side validation of a task definition. Participants decide whom the send guard lets us mail and
 * whose statements carry authority, so they are checked here and never changed afterwards. With
 * `selfAddress` set (live mode, CONTINUITY_SELF_ADDRESS) the task must use that inbox.
 */
export function validateTaskSpec(input: unknown, selfAddress = ''): TaskSpec {
  const bad = (msg: string): never => {
    throw new HttpError(400, `invalid task: ${msg}`);
  };
  const t = (input ?? {}) as Record<string, any>;
  const str = (v: unknown, name: string, max = 2000) => (typeof v === 'string' && v.trim() && v.length <= max ? v : bad(`${name} must be a non-empty string (≤ ${max} chars)`));
  if (!ID.test(String(t.id ?? ''))) bad('id must match [A-Za-z0-9._-]{1,64}');
  if (!ID.test(String(t.alias ?? ''))) bad('alias must match [A-Za-z0-9._-]{1,64}');
  const self = str(t.self_address, 'self_address', 254).toLowerCase();
  if (!EMAIL.test(self)) bad('self_address is not an email address');
  if (selfAddress && self !== selfAddress.toLowerCase()) bad(`self_address must be this agent's inbox (${selfAddress})`);
  if (!Array.isArray(t.participants) || !t.participants.length || t.participants.length > 50) bad('participants must be a list of 1–50 parties');
  const seen = new Set<string>();
  const participants: Participant[] = t.participants.map((p: Record<string, any>, i: number) => {
    const address = str(p?.address, `participants[${i}].address`, 254).toLowerCase();
    if (!EMAIL.test(address)) bad(`participants[${i}].address is not an email address`);
    if (seen.has(address)) bad(`duplicate participant ${address}`);
    seen.add(address);
    if (!['self', 'counterparty', 'internal'].includes(p.role)) bad(`participants[${i}].role must be self | counterparty | internal`);
    if (!Array.isArray(p.authority) || !p.authority.every((a: unknown) => typeof a === 'string' && a.length <= 64)) bad(`participants[${i}].authority must be a list of term prefixes`);
    if (p.sender_auth !== undefined && !SENDER_AUTH_POLICIES.includes(p.sender_auth)) bad(`participants[${i}].sender_auth must be ${SENDER_AUTH_POLICIES.join(' | ')}`);
    if (p.role === 'self' && p.sender_auth === 'flag') bad(`participants[${i}].sender_auth: "flag" cannot apply to self; inbound mail from our own address is never authoritative`);
    return {
      address, name: str(p.name, `participants[${i}].name`, 200), role: p.role, label: str(p.label, `participants[${i}].label`, 64),
      authority: [...p.authority], ...(typeof p.group === 'string' ? { group: p.group } : {}),
      ...(p.sender_auth !== undefined ? { sender_auth: p.sender_auth } : {}),
    };
  });
  const selves = participants.filter((p) => p.role === 'self');
  if (selves.length !== 1 || selves[0].address !== self) bad('exactly one participant must have role "self", and it must be self_address');
  if (!Array.isArray(t.requirements) || t.requirements.length > 50) bad('requirements must be a list (≤ 50)');
  const requirements: Requirement[] = t.requirements.map((r: Record<string, any>, i: number) => {
    if (typeof r?.key !== 'string' || !r.key.startsWith('requirement.')) bad(`requirements[${i}].key must start with "requirement."`);
    return { key: r.key, value: r.value, display: str(r.display, `requirements[${i}].display`, 200), hard: r.hard === true };
  });
  const domain = t.domain ?? 'procurement';
  if (!registeredDomains().includes(domain)) bad(`domain must be one of: ${registeredDomains().join(', ')}`);
  // only known fields are stored
  return {
    id: t.id, alias: t.alias, goal: str(t.goal, 'goal'), ...(typeof t.item === 'string' ? { item: t.item.slice(0, 200) } : {}),
    self_address: self, participants, requirements, domain,
    ...(t.approval !== undefined ? { approval: t.approval } : {}),
  };
}

/** A signed delivery we could not normalize: stored (unlinked, so it surfaces for manual linking) rather than lost. */
function minimalWebhookEvent(payload: Record<string, any>, error: string): EventInput {
  const email = payload?.email ?? {};
  const at = typeof email.received_at === 'string' && !Number.isNaN(Date.parse(email.received_at)) ? new Date(email.received_at).toISOString() : nowIso();
  return {
    source: 'primitive', dedupe_key: `primitive:email:${email.id ?? payload?.id}`, primitive_event_id: payload?.id ?? null, primitive_email_id: email.id ?? null,
    thread_id: null, message_id: null, in_reply_to: null, references: [], direction: 'inbound',
    from: String(email.smtp?.mail_from ?? 'unknown').toLowerCase(), to: [], cc: [], subject: String(email.headers?.subject ?? ''), body_text: '',
    occurred_at: at, received_at: at, attachments: [], raw: { normalize_error: error },
    time_flags: [{ kind: 'normalize_error', detail: `payload could not be normalized: ${error}` }],
  };
}
