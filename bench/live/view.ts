// What the systems under test see of a delivered case, read from real Primitive.
//
// The Mailbox keeps the case's own addresses, ids and clock (the oracle, the task header and the
// scorer all use them) and gains a `live` view:
//   - Primitive-native: its read tools call the real API (list, search, email, sent email, thread,
//     conversation, attachment), scoped to this case's messages, and return Primitive's own fields;
//   - Continuity: ingests each message the way production does (GET /emails/{id} → normaliser,
//     attachment bytes downloaded from Primitive; our sends from GET /sent-emails/{id}).
// Three things are mapped back so a case keeps its meaning: live addresses → the case's addresses, the domain in
// Message-IDs → the sender's case domain, and Primitive's real timestamps → the case's clock (deadlines and
// "overdue" are scripted relative to it).
// Everything else (bodies as Primitive parsed them, threading, ids, auth verdicts, attachment bytes,
// `awaiting`, search behaviour) is what Primitive returned.
//
// Isolation: a tool can only read rows that belong to the case (an allowlist of ids), list and search
// are filtered by the case's own inbox address and the run's start time, and signed download links and
// account internals are never passed on.
import type { BenchCase } from '../core/types.ts';
import { materialize, type Mailbox } from '../core/mailbox.ts';
import { attachmentText } from '../../src/ingest/attachments.ts';
import { fromPrimitiveEmailDetail } from '../../src/ingest/normalize.ts';
import type { EventInput } from '../../src/types.ts';
import type { LiveClient, Rec } from './client.ts';
import { caseMapper, type CaseDelivery } from './deliver.ts';

export interface LiveView {
  client: LiveClient;
  delivery: CaseDelivery;
  self: string; // the agent's live inbox address
  since: string;
  /** live address → case address, in any text */
  toCase: (s: string) => string;
  /** a Message-ID minted on our domain → the same id on its sender's case domain (in_reply_to/references too) */
  toCaseId: (id: unknown) => unknown;
  /** inbound row id or sent row id → m07 */
  idToM: Map<string, string>;
  /** m07 → delivered record */
  byM: Map<string, CaseDelivery['messages'][number]>;
  /** real thread ids of this case */
  threads: Set<string>;
  /** the scripted time of a real row id */
  timeOf: (id: string) => string | null;
}

export function liveMailbox(c: BenchCase, delivery: CaseDelivery, client: LiveClient, since: string): Mailbox {
  const mb = materialize(c);
  const byM = new Map(delivery.messages.map((x) => [x.m, x]));
  const idToM = new Map<string, string>();
  for (const x of delivery.messages) {
    // only the row our agent's side holds: the inbox row for inbound mail, the sent row for our own mail
    if (x.direction === 'inbound' && x.inbound_id) idToM.set(x.inbound_id, x.m);
    if (x.direction === 'outbound') idToM.set(x.sent_id, x.m);
  }
  const missing = mb.messages.filter((m) => !byM.has(m.id)).map((m) => m.id);
  if (missing.length) throw new Error(`${c.id}: live delivery is missing ${missing.join(', ')}`);
  const timeOf = (id: string) => {
    const m = idToM.get(id);
    return m ? byM.get(m)!.scripted_at : null;
  };
  // every Message-ID is minted on our domain; a real counterparty's would carry its own, so the domain of each id
  // becomes its sender's case domain (consistently, so In-Reply-To and References still point at the same ids)
  const idDomain = new Map(delivery.messages.map((x) => [x.message_id, mb.byId.get(x.m)!.event.from.split('@')[1]]));
  const toCaseId = (id: unknown): unknown => {
    if (Array.isArray(id)) return id.map(toCaseId);
    if (typeof id !== 'string') return id;
    const dom = idDomain.get(id);
    return dom ? id.replace(/@[^@>]+>$/, `@${dom}>`) : id;
  };
  mb.live = {
    client, delivery, self: delivery.self, since, toCase: caseMapper(delivery.aliases), toCaseId, idToM, byM,
    threads: new Set(delivery.messages.map((x) => x.thread_id).filter((t): t is string => !!t)), timeOf,
  };
  return mb;
}

// ------------------------------------------------------------------ Primitive's fields, as the agent sees them

const addrList = (v: unknown) => ((v ?? []) as Rec[]).map((x) => String(x?.address ?? x));

function summary(v: LiveView, r: Rec) {
  return {
    id: r.id,
    thread_id: r.thread_id ?? null,
    direction: 'inbound',
    from: v.toCase(String(r.from_header ?? r.sender ?? r.from_email ?? '')),
    to: v.toCase(String(r.recipient ?? r.to_email ?? '')),
    subject: r.subject ?? null,
    received_at: v.timeOf(String(r.id)),
    reply_count: r.reply_count ?? 0,
    awaiting: r.awaiting ?? null,
    automated: r.automated ?? false,
  };
}

function detail(v: LiveView, r: Rec) {
  const parsed = (r.parsed ?? {}) as Rec;
  return {
    ...summary(v, r),
    message_id: v.toCaseId(r.message_id ?? null),
    cc: addrList(parsed.cc).map(v.toCase),
    body_text: String(parsed.body_text ?? r.body_text ?? ''),
    in_reply_to: v.toCaseId(parsed.in_reply_to ?? []),
    references: v.toCaseId(parsed.references ?? []),
    attachments: ((parsed.attachments ?? []) as Rec[]).map((a) => ({ filename: a.filename ?? null, content_type: a.content_type ?? null, part_index: a.part_index ?? null, size_bytes: a.size_bytes ?? 0 })),
    auth: { spf: r.auth?.spf ?? null, dmarc: r.auth?.dmarc ?? null, dkim: ((r.auth?.dkimSignatures ?? []) as Rec[]).map((s) => s.result) },
  };
}

function sentDetail(v: LiveView, s: Rec) {
  return {
    id: s.id,
    thread_id: s.thread_id ?? null,
    direction: 'outbound',
    from: v.toCase(String(s.from_header ?? s.from_address ?? '')),
    to: v.toCase(String(s.to_header ?? s.to_address ?? '')),
    cc: ((s.cc ?? []) as string[]).map(v.toCase),
    subject: s.subject ?? null,
    created_at: v.timeOf(String(s.id)),
    status: s.status ?? null,
    message_id: v.toCaseId(s.message_id ?? null),
    in_reply_to: v.toCaseId(s.in_reply_to ?? null),
    body_text: String(s.body_text ?? ''),
  };
}

/** The trigger message as Primitive's EmailDetail. */
export async function liveTriggerDetail(mb: Mailbox) {
  const v = mb.live!;
  const row = v.byM.get(mb.trigger.id)!;
  if (row.direction === 'outbound') return sentDetail(v, (await v.client.getSentEmail(row.sent_id)) ?? {});
  return detail(v, (await v.client.getEmail(row.inbound_id!)) ?? {});
}

const inCase = (v: LiveView, id: unknown) => typeof id === 'string' && v.idToM.has(id);

/** One read tool call against real Primitive, scoped to the case. Same tool names and inputs as the replay. */
export async function liveTool(mb: Mailbox, name: string, input: Record<string, unknown>): Promise<unknown> {
  const v = mb.live!;
  const limit = Math.min(Number(input.limit ?? 20) || 20, 50);
  const scripted = (rows: Rec[]) => rows.filter((r) => inCase(v, r.id));
  switch (name) {
    case 'list_inbox': {
      const offset = Number(input.offset ?? 0) || 0;
      const rows = scripted(await v.client.listInbox({ recipient: v.self, dateFrom: v.since, limit: 100 }));
      return { data: rows.slice(offset, offset + limit).map((r) => summary(v, r)), meta: { total: rows.length } };
    }
    case 'search_inbox': {
      const rows = scripted(await v.client.searchInbox({ q: String(input.q ?? ''), to: v.self, dateFrom: v.since, limit: 50 }));
      return { data: rows.slice(0, limit).map((r) => summary(v, r)) };
    }
    case 'list_sent': {
      const ours = [...v.byM.values()].filter((x) => x.direction === 'outbound').reverse().slice(0, limit);
      const rows = await Promise.all(ours.map((x) => v.client.getSentEmail(x.sent_id)));
      return { data: rows.filter((r): r is Rec => !!r).map((s) => { const d = sentDetail(v, s); return { id: d.id, thread_id: d.thread_id, to: d.to, subject: d.subject, created_at: d.created_at, body_preview: d.body_text.slice(0, 200) }; }) };
    }
    case 'get_email': {
      if (!inCase(v, input.id)) return { error: 'not_found' };
      const m = v.byM.get(v.idToM.get(String(input.id))!)!;
      if (m.direction === 'outbound') return sentDetail(v, (await v.client.getSentEmail(m.sent_id)) ?? {});
      const r = await v.client.getEmail(String(input.id));
      return r ? detail(v, r) : { error: 'not_found' };
    }
    case 'get_thread': {
      const id = String(input.thread_id ?? '');
      if (!v.threads.has(id)) return { error: 'not_found' };
      const t = await v.client.getThread(id);
      if (!t) return { error: 'not_found' };
      const msgs = ((t.messages ?? []) as Rec[]).filter((x) => inCase(v, x.id));
      return {
        id: t.id, subject: t.subject ?? null, message_count: msgs.length,
        messages: msgs.map((x) => ({ id: x.id, direction: x.direction, from: v.toCase(String(x.from ?? '')), to: v.toCase(String(x.to ?? '')), subject: x.subject ?? null, timestamp: v.timeOf(String(x.id)) })),
      };
    }
    case 'get_conversation': {
      if (!inCase(v, input.email_id)) return { error: 'not_found' };
      const conv = await v.client.getConversation(String(input.email_id));
      if (!conv) return { error: 'not_found' };
      const msgs = ((conv.messages ?? []) as Rec[]).filter((x) => inCase(v, x.id));
      return {
        thread_id: conv.thread_id ?? null, truncated: !!conv.truncated,
        messages: msgs.map((x) => ({ id: x.id, role: x.role, direction: x.direction, from: v.toCase(String(x.from ?? '')), to: v.toCase(String(x.to ?? '')), subject: x.subject ?? null, timestamp: v.timeOf(String(x.id)), text: String(x.text ?? '') })),
      };
    }
    case 'get_attachment': {
      if (!inCase(v, input.email_id)) return { error: 'not_found' };
      const m = v.byM.get(v.idToM.get(String(input.email_id))!)!;
      if (m.direction !== 'inbound') return { error: 'not_found' };
      const r = await v.client.getEmail(m.inbound_id!);
      const a = ((r?.parsed?.attachments ?? []) as Rec[]).find((x) => x.filename === input.filename);
      if (!a) return { error: 'not_found' };
      const bytes = await v.client.downloadAttachment(m.inbound_id!, Number(a.part_index ?? 0));
      return { filename: a.filename, text: attachmentText(String(a.filename), String(a.content_type ?? ''), bytes) };
    }
  }
  return { error: `unknown tool ${name}` };
}

// ------------------------------------------------------------------ Continuity's input, the production way

/** Every message of the case as Continuity's ingestion would receive it from Primitive. */
export async function liveEventInputs(mb: Mailbox, taskId: string): Promise<{ m: string; input: EventInput }[]> {
  const v = mb.live!;
  const out: { m: string; input: EventInput }[] = [];
  for (const m of mb.messages) {
    const row = v.byM.get(m.id)!;
    if (row.direction === 'outbound') {
      const s = (await v.client.getSentEmail(row.sent_id)) ?? {};
      out.push({
        m: m.id,
        input: {
          source: 'primitive', dedupe_key: `primitive:sent:${s.id ?? row.sent_id}`, primitive_email_id: null,
          thread_id: s.thread_id ?? row.thread_id, message_id: s.message_id ?? row.message_id, in_reply_to: s.in_reply_to ?? null,
          references: String(s.email_references ?? '').split(/\s+/).filter(Boolean),
          direction: 'outbound', from: mb.case.task.self_address.toLowerCase(), to: [v.toCase(String(s.to_address ?? ''))], cc: ((s.cc ?? []) as string[]).map(v.toCase),
          subject: String(s.subject ?? m.event.subject), body_text: String(s.body_text ?? ''), occurred_at: row.scripted_at, received_at: row.scripted_at,
          attachments: [], task_id: taskId,
        },
      });
      continue;
    }
    const d = await v.client.getEmail(row.inbound_id!);
    if (!d) throw new Error(`${mb.case.id}/${m.id}: inbound row ${row.inbound_id} not found`);
    // auth is judged on the real From address before anything is mapped back
    const input = fromPrimitiveEmailDetail(d);
    const bytesFor = new Map<number, Buffer>();
    for (const a of input.attachments ?? []) bytesFor.set(a.part_index, await v.client.downloadAttachment(row.inbound_id!, a.part_index));
    out.push({
      m: m.id,
      input: {
        ...input,
        from: v.toCase(input.from),
        to: input.to.map(v.toCase),
        cc: (input.cc ?? []).map(v.toCase),
        occurred_at: row.scripted_at,
        received_at: row.scripted_at,
        time_flags: [], // judged against Primitive's real receipt time, which the case clock replaces
        attachments: (input.attachments ?? []).map((a) => ({ ...a, content_base64: bytesFor.get(a.part_index)?.toString('base64') })),
        raw: { primitive_email_id: d.id, thread_id: d.thread_id ?? null },
      },
    });
  }
  return out;
}
