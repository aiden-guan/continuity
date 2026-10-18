// Signal: a scan of every task that raises alerts nobody asked for — a promise gone overdue, a deadline
// days away, a requirement now failing, a contradiction, quarantined injected text, a task gone quiet —
// each with the evidence behind it. Alerts are remembered (Backend.saveSignals), so a run reports what is
// NEW (or reopened) and marks alerts whose condition has cleared as resolved.
// Ported from samrocksnature's b615ab7.
import type { Backend, SignalRow } from './store/backend.ts';
import type { MemoryStore } from './store/state.ts';
import type { TaskSpec } from './types.ts';
import { openApprovals } from './engine/approval-log.ts';
import { domainFor, outcomeOf, termOf } from './domain/index.ts';
import { isOpen, labelOf } from './engine/resolver.ts';
import { prettyDate } from './extract/dates.ts';
import { nowIso } from './clock.ts';

export type Alert = Omit<SignalRow, 'first_seen' | 'last_seen' | 'resolved_at'>;
export interface SignalRun { at: string; new: SignalRow[]; reopened: SignalRow[]; open: SignalRow[]; resolved: string[] }

const DAY = 86_400_000;
const daysBetween = (fromIso: string, toIso: string) =>
  Math.round((Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`)) / DAY);
/** Flags worth an alert. Sender-authentication flags join here once the resolver records them. */
const SECURITY_FLAGS: Record<string, string> = {
  prompt_injection_suspected: 'prompt injection quarantined',
  sender_unauthenticated: 'unauthenticated sender',
  sender_impersonates_us: 'mail impersonating us',
};
/** No word from a party we are waiting on for this long: the task has gone quiet. */
const STALL_DAYS = 5;
/** Warn this many days before a deadline term (contingency end, quote expiry, closing). */
const DEADLINE_WARN_DAYS = 3;
const RANK = { high: 0, medium: 1, low: 2 } as const;
const byRank = (x: SignalRow, y: SignalRow) => RANK[x.severity] - RANK[y.severity] || x.key.localeCompare(y.key);

/**
 * The alerts one task warrants right now, from its working set. Pure over the state.
 */
export function alertsFor(store: MemoryStore, task: TaskSpec, now: string): Alert[] {
  const pack = domainFor(task);
  const self = task.self_address.toLowerCase();
  const label = (a: string) => labelOf(task, a);
  const tag = task.item ? `${task.alias} (${task.item})` : task.alias;
  const out: Alert[] = [];
  const claims = store.claimsForTask(task.id);
  const active = claims.filter((c) => c.status === 'active');
  // a task that fell through needs no alerts at all; an accepted one only for promises still owed
  const outcome = outcomeOf(pack, task, active);
  if (outcome === 'fell_through') return out;
  const accepted = outcome === 'accepted';
  const open = store.obligationsForTask(task.id).filter(isOpen);
  const sourceOf = (claimId: string) => store.getClaim(claimId)?.source_event_id ?? claimId;

  for (const c of store.getChecks(task.id).filter((x) => x.status === 'fail')) {
    out.push({
      key: `${task.id}:conflict:${c.id}`, task_id: task.id, rule: 'requirement_failing', severity: 'high', summary: `${tag}: ${c.label} — ${c.detail}`,
      detail: { evidence: c.evidence.map(sourceOf), check: c.id },
    });
  }
  for (const key of new Set(claims.filter((c) => c.status === 'contested').map((c) => c.key))) {
    const disputed = claims.filter((c) => c.status === 'contested' && c.key === key);
    out.push({
      key: `${task.id}:contested:${key}`, task_id: task.id, rule: 'contradiction', severity: 'high',
      summary: `${tag}: parties disagree on ${key}: ${disputed.map((c) => `${label(c.speaker)} says ${c.display}`).join(' vs ')}`,
      detail: { evidence: disputed.map((c) => c.source_event_id) },
    });
  }
  for (const o of open.filter((x) => x.due_at)) {
    const days = daysBetween(now, o.due_at!);
    const ours = o.debtor === self;
    if (days < 0) {
      out.push({
        key: `${task.id}:overdue:${o.id}`, task_id: task.id, rule: ours ? 'we_are_overdue' : 'overdue', severity: 'high',
        summary: ours
          ? `${tag}: we are ${-days} day(s) late on "${o.text}" for ${label(o.creditor)} (due ${prettyDate(o.due_at!)})`
          : `${tag}: ${label(o.debtor)} is ${-days} day(s) late on "${o.text}" (due ${prettyDate(o.due_at!)})`,
        detail: { evidence: [o.source_event_id], obligation: o.id },
      });
    } else if (days <= 2 && !accepted) {
      out.push({
        key: `${task.id}:due_soon:${o.id}`, task_id: task.id, rule: 'due_soon', severity: 'medium',
        summary: `${tag}: "${o.text}" from ${label(o.debtor)} is due ${days === 0 ? 'today' : `in ${days} day(s)`} (${prettyDate(o.due_at!)})`,
        detail: { evidence: [o.source_event_id], obligation: o.id },
      });
    }
  }
  if (!accepted) {
    const theirPromises = open.filter((o) => o.debtor !== self && o.kind === 'commitment');
    for (const c of active.filter((x) => termOf(pack, x.key)?.deadline && typeof x.value === 'string')) {
      const days = daysBetween(now, c.value as string);
      if (days > DEADLINE_WARN_DAYS) continue;
      const what = termOf(pack, c.key)!.description.replace(/\s*\(.*\)$/, '');
      const when = days < 0 ? `passed ${-days} day(s) ago` : days === 0 ? 'is today' : `is in ${days} day(s)`;
      const pending = theirPromises.length ? `, with ${theirPromises.map((o) => `"${o.text}" (${label(o.debtor)})`).join(', ')} still outstanding` : '';
      out.push({
        key: `${task.id}:deadline:${c.key}:${c.value}`, task_id: task.id, rule: 'deadline', severity: days < 0 ? 'high' : 'medium',
        summary: `${tag}: ${what} — ${prettyDate(c.value as string)} ${when}${pending}`,
        detail: { evidence: [c.source_event_id, ...theirPromises.map((o) => o.source_event_id)], term: c.key },
      });
    }
    const events = store.eventsForTask(task.id);
    for (const debtor of new Set(open.filter((o) => o.debtor !== self).map((o) => o.debtor))) {
      const last = [...events].reverse().find((e) => e.direction === 'inbound' && e.from === debtor);
      const since = last?.occurred_at ?? open.find((o) => o.debtor === debtor)!.created_at;
      const quiet = daysBetween(since, now);
      if (quiet >= STALL_DAYS) {
        out.push({
          key: `${task.id}:stalled:${debtor}`, task_id: task.id, rule: 'stalled', severity: 'low',
          summary: `${tag}: no word from ${label(debtor)} in ${quiet} days while we wait on them`, detail: { evidence: last ? [last.id] : [] },
        });
      }
    }
  }
  // decisions waiting on a human: always surfaced; urgent once old, about to expire, or a payment detail to verify
  for (const ap of openApprovals(store, task.id, now)) {
    const ageH = (Date.parse(now) - Date.parse(ap.created_at)) / 3_600_000;
    const leftH = (Date.parse(ap.expires_at) - Date.parse(now)) / 3_600_000;
    let severity: Alert['severity'] = 'low';
    if (leftH < 12 || ap.kind === 'verify_change') severity = 'high';
    else if (ageH > 24) severity = 'medium';
    const evidence = ap.claim_id ? [sourceOf(ap.claim_id)] : [];
    out.push({
      key: `${task.id}:approval:${ap.id}`, task_id: task.id, rule: 'awaiting_approval', severity,
      summary: `${tag}: waiting on a human for ${Math.max(0, Math.round(ageH))} h — ${ap.title} (${ap.id}${ap.status === 'held' ? ', held to verify' : ''}; expires in ${Math.round(leftH)} h)`,
      detail: { evidence, approval: ap.id },
    });
  }
  for (const f of store.flagsForTask(task.id).filter((x) => x.kind in SECURITY_FLAGS)) {
    out.push({
      key: `${task.id}:security:${f.id}`, task_id: task.id, rule: 'security', severity: 'medium',
      summary: `${tag}: ${SECURITY_FLAGS[f.kind]} — ${f.detail.slice(0, 160)}`, detail: { evidence: [f.event_id], flag: f.kind },
    });
  }
  return out;
}

/** Scan every task of an org (or `taskIds`), remember what was raised, and report what changed since the last run. */
export async function runSignal(backend: Backend, org: string, opts: { now?: string; taskIds?: string[] } = {}): Promise<SignalRun> {
  const at = opts.now ?? nowIso();
  const tasks = (await backend.listTasks(org)).map((t) => t.spec).filter((t) => !opts.taskIds || opts.taskIds.includes(t.id));
  const scope = new Set(tasks.map((t) => t.id));
  const known = new Map((await backend.listSignals(org, { includeResolved: true })).map((s) => [s.key, s]));
  const fresh: SignalRow[] = [];
  const reopened: SignalRow[] = [];
  const writes: SignalRow[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    const { store } = await backend.loadTask(org, task.id);
    for (const a of alertsFor(store, task, at)) {
      if (seen.has(a.key)) continue;
      seen.add(a.key);
      const prev = known.get(a.key);
      const row: SignalRow = { ...a, first_seen: prev?.first_seen ?? at, last_seen: at, resolved_at: null };
      if (!prev) fresh.push(row);
      else if (prev.resolved_at) reopened.push(row);
      writes.push(row);
    }
  }
  const resolved = [...known.values()].filter((s) => !s.resolved_at && scope.has(s.task_id) && !seen.has(s.key));
  writes.push(...resolved.map((s) => ({ ...s, resolved_at: at })));
  await backend.saveSignals(org, writes);
  const open = writes.filter((s) => !s.resolved_at).sort(byRank);
  return { at, new: fresh.sort(byRank), reopened: reopened.sort(byRank), open, resolved: resolved.map((s) => s.key) };
}

/** Post new and reopened alerts to a chat webhook (Slack-compatible {"text": ...}); never throws. */
export async function notifyWebhook(url: string | undefined, run: SignalRun): Promise<boolean> {
  const items = [...run.new, ...run.reopened];
  if (!url || !items.length) return false;
  const mark = { high: '[HIGH]', medium: '[MED]', low: '[LOW]' } as const;
  const text = [`Signal — ${items.length} new alert(s):`, ...items.map((s) => `${mark[s.severity]} ${s.summary}`)].join('\n');
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, alerts: items }), signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Run Signal every `everySeconds` (inside the server) and deliver new alerts; returns a stop function. */
export function scheduleSignal(backend: Backend, org: string, everySeconds: number, webhook: string | undefined, log: (line: string) => void = console.log): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const run = await runSignal(backend, org);
      for (const s of [...run.new, ...run.reopened]) log(`[signal] ${s.severity.toUpperCase()} ${s.summary}`);
      await notifyWebhook(webhook, run);
    } catch (err) {
      console.error('[signal] run failed', err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), everySeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
