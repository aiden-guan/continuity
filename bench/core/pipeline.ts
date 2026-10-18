// One benchmark cell: (case, condition, trial) → prepared memory → fresh actor → scores → row.
import type { BenchCase, VerticalModule, AgentOutput } from './types.ts';
import { materialize, type Mailbox } from './mailbox.ts';
import { act, actorInput } from './actor.ts';
import { judge } from './judge.ts';
import { scoreAction, scoreState, judgeConditions, type ActionScore, type StateScore } from './score.ts';
import { Llm, estimateTokens, sumUsage, type CallRecord, type Request } from './llm.ts';
import type { Condition } from '../conditions/types.ts';

type Effort = NonNullable<Request['effort']>;

export interface Row {
  key: string; // case|condition|trial
  case_id: string;
  vertical: string;
  archetype: string;
  variant: number;
  split: string;
  backlog: number;
  /** Mail-messiness level of the case (0 = clean). */
  mess: number;
  capabilities: string[];
  condition: string;
  trial: number;
  model: string;
  unsupported?: string;
  error?: string;
  state?: StateScore;
  /** Continuity only: its engine state scored directly (representation experiment). */
  engine_state?: StateScore;
  action?: ActionScore;
  chs?: 0 | 1;
  usage: {
    memory_context_tokens_est: number;
    actor_prompt_tokens_est: number;
    actor_input_tokens: number;
    actor_output_tokens: number;
    ingestion: ReturnType<typeof sumUsage>;
    retrieval: ReturnType<typeof sumUsage>;
    actor_cost_usd: number;
    judge_cost_usd: number;
    /** What the system under test spends for this decision: ingestion + retrieval + actor (judge excluded). */
    system_cost_usd: number;
    task_events: number;
  };
  output?: AgentOutput;
  diag?: Record<string, unknown>;
  ms: number;
}

export async function runCell(opts: { mod: VerticalModule; c: BenchCase; condition: Condition; trial: number; llm: Llm; judgeLlm: Llm; cacheDir: string; mock: boolean; refresh?: boolean; effort?: Effort; mailbox?: (c: BenchCase) => Mailbox }): Promise<Row> {
  const { mod, c, condition, trial, llm, judgeLlm } = opts;
  const started = Date.now();
  // live runs hand in a mailbox backed by real Primitive mail (bench/live); otherwise the replay
  const mb = opts.mailbox ? opts.mailbox(c) : materialize(c);
  const base = {
    key: `${c.id}|${condition.id}|${trial}`, case_id: c.id, vertical: c.vertical, archetype: c.archetype, variant: c.variant, split: c.split,
    backlog: c.backlog ?? 0, mess: Number(c.params.mess ?? 0), capabilities: c.capabilities, condition: condition.id, trial, model: llm.model,
  };
  const emptyUsage = { memory_context_tokens_est: 0, actor_prompt_tokens_est: 0, actor_input_tokens: 0, actor_output_tokens: 0, ingestion: sumUsage([]), retrieval: sumUsage([]), actor_cost_usd: 0, judge_cost_usd: 0, system_cost_usd: 0, task_events: mb.messages.filter((m) => m.task).length };
  try {
    const ctx = { llm, vertical: mod.vertical, trial, cacheDir: opts.cacheDir, mock: opts.mock, refresh: opts.refresh };
    const prepared = await condition.prepare(mb, ctx);
    if (prepared.unsupported) return { ...base, unsupported: prepared.unsupported, usage: emptyUsage, ms: Date.now() - started };

    const actor = await act(llm, mod.vertical, mb, prepared.label, prepared.memory, trial, opts.effort);
    const state = scoreState(mod.vertical, mb, actor.output);
    const engine_state = prepared.engineState ? scoreState(mod.vertical, mb, prepared.engineState as AgentOutput) : undefined;
    const policy = mb.checkpoint.action!;
    const { verdicts, record: judgeRecord } = await judge(judgeLlm, mb, actor.output, judgeConditions(policy), trial);
    const action = scoreAction(mod.vertical, mb, actor.output, policy, verdicts);
    const ingestion = sumUsage(prepared.ingestion);
    const retrieval = sumUsage(prepared.retrieval);
    const actorCost = actor.record.cost_usd;
    return {
      ...base,
      state,
      engine_state,
      action,
      chs: action.nas && state.critical_ok ? 1 : 0,
      usage: {
        memory_context_tokens_est: estimateTokens(prepared.memory),
        actor_prompt_tokens_est: estimateTokens(actorInput(mb, prepared.label, prepared.memory)),
        actor_input_tokens: actor.input_tokens,
        actor_output_tokens: actor.output_tokens,
        ingestion,
        retrieval,
        actor_cost_usd: actorCost,
        judge_cost_usd: judgeRecord?.cost_usd ?? 0,
        system_cost_usd: ingestion.cost_usd + retrieval.cost_usd + (Number.isFinite(actorCost) ? actorCost : 0),
        task_events: emptyUsage.task_events,
      },
      output: actor.output,
      diag: { ...prepared.diag, judge: Object.fromEntries(verdicts) },
      ms: Date.now() - started,
    };
  } catch (e) {
    return { ...base, error: (e as Error).stack ?? String(e), usage: emptyUsage, ms: Date.now() - started };
  }
}

export type { CallRecord };
