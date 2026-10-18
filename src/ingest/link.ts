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

  // 5. the task alias written out in the subject or body, as people actually write it. The alias with its
  // own prefix ("PO 4817") on any task beats a bare number after a noun ("invoice #4817") on an earlier one
  const haystack = `${e.subject}\n${e.body_text}`;
  const tasks = await store.tasks();
  const named = tasks.find((t) => aliasPattern(t.alias, false).test(haystack)) ?? tasks.find((t) => aliasPattern(t.alias).test(haystack));
  if (named) return { task_id: named.id, reason: `explicit task reference "${named.alias}"` };
  // 6. another reference the task itself names (the PO an invoice is on), when exactly one task names it
  for (const task of tasks) {
    for (const ref of referencesIn(task.goal ?? '', task.alias)) {
      if (!aliasPattern(ref).test(haystack)) continue;
      if (tasks.filter((t) => t !== task && referencesIn(t.goal ?? '', t.alias).includes(ref)).length) continue;
      return { task_id: task.id, reason: `reference "${ref}" named in the task` };
    }
  }
  return null;
}

/** Reference codes ("PO-4817", "LGL-4417") a task's goal names besides its alias. */
function referencesIn(goal: string, alias: string): string[] {
  return [...new Set(goal.match(/\b[A-Z]{2,6}-\d{3,}\b/g) ?? [])].filter((r) => r.toLowerCase() !== alias.toLowerCase());
}

/** NOUNS people put before a bare reference number ("load 40209", "invoice #20417", "matter 4417"). */
const REFERENCE_NOUN = String.raw`(?:load|invoice|inv|matter|order|po|ref(?:erence)?|file|case|booking|group code|contract|agreement)`;

/**
 * An alias like "INV-20417" also matches "INV 20417", "INV20417", "invoice #20417" and "load 20417": the
 * digits must be exact (a look-alike with two digits swapped is another task), and a bare number counts
 * only right after a reference noun (not at all with `loose` false).
 */
export function aliasPattern(alias: string, loose = true): RegExp {
  const exact = `(?:^|[^A-Za-z0-9])${literal(alias)}(?:[^A-Za-z0-9]|$)`;
  const parts = alias.match(/^([A-Za-z]{2,6})-(\d{4,})$/);
  if (!parts) return new RegExp(exact, 'i');
  const [, prefix, digits] = parts;
  const spaced = `(?:^|[^A-Za-z0-9])${literal(prefix)}[\\s#-]*${digits}(?![0-9])`;
  const noun = `\\b${REFERENCE_NOUN}\\s*(?:#|no\\.?|number)?\\s*${digits}(?![0-9])`;
  return new RegExp(loose ? `${exact}|${spaced}|${noun}` : `${exact}|${spaced}`, 'i');
}
