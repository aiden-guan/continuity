// Portfolio demo: 200 home purchases, ~2,000 emails, one question at a time across all of them.
//
//   npm run demo:portfolio                 # build, run every beat, leave the server + UI running
//   npm run demo:portfolio -- --step       # one Enter per beat
//   npm run demo:portfolio -- --exit       # run and exit (CI)
//   npm run demo:portfolio -- --deals 500
//
// The deals are synthetic (generated from archetypes; see src/sim/portfolio.ts) but every email goes
// through the real pipeline (heuristic extractor, offline policy agent) into an offline SQLite file, which
// the server then serves. With ANTHROPIC_API_KEY set, the last beat asks Claude in plain language;
// everything else runs offline. Ported from samrocksnature's b615ab7.
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { SqliteBackend } from '../src/store/sqlite.ts';
import { DEFAULT_ORG } from '../src/engine/engine.ts';
import { fillPortfolio, TODAY } from '../src/sim/portfolio.ts';
import { estimateTokens } from '../src/compiler/compile.ts';

const { values: flags } = parseArgs({
  options: {
    step: { type: 'boolean', default: false },
    exit: { type: 'boolean', default: false },
    port: { type: 'string', default: process.env.PORT || '4100' },
    deals: { type: 'string', default: '200' },
  },
});
const PORT = flags.port!;
const API = `http://localhost:${PORT}`;
const DB = 'data/demo-portfolio.db';
const N = Number(flags.deals);
const C = { dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', green: '\x1b[32m', mag: '\x1b[35m', reset: '\x1b[0m' };

const waiting: (() => void)[] = [];
let earlyPresses = 0;
if (flags.step) {
  createInterface({ input: process.stdin }).on('line', () => {
    const wake = waiting.shift();
    if (wake) wake();
    else earlyPresses++;
  });
}
async function pause() {
  if (!flags.step) return;
  process.stdout.write(`${C.dim}  [enter] to continue…${C.reset}\n`);
  if (earlyPresses > 0) {
    earlyPresses--;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}
async function banner(text: string, color = C.cyan) {
  if (/^\d/.test(text)) await pause();
  console.log(`\n${color}${C.bold}━━━ ${text} ${'━'.repeat(Math.max(0, 70 - text.length))}${C.reset}`);
}
const say = (text: string) => console.log(`${C.dim}demo:${C.reset} ${text}`);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function api<J>(method: string, path: string, body?: unknown): Promise<J> {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await res.json();
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status} ${JSON.stringify(payload)}`), { status: res.status });
  return payload as J;
}
type Q = { columns: string[]; rows: unknown[][]; row_count: number };
const sql = (q: string) => api<Q>('POST', '/query', { sql: q });
function table(r: Q, max = 12) {
  const width = r.columns.map((c, i) => Math.min(60, Math.max(c.length, ...r.rows.slice(0, max).map((row) => String(row[i] ?? '').length))));
  console.log(`   ${C.bold}${r.columns.map((c, i) => c.padEnd(width[i])).join('  ')}${C.reset}`);
  for (const row of r.rows.slice(0, max)) console.log(`   ${row.map((v, i) => String(v ?? '').slice(0, 60).padEnd(width[i])).join('  ')}`);
  if (r.row_count > max) console.log(`   ${C.dim}… ${r.row_count - max} more${C.reset}`);
}

let server: ChildProcess | null = null;
process.on('exit', () => {
  if (server && server.exitCode === null) server.kill();
});

async function main() {
  try {
    await fetch(`${API}/api/health`);
    throw new Error(`port ${PORT} is already in use — stop the other server or pass --port`);
  } catch (e) {
    if ((e as Error).message.startsWith('port')) throw e;
  }
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  await banner(`Continuity portfolio — ${N} deals`);

  // generate straight into the offline SQLite file the server will open
  const began = Date.now();
  const backend = new SqliteBackend(DB);
  await backend.ensureOrg(DEFAULT_ORG);
  const deals = await fillPortfolio(backend, DEFAULT_ORG, N, 42, (i) => {
    if ((i + 1) % 25 === 0) process.stdout.write(`${C.dim}  … ${i + 1}/${N} deals${C.reset}\n`);
  });
  const emails = deals.reduce((sum, d) => sum + d.emails, 0);
  let transcriptTokens = 0;
  for (const d of deals) {
    const { store } = await backend.loadTask(DEFAULT_ORG, d.task_id);
    transcriptTokens += estimateTokens(store.eventsForTask(d.task_id).map((e) => `${e.subject}\n${e.body_text}`).join('\n'));
  }
  await backend.close();
  say(`generated ${N} home purchases, ${emails.toLocaleString()} emails, through the real pipeline in ${((Date.now() - began) / 1000).toFixed(1)} s ${C.dim}(synthetic deals from 9 archetypes; our agent's emails written by the policy agent)${C.reset}`);

  server = spawn(process.execPath, ['src/server.ts'], {
    env: { ...process.env, CONTINUITY_STORE: 'sqlite', CONTINUITY_DB: DB, PORT, CONTINUITY_TRANSPORT: 'sim', CONTINUITY_AUTH: 'off', CONTINUITY_EXTRACTOR: 'heuristic', CONTINUITY_ORG: DEFAULT_ORG },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await api('GET', '/api/health');
      break;
    } catch {
      await wait(100);
    }
  }
  await api('POST', '/sim/clock', { now: TODAY });

  await banner('1. The whole portfolio, one row per deal');
  table(await sql("SELECT outcome, count(*) AS deals, sum(next_actor = 'us') AS waiting_on_us, sum(failing_checks > 0) AS with_failing_checks FROM deals GROUP BY outcome ORDER BY deals DESC"));

  await banner('2. Monday morning: Signal scans every deal (nobody asked)', C.yellow);
  const run = await api<{ new: { severity: string; summary: string; rule: string }[] }>('POST', '/signals/run', {});
  const by = (k: 'rule' | 'severity') => Object.entries(run.new.reduce<Record<string, number>>((m, s) => ({ ...m, [s[k]]: (m[s[k]] ?? 0) + 1 }), {})).map(([x, n]) => `${x} ${n}`).join(', ');
  say(`${run.new.length} alerts — by severity: ${by('severity')} — by rule: ${by('rule')}`);
  for (const s of run.new.filter((x) => x.severity === 'high').slice(0, 5)) console.log(`   ${C.red}HIGH${C.reset}  ${s.summary.slice(0, 150)}`);
  say(`${C.dim}deals that already fell through raise nothing; accepted deals only for promises still owed${C.reset}`);

  await banner('3. "Which open deals will miss their closing deadline, and why?" — one SQL query');
  const lateSql = "SELECT d.alias, d.item, c.detail, t.source_event AS evidence FROM deals d JOIN deal_checks c USING (task_id) LEFT JOIN deal_terms t ON t.task_id = d.task_id AND t.term = 'closing.date' AND t.party = 'listing agent' WHERE d.outcome = 'open' AND c.check_id LIKE 'closing_deadline%' AND c.status = 'fail' ORDER BY d.alias";
  console.log(`   ${C.dim}${lateSql}${C.reset}`);
  const late = await sql(lateSql);
  table(late, 8);
  const gaps = await sql("SELECT d.alias, d.item, c.detail FROM deals d JOIN deal_checks c USING (task_id) WHERE d.outcome = 'open' AND c.check_id LIKE 'appraisal_gap%' AND c.status = 'fail' ORDER BY d.alias");
  say(`and ${gaps.row_count} open deal(s) have an appraisal below the price, e.g. ${gaps.rows[0]?.[0]} (${String(gaps.rows[0]?.[2] ?? '').slice(0, 70)}…)`);

  await banner('4. "Which open deals look like the ones that fell through?" — lookalikes');
  const target = String(gaps.rows[0]?.[0] ?? late.rows[0]?.[0]);
  const similar = await api<{ summary: string; similar: { alias: string; similarity: number; outcome: string }[] }>('GET', `/tasks/${encodeURIComponent(target)}/similar`);
  say(`${C.bold}${target}${C.reset}: ${similar.summary}`);
  console.log(`   ${C.dim}nearest: ${similar.similar.slice(0, 5).map((s) => `${s.alias} (${s.outcome}, ${s.similarity})`).join(', ')}${C.reset}`);
  const risky = await sql("SELECT d.alias, d.item, group_concat(c.label, '; ') AS failing FROM deals d JOIN deal_checks c USING (task_id) WHERE d.outcome = 'open' AND c.status = 'fail' GROUP BY d.task_id ORDER BY count(*) DESC, d.alias LIMIT 5");
  say('open deals with the most failing requirements:');
  table(risky, 5);

  await banner('5. What it costs an agent to know this', C.mag);
  const resultTokens = estimateTokens(JSON.stringify(late.rows)) + estimateTokens(JSON.stringify(gaps.rows));
  say(`reading every email to answer beats 3-4: ~${transcriptTokens.toLocaleString()} tokens (${emails.toLocaleString()} emails)`);
  say(`the two query results that answer them:   ~${resultTokens.toLocaleString()} tokens — ${Math.round(transcriptTokens / Math.max(1, resultTokens)).toLocaleString()}× less, every row cited to its source email`);

  await banner('6. Ask, in plain language', C.mag);
  const question = 'Which open deals are most at risk of not closing, and what should we do first on each?';
  say(`"${question}"`);
  if (!process.env.ANTHROPIC_API_KEY) {
    say(`${C.yellow}ANTHROPIC_API_KEY not set${C.reset} — Ask (Claude calling run_sql / get_timeline / find_similar / open_alerts with citations) is skipped. Everything above ran offline.`);
  } else {
    try {
      const answer = await api<{ answer: string; model: string; tool_calls: { name: string }[]; usage: { input_tokens: number; output_tokens: number } }>('POST', '/ask', { question });
      console.log(answer.answer.split('\n').map((l) => `   ${l}`).join('\n'));
      say(`${C.dim}${answer.model}: ${answer.tool_calls.length} tool call(s): ${answer.tool_calls.map((c) => c.name).join(', ')} — ${answer.usage.input_tokens.toLocaleString()} input / ${answer.usage.output_tokens.toLocaleString()} output tokens${C.reset}`);
    } catch (err) {
      say(`${C.red}Ask failed:${C.reset} ${(err as Error).message}`);
    }
  }

  await banner('Done', C.green);
  say(`inspect: ${API}/deals  ·  POST ${API}/query  ·  ${API}/  (observability UI)`);
  if (flags.exit) process.exit(0);
  say('server still running — Ctrl+C to stop.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
