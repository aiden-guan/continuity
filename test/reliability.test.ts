// Reliability guarantees, checked on every available backend:
//  - a received email is stored durably before anyone interprets it, and a crashed worker's job is
//    picked up again exactly once;
//  - redelivered webhooks have no duplicate effects;
//  - interpretation is serialized per task, in event order, with version-checked commits;
//  - a failed commit rolls back completely;
//  - outbound sends refuse incomplete or stale state, allow one in flight per task, and reconcile
//    unknown outcomes without sending the same email twice.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine/engine.ts';
import { heuristicExtractor } from '../src/extract/heuristic.ts';
import type { Extractor } from '../src/extract/types.ts';
import { Continuity, HttpError } from '../src/service.ts';
import { LocalSimTransport } from '../src/transport/transport.ts';
import { SimMailbox } from '../src/sim/mailbox.ts';
import { fromPrimitiveWebhook } from '../src/ingest/normalize.ts';
import { defaultAddresses, procurementTask } from '../src/sim/scenario.ts';
import type { Backend } from '../src/store/backend.ts';
import type { EventInput } from '../src/types.ts';
import { backendCases, closeAll, uniqueOrg } from './backends.ts';

after(closeAll);

const addr = defaultAddresses();
const mailbox = new SimMailbox();

// A supplier email, run through the same webhook normalization as production. Each one gets its own
// random thread so linking has to happen by task alias, never by thread.
function supplierEmail(body: string, at: string, subject = 'PO-4817 update'): EventInput {
  const delivery = mailbox.inbound({ from: addr.supplier, fromName: 'Dana', to: addr.self, subject, body, at, threadKey: `t${Math.random()}` }, 'k');
  return fromPrimitiveWebhook(JSON.parse(delivery.body));
}

const nowIso = () => new Date().toISOString();
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const OFFER = 'We can deliver 500 units Friday (Oct 23) at $11.40 each.';
const CORRECTION = 'Correction: only 300 units can arrive Friday. The other 200 won\'t arrive until Wednesday, Oct 28.';

// A fresh org with the procurement task created in it, plus an engine to drive it.
async function freshTask(backend: Backend, extractor: Extractor = heuristicExtractor, workerId = 'w1') {
  const org = uniqueOrg('rel');
  await backend.ensureOrg(org);
  const engine = new Engine(backend, extractor, null, { workerId, leaseMs: 60_000 });
  await engine.createTask(org, procurementTask(addr), '2026-10-19T08:55:00Z');
  return { org, engine, task: procurementTask(addr) };
}

// Awaits a promise that must fail with an HttpError carrying this status and detail.code.
async function expectHttpError(pending: Promise<unknown>, status: number, code: string) {
  try {
    await pending;
  } catch (err) {
    assert.ok(err instanceof HttpError, String(err));
    assert.equal(err.status, status, err.message);
    assert.equal((err.detail as { code?: string })?.code, code, err.message);
    return err;
  }
  assert.fail(`expected ${status} ${code}`);
}

const note = (taskId: string, summary: string) =>
  ({ task_id: taskId, event_id: null, at: nowIso(), type: 'note', subject_id: null, summary, detail: {} }) as const;

for (const backendCase of backendCases()) {
  const label = backendCase.name;

  test(`[${label}] receipt is durable before interpretation; a crashed worker's job is recovered exactly once`, async () => {
    const backend = await backendCase.make();
    const { org, task } = await freshTask(backend);
    const doomed = new Engine(backend, heuristicExtractor, null, { workerId: 'crashed', leaseMs: 150 });

    const received = await doomed.receive(org, supplierEmail(OFFER, '2026-10-19T11:00:00Z'));
    assert.equal(received.linked, true);
    let snap = await backend.loadTask(org, task.id);
    assert.deepEqual(snap.store.pendingEventIds(task.id), [received.event.id], 'stored and visible as pending before interpretation');

    // The worker takes the job and then dies while still holding the lease.
    const heldJob = await backend.claimJob('crashed', nowIso(), 150);
    assert.ok(heldJob);

    const survivor = new Engine(backend, heuristicExtractor, null, { workerId: 'survivor', leaseMs: 60_000 });
    assert.equal(await survivor.drain({ org }), 0, 'lease still live');
    await sleep(200);
    assert.equal(await survivor.drain({ org }), 1, 'expired lease reclaimed');

    // The dead worker wakes up and runs its outdated copy of the job; it must not apply twice.
    await doomed.runJob(heldJob!);
    snap = await backend.loadTask(org, task.id);
    assert.equal(snap.store.extractionsFor(received.event.id).length, 1);
    assert.equal(snap.store.transitionsForTask(task.id).filter((t) => t.type === 'event_ingested').length, 1);
    assert.equal(snap.store.claimsForTask(task.id).filter((c) => c.key === 'price.unit').length, 1);
    assert.deepEqual(snap.store.pendingEventIds(task.id), []);
  });

  test(`[${label}] duplicate delivery has no duplicate effects, but re-arms an unfinished event`, async () => {
    const backend = await backendCase.make();
    const { org, engine, task } = await freshTask(backend);
    const email = supplierEmail('Unit price is $11.40 per unit.', '2026-10-19T11:00:00Z');
    const first = await engine.receive(org, email);

    // Interpretation is dead-lettered before it finishes.
    const job = await backend.claimJob('w1', nowIso(), 60_000, { org });
    await backend.finishJob(job!.id, { status: 'dead', error: 'simulated poison' });
    let snap = await backend.loadTask(org, task.id);
    assert.deepEqual(snap.store.failedEventIds(task.id), [first.event.id]);

    // Primitive redelivers the same webhook.
    const redelivered = await engine.receive(org, email);
    assert.equal(redelivered.duplicate, true);
    assert.equal(redelivered.event.id, first.event.id);
    assert.equal(redelivered.requeued, true, 'unfinished event is processed again');
    await engine.drain({ org });
    snap = await backend.loadTask(org, task.id);
    assert.equal(snap.store.extractionsFor(first.event.id).length, 1);
    assert.deepEqual(snap.store.failedEventIds(task.id), []);

    // Once it has been interpreted, further redeliveries change nothing.
    const third = await engine.receive(org, email);
    assert.equal(third.requeued, false, 'a finished event is never re-interpreted by redelivery');
    assert.equal(await engine.drain({ org }), 0);
  });

  test(`[${label}] concurrent workers: per-task serialization in event order; stale snapshots are re-interpreted`, async () => {
    const backend = await backendCase.make();
    const { org, task } = await freshTask(backend);
    const workerA = new Engine(backend, heuristicExtractor, null, { workerId: 'w1' });
    const workerB = new Engine(backend, heuristicExtractor, null, { workerId: 'w2' });
    await workerA.receive(org, supplierEmail(OFFER, '2026-10-19T11:00:00Z'));
    await workerA.receive(org, supplierEmail(CORRECTION, '2026-10-20T10:00:00Z'));
    await workerA.receive(org, supplierEmail('Pricing update: unit price is now $11.45 per unit.', '2026-10-20T12:00:00Z'));
    await Promise.all([workerA.drain({ org }), workerB.drain({ org })]);

    const store = (await backend.loadTask(org, task.id)).store;
    const activeValues = (key: string) => store.claimsForTask(task.id).filter((c) => c.status === 'active' && c.key === key).map((c) => c.value);
    assert.deepEqual(activeValues('delivery.schedule'), [[{ qty: 300, date: '2026-10-23' }, { qty: 200, date: '2026-10-28' }]]);
    assert.deepEqual(activeValues('price.unit'), [11.45]);
    // event ids look like "ev_<n>", so sort by the number after the prefix
    const applied = store.transitionsForTask(task.id).filter((t) => t.type === 'event_ingested').map((t) => t.event_id);
    const byEventNumber = [...applied].sort((x, y) => Number(x!.slice(3)) - Number(y!.slice(3)));
    assert.deepEqual(applied, byEventNumber, 'interpreted in event order');

    // Force a race: someone else commits between this worker loading the task and committing.
    let interfered = false;
    const racer = new Engine(backend, heuristicExtractor, null, { workerId: 'racer' });
    racer.beforeCommit = async (_job, snap) => {
      if (interfered) return;
      interfered = true;
      const otherCopy = await backend.loadTask(org, snap.taskId);
      const result = await backend.commit(otherCopy, (st) => st.addTransition(note(task.id, 'concurrent writer')));
      assert.equal(result.ok, true);
    };
    const received = await racer.receive(org, supplierEmail('Payment terms: Net 45.', '2026-10-20T13:00:00Z'));
    await racer.drain({ org });
    assert.equal(racer.stats.stale_retries, 1, 'commit detected the stale snapshot and re-interpreted');

    const finalStore = (await backend.loadTask(org, task.id)).store;
    assert.equal(finalStore.extractionsFor(received.event.id).length, 1);
    assert.ok(finalStore.transitionsForTask(task.id).some((t) => t.summary === 'concurrent writer'));
    assert.equal(finalStore.claimsForTask(task.id).find((c) => c.key === 'payment.terms')?.value, 'Net 45');
  });

  test(`[${label}] commits are atomic: a failing apply leaves no partial state`, async () => {
    const backend = await backendCase.make();
    const { org, task } = await freshTask(backend);
    const snap = await backend.loadTask(org, task.id);
    const transitionCount = snap.store.transitionsForTask(task.id).length;

    // The apply function writes two things and then throws.
    const brokenApply = backend.commit(snap, (s) => {
      s.addTransition(note(task.id, 'half-applied'));
      s.addFlag(task.id, 'ev_x', 'note', 'half-applied', nowIso());
      throw new Error('resolver bug mid-apply');
    });
    await assert.rejects(brokenApply, /mid-apply/);

    const reloaded = await backend.loadTask(org, task.id);
    assert.equal(reloaded.version, snap.version);
    assert.equal(reloaded.store.transitionsForTask(task.id).length, transitionCount);
    assert.equal(reloaded.store.flagsForTask(task.id).length, 0);

    if (backend.mode === 'postgres') {
      // A constraint violation part-way through the flush undoes the rows written before it.
      const second = await backend.loadTask(org, task.id);
      await assert.rejects(backend.commit(second, (s) => {
        s.addTransition(note(task.id, 'before the bad row'));
        s.insertClaim({
          task_id: task.id, key: 'price.unit', value: 1, display: '$1.00', kind: 'offer', speaker: addr.supplier,
          source_event_id: 'ev_does_not_exist', source_artifact_id: null, evidence: 'x', status: 'active',
          superseded_by: null, supersede_reason: null, learned_at: nowIso(), confidence: 1, extractor: 't',
        });
      }));
      const third = await backend.loadTask(org, task.id);
      assert.equal(third.version, snap.version);
      assert.ok(!third.store.transitionsForTask(task.id).some((t) => t.summary === 'before the bad row'));
    }
  });

  test(`[${label}] sends: refused on incomplete or stale state; one in flight per task; retries reconcile without duplicate mail`, async () => {
    const backend = await backendCase.make();

    // An extractor we can pause, to hold an email in the "being interpreted" state.
    let openGate!: () => void;
    let gate: Promise<void> | null = null;
    const pausable: Extractor = {
      name: 'gated',
      async extract(input) {
        if (gate) await gate;
        return heuristicExtractor.extract(input);
      },
    };

    const transport = new LocalSimTransport();
    const org = uniqueOrg('send');
    await backend.ensureOrg(org);
    const app = new Continuity({ backend, extractor: pausable, transport, webhookSecret: null, requireStateVersion: true, ingestOrg: org });
    await app.createTask(org, procurementTask(addr));
    const taskId = 'task_po4817';
    const stateVersion = async () => (await app.context(org, taskId)).context.meta.state_version;
    const sendToSupplier = (body: string, version: number | null, agent = 'agent-a') =>
      app.send(org, taskId, { agent_id: agent, to: addr.supplier, body, based_on_version: version });
    const actionStatus = async (actionId: string) => (await backend.getAction(org, actionId))!.status;
    const actionIdOf = (err: HttpError) => (err.detail as { action_id: string }).action_id;
    const sentCount = () => transport.mailbox.sent.length;

    // No state version at all.
    await expectHttpError(sendToSupplier('Hi Dana, can you quote 500 units?', null), 428, 'version_required');

    // An email has arrived but is still being interpreted.
    gate = new Promise((resolve) => (openGate = resolve));
    const interpreting = app.engine.ingest(org, supplierEmail(OFFER, '2026-10-19T11:00:00Z'));
    await sleep(50);
    await expectHttpError(sendToSupplier('Hi Dana, can you quote 500 units?', await stateVersion()), 409, 'state_incomplete');
    openGate();
    gate = null;
    await interpreting;

    // The agent decided against an older version; the task moved on while it was thinking.
    const decidedOn = await stateVersion();
    await app.engine.ingest(org, supplierEmail(CORRECTION, '2026-10-20T10:00:00Z'));
    const staleErr = await expectHttpError(sendToSupplier('Great, Friday works for all 500.', decidedOn), 409, 'stale_context');
    assert.ok((staleErr.detail as { changes: unknown[] }).changes.length > 0, 'the refusal lists what changed');

    // The provider accepts the message but its response is lost. The outcome is unknown, and the
    // reconciler later settles it using the same idempotency key.
    const v2 = await stateVersion();
    transport.failNext = 'after';
    const lostReply = await expectHttpError(sendToSupplier('Hi Dana, all 500 must arrive by Fri Oct 23. Can you expedite the remaining 200?', v2), 502, 'delivery_unknown');
    const lostActionId = actionIdOf(lostReply);
    assert.equal(await actionStatus(lostActionId), 'attempted');
    // While that send is unresolved, nothing else may go out on this task.
    await expectHttpError(app.send(org, taskId, { agent_id: 'agent-b', to: addr.finance, body: 'FYI: delivery issue on PO-4817.', based_on_version: v2 }), 409, 'send_in_flight');
    assert.equal(await app.engine.drain({ org }, inFuture(60_000)), 1, 'reconcile job ran');
    assert.equal(await actionStatus(lostActionId), 'replayed', 'provider confirmed the earlier attempt delivered it');
    assert.equal(sentCount(), 1, 'exactly one email went out');
    const storeAfterReconcile = (await backend.loadTask(org, taskId)).store;
    assert.equal(storeAfterReconcile.eventsForTask(taskId).filter((e) => e.direction === 'outbound').length, 1, 'recorded once');

    // A client that retries the same POST gets back the recorded result, not a second email.
    const v3 = await stateVersion();
    const original = await sendToSupplier('Hi Dana, any update on the revised quote?', v3);
    const retried = await sendToSupplier('Hi Dana, any update on the revised quote?', v3);
    assert.equal(retried.idempotent_replay, true);
    assert.equal(retried.action_id, original.action_id);
    assert.equal(sentCount(), 2);

    // A network error before the provider ever saw the request: the reconciler sends it, once.
    const v4 = await stateVersion();
    transport.failNext = 'before';
    const neverArrived = await expectHttpError(sendToSupplier('Hi Dana, please confirm the expedite option.', v4), 502, 'delivery_unknown');
    await app.engine.drain({ org }, inFuture(60_000));
    assert.equal(await actionStatus(actionIdOf(neverArrived)), 'delivered');
    assert.equal(sentCount(), 3);

    // The provider rejects permanently: marked failed, nothing counted as sent, the task is free again.
    const v5 = await stateVersion();
    transport.failNext = 'permanent';
    const rejected = await expectHttpError(sendToSupplier('Hi Dana, one more question.', v5), 502, 'send_rejected');
    assert.equal(await actionStatus(actionIdOf(rejected)), 'failed');
    assert.equal(sentCount(), 3);

    // A brand-new database reuses an idempotency key the provider has already seen, so the provider
    // replays somebody else's send on the very first attempt. That must be refused loudly and nothing
    // recorded as sent (this guards the per-database key fix).
    const usedKey = (await backend.listActions(org, taskId)).find((x) => x.status === 'delivered')!.idempotency_key;
    const otherOrg = uniqueOrg('collide');
    await backend.ensureOrg(otherOrg);
    const otherApp = new Continuity({ backend, extractor: heuristicExtractor, transport, webhookSecret: null, ingestOrg: otherOrg });
    await otherApp.createTask(otherOrg, procurementTask(addr));
    await expectHttpError(otherApp.send(otherOrg, taskId, { agent_id: 'agent-a', to: addr.supplier, body: 'Different body', idempotency_key: usedKey }), 502, 'idempotency_collision');
    assert.equal(sentCount(), 3, 'the collision sent nothing new');
    assert.equal((await backend.loadTask(otherOrg, taskId)).store.eventsForTask(taskId).length, 0);
  });
}
