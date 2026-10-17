// End-to-end cold-handoff demo on a local simulation of Primitive (the README covers live mode).
//
//   npm run demo                    # offline: SQLite file + simulated mail; leaves the server + UI running
//   npm run demo -- --exit          # run and exit (CI / tests)
//   npm run demo:supabase -- --exit # same story on Supabase Postgres (SUPABASE_DB_URL, or the local `supabase start` stack),
//                                   # with authentication on and a scoped token per agent; mail is still simulated
//
// The story: Agent A, a long-running process, opens the negotiation and is then killed. With no agent
// running, finance approves in a different thread and the supplier corrects the delivery schedule.
// Agent B, a brand-new process with no memory, picks the task back up from compiled state alone.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { counterparty, defaultAddresses, procurementTask, type SimEmail } from '../src/sim/scenario.ts';

const { values: flags } = parseArgs({
  options: {
    step: { type: 'boolean', default: false },
    exit: { type: 'boolean', default: false },
    port: { type: 'string', default: process.env.PORT || '4100' },
    'no-phase2': { type: 'boolean', default: false },
    store: { type: 'string', default: 'sqlite' },
  },
});
const STORE = flags.store === 'postgres' || flags.store === 'supabase' ? 'postgres' : 'sqlite';
const PORT = flags.port!;
const API = `http://localhost:${PORT}`;
const DB = 'data/demo.db';

// filled in by preparePostgres() when running against Supabase
let operatorToken = '';
const tokensByAgent: Record<string, string> = {};
const serverEnv: Record<string, string> = {};

const addr = defaultAddresses();
const task = procurementTask(addr);
const taskPath = encodeURIComponent(task.id);

const C = { dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', green: '\x1b[32m', mag: '\x1b[35m', reset: '\x1b[0m' };

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
function printBanner(text: string, color = C.cyan) {
  console.log(`\n${color}${C.bold}━━━ ${text} ${'━'.repeat(Math.max(0, 70 - text.length))}${C.reset}`);
}
async function banner(text: string, color = C.cyan) {
  if (/^\d/.test(text)) await pause();
  printBanner(text, color);
}
const say = (text: string) => console.log(`${C.dim}demo:${C.reset} ${text}`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (operatorToken) headers.authorization = `Bearer ${operatorToken}`;
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(payload)}`);
  return payload as T;
}

// ---- child processes
const spawned: ChildProcess[] = [];
process.on('exit', () => {
  for (const child of spawned) if (child.exitCode === null) child.kill();
});

function start(script: string, argv: string[], prefix: string, color: string, env: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, [script, ...argv], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const relay = (chunk: Buffer) => {
    const out = chunk.toString().split('\n').filter(Boolean).map((line) => `${color}${prefix}${C.reset} ${line}\n`).join('');
    process.stdout.write(out);
  };
  child.stdout!.on('data', relay);
  child.stderr!.on('data', relay);
  spawned.push(child);
  return child;
}

function startAgent(name: string, mode: '--watch' | '--once', prefix: string, color: string) {
  const env: Record<string, string> = tokensByAgent[name] ? { CONTINUITY_TOKEN: tokensByAgent[name] } : {};
  return start('src/agent/run.ts', ['--task', task.alias, '--agent', name, mode, '--api', API], prefix, color, env);
}

const exitOf = (child: ChildProcess) => new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

// ---- simulation + state helpers
type Delivered = { webhook_status: number; result: { event_id: string; link_reason: string; linked: boolean }; message_id: string };
type SentMail = { messageId: string; subject: string; references: string[]; to: string; body: string };

async function agentRunCount() {
  return (await api<unknown[]>('GET', `/tasks/${taskPath}/agent-runs`)).length;
}
async function untilAgentRuns(n: number, timeoutMs = 20000) {
  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    if ((await agentRunCount()) >= n) return;
    await wait(150);
  }
  throw new Error(`timed out waiting for agent run #${n}`);
}
const setClock = (iso: string) => api('POST', '/sim/clock', { now: iso });
function deliver(email: SimEmail) {
  const attachments = (email.attachments ?? []).map((att) => ({ filename: att.filename, content_type: att.content_type, base64: att.bytes.toString('base64') }));
  return api<Delivered>('POST', '/sim/deliver', { ...email, attachments });
}
async function mailSentTo(address: string) {
  return (await api<SentMail[]>('GET', '/sim/sent')).filter((m) => m.to === address);
}

async function main() {
  // refuse to run on top of an existing server
  try {
    await fetch(`${API}/api/health`);
    throw new Error(`port ${PORT} is already in use — stop the other server or pass --port`);
  } catch (e) {
    if ((e as Error).message.startsWith('port')) throw e;
  }
  await banner('Continuity — cold agent handoff demo');
  if (STORE === 'postgres') {
    await preparePostgres();
  } else {
    for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
    Object.assign(serverEnv, { CONTINUITY_STORE: 'sqlite', CONTINUITY_DB: DB });
  }
  const server = start('src/server.ts', [], '[continuity]', C.dim, { ...serverEnv, PORT, CONTINUITY_TRANSPORT: 'sim' });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await api('GET', '/api/health');
      break;
    } catch {
      await wait(100);
    }
  }
  const health = await api<Record<string, unknown>>('GET', '/api/health');
  const storage = health.storage as { mode: string; target: string; authoritative: boolean };
  say(`server up: storage=${storage.mode} (${storage.target}${storage.authoritative ? ', authoritative' : ', offline'}) auth=${health.auth} transport=${health.transport} extractor=${health.extractor} agent_llm=${health.agent_llm}`);
  if (health.transport === 'local-sim') {
    say(`${C.yellow}LOCAL SIMULATION${C.reset}: mail is delivered as signed Primitive-format webhooks to our own endpoint; nothing leaves this machine.`);
  }

  await setClock('2026-10-19T08:55:00Z');
  await api('POST', '/tasks', task);
  say(`task ${task.alias}: ${task.goal}`);

  await banner('1. Agent A starts (long-running) and opens the negotiation');
  const agentA = startAgent('agent-a', '--watch', '[agent-a]', C.green);
  await untilAgentRuns(1);

  await banner('2. Supplier replies with an offer + quote PDF (Primitive thread #1)');
  await setClock('2026-10-19T11:20:00Z');
  const rfq = (await mailSentTo(addr.supplier))[0];
  const offer = await deliver(counterparty.supplierOffer(addr, { messageId: rfq.messageId, subject: rfq.subject }));
  say(`ingested ${offer.result.event_id} (${offer.result.link_reason})`);
  await untilAgentRuns(2);
  const promo = await deliver(counterparty.strayPromo(addr));
  say(`unrelated promo email ${promo.result.event_id}: linked=${promo.result.linked} (stays unlinked; never merged by similarity)`);

  await banner('3. Agent A is terminated (SIGKILL)', C.red);
  agentA.kill('SIGKILL');
  await exitOf(agentA);
  say(`agent-a pid ${agentA.pid} killed. From here on NO agent is running.`);

  await banner('4. While no agent runs: finance approves in a separate thread (#2)');
  await setClock('2026-10-19T15:05:00Z');
  const budgetRequest = (await mailSentTo(addr.finance))[0];
  const approval = await deliver(counterparty.financeApproval(addr, { messageId: budgetRequest.messageId, subject: budgetRequest.subject }));
  say(`ingested ${approval.result.event_id} (${approval.result.link_reason})`);

  await banner('5. ...and the supplier corrects the delivery schedule');
  await setClock('2026-10-20T10:12:00Z');
  const correction = await deliver(counterparty.supplierCorrection(addr, { messageId: offer.message_id, subject: `Re: ${rfq.subject}`, references: [rfq.messageId] }));
  say(`ingested ${correction.result.event_id} (${correction.result.link_reason})`);
  const loops = await api<{ next_actor: string; reason: string; conflicts: { check: string; detail: string }[]; waiting_on_them: { owed_by: string; what: string }[] }>('GET', `/tasks/${taskPath}/open-loops`);
  say(`state now: next actor = ${C.bold}${loops.next_actor}${C.reset}; conflicts: ${loops.conflicts.map((c) => c.detail).join(' | ')}`);
  say(`waiting on: ${loops.waiting_on_them.map((w) => `${w.owed_by}: ${w.what}`).join(' | ')}`);

  await banner('6. Agent B — a brand-new process with zero conversation history — wakes up', C.mag);
  const agentB = startAgent('agent-b', '--once', '[agent-b]', C.mag);
  if ((await exitOf(agentB)) !== 0) throw new Error('agent-b failed');
  console.log(`\n${C.bold}${C.mag}  ★ The agent that just sent that email never saw the original conversation.${C.reset}`);

  if (!flags['no-phase2']) {
    await banner('7. Supplier answers Agent B with an expedite offer + revised quote');
    await setClock('2026-10-21T09:30:00Z');
    const fromB = (await mailSentTo(addr.supplier)).at(-1)!;
    const resolution = await deliver(counterparty.supplierResolution(addr, { messageId: fromB.messageId, subject: fromB.subject, references: fromB.references }, fromB.body));
    say(`ingested ${resolution.result.event_id} (${resolution.result.link_reason})`);

    await banner('8. Agent C (another fresh process) closes the loop', C.mag);
    const agentC = startAgent('agent-c', '--once', '[agent-c]', C.mag);
    if ((await exitOf(agentC)) !== 0) throw new Error('agent-c failed');
  }

  await banner('Done', C.green);
  const final = await api<{ briefing_tokens: number; transcript_tokens: number; context: { next_actor: string; next_actor_reason: string } }>('GET', `/tasks/${taskPath}/context`);
  say(`final: next actor = ${final.context.next_actor} (${final.context.next_actor_reason})`);
  say(`inspect: ${API}/  (observability UI)   ·   ${API}/tasks/${taskPath}/context?format=text`);
  if (flags.exit) {
    server.kill();
    process.exit(0);
  }
  say('server still running — Ctrl+C to stop.');
}

/** Supabase mode: a new org for every run, an operator token for this script, and one scoped token per agent. */
async function preparePostgres() {
  let url = process.env.SUPABASE_DB_URL || '';
  const localStack: Record<string, string> = {};
  if (!url) {
    try {
      const out = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split('\n')) {
        const m = line.match(/^([A-Z_]+)="?(.*?)"?$/);
        if (m) localStack[m[1]] = m[2];
      }
      url = localStack.DB_URL ?? '';
    } catch {
      // no local stack running
    }
  }
  if (!url) throw new Error('--store postgres needs SUPABASE_DB_URL, or a local stack (supabase start && supabase migration up --local)');

  const { PostgresBackend } = await import('../src/store/postgres.ts');
  const { mintToken } = await import('../src/auth.ts');
  const backend = new PostgresBackend(url);
  await backend.init();
  const org = `org_demo_${Date.now().toString(36)}`;
  operatorToken = (await mintToken(backend, { org, kind: 'operator', label: 'demo script' })).token;
  for (const name of ['agent-a', 'agent-b', 'agent-c']) {
    tokensByAgent[name] = (await mintToken(backend, { org, kind: 'agent', agent_id: name, task_ids: [task.id], label: `demo ${name}` })).token;
  }
  await backend.close();

  // storage credentials for the server: explicit env wins; otherwise borrow the local stack's
  const localKey = localStack.SECRET_KEY || localStack.SERVICE_ROLE_KEY;
  const storageEnv = process.env.SUPABASE_URL ? {} : localStack.API_URL && localKey ? { SUPABASE_URL: localStack.API_URL, SUPABASE_SECRET_KEY: localKey } : {};
  Object.assign(serverEnv, { CONTINUITY_STORE: 'postgres', SUPABASE_DB_URL: url, CONTINUITY_ORG: org, ...storageEnv });
  say(`Supabase Postgres: org ${org}; 1 operator token + 3 agent tokens (each limited to ${task.alias} and its own agent id)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
