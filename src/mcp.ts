// Stdio MCP server (JSON-RPC 2.0) that puts Continuity in front of any MCP-capable agent — the
// agent can mount Primitive's MCP server for mail alongside this one for conversation state.
//
//   claude mcp add continuity -- node /path/to/src/mcp.ts      (CONTINUITY_URL defaults to http://localhost:4100)
//   Hosted: set CONTINUITY_TOKEN to a scoped agent token (npm run token -- --kind agent --agent <id> --task <id>).
import { createInterface } from 'node:readline';

const API = process.env.CONTINUITY_URL || 'http://localhost:4100';
const TOKEN = process.env.CONTINUITY_TOKEN || '';

function authHeaders(): Record<string, string> {
  return TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
}

/** Per task+agent: the state version of the last context this session read; sends default to it. */
const lastVersion = new Map<string, number>();

const TOOLS = [
  {
    name: 'continuity_get_context',
    description: 'Compiled working state for a task: next actor, suggested actions, conflicts, current vs superseded terms, who owes what, answered questions, document staleness, changes since you last acted, processing completeness, state version, evidence ids. Call this first when you wake up; do not act while it says processing is incomplete.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'task id or alias, e.g. PO-4817' },
        agent_id: { type: 'string', description: 'your stable agent id (defines "changes since last action")' },
        format: { type: 'string', enum: ['text', 'json'], default: 'text' },
        purpose: { type: 'string', enum: ['act', 'reply', 'review', 'accept', 'follow_up'], default: 'act' },
        max_tokens: { type: 'number', description: 'context budget in estimated tokens (characters/4); essential state is never dropped — an over-budget result says so' },
        as_of: { type: 'string', description: 'historical checkpoint: event id (ev_*) to see what was known then' },
      },
      required: ['task'],
    },
  },
  {
    name: 'continuity_open_loops',
    description: 'What we are waiting on, what we owe, open conflicts, and already-answered questions (do not re-ask).',
    inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
  },
  {
    name: 'continuity_explain_term',
    description: 'Why the system believes a term (e.g. delivery.schedule, price.unit) has its current value: full history with evidence quotes and supersession reasons.',
    inputSchema: { type: 'object', properties: { task: { type: 'string' }, term: { type: 'string' } }, required: ['task', 'term'] },
  },
  {
    name: 'continuity_provenance',
    description: 'Source evidence for a claim (cl_*), obligation (ob_*), artifact (ar_*) or event (ev_*).',
    inputSchema: { type: 'object', properties: { item_id: { type: 'string' } }, required: ['item_id'] },
  },
  {
    name: 'continuity_changes',
    description: 'State transitions after a given sequence number.',
    inputSchema: { type: 'object', properties: { task: { type: 'string' }, since: { type: 'number' } }, required: ['task'] },
  },
  {
    name: 'continuity_send',
    description: 'Send an email to a task participant via Primitive. Continuity threads it, records it as an event, refuses binding language (accept/approve payment) while hard requirements fail, and refuses a send decided on an outdated context (fetch context again when told the state is stale or incomplete).',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        agent_id: { type: 'string' },
        to: { type: 'string' },
        body: { type: 'string' },
        subject: { type: 'string' },
        based_on_version: { type: 'number', description: 'state_version of the context you decided on (defaults to the last context this session read)' },
      },
      required: ['task', 'agent_id', 'to', 'body'],
    },
  },
  {
    name: 'continuity_history',
    description: "A task's typed timeline: offers, counters, appraisals, date changes, commitments, conflicts — each with its source email id.",
    inputSchema: { type: 'object', properties: { task: { type: 'string' }, types: { type: 'string', description: 'optional comma-separated event types to keep, e.g. counter_offer,closing_set' } }, required: ['task'] },
  },
  {
    name: 'continuity_state_at',
    description: "A task's terms as they stood at a moment (an ISO time, or a timeline seq).",
    inputSchema: { type: 'object', properties: { task: { type: 'string' }, at: { type: 'string' } }, required: ['task', 'at'] },
  },
  {
    name: 'continuity_signals',
    description: 'Open alerts across all tasks you can see (failing requirements, contradictions, overdue promises, approaching deadlines, quarantined injections, stalled tasks), with evidence ids.',
    inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'optional: one task only' } } },
  },
  {
    name: 'continuity_list_deals',
    description: 'Every task at once: outcome (accepted | fell_through | open), who acts next and why, failing checks, open alerts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'continuity_query',
    description: 'One read-only SQL SELECT across all tasks (tables: deals, deal_events, deal_terms, deal_checks, deal_obligations, signals; columns via GET /query/schema or SELECT name, sql FROM sqlite_master). Max 500 rows.',
    inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
  },
  {
    name: 'continuity_find_similar',
    description: 'Tasks whose history began like this one, and how they ended (fell-through rate over the closest cohort).',
    inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
  },
  {
    name: 'continuity_ask',
    description: 'A plain-language question about the whole portfolio, answered with citations to tasks and source emails (needs ANTHROPIC_API_KEY on the server).',
    inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
  {
    name: 'continuity_mark_seen',
    description: 'Advance your cursor to the current state version (do this after acting).',
    inputSchema: { type: 'object', properties: { task: { type: 'string' }, agent_id: { type: 'string' } }, required: ['task', 'agent_id'] },
  },
];

/** GET against the API; a non-2xx response becomes an error carrying the response body. */
async function apiGet(path: string) {
  const res = await fetch(`${API}${path}`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return { text, headers: res.headers };
}

async function apiPost(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return text;
}

async function callTool(name: string, args: Record<string, any>): Promise<string> {
  const task = encodeURIComponent(args.task ?? '');
  const versionKey = `${args.task}\u0000${args.agent_id ?? ''}`;
  switch (name) {
    case 'continuity_get_context': {
      const params = [
        `agent=${encodeURIComponent(args.agent_id ?? '')}`,
        `purpose=${encodeURIComponent(args.purpose ?? 'act')}`,
        args.max_tokens ? `max_tokens=${Number(args.max_tokens)}` : '',
        args.as_of ? `as_of=${encodeURIComponent(args.as_of)}` : '',
      ].filter(Boolean).join('&');
      if (args.format === 'json') {
        const r = JSON.parse((await apiGet(`/tasks/${task}/context?${params}`)).text);
        if (!args.as_of) lastVersion.set(versionKey, r.state_version);
        return JSON.stringify({ ...r.context, budget: r.budget });
      }
      const r = await apiGet(`/tasks/${task}/context?${params}&format=text`);
      // a historical (as_of) read is not something to decide a send on, so it does not move the version
      if (!args.as_of) lastVersion.set(versionKey, Number(r.headers.get('x-continuity-state-version')));
      return r.text;
    }
    case 'continuity_open_loops':
      return (await apiGet(`/tasks/${task}/open-loops`)).text;
    case 'continuity_explain_term':
      return (await apiGet(`/tasks/${task}/explain?term=${encodeURIComponent(args.term)}`)).text;
    case 'continuity_provenance':
      return (await apiGet(`/items/${encodeURIComponent(args.item_id)}/provenance`)).text;
    case 'continuity_changes':
      return (await apiGet(`/tasks/${task}/changes?since=${Number(args.since ?? 0)}`)).text;
    case 'continuity_send':
      return apiPost(`/tasks/${task}/send`, {
        agent_id: args.agent_id, to: args.to, body: args.body, subject: args.subject,
        based_on_version: args.based_on_version ?? lastVersion.get(versionKey) ?? null,
      });
    case 'continuity_history':
      return (await apiGet(`/tasks/${task}/history${args.types ? `?type=${encodeURIComponent(args.types)}` : ''}`)).text;
    case 'continuity_state_at':
      return (await apiGet(`/tasks/${task}/state-at?at=${encodeURIComponent(args.at ?? '')}`)).text;
    case 'continuity_signals':
      return (await apiGet(`/signals${args.task ? `?task=${task}` : ''}`)).text;
    case 'continuity_list_deals':
      return (await apiGet('/deals')).text;
    case 'continuity_query':
      return apiPost('/query', { sql: args.sql });
    case 'continuity_find_similar':
      return (await apiGet(`/tasks/${task}/similar`)).text;
    case 'continuity_ask':
      return apiPost('/ask', { question: args.question });
    case 'continuity_mark_seen': {
      // asking for changes after a huge seq returns nothing but still reports the current version
      const current = JSON.parse((await apiGet(`/tasks/${task}/changes?since=999999999`)).text).state_version;
      return apiPost(`/tasks/${task}/cursor`, { agent_id: args.agent_id, seq: current });
    }
  }
  throw new Error(`unknown tool ${name}`);
}

const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const lines = createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  if (!line.trim()) return;
  let req: { id?: number | string; method: string; params?: any };
  try {
    req = JSON.parse(line);
  } catch {
    return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  // notifications carry no id and get no reply
  const reply = (result: unknown) => req.id !== undefined && write({ jsonrpc: '2.0', id: req.id, result });
  switch (req.method) {
    case 'initialize':
      return reply({
        protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'continuity', version: '0.1.0' },
        instructions: 'Conversation state for Primitive agents. On wake: continuity_get_context → act (continuity_send) → continuity_mark_seen.',
      });
    case 'notifications/initialized':
      return;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      try {
        return reply({ content: [{ type: 'text', text: await callTool(req.params.name, req.params.arguments ?? {}) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `error: ${(e as Error).message}` }], isError: true });
      }
    default:
      if (req.id !== undefined) write({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } });
  }
});
