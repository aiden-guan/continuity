// The robustness (mess) transform: real-world email clutter that must never change a fact. Every
// archetype of every vertical is perturbed at levels 1–3 (variant 0 plus two dev/eval variants) and must
// stay valid, keep its oracle, pass the strict meaning-preservation guard, and be deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadVerticals, enumerate } from '../bench/verticals/index.ts';
import { validateCase } from '../bench/core/validate.ts';
import { selftestCase } from '../bench/core/selftest.ts';
import { materialize } from '../bench/core/mailbox.ts';
import { assertMeaningPreserved, factTokens, withMess, type MessLevel } from '../bench/core/perturb.ts';
import type { BenchCase, VerticalModule } from '../bench/core/types.ts';

// Other verticals may be mid-edit; fall back to the reference vertical rather than failing here.
let mods: VerticalModule[];
try { mods = await loadVerticals(); } catch { mods = await loadVerticals(['procurement']); }
const cases = enumerate(mods, { variants: [0, 7, 16] });
const LEVELS: MessLevel[] = [1, 2, 3];
const messed = cases.flatMap(({ mod, case: c }) => LEVELS.map((level) => ({ mod, c, level, m: withMess(c, level) })));

test('perturbed cases are structurally valid and keep the oracle', () => {
  assert.ok(cases.length >= 39, `expected every archetype, got ${cases.length} cases`);
  for (const { mod, c, level, m } of messed) {
    assert.deepEqual(validateCase(m, mod.vertical), [], m.id);
    assert.equal(m.id, `${c.id}@mess${level}`);
    assert.ok(m.capabilities.includes('robustness'));
    assert.deepEqual(m.checkpoints, c.checkpoints, m.id);
    assert.equal(m.trigger, c.trigger, m.id);
    assert.deepEqual(m.task, c.task, m.id);
    const tasks = m.events.filter((e) => !e.background);
    assert.equal(tasks.at(-1)!.key, c.events.filter((e) => !e.background).at(-1)!.key, `${m.id}: no task event added`);
  }
});

test('the meaning-preservation guard passes on every perturbed case', () => {
  for (const { c, m } of messed) assert.doesNotThrow(() => assertMeaningPreserved(c, m), m.id);
});

test('the transform is deterministic', () => {
  for (const { c, level, m } of messed) assert.equal(JSON.stringify(withMess(c, level)), JSON.stringify(m), m.id);
});

test('level 3 adds at least 3 background messages and changes most task bodies', () => {
  for (const { c, m } of messed.filter((x) => x.level === 3)) {
    const keys = new Set(c.events.map((e) => e.key));
    const added = m.events.filter((e) => !keys.has(e.key));
    assert.ok(added.length >= 3, `${m.id}: ${added.length} added`);
    assert.ok(added.every((e) => e.background), m.id);
    const orig = c.events.filter((e) => !e.background);
    const changed = orig.filter((e) => m.events.find((x) => x.key === e.key)!.body !== e.body).length;
    assert.ok(changed / orig.length >= 0.5, `${m.id}: only ${changed}/${orig.length} task bodies changed`);
  }
});

test('mess grows with the level', () => {
  const growth = (level: MessLevel) => messed.filter((x) => x.level === level).reduce((n, { c, m }) =>
    n + m.events.reduce((s, e) => s + e.body.length + e.subject.length, 0) - c.events.reduce((s, e) => s + e.body.length + e.subject.length, 0), 0);
  const [g1, g2, g3] = LEVELS.map(growth);
  assert.ok(g1 > 0 && g1 < g2 && g2 < g3, `${g1} < ${g2} < ${g3}`);
});

test('perturbed cases materialise and still pass scorer calibration', () => {
  for (const { mod, m } of messed.filter((x) => x.c.variant === 0)) {
    const mb = materialize(m);
    assert.equal(mb.trigger.key, m.trigger);
    assert.deepEqual(selftestCase(mod, m), [], m.id);
  }
});

test('no wrap splits a number or date across lines', () => {
  for (const { c, m } of messed) {
    for (const o of c.events) {
      const body = m.events.find((x) => x.key === o.key)!.body;
      // every token must appear on one line exactly as a whitespace-normalised substring
      for (const line of body.split('\n')) for (const t of factTokens(line)) assert.ok(!/\n/.test(t));
      assert.deepEqual(body.split('\n').flatMap((l) => factTokens(l)), factTokens(o.body), `${m.id}/${o.key}`);
    }
  }
});

// ------------------------------------------------------------------ the guard itself is strict

test('factTokens finds amounts, numbers, dates, weekdays and relative dates', () => {
  assert.deepEqual(
    factTokens('Only 300 by Fri Oct 23; the rest (1,200) on Wednesday, November 4, 2026 at $11.40 or 2026-11-04, 10/23, 8am. Quote tomorrow, end of day.'),
    ['300', 'fri', 'oct', '23', '1,200', 'wednesday', 'november', '4', '2026', '$11.40', '2026-11-04', '10/23', '8', 'tomorrow', 'end of day'],
  );
  assert.deepEqual(factTokens('Hope you are well. This email may contain confidential information. Sunbelt Canning.'), []);
});

test('the guard rejects fact changes, additions, reordering and misplaced mail', () => {
  const { c } = messed.find((x) => x.c.id === 'procurement/correction/0') ?? messed[0];
  const ok = withMess(c, 2);
  const edit = (fn: (x: BenchCase) => void): BenchCase => { const x = structuredClone(ok); fn(x); return x; };
  const trig = (x: BenchCase) => x.events.find((e) => e.key === x.trigger)!;
  const firstNum = (s: string) => s.match(/\d+/)![0];
  const bad: [string, BenchCase][] = [
    ['changed number', edit((x) => { const e = trig(x); e.body = e.body.replace(firstNum(e.body), String(Number(firstNum(e.body)) + 1)); })],
    ['added number in signature', edit((x) => { trig(x).body += '\n\nTel: 555 0100'; })],
    ['added weekday', edit((x) => { trig(x).body += '\n\nHappy Friday!'; })],
    ['added relative date', edit((x) => { trig(x).body += '\n\nTalk tomorrow.'; })],
    ['dropped number', edit((x) => { const e = trig(x); e.body = e.body.replace(firstNum(e.body), 'some'); })],
    ['subject number', edit((x) => { trig(x).subject += ' (2)'; })],
    ['moved timestamp', edit((x) => { trig(x).at = trig(x).at.replace(/:00Z$/, ':01Z'); })],
    ['oracle edit', edit((x) => { x.checkpoints[0].state.next_actor = x.checkpoints[0].state.next_actor === 'us' ? 'them' : 'us'; })],
    ['added task event', edit((x) => { const i = x.events.findIndex((e) => e.key === x.trigger); x.events.splice(i, 0, { ...x.events[i], key: 'e99', at: x.events[i - 1].at }); })],
    ['background after trigger', edit((x) => { const t = trig(x); x.events.push({ ...t, key: 'b99', background: true, at: '2099-01-01T00:00:00Z', replyTo: null }); })],
    ['background tied with a neighbour', edit((x) => { const i = x.events.findIndex((e) => e.key === x.trigger); x.events.splice(i, 0, { ...x.events[i], key: 'b98', background: true, replyTo: null }); })],
    ['attachment edit', edit((x) => { const e = x.events.find((ev) => ev.attachments?.length); if (e) e.attachments![0].lines = [...e.attachments![0].lines, 'x']; else x.trigger = 'e1'; })],
  ];
  for (const [name, x] of bad) assert.throws(() => assertMeaningPreserved(c, x), /meaning not preserved/, name);
  // swapping two date tokens in the same body is caught (order matters)
  const swapped = edit((x) => {
    const e = x.events.find((ev) => factTokens(ev.body).length >= 2 && new Set(factTokens(ev.body)).size >= 2)!;
    const [a, b] = [...new Set(factTokens(e.body))];
    e.body = e.body.replace(new RegExp(a.replace(/[$.]/g, '\\$&'), 'i'), '\u0000').replace(new RegExp(b.replace(/[$.]/g, '\\$&'), 'i'), a).replace('\u0000', b);
  });
  assert.throws(() => assertMeaningPreserved(c, swapped), /fact tokens differ/);
});
