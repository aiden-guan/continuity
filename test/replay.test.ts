// Compiled state is derived only from the immutable event log plus the saved extractor proposals,
// so replaying those inputs has to land on exactly the same state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Harness, runCanonicalScenario } from '../src/sim/harness.ts';
import { counterparty, defaultAddresses, procurementTask } from '../src/sim/scenario.ts';
import { replayTask } from '../src/engine/replay.ts';
import { heuristicExtractor } from '../src/extract/heuristic.ts';
import type { MemoryStore as Store } from '../src/store/state.ts';

const addr = defaultAddresses();

// A comparable, plain-data picture of everything the engine derived for one task.
function stateOf(store: Store, taskId: string) {
  return {
    claims: store.claimsForTask(taskId).map((c) => [c.id, c.key, c.status, c.display, c.superseded_by, c.source_event_id]),
    obligations: store.obligationsForTask(taskId).map((o) => [o.id, o.kind, o.status, o.debtor, o.resolved_by_event_id]),
    artifacts: store.artifactsForTask(taskId).map((art) => [art.id, art.filename, art.status, art.superseded_by]),
    checks: store.getChecks(taskId).map((c) => [c.id, c.status, c.detail]).sort(),
    transitions: store.transitionsForTask(taskId).map((t) => [t.type, t.summary]),
  };
}

// The canonical story, then our push-back and the supplier's resolution. Also keeps a snapshot
// taken right after the supplier's correction so we can compare a partial replay against it.
async function playWholeStory() {
  const h = new Harness(procurementTask(addr));
  const story = await runCanonicalScenario(h, addr, counterparty);
  const afterCorrection = stateOf(h.store, h.task.id);
  const ourAsk = await h.out(
    addr.supplier,
    `Re: ${story.rfq.subject}`,
    'All 500 must arrive by Friday Oct 23. Can you expedite the remaining 200? Still waiting on the revised quote.',
    '2026-10-20T11:00:00Z',
    { messageId: story.correction.messageId },
  );
  await h.in(counterparty.supplierResolution(addr, { messageId: ourAsk.messageId, subject: ourAsk.subject, references: ourAsk.references }, ourAsk.body));
  return { h, story, afterCorrection };
}

test('full replay from saved proposals reproduces the live state exactly', async () => {
  const { h } = await playWholeStory();
  const rebuilt = await replayTask(h.store, h.task.id);
  assert.deepEqual(stateOf(rebuilt, h.task.id), stateOf(h.store, h.task.id));
});

test('replay as of an event reproduces what we believed at that moment', async () => {
  const { h, story, afterCorrection } = await playWholeStory();
  const past = await replayTask(h.store, h.task.id, { uptoEventId: story.correction.event.id });
  assert.deepEqual(stateOf(past, h.task.id), afterCorrection);
  // back then the delivery conflict was still open and the quote only partly out of date
  const deadlineFailed = past.getChecks(h.task.id).some((c) => c.id.startsWith('delivery_deadline') && c.status === 'fail');
  assert.ok(deadlineFailed);
  assert.equal(past.artifactsForTask(h.task.id)[0].status, 'partially_stale');
});

test('re-interpreting the same evidence with a fresh extractor leaves events untouched', async () => {
  const { h } = await playWholeStory();
  const eventBodies = () => h.store.eventsForTask(h.task.id).map((e) => [e.id, e.body_text]);
  const bodiesBefore = eventBodies();
  const reread = await replayTask(h.store, h.task.id, { extractor: heuristicExtractor });
  assert.deepEqual(eventBodies(), bodiesBefore);
  assert.deepEqual(stateOf(reread, h.task.id).claims, stateOf(h.store, h.task.id).claims);
});
