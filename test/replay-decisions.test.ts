// Human decisions are part of what the system believed. They are event-less transitions, so replay has to
// re-apply them between the emails, or a historical view (as_of) and a replay import would silently show a
// phone-verified payment detail as unverified and lose every approval.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryBackend } from '../src/store/memory-backend.ts';
import { SqliteBackend } from '../src/store/sqlite.ts';
import type { Backend } from '../src/store/backend.ts';
import type { MemoryStore } from '../src/store/state.ts';
import { decisionLog, replayTask } from '../src/engine/replay.ts';
import { approvalsForTask } from '../src/engine/approval-log.ts';
import { closeAll, PG_URL, pg, uniqueOrg } from './backends.ts';
import { decisionStory } from './decisions-story.ts';

delete process.env.PRIMITIVE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const dir = mkdtempSync(join(tmpdir(), 'continuity-replay-decisions-'));
after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await closeAll();
});

// a SQLite file holds one organization, so each test opens its own
let files = 0;
const cases: { name: string; open: () => Promise<Backend> }[] = [
  { name: 'memory', open: async () => new MemoryBackend() },
  {
    name: 'sqlite',
    open: async () => {
      const b = new SqliteBackend(join(dir, `replay-${++files}.db`));
      await b.init();
      return b;
    },
  },
  ...(PG_URL ? [{ name: 'postgres', open: () => pg() }] : []),
];

// What the decisions changed, without the claim and approval ids a replay renumbers.
function decided(store: MemoryStore, taskId: string) {
  return {
    claims: store.claimsForTask(taskId).map((c) => [c.source_event_id, c.key, c.display, c.status, c.supersede_reason]),
    checks: store.getChecks(taskId).map((c) => [c.id, c.status, c.detail]).sort(),
    approvals: approvalsForTask(store, taskId).map((x) => [x.kind, x.status, x.decided_by, x.decision?.option ?? null, x.action_id, x.expires_at, x.draft?.body ?? null]),
    log: decisionLog(store, taskId),
  };
}
const terms = (store: MemoryStore, taskId: string, status: string) =>
  store.claimsForTask(taskId).filter((c) => c.key === 'payment.terms' && c.status === status).map((c) => c.display);

for (const kind of cases) {
  test(`[${kind.name}] replay re-applies verifications, rejections, approved sends and expiries`, async () => {
    const backend = await kind.open();
    const org = uniqueOrg('replaydec');
    const s = await decisionStory(backend, org);
    const source = (await backend.loadTask(org, s.taskId)).store;
    const replayed = await replayTask(source, s.taskId);

    assert.deepEqual(decided(replayed, s.taskId), decided(source, s.taskId));
    assert.deepEqual(terms(replayed, s.taskId, 'active'), ['Net 15']); // verified by phone, so applied
    assert.deepEqual(terms(replayed, s.taskId, 'retracted'), ['Net 10']); // rejected as not genuine
    const statuses = approvalsForTask(replayed, s.taskId).map((x) => `${x.kind}:${x.status}`);
    assert.deepEqual(statuses, ['verify_change:rejected', 'verify_change:stale', 'verify_change:verified', 'send:approved', 'send:expired']);
    // the superseded card still points at the card that replaced it, under the replay's ids
    const [, older, newer, approved] = approvalsForTask(replayed, s.taskId);
    assert.equal(older.decision?.new_approval_id, newer.id);
    // the approved send keeps its record, and its email is the one the replay re-ingested
    assert.equal(approved.decided_by, 'approver:Alex');
    assert.ok(replayed.getEvent(s.sent), 'the sent email replays');
    // replaying a replay changes nothing
    assert.deepEqual(decided(await replayTask(replayed, s.taskId), s.taskId), decided(source, s.taskId));
    if (kind.name === 'sqlite') await backend.close();
  });

  test(`[${kind.name}] as_of shows a verified detail as unverified before the call, and applied after it`, async () => {
    const backend = await kind.open();
    const org = uniqueOrg('asof');
    const s = await decisionStory(backend, org);
    const source = (await backend.loadTask(org, s.taskId)).store;

    // as of the Net 15 email: it was held, its card still open; the phone call came later
    const before = await replayTask(source, s.taskId, { uptoEventId: s.net15 });
    assert.deepEqual(terms(before, s.taskId, 'active'), ['Net 30']);
    assert.deepEqual(terms(before, s.taskId, 'proposed'), ['Net 20', 'Net 15']);
    assert.deepEqual(approvalsForTask(before, s.taskId, '2026-10-19T16:00:00Z').map((x) => x.status), ['rejected', 'pending', 'pending']);
    // as of a later email: verified, applied, and the approved send on record
    const afterwards = await replayTask(source, s.taskId, { uptoEventId: s.later });
    assert.deepEqual(terms(afterwards, s.taskId, 'active'), ['Net 15']);
    assert.deepEqual(approvalsForTask(afterwards, s.taskId).map((x) => x.status), ['rejected', 'stale', 'verified', 'approved']);

    // the same through the API's historical context
    const activeTerms = async (asOf: string) => (await s.service.context(org, 'PO-4817', { asOf })).context.current_terms
      .filter((t) => t.term === 'payment.terms').map((t) => t.value);
    assert.deepEqual(await activeTerms(s.net15), ['Net 30']);
    assert.deepEqual(await activeTerms(s.sent), ['Net 15']);
    assert.deepEqual(await activeTerms(s.later), ['Net 15']);
    if (kind.name === 'sqlite') await backend.close();
  });
}
