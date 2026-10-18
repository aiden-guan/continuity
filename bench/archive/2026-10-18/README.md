# Benchmark archive, 2026-10-18

Every run's `report.md`, `summary.json` and `meta.json`, plus its rows gzipped (`gzcat rows.jsonl.gz`).
Re-render a report by gunzipping `rows.jsonl` into a run folder and running `node bench/run.ts report <folder>`.

- `opt-final2-eval-all`: the headline, a held-out eval split with the final code (Continuity 68.8% vs Primitive 49.2%)
- `opt-final-eval-all`: the first held-out run (round-3 code)
- `opt-v0`…`opt-v4`: tuning rounds on the dev split
- `live-*`, `live-delivery`: runs over real Primitive email, and the delivery manifest
- `pn-budget12-dev-proc`: Primitive alone with 12 lookups
- `value-*`, `VALUE-RESULTS.md`: the value track (dependency depth, wakes, thread length, history)
- `realistic`: realistic-thread eval outputs
- `FINDINGS.md`: write-up
