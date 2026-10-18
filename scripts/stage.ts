// Demo-day stage: hosts the website (site/) and lets the browser step through the cold-handoff story.
//
//   npm run stage                 # http://localhost:4000  (landing)  ·  /live  (engine console)
//   npm run stage -- --offline    # rule-based extractor + policy agents even if ANTHROPIC_API_KEY is set
//
// Under the hood a real Continuity server runs as a child process (local Primitive simulation, its own
// DB), and its API is proxied on the same origin so the site can read state directly. The beats match
// scripts/demo.ts: every agent is its own OS process, Agent A really gets SIGKILLed, and B and C start
// with no memory at all. Child output and process lifecycle are pushed to the site over SSE.
//
// A person is in the loop: Agent C's order confirmation is held as an approval card until someone
// approves or rejects it from the page (A / R).
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { counterparty, defaultAddresses, procurementTask, type SimEmail } from '../src/sim/scenario.ts';

const { values: opts } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.STAGE_PORT || '4000' },
    'engine-port': { type: 'string', default: '4101' },
    offline: { type: 'boolean', default: false },
    db: { type: 'string', default: 'data/stage.db' },
  },
});
const STAGE_PORT = Number(opts.port);
const ENGINE_URL = `http://127.0.0.1:${opts['engine-port']}`;
const DB_PATH = opts.db!;
const REPO = fileURLToPath(new URL('..', import.meta.url));
const SITE_DIR = join(REPO, 'site');

// The stage always runs on the local simulation, so it sticks to the scenario's fictional parties
// (they read cleanly on screen) even if live addresses are configured.
for (const name of ['CONTINUITY_SELF_ADDRESS', 'CONTINUITY_SUPPLIER_ADDRESS', 'CONTINUITY_FINANCE_ADDRESS']) delete process.env[name];
const parties = defaultAddresses();
const task = procurementTask(parties);
const taskPath = encodeURIComponent(task.id);

const baseEnv: Record<string, string | undefined> = { ...process.env, CONTINUITY_TRANSPORT: 'sim' };
if (opts.offline) {
  delete baseEnv.ANTHROPIC_API_KEY;
  baseEnv.CONTINUITY_EXTRACTOR = 'heuristic';
}

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
  return launch(name, 'src/agent/run.ts', ['--task', task.alias, '--agent', name, mode, '--api', ENGINE_URL]);
}

// ---------------------------------------------------------------- Continuity API
async function call<R>(method: string, path: string, body?: unknown): Promise<R> {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(payload)}`);
  return payload as R;
}

type Delivered = { result: { event_id: string; link_reason: string; linked: boolean }; message_id: string };
type SentMail = { messageId: string; subject: string; references: string[]; to: string; body: string };

const setClock = (iso: string) => call('POST', '/sim/clock', { now: iso });

function deliver(email: SimEmail) {
  const attachments = (email.attachments ?? []).map((att) => ({ filename: att.filename, content_type: att.content_type, base64: att.bytes.toString('base64') }));
  return call<Delivered>('POST', '/sim/deliver', { ...email, attachments });
}

async function mailSentTo(address: string) {
  const sent = await call<SentMail[]>('GET', '/sim/sent');
  return sent.filter((m) => m.to === address);
}

async function agentRunCount() {
  const runs = await call<unknown[]>('GET', `/tasks/${taskPath}/agent-runs`);
  return runs.length;
}

async function untilAgentRuns(n: number, timeoutMs = 120000) {
  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    if ((await agentRunCount()) >= n) return;
    await wait(200);
  }
  throw new Error(`timed out waiting for agent run #${n}`);
}

const narrate = (text: string) => emit({ type: 'say', text });

// ---------------------------------------------------------------- the story
interface Beat { title: string; caption: string; run: () => Promise<void> }
const memo: { offerMsg?: string } = {};

const beats: Beat[] = [
  {
    title: 'Agent A opens the deal.',
    caption: 'Two emails. Two threads.',
    run: async () => {
      startAgent('agent-a', '--watch');
      await untilAgentRuns(1);
    },
  },
  {
    title: 'The supplier says yes.',
    caption: '500 by Friday at $11.40. Quote attached.',
    run: async () => {
      await setClock('2026-10-19T11:20:00Z');
      const rfq = (await mailSentTo(parties.supplier))[0];
      const offer = await deliver(counterparty.supplierOffer(parties, { messageId: rfq.messageId, subject: rfq.subject }));
      memo.offerMsg = offer.message_id;
      narrate(`ingested ${offer.result.event_id} (${offer.result.link_reason})`);
      await untilAgentRuns(2);
      const promo = await deliver(counterparty.strayPromo(parties));
      narrate(`unrelated promo ${promo.result.event_id}: linked=${promo.result.linked}`);
    },
  },
  {
    title: 'Agent A is killed.',
    caption: 'No warning. No handoff notes.',
    run: async () => {
      const victim = processes.get('agent-a');
      if (victim && victim.state === 'running') {
        victim.state = 'killed';
        victim.child.kill('SIGKILL');
        await exitCode(victim);
      }
      narrate(`agent-a pid ${victim?.pid} killed — no agent is running`);
    },
  },
  {
    title: 'Finance approves.',
    caption: 'Nobody is awake to read it. Continuity is.',
    run: async () => {
      await setClock('2026-10-19T15:05:00Z');
      const request = (await mailSentTo(parties.finance))[0];
      const approval = await deliver(counterparty.financeApproval(parties, { messageId: request.messageId, subject: request.subject }));
      narrate(`ingested ${approval.result.event_id} (${approval.result.link_reason})`);
    },
  },
  {
    title: 'The supplier changes the deal.',
    caption: 'Only 300 can arrive Friday.',
    run: async () => {
      await setClock('2026-10-20T10:12:00Z');
      const rfq = (await mailSentTo(parties.supplier))[0];
      const correction = await deliver(counterparty.supplierCorrection(parties, { messageId: memo.offerMsg ?? null, subject: `Re: ${rfq.subject}`, references: [rfq.messageId] }));
      narrate(`ingested ${correction.result.event_id} (${correction.result.link_reason})`);
    },
  },
  {
    title: 'Agent B wakes up with zero memory.',
    caption: 'One call to Continuity. Then it writes.',
    run: async () => {
      const b = startAgent('agent-b', '--once');
      if ((await exitCode(b)) !== 0) throw new Error('agent-b failed');
    },
  },
  {
    title: 'The supplier fixes it.',
    caption: 'All 500 by Friday, with a revised quote.',
    run: async () => {
      await setClock('2026-10-21T09:30:00Z');
      const fromB = (await mailSentTo(parties.supplier)).at(-1)!;
      const resolution = await deliver(counterparty.supplierResolution(parties, { messageId: fromB.messageId, subject: fromB.subject, references: fromB.references }, fromB.body));
      narrate(`ingested ${resolution.result.event_id} (${resolution.result.link_reason})`);
    },
  },
  {
    title: 'Agent C closes the deal.',
    caption: 'Every check passes. Committing money still needs you.',
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
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${join(REPO, DB_PATH)}${suffix}`, { force: true });

  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: REPO,
    // pinned so a .env with CONTINUITY_AUTH=required or SUPABASE_DB_URL doesn't change the stage's local engine
    env: { ...baseEnv, CONTINUITY_STORE: 'sqlite', CONTINUITY_DB: DB_PATH, CONTINUITY_AUTH: 'off', PORT: opts['engine-port'] } as NodeJS.ProcessEnv,
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
  await call('POST', '/tasks', task);
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
    headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
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
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

await reset();
server.listen(STAGE_PORT, () => {
  const brains = opts.offline || !process.env.ANTHROPIC_API_KEY ? 'offline rules + policy agents' : 'Claude extractor + Claude agents';
  console.log(`\n  Continuity stage   http://localhost:${STAGE_PORT}        (landing)`);
  console.log(`                     http://localhost:${STAGE_PORT}/live   (engine console)`);
  console.log(`  engine: ${ENGINE_URL}  ·  mail: local Primitive simulation  ·  ${brains}\n`);
});
