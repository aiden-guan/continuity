// Portfolio layer: questions across every task — read-only SQL, deal list, lookalikes, Signal at scale,
// the Ask tool loop (with a scripted stand-in for Claude), and scoping over HTTP.
// Ported from samrocksnature's b615ab7.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { buildPortfolio, fillPortfolio, TODAY, type PortfolioDeal } from '../src/sim/portfolio.ts';
import { findSimilar, listDeals, query, type PortfolioScope } from '../src/portfolio.ts';
import { runSignal } from '../src/signal.ts';
import { ask } from '../src/ask.ts';
import { buildApp } from '../src/server.ts';
import { mintToken } from '../src/auth.ts';
import { MemoryBackend } from '../src/store/memory-backend.ts';
import { LocalSimTransport } from '../src/transport/transport.ts';

delete process.env.PRIMITIVE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

let backend: MemoryBackend;
let scope: PortfolioScope;
let deals: PortfolioDeal[];
before(async () => {
  const built = await buildPortfolio(60, 7);
  backend = built.backend;
  deals = built.deals;
  scope = { org: built.org };
});

test('portfolio: every archetype ends the way its story says', async () => {
  const outcome = new Map((await listDeals(backend, scope)).map((d) => [d.task_id, d.outcome]));
  const expected: Record<string, string> = {
    smooth: 'accepted', gap_resolved: 'accepted', slip_resolved: 'accepted', gap_fell_through: 'fell_through', slip_fell_through: 'fell_through', other_offer: 'fell_through',
  };
  for (const d of deals) assert.equal(outcome.get(d.task_id), expected[d.archetype] ?? 'open', `${d.alias} (${d.archetype})`);
});

test('SQL: one read-only SELECT over curated tables; writes, attach, pragma and stacked statements are refused', async () => {
  const r = await query(backend, scope, 'SELECT outcome, count(*) AS n FROM deals GROUP BY outcome ORDER BY outcome');
  assert.deepEqual(r.columns, ['outcome', 'n']);
  assert.equal(r.rows.reduce((sum, row) => sum + Number(row[1]), 0), 60);
  const late = await query(backend, scope, "SELECT d.alias, c.detail FROM deals d JOIN deal_checks c USING (task_id) WHERE d.outcome = 'open' AND c.check_id LIKE 'closing_deadline%' AND c.status = 'fail'");
  assert.equal(late.row_count, deals.filter((d) => d.archetype === 'open_slip_overdue').length);
  for (const bad of ['DELETE FROM deals', "ATTACH DATABASE 'x.db' AS x", 'PRAGMA table_info(deals)', 'SELECT 1; DELETE FROM deals', 'SELECT * FROM events',
    "WITH x AS (SELECT 1) INSERT INTO deals(task_id) SELECT 'x'", "SELECT load_extension('x')"]) {
    await assert.rejects(query(backend, scope, bad), Error, bad);
  }
  assert.equal((await query(backend, scope, 'SELECT count(*) FROM deals')).rows[0][0], 60); // nothing changed
  assert.equal((await query(backend, scope, "SELECT 'a;b' AS s")).rows[0][0], 'a;b'); // a semicolon inside a string is fine
});

test('scope: a restricted caller sees only its own tasks, in every table', async () => {
  const mine = deals.slice(0, 3).map((d) => d.task_id);
  const narrow = { org: scope.org, taskIds: mine };
  assert.deepEqual((await listDeals(backend, narrow)).map((d) => d.task_id).sort(), [...mine].sort());
  for (const table of ['deals', 'deal_events', 'deal_terms', 'deal_checks', 'deal_obligations']) {
    const r = await query(backend, narrow, `SELECT DISTINCT task_id FROM ${table}`);
    assert.ok(r.rows.every((row) => mine.includes(String(row[0]))), table);
  }
  const similar = await findSimilar(backend, narrow, mine[0]);
  assert.ok(similar.similar.every((s) => mine.includes(s.task_id)));
});

test('lookalikes: an open appraisal-gap deal is compared with how other deals began, and their outcomes', async () => {
  const target = deals.find((d) => d.archetype === 'open_gap')!;
  const r = await findSimilar(backend, scope, target.task_id);
  assert.ok(r.pattern.includes('conflict_detected:Appraisal covers the price'));
  assert.ok(r.cohort.decided > 0);
  const gapDeals = deals.filter((d) => d.archetype === 'gap_resolved' || d.archetype === 'gap_fell_through').length;
  assert.ok(r.cohort.decided >= gapDeals * 0.8, `cohort ${r.cohort.decided} vs ${gapDeals} gap deals`);
  assert.match(r.summary, /fell through \(\d+%\)/);
});

test('Signal at portfolio scale: no alerts for deals that fell through; alerts show up in SQL', async () => {
  const run = await runSignal(backend, scope.org, { now: TODAY });
  const dead = new Set((await listDeals(backend, scope)).filter((d) => d.outcome === 'fell_through').map((d) => d.task_id));
  assert.ok(run.new.length > 0);
  assert.ok(run.new.every((s) => !dead.has(s.task_id)));
  const r = await query(backend, scope, 'SELECT count(*) FROM signals WHERE resolved_at IS NULL');
  assert.equal(r.rows[0][0], run.open.length);
});

test('Ask: tool loop — results go back in one message, errors are flagged, the turn budget is enforced', async () => {
  const sent: unknown[][] = [];
  const script = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'run_sql', input: { sql: "SELECT count(*) FROM deals WHERE outcome = 'open'" } }, { type: 'tool_use', id: 't2', name: 'get_timeline', input: { task: 'NO-SUCH' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'There are open deals [D-1000 ev_1].' }] },
  ];
  const params: { model?: string }[] = [];
  const client = {
    messages: {
      create: async (p: { model: string; messages: unknown[] }) => {
        params.push(p);
        sent.push(structuredClone(p.messages));
        return { ...script[sent.length - 1], usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  };
  const r = await ask(backend, scope, 'How many deals are open?', { client: client as never });
  assert.equal(r.answer, 'There are open deals [D-1000 ev_1].');
  assert.equal(params[0].model, 'claude-haiku-5-5');
  assert.equal(sent.length, 2);
  const second = sent[1] as { role: string; content: { type: string; tool_use_id?: string; is_error?: boolean; content?: string }[] }[];
  assert.equal(second[1].role, 'assistant'); // the assistant turn went back unchanged
  const results = second[2];
  assert.equal(results.role, 'user');
  assert.deepEqual(results.content.map((c) => c.tool_use_id), ['t1', 't2']); // both results, one message
  assert.equal(results.content[1].is_error, true);
  assert.match(results.content[0].content!, /"rows":\[\[\d+\]\]/);
  assert.deepEqual(r.tool_calls.map((c) => c.name), ['run_sql', 'get_timeline']);

  // a model that never stops calling tools gets MAX_TURNS rounds, then must answer
  let calls = 0;
  const looping = {
    messages: {
      create: async (p: { messages: { content: unknown }[] }) => {
        calls++;
        const lastMsg = p.messages.at(-1)!.content as { type: string }[];
        const told = Array.isArray(lastMsg) && lastMsg.some((c) => c.type === 'text');
        return calls > 8 && told
          ? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } }
          : { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `x${calls}`, name: 'open_alerts', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  const r2 = await ask(backend, scope, 'loop', { client: looping as never });
  assert.equal(calls, 9);
  assert.equal(r2.answer, 'done');
});

test('HTTP: deals, query, history, state-at, similar, signals; scoped tokens; Ask explains itself without a key', async () => {
  const mem = new MemoryBackend();
  const built = await buildApp({ backend: mem, port: 0, auth: 'required', transport: new LocalSimTransport(), org: 'org_portfolio', worker: false });
  const portfolio = await fillPortfolio(mem, 'org_portfolio', 8, 3);
  const operator = (await mintToken(mem, { org: 'org_portfolio', kind: 'operator' })).token;
  const agent = (await mintToken(mem, { org: 'org_portfolio', kind: 'agent', agent_id: 'a1', task_ids: [portfolio[0].task_id] })).token;
  await new Promise<void>((r) => built.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(built.server.address() as AddressInfo).port}`;
  const get = (p: string, token = operator) => fetch(`${base}${p}`, { headers: { authorization: `Bearer ${token}` } });
  const post = (p: string, b: unknown, token = operator) => fetch(`${base}${p}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(b) });
  try {
    assert.equal(((await (await get('/deals')).json()) as unknown[]).length, 8);
    const q = await post('/query', { sql: 'SELECT count(*) AS n FROM deal_events' });
    assert.equal(q.status, 200);
    assert.equal((await post('/query', { sql: 'DROP TABLE deals' })).status, 400);
    const history = (await (await get('/tasks/D-1000/history?type=offer_made')).json()) as { events: { type: string }[] };
    assert.ok(history.events.length > 0 && history.events.every((e) => e.type === 'offer_made'));
    assert.equal((await get('/tasks/D-1000/state-at?at=2026-12-31T00:00:00Z')).status, 200);
    assert.equal((await get('/tasks/D-1000/state-at?at=nonsense')).status, 400);
    assert.equal((await get('/tasks/D-1000/similar')).status, 200);
    const run = (await (await post('/signals/run', {})).json()) as { open: unknown[]; notified: boolean };
    assert.equal(run.notified, false);
    assert.equal(((await (await get('/signals')).json()) as unknown[]).length, run.open.length);

    // a task-restricted agent token: only its own task anywhere in the portfolio
    const seen = (await (await get('/deals', agent)).json()) as { task_id: string }[];
    assert.deepEqual(seen.map((d) => d.task_id), [portfolio[0].task_id]);
    const rows = (await (await post('/query', { sql: 'SELECT DISTINCT task_id FROM deal_terms' }, agent)).json()) as { rows: string[][] };
    assert.ok(rows.rows.every((row) => row[0] === portfolio[0].task_id));
    assert.equal((await get(`/tasks/${portfolio[1].alias}/history`, agent)).status, 404);
    assert.ok(((await (await get('/signals', agent)).json()) as { task_id: string }[]).every((s) => s.task_id === portfolio[0].task_id));
    assert.equal((await post('/signals/run', {}, agent)).status, 403); // agents lack tasks:write

    assert.equal((await post('/ask', { question: 'Which deals are at risk?' })).status, 503);
  } finally {
    built.server.close();
  }
});
