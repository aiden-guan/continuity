// Scenario harness for tests and evals, run in-process: the real engine, the real webhook
// normalizer and the real backend contract. Inbound mail travels SimMailbox → Primitive webhook
// JSON → normalize. The in-memory backend is the default; hand in another Backend (Postgres, say)
// to play the identical story against it.
import { MemoryBackend } from '../store/memory-backend.ts';
import type { Backend } from '../store/backend.ts';
import type { MemoryStore } from '../store/state.ts';
import { Engine, DEFAULT_ORG } from '../engine/engine.ts';
import { heuristicExtractor } from '../extract/heuristic.ts';
import type { Extractor } from '../extract/types.ts';
import { SimMailbox, type SentRecord } from './mailbox.ts';
import { fromPrimitiveWebhook } from '../ingest/normalize.ts';
import { compileContext, type CompileOptions } from '../compiler/compile.ts';
import { renderBriefing } from '../compiler/render.ts';
import type { EventInput, StoredEvent, TaskSpec } from '../types.ts';
import type { SimEmail } from './scenario.ts';

export interface Delivered { event: StoredEvent; messageId: string; threadId: string; linked: boolean }

export class Harness {
  backend: Backend;
  engine: Engine;
  mailbox = new SimMailbox();
  task: TaskSpec;
  org: string;
  /** resolves once the org (and, unless create:false, the task) exists */
  ready: Promise<void>;
  /** cached state for non-memory backends, renewed by refresh() */
  #cached: MemoryStore | null = null;

  constructor(task: TaskSpec, extractor: Extractor = heuristicExtractor, at = '2026-10-19T08:55:00Z', opts: { backend?: Backend; org?: string; create?: boolean } = {}) {
    this.task = task;
    this.backend = opts.backend ?? new MemoryBackend();
    this.org = opts.org ?? DEFAULT_ORG;
    this.engine = new Engine(this.backend, extractor);
    this.ready = this.#setup(task, at, opts.create !== false);
  }

  async #setup(task: TaskSpec, at: string, create: boolean): Promise<void> {
    await this.backend.ensureOrg(this.org);
    if (create) await this.engine.createTask(this.org, task, at);
    await this.refresh();
  }

  #isMemory(): boolean { return this.backend instanceof MemoryBackend; }

  /** Synchronous task state: live for the memory backend, otherwise the most recent refresh. */
  get store(): MemoryStore {
    if (this.backend instanceof MemoryBackend) return this.backend.org(this.org);
    if (!this.#cached) throw new Error('call await h.refresh() first');
    return this.#cached;
  }

  async refresh() {
    if (this.#isMemory()) return;
    this.#cached = (await this.backend.loadTask(this.org, this.task.id)).store;
  }

  /** One of our outbound emails, recorded as if an agent had sent it through Continuity. */
  async out(to: string, subject: string, body: string, at: string, replyTo?: { messageId: string; references?: string[] } | null): Promise<SentRecord & { event: StoredEvent }> {
    await this.ready;
    const inReplyTo = replyTo?.messageId ?? null;
    const references = replyTo ? [...(replyTo.references ?? []), replyTo.messageId] : [];
    const sent = this.mailbox.recordSend({ from: this.task.self_address, to, subject, body, inReplyTo, references, at });
    const input: EventInput = {
      source: 'local-sim', dedupe_key: `out:${sent.messageId}`, thread_id: sent.threadId, message_id: sent.messageId, in_reply_to: inReplyTo, references,
      direction: 'outbound', from: this.task.self_address, to: [to], cc: [], subject, body_text: body, occurred_at: at, received_at: at, attachments: [], task_id: this.task.id,
    };
    const result = await this.engine.ingest(this.org, input);
    await this.refresh();
    return { ...sent, event: result.event };
  }

  /** Feed an already-normalized event (received and interpreted inline). */
  async ingest(e: EventInput) {
    await this.ready;
    const result = await this.engine.ingest(this.org, e);
    await this.refresh();
    return result;
  }

  /** Inbound mail, delivered as a signed Primitive-shaped webhook payload. */
  async in(mail: SimEmail): Promise<Delivered> {
    await this.ready;
    const delivery = this.mailbox.inbound(mail, 'test-secret');
    const result = await this.engine.ingest(this.org, fromPrimitiveWebhook(JSON.parse(delivery.body)));
    await this.refresh();
    return { event: result.event, messageId: delivery.messageId, threadId: delivery.threadId, linked: result.linked };
  }

  context(agentId?: string, opts: CompileOptions = {}) {
    return compileContext(this.store, this.task.id, { agentId, ...opts });
  }
  briefing(agentId?: string, opts: CompileOptions & { maxTokens?: number } = {}) {
    return renderBriefing(this.context(agentId, opts), { maxTokens: opts.maxTokens });
  }
  claims(key?: string) { return this.store.claimsForTask(this.task.id).filter((c) => !key || c.key === key); }
  active(key: string) { return this.claims(key).filter((c) => c.status === 'active'); }
  obligations() { return this.store.obligationsForTask(this.task.id); }
  artifacts() { return this.store.artifactsForTask(this.task.id); }
  checks() { return this.store.getChecks(this.task.id); }
  flags() { return this.store.flagsForTask(this.task.id); }
  transitions() { return this.store.transitionsForTask(this.task.id); }

  /** Swap the task definition partway through a scenario (eval only, e.g. a forwarder joins). */
  replaceTask(spec: TaskSpec) {
    this.task = spec;
    if (this.backend instanceof MemoryBackend) this.backend.org(this.org).replaceTaskSpec(spec);
  }

  /** The raw thread as one plain-text transcript; each attachment's text follows the email carrying it (a fair baseline). */
  transcriptText(): string {
    const artifacts = this.artifacts();
    const blocks = this.store.eventsForTask(this.task.id).map((e) => {
      const attachLine = e.attachments.length ? `\nAttachments: ${e.attachments.map((x) => x.filename).join(', ')}` : '';
      const header = `From: ${e.from}\nTo: ${e.to.join(', ')}\nDate: ${e.occurred_at}\nSubject: ${e.subject}${attachLine}`;
      const inlined = artifacts.filter((a) => a.event_id === e.id).map((a) => `\n\n[attachment ${a.filename}]\n${a.text}`).join('');
      return `${header}\n\n${e.body_text}${inlined}`;
    });
    return blocks.join('\n\n=====\n\n');
  }
}

/** Plays the canonical PO-4817 story up to the point Agent B wakes (the agent's emails are fixed text here). */
export async function runCanonicalScenario(h: Harness, a: { self: string; supplier: string; finance: string; stray: string }, cp: typeof import('./scenario.ts').counterparty) {
  const rfq = await h.out(a.supplier, 'RFQ: 500 x AX-200 — PO-4817', 'Hi Dana,\n\nWe need 500 AX-200 boards delivered by Friday, Oct 23. Can you deliver all 500 by then, and what is your unit price? Please send a formal quote.\n\nAcme Procurement Agent', '2026-10-19T09:00:00Z');
  const fin = await h.out(a.finance, 'Budget approval request — PO-4817', 'Hi Priya,\n\nCould you approve a budget of up to $11.50 per unit for PO-4817?\n\nAcme Procurement Agent', '2026-10-19T09:01:00Z');
  const offer = await h.in(cp.supplierOffer(a, { messageId: rfq.messageId, subject: rfq.subject }));
  const stray = await h.in(cp.strayPromo(a));
  const approval = await h.in(cp.financeApproval(a, { messageId: fin.messageId, subject: fin.subject }));
  const correction = await h.in(cp.supplierCorrection(a, { messageId: offer.messageId, subject: `Re: ${rfq.subject}`, references: [rfq.messageId] }));
  return { rfq, fin, offer, stray, approval, correction };
}
