// Primitive-native: a competent agent with Primitive's own read tools and a fixed call budget. It
// starts with the task header and the new message (including Primitive's thread-level `awaiting`)
// and decides what to read. The tools mirror @primitivedotdev/sdk v2.4.0 shapes, served from the
// replayed mailbox so the run is deterministic:
//   list_inbox   ~ GET /emails            (inbound only; EmailSummary with thread-level `awaiting`)
//   search_inbox ~ GET /emails/search     (inbound only; full-text)
//   list_sent    ~ GET /sent-emails
//   get_email    ~ GET /emails/{id}       (EmailDetail: parsed body, in_reply_to, references, attachments meta, auth)
//   get_thread   ~ GET /threads/{id}      (messages without bodies)
//   get_conversation ~ GET /emails/{id}/conversation (thread with message text)
//   get_attachment   ~ GET /emails/{id}/attachments/{part} (text extracted from the part)
// After the tool phase, everything the agent read is handed to the shared actor as its memory, so the
// final answer goes through exactly the same prompt and schema as every other condition.
import type { Condition } from './types.ts';
import type { Mailbox } from '../core/mailbox.ts';
import { emailDetail, emailSummary, taskHeader } from '../core/mailbox.ts';
import type { CallRecord } from '../core/llm.ts';
import { bm25 } from '../core/bm25.ts';

export const TOOL_BUDGET = 6;

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  name, description, input_schema: { type: 'object', additionalProperties: false, properties, required },
});

const TOOLS = [
  tool('list_inbox', 'List received emails, newest first (Primitive GET /emails). Inbound only.', { limit: { type: 'integer' }, offset: { type: 'integer' } }),
  tool('search_inbox', 'Full-text search over received emails (subject, body, sender). Inbound only (Primitive GET /emails/search).', { q: { type: 'string' }, limit: { type: 'integer' } }, ['q']),
  tool('list_sent', 'List emails we sent, newest first.', { limit: { type: 'integer' } }),
  tool('get_email', 'Get one email with its full body, threading headers, attachment list and auth results.', { id: { type: 'string' } }, ['id']),
  tool('get_thread', 'Get a thread: its messages in order, without bodies.', { thread_id: { type: 'string' } }, ['thread_id']),
  tool('get_conversation', 'Get the whole thread of an email with every message body.', { email_id: { type: 'string' } }, ['email_id']),
  tool('get_attachment', 'Get the text content of one attachment of an email.', { email_id: { type: 'string' }, filename: { type: 'string' } }, ['email_id', 'filename']),
];

function runTool(mb: Mailbox, name: string, input: Record<string, unknown>): unknown {
  const visible = mb.messages; // the inbox as of the checkpoint (task and unrelated mail)
  const inbound = visible.filter((m) => m.event.direction === 'inbound').reverse();
  const sent = visible.filter((m) => m.event.direction === 'outbound').reverse();
  const limit = Math.min(Number(input.limit ?? 20) || 20, 50);
  const find = (id: unknown) => mb.byId.get(String(id));
  switch (name) {
    case 'list_inbox': {
      const offset = Number(input.offset ?? 0) || 0;
      return { data: inbound.slice(offset, offset + limit).map((m) => emailSummary(mb, m)), meta: { total: inbound.length } };
    }
    case 'search_inbox': {
      const ranked = bm25(inbound.map((m) => `${m.event.subject}\n${m.event.from} ${m.event.fromName}\n${m.body}`), String(input.q ?? ''));
      return { data: ranked.filter((r) => r.score > 0).slice(0, limit).map((r) => emailSummary(mb, inbound[r.index])) };
    }
    case 'list_sent':
      return { data: sent.slice(0, limit).map((m) => ({ id: m.id, thread_id: m.thread_id, to: m.event.to, subject: m.event.subject, created_at: m.event.at, body_preview: m.event.body.slice(0, 200) })) };
    case 'get_email': {
      const m = find(input.id);
      return m ? emailDetail(mb, m) : { error: 'not_found' };
    }
    case 'get_thread': {
      const msgs = visible.filter((m) => m.thread_id === String(input.thread_id));
      if (!msgs.length) return { error: 'not_found' };
      return { id: input.thread_id, subject: msgs[0].event.subject, message_count: msgs.length, messages: msgs.map((m) => ({ id: m.id, direction: m.event.direction, from: m.event.from, to: m.event.to, subject: m.event.subject, timestamp: m.event.at })) };
    }
    case 'get_conversation': {
      const m = find(input.email_id);
      if (!m) return { error: 'not_found' };
      const msgs = visible.filter((x) => x.thread_id === m.thread_id);
      return { thread_id: m.thread_id, messages: msgs.map((x) => ({ id: x.id, role: x.event.direction === 'inbound' ? 'user' : 'assistant', from: x.event.from, timestamp: x.event.at, text: x.event.body, attachments: x.attachments.map((a) => a.filename) })) };
    }
    case 'get_attachment': {
      const m = find(input.email_id);
      const a = m?.attachments.find((x) => x.filename === input.filename);
      return a ? { filename: a.filename, text: a.text } : { error: 'not_found' };
    }
  }
  return { error: `unknown tool ${name}` };
}

const TOOL_SYSTEM = `You are about to take over an email-based business task with no memory of it. You have read-only mailbox tools (Primitive). Use them to gather whatever you need to understand where the task stands: current terms, what changed, what is still owed, documents. You may make at most ${TOOL_BUDGET} tool calls in total. When you have enough, reply with the single word DONE.`;

export const primitiveNative: Condition = {
  id: 'primitive-native',
  label: 'Primitive-native tools',
  description: `Task header + new message (with Primitive's thread-level awaiting), then up to ${TOOL_BUDGET} calls to Primitive-shaped read tools (list/search inbox, sent, email, thread, conversation, attachment). Everything read becomes the memory.`,
  usesModel: true,
  async prepare(mb, ctx) {
    const header = taskHeader(mb);
    const trig = mb.trigger;
    const start = `${header}\n\nNew message (Primitive EmailDetail):\n${JSON.stringify(emailDetail(mb, trig), null, 1)}\n\nGather what you need, then reply DONE.`;
    const messages: { role: 'user' | 'assistant'; content: unknown }[] = [{ role: 'user', content: start }];
    const calls: CallRecord[] = [];
    const reads: string[] = [];
    let used = 0;
    for (let turn = 0; turn < TOOL_BUDGET + 2; turn++) {
      const res = await ctx.llm.complete({ purpose: 'tool-agent', system: TOOL_SYSTEM, messages, tools: TOOLS, effort: 'medium', trial: ctx.trial, maxTokens: 8000 });
      calls.push(res.record);
      const uses = res.content.filter((b) => b.type === 'tool_use') as { type: string; id: string; name: string; input: Record<string, unknown> }[];
      if (!uses.length) break;
      messages.push({ role: 'assistant', content: res.content });
      const results = uses.map((u) => {
        if (used >= TOOL_BUDGET) return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Tool budget exhausted. Reply DONE.' };
        used++;
        const out = JSON.stringify(runTool(mb, u.name, u.input ?? {}), null, 1);
        reads.push(`### ${u.name}(${JSON.stringify(u.input ?? {})})\n${out}`);
        return { type: 'tool_result', tool_use_id: u.id, content: out };
      });
      messages.push({ role: 'user', content: results });
    }
    return {
      label: 'mailbox_reads',
      memory: reads.length ? reads.join('\n\n') : '(no tool calls made)',
      ingestion: [],
      retrieval: calls,
      diag: { tool_calls: used, tools: reads.map((r) => r.slice(4, r.indexOf('('))) },
    };
  },
};
