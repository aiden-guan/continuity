// Paired statistics. Every condition is scored on the same cases, so comparisons are paired:
//  - bootstrap over cases for the difference in a mean (accuracy, tokens, cost) with a 95% CI;
//  - exact McNemar test on discordant pairs for binary outcomes (NAS, CHS).
import { rng } from './util.ts';

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** 95% percentile-bootstrap CI for mean(a - b) over paired samples (cluster = case). */
export function pairedBootstrap(a: number[], b: number[], iterations = 10_000, seed = 7): { diff: number; lo: number; hi: number } {
  if (a.length !== b.length) throw new Error('paired samples must align');
  const n = a.length;
  const d = a.map((x, i) => x - b[i]);
  const r = rng(seed);
  const stats: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(r() * n)];
    stats.push(s / n);
  }
  stats.sort((x, y) => x - y);
  return { diff: mean(d), lo: quantile(stats, 0.025), hi: quantile(stats, 0.975) };
}

/** 95% bootstrap CI for a single mean. */
export function bootstrapMean(a: number[], iterations = 10_000, seed = 11): { mean: number; lo: number; hi: number } {
  const zeros = a.map(() => 0);
  const r = pairedBootstrap(a, zeros, iterations, seed);
  return { mean: r.diff, lo: r.lo, hi: r.hi };
}

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** Exact two-sided McNemar test. b = cases A passed and B failed; c = the reverse. */
export function mcnemar(a: number[], b: number[]): { b: number; c: number; p: number } {
  let nb = 0;
  let nc = 0;
  a.forEach((x, i) => {
    if (x && !b[i]) nb++;
    if (!x && b[i]) nc++;
  });
  const n = nb + nc;
  if (n === 0) return { b: 0, c: 0, p: 1 };
  const k = Math.min(nb, nc);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return { b: nb, c: nc, p: Math.min(1, 2 * tail) };
}
