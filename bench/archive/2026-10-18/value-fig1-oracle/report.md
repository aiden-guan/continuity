# Continuity benchmark — value-fig1-oracle

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 84 · splits: undefined · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| oracle | 71.4% (60/84) [61.9%–81.0%] | 77.4% (65/84) | 84.5% (71/84) | 99.1% (427/431) | 0/165 · 0/165 | 78.8% (39) | 100.0% (420/420) | 0 | 340 | $0.00173 | $0.00000 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Vertical — cold-handoff success

| Vertical | oracle |
|---|---|
| procurement | 71.4% (84) |

## Capability — cold-handoff success

| Capability | oracle |
|---|---|
| cold_handoff | 70.8% (48) |
| cross_thread | 71.4% (84) |
| open_loops | 71.4% (84) |
| supersession | 71.4% (84) |

## Archetype — cold-handoff success

| Archetype | oracle |
|---|---|
| value_chain_d1 | 91.7% (12) |
| value_chain_d2 | 75.0% (12) |
| value_chain_d4 | 58.3% (12) |
| value_chain_d6 | 58.3% (12) |
| value_fanout_t2 | 75.0% (12) |
| value_fanout_t5 | 83.3% (12) |
| value_fanout_t8 | 58.3% (12) |
