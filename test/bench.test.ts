// Benchmark harness tests (no model calls): case validity, scorer calibration on every case,
// statistics, normalisation, the scale transform and the shared mailbox materialisation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadVerticals, enumerate } from '../bench/verticals/index.ts';
import { validateCase } from '../bench/core/validate.ts';
import { selftestActions, selftestCase } from '../bench/core/selftest.ts';
import { mcnemar, pairedBootstrap } from '../bench/core/stats.ts';
import { normalize } from '../bench/core/normalize.ts';
import { withBacklog } from '../bench/core/scale.ts';
import { materialize, awaitingFor } from '../bench/core/mailbox.ts';

const mods = await loadVerticals();
const all = enumerate(mods);

test('every case is structurally valid', () => {
  const errors = all.flatMap(({ mod, case: c }) => validateCase(c, mod.vertical));
  assert.deepEqual(errors.slice(0, 10), []);
});

test('scorer calibration holds on every case', () => {
  const fails = all.flatMap(({ mod, case: c }) => [...selftestCase(mod, c), ...selftestActions(mod, c)]);
  assert.deepEqual(fails.slice(0, 10), []);
});

test('case generation is deterministic', () => {
  for (const { mod, case: c } of all.filter((_, i) => i % 7 === 0)) {
    const a = mod.archetypes.find((x) => x.id === c.archetype)!;
    assert.equal(JSON.stringify(a.generate(c.variant)), JSON.stringify(c));
  }
});

test('backlog transform keeps the oracle and moves the trigger to the newest task message', () => {
  for (const { mod, case: c } of all.filter((x) => x.case.variant === 0)) {
    const big = withBacklog(c, 60, mod);
    assert.equal(validateCase(big, mod.vertical).length, 0, big.id);
    assert.deepEqual(big.checkpoints.at(-1)!.state, c.checkpoints.at(-1)!.state);
    assert.ok(big.events.length >= c.events.length + 60);
    assert.ok(Date.parse(big.checkpoints.at(-1)!.now) - Date.parse(c.checkpoints.at(-1)!.now) < 8 * 3600_000, 'clock barely moves');
    assert.deepEqual(selftestCase(mod, big), []);
  }
});

test('materialised mail quotes the parent and threads replies', () => {
  const { case: c } = all.find((x) => x.case.id === 'procurement/correction/0')!;
  const mb = materialize(c);
  const reply = mb.messages.find((m) => m.event.replyTo)!;
  assert.match(reply.body, /wrote:\n> /);
  assert.equal(reply.thread_id, mb.byKey.get(reply.event.replyTo!)!.thread_id);
  assert.ok(['you', 'them'].includes(awaitingFor(mb, reply.thread_id)));
});

test('McNemar and paired bootstrap behave', () => {
  assert.equal(mcnemar([1, 1, 1, 0], [1, 1, 1, 0]).p, 1);
  const strong = mcnemar(Array(20).fill(1), Array(20).fill(0));
  assert.ok(strong.p < 1e-5 && strong.b === 20 && strong.c === 0);
  const d = pairedBootstrap([1, 1, 1, 1, 0, 1, 1, 1], [0, 1, 0, 0, 0, 1, 0, 0]);
  assert.ok(d.diff > 0.5 && d.lo > 0 && d.hi <= 1);
});

test('normalisation canonicalises equivalent values', () => {
  assert.equal(normalize('money', '$11.40'), 11.4);
  assert.deepEqual(normalize('lots', [{ qty: '200', date: '2026-10-28' }, { qty: 300, date: '2026-10-23' }]), [{ qty: 300, date: '2026-10-23' }, { qty: 200, date: '2026-10-28' }]);
  assert.deepEqual(normalize('window', { start: '2026-10-23T08:00:00Z', end: '2026-10-23 12:00' }), { start: '2026-10-23T08:00', end: '2026-10-23T12:00' });
  assert.equal(normalize('text', ' Net-30 '), 'net 30');
  assert.equal(normalize('date', 'Friday'), null);
});

test('primitive-native tool loop runs real tools and enforces the call budget', async () => {
  const { primitiveNative, TOOL_BUDGET } = await import('../bench/conditions/primitive.ts');
  const { Llm } = await import('../bench/core/llm.ts');
  const { case: c, mod } = all.find((x) => x.case.id === 'procurement/correction/0')!;
  const mb = materialize(c);
  let turn = 0;
  // a greedy agent: two tool calls per turn, forever
  const llm = new Llm({ mock: () => {
    turn++;
    return { content: [
      { type: 'tool_use', id: `t${turn}a`, name: 'search_inbox', input: { q: 'correction revised quote' } },
      { type: 'tool_use', id: `t${turn}b`, name: 'get_conversation', input: { email_id: mb.trigger.id } },
    ] };
  } });
  const p = await primitiveNative.prepare(mb, { llm, vertical: mod.vertical, trial: 1, cacheDir: '.scratch/bench-cache', mock: true });
  assert.equal((p.diag as { tool_calls: number }).tool_calls, TOOL_BUDGET);
  assert.match(p.memory, /search_inbox/);
  assert.match(p.memory, /"role": "assistant"/, 'conversation includes our outbound mail');
  // search is inbound-only, like Primitive's /emails/search
  assert.doesNotMatch(p.memory.split('### get_conversation')[0], /"direction": "outbound"/);
});
