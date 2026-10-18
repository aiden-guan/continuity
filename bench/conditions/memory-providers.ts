// Third-party memory layers on the same inbox: Mem0 (open source), Zep (its open-source engine, Graphiti) and Hindsight.
// Each is plugged in the way its docs show: every task email is added as it arrives (ground-truth task membership,
// generous as for the other baselines), and when the agent wakes it gets what the layer recalls for the goal plus the new
// message, capped at ~2,000 tokens like the retrieval baseline. Where a layer has a knob for what to keep, it gets the same
// one-sentence mission. All three run on the same model as Continuity (Claude Haiku 5.5, thinking off) with local
// embeddings, and every model call they make, in the foreground or in the background, is billed to the case.
//
// Services (see bench/providers/README.md): bench/providers/up.sh (FalkorDB, Hindsight ×N), bench/providers/proxy.ts,
// bench/providers/server.py (Mem0 and Graphiti).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Condition, ConditionCtx, Prepared } from './types.ts';
import type { Mailbox } from '../core/mailbox.ts';
import { renderEmail } from '../core/mailbox.ts';
import { costUsd, estimateTokens, type CallRecord, type Usage } from '../core/llm.ts';

const SIDECAR = process.env.PROVIDER_SIDECAR ?? 'http://127.0.0.1:8795';
const PROXY = process.env.PROVIDER_PROXY ?? 'http://127.0.0.1:8787';
/** tag=url pairs; the tag is the one the instance's base URL names at the proxy (up.sh). */
const HINDSIGHT = (process.env.HINDSIGHT_URLS ?? [1].map((i) => `hs${i}=http://127.0.0.1:888${i}`).join(','))
  .split(',').map((s) => { const [tag, url] = s.split('='); return { tag, url }; });
const MODEL = 'claude-haiku-5-5';
const BUDGET = 2000;
const LIMIT = 20;
/** Bump to re-ingest instead of reusing memories cached by an earlier run. */
const VERSION = 1;
/** The same sentence as MISSION in bench/providers/server.py. */
const MISSION = 'An AI agent works an email-based business deal for its company. Keep what it needs to act: the terms each party has stated (prices, quantities, dates, conditions) and which later messages changed or withdrew them, requests and promises still open and who owes them, documents sent and whether they are current, deadlines, and requirements the deal must meet.';

const taskMail = (mb: Mailbox) => mb.messages.filter((m) => m.id !== mb.trigger.id && m.task);
const queryOf = (mb: Mailbox) => `${mb.case.task.goal}\n${mb.trigger.event.subject}\n${mb.trigger.event.body}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function http<T>(method: string, url: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(600_000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 300)}`);
      return (text ? JSON.parse(text) : {}) as T;
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

type Counted = Usage & { calls?: number };
const ZERO: Counted = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const minus = (a: Counted, b: Counted): Counted => ({
  calls: (a.calls ?? 0) - (b.calls ?? 0),
  input_tokens: a.input_tokens - b.input_tokens,
  output_tokens: a.output_tokens - b.output_tokens,
  cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) - (b.cache_read_input_tokens ?? 0),
  cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) - (b.cache_creation_input_tokens ?? 0),
});
const record = (purpose: string, u: Counted, ms: number, cached: boolean): CallRecord[] => {
  if (!u.calls) return [];
  const usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0 };
  return [{ purpose, model: MODEL, usage, cost_usd: costUsd(MODEL, usage), cached, ms }];
};

/** Keep lines in rank order until the budget is spent. */
function fit<T>(rows: T[], line: (r: T) => string, budget = BUDGET): T[] {
  const out: T[] = [];
  for (const r of rows) {
    const cost = estimateTokens(line(r)) + 1;
    if (cost > budget) continue;
    budget -= cost;
    out.push(r);
  }
  return out;
}

interface Built { memory: string; ingest: Counted; recall: Counted; ingestMs: number; recallMs: number; diag: Record<string, unknown> }

/** One namespace per case, checkpoint, trial and attempt; finished memories are cached, so a rerun bills but does not re-ingest. */
function provider(id: string, label: string, description: string, memLabel: string, build: (mb: Mailbox, ns: string) => Promise<Built>): Condition {
  return {
    id, label, description, usesModel: true,
    async prepare(mb: Mailbox, ctx: ConditionCtx): Promise<Prepared> {
      if (ctx.mock) return { label: memLabel, memory: '', ingestion: [], retrieval: [], unsupported: 'mock mode: third-party providers call the model' };
      const dir = join(ctx.cacheDir, 'providers', id);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${sha(JSON.stringify({ v: VERSION, c: mb.case.id, cp: mb.checkpoint.id, trial: ctx.trial }))}.json`);
      let built: Built;
      let cached = false;
      if (!ctx.refresh && existsSync(file)) {
        built = JSON.parse(readFileSync(file, 'utf8'));
        cached = true;
      } else {
        const ns = `b${sha(`${mb.case.id}|${mb.checkpoint.id}`).slice(0, 10)}t${ctx.trial}${randomBytes(3).toString('hex')}`;
        built = await build(mb, ns);
        writeFileSync(file, JSON.stringify(built));
      }
      return {
        label: memLabel,
        memory: built.memory || '(nothing recalled)',
        ingestion: record(`${id}-ingest`, built.ingest, built.ingestMs, cached),
        retrieval: record(`${id}-recall`, built.recall, built.recallMs, cached),
        diag: { ...built.diag, ingest_calls: built.ingest.calls, recall_calls: built.recall.calls },
      };
    },
  };
}

// ------------------------------------------------------------------ Mem0 and Graphiti (the Python sidecar)

const sidecarUsage = (ns: string) => http<Counted>('GET', `${SIDECAR}/usage/${ns}`);

async function ingestSidecar(kind: 'mem0' | 'graphiti', mb: Mailbox, ns: string) {
  const started = Date.now();
  for (const m of taskMail(mb)) await http('POST', `${SIDECAR}/${kind}/add`, { ns, content: renderEmail(m), timestamp: m.event.at, name: m.id });
  return { ingest: await sidecarUsage(ns), ingestMs: Date.now() - started };
}

interface Mem0Row { text: string; score: number; metadata?: { date?: string; source?: string } }

export const mem0: Condition = provider(
  'mem0', 'Mem0 (OSS)',
  'Mem0 open source: every task email added as it arrives (its fact extraction, mission set); top memories for goal + new message, ~2,000 tokens. Haiku 5.5, local embeddings.',
  'recalled_memories',
  async (mb, ns) => {
    const { ingest, ingestMs } = await ingestSidecar('mem0', mb, ns);
    const started = Date.now();
    const { results } = await http<{ results: Mem0Row[] }>('POST', `${SIDECAR}/mem0/search`, { ns, query: queryOf(mb), limit: LIMIT });
    const recall = minus(await sidecarUsage(ns), ingest);
    const line = (r: Mem0Row) => `- [${r.metadata?.date?.slice(0, 16) ?? '?'}${r.metadata?.source ? ` ${r.metadata.source}` : ''}] ${r.text}`;
    // rank decides what fits; the agent reads them in date order
    const kept = fit(results, line).sort((a, b) => String(a.metadata?.date).localeCompare(String(b.metadata?.date)));
    return { memory: kept.map(line).join('\n'), ingest, recall, ingestMs, recallMs: Date.now() - started, diag: { ns, recalled: results.length, shown: kept.length } };
  },
);

interface ZepFact { text: string; valid_at: string | null; invalid_at: string | null; expired_at: string | null; sources: string[] }
interface ZepEntity { name: string; summary: string }

export const zep: Condition = provider(
  'zep-graphiti', 'Zep (Graphiti OSS)',
  'Zep\'s open-source engine Graphiti: every task email added as an episode (temporal knowledge graph, mission set); hybrid search + rerank for goal + new message, rendered in Zep\'s context-block format, ~2,000 tokens. Haiku 5.5, local embeddings.',
  'zep_context',
  async (mb, ns) => {
    const { ingest, ingestMs } = await ingestSidecar('graphiti', mb, ns);
    const started = Date.now();
    const { facts, entities } = await http<{ facts: ZepFact[]; entities: ZepEntity[] }>('POST', `${SIDECAR}/graphiti/search`, { ns, query: queryOf(mb), limit: LIMIT });
    const recall = minus(await sidecarUsage(ns), ingest);
    // Zep's documented context block: facts with their valid date ranges, then entity summaries
    const factLine = (f: ZepFact) => `  - ${f.text}${f.sources.length ? ` [${f.sources.join(', ')}]` : ''} (Date range: ${f.valid_at ?? 'unknown'} - ${f.invalid_at ?? 'present'})`;
    const entityLine = (e: ZepEntity) => `  - ${e.name}: ${e.summary}`;
    const keptFacts = fit(facts, factLine, BUDGET - 120);
    const left = BUDGET - 120 - keptFacts.reduce((n, f) => n + estimateTokens(factLine(f)) + 1, 0);
    const keptEntities = fit(entities, entityLine, left);
    const memory = [
      'FACTS and ENTITIES represent relevant context to the current conversation.',
      '# These are the most relevant facts and their valid date ranges',
      '# format: FACT (Date range: from - to)',
      '<FACTS>', ...keptFacts.map(factLine), '</FACTS>',
      '# These are the most relevant entities',
      '# ENTITY_NAME: entity summary',
      '<ENTITIES>', ...keptEntities.map(entityLine), '</ENTITIES>',
    ].join('\n');
    return { memory, ingest, recall, ingestMs, recallMs: Date.now() - started, diag: { ns, facts: facts.length, entities: entities.length, shown_facts: keptFacts.length, shown_entities: keptEntities.length, invalidated_shown: keptFacts.filter((f) => f.invalid_at).length } };
  },
);

// ------------------------------------------------------------------ Hindsight (Docker, one case per instance at a time)

// Hindsight cannot tag its own model calls, so each instance reaches the proxy under its own tag and runs one case at a
// time: the tag's usage over the case is exactly that case's, background consolidation included.
// HINDSIGHT_POOL=n runs n cases per instance at once (faster); a case's own usage is then unknowable, so those cases bill
// nothing here (diag.billing = 'pooled') and bench/providers/pool-billing.ts later splits the tag's total evenly over them.
const POOL = Math.max(1, Number(process.env.HINDSIGHT_POOL) || 1);
const free = Array.from({ length: POOL }, () => HINDSIGHT).flat();
const waiting: ((i: (typeof HINDSIGHT)[number]) => void)[] = [];
const acquire = () => new Promise<(typeof HINDSIGHT)[number]>((resolve) => { const i = free.shift(); if (i) resolve(i); else waiting.push(resolve); });
const release = (i: (typeof HINDSIGHT)[number]) => { const next = waiting.shift(); if (next) next(i); else free.push(i); };
const proxyUsage = async (tag: string) => ((await http<Record<string, Counted>>('GET', `${PROXY}/__usage`))[tag] ?? ZERO);

/** Wait until the bank's background work (consolidation) is done, as it would be before the next email in production. */
async function settle(bank: string, url: string) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const { operations } = await http<{ operations: { status: string }[] }>('GET', `${url}/v1/default/banks/${bank}/operations?limit=100`);
    if (operations.every((o) => ['completed', 'failed', 'cancelled'].includes(o.status))) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`hindsight bank ${bank}: background work still running after 5 minutes`);
}

interface HindsightResult { text: string; type?: string | null; occurred_start?: string | null; mentioned_at?: string | null; document_id?: string | null }

export const hindsight: Condition = provider(
  'hindsight', 'Hindsight',
  'Hindsight (Docker): every task email retained as it arrives (its fact extraction and observation consolidation, mission set); recall for goal + new message at the decision time, ~2,000 tokens. Haiku 5.5, local embeddings.',
  'recalled_memories',
  async (mb, ns) => {
    const inst = await acquire();
    try {
      const bank = `${inst.url}/v1/default/banks/${ns}`;
      const before = await proxyUsage(inst.tag);
      const started = Date.now();
      await http('PUT', bank, { retain_mission: MISSION });
      for (const m of taskMail(mb)) {
        await http('POST', `${bank}/memories`, { async: false, items: [{ content: renderEmail(m), timestamp: m.event.at, context: 'email', document_id: m.id }] });
        await settle(ns, inst.url);
      }
      const ingested = await proxyUsage(inst.tag);
      const ingestMs = Date.now() - started;
      const t1 = Date.now();
      const { results } = await http<{ results: HindsightResult[] }>('POST', `${bank}/memories/recall`, { query: queryOf(mb), max_tokens: BUDGET, query_timestamp: mb.now.replace(/Z$/, '') });
      const recall = minus(await proxyUsage(inst.tag), ingested);
      const line = (r: HindsightResult) => `- [${r.type ?? 'fact'}${r.occurred_start ? ` ${r.occurred_start.slice(0, 10)}` : ''}${r.document_id ? ` ${r.document_id}` : ''}] ${r.text}`;
      const kept = fit(results, line);
      const pooled = POOL > 1;
      return {
        memory: kept.map(line).join('\n'), ingest: pooled ? ZERO : minus(ingested, before), recall: pooled ? ZERO : recall, ingestMs, recallMs: Date.now() - t1,
        diag: { ns, instance: inst.tag, billing: pooled ? 'pooled' : 'exact', recalled: results.length, shown: kept.length, types: Object.fromEntries(['world', 'experience', 'observation'].map((t) => [t, kept.filter((r) => r.type === t).length])) },
      };
    } finally {
      release(inst);
    }
  },
);
