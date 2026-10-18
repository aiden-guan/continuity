// The live mode's commands, called from bench/run.ts:
//   live-check            read-only preflight of the Primitive account (no mail sent)
//   live-deliver          send the selected cases through Primitive and verify them (no model calls)
//   run --live <name>     run conditions on delivered cases; the client cannot send during a run
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { BenchCase } from '../core/types.ts';
import { materialize, type Mailbox } from '../core/mailbox.ts';
import { PrimitiveLiveClient, redact, type LiveClient, type Preflight } from './client.ts';
import { FakeLiveClient } from './fake.ts';
import { deliverCase, liveSupport, loadManifest, saveManifest, verifyCase, type LiveManifest } from './deliver.ts';
import { liveMailbox } from './view.ts';

export const manifestPath = (name: string) => join('bench/results/live', name, 'manifest.json');

export interface LiveOpts {
  name: string;
  fake: boolean;
  maxSends: number;
  perHour?: number;
  allowProcessing: boolean;
  concurrency: number;
}

export function openClient(o: { fake: boolean; maxSends: number; perHour: number; since: string }): LiveClient {
  if (o.fake) return new FakeLiveClient();
  return new PrimitiveLiveClient(process.env.PRIMITIVE_API_KEY ?? '', { perHour: o.perHour, maxSends: o.maxSends, since: o.since });
}

export function describePreflight(p: Preflight): string {
  return [
    `domain ${p.domain || '(none)'} · ${p.sendable ? 'can send' : 'CANNOT send'} · plan ${p.plan}`,
    `limits: ${p.send_per_hour} sends/hour, ${p.send_per_day} sends/day`,
    `processing routes on the inbox (webhooks/functions): ${p.processing_routes}`,
  ].join('\n');
}

/** Refuse to send into an inbox that something else processes: the cases carry prompt injections and fake bank-detail changes. */
export function preflightProblems(p: Preflight, allowProcessing: boolean): string[] {
  const out: string[] = [];
  if (!p.domain || !p.sendable) out.push('no verified, sendable Primitive domain on this account');
  if (p.processing_routes > 0 && !allowProcessing) out.push(`${p.processing_routes} webhook/function route(s) process this inbox; benchmark mail contains prompt injections and fake payment changes. Disable them or pass --allow-processing`);
  return out;
}

const pct = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

export function summarize(m: LiveManifest): string {
  const cases = Object.values(m.cases);
  const count = (s: string) => cases.filter((c) => c.status === s).length;
  const lat = cases.flatMap((c) => c.messages.map((x) => x.latency_ms).filter((n): n is number => n != null));
  const lines = [
    `live run ${m.name} (tag ${m.run_tag}) on ${m.domain}: ${count('delivered')} delivered · ${count('fault')} with faults · ${count('unsupported')} replay-only · ${count('error')} errors`,
    `messages sent: ${cases.reduce((n, c) => n + c.messages.length, 0)} · arrival latency p50 ${pct(lat, 0.5) ?? '—'} ms, p95 ${pct(lat, 0.95) ?? '—'} ms`,
  ];
  for (const c of cases.filter((x) => x.status !== 'delivered')) lines.push(`  ${c.status.padEnd(11)} ${c.case_id}: ${c.reason ?? c.verification?.faults.slice(0, 3).join(' | ') ?? ''}`);
  const diffs = cases.flatMap((c) => (c.verification?.differences ?? []).map((d) => `${c.case_id} ${d}`));
  if (diffs.length) lines.push(`differences (kept: real Primitive behaviour), ${diffs.length}:`, ...diffs.slice(0, 15).map((d) => `  ${d}`));
  return lines.join('\n');
}

/** Re-run the delivery checks on cases already delivered (after the checks changed). Read-only: nothing is sent. */
export async function reverifyAll(cases: BenchCase[], name: string, log = console.log): Promise<void> {
  const file = manifestPath(name);
  const manifest = loadManifest(file);
  if (!manifest) throw new Error(`no live delivery named ${name}`);
  const client = openClient({ fake: false, maxSends: 0, perHour: 1, since: manifest.since });
  try {
    for (const c of cases) {
      const d = manifest.cases[c.id];
      if (!d || !['delivered', 'fault'].includes(d.status)) continue;
      d.verification = await verifyCase(client, c, d);
      d.status = d.verification.faults.length ? 'fault' : 'delivered';
      saveManifest(file, manifest);
      log(`${d.status.padEnd(11)} ${c.id}${d.verification.faults.length ? ` — ${d.verification.faults[0]}` : ''}`);
    }
  } finally {
    client.close();
  }
  log(summarize(manifest));
}

export async function deliverAll(cases: BenchCase[], o: LiveOpts & { yes: boolean }, log = console.log): Promise<{ manifest: LiveManifest; client: LiveClient } | null> {
  const file = manifestPath(o.name);
  const existing = o.fake ? null : loadManifest(file);
  const since = existing?.since ?? new Date(Date.now() - 120_000).toISOString();
  const probe = openClient({ fake: o.fake, maxSends: 0, perHour: 1, since });
  const pf = await probe.preflight();
  probe.close();
  log(describePreflight(pf));
  const problems = preflightProblems(pf, o.allowProcessing);
  if (problems.length) throw new Error(problems.join('\n'));
  if (existing && existing.domain !== pf.domain) throw new Error(`${file} was delivered on ${existing.domain}, this account sends from ${pf.domain}`);

  const manifest: LiveManifest = existing ?? { name: o.name, run_tag: randomBytes(3).toString('hex').slice(0, 5), domain: pf.domain, created_at: new Date().toISOString(), since, cases: {} };
  const todo = cases.filter((c) => !['delivered', 'fault'].includes(manifest.cases[c.id]?.status ?? ''));
  const supported = todo.filter((c) => !liveSupport(c));
  const sends = supported.reduce((n, c) => n + materialize(c).messages.length - (manifest.cases[c.id]?.messages.length ?? 0), 0);
  const perHour = o.perHour ?? Math.max(1, Math.floor(pf.send_per_hour * 0.9));
  log(`${cases.length} cases selected: ${todo.length} to deliver (${todo.length - supported.length} replay-only), ${sends} emails to send at ≤${perHour}/hour (~${Math.ceil((sends / perHour) * 60)} min)`);
  if (sends > o.maxSends) throw new Error(`${sends} sends exceed --max-sends ${o.maxSends}; narrow the selection or raise the cap`);
  if (!o.fake && !o.yes) {
    log('nothing sent: re-run with --yes-send to deliver (every address is on your own domain; see bench/live/README.md)');
    return null;
  }
  const client = openClient({ fake: o.fake, maxSends: o.maxSends, perHour, since });
  const persist = () => { if (!o.fake) saveManifest(file, manifest); };
  persist();
  let next = 0;
  let done = 0;
  await Promise.all(Array.from({ length: Math.min(o.concurrency, todo.length) }, async () => {
    while (next < todo.length) {
      const c = todo[next++];
      const d = await deliverCase(client, c, manifest.cases[c.id], {
        runTag: manifest.run_tag, domain: manifest.domain, since,
        onProgress: (x) => { manifest.cases[c.id] = x; persist(); },
      });
      manifest.cases[c.id] = d;
      persist();
      log(`[${++done}/${todo.length}] ${d.status.padEnd(11)} ${c.id}${d.reason ? ` — ${redact(d.reason)}` : d.verification?.faults.length ? ` — ${d.verification.faults[0]}` : ''}`);
    }
  }));
  log(summarize(manifest));
  return { manifest, client };
}

/** For `run --live`: a read-only client and a mailbox per delivered case (null when the case was not delivered). */
export function liveMailboxes(manifest: LiveManifest, client: LiveClient): (c: BenchCase) => Mailbox | null {
  return (c) => {
    const d = manifest.cases[c.id];
    return d?.status === 'delivered' ? liveMailbox(c, d, client, manifest.since) : null;
  };
}

export function liveSkipReason(manifest: LiveManifest, c: BenchCase): string {
  const d = manifest.cases[c.id];
  if (!d) return `not delivered in live run ${manifest.name}`;
  return d.reason ?? (d.verification?.faults.length ? `delivery faults: ${d.verification.faults.slice(0, 2).join(' | ')}` : d.status);
}
