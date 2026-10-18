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
import type { Backend } from '../src/store/backend.ts';
import { DEFAULT_ORG } from '../src/engine/engine.ts';

delete process.env.PRIMITIVE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
const a = defaultAddresses();
const dir = mkdtempSync(join(tmpdir(), 'continuity-approval-scaling-'));
after(() => rmSync(dir, { recursive: true, force: true }));

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
