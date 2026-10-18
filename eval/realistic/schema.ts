// Realistic synthetic threads: the file format and its validator.
//
// Each thread is one JSON file: a task (Continuity's TaskSpec), the messages in arrival order, and
// checkpoints that state the CORRECT deal state after a given message. The emails are written in
// the style of real business mail (see STYLE.md: quoted history, terse replies, tables, shorthand,
// distractor numbers), but every fact is scripted, so the gold answers are known by construction.
//
// The validator keeps the gold honest: every term in a checkpoint must quote, verbatim, the words
// that state it in the message it cites, and every message and party reference must resolve.
//
//   node eval/realistic/validate.ts                 # every thread
//   node eval/realistic/validate.ts threads/P01.json
import type { TaskSpec } from '../../src/types.ts';

export type ThreadDomain = 'procurement' | 'real_estate';

export interface ThreadMessage {
  /** m1, m2, … in arrival order */
  id: string;
  direction: 'inbound' | 'outbound';
  from: string;
  fromName: string;
  to: string;
  subject: string;
  /** ISO 8601 arrival time; strictly increasing through the thread */
  at: string;
  /** id of the message this one replies to (threads the mail), or null */
  in_reply_to: string | null;
  /** the full body as the recipient sees it, INCLUDING any quoted history */
  body: string;
  attachments?: { filename: string; lines: string[] }[];
  /** sender authentication Primitive would observe (default "pass") */
  auth?: 'pass' | 'spoofed' | 'no_dmarc';
}

/** A term as the gold says it stands. `value` uses Continuity's normalized form for the term type. */
export interface GoldTerm {
  /** participant label, e.g. "supplier", "listing agent", "buyer agent (us)" */
  party: string;
  /** term key from the domain pack, e.g. "price.unit", "closing.date" */
  term: string;
  /** money/number: 11.4 · date: "2026-10-23" · schedule: [{"qty":300,"date":"2026-10-23"}] · text: "Net 30" */
  value: unknown;
  /** message that states it */
  stated_in: string;
  /** exact words from that message's NEW text or an attachment that state the value */
  evidence: string;
}

export interface GoldCheckpoint {
  /** the state is judged after this message */
  after: string;
  /** current applied terms (status active) */
  active: GoldTerm[];
  /** terms in dispute between two speakers of the same side (status contested) */
  contested?: GoldTerm[];
  /** earlier values that a later statement replaced */
  superseded?: (GoldTerm & { replaced_in: string })[];
  /** statements recorded but NOT applied: hedged, unauthorized speaker, unauthenticated sender, held money detail */
  tentative?: (GoldTerm & { why: 'hedged' | 'not_authoritative' | 'unauthenticated' | 'held_for_verification' | 'stale_forward' })[];
  /** who owes what */
  obligations?: { owed_by: string; owed_to: string; kind: 'question' | 'request' | 'commitment'; about: string; status: 'open' | 'answered' | 'fulfilled' | 'partially_fulfilled'; opened_in: string; resolved_in?: string | null }[];
  documents?: { filename: string; status: 'current' | 'partially_stale' | 'superseded' | 'withdrawn' }[];
  /** expected check outcome per check id prefix, e.g. { "delivery_deadline": "fail" } */
  checks?: Record<string, 'pass' | 'fail' | 'unknown'>;
  /** who should act next */
  next_actor: 'us' | 'them' | 'none' | 'human';
  /** what a fresh agent should do now (graded on its email) */
  handoff?: { expect: 'send' | 'wait'; to?: string; must: string[]; must_not: string[] };
}

export interface Thread {
  id: string;
  domain: ThreadDomain;
  title: string;
  /** which hard cases this thread exercises (see README) */
  features: string[];
  task: TaskSpec;
  messages: ThreadMessage[];
  checkpoints: GoldCheckpoint[];
  /** anything a reader of the results should know about this thread */
  notes?: string;
}

export const TERM_KEYS: Record<ThreadDomain, string[]> = {
  procurement: ['price.unit', 'delivery.schedule', 'order.quantity', 'payment.terms', 'quote.valid_until', 'offer.status', 'budget.max_unit_price', 'decision.order'],
  real_estate: ['price.purchase', 'closing.date', 'contingency.inspection_until', 'inspection.date', 'appraisal.value', 'budget.max_price', 'decision.accept', 'payment.wire_instructions', 'deal.fell_through'],
};
export const FEATURES = [
  'quoted_history', 'buried_correction', 'from_to_change', 'partial_update', 'contested', 'hedged', 'not_authoritative',
  'unauthenticated', 'late_forward', 'promise_without_attachment', 'document_versions', 'answered_question', 'unanswered_question',
  'subject_drift', 'distractor_numbers', 'withdrawal', 'sensitive_change', 'terse_shorthand', 'table', 'noise_mail', 'long_thread', 'acceptance',
] as const;

/** The text a message adds itself: its body minus quoted history ("-----Original Message-----", "> ", "On … wrote:" and Lotus-style headers). */
export function newText(body: string): string {
  // Outlook "-----Original Message-----", Lotus "---- Forwarded by", "On … wrote:", Outlook/Lotus header blocks
  const cut = body.search(/\n\s*-{2,}\s*(Original Message|Forwarded by)[^\n]*|\n[^\n]*\bwrote:\s*\n|\n\s*From:\s+[^\n]+\n\s*(Sent|To|cc):|\n[^\n]*@[A-Za-z]+\s*\n\s*\d{1,2}\/\d{1,2}\/\d{2,4} \d{1,2}:\d{2}/i);
  return (cut >= 0 ? body.slice(0, cut) : body).split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export function validateThread(t: Thread): string[] {
  const errs: string[] = [];
  const e = (m: string) => errs.push(`${t.id}: ${m}`);
  if (!/^[PR]\d{2}$/.test(t.id)) e('id must look like P01 or R01');
  if (!(t.domain in TERM_KEYS)) e(`unknown domain ${t.domain}`);
  if (t.task?.domain !== t.domain) e('task.domain must equal domain');
  for (const f of t.features ?? []) if (!(FEATURES as readonly string[]).includes(f)) e(`unknown feature ${f}`);
  const parties = new Map((t.task?.participants ?? []).map((p) => [p.address.toLowerCase(), p]));
  const labels = new Set((t.task?.participants ?? []).map((p) => p.label));
  const self = t.task?.self_address?.toLowerCase();
  if (!self || parties.get(self)?.role !== 'self') e('self_address must be a participant with role "self"');
  const ids = new Map<string, number>();
  let last = '';
  t.messages.forEach((m, i) => {
    if (m.id !== `m${i + 1}`) e(`message ${i + 1} must have id m${i + 1}`);
    ids.set(m.id, i);
    if (!ISO.test(m.at)) e(`${m.id}: at must be ISO UTC (…Z)`);
    if (m.at <= last) e(`${m.id}: arrival times must strictly increase`);
    last = m.at;
    const fromSelf = m.from.toLowerCase() === self;
    if ((m.direction === 'outbound') !== fromSelf) e(`${m.id}: direction must be outbound exactly when sent from self_address`);
    if (m.direction === 'outbound' && !parties.has(m.to.toLowerCase())) e(`${m.id}: outbound mail must go to a participant`);
    if (m.direction === 'inbound' && m.to.toLowerCase() !== self) e(`${m.id}: inbound mail must be addressed to self_address`);
    if (m.in_reply_to && !(ids.has(m.in_reply_to) && ids.get(m.in_reply_to)! < i)) e(`${m.id}: in_reply_to must name an earlier message`);
    if (!m.body?.trim() && !m.attachments?.length) e(`${m.id}: empty message`);
  });
  const textOf = (id: string) => {
    const m = t.messages[ids.get(id) ?? -1];
    return m ? [newText(m.body), ...(m.attachments ?? []).map((a) => a.lines.join('\n'))].join('\n') : null;
  };
  const checkTerm = (where: string, g: GoldTerm) => {
    if (!labels.has(g.party)) e(`${where}: unknown party label "${g.party}"`);
    if (!TERM_KEYS[t.domain]?.includes(g.term)) e(`${where}: unknown term ${g.term}`);
    const text = textOf(g.stated_in);
    if (text === null) e(`${where}: stated_in ${g.stated_in} is not a message`);
    else if (!g.evidence || !squash(text).includes(squash(g.evidence))) e(`${where}: evidence "${g.evidence}" is not in the new text of ${g.stated_in}`);
    if (g.term === 'closing.date' || g.term.endsWith('until') || g.term === 'inspection.date') { if (typeof g.value !== 'string' || !DATE.test(g.value)) e(`${where}: ${g.term} must be YYYY-MM-DD`); }
    if (/price|value|max_/.test(g.term) && g.term !== 'payment.wire_instructions' && typeof g.value !== 'number') e(`${where}: ${g.term} must be a number`);
    if (g.term === 'delivery.schedule' && !(Array.isArray(g.value) && g.value.every((l: { qty?: unknown; date?: unknown }) => typeof l.qty === 'number' && typeof l.date === 'string' && DATE.test(l.date)))) e(`${where}: delivery.schedule must be [{qty, date}]`);
  };
  let prev = -1;
  t.checkpoints.forEach((c, k) => {
    const at = ids.get(c.after);
    const where = `checkpoint ${k + 1} (after ${c.after})`;
    if (at === undefined) { e(`${where}: after must name a message`); return; }
    if (at <= prev) e(`${where}: checkpoints must be in message order`);
    prev = at;
    const visible = (id: string) => (ids.get(id) ?? Infinity) <= at;
    for (const g of [...c.active, ...(c.contested ?? []), ...(c.superseded ?? []), ...(c.tentative ?? [])]) {
      checkTerm(`${where} ${g.party}/${g.term}`, g);
      if (!visible(g.stated_in)) e(`${where}: ${g.term} cites ${g.stated_in}, which comes after the checkpoint`);
    }
    for (const s of c.superseded ?? []) if (!visible(s.replaced_in)) e(`${where}: superseded ${s.term} replaced_in ${s.replaced_in} is after the checkpoint`);
    const key = (g: GoldTerm) => `${g.party}|${g.term}`;
    const active = new Map<string, number>();
    for (const g of c.active) active.set(key(g), (active.get(key(g)) ?? 0) + 1);
    for (const [k2, n] of active) if (n > 1) e(`${where}: ${k2} is active twice`);
    // restating the same value confirms it; a "superseded" value that is still the current one is a contradiction
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const s of c.superseded ?? []) if (c.active.some((g) => key(g) === key(s) && same(g.value, s.value))) e(`${where}: ${key(s)}=${JSON.stringify(s.value)} is both superseded and active (a restated value confirms, it does not supersede)`);
    for (const o of c.obligations ?? []) {
      if (!labels.has(o.owed_by) || !labels.has(o.owed_to)) e(`${where}: obligation parties must be labels (${o.owed_by} → ${o.owed_to})`);
      if (!visible(o.opened_in)) e(`${where}: obligation opened_in ${o.opened_in} is after the checkpoint`);
      if (o.resolved_in && !visible(o.resolved_in)) e(`${where}: obligation resolved_in ${o.resolved_in} is after the checkpoint`);
      if (o.status !== 'open' && !o.resolved_in) e(`${where}: a resolved obligation needs resolved_in`);
    }
    if (c.handoff && c.handoff.expect === 'send' && !c.handoff.to) e(`${where}: handoff with expect "send" needs "to" (a label)`);
  });
  if (t.messages.length < 4) e('a thread needs at least 4 messages');
  if (!t.checkpoints.length) e('a thread needs at least one checkpoint');
  return errs;
}
