# Value benchmark: results (2026-10-18)

Report with charts: https://claude.ai/artifact/CzDW2qWjaS3fwrCDZsBgmf (private to Aiden until shared).
Design and fairness rules: [README.md](README.md). Engine: the optimization track's Round 2 snapshot (`af69a53`);
four of the defects below were fixed there afterwards, so these numbers predate those fixes.

All runs: `claude-haiku-5-5` for every condition and the judge; held-out variants 11–22 frozen in `manifest.json`;
95% intervals are bootstrap over cases; p-values are sign-flip permutation tests on per-case differences.

## Figure 1: handoff success vs dependency depth and thread fan-out (84 cases × 3 trials)

| | Continuity | Primitive-only | Full history | True state given |
|---|---|---|---|---|
| All 84 cases | **70.6%** [63.9–77.4] | 41.7% [33.3–50.0] | 42.9% [33.7–52.0] | 71.4% (1 trial) |
| Depth 1 / 2 / 4 / 6 | 92 / 64 / 75 / 69 | 64 / 42 / 47 / 36 | 72 / 72 / 53 / 33 | 92 / 75 / 58 / 58 |
| Threads 2 / 5 / 8 | 64 / 58 / 72 | 53 / 11 / 39 | 19 / 25 / 25 | 75 / 83 / 58 |
| Critical state right (code only, no judge) | 82.9% | 59.9% | 63.5% | |

- Continuity vs Primitive-only: **+29.0 pp [20.2, 38.1], p < 0.001** (45 cases won, 9 lost).
- Continuity vs full history: **+27.8 pp [17.9, 38.1], p < 0.001** (49 / 13). Tied at depth 1–2; +36 pp at depth 6 (p = 0.031).
- Judge-free critical state: +23.0 pp vs Primitive-only, +19.4 pp vs full history (both p < 0.001).
- The "true state given" condition is not a ceiling on held-out cases (90.5% on dev): its failures are decisions and
  strict grading. Graders were not changed after held-out results were read.

## Figure 2: lifetime cost (cold-cache prices)

- Re-waking on the same state: Continuity one-time $0.0078 + $0.0025 per wake; Primitive-only $0.0050 per wake;
  full history $0.0033. Cost per correct decision: Continuity is the most expensive at 1 wake ($0.0146 vs $0.0121
  and $0.0076), breaks even after ~3 wakes vs Primitive-only and ~10 vs full history, and costs $0.0038 at 50
  wakes (3.2× less than Primitive-only, 2× less than full history).
- A fresh wake on every inbound email (6 depth-6 threads, ~13 wakes each): Continuity $0.039 per thread, Primitive-only
  $0.052, rolling summary $0.056, full history $0.035.
- Thread length (+0 / +40 / +120 state-neutral emails, depth-4 cases): context per decision stays flat for Continuity
  (1.9K → 1.6K tokens) while full history grows 2.4K → 7.1K and Primitive-only's reads 2.6K → 6.8K. Continuity's
  per-wake cost stays $0.0025; its one-time cost grows $0.0078 → $0.0362 (about $0.00024 per extra email).
  Success: Continuity 75 / 67 / 58, Primitive-only 47 / 33 / 33, full history 53 / 33 / 58 (1 trial at +40/+120).

## Figure 3: history questions (24 cases × 2 trials)

All three right: full history 95.8%, Continuity briefing 95.8%, Continuity + as-of replay 95.8%, rolling summary
87.5%, model-kept latest-state notes 62.5%. Continuity vs latest-state notes +33.3 pp [14.6, 50.0], p = 0.003;
vs full history a tie. The as-of replay tool changed no answer on these short threads.

## Where Continuity loses

Short histories (tied with full history at 1–2 changes); a single decision (1.6× full history's cost, ~3× Primitive-only's
tokens); long threads with few wakes (break-even 8 wakes vs Primitive-only at +120 emails); committing while blocked in
3 of 252 runs; two-thread fan-out (more dead facts than Primitive-only); accuracy lost between engine state and the
agent's report (budget line, now fixed upstream).

## Raw data

`bench/results/value-fig1/rows.jsonl` (756 rows), `value-fig1-oracle/`, `value-wakes/wakes.jsonl`, `value-length/rows.jsonl`,
`value-history/history.jsonl`. Results folders are gitignored; force-add a folder to publish it.
