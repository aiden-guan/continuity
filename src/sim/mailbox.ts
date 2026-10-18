// Stand-in for Primitive's mail transport when there is no PRIMITIVE_API_KEY.
// It hands out Message-IDs and thread ids the way a real provider would, and turns inbound mail
// into Primitive-shaped `email.received` webhook payloads signed with the SDK's own signer — so
// the server runs exactly the same verification and normalization code as in production.
import { createHash, randomBytes } from 'node:crypto';
import { signWebhookPayload } from '@primitivedotdev/sdk';
import type { SimEmail } from './scenario.ts';
import { canonicalIso } from '../clock.ts';

/**
 * EmailAuth as Primitive reports it: 'pass' (DKIM-aligned DMARC pass), 'spoofed' (DMARC fail, p=reject),
 * 'no_dmarc' (no DMARC record), 'dkim_only' (no DMARC record, DKIM by the From domain), 'dns_temperror'
 * (DMARC lookup failed temporarily).
 */
export function simAuth(e: Pick<SimEmail, 'from' | 'auth'>) {
  const d = e.from.split('@')[1];
  const dkim = [{ domain: d, selector: 'sim', result: 'pass', aligned: true, keyBits: 2048, algo: 'rsa-sha256' }];
  const unaligned = { dmarcFromDomain: d, dmarcSpfAligned: false, dmarcDkimAligned: false, dmarcSpfStrict: null, dmarcDkimStrict: null };
  if (e.auth === 'spoofed') return { spf: 'fail', dmarc: 'fail', dmarcPolicy: 'reject', ...unaligned, dmarcSpfStrict: false, dmarcDkimStrict: false, dkimSignatures: [] };
  if (e.auth === 'dns_temperror') return { spf: 'temperror', dmarc: 'temperror', dmarcPolicy: null, ...unaligned, dkimSignatures: [] };
  if (e.auth === 'no_dmarc') return { spf: 'pass', dmarc: 'none', dmarcPolicy: null, ...unaligned, dkimSignatures: [] };
  if (e.auth === 'dkim_only') return { spf: 'pass', dmarc: 'none', dmarcPolicy: null, ...unaligned, dkimSignatures: dkim };
  return { spf: 'pass', dmarc: 'pass', dmarcPolicy: 'reject', dmarcFromDomain: d, dmarcSpfAligned: true, dmarcDkimAligned: true, dmarcSpfStrict: false, dmarcDkimStrict: false, dkimSignatures: dkim };
}

export interface SentRecord { messageId: string; threadId: string; subject: string; references: string[]; at: string; to: string; body: string }

/** Quote a parent message the way a mail client does ("On <date>, <who> wrote:" + "> " lines). */
function withQuotedParent(body: string, parent: { from: string; at: string; body: string }): string {
  const quoted = parent.body.split('\n').map((line) => `> ${line}`).join('\n');
  return `${body}\n\nOn ${new Date(parent.at).toUTCString()}, ${parent.from} wrote:\n${quoted}`;
}

export class SimMailbox {
  /** Message-ID → thread id */
  threads = new Map<string, string>();
  /** Message-ID → what was said, so replies can quote it realistically */
  bodies = new Map<string, { from: string; at: string; body: string }>();
  sent: SentRecord[] = [];
  #counter = 0;
  domain: string;

  constructor(domain = 'sim.primitive.local') {
    this.domain = domain;
  }

  newMessageId(): string {
    this.#counter += 1;
    return `<sim-${Date.now().toString(36)}-${this.#counter.toString(36)}-${randomBytes(3).toString('hex')}@${this.domain}>`;
  }

  /** A reply joins its parent's thread; anything else starts a fresh one. */
  threadFor(inReplyTo: string | null | undefined): string {
    if (inReplyTo) {
      const known = this.threads.get(inReplyTo);
      if (known !== undefined) return known;
    }
    return `thr_sim_${randomBytes(6).toString('hex')}`;
  }

  /** Record a send of ours and return the ids, as Primitive's send-mail would. */
  recordSend(s: { from?: string; to: string; subject: string; body: string; inReplyTo: string | null; references: string[]; at: string }): SentRecord {
    const messageId = this.newMessageId();
    const threadId = this.threadFor(s.inReplyTo);
    this.threads.set(messageId, threadId);
    const at = canonicalIso(s.at);
    this.bodies.set(messageId, { from: s.from ?? 'procurement', at, body: s.body });
    const record: SentRecord = { messageId, threadId, subject: s.subject, references: s.references, at, to: s.to, body: s.body };
    this.sent.push(record);
    return record;
  }

  /** Produce a signed Primitive `email.received` webhook delivery for one inbound message. */
  inbound(e: SimEmail, secret: string): { body: string; headers: Record<string, string>; messageId: string; threadId: string } {
    const messageId = this.newMessageId();
    const threadId = this.threadFor(e.inReplyTo);
    this.threads.set(messageId, threadId);

    const parent = e.inReplyTo ? this.bodies.get(e.inReplyTo) : undefined;
    const body = parent ? withQuotedParent(e.body, parent) : e.body;
    const fromHeader = e.fromHeader ?? `${e.fromName} <${e.from}>`;
    this.bodies.set(messageId, { from: fromHeader, at: e.at, body });

    const senderDomain = e.from.split('@')[1];
    const attachments = (e.attachments ?? []).map((a, i) => ({
      filename: a.filename,
      content_type: a.content_type,
      size_bytes: a.bytes.length,
      sha256: createHash('sha256').update(a.bytes).digest('hex'),
      part_index: i,
      tar_path: `${i}_${a.filename}`,
      content_base64: a.bytes.toString('base64'),
    }));
    const emailId = `sim_em_${randomBytes(8).toString('hex')}`;
    const webhookId = `evt_${randomBytes(32).toString('hex')}`;

    const payload = {
      id: webhookId,
      event: 'email.received',
      version: '2025-12-14',
      delivery: { endpoint_id: 'ep_local_sim', attempt: e.deliveryAttempt ?? 1, attempted_at: new Date().toISOString() },
      email: {
        id: emailId,
        received_at: canonicalIso(e.receivedAt ?? e.at),
        smtp: { helo: senderDomain, mail_from: e.from, rcpt_to: [e.to] },
        headers: { message_id: messageId, subject: e.subject, from: fromHeader, to: e.to, date: e.dateHeader ?? new Date(e.at).toUTCString() },
        content: {
          raw: { included: false, reason_code: 'size_exceeded', max_inline_bytes: 262144, size_bytes: 0, sha256: '0'.repeat(64) },
          download: { url: 'https://localhost.invalid/raw', expires_at: e.at },
        },
        parsed: {
          status: 'complete',
          error: null,
          body_text: body,
          body_html: null,
          reply_to: null,
          cc: null,
          bcc: null,
          to_addresses: [{ address: e.to, name: null }],
          in_reply_to: e.inReplyTo ? [e.inReplyTo] : null,
          references: e.references?.length ? e.references : null,
          attachments,
          attachments_download_url: null,
        },
        analysis: {},
        auth: simAuth(e),
        thread_id: threadId,
      },
    };

    const raw = JSON.stringify(payload);
    const signature = signWebhookPayload(raw, secret);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'primitive-signature': signature.header,
      'x-webhook-event': 'email.received',
      'x-webhook-id': webhookId,
    };
    return { body: raw, headers, messageId, threadId };
  }
}
