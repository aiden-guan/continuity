// HTTP API, Primitive webhook receiver and observability UI on plain node:http (no framework).
// A job worker runs inside the server unless CONTINUITY_WORKER=off (then run `npm run worker` separately).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { Continuity, HttpError } from './service.ts';
import { heuristicExtractor } from './extract/heuristic.ts';
import { llmExtractor } from './extract/llm.ts';
import { LocalSimTransport, makeTransport, type Transport } from './transport/transport.ts';
import { setSimTime, nowIso } from './clock.ts';
import type { SimEmail } from './sim/scenario.ts';
import type { Backend, Principal } from './store/backend.ts';
import { openBackend, redactUrl, storageConfig, type StorageConfig } from './store/index.ts';
import { canTask, hashToken, hasScope, localPrincipal, type Scope } from './auth.ts';
import { Engine } from './engine/engine.ts';
import { deriveTimeline, stateAt } from './engine/timeline.ts';
import { notifyWebhook, runSignal, scheduleSignal } from './signal.ts';
import { findSimilar, listDeals, query, QueryError, SCHEMA_GUIDE, type PortfolioScope } from './portfolio.ts';
import { ask } from './ask.ts';

export interface AppOptions {
  backend?: Backend;
  storage?: StorageConfig;
  port?: number;
  /** required: a bearer token on every API route; off: everything runs as the local operator (offline modes only) */
  auth?: 'required' | 'off';
  worker?: boolean;
  transport?: Transport;
  org?: string;
}

type Handler = (m: RegExpMatchArray, q: URLSearchParams, body: string, req: IncomingMessage, p: Principal) => Promise<unknown> | unknown;
/** [method, path pattern, scope the caller needs (null = public), handler] */
type Route = [string, RegExp, Scope | null, Handler];

/** Special handler results: raw bytes or plain text instead of JSON, with extra response headers. */
type BytesReply = { __bytes: Buffer; __headers: Record<string, string> };
type TextReply = { __text: string; __headers?: Record<string, string> };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

export async function buildApp(opts: AppOptions = {}) {
  const transport = opts.transport ?? makeTransport();

  // extractor: CONTINUITY_EXTRACTOR=llm|heuristic|auto (auto = LLM when an Anthropic key is present)
  const extractorMode = process.env.CONTINUITY_EXTRACTOR || 'auto';
  const useLlm = extractorMode === 'llm' || (extractorMode === 'auto' && !!process.env.ANTHROPIC_API_KEY);
  const extractor = useLlm ? llmExtractor() : heuristicExtractor;
  const sim = transport.mode === 'local-sim';

  const cfg = opts.backend ? null : (opts.storage ?? storageConfig());
  const backend = opts.backend ?? await openBackend(cfg!);
  const hosted = backend.mode === 'postgres';

  const authMode = opts.auth ?? ((process.env.CONTINUITY_AUTH as 'required' | 'off' | undefined) || (hosted ? 'required' : 'off'));
  if (authMode === 'off' && hosted && process.env.CONTINUITY_ALLOW_UNAUTHENTICATED !== '1') {
    throw new Error('Refusing to serve the hosted (Postgres) store without authentication. Mint a token (npm run token) or set CONTINUITY_ALLOW_UNAUTHENTICATED=1 for a local-only Supabase stack.');
  }

  const org = opts.org || process.env.CONTINUITY_ORG || 'org_local';
  await backend.ensureOrg(org);

  const webhookSecret = process.env.PRIMITIVE_WEBHOOK_SECRET || (sim ? 'local-sim-webhook-secret' : null);
  if (!webhookSecret) {
    console.warn('[continuity] PRIMITIVE_WEBHOOK_SECRET not set: webhook signatures are NOT verified' + (authMode === 'required' ? ' — webhook endpoint disabled' : ''));
  }

  const engine = new Engine(backend, extractor, (ev, i) => transport.fetchAttachment(ev, i));
  const app = new Continuity({ backend, extractor, transport, webhookSecret, requireStateVersion: hosted, ingestOrg: org, engine });
  const ui = fileURLToPath(new URL('../ui/index.html', import.meta.url));
  const port = opts.port ?? Number(process.env.PORT || 4100);
  const workerOn = opts.worker ?? process.env.CONTINUITY_WORKER !== 'off';
  if (workerOn) engine.start();
  // Signal on a schedule (CONTINUITY_SIGNAL_INTERVAL_S); new alerts go to CONTINUITY_SIGNAL_WEBHOOK when set
  const signalEvery = Number(process.env.CONTINUITY_SIGNAL_INTERVAL_S || 0);
  const stopSignal = signalEvery > 0 ? scheduleSignal(backend, org, signalEvery, process.env.CONTINUITY_SIGNAL_WEBHOOK) : () => undefined;

  function attachmentStorage(): string {
    if (!hosted) return backend.mode;
    return cfg?.storage ? `supabase storage bucket ${cfg.storage.bucket} (private)` : 'postgres inline (SUPABASE_URL/SUPABASE_SECRET_KEY not set)';
  }

  const health = async () => {
    const h = await backend.health().catch((e) => ({ ok: false, detail: (e as Error).message, schema: null }));
    return {
      ok: h.ok,
      now: nowIso(),
      storage: {
        mode: backend.mode, authoritative: hosted, persistent: backend.mode !== 'memory', target: backend.target,
        selected_by: cfg?.explicit ?? 'injected', schema: h.schema ?? null, detail: h.ok ? undefined : h.detail,
        attachments: attachmentStorage(),
      },
      transport: transport.mode,
      extractor: extractor.name,
      webhook_signature_verification: !!webhookSecret,
      auth: authMode,
      worker: workerOn ? 'embedded' : 'external',
      jobs: await backend.jobCounts().catch(() => null),
      agent_llm: !!process.env.ANTHROPIC_API_KEY,
      primitive_api_key: !!process.env.PRIMITIVE_API_KEY,
    };
  };

  function assertSim() {
    if (!sim) throw new HttpError(403, 'simulation endpoints are disabled when PRIMITIVE_API_KEY is set');
  }
  /** An agent-bound token may only act as its own agent. */
  function assertAgent(p: Principal, agentId: string | undefined | null) {
    if (p.kind === 'agent' && p.agent_id && agentId && agentId !== p.agent_id) {
      throw new HttpError(403, `this token acts as agent ${p.agent_id}, not ${agentId}`);
    }
  }
  const numberParam = (q: URLSearchParams, name: string) => (q.get(name) ? Number(q.get(name)) : undefined);
  /** Item and event lookups: task-bound items need task access; unlinked ones need an unrestricted principal. */
  const itemAccess = (p: Principal) => (t: string) => (t ? canTask(p, t) : !p.task_ids);
  /** Portfolio reads see the caller's org and, for a task-restricted principal, only its tasks. */
  const scopeOf = (p: Principal): PortfolioScope => ({ org: p.org, taskIds: p.task_ids });
  const portfolioError = (err: unknown): never => {
    if (err instanceof QueryError) throw new HttpError(400, err.message);
    throw err;
  };

  const routes: Route[] = [
    ['GET', /^\/api\/health$/, null, health],

    ['POST', /^\/webhooks\/primitive$/, null, (_m, q, body, req) => {
      if (!webhookSecret && authMode === 'required') throw new HttpError(503, 'webhook disabled: set PRIMITIVE_WEBHOOK_SECRET');
      return app.ingestWebhook(body, req.headers, { wait: q.get('wait') === '1' });
    }],

    // the live long-poll receiver (scripts/primitive-receive.ts) posts a Primitive EmailDetail here
    ['POST', /^\/ingest\/primitive-email$/, 'ingest', (_m, q, body, _r, p) => app.ingestEmailDetail(p.org, JSON.parse(body), { wait: q.get('wait') === '1' })],

    ['GET', /^\/tasks$/, 'context:read', async (_m, _q, _b, _r, p) => {
      const tasks = await backend.listTasks(p.org);
      return tasks
        .filter((t) => canTask(p, t.spec.id))
        .map((t) => ({ id: t.spec.id, alias: t.spec.alias, goal: t.spec.goal, domain: t.spec.domain, state_version: t.state_version }));
    }],
    ['POST', /^\/tasks$/, 'tasks:write', (_m, _q, body, _r, p) => app.createTask(p.org, JSON.parse(body))],

    ['GET', /^\/tasks\/([^/]+)\/context$/, 'context:read', async (m, q, _b, _r, p) => {
      const agentId = q.get('agent') ?? (p.kind === 'agent' ? p.agent_id ?? undefined : undefined);
      assertAgent(p, agentId);
      const r = await app.context(p.org, m[1], {
        agentId,
        party: q.get('party') ?? undefined,
        maxTokens: numberParam(q, 'max_tokens'),
        asOf: q.get('as_of') ?? undefined,
        purpose: (q.get('purpose') as never) ?? undefined,
        historyLimit: numberParam(q, 'history_limit'),
      });
      if (q.get('format') !== 'text') return r;
      const reply: TextReply = {
        __text: r.briefing,
        __headers: {
          'x-continuity-state-version': String(r.state_version),
          'x-continuity-processing-complete': String(r.processing_complete),
          'x-continuity-budget-fits': String(r.budget.fits),
        },
      };
      return reply;
    }],
    ['GET', /^\/tasks\/([^/]+)\/state$/, 'context:read', (m, _q, _b, _r, p) => app.state(p.org, m[1])],
    ['GET', /^\/tasks\/([^/]+)\/timeline$/, 'context:read', (m, _q, _b, _r, p) => app.timeline(p.org, m[1])],
    ['GET', /^\/tasks\/([^/]+)\/open-loops$/, 'context:read', (m, _q, _b, _r, p) => app.openLoops(p.org, m[1])],
    ['GET', /^\/tasks\/([^/]+)\/changes$/, 'context:read', (m, q, _b, _r, p) => app.changes(p.org, m[1], Number(q.get('since') ?? 0))],
    ['GET', /^\/tasks\/([^/]+)\/explain$/, 'context:read', (m, q, _b, _r, p) => app.explain(p.org, m[1], q.get('term') ?? 'delivery.schedule')],
    ['GET', /^\/tasks\/([^/]+)\/wait$/, 'context:read', async (m, q, _b, _r, p) => {
      const timeout = Math.min(Number(q.get('timeout_ms') ?? 25000), 30000);
      return { state_version: await app.waitForChange(p.org, m[1], Number(q.get('since') ?? 0), timeout) };
    }],
    ['POST', /^\/tasks\/([^/]+)\/send$/, 'send', (m, _q, body, _r, p) => {
      const input = JSON.parse(body);
      assertAgent(p, input.agent_id);
      return app.send(p.org, m[1], input, p);
    }],
    // message bodies are left out of the action list
    ['GET', /^\/tasks\/([^/]+)\/actions$/, 'context:read', async (m, _q, _b, _r, p) => (await backend.listActions(p.org, m[1])).map(({ body: _omit, ...rest }) => rest)],
    ['POST', /^\/tasks\/([^/]+)\/cursor$/, 'agent:write', async (m, _q, body, _r, p) => {
      const { agent_id, seq } = JSON.parse(body);
      assertAgent(p, agent_id);
      await backend.setCursor(p.org, agent_id, m[1], Number(seq), nowIso());
      // mirror the cursor into Primitive Memories when the live transport offers them (best effort)
      await transport.memory?.set(`continuity:cursor:${m[1]}:${agent_id}`, { seq, at: nowIso() }).catch(() => undefined);
      return { agent_id, seq };
    }],
    ['GET', /^\/tasks\/([^/]+)\/agent-runs$/, 'context:read', (m, _q, _b, _r, p) => backend.agentRuns(p.org, m[1])],
    ['POST', /^\/tasks\/([^/]+)\/agent-runs$/, 'agent:write', async (m, _q, body, _r, p) => {
      const run = JSON.parse(body);
      assertAgent(p, run.agent_id);
      return { id: await backend.saveAgentRun(p.org, { ...run, task_id: m[1], principal_id: p.id }) };
    }],

    // ---- typed timeline (the raw per-email view stays at /timeline): ?type=counter_offer,appraisal_received  ?since=<seq>
    ['GET', /^\/tasks\/([^/]+)\/history$/, 'context:read', async (m, q, _b, _r, p) => {
      const { snap } = await app.snapshot(p.org, m[1]);
      const types = q.get('type')?.split(',').filter(Boolean);
      const since = Number(q.get('since') ?? 0);
      return { task_id: m[1], state_version: snap.version, events: deriveTimeline(snap.store, m[1]).filter((e) => e.seq > since && (!types || types.includes(e.type))) };
    }],
    // the task's terms at a moment: ?at=<ISO time> or ?at=<timeline seq>
    ['GET', /^\/tasks\/([^/]+)\/state-at$/, 'context:read', async (m, q, _b, _r, p) => {
      const raw = q.get('at');
      if (!raw) throw new HttpError(400, 'at=<ISO time | seq> is required');
      const at = /^\d+$/.test(raw) ? Number(raw) : raw;
      if (typeof at === 'string' && Number.isNaN(Date.parse(at))) throw new HttpError(400, 'at must be an ISO time or a seq number');
      const { snap } = await app.snapshot(p.org, m[1]);
      return stateAt(snap.store, m[1], typeof at === 'string' ? new Date(at).toISOString() : at);
    }],
    ['GET', /^\/tasks\/([^/]+)\/similar$/, 'context:read', (m, q, _b, _r, p) =>
      findSimilar(backend, scopeOf(p), m[1], Math.min(Number(q.get('k') ?? 5), 20)).catch(portfolioError)],

    // ---- portfolio: every task the caller may see, at once
    ['GET', /^\/deals$/, 'context:read', (_m, _q, _b, _r, p) => listDeals(backend, scopeOf(p))],
    ['GET', /^\/query\/schema$/, 'context:read', () => SCHEMA_GUIDE],
    ['POST', /^\/query$/, 'context:read', (_m, _q, body, _r, p) => query(backend, scopeOf(p), JSON.parse(body || '{}').sql).catch(portfolioError)],
    // a plain-language question across the portfolio, answered by Claude with the read-only tools above
    ['POST', /^\/ask$/, 'context:read', (_m, _q, body, _r, p) => {
      if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, 'Ask needs ANTHROPIC_API_KEY (the SQL, history, similarity and Signal endpoints work without it)');
      const question = String(JSON.parse(body || '{}').question ?? '').trim();
      if (!question || question.length > 2000) throw new HttpError(400, 'body must be {"question": "..."} (at most 2,000 characters)');
      return ask(backend, scopeOf(p), question);
    }],
    // ---- Signal: remembered alerts (?task=<id|alias>, ?all=1 includes resolved ones); POST runs a scan now
    ['GET', /^\/signals$/, 'context:read', async (_m, q, _b, _r, p) => {
      const only = q.get('task') ? (await app.task(p.org, q.get('task')!)).id : null;
      if (only && !canTask(p, only)) throw new HttpError(404, `unknown task ${q.get('task')}`);
      return (await backend.listSignals(p.org, { includeResolved: q.get('all') === '1' })).filter((s) => canTask(p, s.task_id) && (!only || s.task_id === only));
    }],
    ['POST', /^\/signals\/run$/, 'tasks:write', async (_m, _q, _b, _r, p) => {
      const run = await runSignal(backend, p.org, { taskIds: p.task_ids ?? undefined });
      return { ...run, notified: await notifyWebhook(process.env.CONTINUITY_SIGNAL_WEBHOOK, run) };
    }],

    ['GET', /^\/items\/([^/]+)\/provenance$/, 'evidence:read', (m, _q, _b, _r, p) => app.provenance(p.org, m[1], itemAccess(p))],
    ['GET', /^\/events\/([^/]+)\/attachments\/(\d+)$/, 'evidence:read', async (m, _q, _b, _r, p) => {
      const a = await app.attachment(p.org, m[1], Number(m[2]), (t) => canTask(p, t));
      const reply: BytesReply = {
        __bytes: a.bytes,
        __headers: {
          'content-type': a.content_type,
          'content-disposition': `attachment; filename="${a.filename.replace(/"/g, '')}"`,
          'x-content-sha256': a.sha256,
        },
      };
      return reply;
    }],
    ['GET', /^\/events\/([^/]+)$/, 'evidence:read', (m, _q, _b, _r, p) => app.provenance(p.org, m[1], itemAccess(p))],
    ['GET', /^\/events$/, 'evidence:read', async (_m, q, _b, _r, p) => (q.get('unlinked') && !p.task_ids ? backend.unlinkedEvents(p.org) : [])],
    ['POST', /^\/events\/([^/]+)\/link$/, 'tasks:write', async (m, _q, body, _r, p) => {
      const task = await app.task(p.org, JSON.parse(body).task_id);
      const r = await engine.link(p.org, m[1], task.id);
      return { event_id: r.event.id, task_id: r.event.task_id };
    }],

    // ---- local simulation only (refused once a real Primitive key is configured)
    ['POST', /^\/sim\/clock$/, 'tasks:write', (_m, _q, body) => {
      assertSim();
      setSimTime(JSON.parse(body).now);
      return { now: nowIso() };
    }],
    ['POST', /^\/sim\/deliver$/, 'tasks:write', async (_m, _q, body, _r, p) => {
      assertSim();
      const e = JSON.parse(body) as Omit<SimEmail, 'attachments'> & { attachments?: { filename: string; content_type: string; base64: string }[] };
      const mail: SimEmail = {
        ...e,
        attachments: (e.attachments ?? []).map((a) => ({ filename: a.filename, content_type: a.content_type, bytes: Buffer.from(a.base64, 'base64') })),
      };
      const delivery = (transport as LocalSimTransport).mailbox.inbound(mail, webhookSecret!);
      // post it over real HTTP to our own webhook endpoint, exactly as Primitive would, then let interpretation settle
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/primitive`, { method: 'POST', headers: delivery.headers, body: delivery.body });
      const result = await res.json() as { event_id?: string; task_id?: string | null; linked?: boolean };
      if (res.ok && result.linked && result.task_id && result.event_id) await engine.settle(p.org, result.task_id, result.event_id);
      return { webhook_status: res.status, result, message_id: delivery.messageId, thread_id: delivery.threadId };
    }],
    ['GET', /^\/sim\/sent$/, 'context:read', () => {
      assertSim();
      return (transport as LocalSimTransport).mailbox.sent;
    }],
  ];

  /** The authenticated caller, or null when no valid bearer token was presented. */
  async function principalFor(req: IncomingMessage): Promise<Principal | null> {
    if (authMode === 'off') return localPrincipal(org);
    const header = String(req.headers.authorization ?? '');
    const bearer = header.match(/^Bearer\s+(\S+)$/i);
    if (!bearer) return null;
    return backend.findPrincipal(hashToken(bearer[1]));
  }

  async function authorize(req: IncomingMessage, scope: Scope | null): Promise<Principal> {
    if (!scope) return localPrincipal(org);
    const found = await principalFor(req);
    if (!found) throw new HttpError(401, 'authentication required: Authorization: Bearer <token>');
    if (!hasScope(found, scope)) throw new HttpError(403, `token lacks scope ${scope}`);
    return found;
  }

  function reply(res: ServerResponse, out: unknown) {
    if (isObject(out) && '__bytes' in out) {
      const bytes = out as unknown as BytesReply;
      res.writeHead(200, bytes.__headers);
      return res.end(bytes.__bytes);
    }
    if (isObject(out) && '__text' in out) {
      const text = out as unknown as TextReply;
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...(text.__headers ?? {}) });
      return res.end(text.__text);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(out, null, 1));
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(ui));
      }
      const body = await readBody(req);
      for (const [method, pattern, scope, handler] of routes) {
        const m = url.pathname.match(pattern);
        if (!m || req.method !== method) continue;
        const p = await authorize(req, scope);
        // task routes take an alias or an id; handlers always receive the canonical id of a task in the caller's org
        if (pattern.source.startsWith('^\\/tasks\\/([^/]+)')) {
          const t = await app.task(p.org, decodeURIComponent(m[1]));
          if (!canTask(p, t.id)) throw new HttpError(404, `unknown task ${m[1]}`);
          m[1] = t.id;
        }
        return reply(res, await handler(m, url.searchParams, body, req, p));
      }
      throw new HttpError(404, `no route ${req.method} ${url.pathname}`);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : Number((err as { status?: number }).status) || 500;
      if (status === 500) console.error(err);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message, detail: err instanceof HttpError ? err.detail : undefined }));
    }
  });
  server.on('close', () => { engine.stop(); stopSignal(); });
  const shutdown = async () => {
    engine.stop();
    stopSignal();
    await backend.close();
  };
  return { server, app, backend, engine, transport, extractor, port, authMode, shutdown };
}

// started directly (`node src/server.ts`) rather than imported
const invokedDirectly = !!process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (invokedDirectly) {
  try {
    const { server, port, transport, extractor, backend, authMode, shutdown } = await buildApp();
    server.listen(port, () => {
      console.log(`[continuity] listening on http://localhost:${port}  storage=${backend.mode} (${backend.target}) transport=${transport.mode} extractor=${extractor.name} auth=${authMode}`);
      if (backend.mode !== 'postgres') console.log(`[continuity] OFFLINE STORAGE (${backend.mode}): explicitly selected; not the hosted Supabase store.`);
      if (transport.mode === 'local-sim') console.log('[continuity] LOCAL SIMULATION: no PRIMITIVE_API_KEY — mail is simulated, not sent.');
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        server.close();
        void shutdown().finally(() => process.exit(0));
      });
    }
  } catch (err) {
    console.error(`[continuity] failed to start: ${(err as Error).message}`);
    process.exit(1);
  }
}
export { redactUrl };
