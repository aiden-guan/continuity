# Benchmark results

Each run writes `bench/results/<name>/` containing `meta.json`, `rows.jsonl` (one row per case × condition × trial, including the agent output, every score and the usage), `report.md` and `summary.json`. Run folders are gitignored; commit one deliberately with `git add -f` when you publish its numbers.
