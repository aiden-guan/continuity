// Judge-calibration fixtures (no model calls): every fixture in bench/judge-fixtures must name an
// existing golden case, label exactly that case's judged conditions, carry a snapshot of the condition texts it was
// labelled against that still equals the current text, address task parties only (unless it is deliberately about
// an outsider), and carry non-empty drafts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixtures } from '../bench/judge-calibration.ts';
import { loadVerticals, enumerate } from '../bench/verticals/index.ts';
import { judgeConditions } from '../bench/core/score.ts';
import type { BenchCase } from '../bench/core/types.ts';

const fixtures = await loadFixtures();
// load only the verticals that have fixtures, so a vertical still being written elsewhere can't break this test
const mods = await loadVerticals([...fixtures.keys()]);
const golden = new Map<string, BenchCase>(enumerate(mods, { splits: ['golden'] }).map((x) => [x.case.id, x.case]));
const all = [...fixtures].flatMap(([vertical, list]) => list.map((f, i) => ({ vertical, f, label: `${vertical}#${i} ${f.case_id} (${f.note})` })));

test('there are judge fixtures', () => {
  assert.ok(all.length > 0);
});

test('every fixture names an existing golden case of its own vertical', () => {
  const bad = all.filter(({ vertical, f }) => !golden.has(f.case_id) || !f.case_id.startsWith(`${vertical}/`) || !f.case_id.endsWith('/0')).map((x) => x.label);
  assert.deepEqual(bad, []);
});

test('expected keys exactly equal the case\'s judged condition ids', () => {
  const bad: string[] = [];
  for (const { f, label } of all) {
    const c = golden.get(f.case_id);
    if (!c) continue;
    const want = judgeConditions(c.checkpoints.at(-1)!.action!).map((x) => x.id).sort();
    const got = Object.keys(f.expected).sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) bad.push(`${label}: expected keys ${got.join(',')} but judged conditions are ${want.join(',')}`);
    for (const [k, v] of Object.entries(f.expected)) if (typeof v !== 'boolean') bad.push(`${label}: ${k} is not a boolean`);
  }
  assert.deepEqual(bad, []);
});

test('every fixture was labelled against the current condition texts (drift detection)', () => {
  // A reworded condition changes what the judge is asked, so the hand labels must be re-checked: update the
  // fixture's `texts` snapshot only after relabelling against the new text.
  const bad: string[] = [];
  for (const { f, label } of all) {
    const c = golden.get(f.case_id);
    if (!c) continue;
    const current = new Map(judgeConditions(c.checkpoints.at(-1)!.action!).map((x) => [x.id, x.text]));
    const snap = f.texts ?? {};
    const keys = Object.keys(snap).sort();
    const want = Object.keys(f.expected).sort();
    if (JSON.stringify(keys) !== JSON.stringify(want)) bad.push(`${label}: texts keys ${keys.join(',')} differ from expected keys ${want.join(',')}`);
    for (const [id, text] of Object.entries(snap)) {
      if (!current.has(id)) bad.push(`${label}: ${id} is no longer a judged condition`);
      else if (current.get(id) !== text) bad.push(`${label}: ${id} was reworded; relabel and update the snapshot\n      was: ${text}\n      now: ${current.get(id)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('recipients are task parties (unless the fixture is about an outsider)', () => {
  const bad: string[] = [];
  for (const { f, label } of all) {
    const c = golden.get(f.case_id);
    if (!c) continue;
    const parties = new Set(c.task.parties.filter((p) => p.role !== 'self').map((p) => p.address.toLowerCase()));
    const outsiders = f.drafts.filter((d) => !parties.has(d.to.toLowerCase()));
    if (f.outsider ? !outsiders.length : outsiders.length) bad.push(`${label}: ${f.outsider ? 'marked outsider but every recipient is a party' : `not a task party: ${outsiders.map((d) => d.to).join(', ')}`}`);
  }
  assert.deepEqual(bad, []);
});

test('every fixture has at least one draft and no empty bodies', () => {
  const bad = all.filter(({ f }) => !f.drafts.length || f.drafts.some((d) => !d.to.trim() || !d.body.trim())).map((x) => x.label);
  assert.deepEqual(bad, []);
});

test('every golden case with judged conditions has a strong, a flawed and an edge fixture', () => {
  const bad: string[] = [];
  for (const [id, c] of golden) {
    if (!judgeConditions(c.checkpoints.at(-1)!.action!).length) continue;
    const kinds = new Set(all.filter((x) => x.f.case_id === id).map((x) => x.f.kind));
    for (const k of ['strong', 'flawed', 'edge'] as const) if (!kinds.has(k)) bad.push(`${id}: no ${k} fixture`);
  }
  assert.deepEqual(bad, []);
});
