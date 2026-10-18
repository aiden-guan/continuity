// Live delivery: play a benchmark case through real Primitive mail, then check that what Primitive
// stored is what the case says was sent.
//
// Every address in a case (made-up domains such as northwind-components.example) is mapped to a unique
// address on the account's own Primitive domain: `<run><case>.<name>-<domain hash>@<your domain>`. The
// run and case tags keep runs and cases apart in one inbox, and the domain hash keeps look-alike domains
// distinct. Systems under test see the case's own addresses again (view.ts maps them back), so the
// labels, the task header and the scorer are unchanged.
//
// Order: one case's messages are sent strictly in sequence, and each inbound message must have arrived
// before the next is sent, so Primitive sees the case's order (threads, `awaiting`, reply links). Cases
// run side by side; the client paces sends under the hourly limit.
// Resume: the manifest is written after every message and every send carries an idempotency key derived
// from (run, case, message), so a crashed or repeated run never sends a message twice.
// Security: only addresses on the account's own domain are ever used (checked before every send), and
// cases with spoofed senders (DMARC failure) are not sent: real mail from our own domain always
// authenticates, so those cases would test something else. They stay replay-only.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BenchCase } from '../core/types.ts';
import { awaitingFor, materialize, type MailMessage } from '../core/mailbox.ts';
import { makePdf } from '../../src/sim/pdf.ts';
import { attachmentText } from '../../src/ingest/attachments.ts';
import { detailAsEvent, senderAuthOf } from '../../src/ingest/sender-auth.ts';
import { decodeMimeWords } from '../../src/ingest/normalize.ts';
import { redact, type LiveClient, type Rec } from './client.ts';

export interface DeliveredMessage {
  m: string; // m07
  key: string; // oracle key
  direction: 'inbound' | 'outbound';
  sent_id: string;
  message_id: string;
  thread_id: string | null; // Primitive's thread id, from the row the agent's inbox holds (inbound) or the sent row
  references: string[];
  inbound_id: string | null; // the row in our agent's inbox (inbound mail only)
  scripted_at: string;
  sent_at: string;
  received_at: string | null;
  latency_ms: number | null;
  replayed: boolean;
}

export interface CaseDelivery {
  case_id: string;
  case_hash: string;
  status: 'delivered' | 'fault' | 'unsupported' | 'error';
  reason?: string;
  self: string;
  /** case address → live address */
  aliases: Record<string, string>;
  messages: DeliveredMessage[];
  /** faults exclude the case from a live run; differences are real Primitive behaviour and are kept */
  verification?: { faults: string[]; differences: string[] };
  started_at: string;
  finished_at?: string;
}

export interface LiveManifest {
  name: string;
  run_tag: string;
  domain: string;
  created_at: string;
  /** Lower bound for every list/search the live tools make (mail older than the run is never shown). */
  since: string;
  cases: Record<string, CaseDelivery>;
}

export const caseHash = (c: BenchCase) => createHash('sha256').update(JSON.stringify(c)).digest('hex');
const short = (s: string, n = 6) => createHash('sha256').update(s).digest('hex').slice(0, n);

// ------------------------------------------------------------------ addresses

export function aliasesFor(c: BenchCase, runTag: string, domain: string): Record<string, string> {
  const tag = `b${runTag}${short(c.id)}`;
  const addrs = new Set<string>([c.task.self_address, ...c.task.parties.map((p) => p.address)]);
  for (const e of c.events) [e.from, ...e.to, ...(e.cc ?? [])].forEach((a) => addrs.add(a));
  const out: Record<string, string> = {};
  for (const a of [...addrs].map((x) => x.toLowerCase()).sort()) {
    const [local, dom = ''] = a.split('@');
    const name = local.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'x';
    out[a] = `${tag}.${name}-${short(dom, 4)}@${domain}`;
  }
  return out;
}

/** Rewrites every live address in a piece of text back to the case address it stands for. */
export function caseMapper(aliases: Record<string, string>): (s: string) => string {
  const pairs = Object.entries(aliases).map(([caseAddr, alias]) => [alias.toLowerCase(), caseAddr] as const).sort((a, b) => b[0].length - a[0].length);
  if (!pairs.length) return (s) => s;
  const rx = new RegExp(pairs.map(([alias]) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  const back = new Map(pairs);
  return (s) => s.replace(rx, (m) => back.get(m.toLowerCase()) ?? m);
}

/** Refuse anything that would leave the account's own domain. */
export function assertOwnDomain(address: string, domain: string) {
  const at = address.lastIndexOf('@');
  if (at < 0 || address.slice(at + 1).toLowerCase() !== domain.toLowerCase()) throw new Error(`refusing to send to ${address}: not on ${domain}`);
}

/** Why a case cannot be reproduced over real mail, or null when it can. */
export function liveSupport(c: BenchCase): string | null {
  const spoofed = c.events.filter((e) => e.auth === 'fail').map((e) => e.key);
  if (spoofed.length) return `spoofed sender (${spoofed.join(', ')}): mail sent from our own domain always passes DMARC, so this case stays replay-only`;
  return null;
}

// ------------------------------------------------------------------ manifest

export function loadManifest(file: string): LiveManifest | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as LiveManifest) : null;
}

export function saveManifest(file: string, manifest: LiveManifest) {
  mkdirSync(dirname(file), { recursive: true });
  // write-then-rename, so an interrupted write never leaves a half manifest behind
  writeFileSync(`${file}.tmp`, JSON.stringify(manifest, null, 1));
  renameSync(`${file}.tmp`, file);
}

// ------------------------------------------------------------------ delivery

const attachmentBytes = (a: MailMessage['attachments'][number]) => (a.content_type === 'application/pdf' ? makePdf(a.lines) : Buffer.from(a.text, 'utf8'));
const norm = (s: string) => s.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
const bare = (v: string) => ([...String(v ?? '').matchAll(/<([^<>]+@[^<>]+)>/g)].at(-1)?.[1] ?? String(v ?? '')).trim().toLowerCase();
const displayName = (v: string) => String(v ?? '').match(/^\s*"?([^"<]+?)"?\s*</)?.[1].trim() ?? null;

export interface DeliverOpts {
  runTag: string;
  domain: string;
  since: string;
  arrivalTimeoutMs?: number;
  /** Called after every message, with the case record as it stands (persist the manifest here). */
  onProgress?: (d: CaseDelivery) => void;
}

export async function deliverCase(client: LiveClient, c: BenchCase, prior: CaseDelivery | undefined, opts: DeliverOpts): Promise<CaseDelivery> {
  const hash = caseHash(c);
  const unsupported = liveSupport(c);
  const aliases = aliasesFor(c, opts.runTag, opts.domain);
  const self = aliases[c.task.self_address.toLowerCase()];
  const started = new Date().toISOString();
  if (unsupported) return { case_id: c.id, case_hash: hash, status: 'unsupported', reason: unsupported, self, aliases, messages: [], started_at: started, finished_at: started };
  if (prior && prior.case_hash !== hash) throw new Error(`${c.id} changed since it was delivered in this run; start a new live run`);
  if (prior?.status === 'delivered' || prior?.status === 'fault') return prior;

  const d: CaseDelivery = { case_id: c.id, case_hash: hash, status: 'error', self, aliases, messages: [...(prior?.messages ?? [])], started_at: prior?.started_at ?? started };
  const mb = materialize(c);
  const live = (addr: string) => {
    const a = aliases[addr.toLowerCase()];
    if (!a) throw new Error(`${c.id}: no live address for ${addr}`);
    assertOwnDomain(a, opts.domain);
    return a;
  };
  const byKey = new Map(d.messages.map((x) => [x.key, x]));
  try {
    for (const m of mb.messages) {
      if (byKey.get(m.key)?.inbound_id || (byKey.get(m.key) && m.event.direction === 'outbound')) continue;
      const e = m.event;
      const parent = e.replyTo ? byKey.get(e.replyTo) : undefined;
      if (e.replyTo && !parent) throw new Error(`${c.id}/${m.id}: parent ${e.replyTo} was not delivered`);
      const to = e.to.map(live);
      const cc = (e.cc ?? []).map(live);
      // the agent's inbox holds every inbound message; if the case does not address it, it got a blind copy
      const bcc = e.direction === 'inbound' && ![...to, ...cc].includes(self) ? [self] : [];
      const references = parent ? [...parent.references, parent.message_id] : [];
      const sent = await client.send({
        from: `${e.fromName} <${live(e.from)}>`,
        to: to[0],
        cc: [...to.slice(1), ...cc],
        bcc,
        subject: e.subject,
        bodyText: m.body,
        inReplyTo: parent?.message_id ?? null,
        references,
        attachments: m.attachments.map((a) => ({ filename: a.filename, content_type: a.content_type, bytes: attachmentBytes(a) })),
      }, `bench-${opts.runTag}-${short(c.id, 10)}-${m.key}`);
      if (!sent.message_id) throw new Error(`${c.id}/${m.id}: Primitive returned no Message-ID for send ${sent.id}`);
      if (['bounced', 'agent_failed', 'gate_denied', 'canceled'].includes(sent.status)) throw new Error(`${c.id}/${m.id}: send ${sent.id} ended ${sent.status}`);

      let inbound: { id: string; received_at: string } | null = null;
      if (e.direction === 'inbound') inbound = await client.awaitInbound(sent.message_id, self, { notBefore: opts.since, timeoutMs: opts.arrivalTimeoutMs ?? 180_000 });
      const row: DeliveredMessage = {
        m: m.id, key: m.key, direction: e.direction, sent_id: sent.id, message_id: sent.message_id, thread_id: sent.thread_id, references,
        inbound_id: inbound?.id ?? null, scripted_at: e.at, sent_at: sent.created_at, received_at: inbound?.received_at ?? null,
        latency_ms: inbound ? Date.parse(inbound.received_at) - Date.parse(sent.created_at) : null, replayed: sent.replayed,
      };
      if (inbound) {
        const detail = await client.getEmail(inbound.id);
        row.thread_id = detail?.thread_id ?? row.thread_id;
      }
      d.messages = [...d.messages.filter((x) => x.key !== m.key), row];
      byKey.set(m.key, row);
      opts.onProgress?.(d);
    }
    d.verification = await verifyCase(client, c, d);
    d.status = d.verification.faults.length ? 'fault' : 'delivered';
  } catch (err) {
    d.status = 'error';
    d.reason = redact((err as Error).message);
  }
  d.finished_at = new Date().toISOString();
  opts.onProgress?.(d);
  return d;
}

// ------------------------------------------------------------------ verification

/** Compare what Primitive stored with what the case says was sent. */
export async function verifyCase(client: LiveClient, c: BenchCase, d: CaseDelivery): Promise<{ faults: string[]; differences: string[] }> {
  const mb = materialize(c);
  const faults: string[] = [];
  const differences: string[] = [];
  const byKey = new Map(d.messages.map((x) => [x.key, x]));
  const alias = (a: string) => d.aliases[a.toLowerCase()];
  for (const m of mb.messages) {
    const got = byKey.get(m.key);
    const e = m.event;
    const where = `${m.id} (${e.direction} ${e.subject.slice(0, 40)})`;
    if (!got) { faults.push(`${where}: not delivered`); continue; }
    const parent = e.replyTo ? byKey.get(e.replyTo) : undefined;
    if (e.direction === 'outbound') {
      const s = await client.getSentEmail(got.sent_id);
      if (!s) { faults.push(`${where}: sent row ${got.sent_id} not found`); continue; }
      if (['bounced', 'agent_failed', 'gate_denied', 'canceled'].includes(String(s.status))) faults.push(`${where}: send ${s.status}`);
      if (bare(s.to_address ?? s.to_header) !== alias(e.to[0])) faults.push(`${where}: sent to ${s.to_address ?? s.to_header}`);
      if (parent && s.in_reply_to !== parent.message_id) faults.push(`${where}: In-Reply-To ${s.in_reply_to ?? 'missing'}, expected ${parent.message_id}`);
      if (s.body_text != null && !norm(String(s.body_text)).includes(norm(e.body))) faults.push(`${where}: stored body differs from what was sent`);
      continue;
    }
    if (!got.inbound_id) { faults.push(`${where}: never arrived in the agent's inbox`); continue; }
    const r = await client.getEmail(got.inbound_id);
    if (!r) { faults.push(`${where}: inbound row ${got.inbound_id} not found`); continue; }
    if (r.status === 'rejected') faults.push(`${where}: rejected by Primitive (${r.rejection_reason ?? 'no reason'})`);
    const from = bare(r.from_header ?? r.from_email);
    if (from !== alias(e.from)) faults.push(`${where}: From ${from}, expected ${alias(e.from)}`);
    if (displayName(r.from_header) !== e.fromName) differences.push(`${where}: sender name "${displayName(r.from_header) ?? ''}" (sent "${e.fromName}")`);
    if (norm(r.subject ?? '') !== norm(e.subject)) {
      // seen live: a non-ASCII subject on a message sent with a Cc can be stored still RFC 2047-encoded
      if (norm(decodeMimeWords(String(r.subject ?? ''))) === norm(e.subject)) differences.push(`${where}: Primitive stored the subject undecoded (RFC 2047): "${String(r.subject).replace(/\s+/g, ' ')}"`);
      else faults.push(`${where}: subject "${r.subject}"`);
    }
    const parsed = (r.parsed ?? {}) as Rec;
    const body = String(parsed.body_text ?? r.body_text ?? '');
    if (!norm(body).includes(norm(e.body))) faults.push(`${where}: the author's text is not in the stored body`);
    else if (!norm(body).includes(norm(m.body))) differences.push(`${where}: quoted history changed in transit`);
    if (parent) {
      const irt = ([] as string[]).concat(parsed.in_reply_to ?? []);
      if (!irt.includes(parent.message_id)) faults.push(`${where}: In-Reply-To ${irt.join(' ') || 'missing'}, expected ${parent.message_id}`);
      if (parent.thread_id && r.thread_id && r.thread_id !== parent.thread_id) differences.push(`${where}: Primitive put it in a new thread (${r.thread_id})`);
    }
    const wantCc = new Set([...e.to.slice(1), ...(e.cc ?? [])].map(alias));
    const gotCc = new Set(((parsed.cc ?? []) as Rec[]).map((x) => String(x.address ?? x).toLowerCase()));
    if ([...wantCc].some((a) => !gotCc.has(a))) differences.push(`${where}: cc ${[...gotCc].join(', ') || 'none'}, sent ${[...wantCc].join(', ')}`);
    const atts = ((parsed.attachments ?? []) as Rec[]);
    for (const [i, a] of m.attachments.entries()) {
      const stored = atts.find((x) => x.filename === a.filename);
      if (!stored) { faults.push(`${where}: attachment ${a.filename} missing`); continue; }
      try {
        const text = norm(attachmentText(a.filename, String(stored.content_type ?? a.content_type), await client.downloadAttachment(got.inbound_id, Number(stored.part_index ?? i))));
        const lost = a.lines.filter((l) => l.trim() && !text.includes(norm(l)));
        if (lost.length) faults.push(`${where}: ${a.filename} lost ${lost.length} line(s) in transit, e.g. "${lost[0].slice(0, 60)}"`);
      } catch (err) {
        faults.push(`${where}: ${a.filename} could not be downloaded (${redact((err as Error).message)})`);
      }
    }
    const auth = senderAuthOf(detailAsEvent(r), from);
    if (auth.status !== 'pass') faults.push(`${where}: sender did not authenticate (${auth.reason})`);
    // every party is an inbox in the same Primitive org, so the other side's copies of a message are rows too;
    // say so when that makes Primitive's thread-level `awaiting` differ from what an outside counterparty gives
    if (m.id === mb.trigger.id && r.awaiting && r.awaiting !== awaitingFor(mb, m.thread_id)) {
      differences.push(`${where}: Primitive says awaiting "${r.awaiting}", a counterparty outside the org would give "${awaitingFor(mb, m.thread_id)}"`);
    }
  }
  return { faults, differences };
}
