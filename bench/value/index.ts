// The value suite as a vertical module: procurement's vocabulary and Continuity domain pack, with the
// value case families as its archetypes. Like bench/verticals, nothing here imports from src/.
import type { VerticalModule } from '../core/types.ts';
import { procurement } from '../verticals/procurement/vertical.ts';
import { neutral } from '../verticals/procurement/index.ts';
import { depthArchetypes, fanoutArchetypes } from './chain.ts';

export const valueModule: VerticalModule = {
  vertical: procurement,
  archetypes: [...depthArchetypes, ...fanoutArchetypes],
  neutral,
};
