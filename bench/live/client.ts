// The benchmark's door to real Primitive: everything the live mode sends or reads goes through this
// interface, so the delivery code and both conditions are tested against an in-memory fake
// (bench/live/fake.ts) and run unchanged against the real API.
//
//   send             POST /send-mail (cc/bcc, threading headers, attachments) with an Idempotency-Key
//   awaitInbound     the GET /emails forward tail (?since&wait long-poll), one shared receiver loop
//   reads            GET /emails/{id}, /sent-emails/{id}, /emails (list), /emails/search, /threads/{id},
//                    /emails/{id}/conversation, /emails/{id}/attachments/{part}
//
// Latency: arrival is detected by long-poll (the server answers as soon as mail lands), with a direct
// lookup as a fallback; there are no fixed sleeps. Sends are paced under the account's hourly limit
// and retried only with the same idempotency key, so a retry can never send twice.
// Security: the API key stays inside the SDK client; error text is redacted before it is logged or
// stored; signed download links never leave this file.
import { createPrimitiveClient } from '@primitivedotdev/sdk';
import {
  getConversation, getEmail, getInboxStatus, getOutboundStatus, getSentEmail, getThread, listDomains, listEmails, searchEmails, sendEmail,
} from '@primitivedotdev/sdk/api';

export type Rec = Record<string, any>;

export interface LiveSend {
  from: string; // RFC 5322 From header: `Name <address>`
  to: string;
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  inReplyTo?: string | null;
  references?: string[];
  attachments?: { filename: string; content_type: string; bytes: Buffer }[];
}

export interface SentRecord {
  id: string;
  message_id: string | null;
  thread_id: string | null;
  status: string;
  created_at: string;
  /** Primitive answered with an earlier send for the same Idempotency-Key (nothing new went out). */
  replayed: boolean;
}

export interface Preflight {
  domain: string;
  plan: string;
  send_per_hour: number;
  send_per_day: number;
  /** Webhook endpoints or Functions that would process (and could act on) mail the benchmark sends. */
  processing_routes: number;
  sendable: boolean;
}

export interface LiveClient {
  readonly kind: 'primitive' | 'fake';
  preflight(): Promise<Preflight>;
  send(req: LiveSend, idempotencyKey: string): Promise<SentRecord>;
  /** The inbound row Primitive stored for this Message-ID at this recipient, as soon as it is visible. */
  awaitInbound(messageId: string, recipient: string, opts: { notBefore: string; timeoutMs: number }): Promise<{ id: string; received_at: string }>;
  getEmail(id: string): Promise<Rec | null>;
  getSentEmail(id: string): Promise<Rec | null>;
  listInbox(q: { recipient: string; dateFrom: string; limit: number }): Promise<Rec[]>;
  searchInbox(q: { q: string; to: string; dateFrom: string; limit: number }): Promise<Rec[]>;
  getThread(id: string): Promise<Rec | null>;
  getConversation(emailId: string): Promise<Rec | null>;
  downloadAttachment(emailId: string, partIndex: number): Promise<Buffer>;
  close(): void;
}

// ------------------------------------------------------------------ safety helpers

/** Strip API keys, bearer tokens and URL signatures from any text that may be printed or saved. */
export function redact(text: string): string {
  return text
    .replace(/\bprim_[A-Za-z0-9_-]{6,}/g, 'prim_[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:sig|signature|token|key|expires|X-Amz-[A-Za-z-]+)=)[^&\s"']+/gi, '$1[redacted]');
}

export class LiveApiError extends Error {
  status: number;
  retryAfterMs: number | null;
  constructor(message: string, status: number, retryAfterMs: number | null = null) {
    super(redact(message));
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const retryable = (e: unknown) => {
  const status = (e as LiveApiError).status ?? 0;
  return !status || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry transient failures with backoff (honouring Retry-After). Only for idempotent calls. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 5, baseMs = 500): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= tries || !retryable(e)) throw e;
      const after = (e as LiveApiError).retryAfterMs;
      await sleep(after ?? Math.min(baseMs * 2 ** (attempt - 1), 15_000) * (0.75 + Math.random() / 2));
    }
  }
}

/** Paces sends under the account's hourly limit and stops at a hard cap on total sends for the process. */
export class SendBudget {
  #next = 0;
  #sent = 0;
  readonly perHour: number;
  readonly maxSends: number;
  now: () => number;
  wait: (ms: number) => Promise<unknown>;
  constructor(perHour: number, maxSends: number, now = () => Date.now(), wait: (ms: number) => Promise<unknown> = sleep) {
    this.perHour = perHour;
    this.maxSends = maxSends;
    this.now = now;
    this.wait = wait;
  }
  get sent() { return this.#sent; }
  async take(): Promise<void> {
    if (this.#sent >= this.maxSends) throw new LiveApiError(`send cap reached (${this.maxSends}); raise --max-sends to send more`, 0);
    this.#sent++;
    const interval = 3_600_000 / this.perHour;
    const at = Math.max(this.now(), this.#next);
    this.#next = at + interval;
    if (at > this.now()) await this.wait(at - this.now());
  }
}

/** The sent row gets its Message-ID a moment after the send returns (seen live: ~300 ms): read it until it has one. */
export async function sentWithMessageId(read: () => Promise<Rec | null>, wait: (ms: number) => Promise<unknown> = sleep): Promise<Rec | null> {
  let sent = await read();
  for (let ms = 250; !sent?.message_id && ms <= 4000; ms *= 2) {
    await wait(ms);
    sent = await read();
  }
  return sent;
}

/** A forward-tail cursor for "mail that became visible after this instant" (format `{ISO with µs}|{uuid}`). */
export function cursorAt(iso: string): string {
  return `${new Date(iso).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z')}|00000000-0000-0000-0000-000000000000`;
}

// ------------------------------------------------------------------ real Primitive

type Op = { data?: Rec; error?: unknown; response?: Response };

function unwrap(r: Op, what: string): Rec | null {
  const status = r.response?.status ?? 0;
  if (status === 404) return null;
  if (r.error || (status && status >= 400)) {
    const err = r.error as Rec | undefined;
    const msg = err?.error?.message ?? err?.message ?? JSON.stringify(err ?? {}).slice(0, 300);
    const ra = Number(r.response?.headers.get('retry-after'));
    throw new LiveApiError(`Primitive ${what} failed (HTTP ${status}): ${msg}`, status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
  }
  return (r.data?.data ?? r.data ?? null) as Rec | null;
}

export class PrimitiveLiveClient implements LiveClient {
  readonly kind = 'primitive' as const;
  #sdk: ReturnType<typeof createPrimitiveClient>;
  #budget: SendBudget;
  #stop = new AbortController();
  // receiver state: rows seen on the forward tail, and callers waiting for one
  #seen = new Map<string, { id: string; received_at: string }>();
  #waiters = new Map<string, (row: { id: string; received_at: string }) => void>();
  #receiving: Promise<void> | null = null;
  #cursor: string;

  constructor(apiKey: string, opts: { perHour: number; maxSends: number; since: string }) {
    if (!apiKey) throw new Error('PRIMITIVE_API_KEY is not set');
    this.#sdk = createPrimitiveClient({ apiKey });
    this.#budget = new SendBudget(opts.perHour, opts.maxSends);
    this.#cursor = cursorAt(opts.since);
  }

  get #c() { return this.#sdk.client; }

  async preflight(): Promise<Preflight> {
    const account = await withRetry(() => this.#sdk.account.get()) as Rec;
    const domains = (unwrap(await listDomains({ client: this.#c }) as Op, 'list domains') ?? []) as unknown as Rec[];
    const outbound = unwrap(await getOutboundStatus({ client: this.#c }) as Op, 'outbound status') ?? {};
    const inbox = unwrap(await getInboxStatus({ client: this.#c }) as Op, 'inbox status') ?? {};
    const active = domains.filter((d) => d.is_active && d.verified).map((d) => String(d.domain));
    const sendable = (outbound.sendable_domains ?? []) as string[];
    const domain = active.find((d) => sendable.includes(d)) ?? active[0] ?? '';
    return {
      domain,
      plan: String(account.plan ?? 'unknown'),
      send_per_hour: Number(account.limits?.send_per_hour ?? 0),
      send_per_day: Number(account.limits?.send_per_day ?? 0),
      processing_routes: Number(inbox.endpoints?.enabled ?? 0) + Number(inbox.functions?.deployed ?? 0),
      sendable: !!domain && sendable.includes(domain),
    };
  }

  async send(req: LiveSend, idempotencyKey: string): Promise<SentRecord> {
    await this.#budget.take();
    const body: Rec = {
      from: req.from, to: req.to, subject: req.subject, body_text: req.bodyText, wait: true,
      ...(req.cc?.length ? { cc: req.cc } : {}),
      ...(req.bcc?.length ? { bcc: req.bcc } : {}),
      ...(req.inReplyTo ? { in_reply_to: req.inReplyTo } : {}),
      ...(req.references?.length ? { references: req.references } : {}),
      ...(req.attachments?.length ? { attachments: req.attachments.map((a) => ({ filename: a.filename, content_type: a.content_type, content_base64: a.bytes.toString('base64') })) } : {}),
    };
    // the same key on every retry: Primitive hands back the first send instead of sending again
    const result = await withRetry(async () => unwrap(await sendEmail({ client: this.#c, body: body as never, headers: { 'Idempotency-Key': idempotencyKey } }) as Op, 'send'));
    if (!result?.id) throw new LiveApiError('Primitive send returned no id', 0);
    if (Array.isArray(result.rejected) && result.rejected.length) throw new LiveApiError(`Primitive rejected recipients: ${result.rejected.join(', ')}`, 0);
    const sent = await sentWithMessageId(() => this.getSentEmail(String(result.id)));
    return {
      id: String(result.id),
      message_id: sent?.message_id ?? null,
      thread_id: sent?.thread_id ?? null,
      status: String(sent?.status ?? result.status ?? 'unknown'),
      created_at: String(sent?.created_at ?? new Date().toISOString()),
      replayed: !!result.idempotent_replay,
    };
  }

  /** One long-poll loop for the whole process; each row is matched to whoever is waiting for it. */
  #receive() {
    this.#receiving ??= (async () => {
      while (!this.#stop.signal.aborted) {
        let page: Rec | null;
        try {
          const r = await listEmails({ client: this.#c, query: { since: this.#cursor, wait: 20, limit: 100 } as never, signal: this.#stop.signal }) as Op;
          if (r.error || (r.response?.status ?? 200) >= 400) { unwrap(r, 'inbox tail'); continue; }
          page = r.data ?? null;
        } catch (e) {
          if (this.#stop.signal.aborted) return;
          await sleep(retryable(e) ? 1000 : 5000);
          continue;
        }
        const rows = (page?.data ?? []) as Rec[];
        for (const row of rows) {
          const key = `${row.message_id}|${String(row.recipient ?? row.to_email ?? '').toLowerCase()}`;
          const hit = { id: String(row.id), received_at: String(row.received_at ?? row.created_at) };
          this.#seen.set(key, hit);
          this.#waiters.get(key)?.(hit);
        }
        if (page?.meta?.cursor) this.#cursor = page.meta.cursor;
      }
    })();
  }

  async awaitInbound(messageId: string, recipient: string, opts: { notBefore: string; timeoutMs: number }) {
    const key = `${messageId}|${recipient.toLowerCase()}`;
    this.#receive();
    const seen = this.#seen.get(key);
    if (seen) return seen;
    return new Promise<{ id: string; received_at: string }>((resolve, reject) => {
      let settled = false;
      const done = (row: { id: string; received_at: string } | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(fallback);
        this.#waiters.delete(key);
        if (row instanceof Error) reject(row); else resolve(row);
      };
      this.#waiters.set(key, done);
      // fallback: look the message up directly, in case the tail cursor skipped it
      const fallback = setInterval(async () => {
        try {
          const rows = await this.listInbox({ recipient, dateFrom: opts.notBefore, limit: 100 });
          const row = rows.find((x) => x.message_id === messageId);
          if (row) done({ id: String(row.id), received_at: String(row.received_at ?? row.created_at) });
        } catch { /* the tail is still running; try again next tick */ }
      }, 10_000);
      const timer = setTimeout(() => done(new LiveApiError(`message ${messageId} did not arrive at ${recipient} within ${opts.timeoutMs} ms`, 0)), opts.timeoutMs);
    });
  }

  async getEmail(id: string) {
    return withRetry(async () => unwrap(await getEmail({ client: this.#c, path: { id } }) as Op, `GET /emails/${id}`));
  }
  async getSentEmail(id: string) {
    return withRetry(async () => unwrap(await getSentEmail({ client: this.#c, path: { id } }) as Op, `GET /sent-emails/${id}`));
  }
  async listInbox(q: { recipient: string; dateFrom: string; limit: number }) {
    // `search` matches subject, sender and recipient; the recipient filter below makes it exact
    const rows = await withRetry(async () => unwrap(await listEmails({ client: this.#c, query: { search: q.recipient, date_from: q.dateFrom, limit: q.limit } as never }) as Op, 'list emails'));
    return ((rows ?? []) as unknown as Rec[]).filter((r) => String(r.recipient ?? '').toLowerCase() === q.recipient.toLowerCase());
  }
  async searchInbox(q: { q: string; to: string; dateFrom: string; limit: number }) {
    const rows = await withRetry(async () => unwrap(await searchEmails({ client: this.#c, query: { q: q.q, to: q.to, date_from: q.dateFrom, limit: q.limit } as never }) as Op, 'search emails'));
    return ((rows ?? []) as unknown as Rec[]).filter((r) => String(r.recipient ?? '').toLowerCase() === q.to.toLowerCase());
  }
  async getThread(id: string) {
    return withRetry(async () => unwrap(await getThread({ client: this.#c, path: { id } }) as Op, `GET /threads/${id}`));
  }
  async getConversation(emailId: string) {
    return withRetry(async () => unwrap(await getConversation({ client: this.#c, path: { id: emailId } } as never) as Op, `GET /emails/${emailId}/conversation`));
  }
  async downloadAttachment(emailId: string, partIndex: number): Promise<Buffer> {
    // the SDK's own download (the path the production transport uses, verified live)
    return withRetry(async () => {
      try {
        return Buffer.from((await this.#sdk.downloadEmailAttachmentPart(emailId, partIndex)).bytes);
      } catch (e) {
        const err = e as { status?: number; message?: string };
        throw new LiveApiError(`Primitive attachment download failed: ${err.message ?? e}`, Number(err.status ?? 0));
      }
    });
  }
  close() { this.#stop.abort(); }
}
