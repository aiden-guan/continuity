// The mail-delivery boundary. Delivery always belongs to Primitive, never to Continuity; locally a
// simulator takes its place, and every outcome records which of the two produced it.
import { createPrimitiveClient } from '@primitivedotdev/sdk';
import { getSentEmail } from '@primitivedotdev/sdk/api';
import type { StoredEvent } from '../types.ts';
import { SimMailbox } from '../sim/mailbox.ts';
import { nowIso } from '../clock.ts';

export interface SendRequest {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: string[];
  attachments?: { filename: string; content_type: string; bytes: Buffer }[];
}
export interface SendOutcome {
  mode: 'primitive' | 'local-sim';
  primitive_email_id: string | null;
  message_id: string | null;
  thread_id: string | null;
  status: string;
  /** set when Primitive returned an earlier send for the same Idempotency-Key instead of sending again */
  replayed?: boolean;
}

export interface Transport {
  mode: 'primitive' | 'local-sim';
  send(req: SendRequest, idempotencyKey: string): Promise<SendOutcome>;
  fetchAttachment(event: StoredEvent, partIndex: number): Promise<Buffer | null>;
  /** Primitive Memories (live transport only): durable string-keyed checkpoints. */
  memory?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
}

/** The provider refused the send in a way retrying will not fix (bad recipient, policy refusal). */
export class PermanentSendError extends Error {}

export class LocalSimTransport implements Transport {
  mode = 'local-sim' as const;
  mailbox = new SimMailbox();
  /** Mirrors Primitive's idempotency: reusing a key hands back the earlier send, flagged as a replay. */
  #sentByKey = new Map<string, SendOutcome>();
  /** Test fault injection: 'before' fails with nothing sent; 'after' sends and then loses the response. */
  failNext: 'before' | 'after' | 'permanent' | null = null;

  async send(req: SendRequest, idempotencyKey?: string): Promise<SendOutcome> {
    if (idempotencyKey) {
      const earlier = this.#sentByKey.get(idempotencyKey);
      if (earlier) return { ...earlier, replayed: true };
    }
    const fault = this.failNext;
    this.failNext = null;
    if (fault === 'before') throw new Error('simulated network error (nothing sent)');
    if (fault === 'permanent') throw new PermanentSendError('simulated provider rejection (recipient refused)');

    const record = this.mailbox.recordSend({ from: req.from, to: req.to, subject: req.subject, body: req.body, inReplyTo: req.inReplyTo, references: req.references, at: nowIso() });
    const outcome: SendOutcome = {
      mode: 'local-sim',
      primitive_email_id: `sim_sent_${this.mailbox.sent.length}_${record.messageId.slice(5, 13)}`,
      message_id: record.messageId,
      thread_id: record.threadId,
      status: 'simulated',
    };
    if (idempotencyKey) this.#sentByKey.set(idempotencyKey, outcome);
    if (fault === 'after') throw new Error('simulated timeout after the provider accepted the message');
    return outcome;
  }

  // the simulator carries attachment bytes inline in the webhook payload, so there is nothing to fetch
  async fetchAttachment() { return null; }
}

/** Retryable statuses among the 4xx range; any other 4xx is treated as a permanent refusal. */
const RETRYABLE_4XX = [408, 409, 429];

/** Live transport over the official Primitive SDK (typed against SDK 2.4.0; see README for what was verified). */
export class PrimitiveTransport implements Transport {
  mode = 'primitive' as const;
  client: ReturnType<typeof createPrimitiveClient>;

  constructor(apiKey: string) {
    this.client = createPrimitiveClient({ apiKey });
  }

  async send(req: SendRequest, idempotencyKey: string): Promise<SendOutcome> {
    return this.#deliver(req, idempotencyKey);
  }

  async #deliver(req: SendRequest, idempotencyKey: string): Promise<SendOutcome> {
    let result;
    try {
      result = await this.client.send({
        from: req.from,
        to: req.to,
        subject: req.subject,
        bodyText: req.body,
        thread: req.inReplyTo ? { inReplyTo: req.inReplyTo, references: req.references } : undefined,
        attachments: req.attachments?.map((a) => ({ filename: a.filename, content_type: a.content_type, content_base64: a.bytes.toString('base64') })),
      }, { idempotencyKey });
    } catch (err) {
      // a client error (other than timeout/conflict/rate-limit) will fail again; anything else may have gone out
      const e = err as { status?: number; statusCode?: number };
      const status = Number(e.status ?? e.statusCode ?? 0);
      if (status >= 400 && status < 500 && !RETRYABLE_4XX.includes(status)) throw new PermanentSendError((err as Error).message);
      throw err;
    }

    // the send call returns the sent-email id; its Message-ID and thread id live on the sent-email record
    let message_id: string | null = null;
    let thread_id: string | null = null;
    try {
      const detail = await getSentEmail({ client: this.client.client, path: { id: result.id } });
      const record = (detail.data as { data?: { message_id?: string | null; thread_id?: string | null } } | undefined)?.data;
      message_id = record?.message_id ?? null;
      thread_id = record?.thread_id ?? null;
    } catch {
      // not fatal: the inbound reply still threads through reply_to_sent_email_id
    }
    return { mode: 'primitive', primitive_email_id: result.id, message_id, thread_id, status: String(result.status), replayed: result.idempotentReplay };
  }

  async fetchAttachment(event: StoredEvent, partIndex: number): Promise<Buffer | null> {
    if (!event.primitive_email_id) return null;
    const download = await this.client.downloadEmailAttachmentPart(event.primitive_email_id, partIndex);
    return Buffer.from(download.bytes);
  }

  memory = {
    get: async (key: string) => {
      try {
        return (await this.client.memories.get(key)).value;
      } catch {
        return null;
      }
    },
    set: async (key: string, value: unknown) => {
      await this.client.memories.set({ key, value: value as never });
    },
  };
}

export function makeTransport(): Transport {
  // CONTINUITY_TRANSPORT=sim pins the simulator even if a Primitive key is configured (`npm run demo` uses this)
  const apiKey = process.env.CONTINUITY_TRANSPORT === 'sim' ? undefined : process.env.PRIMITIVE_API_KEY;
  if (apiKey) return new PrimitiveTransport(apiKey);
  return new LocalSimTransport();
}
