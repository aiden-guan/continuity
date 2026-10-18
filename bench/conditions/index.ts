import type { Condition } from './types.ts';
import { agentNotes, fullHistory, oracle, retrieval, rollingSummary } from './baselines.ts';
import { primitiveNative } from './primitive.ts';
import { continuity, continuityRules } from './continuity.ts';
import { hindsight, mem0, zep } from './memory-providers.ts';

/** In report order: competitors first, then Continuity, then calibration rows. */
export const CONDITIONS: Condition[] = [primitiveNative, retrieval, rollingSummary, agentNotes, mem0, zep, hindsight, fullHistory, continuity, continuityRules, oracle];

export const conditionById = (id: string) => {
  const c = CONDITIONS.find((x) => x.id === id);
  if (!c) throw new Error(`unknown condition ${id} (known: ${CONDITIONS.map((x) => x.id).join(', ')})`);
  return c;
};

export type { Condition };
