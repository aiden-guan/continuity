# Continuity benchmark — mp-smoke

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 2 · splits: golden · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hindsight | 50.0% (1/2) [0.0%–100.0%] | 50.0% (1/2) | 100.0% (2/2) | 100.0% (8/8) | 0/4 · 0/3 | 50.0% (1) | 100.0% (5/5) | 0 | 711 | $0.00152 | $0.00439 |
| mem0 | 100.0% (2/2) [100.0%–100.0%] | 100.0% (2/2) | 100.0% (2/2) | 100.0% (8/8) | 0/4 · 0/3 | 66.7% (0) | 100.0% (5/5) | 0 | 366 | $0.00119 | $0.00433 |
| zep-graphiti | 50.0% (1/2) [0.0%–100.0%] | 50.0% (1/2) | 100.0% (2/2) | 100.0% (8/8) | 0/4 · 0/3 | 66.7% (0) | 100.0% (5/5) | 0 | 1182 | $0.00136 | $0.00623 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Vertical — cold-handoff success

| Vertical | hindsight | mem0 | zep-graphiti |
|---|---|---|---|
| procurement | 50.0% (2) | 100.0% (2) | 50.0% (2) |

## Capability — cold-handoff success

| Capability | hindsight | mem0 | zep-graphiti |
|---|---|---|---|
| cold_handoff | 0.0% (1) | 100.0% (1) | 0.0% (1) |
| cross_thread | 0.0% (1) | 100.0% (1) | 0.0% (1) |
| document_validity | 0.0% (1) | 100.0% (1) | 0.0% (1) |
| lifecycle | 100.0% (1) | 100.0% (1) | 100.0% (1) |
| open_loops | 0.0% (1) | 100.0% (1) | 0.0% (1) |
| supersession | 50.0% (2) | 100.0% (2) | 50.0% (2) |

## Archetype — cold-handoff success

| Archetype | hindsight | mem0 | zep-graphiti |
|---|---|---|---|
| correction | 0.0% (1) | 100.0% (1) | 0.0% (1) |
| withdrawn_offer | 100.0% (1) | 100.0% (1) | 100.0% (1) |
