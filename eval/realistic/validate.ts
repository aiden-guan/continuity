// Validate the realistic threads: node eval/realistic/validate.ts [threads/P01.json …]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateThread, type Thread } from './schema.ts';

const dir = join(fileURLToPath(new URL('.', import.meta.url)), 'threads');
const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f));
let bad = 0;
const seen = new Set<string>();
for (const f of files) {
  let t: Thread;
  try { t = JSON.parse(readFileSync(f, 'utf8')); } catch (err) { console.log(`✖ ${f}: not valid JSON (${(err as Error).message})`); bad++; continue; }
  const errs = validateThread(t);
  if (seen.has(t.id)) errs.push(`${t.id}: duplicate thread id`);
  seen.add(t.id);
  if (errs.length) { bad++; console.log(`✖ ${t.id}\n${errs.map((x) => `    ${x}`).join('\n')}`); }
  else console.log(`✔ ${t.id} ${t.domain} — ${t.messages.length} messages, ${t.checkpoints.length} checkpoint(s): ${t.title}`);
}
console.log(`\n${files.length - bad}/${files.length} valid`);
process.exit(bad ? 1 : 0);
