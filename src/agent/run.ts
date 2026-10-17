// Agent process. It reaches Continuity over HTTP only and has no access to the event store.
//
//   node src/agent/run.ts --task PO-4817 --agent agent-b --once        # cold start, act once, exit
//   node src/agent/run.ts --task PO-4817 --agent agent-a --watch       # long-running, wakes on new mail
//
// On every wake: fetch the compiled context → decide (LLM when ANTHROPIC_API_KEY is set, offline
// policy otherwise) → POST /send per message with its declared intent (guarded and threaded by
// Continuity; a 202 means a human must approve it, and the plan stops there) → move the cursor
// forward → record the run. While the next actor is a human, the agent does not act.
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { policyDecide, type Decision } from './policy.ts';
import { llmDecide } from './llm-agent.ts';
import type { CompiledContext } from '../compiler/compile.ts';

const { values: args } = parseArgs({
  options: {
    task: { type: 'string', default: 'PO-4817' },
    agent: { type: 'string', default: `agent-${randomUUID().slice(0, 6)}` },
    api: { type: 'string', default: process.env.CONTINUITY_URL || 'http://localhost:4100' },
    mode: { type: 'string', default: process.env.ANTHROPIC_API_KEY ? 'llm' : 'policy' },
    once: { type: 'boolean', default: false },
    watch: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  },
});
const api = args.api!;
const agentId = args.agent!;
const taskPath = `/tasks/${encodeURIComponent(args.task!)}`;
const tag = `[${agentId} pid ${process.pid}]`;
const log = (...parts: unknown[]) => console.log(tag, ...parts);

const token = process.env.CONTINUITY_TOKEN || '';
const contextBudget = process.env.CONTINUITY_CONTEXT_BUDGET ? Number(process.env.CONTINUITY_CONTEXT_BUDGET) : null;

const POLL_MS = 1500;
const MAX_CATCH_UP_MS = 120_000;

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${json.error}`), { status: res.status, detail: json.detail });
  return json as T;
}

/** What this process itself remembers. Empty at start and never consulted when deciding — it is logged to prove that. */
const conversationMemory: unknown[] = [];

type ContextResponse = {
  context: CompiledContext;
  briefing: string;
  briefing_tokens: number;
  transcript_tokens: number;
  state_version: number;
  processing_complete?: boolean;
  context_digest?: string;
  budget?: unknown;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function wake(reason: string) {
  const startedAt = new Date().toISOString();
  const fetchContext = () => http<ContextResponse>('GET', `${taskPath}/context?agent=${agentId}&purpose=act${contextBudget ? `&max_tokens=${contextBudget}` : ''}`);
  const stillCatchingUp = (c: ContextResponse) => c.processing_complete === false || c.context.meta.pending_events.length > 0;

  // never decide on a state that has not yet absorbed mail that already arrived
  let r = await fetchContext();
  for (let waited = 0; stillCatchingUp(r) && waited < MAX_CATCH_UP_MS; waited += POLL_MS) {
    if (waited === 0) log(`state is catching up (${JSON.stringify(r.context.processing ?? { pending_events: r.context.meta.pending_events })}) — waiting`);
    await sleep(POLL_MS);
    r = await fetchContext();
  }
  if (stillCatchingUp(r)) {
    // running out of patience does not make half-interpreted state safe to act on
    log('state is still incomplete after waiting — not acting this wake');
    await http('POST', `${taskPath}/agent-runs`, {
      agent_id: agentId, started_at: startedAt, mode: args.mode, purpose: 'act', state_version: r.state_version, context_digest: r.context_digest ?? null, context: r.context, briefing: r.briefing,
      context_tokens: r.briefing_tokens, transcript_tokens: r.transcript_tokens, budget: r.budget ?? null,
      decision: { action: 'wait', rationale: 'processing incomplete', wake_reason: reason, pid: process.pid }, actions: [],
    });
    return r.state_version;
  }

  const ctx = r.context;
  log(`wake (${reason}) — prior conversation messages in this process: ${conversationMemory.length}`);
  log(`compiled context v${ctx.meta.state_version}: ~${r.briefing_tokens} tokens (full transcript would be ~${r.transcript_tokens}); next actor: ${ctx.next_actor}`);
  if (!args.quiet) {
    for (const a of ctx.suggested_actions) log(`  P${a.priority} ${a.action}`);
  }

  if (ctx.next_actor === 'human') {
    // a person has the next move (a held commitment, a detail to verify): do not act around them
    log(`waiting on a human — not acting this wake: ${ctx.next_actor_reason}`);
    await http('POST', `${taskPath}/agent-runs`, {
      agent_id: agentId, started_at: startedAt, mode: args.mode, purpose: 'act', state_version: r.state_version, context_digest: r.context_digest ?? null, context: ctx, briefing: r.briefing,
      context_tokens: r.briefing_tokens, transcript_tokens: r.transcript_tokens, budget: r.budget ?? null,
      decision: { action: 'wait', rationale: ctx.next_actor_reason, wake_reason: reason, pid: process.pid }, actions: [],
    });
    return r.state_version;
  }

  let mode = args.mode!;
  let decision: Decision;
  try {
    decision = mode === 'llm' ? await llmDecide(r.briefing, undefined, ctx.meta.domain) : policyDecide(ctx);
  } catch (err) {
    log(`LLM decision failed (${(err as Error).message}); falling back to offline policy`);
    mode = 'policy(fallback)';
    decision = policyDecide(ctx);
  }
  log(`decision: ${decision.action} — ${decision.rationale}`);

  const sent: string[] = [];
  const blocked: unknown[] = [];
  const held: unknown[] = [];
  const actions: { action_id?: string; approval_id?: string; to: string; status: string; error?: string }[] = [];
  for (let i = 0; i < decision.messages.length; i++) {
    const m = decision.messages[i];
    if (blocked.length) {
      // later messages in this plan assumed the refused one went out, so they stay unsent
      log(`not sending remaining ${decision.messages.length - i} message(s): an earlier send in this plan was refused`);
      blocked.push(...decision.messages.slice(i).map((x) => ({ to: x.to, error: 'skipped: earlier send in the same plan was refused' })));
      break;
    }
    try {
      // based_on_version pins the state this decision saw; the server refuses if it moved since
      const s = await http<{ event_id: string; transport: { mode: string }; subject: string; action_id: string; status: string; held?: boolean; approval_id?: string; title?: string; reasons?: string[] }>('POST', `${taskPath}/send`, {
        agent_id: agentId, to: m.to, subject: m.subject, body: m.body, intent: m.intent, based_on_version: ctx.meta.state_version,
      });
      if (s.held) {
        // 202: a human decides this one; the rest of the plan assumed it went out, so stop here
        held.push({ to: m.to, approval_id: s.approval_id, reasons: s.reasons });
        actions.push({ approval_id: s.approval_id, to: m.to, status: 'held' });
        log(`held for a human: ${s.approval_id} "${s.title}" — ${s.reasons?.join('; ')}`);
        if (!args.quiet) console.log(m.body.split('\n').map((l) => `    | ${l}`).join('\n'));
        if (decision.messages.length > i + 1) log(`not sending remaining ${decision.messages.length - i - 1} message(s) until the human decides`);
        break;
      }
      sent.push(s.event_id);
      actions.push({ action_id: s.action_id, to: m.to, status: s.status });
      log(`sent ${s.event_id} to ${m.to} via ${s.transport?.mode ?? '?'} (${s.status}, ${s.action_id}): "${s.subject}"`);
      if (!args.quiet) console.log(m.body.split('\n').map((l) => `    | ${l}`).join('\n'));
    } catch (err) {
      const message = (err as Error).message;
      const detail = (err as { detail?: unknown }).detail;
      blocked.push({ to: m.to, error: message, detail });
      actions.push({ action_id: (detail as { action_id?: string } | undefined)?.action_id, to: m.to, status: 'refused', error: message });
      log(`send to ${m.to} refused: ${message} ${JSON.stringify(detail ?? '')}`);
    }
  }

  // move our cursor past everything we have now seen, our own sends included
  const after = await http<{ state_version: number }>('GET', `${taskPath}/changes?since=999999999`);
  await http('POST', `${taskPath}/cursor`, { agent_id: agentId, seq: after.state_version });
  await http('POST', `${taskPath}/agent-runs`, {
    agent_id: agentId, started_at: startedAt, mode, purpose: 'act', state_version: ctx.meta.state_version, context_digest: r.context_digest ?? null, budget: r.budget ?? null,
    context: ctx, briefing: r.briefing, context_tokens: r.briefing_tokens, transcript_tokens: r.transcript_tokens, usage: decision.usage ?? null, actions,
    decision: { ...decision, usage: undefined, sent, blocked, held, pid: process.pid, prior_messages_in_process_memory: conversationMemory.length, wake_reason: reason },
    sent_event_id: sent[0] ?? null,
  });
  // a long-running agent accumulates this; a fresh process always starts at 0
  conversationMemory.push({ wake: reason, sent });
  return after.state_version;
}

async function main() {
  log(`starting: task=${args.task} api=${api} decision-mode=${args.mode}`);
  let seen = await wake(args.watch ? 'startup' : 'cold start');
  if (!args.watch) return;
  for (;;) {
    const { state_version } = await http<{ state_version: number }>('GET', `${taskPath}/wait?since=${seen}&timeout_ms=25000`);
    if (state_version <= seen) continue;
    const ch = await http<{ changes: { type: string; detail: { direction?: string } }[] }>('GET', `${taskPath}/changes?since=${seen}`);
    seen = state_version;
    if (ch.changes.some((c) => c.type === 'event_ingested' && c.detail.direction === 'inbound')) seen = await wake('new inbound mail');
    else if (ch.changes.some((c) => c.type === 'obligation_overdue')) seen = await wake('a deadline passed');
    else if (ch.changes.some((c) => ['approval_decided', 'claim_verified', 'claim_rejected'].includes(c.type))) seen = await wake('a human decided');
  }
}

main().catch((err) => {
  console.error(tag, err);
  process.exit(1);
});
