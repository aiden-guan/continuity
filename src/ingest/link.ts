// Cross-thread task resolution: try *explicit* signals in order, strongest first.
// There is deliberately no semantic similarity here — a message that matches nothing stays
// unlinked (and visible in the UI/API) instead of being quietly merged into the wrong task.
import type { LinkLookup } from '../store/backend.ts';
import type { EventInput } from '../types.ts';

export interface LinkResult { task_id: string; reason: string }

/** Escape regex metacharacters so an alias matches literally. */
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function resolveTask(store: LinkLookup, e: EventInput): Promise<LinkResult | null> {
  // 1. the caller already knows (sent through Continuity, or replay)
  if (e.task_id) return { task_id: e.task_id, reason: e.link_reason ?? 'sent through Continuity for this task' };

  // 2. Primitive's own thread grouping
  if (e.thread_id) {
    const owner = await store.taskForThread(e.thread_id);
    if (owner) return { task_id: owner, reason: `Primitive thread ${e.thread_id} belongs to task` };
  }

  // 3. a reply to an email we sent
  if (e.reply_to_sent_email_id) {
    const sent = await store.eventByPrimitiveEmailId(e.reply_to_sent_email_id);
    if (sent?.task_id) return { task_id: sent.task_id, reason: `reply to our sent email ${e.reply_to_sent_email_id}` };
  }

  // 4. RFC 5322 threading headers: In-Reply-To first, then References newest-first
  const headerIds = [e.in_reply_to, ...[...e.references].reverse()].filter(Boolean) as string[];
  for (const id of headerIds) {
    const earlier = await store.eventByMessageId(id);
    if (earlier?.task_id) return { task_id: earlier.task_id, reason: `In-Reply-To/References ${id}` };
  }

  // 5. the task alias written out in the subject or body
  const haystack = `${e.subject}\n${e.body_text}`;
  for (const task of await store.tasks()) {
    const mention = new RegExp(`(^|[^A-Za-z0-9])${literal(task.alias)}([^A-Za-z0-9]|$)`, 'i');
    if (mention.test(haystack)) return { task_id: task.id, reason: `explicit task reference "${task.alias}"` };
  }
  return null;
}
