// Debug helper: print the Continuity briefing for one case (served from the extraction cache when the
// case was already run with trial 1).   node bench/value/peek.ts value_chain_d4 2 [--upto e7]
import { parseArgs } from 'node:util';
import { valueModule } from './index.ts';
import { materialize } from '../core/mailbox.ts';
import { continuity } from '../conditions/continuity.ts';
import { DEFAULT_MODEL, Llm } from '../core/llm.ts';

process.env.CONTINUITY_EXTRACTOR_THINKING ??= 'off';
process.env.CONTINUITY_EXTRACT_ROUTE ??= 'skip-empty,outbound-plain-rules';
const { values: a, positionals } = parseArgs({ allowPositionals: true, options: { upto: { type: 'string', default: '' } } });
const [arch, v] = positionals;
const c = valueModule.archetypes.find((x) => x.id === arch)!.generate(Number(v));
const final = c.checkpoints.at(-1)!;
const mb = materialize(c, a.upto ? { ...final, after: a.upto } : final);
const cacheDir = `.scratch/bench-cache/${DEFAULT_MODEL}`;
const p = await continuity.prepare(mb, { llm: new Llm({ model: DEFAULT_MODEL, cacheDir }), vertical: valueModule.vertical, trial: 1, cacheDir, mock: false });
console.log(p.memory);
console.log(`--- ${p.ingestion.length} extraction calls (${p.ingestion.filter((x) => x.cached).length} from cache)`);
