// Cross-thread task resolution: try *explicit* signals in order, strongest first.
// There is deliberately no semantic similarity here — a message that matches nothing stays
// unlinked (and visible in the UI/API) instead of being quietly merged into the wrong task.
import type { LinkLookup } from '../store/backend.ts';
import type { EventInput, TaskSpec } from '../types.ts';

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
  // 6. another reference the task itself names (the PO an invoice is on), when exactly one task names it and the
  // sender writes from the domain of one of its parties (a part number in a stranger's sale flyer is not the deal)
  const from = (e.from ?? '').toLowerCase();
  const senderDomain = from.slice(from.lastIndexOf('@') + 1);
  for (const task of tasks) {
    if (e.direction === 'inbound' && !task.participants?.some((p) => p.slice(p.lastIndexOf('@') + 1) === senderDomain)) continue;
    for (const ref of referencesIn(task.goal ?? '', task.alias)) {
      if (!aliasPattern(ref).test(haystack)) continue;
      if (tasks.filter((t) => t !== task && referencesIn(t.goal ?? '', t.alias).includes(ref)).length) continue;
      return { task_id: task.id, reason: `reference "${ref}" named in the task` };
    }
  }
  // 7. a new thread from a known party, when exactly one task names that sender (the buyer writing
  // "Wren Hollow — take the 805" without the alias). A sender on several tasks stays unlinked; this
  // only routes the mail, it grants no authority (the resolver still checks who may set what)
  // — unless the mail names a different deal of the same kind (another PO, invoice, group code) and none of this one's
  if (e.direction === 'inbound') {
    const sender = e.from.toLowerCase();
    const theirs = tasks.filter((t) => t.participants?.includes(sender));
    if (theirs.length === 1 && !aboutAnotherDeal(theirs[0], haystack)) return { task_id: theirs[0].id, reason: `sender ${sender} is a participant only on this task` };
  }
  return null;
}

const CODE = /\b([A-Z]{2,6})-([A-Z0-9]*\d[A-Z0-9]*)\b/g;

/** The mail names a reference with the same prefix as one of the task's own ("PO-8539" on PO-8228's task) and none of the task's. */
export function aboutAnotherDeal(task: { alias: string; goal?: string }, text: string): boolean {
  const own = [task.alias, ...referencesIn(task.goal ?? '', task.alias)];
  if (own.some((ref) => aliasPattern(ref, false).test(text))) return false;
  const prefixes = new Set(own.map((ref) => ref.match(/^([A-Za-z]{2,6})-/)?.[1].toUpperCase()).filter(Boolean));
  return [...text.matchAll(CODE)].some((m) => prefixes.has(m[1]) && !own.some((ref) => ref.toUpperCase() === m[0]));
}

/** The addresses on a task other than our own, lowercased (what rule 7 matches a sender against). */
export function participantAddresses(spec: Pick<TaskSpec, 'participants'>): string[] {
  return spec.participants.filter((p) => p.role !== 'self').map((p) => p.address.toLowerCase());
}

/** Reference codes ("PO-4817", "LGL-4417", "ACME-SKO91") a task's goal names besides its alias. */
function referencesIn(goal: string, alias: string): string[] {
  return [...new Set(goal.match(/\b[A-Z]{2,6}-[A-Z0-9]*\d[A-Z0-9]*\b/g) ?? [])].filter((r) => r.toLowerCase() !== alias.toLowerCase() && /\d{3,}|[A-Z]\d/.test(r.split('-')[1]));
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
