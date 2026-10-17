// Continuity: replay the mailbox through the real engine and hand the actor the compiled briefing.
//
// Replay substitutes only the transport. Inbound mail becomes a Primitive `email.received` webhook
// payload (same shape as the SDK schema, SDK-signed in the sim) and goes through the production
// normaliser, linker, extractor, resolver and compiler. Our own outbound mail is recorded the way a
// send through Continuity is. The whole inbox is replayed, unrelated mail included, so Continuity
// has to do its own task linkage (the baselines are handed ground-truth membership).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Condition, ConditionCtx, Prepared } from './types.ts';
import type { Mailbox, MailMessage } from '../core/mailbox.ts';
import type { CallRecord } from '../core/llm.ts';
import { costUsd } from '../core/llm.ts';
import { Harness } from '../../src/sim/harness.ts';
import { makePdf } from '../../src/sim/pdf.ts';
import { fromPrimitiveWebhook } from '../../src/ingest/normalize.ts';
import { compileContext } from '../../src/compiler/compile.ts';
import { renderBriefing } from '../../src/compiler/render.ts';
import { heuristicExtractor } from '../../src/extract/heuristic.ts';
import { llmExtractor } from '../../src/extract/llm.ts';
import { domainFor, registeredDomains } from '../../src/domain/index.ts';
import type { EventInput, TaskSpec } from '../../src/types.ts';
import { isOpenStatus } from '../../src/types.ts';
import type { AgentOutput, ConflictKind } from '../core/types.ts';
import type { Extractor } from '../../src/extract/types.ts';

function taskSpec(mb: Mailbox, domain: string): TaskSpec {
  const t = mb.case.task;
  return {
    id: t.id, alias: t.alias, goal: t.goal, item: t.item, self_address: t.self_address, domain,
    participants: t.parties.map((p) => ({ address: p.address, name: p.name, role: p.role, label: p.label, authority: p.authority, group: p.group })),
    requirements: t.requirements,
  };
}

function attachmentBytes(a: MailMessage['attachments'][number]): Buffer {
  return a.content_type === 'application/pdf' ? makePdf(a.lines) : Buffer.from(a.text, 'utf8');
}

/** A Primitive `email.received` webhook payload for one inbound message (shape of SimMailbox.inbound). */
function webhookPayload(m: MailMessage) {
  const e = m.event;
  const domain = e.from.split('@')[1];
  const ok = e.auth !== 'fail';
  const attachments = m.attachments.map((a, i) => {
    const bytes = attachmentBytes(a);
    return { filename: a.filename, content_type: a.content_type, size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), part_index: i, tar_path: `${i}_${a.filename}`, content_base64: bytes.toString('base64') };
  });
  return {
    id: `evt_${createHash('sha256').update(m.message_id).digest('hex')}`,
    event: 'email.received',
    version: '2025-12-14',
    delivery: { endpoint_id: 'ep_bench', attempt: 1, attempted_at: e.at },
    email: {
      id: `bench_em_${m.id}_${createHash('sha256').update(m.message_id).digest('hex').slice(0, 12)}`,
      received_at: e.at,
      smtp: { helo: domain, mail_from: e.from, rcpt_to: e.to },
      headers: { message_id: m.message_id, subject: e.subject, from: `${e.fromName} <${e.from}>`, to: e.to.join(', '), date: new Date(e.at).toUTCString() },
      content: { raw: { included: false, reason_code: 'size_exceeded', max_inline_bytes: 262144, size_bytes: 0, sha256: '0'.repeat(64) }, download: { url: 'https://localhost.invalid/raw', expires_at: e.at } },
      parsed: {
        status: 'complete', error: null, body_text: m.body, body_html: null, reply_to: null,
        cc: e.cc?.length ? e.cc.map((address) => ({ address, name: null })) : null, bcc: null,
        to_addresses: e.to.map((address) => ({ address, name: null })),
        in_reply_to: m.in_reply_to ? [m.in_reply_to] : null,
        references: m.references.length ? m.references : null,
        attachments, attachments_download_url: null,
      },
      analysis: { sender: { authenticated: ok, basis: ok ? 'dmarc_aligned' : 'none', reasons: ['bench replay'] } },
      auth: { spf: ok ? 'pass' : 'fail', dmarc: ok ? 'pass' : 'fail', dmarcPolicy: 'none', dmarcFromDomain: domain, dmarcSpfAligned: ok, dmarcDkimAligned: ok, dmarcSpfStrict: false, dmarcDkimStrict: false, dkimSignatures: [] },
      thread_id: m.thread_id,
    },
  };
}

function outboundInput(m: MailMessage, taskId: string): EventInput {
  const e = m.event;
  return {
    source: 'local-sim', dedupe_key: `out:${m.message_id}`, thread_id: m.thread_id, message_id: m.message_id, in_reply_to: m.in_reply_to, references: m.references,
    direction: 'outbound', from: e.from, to: e.to, cc: e.cc ?? [], subject: e.subject, body_text: m.body, occurred_at: e.at, received_at: e.at,
    attachments: [], task_id: taskId,
  };
}

/** Wraps an extractor: caches proposals on disk (per trial) and records provider usage as ingestion cost. */
function metered(inner: Extractor, cacheDir: string, trial: number, calls: CallRecord[]): Extractor {
  mkdirSync(cacheDir, { recursive: true });
  return {
    name: inner.name,
    async extract(input) {
      const key = createHash('sha256').update(JSON.stringify({ x: inner.name, trial, input: { ...input, event: { ...input.event, id: undefined, seq: undefined } } })).digest('hex');
      const file = join(cacheDir, `extract-${key}.json`);
      const started = Date.now();
      let proposal;
      let cached = false;
      if (existsSync(file)) {
        proposal = JSON.parse(readFileSync(file, 'utf8'));
        cached = true;
      } else {
        proposal = await inner.extract(input);
        writeFileSync(file, JSON.stringify(proposal));
      }
      const u = proposal.meta?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      if (u && proposal.meta?.model) {
        const usage = { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 };
        calls.push({ purpose: 'extractor', model: proposal.meta.model, usage, cost_usd: costUsd(proposal.meta.model, usage), cached, ms: Date.now() - started });
      }
      return proposal;
    },
  };
}


/** Which term a failing check is about, per domain pack (check ids are "<kind>:<party>"). */
const CHECK_TERMS: Record<string, Record<string, { kind: ConflictKind; term: string }>> = {
  procurement: {
    delivery_deadline: { kind: 'requirement_violation', term: 'delivery.schedule' },
    quantity: { kind: 'requirement_violation', term: 'delivery.schedule' },
    price_budget: { kind: 'requirement_violation', term: 'price.unit' },
    budget_approval: { kind: 'requirement_violation', term: 'budget.max_unit_price' },
    offer_available: { kind: 'offer_unavailable', term: 'offer.status' },
  },
  freight: {
    pickup_window: { kind: 'requirement_violation', term: 'pickup.window' },
    deliver_by: { kind: 'requirement_violation', term: 'delivery.eta' },
    equipment: { kind: 'requirement_violation', term: 'equipment.type' },
    reefer_temp: { kind: 'requirement_violation', term: 'equipment.reefer_temp_f' },
    max_all_in: { kind: 'requirement_violation', term: 'rate.all_in' },
    loads: { kind: 'requirement_violation', term: 'capacity.loads' },
    all_picked_up_by: { kind: 'requirement_violation', term: 'capacity.loads' },
    budget_approval: { kind: 'requirement_violation', term: 'budget.max_all_in' },
    offer_available: { kind: 'offer_unavailable', term: 'offer.status' },
  },
  hotel: {
    block: { kind: 'requirement_violation', term: 'block.rooms' },
    max_rate: { kind: 'requirement_violation', term: 'rate.group' },
    min_attrition: { kind: 'requirement_violation', term: 'attrition.allowance' },
    cutoff: { kind: 'requirement_violation', term: 'cutoff.date' },
    max_fnb_minimum: { kind: 'requirement_violation', term: 'fnb.minimum' },
    budget_approval: { kind: 'requirement_violation', term: 'budget.max_rate' },
    offer_available: { kind: 'offer_unavailable', term: 'offer.status' },
  },
  finance: {
    three_way_match: { kind: 'requirement_violation', term: 'invoice.quantity' },
    po_amount: { kind: 'requirement_violation', term: 'invoice.amount' },
    max_amount: { kind: 'requirement_violation', term: 'invoice.amount' },
    payment_run: { kind: 'requirement_violation', term: 'discount.deadline' },
    verified_remit_to: { kind: 'unverified_change', term: 'payment.remit_to' },
    offer_available: { kind: 'offer_unavailable', term: 'offer.status' },
  },
  legal: {
    liability_cap: { kind: 'requirement_violation', term: 'liability.cap_months_fees' },
    governing_law: { kind: 'requirement_violation', term: 'governing.law' },
    termination_notice: { kind: 'requirement_violation', term: 'termination.convenience_notice_days' },
    renewal_term: { kind: 'requirement_violation', term: 'renewal.auto' },
    renewal_notice: { kind: 'requirement_violation', term: 'renewal.notice_days' },
    dpa: { kind: 'requirement_violation', term: 'dpa.status' },
    fully_executed_by: { kind: 'requirement_violation', term: 'signature.status' },
    offer_available: { kind: 'offer_unavailable', term: 'offer.status' },
  },
};

/**
 * Continuity's own state, read straight from the engine and mapped onto the report schema. Scoring it
 * is the representation experiment: how right is the state before any actor reads it?
 */
function engineReport(h: Harness, context: ReturnType<typeof compileContext>, idOf: Map<string, string>, domain: string): AgentOutput {
  const ids = (evs: (string | null | undefined)[]) => [...new Set(evs.filter((e): e is string => !!e).map((e) => idOf.get(e) ?? e))];
  const evidenceOf = (claimId: string, source: string) => ids([source, ...h.store.claimEvidence(claimId).map((r) => r.event_id)]);
  const claims = h.claims();
  const pack = domainFor(domain);
  const subjectOf = (o: ReturnType<Harness['obligations']>[number]) => pack.loopSubject?.(o)
    ?? (o.expects_artifact ? `document.${o.expects_artifact}` : o.kind === 'commitment' && o.quantity != null ? 'delivery.remaining_units' : o.issue_key ?? o.topic_keys[0] ?? 'other');
  const conflicts: AgentOutput['conflicts'] = [];
  for (const c of h.checks().filter((x) => x.status === 'fail')) {
    const m = CHECK_TERMS[domain]?.[c.id.split(':')[0]];
    if (m) conflicts.push({ kind: m.kind, term: m.term, description: c.detail });
  }
  for (const key of new Set(claims.filter((c) => c.status === 'contested').map((c) => c.key))) conflicts.push({ kind: 'contradiction', term: key, description: 'contested' });
  for (const c of claims.filter((x) => x.status === 'proposed')) {
    const active = claims.find((a) => a.key === c.key && a.status === 'active');
    if (!active || JSON.stringify(active.value) !== JSON.stringify(c.value)) conflicts.push({ kind: 'unverified_change', term: c.key, description: `tentative ${c.display} from ${c.speaker}` });
  }
  return {
    current_terms: claims.filter((c) => c.status === 'active' || c.status === 'contested').map((c) => ({
      party: c.speaker, term: c.key, value_json: JSON.stringify(c.value), status: c.status === 'active' ? 'current' : 'contested', source_ids: evidenceOf(c.id, c.source_event_id),
    })),
    superseded_terms: claims.filter((c) => c.status === 'superseded' || c.status === 'retracted').map((c) => ({ party: c.speaker, term: c.key, value_json: JSON.stringify(c.value), source_ids: ids([c.source_event_id]) })),
    open_loops: h.obligations().filter((o) => isOpenStatus(o.status)).map((o) => ({
      kind: o.kind, owed_by: o.debtor, subject: subjectOf(o), description: o.text, source_ids: ids([o.source_event_id]),
    })),
    conflicts,
    documents: context.documents.map((d: { filename: string; status: string; stale_terms: { term: string }[] }) => ({ filename: d.filename, status: d.status as AgentOutput['documents'][number]['status'], stale_terms: d.stale_terms.map((t) => t.term) })),
    next_actor: context.next_actor === 'us' ? 'us' : 'them',
    decision: { action: 'wait', messages: [], rationale: 'engine state only' },
  };
}

async function replay(mb: Mailbox, ctx: ConditionCtx, extractor: Extractor) {
  const domain = ctx.vertical.continuityDomain;
  const spec = taskSpec(mb, domain!);
  const first = mb.messages[0]?.event.at ?? mb.now;
  const created = new Date(Date.parse(first) - 60_000).toISOString();
  const h = new Harness(spec, extractor, created);
  await h.ready;
  const idOf = new Map<string, string>(); // ev_N -> m07
  for (const m of mb.messages) {
    const input = m.event.direction === 'outbound' ? outboundInput(m, spec.id) : fromPrimitiveWebhook(webhookPayload(m));
    const res = await h.ingest(input);
    idOf.set(res.event.id, m.id);
  }
  const context = compileContext(h.store, spec.id, { agentId: 'bench-fresh-agent', now: mb.now });
  const rewrite = (s: string) => s.replace(/\bev_\d+\b/g, (id) => idOf.get(id) ?? id);
  const briefing = rewrite(renderBriefing(context));
  const engineState = engineReport(h, context, idOf, domain!);
  const linked = new Set(h.store.eventsForTask(spec.id).map((e) => idOf.get(e.id)));
  const linkage = {
    task_linked: mb.messages.filter((m) => m.task && linked.has(m.id)).length,
    task_total: mb.messages.filter((m) => m.task).length,
    background_linked: mb.messages.filter((m) => !m.task && linked.has(m.id)).length,
    background_total: mb.messages.filter((m) => !m.task).length,
  };
  return { briefing, engineState, linkage };
}

function continuityCondition(id: string, label: string, description: string, pick: (ctx: ConditionCtx) => Extractor): Condition {
  return {
    id, label, description, usesModel: id === 'continuity',
    async prepare(mb, ctx): Promise<Prepared> {
      const domain = ctx.vertical.continuityDomain;
      if (!domain || !registeredDomains().includes(domain)) {
        return { label: 'briefing', memory: '', ingestion: [], retrieval: [], unsupported: `no Continuity domain pack "${domain}" for vertical ${ctx.vertical.id}` };
      }
      const calls: CallRecord[] = [];
      const extractor = metered(pick(ctx), join(ctx.cacheDir, 'extractions'), ctx.trial, calls);
      const { briefing, engineState, linkage } = await replay(mb, ctx, extractor);
      return { label: 'briefing', memory: briefing, ingestion: calls, retrieval: [], engineState, diag: { extractor: extractor.name, linkage } };
    },
  };
}

export const continuity = continuityCondition(
  'continuity',
  'Continuity (model extractor)',
  'The whole inbox replayed through the engine (model extractor → deterministic resolver → compiler); the actor gets the compiled briefing.',
  (ctx) => (ctx.mock ? heuristicExtractor : llmExtractor({ model: ctx.llm.model })),
);

export const continuityRules = continuityCondition(
  'continuity-rules',
  'Continuity (rule extractor)',
  'Same as Continuity, with the offline rule-based extractor (no model at ingestion). Diagnostic: how much depends on the extractor.',
  () => heuristicExtractor,
);
