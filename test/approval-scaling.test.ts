// Scaling the approval paths: the memory backend loads one task's working set (not a copy of the
// whole org), GET /approvals loads only tasks with open cards, and a card is announced to the approval
// webhook at most once across restarts and processes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness, runCanonicalScenario } from '../src/sim/harness.ts';
import { counterparty, defaultAddresses, procurementTask } from '../src/sim/scenario.ts';
import { MemoryBackend } from '../src/store/memory-backend.ts';
import { SqliteBackend } from '../src/store/sqlite.ts';
import { COMMIT_COUNTERS, type MemoryStore } from '../src/store/state.ts';
import type { Backend, Principal } from '../src/store/backend.ts';
import { DEFAULT_ORG } from '../src/engine/engine.ts';
import { Continuity } from '../src/service.ts';
import { heuristicExtractor } from '../src/extract/heuristic.ts';
import { LocalSimTransport } from '../src/transport/transport.ts';
import { APPROVER_SCOPES } from '../src/auth.ts';
import { openApprovalTaskIds } from '../src/engine/approval-log.ts';
import { setSimTime } from '../src/clock.ts';
import { backendCases, closeAll, pg, PG_URL, uniqueOrg } from './backends.ts';
import { createServer } from 'node:http';
import { compileContext } from '../src/compiler/compile.ts';
import { deriveTimeline } from '../src/engine/timeline.ts';

delete process.env.PRIMITIVE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
const a = defaultAddresses();
const dir = mkdtempSync(join(tmpdir(), 'continuity-approval-scaling-'));
after(() => rmSync(dir, { recursive: true, force: true }));
after(() => closeAll());

/** memory and (with a local Supabase) postgres from the shared matrix, plus a SQLite file per org */
const cases = [
  ...backendCases(),
  {
    name: 'sqlite',
    make: async () => {
      const b = new SqliteBackend(join(dir, `${Math.random().toString(36).slice(2)}.db`));
      await b.init();
      return b as Backend;
    },
  },
];
const human = (org: string): Principal => ({ id: 'pr_human', org, kind: 'operator', agent_id: null, scopes: APPROVER_SCOPES, task_ids: null, label: 'Robin' });
const taskN = (n: number) => ({ ...procurementTask(a), id: `task_${n}`, alias: `PO-${n}` });
const commit = (svc: Continuity, org: string, n: number, body = 'We accept your offer.') =>
  svc.send(org, `PO-${n}`, { agent_id: 'agent-x', to: a.supplier, body, intent: 'commit' }) as Promise<{ status: string; approval_id: string }>;

/** What a loaded working set holds, in a form two backends can be compared on. */
function shape(s: MemoryStore, taskId: string) {
  const ids = (m: Map<string, unknown>) => [...m.keys()].sort();
  return {
    tasks: ids(s.tasks),
    events: ids(s.events),
    threads: s.threads.size, // sim thread ids are random per mailbox
    extractions: s.extractions.map((x) => `${x.event_id}:${x.version}`).sort(),
    artifacts: ids(s.artifacts),
    claims: ids(s.claims),
    claimEvidence: s.claimEv.map((x) => `${x.claim_id}:${x.event_id}`).sort(),
    obligations: ids(s.obligations),
    transitions: s.transitions.map((t) => t.seq),
    checks: s.getChecks(taskId).map((c) => `${c.id}:${c.status}`),
    flags: s.flags.map((f) => f.id).sort(),
    cursors: [...s.cursors.entries()].sort(),
    counters: COMMIT_COUNTERS.map((k) => s.counters.get(k) ?? 0),
    failed: [...s.failed].sort(),
    version: s.stateVersion(taskId),
  };
}

/** Two tasks and an unlinked email in one org, played identically on any backend. */
async function twoTasks(backend: Backend) {
  const main = new Harness(procurementTask(a), undefined, undefined, { backend });
  await runCanonicalScenario(main, a, counterparty);
  const other = new Harness({ ...procurementTask(a), id: 'task_other', alias: 'PO-9001' }, undefined, undefined, { backend });
  await other.out(a.supplier, 'RFQ: PO-9001', 'Hi Dana, can you quote 20 units of AX-300 for PO-9001?', '2026-10-19T09:30:00Z');
  await backend.setCursor(DEFAULT_ORG, 'agent-x', main.task.id, 3, '2026-10-19T10:00:00Z');
  await backend.setCursor(DEFAULT_ORG, 'agent-x', 'task_other', 1, '2026-10-19T10:00:00Z');
  return { main, other };
}

test('memory loadTask copies only the task working set, the same rows SQLite loads', async () => {
  const memory = new MemoryBackend();
  const sqlite = new SqliteBackend(join(dir, 'working-set.db'));
  await sqlite.init();
  try {
    await twoTasks(memory);
    await twoTasks(sqlite);
    await memory.instanceId(DEFAULT_ORG);
    const auth = memory.org(DEFAULT_ORG);
    assert.ok(auth.unlinkedEvents().length > 0, 'the scenario leaves an unlinked email in the org');

    for (const taskId of ['task_po4817', 'task_other']) {
      const m = (await memory.loadTask(DEFAULT_ORG, taskId)).store;
      const s = (await sqlite.loadTask(DEFAULT_ORG, taskId)).store;
      assert.deepEqual(shape(m, taskId), shape(s, taskId), `working set of ${taskId}`);
      // nothing of the other task and no unlinked email
      assert.deepEqual([...m.tasks.keys()], [taskId]);
      assert.ok([...m.events.values()].every((e) => e.task_id === taskId));
      assert.ok(m.transitions.every((t) => t.task_id === taskId));
      assert.equal(m.instanceId(), auth.instanceId());
    }

    // a commit through the smaller snapshot still allocates ids after every other task's
    const snap = await memory.loadTask(DEFAULT_ORG, 'task_other');
    const before = auth.counters.get('tr')!;
    const c = await memory.commit(snap, (w) => w.addTransition({ task_id: 'task_other', event_id: null, at: '2026-10-19T11:00:00Z', type: 'note', subject_id: null, summary: 'x', detail: {} }));
    assert.ok(c.ok);
    assert.equal(c.version, before + 1);
    assert.equal(auth.stateVersion('task_other'), before + 1);
    assert.equal(auth.stateVersion('task_po4817') < before + 1, true);
  } finally {
    await sqlite.close();
  }
});

for (const kind of cases) {
  test(`[${kind.name}] GET /approvals loads only tasks with open cards, and returns exactly what loading every task did`, async () => {
    const org = uniqueOrg('openap');
    const backend = await kind.make();
    try {
      await backend.ensureOrg(org);
      const svc = new Continuity({ backend, extractor: heuristicExtractor, transport: new LocalSimTransport(), webhookSecret: null, ingestOrg: org });
      const T0 = '2026-10-19T09:00:00Z';
      setSimTime(T0);
      for (let n = 1; n <= 7; n++) await svc.createTask(org, taskN(n));
      const expiredByTime = await commit(svc, org, 5); // open as recorded, expired by the clock
      const expiredRecorded = await commit(svc, org, 6); // expiry written when touched
      setSimTime('2026-10-21T08:00:00Z'); // 47 h later
      const open = await commit(svc, org, 1);
      const rejected = await commit(svc, org, 2);
      const held = await commit(svc, org, 3);
      const twice = await commit(svc, org, 7); // rejected, then a second card stays open
      // task 4 never asks
      assert.equal((await svc.decide(org, 'PO-2', rejected.approval_id, { option: 'reject' }, human(org))).status, 'rejected');
      assert.equal((await svc.decide(org, 'PO-3', held.approval_id, { option: 'hold_verify' }, human(org))).status, 'held');
      assert.equal((await svc.decide(org, 'PO-7', twice.approval_id, { option: 'reject' }, human(org))).status, 'rejected');
      const second = await commit(svc, org, 7, 'We accept your offer of $11.40 per unit.');
      assert.notEqual(second.approval_id, twice.approval_id);
      setSimTime('2026-10-21T10:00:00Z'); // 49 h after T0
      await assert.rejects(svc.decide(org, 'PO-6', expiredRecorded.approval_id, { option: 'approve' }, human(org)), /expired/);
      assert.ok(open.approval_id && expiredByTime.approval_id);

      // the lookup: open as recorded (the clock is judged after loading), equal to the reference fold
      const ids = (await backend.openApprovalTaskIds(org)).sort();
      assert.deepEqual(ids, ['task_1', 'task_3', 'task_5', 'task_7']);
      const tasks = (await backend.listTasks(org)).map((t) => t.spec.id);
      const everyTransition = (await Promise.all(tasks.map(async (t) => (await backend.loadTask(org, t)).store.transitionsForTask(t)))).flat();
      assert.deepEqual(openApprovalTaskIds(everyTransition).sort(), ids);

      // the org-wide list is what loading every task gave, in the same order, from only the candidates' loads
      const perTask = (await Promise.all(tasks.map((t) => svc.approvals(org, { taskId: t })))).flat();
      const loaded: string[] = [];
      const load = backend.loadTask.bind(backend);
      backend.loadTask = (o, t) => { loaded.push(t); return load(o, t); };
      const orgWide = await svc.approvals(org);
      backend.loadTask = load;
      assert.deepEqual(orgWide, perTask);
      assert.deepEqual(orgWide.map((x) => [x.task_id, x.status]), [['task_1', 'pending'], ['task_3', 'held'], ['task_7', 'pending']]);
      assert.deepEqual(loaded.sort(), ids);
      // ?all=1 still lists every card of every task
      assert.equal((await svc.approvals(org, { all: true })).length, 7);
    } finally {
      setSimTime(new Date().toISOString());
      if (kind.name === 'sqlite') await backend.close();
    }
  });
}

// ------------------------------------------------------------------ announcements

/** A chat webhook that records every card posted to it; failNext(n) answers the next n posts with a 500. */
async function webhook() {
  const posts: { id: string; ok: boolean }[] = [];
  let fail = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const ok = fail <= 0;
      if (!ok) fail--;
      posts.push({ id: JSON.parse(body).approval.id, ok });
      res.writeHead(ok ? 200 : 500).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/hook`, posts,
    delivered: () => posts.filter((p) => p.ok).map((p) => p.id),
    failNext: (n: number) => { fail = n; },
    close: () => server.close(),
  };
}
const until = async (cond: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !cond() && Date.now() < end;) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), 'timed out waiting');
};
const settle = () => new Promise((r) => setTimeout(r, 150));

/** Backends that can be "restarted": a fresh instance over the same data (the same object for memory). */
const durable: { name: string; open: () => Promise<Backend>; again: (b: Backend) => Promise<Backend>; done: (b: Backend[]) => Promise<void> }[] = [
  { name: 'memory', open: async () => new MemoryBackend(), again: async (b) => b, done: async () => {} },
  (() => {
    let file = '';
    const fresh = async () => {
      const b = new SqliteBackend(file);
      await b.init();
      return b as Backend;
    };
    return {
      name: 'sqlite',
      open: async () => {
        file = join(dir, `announce-${Math.random().toString(36).slice(2)}.db`);
        return fresh();
      },
      again: fresh,
      done: async (bs: Backend[]) => { for (const b of bs) await b.close(); },
    };
  })(),
  ...(PG_URL ? [{ name: 'postgres', open: () => pg(), again: () => pg(), done: async () => {} }] : []),
];
const announcer = (backend: Backend, org: string, url?: string) =>
  new Continuity({ backend, extractor: heuristicExtractor, transport: new LocalSimTransport(), webhookSecret: null, ingestOrg: org, approvalWebhook: url });

for (const kind of durable) {
  test(`[${kind.name}] a held send's card is announced once, claimed in the card's own commit, and never again after a restart`, async () => {
    const hook = await webhook();
    const org = uniqueOrg('announce');
    const opened: Backend[] = [];
    try {
      const backend = await kind.open();
      opened.push(backend);
      await backend.ensureOrg(org);
      const first = announcer(backend, org, hook.url);
      await first.createTask(org, procurementTask(a));
      const held = await commit(first, org, 4817) as { status: string; approval_id: string; state_version: number };
      assert.equal(held.status, 'held');
      await until(() => hook.posts.length === 1);
      assert.deepEqual(hook.delivered(), [held.approval_id]);
      // the claim rode in the card's own commit: no extra state version for an agent to trip over
      const snap = await backend.loadTask(org, 'task_po4817');
      assert.equal(snap.version, held.state_version);
      assert.deepEqual(snap.store.transitionsForTask('task_po4817').filter((t) => t.type === 'approval_notified').map((t) => t.subject_id), [held.approval_id]);

      // a restart: a new process over the same data posts nothing already announced
      const again = await kind.again(backend);
      if (again !== backend) opened.push(again);
      const second = announcer(again, org, hook.url);
      second.engine.notify(org, 'task_po4817');
      assert.deepEqual(await second.notifyVerifications(org, 'task_po4817'), []);
      const same = await commit(second, org, 4817) as unknown as { existing: boolean; approval_id: string };
      assert.equal(same.existing, true);
      assert.equal(same.approval_id, held.approval_id);
      await settle();
      assert.equal(hook.posts.length, 1);
    } finally {
      hook.close();
      await kind.done(opened);
    }
  });

  test(`[${kind.name}] a verification card is posted by exactly one of two processes, not again after a restart, and is bookkeeping only`, async () => {
    const hook = await webhook();
    const org = uniqueOrg('announce');
    const opened: Backend[] = [];
    try {
      const backend = await kind.open();
      opened.push(backend);
      await backend.ensureOrg(org);
      const h = new Harness(procurementTask(a), undefined, undefined, { backend, org });
      const supplier = (body: string, at: string) => h.in({ from: a.supplier, fromName: 'Dana', to: a.self, subject: 'PO-4817 terms', body, at, threadKey: 'x' });
      await supplier('Our payment terms are Net 30.', '2026-10-19T13:00:00Z');
      await supplier('Update: our payment terms are now Net 10.', '2026-10-19T14:00:00Z');
      const before = await backend.loadTask(org, 'task_po4817');
      const [card] = (await announcer(backend, org).approvals(org, { taskId: 'PO-4817' })).filter((x) => x.kind === 'verify_change');
      assert.ok(card, 'the held payment-terms change raised a verification card');

      // two server processes (two backend instances over the same data) race to announce it
      const other = await kind.again(backend);
      if (other !== backend) opened.push(other);
      const claims = await Promise.all([announcer(backend, org, hook.url).notifyVerifications(org, 'task_po4817'), announcer(other, org, hook.url).notifyVerifications(org, 'task_po4817')]);
      assert.deepEqual(claims.flat(), [card.id]);
      assert.deepEqual(hook.delivered(), [card.id]);

      // a restart: nothing is posted again
      const third = await kind.again(backend);
      if (third !== backend) opened.push(third);
      const restarted = announcer(third, org, hook.url);
      assert.deepEqual(await restarted.notifyVerifications(org, 'task_po4817'), []);
      restarted.engine.notify(org, 'task_po4817');
      await settle();
      assert.equal(hook.posts.length, 1);

      // bookkeeping only: the card reads the same, the briefing and the typed timeline do not change, and
      // an agent's send decided on the version before the claim is not refused as stale
      const after = await third.loadTask(org, 'task_po4817');
      assert.equal(after.version, before.version + 1);
      const [still] = (await restarted.approvals(org, { taskId: 'PO-4817' })).filter((x) => x.kind === 'verify_change');
      assert.deepEqual(still, card);
      const strip = (ctx: ReturnType<typeof compileContext>) => ({ ...ctx, meta: { ...ctx.meta, state_version: 0, compiled_at: null } });
      assert.deepEqual(strip(compileContext(after.store, 'task_po4817', { now: '2026-10-19T15:00:00Z' })), strip(compileContext(before.store, 'task_po4817', { now: '2026-10-19T15:00:00Z' })));
      assert.deepEqual(deriveTimeline(after.store, 'task_po4817'), deriveTimeline(before.store, 'task_po4817'));
      const sent = await restarted.send(org, 'PO-4817', { agent_id: 'agent-x', to: a.finance, body: 'Could you confirm the PO-4817 budget is still approved?', intent: 'ask', based_on_version: before.version });
      assert.equal(sent.status, 'delivered');
    } finally {
      hook.close();
      await kind.done(opened);
    }
  });
}

test('a post the webhook did not accept is retried by a durable job until accepted, or dropped once the card closes', async () => {
  const hook = await webhook();
  const org = uniqueOrg('announce');
  try {
    const backend = new MemoryBackend();
    await backend.ensureOrg(org);
    const svc = announcer(backend, org, hook.url);
    for (const n of [1, 2]) await svc.createTask(org, taskN(n));
    hook.failNext(2);
    const one = await commit(svc, org, 1);
    const two = await commit(svc, org, 2);
    const retries = () => backend.jobs.filter((j) => j.kind === 'notify_approval');
    await until(() => retries().length === 2);
    assert.equal(hook.posts.length, 2);
    assert.deepEqual(hook.delivered(), []);
    assert.ok(retries().every((j) => j.task_id === null && j.status === 'pending' && Date.parse(j.run_after) > Date.now()));

    // card 2 is decided before its retry: that job finishes without posting
    await svc.decide(org, 'PO-2', two.approval_id, { option: 'reject' }, human(org));
    hook.failNext(1); // the first retry of card 1 fails as well: the queue backs off and tries again
    // not due yet: nothing runs before the retry delay
    assert.equal(await svc.engine.drain({ org }), 0);
    // a minute on: card 2's job (closed card), card 1's failing retry, then (after its backoff) its accepted one
    assert.equal(await svc.engine.drain({ org }, new Date(Date.now() + 60_000).toISOString()), 3);
    assert.deepEqual(hook.posts.map((p) => [p.id, p.ok]), [[one.approval_id, false], [two.approval_id, false], [one.approval_id, false], [one.approval_id, true]]);
    assert.deepEqual(hook.delivered(), [one.approval_id]);
    assert.deepEqual(retries().map((j) => [j.payload.approval_id, j.status, j.attempts]), [[one.approval_id, 'done', 2], [two.approval_id, 'done', 1]]);
    // retries never write a second claim
    const claimsOf = async (t: string) => (await backend.loadTask(org, t)).store.transitionsForTask(t).filter((x) => x.type === 'approval_notified').length;
    assert.deepEqual([await claimsOf('task_1'), await claimsOf('task_2')], [1, 1]);
  } finally {
    hook.close();
  }
});
