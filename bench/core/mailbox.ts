// Turns a case into the mailbox every condition sees, up to a checkpoint. One materialisation is
// shared by all conditions so they get byte-identical mail: the same message ids ("m07"), the same
// threads, the same mail-client quoting of the parent message, and the same attachment text.
//
// Ids: every message gets a neutral display id from its position in the case (m01, m02, …). The
// Continuity condition's own event ids (ev_N) are rewritten to these in its briefing, so every system
// cites sources in the same id space and the scorer maps them back to oracle keys.
import { createHash } from 'node:crypto';
import type { BenchCase, BenchEvent, Checkpoint } from './types.ts';

export interface MailMessage {
  id: string; // m07
  key: string; // oracle key e3 / b2
  event: BenchEvent;
  thread_id: string;
  message_id: string;
  in_reply_to: string | null;
  references: string[];
  /** The body as delivered: author text plus the quoted parent, like a mail client. */
  body: string;
  attachments: { filename: string; content_type: string; text: string; lines: string[] }[];
  task: boolean; // ground-truth task membership
}

export interface Mailbox {
  case: BenchCase;
  checkpoint: Checkpoint;
  /** Messages visible at the checkpoint, chronological. */
  messages: MailMessage[];
  byId: Map<string, MailMessage>;
  byKey: Map<string, MailMessage>;
  trigger: MailMessage;
  now: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

function rfc2822(iso: string): string {
  return new Date(iso).toUTCString();
}

export function materialize(c: BenchCase, checkpoint: Checkpoint = c.checkpoints.at(-1)!): Mailbox {
  const cut = c.events.findIndex((e) => e.key === checkpoint.after);
  if (cut < 0) throw new Error(`${c.id}: checkpoint ${checkpoint.id} after unknown ${checkpoint.after}`);
  const salt = createHash('sha256').update(c.id).digest('hex').slice(0, 8);
  const all = new Map<string, MailMessage>();
  const messages: MailMessage[] = [];

  c.events.slice(0, cut + 1).forEach((e, i) => {
    const parent = e.replyTo ? all.get(e.replyTo) ?? null : null;
    const thread_id = parent ? parent.thread_id : `thr_${salt}_${e.key}`;
    const message_id = `<${salt}.${e.key}@mail.bench.example>`;
    const quoted = parent && e.quoteParent !== false
      ? `${e.body}\n\nOn ${rfc2822(parent.event.at)}, ${parent.event.fromName} <${parent.event.from}> wrote:\n${parent.body.split('\n').map((l) => `> ${l}`).join('\n')}`
      : e.body;
    const m: MailMessage = {
      id: `m${pad(i + 1)}`,
      key: e.key,
      event: e,
      thread_id,
      message_id,
      in_reply_to: parent?.message_id ?? null,
      references: parent ? [...parent.references, parent.message_id] : [],
      body: quoted,
      attachments: (e.attachments ?? []).map((a) => ({ filename: a.filename, content_type: a.content_type, text: a.lines.join('\n'), lines: a.lines })),
      task: !e.background,
    };
    all.set(e.key, m);
    messages.push(m);
  });

  const trigger = all.get(c.trigger) ?? messages.at(-1)!;
  return {
    case: c,
    checkpoint,
    messages,
    byId: new Map(messages.map((m) => [m.id, m])),
    byKey: all,
    trigger: checkpoint.after === c.trigger ? trigger : all.get(checkpoint.after)!,
    now: checkpoint.now,
  };
}

// ------------------------------------------------------------------ renderings shared by the baselines

export function renderEmail(m: MailMessage, opts: { attachments?: boolean } = {}): string {
  const e = m.event;
  const lines = [
    `[message id: ${m.id}] [thread: ${m.thread_id}]`,
    `From: ${e.fromName} <${e.from}>`,
    `To: ${e.to.join(', ')}${e.cc?.length ? `\nCc: ${e.cc.join(', ')}` : ''}`,
    `Date: ${e.at}`,
    `Subject: ${e.subject}`,
    // Primitive reports SPF/DMARC on every message; showing it always (pass or fail) gives every condition the same signal
    `Auth: spf=${e.auth === 'fail' ? 'fail' : 'pass'} dmarc=${e.auth === 'fail' ? 'fail' : 'pass'}`,
  ];
  if (m.attachments.length) lines.push(`Attachments: ${m.attachments.map((a) => a.filename).join(', ')}`);
  let out = `${lines.join('\n')}\n\n${m.body}`;
  if (opts.attachments !== false) {
    for (const a of m.attachments) out += `\n\n[attachment ${a.filename} (from ${m.id})]\n${a.text}`;
  }
  return out;
}

/** The task header every condition gets: goal, parties with what they may set, requirements, and the clock. */
export function taskHeader(mb: Mailbox): string {
  const t = mb.case.task;
  const parties = t.parties
    .filter((p) => p.role !== 'self')
    .map((p) => `- ${p.label}: ${p.name} <${p.address}> (${p.role}; may set: ${p.authority.join(', ') || 'nothing'})`)
    .join('\n');
  const reqs = t.requirements.map((r) => `- ${r.key.replace('requirement.', '')} = ${r.display}${r.hard ? ' (hard)' : ''}`).join('\n');
  return [
    `Task ${t.alias}: ${t.goal}`,
    `You are ${t.self_address}.`,
    `Parties:\n${parties}`,
    `Requirements:\n${reqs}`,
    `Current time: ${mb.now}`,
  ].join('\n');
}

/** The message that woke the agent, given verbatim to every condition. */
export function triggerBlock(mb: Mailbox): string {
  return `<new_message>\n${renderEmail(mb.trigger)}\n</new_message>`;
}

/** Map any id an agent might cite (m07, a filename, an attachment marker) back to an oracle event key. */
export function resolveSourceId(mb: Mailbox, id: string): string | null {
  const s = id.trim();
  const direct = mb.byId.get(s) ?? mb.byId.get(s.replace(/^\[?message id:\s*/i, '').replace(/\]$/, ''));
  if (direct) return direct.key;
  const m = s.match(/\bm\d{2,3}\b/);
  if (m && mb.byId.get(m[0])) return mb.byId.get(m[0])!.key;
  const byFile = mb.messages.find((x) => x.attachments.some((a) => a.filename === s));
  return byFile?.key ?? null;
}

// ------------------------------------------------------------------ Primitive-shaped records (for the Primitive-native condition)

/**
 * Thread-level `awaiting`, as Primitive documents it on EmailSummary/EmailDetail: "them" when the
 * thread's latest outbound send is at or after its latest inbound message, otherwise "you".
 */
export function awaitingFor(mb: Mailbox, threadId: string): 'you' | 'them' {
  const inThread = mb.messages.filter((m) => m.thread_id === threadId);
  const lastIn = inThread.filter((m) => m.event.direction === 'inbound').at(-1)?.event.at ?? '';
  const lastOut = inThread.filter((m) => m.event.direction === 'outbound').at(-1)?.event.at ?? '';
  if (!lastOut) return 'you';
  return lastOut >= lastIn ? 'them' : 'you';
}

export function emailSummary(mb: Mailbox, m: MailMessage) {
  const replies = mb.messages.filter((x) => x.in_reply_to === m.message_id && x.event.direction === 'outbound');
  return {
    id: m.id,
    thread_id: m.thread_id,
    direction: m.event.direction,
    from: `${m.event.fromName} <${m.event.from}>`,
    to: m.event.to,
    subject: m.event.subject,
    received_at: m.event.at,
    snippet: m.event.body.replace(/\s+/g, ' ').slice(0, 140),
    attachment_count: m.attachments.length,
    reply_count: replies.length,
    awaiting: awaitingFor(mb, m.thread_id),
  };
}

export function emailDetail(mb: Mailbox, m: MailMessage) {
  return {
    ...emailSummary(mb, m),
    message_id: m.message_id,
    parsed: {
      body_text: m.body,
      in_reply_to: m.in_reply_to ? [m.in_reply_to] : [],
      references: m.references,
      attachments: m.attachments.map((a, i) => ({ filename: a.filename, content_type: a.content_type, part_index: i, size_bytes: a.text.length })),
    },
    auth: { dmarc: m.event.auth === 'fail' ? 'fail' : 'pass', spf: m.event.auth === 'fail' ? 'fail' : 'pass' },
  };
}
