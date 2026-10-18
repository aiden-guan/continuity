// An in-memory stand-in for Primitive, with the shapes the live client returns. Used by the tests and by
// `--fake` dry runs, so the whole live pipeline (delivery, verification, both conditions) runs without
// sending anything. Like the real account it only accepts addresses on its own domain, threads by
// In-Reply-To, stores one inbox row per recipient on the domain, and deduplicates on Idempotency-Key.
import { createHash, randomUUID } from 'node:crypto';
import { attachmentText } from '../../src/ingest/attachments.ts';
import { LiveApiError, type LiveClient, type LiveSend, type Preflight, type Rec, type SentRecord } from './client.ts';

const bare = (v: string) => ([...v.matchAll(/<([^<>]+@[^<>]+)>/g)].at(-1)?.[1] ?? v).trim().toLowerCase();

export interface FakeFaults {
  /** drop every attachment from stored inbox rows */
  dropAttachments?: boolean;
  /** store only the first line of each body */
  truncateBodies?: boolean;
  /** inbox rows never become visible */
  loseInbound?: boolean;
}

export class FakeLiveClient implements LiveClient {
  readonly kind = 'fake' as const;
  sends = 0;
  faults: FakeFaults = {};
  #sent = new Map<string, Rec>();
  #inbox = new Map<string, Rec>();
  #bytes = new Map<string, Buffer>();
  #byKey = new Map<string, SentRecord>();
  #threadOf = new Map<string, string>(); // Message-ID → thread id
  #clock: number;
  readonly domain: string;

  constructor(domain = 'bench-fake.primitive.email', start = Date.now()) {
    this.domain = domain;
    this.#clock = start;
  }

  #now() {
    this.#clock += 1000;
    return new Date(this.#clock).toISOString();
  }

  async preflight(): Promise<Preflight> {
    return { domain: this.domain, plan: 'fake', send_per_hour: 1000, send_per_day: 10000, processing_routes: 0, sendable: true };
  }

  async send(req: LiveSend, key: string): Promise<SentRecord> {
    const earlier = this.#byKey.get(key);
    if (earlier) return { ...earlier, replayed: true };
    const recipients = [req.to, ...(req.cc ?? []), ...(req.bcc ?? [])].map((a) => a.toLowerCase());
    for (const a of [bare(req.from), ...recipients]) {
      if (!a.endsWith(`@${this.domain}`)) throw new LiveApiError(`fake Primitive: ${a} is not on ${this.domain}`, 422);
    }
    this.sends++;
    const at = this.#now();
    const id = randomUUID();
    const message_id = `<${createHash('sha256').update(id).digest('hex').slice(0, 16)}@${this.domain}>`;
    const thread_id = (req.inReplyTo && this.#threadOf.get(req.inReplyTo)) || randomUUID();
    this.#threadOf.set(message_id, thread_id);
    const atts = (req.attachments ?? []).map((a, i) => ({ filename: a.filename, content_type: a.content_type, size_bytes: a.bytes.length, part_index: i, tar_path: `${i}_${a.filename}` }));
    this.#sent.set(id, {
      id, status: 'delivered', created_at: at, updated_at: at, from_header: req.from, from_address: bare(req.from), to_header: req.to, to_address: req.to.toLowerCase(),
      cc: req.cc ?? [], subject: req.subject, body_text: req.bodyText, message_id, in_reply_to: req.inReplyTo ?? null, email_references: (req.references ?? []).join(' '), thread_id, attachments: atts,
    });
    if (!this.faults.loseInbound) {
      for (const rcpt of recipients) {
        const rowId = randomUUID();
        const body = this.faults.truncateBodies ? req.bodyText.split('\n')[0] : req.bodyText;
        const stored = this.faults.dropAttachments ? [] : atts;
        (req.attachments ?? []).forEach((a, i) => this.#bytes.set(`${rowId}:${i}`, a.bytes));
        this.#inbox.set(rowId, {
          id: rowId, message_id, status: 'completed', sender: bare(req.from), recipient: rcpt, from_header: req.from, from_email: bare(req.from), to_email: rcpt,
          subject: req.subject, body_text: body, created_at: at, received_at: at, thread_id, reply_to_sent_email_id: null, reply_count: 0, awaiting: 'you', automated: false,
          parsed: {
            status: 'complete', body_text: body, cc: (req.cc ?? []).map((address) => ({ address, name: null })), to_addresses: [{ address: req.to, name: null }],
            in_reply_to: req.inReplyTo ? [req.inReplyTo] : null, references: req.references?.length ? req.references : null, attachments: stored,
          },
          auth: {
            spf: 'pass', dmarc: 'pass', dmarcPolicy: 'reject', dmarcFromDomain: this.domain, dmarcSpfAligned: true, dmarcDkimAligned: true, dmarcSpfStrict: false, dmarcDkimStrict: false,
            dkimSignatures: [{ domain: this.domain, selector: 'fake', result: 'pass', aligned: true, algo: 'ed25519-sha256' }],
          },
        });
      }
    }
    const rec: SentRecord = { id, message_id, thread_id, status: 'delivered', created_at: at, replayed: false };
    this.#byKey.set(key, rec);
    return rec;
  }

  async awaitInbound(messageId: string, recipient: string) {
    const row = [...this.#inbox.values()].find((r) => r.message_id === messageId && r.recipient === recipient.toLowerCase());
    if (!row) throw new LiveApiError(`message ${messageId} did not arrive at ${recipient}`, 0);
    return { id: row.id as string, received_at: row.received_at as string };
  }

  async getEmail(id: string) { return structuredClone(this.#inbox.get(id) ?? null); }
  async getSentEmail(id: string) { return structuredClone(this.#sent.get(id) ?? null); }

  async listInbox(q: { recipient: string; dateFrom: string; limit: number }) {
    return [...this.#inbox.values()].filter((r) => r.recipient === q.recipient.toLowerCase() && r.received_at >= q.dateFrom).reverse().slice(0, q.limit).map((r) => structuredClone(r));
  }

  async searchInbox(q: { q: string; to: string; dateFrom: string; limit: number }) {
    const words = q.q.toLowerCase().split(/\W+/).filter(Boolean);
    return (await this.listInbox({ recipient: q.to, dateFrom: q.dateFrom, limit: 500 }))
      .filter((r) => words.some((w) => `${r.subject} ${r.body_text} ${r.from_header}`.toLowerCase().includes(w))).slice(0, q.limit);
  }

  async getThread(id: string) {
    const msgs = [
      ...[...this.#sent.values()].filter((s) => s.thread_id === id).map((s) => ({ id: s.id, direction: 'outbound', message_id: s.message_id, from: s.from_header, to: s.to_address, subject: s.subject, timestamp: s.created_at })),
      ...[...this.#inbox.values()].filter((r) => r.thread_id === id).map((r) => ({ id: r.id, direction: 'inbound', message_id: r.message_id, from: r.from_header, to: r.recipient, subject: r.subject, timestamp: r.received_at })),
    ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return msgs.length ? { id, subject: msgs[0].subject, message_count: msgs.length, messages: msgs } : null;
  }

  async getConversation(emailId: string) {
    const row = this.#inbox.get(emailId) ?? this.#sent.get(emailId);
    if (!row) return null;
    const t = await this.getThread(String(row.thread_id));
    const text = (id: string) => String((this.#inbox.get(id) ?? this.#sent.get(id))?.body_text ?? '');
    return { thread_id: row.thread_id, message_count: t!.messages.length, truncated: false, messages: t!.messages.map((m) => ({ ...m, role: m.direction === 'inbound' ? 'user' : 'assistant', text: text(m.id) })) };
  }

  async downloadAttachment(emailId: string, partIndex: number) {
    const b = this.#bytes.get(`${emailId}:${partIndex}`);
    if (!b) throw new LiveApiError('fake Primitive: no such attachment part', 404);
    return b;
  }

  /** Text of an attachment as the real pipeline would extract it (test helper). */
  async attachmentTextOf(emailId: string, partIndex: number) {
    const r = this.#inbox.get(emailId)!;
    const a = (r.parsed.attachments as Rec[])[partIndex];
    return attachmentText(a.filename, a.content_type, await this.downloadAttachment(emailId, partIndex));
  }

  close() {}
}
