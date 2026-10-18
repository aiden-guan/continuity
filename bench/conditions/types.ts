import type { VerticalSpec } from '../core/types.ts';
import type { Mailbox } from '../core/mailbox.ts';
import type { CallRecord, Llm } from '../core/llm.ts';

export interface ConditionCtx {
  llm: Llm;
  vertical: VerticalSpec;
  trial: number;
  cacheDir: string;
  /** Mock mode: no provider calls anywhere (Continuity falls back to the rule extractor). */
  mock: boolean;
  /** Ignore cached model output (still writes it), e.g. Continuity's extraction cache. */
  refresh?: boolean;
}

export interface Prepared {
  /** Tag the memory is wrapped in for the actor. */
  label: string;
  memory: string;
  /** Model calls made to build or fetch the memory: ingestion (per event) or retrieval (at decision time). */
  ingestion: CallRecord[];
  retrieval: CallRecord[];
  /** Set when the condition cannot run on this case (e.g. no Continuity domain pack for the vertical). */
  unsupported?: string;
  /** Diagnostics saved with the run (e.g. which messages were retrieved, tool calls made). */
  diag?: Record<string, unknown>;
  /** Continuity only: its own structured state, scored directly in the representation experiment. */
  engineState?: unknown;
}

export interface Condition {
  id: string;
  label: string;
  /** What the actor is given, for the README table. */
  description: string;
  /** Uses model calls before the actor (ingestion or retrieval). */
  usesModel: boolean;
  prepare(mb: Mailbox, ctx: ConditionCtx): Promise<Prepared>;
}
