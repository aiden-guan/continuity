// Generator self-check for one vertical: builds variants 0..20 of every archetype, validates them, and
// prints size statistics plus (with --show <archetype> [variant]) one full case. Makes no model calls.
//   node bench/core/check-vertical.ts procurement [--show correction 3]
import type { VerticalModule } from './types.ts';
import { validateCase } from './validate.ts';
import { Rand, seedOf } from './util.ts';

const [id, flag, showArch, showVariant] = process.argv.slice(2);
const mod = (await import(`../verticals/${id}/index.ts`)) as VerticalModule;
let errors = 0;
for (const a of mod.archetypes) {
  const sizes: number[] = [];
  const texts = new Set<string>();
  for (let v = 0; v <= 20; v++) {
    const c = a.generate(v);
    const problems = validateCase(c, mod.vertical);
    if (c.id !== `${id}/${a.id}/${v}`) problems.push(`${c.id}: id should be ${id}/${a.id}/${v}`);
    if (c.split !== (v === 0 ? 'golden' : v <= 10 ? 'dev' : 'eval')) problems.push(`${c.id}: wrong split`);
    const again = JSON.stringify(a.generate(v));
    if (again !== JSON.stringify(c)) problems.push(`${c.id}: not deterministic`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    errors += problems.length;
    sizes.push(c.events.length);
    texts.add(c.events.find((e) => e.key === c.trigger)!.body);
    for (let i = 0; i < 3; i++) mod.neutral(c, i, new Rand(seedOf(c.id, i)));
  }
  console.log(`${a.id.padEnd(22)} ${a.priority} events ${Math.min(...sizes)}–${Math.max(...sizes)}  distinct trigger bodies ${texts.size}/21  [${a.capabilities.join(', ')}]`);
}
if (flag === '--show') {
  const a = mod.archetypes.find((x) => x.id === showArch)!;
  const c = a.generate(Number(showVariant ?? 0));
  for (const e of c.events) console.log(`--- ${e.key}${e.background ? ' (background)' : ''} ${e.at} ${e.direction} ${e.from} → ${e.to.join(', ')} | ${e.subject}${e.replyTo ? ` (re ${e.replyTo})` : ''}\n${e.body}${(e.attachments ?? []).map((x) => `\n[${x.filename}]\n${x.lines.join('\n')}`).join('')}`);
  console.log(JSON.stringify(c.checkpoints, null, 1));
}
console.log(errors ? `\n${errors} problem(s)` : '\nall cases valid');
process.exitCode = errors ? 1 : 0;
