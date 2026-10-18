// Demo-day stage: hosts the website (site/) and lets the browser step through the cold-handoff story.
//
//   npm run stage                 # http://localhost:4000  (landing)  ·  /live  (engine console)
//   npm run stage -- --sim        # local mail simulation even when Primitive keys are configured
//   npm run stage -- --offline    # rule-based extractor + policy agents even if ANTHROPIC_API_KEY is set
//
// Under the hood a real Continuity server runs as a child process (its own DB), and its API is proxied on
// the same origin so the site can read state directly. With PRIMITIVE_API_KEY and the three
// CONTINUITY_*_ADDRESS inboxes in .env, every email is real Primitive mail: the agents send through
// Primitive, the scripted supplier and finance reply in-thread from their own inboxes, and a receiver
// feeds the agent's inbox to Continuity. Otherwise the story runs on the local Primitive simulation.
// Every agent is its own OS process, Agent A really gets SIGKILLed, and B and C start with no memory.
//
// A person is in the loop: Agent C's order confirmation is held as an approval card until someone
// approves or rejects it from the page (A / R).
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPrimitiveClient, type ReplyInput } from '@primitivedotdev/sdk';
import { getEmail } from '@primitivedotdev/sdk/api';
import { counterparty, defaultAddresses, procurementTask, type SimEmail } from '../src/sim/scenario.ts';
import { openBackend } from '../src/store/index.ts';
import { APPROVER_SCOPES, mintToken } from '../src/auth.ts';

const { values: opts } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.STAGE_PORT || '4000' },
    'engine-port': { type: 'string', default: '4101' },
    offline: { type: 'boolean', default: false },
    sim: { type: 'boolean', default: false },
    db: { type: 'string', default: 'data/stage.db' },
  },
});
const STAGE_PORT = Number(opts.port);
const ENGINE_URL = `http://127.0.0.1:${opts['engine-port']}`;
const DB_PATH = opts.db!;
const REPO = fileURLToPath(new URL('..', import.meta.url));
const SITE_DIR = join(REPO, 'site');

const ADDRESS_VARS = ['CONTINUITY_SELF_ADDRESS', 'CONTINUITY_SUPPLIER_ADDRESS', 'CONTINUITY_FINANCE_ADDRESS'];
const LIVE = !opts.sim && Boolean(process.env.PRIMITIVE_API_KEY) && ADDRESS_VARS.every((name) => process.env[name]);
// on the simulation the stage sticks to the scenario's fictional parties (they read cleanly on screen)
if (!LIVE) for (const name of ADDRESS_VARS) delete process.env[name];
const parties = defaultAddresses();
const task = procurementTask(parties);
const taskPath = encodeURIComponent(task.id);

const baseEnv: Record<string, string | undefined> = { ...process.env };
if (!LIVE) baseEnv.CONTINUITY_TRANSPORT = 'sim';
if (opts.offline) {
  delete baseEnv.ANTHROPIC_API_KEY;
  baseEnv.CONTINUITY_EXTRACTOR = 'heuristic';
}
const primitive = LIVE ? createPrimitiveClient({ apiKey: process.env.PRIMITIVE_API_KEY! }) : null;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- event stream (SSE)
type StageEvent = Record<string, unknown> & { type: string };
const subscribers = new Set<ServerResponse>();
const history: StageEvent[] = [];
const HISTORY_LIMIT = 400;

function emit(event: StageEvent) {
  const stamped = { ...event, t: Date.now() };
  history.push(stamped);
  if (history.length > HISTORY_LIMIT) history.shift();
  const frame = `data: ${JSON.stringify(stamped)}\n\n`;
  for (const sub of subscribers) sub.write(frame);
}

// ---------------------------------------------------------------- processes
interface Proc {
  name: string;
  pid: number | undefined;
  state: 'running' | 'exited' | 'killed';
  code: number | null;
  child: ChildProcess;
  started: number;
}
const processes = new Map<string, Proc>();
let engineChild: ChildProcess | null = null;
let receiver: ChildProcess | null = null;

/** Mirror each non-blank output line to our stdout and to the SSE stream. */
function forwardLines(label: string, pid: number | undefined) {
  return (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      process.stdout.write(`[${label}] ${line}\n`);
      emit({ type: 'log', proc: label, pid, line });
    }
  };
}

function launch(name: string, script: string, argv: string[], env: Record<string, string | undefined> = baseEnv): Proc {
  const child = spawn(process.execPath, [script, ...argv], { cwd: REPO, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const proc: Proc = { name, pid: child.pid, state: 'running', code: null, child, started: Date.now() };
  const forward = forwardLines(name, child.pid);
  child.stdout!.on('data', forward);
  child.stderr!.on('data', forward);
  child.on('exit', (code, signal) => {
    // a deliberate kill already marked the state; otherwise classify by how it ended
    if (proc.state === 'running') proc.state = signal === 'SIGKILL' ? 'killed' : 'exited';
    proc.code = code;
    emit({ type: 'proc', name, pid: child.pid, state: proc.state, code, signal });
  });
  processes.set(name, proc);
  emit({ type: 'proc', name, pid: child.pid, state: 'running' });
  return proc;
}

function exitCode(proc: Proc): Promise<number | null> {
  if (proc.state !== 'running') return Promise.resolve(proc.code);
  return new Promise((resolve) => proc.child.on('exit', (code) => resolve(code)));
}

function startAgent(name: string, mode: '--once' | '--watch') {
  return launch(name, 'src/agent/run.ts', ['--task', task.alias, '--agent', name, mode, '--api', ENGINE_URL], { ...baseEnv, CONTINUITY_TOKEN: tokens[name] ?? '' });
}

// ---------------------------------------------------------------- tokens (live mail only)
// The engine never serves live Primitive mail without authentication: the stage, the receiver, each
// agent and the person at the page get their own token. On the simulation the engine runs with auth off.
const tokens: Record<string, string> = {};
const APPROVER = 'the procurement lead';

async function mintStageTokens() {
  for (const key of Object.keys(tokens)) delete tokens[key];
  if (!LIVE) return;
  const org = process.env.CONTINUITY_ORG || 'org_local';
  const backend = await openBackend({ mode: 'sqlite', path: join(REPO, DB_PATH), explicit: 'stage' });
  tokens.operator = (await mintToken(backend, { org, kind: 'operator', label: 'stage' })).token;
  tokens.ingest = (await mintToken(backend, { org, kind: 'ingest', label: 'stage receiver' })).token;
  tokens.approver = (await mintToken(backend, { org, kind: 'operator', scopes: APPROVER_SCOPES, label: `stage approver (${APPROVER})` })).token;
  for (const name of ['agent-a', 'agent-b', 'agent-c']) {
    tokens[name] = (await mintToken(backend, { org, kind: 'agent', agent_id: name, task_ids: [task.id], label: `stage ${name}` })).token;
  }
  await backend.close();
}

const authHeader = (token = tokens.operator): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

// ---------------------------------------------------------------- Continuity API
async function call<R>(method: string, path: string, body?: unknown): Promise<R> {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...authHeader() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(payload)}`);
  return payload as R;
}

type Delivered = { result: { event_id: string; link_reason: string; linked: boolean }; message_id: string };
type SentMail = { messageId: string; subject: string; references: string[]; to: string; body: string };
type TimelineEvent = { id: string; direction: string; from: string; extractions?: unknown[] };

// the simulation has its own clock; live mail runs on real time
const setClock = (iso: string) => (LIVE ? Promise.resolve() : call('POST', '/sim/clock', { now: iso }));

function deliver(email: SimEmail) {
  const attachments = (email.attachments ?? []).map((att) => ({ filename: att.filename, content_type: att.content_type, base64: att.bytes.toString('base64') }));
  return call<Delivered>('POST', '/sim/deliver', { ...email, attachments });
}

async function agentRunCount() {
  const runs = await call<unknown[]>('GET', `/tasks/${taskPath}/agent-runs`);
  return runs.length;
}

/** Poll until `probe` yields something; gives up on timeout, or when the story is reset underneath it. */
async function waitUntil<X>(label: string, probe: () => Promise<X | null | undefined | false>, timeoutMs = 180_000): Promise<X> {
  const myEpoch = epoch;
  const began = Date.now();
  for (;;) {
    if (myEpoch !== epoch) throw new Error('reset');
    const value = await probe().catch(() => null);
    if (value) return value as X;
    if (Date.now() - began > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await wait(LIVE ? 700 : 200);
  }
}

const untilAgentRuns = (n: number) => waitUntil(`agent run #${n}`, async () => (await agentRunCount()) >= n);

/** Resolves once Continuity has read the n-th inbound email from `from` and applied it to state. */
const ingestedFrom = (from: string, n: number, label: string) => waitUntil(label, async () => {
  const { events } = await call<{ events: TimelineEvent[] }>('GET', `/tasks/${taskPath}/timeline`);
  const nth = events.filter((e) => e.direction === 'inbound' && e.from === from.toLowerCase())[n - 1];
  return nth && (nth.extractions?.length ?? 0) > 0 ? nth : null;
});

const narrate = (text: string) => emit({ type: 'say', text });

// ---------------------------------------------------------------- the counterparties' mail
// Supplier and finance are scripted, but they answer the emails the agents actually wrote. Live, they
// read their own Primitive inboxes and reply in-thread; on the simulation they read the sim's sent mail.
type Inbound = {
  id: string; from: string; to: string; subject: string | null; receivedAt: string;
  reply: (i: ReplyInput, o?: { idempotencyKey?: string }) => Promise<{ id: string; status: string; idempotentReplay: boolean }>;
};
interface AgentMail { ref: { messageId: string | null; subject: string; references: string[] }; body: () => Promise<string>; inbound: Inbound | null }

const STARTED = Date.now();
let runStarted = new Date().toISOString();
const seen: Inbound[] = [];
if (primitive) {
  (async () => {
    for await (const email of primitive.inbox.stream({ waitSeconds: 10 })) {
      if (Date.parse(email.receivedAt) >= STARTED - 60_000) seen.push(email as unknown as Inbound);
    }
  })().catch((err) => narrate(`counterparty mail watcher stopped: ${(err as Error).message}`));
}

const lower = (s: string) => s.toLowerCase();
const liveMailTo = (to: string) => seen.filter((m) => lower(m.to) === lower(to) && lower(m.from) === lower(parties.self) && Date.parse(m.receivedAt) >= Date.parse(runStarted) - 2000);

async function agentMailCount(to: string) {
  if (LIVE) return liveMailTo(to).length;
  return (await call<SentMail[]>('GET', '/sim/sent')).filter((m) => m.to === to).length;
}

/** The n-th email (0-based) our agents sent to `to` in this run, once it has arrived. */
async function agentMail(to: string, n: number, label: string): Promise<AgentMail> {
  if (!LIVE) {
    const m = await waitUntil(label, async () => (await call<SentMail[]>('GET', '/sim/sent')).filter((x) => x.to === to)[n]);
    return { ref: { messageId: m.messageId, subject: m.subject, references: m.references }, body: async () => m.body, inbound: null };
  }
  const m = await waitUntil(label, async () => liveMailTo(to)[n]);
  return {
    ref: { messageId: null, subject: m.subject ?? '', references: [] },
    inbound: m,
    body: async () => {
      const detail = await getEmail({ client: primitive!.client, path: { id: m.id } });
      return (detail.data as { data?: { body_text?: string } } | undefined)?.data?.body_text ?? '';
    },
  };
}

/** A counterparty answers `to` with `mail` (its body and attachments); returns the new Message-ID on the sim. */
async function answer(stage: string, to: AgentMail, mail: SimEmail): Promise<string | null> {
  if (!LIVE) {
    const d = await deliver(mail);
    narrate(`ingested ${d.result.event_id} (${d.result.link_reason})`);
    return d.message_id;
  }
  const attachments = (mail.attachments ?? []).map((att) => ({ filename: att.filename, content_type: att.content_type, content_base64: att.bytes.toString('base64') }));
  const sent = await to.inbound!.reply({ text: mail.body, ...(attachments.length ? { attachments } : {}) }, { idempotencyKey: `stage:${runStarted}:${stage}` });
  if (sent.idempotentReplay) throw new Error(`${stage}: Primitive treated the reply as a replay; nothing was sent`);
  narrate(`${mail.fromName} replied in-thread via Primitive (${sent.status})`);
  return null;
}

// ---------------------------------------------------------------- the story
interface Beat { title: string; caption: string; run: () => Promise<void> }
const memo: { offerMsg?: string | null; fromB?: AgentMail } = {};

const beats: Beat[] = [
  {
    title: 'A deal begins.',
    caption: 'Agent A emails the supplier and finance.',
    run: async () => {
      startAgent('agent-a', '--watch');
      const rfq = await agentMail(parties.supplier, 0, 'the RFQ to reach the supplier');
      await agentMail(parties.finance, 0, 'the budget request to reach finance');
      const runs = await agentRunCount();
      await setClock('2026-10-19T11:20:00Z');
      memo.offerMsg = await answer('supplier-offer', rfq, counterparty.supplierOffer(parties, rfq.ref));
      await ingestedFrom(parties.supplier, 1, 'Continuity to read the offer');
      await untilAgentRuns(runs + 1);
    },
  },
  {
    title: 'Agent A dies.',
    caption: 'The deal keeps moving without it.',
    run: async () => {
      const victim = processes.get('agent-a');
      if (victim && victim.state === 'running') {
        victim.state = 'killed';
        victim.child.kill('SIGKILL');
        await exitCode(victim);
      }
      narrate(`agent-a pid ${victim?.pid} killed — no agent is running`);
      await wait(2200); // let the kill land on screen before the mail does
      const budget = await agentMail(parties.finance, 0, 'the budget request');
      const rfq = await agentMail(parties.supplier, 0, 'the RFQ');
      await setClock('2026-10-19T15:05:00Z');
      await answer('finance-approval', budget, counterparty.financeApproval(parties, budget.ref));
      await ingestedFrom(parties.finance, 1, 'Continuity to read the approval');
      await setClock('2026-10-20T10:12:00Z');
      const replyTo = { messageId: memo.offerMsg ?? null, subject: `Re: ${rfq.ref.subject}`, references: rfq.ref.messageId ? [rfq.ref.messageId] : [] };
      await answer('supplier-correction', rfq, counterparty.supplierCorrection(parties, replyTo));
      await ingestedFrom(parties.supplier, 2, 'Continuity to read the correction');
    },
  },
  {
    title: 'Agent B wakes up.',
    caption: 'Brand-new process. Zero memory.',
    run: async () => {
      const before = await agentMailCount(parties.supplier);
      const b = startAgent('agent-b', '--once');
      if ((await exitCode(b)) !== 0) throw new Error('agent-b failed');
      memo.fromB = await agentMail(parties.supplier, before, "agent B's email to reach the supplier");
    },
  },
  {
    title: 'The supplier fixes it.',
    caption: 'All 500 by Friday. Revised quote attached.',
    run: async () => {
      const fromB = memo.fromB ?? await agentMail(parties.supplier, (await agentMailCount(parties.supplier)) - 1, "agent B's email");
      await setClock('2026-10-21T09:30:00Z');
      await answer('supplier-resolution', fromB, counterparty.supplierResolution(parties, fromB.ref, await fromB.body()));
      await ingestedFrom(parties.supplier, 3, 'Continuity to read the revised quote');
    },
  },
  {
    title: 'Agent C closes.',
    caption: 'Agents propose. You decide.',
    run: async () => {
      const c = startAgent('agent-c', '--once');
      if ((await exitCode(c)) !== 0) throw new Error('agent-c failed');
    },
  },
];

let nextBeat = 0;        // index of the beat that runs on the next /stage/next
let running = false;
let failure: string | null = null;
let epoch = 0;           // incremented by every reset, so a beat from an older run can't move the new one forward

async function bootEngine() {
  for (const proc of processes.values()) {
    if (proc.state === 'running') {
      proc.state = 'killed';
      proc.child.kill('SIGKILL');
    }
  }
  processes.clear();
  if (engineChild && engineChild.exitCode === null) {
    const old = engineChild;
    old.kill();
    await new Promise((resolve) => old.on('exit', resolve));
  }
  receiver?.kill();
  receiver = null;
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${join(REPO, DB_PATH)}${suffix}`, { force: true });
  runStarted = new Date().toISOString();
  for (const key of Object.keys(memo)) delete memo[key as keyof typeof memo];
  await mintStageTokens();

  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: REPO,
    // pinned so a .env with CONTINUITY_AUTH=required or SUPABASE_DB_URL doesn't change the stage's local engine
    env: { ...baseEnv, CONTINUITY_STORE: 'sqlite', CONTINUITY_DB: DB_PATH, CONTINUITY_AUTH: LIVE ? 'required' : 'off', PORT: opts['engine-port'] } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  engineChild = child;
  const forward = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      process.stdout.write(`[engine] ${line}\n`);
      emit({ type: 'log', proc: 'engine', pid: child.pid, line });
    }
  };
  child.stdout!.on('data', forward);
  child.stderr!.on('data', forward);

  // give the server up to ~15s to answer its health check
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      await call('GET', '/api/health');
      break;
    } catch {
      await wait(100);
    }
  }
  await setClock('2026-10-19T08:55:00Z');
  if (!LIVE) {
    await call('POST', '/tasks', task);
    return;
  }
  // Live: the agent's inbox reaches Continuity through the receiver (Primitive long-poll → /ingest).
  // Supplier and finance reply from inboxes on your own Primitive domain; until mail between them has been
  // seen to authenticate, an *unknown* sender verdict from them is accepted and flagged (a failing one never is).
  const demoAuth = process.env.CONTINUITY_DEMO_SENDER_AUTH === 'enforce' ? 'enforce' : 'flag';
  await call('POST', '/tasks', { ...task, participants: task.participants.map((p) => (p.address === parties.supplier || p.address === parties.finance ? { ...p, sender_auth: demoAuth } : p)) });
  receiver = spawn(process.execPath, ['scripts/primitive-receive.ts'], {
    cwd: REPO,
    env: { ...baseEnv, CONTINUITY_URL: ENGINE_URL, RECEIVE_SINCE: runStarted, CONTINUITY_TOKEN: tokens.ingest } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const forwardReceiver = forwardLines('receive', receiver.pid);
  receiver.stdout!.on('data', forwardReceiver);
  receiver.stderr!.on('data', forwardReceiver);
}

async function reset() {
  epoch++;
  running = true;
  nextBeat = 0;
  failure = null;
  history.length = 0;
  emit({ type: 'reset' });
  try {
    await bootEngine();
  } finally {
    running = false;
  }
  emit({ type: 'status', ...snapshot() });
}

async function advance() {
  const myEpoch = epoch;
  const index = nextBeat;
  const beat = beats[index];
  running = true;
  failure = null;
  emit({ type: 'beat', index, status: 'running', title: beat.title });
  try {
    await beat.run();
    if (myEpoch !== epoch) return;
    nextBeat = index + 1;
    emit({ type: 'beat', index, status: 'done', title: beat.title });
  } catch (err) {
    if (myEpoch !== epoch) return;
    failure = (err as Error).message;
    emit({ type: 'beat', index, status: 'error', title: beat.title, error: failure });
  } finally {
    if (myEpoch === epoch) running = false;
    emit({ type: 'status', ...snapshot() });
  }
}

function snapshot() {
  return {
    cursor: nextBeat,
    busy: running,
    error: failure,
    offline: !!opts.offline,
    live: LIVE,
    beats: beats.map((b, index) => ({ index, title: b.title, caption: b.caption, done: index < nextBeat })),
    procs: [...processes.values()].map((p) => ({ name: p.name, pid: p.pid, state: p.state, code: p.code, started: p.started })),
  };
}

// ---------------------------------------------------------------- http
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};
const ROUTES: Record<string, string> = { '/': 'index.html', '/live': 'live.html' };

/** Serve a file from site/ if one matches; returns false so the caller can fall through to the proxy. */
function tryStatic(pathname: string, res: ServerResponse): boolean {
  const relative = ROUTES[pathname] ?? normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const file = join(SITE_DIR, relative);
  if (!file.startsWith(SITE_DIR) || !existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
  return true;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => resolve(Buffer.concat(parts)));
  });
}

async function forwardToEngine(req: IncomingMessage, res: ServerResponse, url: URL) {
  const hasBody = !(req.method === 'GET' || req.method === 'HEAD');
  const body = hasBody ? await readBody(req) : undefined;
  const upstream = await fetch(`${ENGINE_URL}${url.pathname}${url.search}`, {
    method: req.method,
    // live, the engine requires a token: the page reads as the stage, and decides as the person at it
    headers: { 'content-type': req.headers['content-type'] ?? 'application/json', ...authHeader(/\/decide$/.test(url.pathname) ? tokens.approver : tokens.operator) },
    body: body ? new Uint8Array(body) : undefined,
  });
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function openStream(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  // a fresh status first, then everything that happened so far (flagged as replayed)
  res.write(`data: ${JSON.stringify({ type: 'status', ...snapshot(), t: Date.now() })}\n\n`);
  for (const past of history) res.write(`data: ${JSON.stringify({ ...past, replay: true })}\n\n`);
  subscribers.add(res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    subscribers.delete(res);
    clearInterval(keepAlive);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    switch (url.pathname) {
      case '/stage/stream':
        openStream(req, res);
        return;
      case '/stage/status':
        return sendJson(res, 200, snapshot());
    }
    if (url.pathname === '/stage/next' && req.method === 'POST') {
      if (running) return sendJson(res, 409, { ...snapshot(), error: 'a beat is still running' });
      if (nextBeat >= beats.length) return sendJson(res, 409, { ...snapshot(), error: 'the story is over — reset to run it again' });
      void advance();
      return sendJson(res, 202, { accepted: true, ...snapshot() });
    }
    if (url.pathname === '/stage/reset' && req.method === 'POST') {
      await reset();
      return sendJson(res, 200, snapshot());
    }
    if (req.method === 'GET' && tryStatic(url.pathname, res)) return;
    return await forwardToEngine(req, res, url);
  } catch (err) {
    const e = err as Error & { status?: number };
    sendJson(res, e.status ?? 502, { error: e.message });
  }
});

process.on('exit', () => {
  for (const proc of processes.values()) if (proc.state === 'running') proc.child.kill();
  engineChild?.kill();
  receiver?.kill();
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

await reset();
server.listen(STAGE_PORT, () => {
  const brains = opts.offline || !process.env.ANTHROPIC_API_KEY ? 'offline rules + policy agents' : 'Claude extractor + Claude agents';
  console.log(`\n  Continuity stage   http://localhost:${STAGE_PORT}        (landing)`);
  console.log(`                     http://localhost:${STAGE_PORT}/live   (engine console)`);
  const mail = LIVE ? `live Primitive mail (${parties.self})` : 'local Primitive simulation';
  console.log(`  engine: ${ENGINE_URL}  ·  mail: ${mail}  ·  ${brains}\n`);
});
