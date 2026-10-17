// The LIVE demo, in one command, on real Primitive mail.
//
//   npm run demo:live                # full story, leaves server + UI running on :4100
//   npm run demo:live -- --step      # pause before each beat (Enter to continue) — for presenting
//   npm run demo:live -- --fast      # rule-based extractor + offline policy agent (no Claude calls, faster)
//   npm run demo:live -- --exit      # exit when done
//
// .env must provide PRIMITIVE_API_KEY plus three addresses on your Primitive domain
// (CONTINUITY_SELF_ADDRESS / _SUPPLIER_ / _FINANCE_). With ANTHROPIC_API_KEY (+ workspace id) both the
// agents and the extractor use Claude; without it, or with --fast, the offline versions run instead.
//
// Every message in this story is real Primitive mail. Supplier and finance are scripted counterparties
// that reply in-thread from their own inboxes; the agents are separate processes that only ever see
// Continuity's compiled state. Agent A gets SIGKILLed halfway through.
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createPrimitiveClient, type ReplyInput } from '@primitivedotdev/sdk';
import { getEmail } from '@primitivedotdev/sdk/api';
import { counterparty, defaultAddresses, procurementTask, quoteV1, quoteV2 } from '../src/sim/scenario.ts';
import { openBackend } from '../src/store/index.ts';
import { mintToken } from '../src/auth.ts';

const { values: flags } = parseArgs({
  options: {
    step: { type: 'boolean', default: false },
    exit: { type: 'boolean', default: false },
    fast: { type: 'boolean', default: false },
    port: { type: 'string', default: process.env.PORT || '4100' },
  },
});
const PORT = flags.port!;
const API = `http://localhost:${PORT}`;
const DB = 'data/live-demo.db';
const RUN_STARTED = new Date().toISOString();
const addr = defaultAddresses();
const task = procurementTask(addr);
const taskPath = encodeURIComponent(task.id);
const agentMode = flags.fast || !process.env.ANTHROPIC_API_KEY ? 'policy' : 'llm';

const C = { dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', green: '\x1b[32m', mag: '\x1b[35m', blue: '\x1b[34m', reset: '\x1b[0m' };
const say = (text: string) => console.log(`${C.dim}demo:${C.reset} ${text}`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- preflight -------------------------------------------------------------------------
const apiKey = process.env.PRIMITIVE_API_KEY;
if (!apiKey) {
  console.error('PRIMITIVE_API_KEY is not set (.env). For the offline demo use `npm run demo`.');
  process.exit(1);
}
const domains = new Set([addr.self, addr.supplier, addr.finance].map((x) => x.split('@')[1]));
if (!process.env.CONTINUITY_SELF_ADDRESS || !process.env.CONTINUITY_SUPPLIER_ADDRESS || !process.env.CONTINUITY_FINANCE_ADDRESS) {
  console.error('Set CONTINUITY_SELF_ADDRESS, CONTINUITY_SUPPLIER_ADDRESS and CONTINUITY_FINANCE_ADDRESS in .env (addresses on your Primitive domain).');
  process.exit(1);
}
const primitive = createPrimitiveClient({ apiKey });

// ---- step mode -------------------------------------------------------------------------
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
async function beat(title: string, color = C.cyan) {
  if (/^\d/.test(title)) await pause();
  console.log(`\n${color}${C.bold}━━━ ${title} ${'━'.repeat(Math.max(0, 70 - title.length))}${C.reset}`);
}

// ---- child processes -------------------------------------------------------------------
const spawned: ChildProcess[] = [];
function stopAll() {
  for (const child of spawned) if (child.exitCode === null) child.kill();
}
process.on('exit', stopAll);
process.on('SIGINT', () => {
  stopAll();
  process.exit(130);
});

const prefixLines = (chunk: Buffer, tag: string) => chunk.toString().split('\n').filter(Boolean).map((line) => `${tag} ${line}\n`).join('');

function start(file: string, argv: string[], prefix: string, color: string, env: Record<string, string> = {}, quiet = false): ChildProcess {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', file, ...argv], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  // stdout can be silenced; stderr always shows, in red
  child.stdout!.on('data', (d: Buffer) => {
    if (!quiet) process.stdout.write(prefixLines(d, `${color}${prefix}${C.reset}`));
  });
  child.stderr!.on('data', (d: Buffer) => process.stdout.write(prefixLines(d, `${C.red}${prefix}${C.reset}`)));
  spawned.push(child);
  return child;
}
function exitOf(child: ChildProcess) {
  return new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.on('exit', (code) => resolve(code));
  });
}
const startAgent = (name: string, mode: '--watch' | '--once', color: string) =>
  start('src/agent/run.ts', ['--task', task.alias, '--agent', name, mode, '--mode', agentMode, '--api', API], `[${name}]`, color, { CONTINUITY_TOKEN: tokens[name] ?? '' });

// live mode refuses an unauthenticated API: this script, the receiver and each agent get their own token
const tokens: Record<string, string> = {};
async function mintDemoTokens() {
  const org = process.env.CONTINUITY_ORG || 'org_local';
  const backend = await openBackend({ mode: 'sqlite', path: DB, explicit: 'demo:live' });
  tokens.operator = (await mintToken(backend, { org, kind: 'operator', label: 'demo:live script' })).token;
  tokens.ingest = (await mintToken(backend, { org, kind: 'ingest', label: 'demo:live receiver' })).token;
  for (const name of ['agent-a', 'agent-b', 'agent-c']) {
    tokens[name] = (await mintToken(backend, { org, kind: 'agent', agent_id: name, task_ids: [task.id], label: `demo:live ${name}` })).token;
  }
  await backend.close();
}

// ---- Continuity API helpers ------------------------------------------------------------
async function api<J>(method: string, path: string, body?: unknown): Promise<J> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (tokens.operator) headers.authorization = `Bearer ${tokens.operator}`;
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(payload)}`);
  return payload as J;
}

type TimelineEvent = { id: string; direction: string; from: string; subject: string; link_reason: string | null; extractions: string[] };

/** Poll every 1.5s until `probe` yields something truthy, printing a dotted progress line meanwhile. */
async function waitUntil<X>(label: string, probe: () => Promise<X | null | undefined | false>, timeoutMs = 180_000): Promise<X> {
  const began = Date.now();
  let ticks = 0;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) {
      if (ticks) process.stdout.write('\n');
      return value as X;
    }
    if (Date.now() - began > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    ticks++;
    process.stdout.write(ticks % 10 === 1 ? `${C.dim}  …waiting for ${label}${C.reset}` : `${C.dim}.${C.reset}`);
    await wait(1500);
  }
}

/** Resolves once Continuity has ingested the n-th inbound email from `from`. */
function ingested(from: string, n: number, label: string) {
  return waitUntil(label, async () => {
    const { events } = await api<{ events: TimelineEvent[] }>('GET', `/tasks/${taskPath}/timeline`);
    const fromThem = events.filter((e) => e.direction === 'inbound' && e.from === from.toLowerCase());
    const nth = fromThem[n - 1];
    // stored isn't enough: it has to be interpreted and applied to state
    return fromThem.length >= n && nth.extractions.length > 0 ? nth : null;
  });
}
const agentRunCount = async () => (await api<unknown[]>('GET', `/tasks/${taskPath}/agent-runs`)).length;

// ---- Primitive mail watcher (what arrives in the supplier/finance inboxes) -------------
type Inbound = {
  id: string; from: string; to: string; subject: string | null; receivedAt: string;
  reply: (i: ReplyInput, o?: { idempotencyKey?: string }) => Promise<{ id: string; status: string; idempotentReplay: boolean }>;
};
const seen: Inbound[] = [];
(async () => {
  for await (const email of primitive.inbox.stream({ waitSeconds: 10 })) {
    if (Date.parse(email.receivedAt) >= Date.parse(RUN_STARTED) - 2000) seen.push(email as unknown as Inbound);
  }
})().catch((err) => console.error('[mail watcher]', err));

const lower = (s: string) => s.toLowerCase();
/** The first email from the agent's inbox to `to` that arrived after `after` (2s of clock slack). */
const agentMailTo = (to: string, after: string, label: string) =>
  waitUntil(label, async () =>
    seen.find((m) => lower(m.to) === lower(to) && lower(m.from) === lower(addr.self) && Date.parse(m.receivedAt) >= Date.parse(after) - 2000));

async function counterpartyReply(email: Inbound, stage: string, who: string, input: ReplyInput) {
  const sent = await email.reply(input, { idempotencyKey: `demo-live:${RUN_STARTED}:${stage}` });
  if (sent.idempotentReplay) throw new Error(`${stage}: Primitive treated the reply as a replay — nothing was sent`);
  say(`${C.blue}${who}${C.reset} replied in-thread via Primitive (${sent.status})`);
}
const pdf = (filename: string, bytes: Buffer) => ({ filename, content_type: 'application/pdf', content_base64: bytes.toString('base64') });

// ---- the story ---------------------------------------------------------------------------
async function main() {
  try {
    await fetch(`${API}/api/health`);
    throw new Error(`port ${PORT} is in use — stop the other server or pass --port`);
  } catch (e) {
    if ((e as Error).message.startsWith('port')) throw e;
  }
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  await mintDemoTokens();

  await beat('Continuity — LIVE cold-handoff demo');
  say(`agent inbox: ${C.bold}${addr.self}${C.reset}   supplier: ${addr.supplier}   finance: ${addr.finance}`);
  if (domains.size > 1) say(`${C.yellow}note:${C.reset} the three addresses are on different domains; the counterparties must be inboxes this Primitive account can read and send from.`);
  say(`agents + extraction: ${agentMode === 'llm' ? 'Claude' : 'offline rule-based (--fast or no ANTHROPIC_API_KEY)'}`);
  start('src/server.ts', [], '[continuity]', C.dim, { CONTINUITY_STORE: 'sqlite', CONTINUITY_DB: DB, CONTINUITY_AUTH: 'required', PORT, ...(flags.fast ? { CONTINUITY_EXTRACTOR: 'heuristic' } : {}) }, true);
  const health = await waitUntil('server', () => api<{ transport: string; extractor: string }>('GET', '/api/health'), 30_000);
  if (health.transport !== 'primitive') throw new Error(`server is not in live mode (transport=${health.transport})`);
  say(`Continuity up: transport=${health.transport} extractor=${health.extractor} — UI: ${API}/`);
  start('scripts/primitive-receive.ts', [], '[receive]', C.dim, { CONTINUITY_URL: API, RECEIVE_SINCE: RUN_STARTED, CONTINUITY_TOKEN: tokens.ingest }, true);
  await api('POST', '/tasks', task);
  say(`task ${task.alias}: ${task.goal}`);

  await beat('1. Agent A (long-running) opens the negotiation over Primitive');
  const agentA = startAgent('agent-a', '--watch', C.green);
  const rfq = await agentMailTo(addr.supplier, RUN_STARTED, 'the RFQ to reach the supplier inbox');
  const budgetRequest = await agentMailTo(addr.finance, RUN_STARTED, 'the budget request to reach the finance inbox');
  say(`delivered: "${rfq.subject}" → ${addr.supplier}`);
  say(`delivered: "${budgetRequest.subject}" → ${addr.finance}`);

  await beat('2. Supplier replies with an offer + quote PDF');
  const runsBefore = await agentRunCount();
  await counterpartyReply(rfq, 'supplier-offer', 'supplier', {
    text: counterparty.supplierOffer(addr, { messageId: null, subject: '' }).body,
    attachments: [pdf('Northwind-Quote-Q-2291.pdf', quoteV1())],
  });
  const offer = await ingested(addr.supplier, 1, 'Continuity to ingest the offer');
  say(`ingested ${offer.id} — ${offer.link_reason}`);
  await waitUntil('agent A to process the offer', async () => (await agentRunCount()) > runsBefore);

  await beat('3. Agent A is terminated (SIGKILL)', C.red);
  agentA.kill('SIGKILL');
  await exitOf(agentA);
  say(`agent-a pid ${agentA.pid} killed. ${C.bold}No agent is running from here on.${C.reset}`);

  await beat('4. While no agent runs: finance approves in its own thread');
  await counterpartyReply(budgetRequest, 'finance-approval', 'finance', { text: counterparty.financeApproval(addr, { messageId: null, subject: '' }).body });
  const approval = await ingested(addr.finance, 1, 'Continuity to ingest the approval');
  say(`ingested ${approval.id} — ${approval.link_reason}`);

  await beat('5. …and the supplier corrects the delivery schedule');
  await counterpartyReply(rfq, 'supplier-correction', 'supplier', { text: counterparty.supplierCorrection(addr, { messageId: null, subject: '', references: [] }).body });
  const correction = await ingested(addr.supplier, 2, 'Continuity to ingest the correction');
  say(`ingested ${correction.id} — ${correction.link_reason}`);
  const loops = await api<{ next_actor: string; conflicts: { detail: string }[]; waiting_on_them: { owed_by: string; what: string; due?: string }[] }>('GET', `/tasks/${taskPath}/open-loops`);
  say(`state: next actor ${C.bold}${loops.next_actor}${C.reset} · conflict: ${loops.conflicts.map((c) => c.detail).join('; ')}`);
  say(`waiting on: ${loops.waiting_on_them.map((w) => `${w.owed_by} — ${w.what}${w.due ? ` (due ${w.due})` : ''}`).join('; ')}`);

  await beat('6. Agent B — a brand-new process, zero memory — wakes up', C.mag);
  const bStarted = new Date().toISOString();
  const agentB = startAgent('agent-b', '--once', C.mag);
  if ((await exitOf(agentB)) !== 0) throw new Error('agent-b failed');
  const fromB = await agentMailTo(addr.supplier, bStarted, "agent B's email to reach the supplier inbox");
  say(`delivered to ${addr.supplier}: "${fromB.subject}"`);
  console.log(`\n${C.bold}${C.mag}  ★ The agent that just sent that email never saw the original conversation.${C.reset}`);

  await beat('7. Supplier answers with an expedite offer + revised quote');
  // the scripted supplier reacts to what B actually wrote, so fetch its body
  const detail = await getEmail({ client: primitive.client, path: { id: fromB.id } });
  const bBody = (detail.data as { data?: { body_text?: string } } | undefined)?.data?.body_text ?? '';
  await counterpartyReply(fromB, 'supplier-resolution', 'supplier', {
    text: counterparty.supplierResolution(addr, { messageId: null, subject: '', references: [] }, bBody).body,
    attachments: [pdf('Northwind-Quote-Q-2291-rev2.pdf', quoteV2())],
  });
  const resolution = await ingested(addr.supplier, 3, 'Continuity to ingest the revised quote');
  say(`ingested ${resolution.id} — ${resolution.link_reason}`);

  await beat('8. Agent C (another fresh process) closes the loop', C.mag);
  const agentC = startAgent('agent-c', '--once', C.mag);
  if ((await exitOf(agentC)) !== 0) throw new Error('agent-c failed');

  await beat('Done', C.green);
  const final = await api<{ context: { next_actor: string; next_actor_reason: string } }>('GET', `/tasks/${taskPath}/context`);
  say(`final: next actor = ${final.context.next_actor} (${final.context.next_actor_reason})`);
  say(`every message above went through Primitive. Inspect: ${API}/`);
  if (flags.exit) {
    stopAll();
    process.exit(0);
  }
  say('server + receiver still running (new mail keeps updating state) — Ctrl+C to stop.');
}

main().catch((err) => {
  console.error(`\n${C.red}demo failed:${C.reset}`, err.message ?? err);
  stopAll();
  process.exit(1);
});
