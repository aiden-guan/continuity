// Which eval cases differ from bench/value/manifest.json (e.g. after a generator fix). Prints one id per line.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { valueModule } from './index.ts';

const manifest = JSON.parse(readFileSync('bench/value/manifest.json', 'utf8')) as { cases: Record<string, string> };
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
for (const id of Object.keys(manifest.cases)) {
  const [, arch, v] = id.split('/');
  const c = valueModule.archetypes.find((a) => a.id === arch)!.generate(Number(v));
  if (hash(c) !== manifest.cases[id]) console.log(id);
}
