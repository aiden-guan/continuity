// The benchmark's labels must never come from the system under test: scenario generators may not
// import engine, extractor, compiler or domain code (or anything else under src/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

test('scenario generators import nothing from src/', () => {
  const offenders: string[] = [];
  for (const f of files('bench/verticals')) {
    for (const m of readFileSync(f, 'utf8').matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]|import\(\s*['"`]([^'"`]+)/g)) {
      const spec = m[1] ?? m[2];
      if (/(^|\/)src\//.test(spec) || /\.\.\/\.\.\/\.\.\//.test(spec)) offenders.push(`${f} → ${spec}`);
      if (spec.startsWith('../../core/') && !/core\/(types|util)\.ts$/.test(spec)) offenders.push(`${f} → ${spec} (only core/types and core/util are allowed)`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the oracle, scorer and judge do not import Continuity code', () => {
  const offenders: string[] = [];
  for (const f of ['bench/core/types.ts', 'bench/core/score.ts', 'bench/core/normalize.ts', 'bench/core/judge.ts', 'bench/core/validate.ts', 'bench/core/mailbox.ts', 'bench/core/report.ts', 'bench/core/stats.ts']) {
    for (const m of readFileSync(f, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)) if (/src\//.test(m[1])) offenders.push(`${f} → ${m[1]}`);
  }
  assert.deepEqual(offenders, []);
});
