// A local Anthropic proxy for third-party memory providers (Hindsight in Docker; anything else that takes a base URL).
//
//   node --env-file=.env bench/providers/proxy.ts          # listens on 127.0.0.1:8787 (PROXY_PORT)
//
// Why: the providers are measured on the same model as Continuity (Claude Haiku 5.5), and their token use is counted.
//   - every /v1/messages request is sent with model claude-haiku-5-5 (PROVIDER_MODEL), whatever the library asked for;
//   - sampling parameters Haiku 5.5 rejects (temperature, top_p, top_k) and old-style thinking budgets are dropped, and
//     thinking is turned off (the same setting as Continuity's extractor, and what older-model code expects back);
//   - the real API key is added here, so containers only ever hold a dummy key;
//   - usage is appended to bench/providers/data/usage.jsonl and totalled per tag (base URL prefix /t/<tag>, header
//     x-bench-tag, else "untagged").
// GET /__usage returns the running totals per tag, so a condition can snapshot before and after a case.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PROXY_PORT || 8787);
const MODEL = process.env.PROVIDER_MODEL || 'claude-haiku-5-5';
const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) throw new Error('ANTHROPIC_API_KEY is not set');
const here = dirname(fileURLToPath(import.meta.url));
const LOG = join(here, 'data', 'usage.jsonl');
mkdirSync(dirname(LOG), { recursive: true });

type Usage = { calls: number; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
const totals = new Map<string, Usage>();
const add = (tag: string, u: Partial<Usage>) => {
  const t = totals.get(tag) ?? { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  t.calls += 1;
  t.input_tokens += u.input_tokens ?? 0;
  t.output_tokens += u.output_tokens ?? 0;
  t.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
  t.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
  totals.set(tag, t);
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), tag, ...u })}\n`);
};

/** The request a third-party library sent, made valid for Haiku 5.5 and measured on it. */
export function adapt(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, model: MODEL };
  delete out.temperature;
  delete out.top_p;
  delete out.top_k;
  out.thinking = { type: 'disabled' };
  // thinking off is accepted only at effort high or below
  const oc = (out.output_config ?? {}) as Record<string, unknown>;
  if (oc.effort === 'xhigh' || oc.effort === 'max') out.output_config = { ...oc, effort: 'high' };
  return out;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    if (req.method === 'GET' && req.url === '/__usage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Object.fromEntries(totals)));
      return;
    }
    const raw = await readBody(req);
    // a client that cannot set headers (Hindsight) names its tag in the base URL: http://proxy/t/<tag>/v1/messages
    const tagged = (req.url ?? '').match(/^\/t\/([\w.-]+)(\/.*)$/);
    if (tagged) req.url = tagged[2];
    const tag = tagged?.[1] ?? String(req.headers['x-bench-tag'] ?? 'untagged');
    const isMessages = req.method === 'POST' && (req.url ?? '').startsWith('/v1/messages') && !(req.url ?? '').includes('count_tokens');
    let payload = raw;
    let streaming = false;
    if (isMessages && raw.length) {
      const body = adapt(JSON.parse(raw.toString('utf8')));
      streaming = !!body.stream;
      payload = Buffer.from(JSON.stringify(body));
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': String(req.headers['anthropic-version'] ?? '2023-06-01'),
      'x-api-key': KEY,
    };
    if (req.headers['anthropic-beta']) headers['anthropic-beta'] = String(req.headers['anthropic-beta']);
    // keys without a workspace scope need the workspace named (as src/anthropic.ts does)
    if (process.env.ANTHROPIC_WORKSPACE_ID) headers['anthropic-workspace-id'] = process.env.ANTHROPIC_WORKSPACE_ID;
    const upstream = await fetch(`https://api.anthropic.com${req.url}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : new Uint8Array(payload) });
    const passHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) passHeaders[k] = v; });
    res.writeHead(upstream.status, passHeaders);
    if (!upstream.body) { res.end(); return; }
    if (streaming) {
      // pass the event stream through, picking the usage out of message_start and message_delta
      const usage: Partial<Usage> = {};
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(chunk);
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(line.slice(5));
            const u = ev.message?.usage ?? ev.usage;
            if (u) Object.assign(usage, Object.fromEntries(Object.entries(u).filter(([, v]) => typeof v === 'number' && v > 0)));
          } catch { /* not JSON */ }
        }
      }
      res.end();
      if (upstream.ok && isMessages) add(tag, usage);
      return;
    }
    const text = await upstream.text();
    res.end(text);
    if (upstream.ok && isMessages) {
      try { add(tag, JSON.parse(text).usage ?? {}); } catch { /* not JSON */ }
    } else if (!upstream.ok) {
      appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), tag, error: upstream.status, body: text.slice(0, 300) })}\n`);
    }
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: String((err as Error).message) } }));
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // loopback only: it adds the real API key, so it must never listen on the network. Docker Desktop still reaches it
  // from a container as host.docker.internal.
  server.listen(PORT, '127.0.0.1', () => console.log(`anthropic proxy on :${PORT}, model ${MODEL}, usage → ${LOG}`));
}
