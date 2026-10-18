// Row helpers shared by the persistent backends.
import type { EventInput, StoredEvent } from '../types.ts';

type EventColumns = Omit<StoredEvent, 'id' | 'seq' | 'task_id' | 'link_reason'>;

/** An event as stored. Attachment bytes live in the blob cache, never in the evidence row. */
export function stripAttachmentBytes(e: EventInput): EventColumns {
  const { raw: _raw, preserve_seq: _seq, task_id: _task, link_reason: _reason, time_flags: flags, ...columns } = e;
  return {
    ...columns,
    attachments: e.attachments.map(({ content_base64: _bytes, ...meta }) => meta),
    ...(flags?.length ? { time_flags: flags } : {}), // stored only when the times needed repair
  };
}

export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return v == null ? (v as never) : String(v);
}
export function isoOrNull(v: unknown): string | null {
  return v == null ? null : iso(v);
}
export function dateOnly(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}
