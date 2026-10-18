// Registry of vertical modules and case enumeration.
import { existsSync } from 'node:fs';
import type { BenchCase, Split, VerticalModule } from '../core/types.ts';

export const VERTICAL_IDS = ['procurement', 'freight', 'hotel', 'finance', 'legal'] as const;

export async function loadVerticals(only?: string[]): Promise<VerticalModule[]> {
  const out: VerticalModule[] = [];
  for (const id of VERTICAL_IDS) {
    if (only?.length && !only.includes(id)) continue;
    // a vertical that has not been written yet is skipped; a broken one fails loudly
    if (!existsSync(new URL(`./${id}/index.ts`, import.meta.url))) continue;
    out.push((await import(`./${id}/index.ts`)) as VerticalModule);
  }
  return out;
}

export const SPLIT_VARIANTS: Record<Split, number[]> = {
  golden: [0],
  dev: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  eval: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
};

export interface CaseFilter { splits?: Split[]; archetypes?: string[]; variants?: number[]; priority?: 'P0' | 'P1' }

export function enumerate(mods: VerticalModule[], f: CaseFilter = {}): { mod: VerticalModule; case: BenchCase }[] {
  const out: { mod: VerticalModule; case: BenchCase }[] = [];
  const variants = f.variants ?? (f.splits ?? ['golden', 'dev', 'eval']).flatMap((s) => SPLIT_VARIANTS[s]);
  for (const mod of mods) {
    for (const a of mod.archetypes) {
      if (f.archetypes?.length && !f.archetypes.includes(a.id)) continue;
      if (f.priority && a.priority !== f.priority) continue;
      for (const v of variants) out.push({ mod, case: a.generate(v) });
    }
  }
  return out;
}
