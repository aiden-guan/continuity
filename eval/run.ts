// Eval runner.
//
//   npm run eval                 # offline: state accuracy, context size, offline-policy handoff
//   npm run eval -- --llm        # + LLM handoff under 3 context conditions (needs ANTHROPIC_API_KEY)
//   npm run eval -- --export     # write per-scenario agent inputs to eval/inputs/ (for manual/LLM runs)
//
// Other flags: --only a,b (scenario ids)  --extractor heuristic|llm  --k N (recent-N size)  --save <name>
//
// The cold-handoff comparison holds the actor model, system rules and output schema fixed and only
// changes what the agent is given:
//   compiled   — Continuity's compiled briefing, nothing else
//   recent-3   — task header + the 3 newest inbox messages, unrelated mail included (a naive inbox agent).
//                This is NOT Primitive-native retrieval (thread/search tools under a call budget), which
//                is not implemented.
//   transcript — task header + every task message (quoted reply history included) and attachment text
//   dequoted   — task header + every task message with quoted reply history removed, and attachment text
// Every baseline header states the same requirements and party authority that the compiled state carries.
// Not implemented: rolling summary, Primitive-native retrieval, semantic retrieval (Primitive
// /semantic-search is plan-gated and no substitute RAG is wired in). One run per condition is a smoke
// test, not a statistical result.
//
// Each run writes eval/results/runs/<timestamp>.json (gitignored); saved historical results are never
// overwritten. --save <name> also writes eval/results/<name>.json and refuses to replace an existing file.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { stripQuoted, heuristicExtractor } from '../src/extract/heuristic.ts';
import { SCENARIOS, Harness, procurementTask, A, grade } from './scenarios.ts';
import { estimateTokens } from '../src/compiler/compile.ts';
import { policyDecide, type Decision } from '../src/agent/policy.ts';
import { llmDecide, AGENT_SYSTEM } from '../src/agent/llm-agent.ts';
import { llmExtractor } from '../src/extract/llm.ts';

const { values: args } = parseArgs({
  options: {
    only: { type: 'string', default: '' },
    extractor: { type: 'string', default: 'heuristic' },
    llm: { type: 'boolean', default: false },
    export: { type: 'boolean', default: false },
    k: { type: 'string', default: '3' },
    save: { type: 'string', default: '' },
  },
});
const K = Number(args.k);

type Graded = { pass: boolean; fails: string[] };
type TaskEvent = ReturnType<Harness['store']['eventsForTask']>[number];

// One email as plain text, the way the baseline agents see it.
function emailText(e: TaskEvent, body: string) {
  const attachmentLine = e.attachments.length ? `\nAttachments: ${e.attachments.map((x) => x.filename).join(', ')}` : '';
  return `From: ${e.from}\nTo: ${e.to.join(', ')}\nDate: ${e.occurred_at}\nSubject: ${e.subject}${attachmentLine}\n\n${body}`;
}

// The task header every baseline gets: the goal, the parties and what each may set, and the requirements.
function taskHeader(h: Harness) {
  const t = h.task;
  const parties = t.participants
    .filter((p) => p.role !== 'self')
    .map((p) => `${p.label} <${p.address}> (may set: ${p.authority.join(', ') || 'nothing'})`)
    .join('; ');
  const requirements = t.requirements
    .map((r) => `${r.key.replace('requirement.', '')} = ${r.display}${r.hard ? ' (hard)' : ''}`)
    .join('; ');
  return `Task ${t.alias} goal: ${t.goal}\nYou are ${t.self_address}. Parties: ${parties}\nRequirements: ${requirements}`;
}

// Every task message with quoted history stripped, each followed by the text of its attachments.
function dequotedText(h: Harness) {
  const artifacts = h.artifacts();
  return h.store.eventsForTask(h.task.id)
    .map((e) => {
      const attachmentText = artifacts
        .filter((art) => art.event_id === e.id)
        .map((art) => `\n\n[attachment ${art.filename}]\n${art.text}`)
        .join('');
      return emailText(e, stripQuoted(e.body_text).trim()) + attachmentText;
    })
    .join('\n\n=====\n\n');
}

function baselineInputs(h: Harness) {
  const goal = taskHeader(h);
  // The naive inbox view mixes task mail with unrelated mail, ordered by time.
  const inbox = [...h.store.eventsForTask(h.task.id), ...h.store.unlinkedEvents()]
    .sort((x, y) => x.occurred_at.localeCompare(y.occurred_at));
  const newestInbound = inbox
    .filter((e) => e.direction === 'inbound')
    .slice(-K)
    .map((e) => emailText(e, e.body_text))
    .join('\n\n=====\n\n');
  return {
    goal,
    recent: `${goal}\n\n<recent_messages count="${K}">\n${newestInbound}\n</recent_messages>`,
    transcript: `${goal}\n\n<full_history>\n${h.transcriptText()}\n</full_history>`,
    dequoted: `${goal}\n\n<full_history quoted_replies="removed">\n${dequotedText(h)}\n</full_history>`,
  };
}

// The baselines get the same system rules, minus the sentence that describes a compiled briefing.
const BASELINE_SYSTEM = AGENT_SYSTEM.replace(
  'everything you know about this task is in the briefing below, compiled from the full communication history by a state engine.',
  'everything you know about this task is in the material below.',
);

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'messages', 'rationale', 'relied_on'],
  properties: {
    action: { type: 'string', enum: ['send', 'wait'] },
    messages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['to', 'subject', 'body'],
        properties: { to: { type: 'string' }, subject: { type: ['string', 'null'] }, body: { type: 'string' } },
      },
    },
    rationale: { type: 'string' },
    relied_on: { type: 'array', items: { type: 'string' } },
  },
};

// Ask the actor model for a decision given raw material (used for the non-compiled conditions).
async function llmDecideRaw(system: string, content: string): Promise<Decision> {
  const { anthropicClient } = await import('../src/anthropic.ts');
  const client = anthropicClient();
  const request = {
    model: process.env.CONTINUITY_AGENT_MODEL || 'claude-opus-5-5',
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: `${content}\n\nWhat do you do next? Respond with the JSON decision.` }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: DECISION_SCHEMA } },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
  const res = await client.beta.messages.create(request as never) as unknown as {
    content: { type: string; text?: string }[];
    usage?: unknown;
    model?: string;
  };
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { ...JSON.parse(text), usage: { model: res.model, ...(res.usage as object ?? {}) } };
}

const mark = (x: unknown) => (x == null ? ' — ' : (x as { pass: boolean }).pass ? 'PASS' : 'FAIL');

async function main() {
  const extractor = args.extractor === 'llm' ? llmExtractor() : heuristicExtractor;
  const rows: Record<string, unknown>[] = [];
  let assertionsPassed = 0;
  let assertionsTotal = 0;
  console.log(`\nPrimitive Continuity eval — ${SCENARIOS.length} scenarios · extractor=${extractor.name}${args.llm ? ' · + LLM handoff (3 conditions)' : ''}\n`);

  const only = args.only ? new Set(args.only.split(',')) : null;
  const selected = SCENARIOS.filter((sc) => !only || only.has(sc.id));

  for (const sc of selected) {
    const h = new Harness(structuredClone(procurementTask(A)), extractor);
    await h.ready;
    await sc.build(h);

    // State assertions; one that throws counts as a failure.
    const results = sc.assertions.map(([name, check]) => {
      let ok = false;
      try { ok = check(h); } catch { ok = false; }
      return { name, ok };
    });
    const passed = results.filter((r) => r.ok).length;
    assertionsPassed += passed;
    assertionsTotal += results.length;

    const ctx = h.context('eval-fresh-agent');
    const briefing = h.briefing('eval-fresh-agent');
    const base = baselineInputs(h);
    const sizes = {
      unit: 'estimated tokens (chars/4)',
      briefing: estimateTokens(briefing),
      transcript: estimateTokens(base.transcript),
      dequoted: estimateTokens(base.dequoted),
      recent: estimateTokens(base.recent),
      events: h.store.eventsForTask(h.task.id).length,
    };
    const row: Record<string, unknown> = {
      id: sc.id,
      category: sc.category,
      state: `${passed}/${results.length}`,
      failed: results.filter((r) => !r.ok).map((r) => r.name),
      sizes,
    };

    if (sc.rubric) {
      row.policy = grade(policyDecide(ctx), sc.rubric);
      if (args.llm) {
        const conditions: [string, () => Promise<Decision>][] = [
          ['compiled', () => llmDecide(briefing)],
          ['recent', () => llmDecideRaw(BASELINE_SYSTEM, base.recent)],
          ['transcript', () => llmDecideRaw(BASELINE_SYSTEM, base.transcript)],
          ['dequoted', () => llmDecideRaw(BASELINE_SYSTEM, base.dequoted)],
        ];
        for (const [name, decide] of conditions) {
          try {
            const decision = await decide();
            row[`llm_${name}`] = { ...grade(decision, sc.rubric), decision };
          } catch (e) {
            row[`llm_${name}`] = { pass: false, fails: [`error: ${(e as Error).message}`] };
          }
        }
      }
    }

    if (args.export) {
      mkdirSync('eval/inputs', { recursive: true });
      writeFileSync(`eval/inputs/${sc.id}.compiled.txt`, briefing);
      writeFileSync(`eval/inputs/${sc.id}.recent.txt`, base.recent);
      writeFileSync(`eval/inputs/${sc.id}.transcript.txt`, base.transcript);
    }
    rows.push(row);

    const llmPart = args.llm
      ? `  llm[compiled ${mark(row.llm_compiled)} | recent-${K} ${mark(row.llm_recent)} | transcript ${mark(row.llm_transcript)} | dequoted ${mark(row.llm_dequoted)}]`
      : '';
    const sizePart = `~tokens: briefing ${sizes.briefing} / transcript ${sizes.transcript} / dequoted ${sizes.dequoted} / recent-${K} ${sizes.recent}`;
    console.log(`${sc.id.padEnd(24)} ${sc.category.padEnd(24)} state ${String(row.state).padEnd(6)} policy-agent ${mark(row.policy)}${llmPart}   ${sizePart}`);
    for (const name of row.failed as string[]) console.log(`    ✗ state: ${name}`);
    for (const key of ['policy', 'llm_compiled', 'llm_recent', 'llm_transcript', 'llm_dequoted']) {
      for (const why of (row[key] as { fails?: string[] })?.fails ?? []) console.log(`    ✗ ${key}: ${why}`);
    }
  }

  const graded = rows.filter((r) => r.policy);
  const policyPassed = graded.filter((r) => (r.policy as Graded).pass).length;
  console.log(`\nState assertions: ${assertionsPassed}/${assertionsTotal}   Offline policy-agent handoffs: ${policyPassed}/${graded.length}`);

  const result = JSON.stringify({
    at: new Date().toISOString(),
    k: K,
    extractor: extractor.name,
    llm_handoff: args.llm,
    conditions: args.llm ? ['compiled', `recent-${K}`, 'transcript', 'dequoted'] : [],
    not_implemented: ['rolling summary', 'Primitive-native retrieval', 'semantic retrieval'],
    runs_per_condition: 1,
    rows,
  }, null, 1);

  mkdirSync('eval/results/runs', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = `eval/results/runs/${stamp}${args.extractor === 'llm' ? '-llm-extractor' : ''}${args.llm ? '-llm-handoff' : ''}.json`;
  writeFileSync(out, result);
  console.log(`wrote ${out}`);

  if (args.save) {
    const saved = `eval/results/${args.save}.json`;
    if (existsSync(saved)) throw new Error(`${saved} exists; saved results are never overwritten — choose another --save name`);
    writeFileSync(saved, result);
    console.log(`saved ${saved}`);
  }

  if (assertionsPassed !== assertionsTotal) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
