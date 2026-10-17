// Deal-room demo: a buyer's agent buying 42 Elm St, on a local simulation of Primitive.
//
//   npm run demo:deal              # offline (SQLite + simulated mail + heuristic extractor + policy agent); leaves the server running
//   npm run demo:deal -- --step    # one Enter per beat (for presenting)
//   npm run demo:deal -- --exit    # run and exit (CI)
//   npm run demo:deal -- --llm     # let the server and agents use Claude when ANTHROPIC_API_KEY is set
//
// Four parties across four email threads. Agent A opens the deal and is killed. While no agent runs, the
// buyer approves a ceiling, the inspector books, the lender's appraisal comes in short and the listing agent
// moves the closing date. Signal raises what matters unprompted, the guard refuses a premature acceptance,
// a fresh Agent B negotiates from compiled state alone, and a fresh Agent C accepts once every requirement
// passes. Ported from samrocksnature's b615ab7 (the forged-sender, human-approval and wire-fraud beats
// of the original belong to the sender-authentication and approvals work and are not part of this demo).
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import type { SimEmail } from '../src/sim/scenario.ts';
import { dealAddresses, dealParties as P, elmStreetDeal } from '../src/sim/real-estate.ts';

const { values: flags } = parseArgs({
  options: {
    step: { type: 'boolean', default: false },
    exit: { type: 'boolean', default: false },
    llm: { type: 'boolean', default: false },
    port: { type: 'string', default: process.env.PORT || '4100' },
  },
});
const PORT = flags.port!;
const API = `http://localhost:${PORT}`;
const DB = 'data/demo-deal.db';
const a = dealAddresses();
const task = elmStreetDeal(a);
const T = encodeURIComponent(task.id);
// offline unless --llm: the heuristic extractor and the rule-based policy agent
const OFFLINE = !flags.llm;

const C = { dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', green: '\x1b[32m', mag: '\x1b[35m', blue: '\x1b[34m', reset: '\x1b[0m' };

// --step: one Enter per numbered beat. Reads lines (not raw keys) so piped input works as well.
const waiting: (() => void)[] = [];
let earlyPresses = 0;
if (flags.step) {
  createInterface({ input: process.stdin }).on('line', () => {
    const wake = waiting.shift();
    if (wake) wake();
    else earlyPresses++;
  });
}
async function pause() {
  if (!flags.step) return;
  process.stdout.write(`${C.dim}  [enter] to continue…${C.reset}\n`);
  if (earlyPresses > 0) {
    earlyPresses--;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}
async function banner(text: string, color = C.cyan) {
  if (/^\d/.test(text)) await pause();
  console.log(`\n${color}${C.bold}━━━ ${text} ${'━'.repeat(Math.max(0, 70 - text.length))}${C.reset}`);
}
const say = (text: string) => console.log(`${C.dim}demo:${C.reset} ${text}`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function api<J>(method: string, path: string, body?: unknown): Promise<J> {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await res.json();
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status} ${JSON.stringify(payload)}`), { status: res.status, body: payload });
  return payload as J;
}

// ---- child processes
const spawned: ChildProcess[] = [];
process.on('exit', () => {
  for (const child of spawned) if (child.exitCode === null) child.kill();
});
function start(script: string, argv: string[], prefix: string, color: string, env: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, [script, ...argv], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const relay = (chunk: Buffer) => process.stdout.write(chunk.toString().split('\n').filter(Boolean).map((line) => `${color}${prefix}${C.reset} ${line}\n`).join(''));
  child.stdout!.on('data', relay);
  child.stderr!.on('data', relay);
  spawned.push(child);
  return child;
}
const startAgent = (name: string, mode: '--watch' | '--once', color: string) =>
  start('src/agent/run.ts', ['--task', task.alias, '--agent', name, mode, '--api', API, '--quiet', ...(OFFLINE ? ['--mode', 'policy'] : [])], `[${name}]`, color);
const exitOf = (child: ChildProcess) => new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.on('exit', (code) => resolve(code))));

// ---- simulation helpers
const runCount = async () => (await api<unknown[]>('GET', `/tasks/${T}/agent-runs`)).length;
async function untilRuns(n: number, timeoutMs = 20000) {
  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    if ((await runCount()) >= n) return;
    await wait(150);
  }
  throw new Error(`timed out waiting for agent run #${n}`);
}
const setClock = (iso: string) => api('POST', '/sim/clock', { now: iso });
type Delivered = { result: { event_id: string; link_reason: string; linked: boolean }; message_id: string };
const deliver = (e: SimEmail) => api<Delivered>('POST', '/sim/deliver', { ...e, attachments: (e.attachments ?? []).map((x) => ({ filename: x.filename, content_type: x.content_type, base64: x.bytes.toString('base64') })) });
type Sent = { messageId: string; subject: string; references: string[]; to: string; body: string };
async function lastTo(address: string) {
  const s = (await api<Sent[]>('GET', '/sim/sent')).filter((m) => m.to === address).at(-1);
  return s ? { messageId: s.messageId, subject: s.subject, references: s.references, body: s.body } : null;
}
const arrived = (who: string, d: Delivered, what: string) => say(`${C.blue}${who}${C.reset} → ${what}  ${C.dim}(${d.result.event_id}, linked by ${d.result.link_reason})${C.reset}`);

type Alert = { severity: string; summary: string };
async function signal(label: string) {
  const r = await api<{ new: Alert[]; reopened: Alert[]; open: Alert[]; resolved: string[] }>('POST', '/signals/run');
  const mark: Record<string, string> = { high: `${C.red}HIGH${C.reset}`, medium: `${C.yellow}MED ${C.reset}`, low: `${C.dim}LOW ${C.reset}` };
  say(`Signal ${label}: ${r.new.length} new alert(s), ${r.resolved.length} cleared, ${r.open.length} open`);
  for (const s of [...r.new, ...r.reopened]) console.log(`   ${mark[s.severity]}  ${s.summary}`);
}

async function main() {
  try {
    await fetch(`${API}/api/health`);
    throw new Error(`port ${PORT} is already in use — stop the other server or pass --port`);
  } catch (e) {
    if ((e as Error).message.startsWith('port')) throw e;
  }
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  await banner('Continuity deal room — 42 Elm St');
  start('src/server.ts', [], '[continuity]', C.dim, {
    CONTINUITY_STORE: 'sqlite', CONTINUITY_DB: DB, PORT, CONTINUITY_TRANSPORT: 'sim', CONTINUITY_AUTH: 'off',
    ...(OFFLINE ? { CONTINUITY_EXTRACTOR: 'heuristic' } : {}),
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await api('GET', '/api/health');
      break;
    } catch {
      await wait(100);
    }
  }
  const health = await api<{ storage: { mode: string }; extractor: string; transport: string }>('GET', '/api/health');
  say(`server up: storage=${health.storage.mode} transport=${health.transport} extractor=${health.extractor}`);
  say(`${C.yellow}LOCAL SIMULATION${C.reset}: every email is a signed Primitive-format webhook to our own endpoint; nothing leaves this machine.`);
  await setClock('2026-10-19T08:55:00Z');
  await api('POST', '/tasks', task);
  say(`deal ${task.alias}: ${task.goal}`);
  say('parties: listing agent (seller side), buyer, lender, inspector — four inboxes, four threads');

  await banner('1. Agent A (long-running) opens the deal');
  const agentA = startAgent('agent-a', '--watch', C.green);
  await untilRuns(1);
  for (const who of [a.listing, a.buyer, a.lender]) {
    const m = await lastTo(who);
    if (m) say(`agent-a → ${who}: "${m.subject}"`);
  }

  await banner('2. The listing agent counters at $845,000 — signed counter PDF attached');
  await setClock('2026-10-20T10:05:00Z');
  arrived('listing agent', await deliver(P.listingCounter(a, (await lastTo(a.listing))!)), 'counter $845,000, close Fri Nov 20, inspection contingency to Fri Oct 30 (+ PDF)');
  await untilRuns(2);

  await banner('3. Agent A is terminated (SIGKILL)', C.red);
  agentA.kill('SIGKILL');
  await exitOf(agentA);
  say(`agent-a pid ${agentA.pid} killed. From here on NO agent is running.`);

  await banner('4. While no agent runs: four parties write, in four threads');
  await setClock('2026-10-20T18:30:00Z');
  arrived('buyer', await deliver(P.buyerApproval(a, (await lastTo(a.buyer))!)), 'approves going up to $850,000');
  await setClock('2026-10-21T08:00:00Z');
  arrived('inspector', await deliver(P.inspectorBooking(a)), 'inspection Fri Oct 23; report promised by Mon Oct 26');
  await setClock('2026-10-22T14:00:00Z');
  arrived('lender', await deliver(P.lenderAppraisal(a, (await lastTo(a.lender))!)), 'appraisal came in at $830,000');
  await setClock('2026-10-23T09:15:00Z');
  arrived('listing agent', await deliver(P.listingCorrection(a, (await lastTo(a.listing))!)), '"correction": closing moves to Fri Dec 4; revised counter promised');

  await banner('5. Monday Oct 27. Nobody has asked anything. Signal runs.', C.yellow);
  await setClock('2026-10-27T08:00:00Z');
  await signal('(scan of every deal)');

  await banner('6. Trust: what the system refused to believe or do', C.red);
  const st = await api<{ flags: { kind: string; detail: string }[] }>('GET', `/tasks/${T}/state`);
  const injected = st.flags.find((f) => f.kind === 'prompt_injection_suspected');
  if (injected) say(`the counter PDF said: "${injected.detail.slice(0, 92)}…" → ${C.red}quarantined${C.reset} (data, not an instruction)`);
  try {
    await api('POST', `/tasks/${T}/send`, { agent_id: 'hasty-agent', to: a.listing, body: 'Deal — we accept the $845,000 counter. Please send the contract.' });
    say(`${C.red}unexpected: the premature acceptance was sent${C.reset}`);
  } catch (err) {
    const reasons = (err as { body?: { detail?: { reasons?: string[] } } }).body?.detail?.reasons ?? [(err as Error).message];
    say(`a hasty agent tries "Deal — we accept the $845,000 counter" → ${C.red}refused${C.reset}:`);
    for (const r of reasons) console.log(`   · ${r}`);
  }

  await banner('7. Agent B — a brand-new process, zero memory — reads the compiled state and acts', C.mag);
  const ctx = await api<{ briefing_tokens: number; transcript_tokens: number }>('GET', `/tasks/${T}/context`);
  say(`briefing ~${ctx.briefing_tokens} tokens for four parties and every open loop (full transcript ~${ctx.transcript_tokens})`);
  await setClock('2026-10-27T09:00:00Z');
  if ((await exitOf(startAgent('agent-b', '--once', C.mag))) !== 0) throw new Error('agent-b failed');
  const toListing = (await lastTo(a.listing))!;
  console.log(toListing.body.split('\n').map((l) => `   ${C.dim}│${C.reset} ${l}`).join('\n'));
  console.log(`\n${C.bold}${C.mag}  ★ Agent B never saw a single one of those emails.${C.reset}`);

  await banner('8. The seller agrees; the inspector delivers');
  await setClock('2026-10-28T11:00:00Z');
  arrived('listing agent', await deliver(P.listingResolution(a, toListing, toListing.body)), 'seller agrees to $830,000 and keeps Fri Nov 20 (+ revised counter PDF)');
  await setClock('2026-10-28T13:00:00Z');
  const toInspector = await lastTo(a.inspector);
  arrived('inspector', await deliver(P.inspectorReport(a, toInspector ?? { messageId: null, subject: 'Inspection booked: 42 Elm St (ELM-42)' })), 'inspection report (+ PDF)');
  await signal('(after the replies)');

  await banner('9. Agent C (another fresh process) accepts — every requirement now passes', C.mag);
  await setClock('2026-10-28T14:00:00Z');
  if ((await exitOf(startAgent('agent-c', '--once', C.mag))) !== 0) throw new Error('agent-c failed');
  const accepted = (await lastTo(a.listing))!;
  console.log(accepted.body.split('\n').map((l) => `   ${C.dim}│${C.reset} ${l}`).join('\n'));

  await banner('10. One timeline per deal: every typed event, with its source email', C.cyan);
  type Ev = { at: string; type: string; party: string | null; display?: string; replaces?: string; applied: boolean; source_event: string | null };
  const history = await api<{ events: Ev[] }>('GET', `/tasks/${T}/history`);
  const quiet = new Set(['message_received', 'message_sent', 'question_answered', 'request_answered', 'request_made', 'question_asked']);
  for (const e of history.events.filter((x) => !quiet.has(x.type))) {
    console.log(`   ${e.at.slice(5, 16).replace('T', ' ')}  ${C.bold}${e.type.padEnd(24)}${C.reset} ${(e.party ?? '').padEnd(17)} ${e.replaces ? `${e.replaces} → ` : ''}${e.display ?? ''}${e.applied ? '' : `  ${C.red}(not applied)${C.reset}`}  ${C.dim}${e.source_event ?? ''}${C.reset}`);
  }
  type Terms = { terms: { term: string; party: string; display: string }[] };
  const then = await api<Terms>('GET', `/tasks/${T}/state-at?at=2026-10-23T12:00:00Z`);
  const now = await api<Terms>('GET', `/tasks/${T}/state-at?at=2026-10-28T23:59:00Z`);
  const pick = (s: Terms, term: string, party: string) => s.terms.find((x) => x.term === term && x.party === party)?.display ?? '—';
  say(`state on Fri Oct 23 noon: price ${pick(then, 'price.purchase', 'listing agent')}, closing ${pick(then, 'closing.date', 'listing agent')}, appraisal ${pick(then, 'appraisal.value', 'lender')}`);
  say(`state now:               price ${pick(now, 'price.purchase', 'listing agent')}, closing ${pick(now, 'closing.date', 'listing agent')}, appraisal ${pick(now, 'appraisal.value', 'lender')}`);

  await banner('Done', C.green);
  const fin = await api<{ context: { next_actor: string; next_actor_reason: string } }>('GET', `/tasks/${T}/context`);
  say(`final: next actor = ${fin.context.next_actor} (${fin.context.next_actor_reason})`);
  say(`inspect: ${API}/  (observability UI)   ·   ${API}/tasks/${T}/history`);
  if (flags.exit) process.exit(0);
  say('server still running — Ctrl+C to stop.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
