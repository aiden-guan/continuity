// Primitive payloads → normalized CommunicationEvent input. Field names follow Primitive's
// documented `email.received` webhook payload (version 2025-12-14) and the REST EmailDetail shape.
// Threading comes from protocol metadata (thread_id, Message-ID, In-Reply-To, References),
// never from an LLM.
import type { AttachmentMeta, EventInput } from '../types.ts';
import { resolveEventTimes } from './maildate.ts';
import { detailAsEvent, senderAuthOf } from './sender-auth.ts';

/** `"Name" <a@b.com>` → `a@b.com` (lowercased); a bare address passes through. */
function bareAddress(v: string | null | undefined): string {
  if (!v) return '';
  const angle = v.match(/<([^>]+@[^>]+)>/);
  return (angle ? angle[1] : v).trim().toLowerCase();
}

/** `"Name" <a@b.com>` → `Name`; null when there is no display name. */
function displayName(v: string | null | undefined): string | null {
  const m = v?.match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : null;
}

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  return v ? [String(v)] : [];
}

const lowerAddresses = (list: any[] | undefined): string[] => (list ?? []).map((a: any) => String(a.address).toLowerCase());

/** Webhook `email.received` event (also what Primitive Functions receive). */
export function fromPrimitiveWebhook(evt: Record<string, any>): EventInput {
  const email = evt.email ?? {};
  const headers = email.headers ?? {};
  const parsed = email.parsed ?? {};
  const toAddrs = lowerAddresses(parsed.to_addresses);
  const attachments: AttachmentMeta[] = (parsed.attachments ?? []).map((a: any) => ({
    filename: a.filename ?? `attachment-${a.part_index}`,
    content_type: a.content_type ?? 'application/octet-stream',
    size_bytes: a.size_bytes ?? 0,
    sha256: a.sha256 ?? '',
    part_index: a.part_index ?? 0,
    // Not in Primitive's schema: the local simulator inlines the bytes here. Live mode downloads
    // them via GET /emails/{id}/attachments/{part_index} instead (see transport/primitive.ts).
    content_base64: a.content_base64,
  }));
  const times = resolveEventTimes(headers.date ?? null, email.received_at);
  // identity comes from the From header only — never the SMTP envelope sender, which the sender controls
  const from = bareAddress(headers.from);
  return {
    source: email.id?.startsWith?.('sim_') ? 'local-sim' : 'primitive',
    dedupe_key: `primitive:email:${email.id ?? evt.id}`,
    primitive_event_id: evt.id ?? null,
    primitive_email_id: email.id ?? null,
    reply_to_sent_email_id: email.reply_to_sent_email_id ?? null,
    thread_id: email.thread_id ?? null,
    message_id: headers.message_id ?? null,
    in_reply_to: asList(parsed.in_reply_to)[0] ?? null,
    references: asList(parsed.references),
    direction: 'inbound',
    from,
    from_name: displayName(headers.from),
    to: toAddrs.length ? toAddrs : asList(email.smtp?.rcpt_to).map((a) => a.toLowerCase()),
    cc: lowerAddresses(parsed.cc),
    subject: headers.subject ?? '',
    body_text: parsed.body_text ?? '',
    occurred_at: times.occurred_at,
    received_at: times.received_at,
    time_flags: times.time_flags,
    auth_verdict: JSON.stringify(senderAuthOf(evt, from)),
    attachments,
    raw: withoutBulk(evt),
  };
}

/** REST `GET /v1/emails/{id}` EmailDetail (used by the long-poll receiver in live mode). */
export function fromPrimitiveEmailDetail(d: Record<string, any>): EventInput {
  const parsed = d.parsed ?? {};
  // EmailDetail has no Date header field: occurred_at is Primitive's receipt time
  const times = resolveEventTimes(undefined, d.received_at ?? d.created_at);
  const from = bareAddress(d.from_header) || String(d.from_email ?? '').toLowerCase();
  return {
    source: 'primitive',
    dedupe_key: `primitive:email:${d.id}`,
    primitive_email_id: d.id,
    reply_to_sent_email_id: d.reply_to_sent_email_id ?? null,
    thread_id: d.thread_id ?? null,
    message_id: d.message_id ?? null,
    in_reply_to: asList(parsed.in_reply_to)[0] ?? null,
    references: asList(parsed.references),
    direction: 'inbound',
    from,
    from_name: displayName(d.from_header),
    to: [String(d.to_email ?? d.recipient ?? '').toLowerCase()],
    cc: lowerAddresses(parsed.cc),
    subject: d.subject ?? '',
    body_text: d.body_text ?? parsed.body_text ?? '',
    occurred_at: times.occurred_at,
    received_at: times.received_at,
    time_flags: times.time_flags,
    auth_verdict: JSON.stringify(senderAuthOf(detailAsEvent(d), from)),
    attachments: (parsed.attachments ?? []).map((a: any) => ({
      filename: a.filename,
      content_type: a.content_type,
      size_bytes: a.size_bytes ?? 0,
      sha256: a.sha256 ?? '',
      part_index: a.part_index ?? 0,
    })),
    raw: withoutBulk(d),
  };
}

/** A copy of the payload with raw MIME and inlined attachment bytes replaced by a marker. */
function withoutBulk(x: Record<string, any>) {
  const copy = structuredClone(x);
  if (copy.email?.content?.raw?.data) copy.email.content.raw.data = '[omitted]';
  for (const a of copy.email?.parsed?.attachments ?? []) {
    if (a.content_base64) a.content_base64 = '[omitted]';
  }
  return copy;
}
