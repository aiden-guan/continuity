// Portfolio layer: questions across every task at once.
//
//  - A read-only, in-memory SQLite snapshot of curated tables built from the Backend (listTasks, then
//    loadTask per task): deals, deal_events, deal_terms, deal_checks, deal_obligations, signals. Queries
//    never see raw email bodies or the live database, and cannot write, attach files or run pragmas
//    (query_only plus an allow-list authorizer: SELECT, READ, FUNCTION, RECURSIVE — nothing else).
//  - query(): one SELECT (or WITH … SELECT), row-capped, results as compact arrays.
//  - listDeals(): one row per task with where it stands.
//  - findSimilar(): tasks whose history BEGAN like this task's history so far, and how they ended.
//
// Every call takes a scope: the org, and the task ids the caller may see (null = all). A task-restricted
// principal gets a snapshot of its own tasks only, so other tasks cannot leak through SQL.
// Ported from samrocksnature's b615ab7 and 4b22c86.
import { DatabaseSync, constants as K } from 'node:sqlite';
import type { Backend } from './store/backend.ts';
import type { MemoryStore } from './store/state.ts';
import type { TaskSpec } from './types.ts';
import { compileContext } from './compiler/compile.ts';
import { domainFor, outcomeOf } from './domain/index.ts';
import { deriveTimeline, type TimelineEvent } from './engine/timeline.ts';
import { approvalsForTask } from './engine/approval-log.ts';
import { labelOf } from './engine/resolver.ts';
import { compareIso, nowIso } from './clock.ts';

export const MAX_ROWS = 500;

export interface PortfolioScope {
  org: string;
  /** Tasks the caller may see; null or undefined = every task in the org. */
  taskIds?: string[] | null;
}

const SCHEMA = `
CREATE TABLE deals (task_id TEXT PRIMARY KEY, alias TEXT, item TEXT, domain TEXT, goal TEXT, outcome TEXT, next_actor TEXT, next_actor_reason TEXT,
  failing_checks INTEGER, open_alerts INTEGER, events_total INTEGER, last_activity TEXT, state_version INTEGER);
CREATE TABLE deal_events (task_id TEXT, seq INTEGER, at TEXT, type TEXT, type_id INTEGER, party TEXT, term TEXT, value_json TEXT, display TEXT,
  applied INTEGER, replaces TEXT, source_event TEXT);
CREATE TABLE deal_terms (task_id TEXT, party TEXT, term TEXT, value_json TEXT, value_num REAL, value_text TEXT, display TEXT, status TEXT, source_event TEXT);
CREATE TABLE deal_checks (task_id TEXT, check_id TEXT, label TEXT, status TEXT, detail TEXT, party TEXT);
CREATE TABLE deal_obligations (task_id TEXT, id TEXT, kind TEXT, owed_by TEXT, owed_to TEXT, what TEXT, status TEXT, due TEXT, overdue INTEGER, source_event TEXT);
CREATE TABLE signals (task_id TEXT, rule TEXT, severity TEXT, summary TEXT, first_seen TEXT, resolved_at TEXT, evidence_json TEXT);
CREATE TABLE approvals (task_id TEXT, id TEXT, kind TEXT, status TEXT, title TEXT, reasons_json TEXT, created_at TEXT, expires_at TEXT, decided_at TEXT, decided_by TEXT, option TEXT);
`;

/** Table and column guide for agents writing queries (also served at GET /query/schema). */
export const SCHEMA_GUIDE = {
  deals: 'one row per deal (task): task_id, alias, item, domain, goal, outcome (accepted | fell_through | open), next_actor (us | them | none), next_actor_reason, failing_checks, open_alerts, events_total, last_activity, state_version',
  deal_events: 'the typed timeline of every deal, in order: task_id, seq, at (ISO), type (offer_made, counter_offer, appraisal_received, closing_set, price_quoted, conflict_detected, commitment_made, …), type_id, party, term, value_json, display, applied (0 = recorded but not applied), replaces, source_event (ev_ id)',
  deal_terms: 'current terms per deal and party: task_id, party, term (e.g. price.purchase, closing.date, price.unit), value_json, value_num (numbers), value_text (dates/text; ISO dates sort correctly), display, status (active | contested), source_event',
  deal_checks: 'requirement checks per deal: task_id, check_id, label, status (pass | fail | unknown), detail, party',
  deal_obligations: 'who owes what: task_id, id, kind (question | request | commitment), owed_by, owed_to, what, status (open | partially_fulfilled | answered | fulfilled | …), due (ISO date), overdue (1/0), source_event',
  signals: 'alerts raised by Signal: task_id, rule, severity (high | medium | low), summary, first_seen, resolved_at (NULL = open), evidence_json',
  approvals: 'decisions held for a human: task_id, id, kind (send | verify_change), status (pending | held | approved | edited | rejected | replied | verified | taken_over | expired | stale), title, reasons_json, created_at, expires_at, decided_at, decided_by, option',
};

export interface Deal { task: TaskSpec; store: MemoryStore; version: number; timeline: TimelineEvent[] }
interface Built { version: string; deals: Deal[]; db: DatabaseSync | null }

const cache = new WeakMap<Backend, Map<string, Built>>();
const scopeKey = (s: PortfolioScope) => `${s.org}\u0000${s.taskIds ? [...s.taskIds].sort().join(',') : '*'}`;

async function visibleTasks(backend: Backend, scope: PortfolioScope) {
  return (await backend.listTasks(scope.org)).filter((t) => !scope.taskIds || scope.taskIds.includes(t.spec.id));
}

/** The scope's tasks, each with its working set and typed timeline; reloaded only when some task or alert changed. */
async function load(backend: Backend, scope: PortfolioScope): Promise<Built> {
  const tasks = await visibleTasks(backend, scope);
  const signals = await backend.listSignals(scope.org, { includeResolved: true });
  const lastSignal = signals.reduce((m, s) => (!m || compareIso(s.last_seen, m) > 0 ? s.last_seen : m), '');
  const version = `${tasks.map((t) => `${t.spec.id}:${t.state_version}`).join(',')}|${signals.length}.${lastSignal}.${signals.filter((s) => s.resolved_at).length}|${nowIso().slice(0, 10)}`;
  let byScope = cache.get(backend);
  if (!byScope) cache.set(backend, (byScope = new Map()));
  const key = scopeKey(scope);
  const cached = byScope.get(key);
  if (cached?.version === version) return cached;
  cached?.db?.close();
  const deals: Deal[] = [];
  for (const t of tasks) {
    const snap = await backend.loadTask(scope.org, t.spec.id);
    deals.push({ task: t.spec, store: snap.store, version: snap.version, timeline: deriveTimeline(snap.store, t.spec.id) });
  }
  const built: Built = { version, deals, db: null };
  byScope.set(key, built);
  return built;
}

const activeClaims = (d: Deal) => d.store.claimsForTask(d.task.id).filter((c) => c.status === 'active');
const outcome = (d: Deal) => outcomeOf(domainFor(d.task), d.task, activeClaims(d));

function dealRows(deals: Deal[], openAlerts: Map<string, number>, today: string) {
  return deals.map((d) => {
    const ctx = compileContext(d.store, d.task.id, { now: today });
    const events = d.store.eventsForTask(d.task.id);
    return {
      task_id: d.task.id, alias: d.task.alias, item: d.task.item ?? null, domain: d.task.domain, goal: d.task.goal, outcome: outcome(d),
      next_actor: ctx.next_actor, next_actor_reason: ctx.next_actor_reason, failing_checks: d.store.getChecks(d.task.id).filter((c) => c.status === 'fail').length,
      open_alerts: openAlerts.get(d.task.id) ?? 0, events_total: events.length, last_activity: events.at(-1)?.occurred_at ?? null, state_version: d.version,
    };
  });
}

/** One row per task in scope: outcome, who acts next and why, failing checks, open alerts. */
export async function listDeals(backend: Backend, scope: PortfolioScope) {
  const { deals } = await load(backend, scope);
  return dealRows(deals, await openAlertCounts(backend, scope.org), nowIso());
}

async function openAlertCounts(backend: Backend, org: string) {
  const counts = new Map<string, number>();
  for (const s of await backend.listSignals(org)) counts.set(s.task_id, (counts.get(s.task_id) ?? 0) + 1);
  return counts;
}

/** The read-only portfolio database for a scope, rebuilt only when something in it changed. */
export async function snapshot(backend: Backend, scope: PortfolioScope): Promise<DatabaseSync> {
  const built = await load(backend, scope);
  if (built.db) return built.db;
  const db = new DatabaseSync(':memory:');
  if (typeof db.setAuthorizer !== 'function') throw new QueryError('portfolio SQL needs a Node.js with node:sqlite setAuthorizer (Node 24+)');
  db.exec(SCHEMA);
  const insert = (table: string, n: number) => db.prepare(`INSERT INTO ${table} VALUES (${Array(n).fill('?').join(',')})`);
  const dealIns = insert('deals', 13), evIns = insert('deal_events', 12), termIns = insert('deal_terms', 9);
  const checkIns = insert('deal_checks', 6), obIns = insert('deal_obligations', 10), sigIns = insert('signals', 7);
  const apIns = insert('approvals', 11);
  const today = nowIso().slice(0, 10);
  const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  const inScope = new Set(built.deals.map((d) => d.task.id));
  db.exec('BEGIN');
  for (const r of dealRows(built.deals, await openAlertCounts(backend, scope.org), nowIso())) {
    dealIns.run(r.task_id, r.alias, r.item, r.domain, r.goal, r.outcome, r.next_actor, r.next_actor_reason, r.failing_checks, r.open_alerts, r.events_total, r.last_activity, r.state_version);
  }
  for (const d of built.deals) {
    const id = d.task.id;
    const label = (a: string) => labelOf(d.task, a);
    for (const e of d.timeline) {
      evIns.run(id, e.seq, e.at, e.type, e.type_id, e.party, e.term ?? null, json(e.value), e.display ?? null, e.applied ? 1 : 0, e.replaces ?? null, e.source_event);
    }
    for (const c of d.store.claimsForTask(id).filter((x) => x.status === 'active' || x.status === 'contested')) {
      termIns.run(id, label(c.speaker), c.key, json(c.value), typeof c.value === 'number' ? c.value : null, typeof c.value === 'string' ? c.value : null, c.display, c.status, c.source_event_id);
    }
    for (const c of d.store.getChecks(id)) checkIns.run(id, c.id, c.label, c.status, c.detail, c.party ? label(c.party) : null);
    for (const o of d.store.obligationsForTask(id)) {
      const overdue = (o.status === 'open' || o.status === 'partially_fulfilled') && !!o.due_at && o.due_at < today;
      obIns.run(id, o.id, o.kind, label(o.debtor), label(o.creditor), o.text, o.status, o.due_at ?? null, overdue ? 1 : 0, o.source_event_id);
    }
    for (const a of approvalsForTask(d.store, id)) {
      apIns.run(id, a.id, a.kind, a.status, a.title, json(a.reasons), a.created_at, a.expires_at, a.decided_at, a.decided_by, a.decision?.option ?? null);
    }
  }
  for (const s of await backend.listSignals(scope.org, { includeResolved: true })) {
    if (inScope.has(s.task_id)) sigIns.run(s.task_id, s.rule, s.severity, s.summary, s.first_seen, s.resolved_at, json(s.detail.evidence));
  }
  db.exec('COMMIT');
  db.exec('PRAGMA query_only = ON');
  const allowed = new Set([K.SQLITE_SELECT, K.SQLITE_READ, K.SQLITE_FUNCTION, K.SQLITE_RECURSIVE]);
  db.setAuthorizer((code, _a1, a2) => {
    if (code === K.SQLITE_FUNCTION && /^(load_extension|readfile|writefile|fts3_tokenizer)$/i.test(String(a2 ?? ''))) return K.SQLITE_DENY;
    return allowed.has(code) ? K.SQLITE_OK : K.SQLITE_DENY;
  });
  built.db = db;
  return db;
}

/** A refused or invalid query: a client error, never a server one. */
export class QueryError extends Error {}

/** Run one read-only SELECT against the scope's snapshot. Rows come back as arrays (compact for agents). */
export async function query(backend: Backend, scope: PortfolioScope, sql: string) {
  const text = String(sql ?? '').trim().replace(/;\s*$/, '');
  if (!text) throw new QueryError('sql is required');
  if (text.length > 8000) throw new QueryError('sql is limited to 8,000 characters');
  if (!/^(select|with)\b/i.test(text)) throw new QueryError('only a single SELECT (or WITH … SELECT) is allowed');
  if (/;/.test(text.replace(/'(?:[^']|'')*'/g, "''"))) throw new QueryError('only one statement per query');
  const db = await snapshot(backend, scope);
  try {
    const stmt = db.prepare(`SELECT * FROM (${text}) LIMIT ${MAX_ROWS + 1}`);
    stmt.setReturnArrays(true);
    const rows = stmt.all() as unknown as unknown[][];
    const columns = stmt.columns().map((c) => c.name);
    return { columns, rows: rows.slice(0, MAX_ROWS), row_count: Math.min(rows.length, MAX_ROWS), truncated: rows.length > MAX_ROWS };
  } catch (err) {
    throw new QueryError((err as Error).message);
  }
}

// ------------------------------------------------------------------ similarity: how did tasks that started like this one end?

const NOISE = new Set(['message_received', 'message_sent', 'question_asked', 'request_made', 'question_answered', 'request_answered', 'document_superseded', 'injection_quarantined', 'send_blocked']);

/** A task's history as tokens: event types, which requirement broke, and whether a term changed. Outcome events are left out. */
function tokens(pack: ReturnType<typeof domainFor>, events: TimelineEvent[]): string[] {
  const decision = pack.decisionKey;
  const lifecycle = new Set(pack.terms.filter((t) => t.lifecycle).map((t) => t.key));
  return events
    .filter((e) => !NOISE.has(e.type) && e.term !== decision && !(e.term && lifecycle.has(e.term)))
    .map((e) => (e.type === 'conflict_detected' || e.type === 'conflict_resolved' ? `${e.type}:${e.display ?? ''}` : e.replaces ? `${e.type}:changed` : e.type));
}
const grams = (t: string[]) => new Set([...t, ...t.slice(1).map((x, i) => `${t[i]} > ${x}`)]);

/** Tasks in scope (same domain) whose history began like this one's, and the outcome rates of the closest cohort. */
export async function findSimilar(backend: Backend, scope: PortfolioScope, taskId: string, k = 5) {
  const { deals } = await load(backend, scope);
  const target = deals.find((d) => d.task.id === taskId);
  if (!target) throw new QueryError(`unknown task ${taskId}`);
  const pack = domainFor(target.task);
  const pattern = tokens(pack, target.timeline);
  const tg = grams(pattern);
  const scored = deals.filter((d) => d.task.id !== taskId && d.task.domain === target.task.domain).map((d) => {
    // compare with how each task BEGAN: its first as-many tokens as the target has so far
    const g = grams(tokens(pack, d.timeline).slice(0, Math.max(pattern.length, 1)));
    const shared = [...tg].filter((x) => g.has(x));
    const union = new Set([...tg, ...g]).size || 1;
    return {
      task_id: d.task.id, alias: d.task.alias, item: d.task.item ?? null, similarity: Math.round((shared.length / union) * 100) / 100, outcome: outcome(d),
      shared: shared.filter((x) => x.includes('conflict') || x.includes('changed') || x.includes(' > ')).slice(0, 6),
    };
  }).filter((s) => s.similarity > 0).sort((a, b) => b.similarity - a.similarity || a.alias.localeCompare(b.alias));
  // the cohort: every decided task about as close as the closest decided one (many histories tie exactly);
  // open lookalikes are listed but say nothing yet about how such deals end
  const best = scored.find((s) => s.outcome !== 'open')?.similarity ?? 0;
  const floor = Math.round((best - 0.1) * 100) / 100;
  const cohort = scored.filter((s) => s.similarity >= best - 0.1);
  const decided = cohort.filter((s) => s.outcome !== 'open');
  const fell = decided.filter((s) => s.outcome === 'fell_through').length;
  const pct = decided.length ? Math.round((fell / decided.length) * 100) : 0;
  return {
    task_id: taskId, pattern, similar: scored.slice(0, k),
    cohort: { size: cohort.length, decided: decided.length, fell_through: fell, accepted: decided.length - fell, fell_through_rate: decided.length ? fell / decided.length : null },
    summary: decided.length
      ? `Of ${decided.length} decided deal(s) that began like this one (similarity ≥ ${floor}), ${fell} fell through (${pct}%) and ${decided.length - fell} closed`
      : 'no decided deals with a similar history yet',
  };
}

/** The typed timeline of one task in scope (for Ask). */
export async function timelineOf(backend: Backend, scope: PortfolioScope, taskIdOrAlias: string): Promise<{ task: TaskSpec; events: TimelineEvent[]; store: MemoryStore }> {
  const { deals } = await load(backend, scope);
  const d = deals.find((x) => x.task.id === taskIdOrAlias || x.task.alias === taskIdOrAlias);
  if (!d) throw new QueryError(`unknown deal ${taskIdOrAlias}`);
  return { task: d.task, events: d.timeline, store: d.store };
}
