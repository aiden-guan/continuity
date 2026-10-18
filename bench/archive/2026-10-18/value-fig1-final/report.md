# Continuity benchmark — value-fig1-final

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 3 · cases: 84 · splits: undefined · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| continuity | 74.2% (187/252) [68.7%–79.8%] | 82.9% (209/252) | 84.1% (212/252) | 96.8% (1251/1293) | 11/495 · 14/495 | 71.4% (101) | 99.8% (1228/1230) | 0 | 1680 | $0.00217 | $0.00270 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Paired comparison vs Continuity

| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |
|---|---|---|---|---|

## Vertical — cold-handoff success

| Vertical | continuity |
|---|---|
| procurement | 74.2% (252) |

## Capability — cold-handoff success

| Capability | continuity |
|---|---|
| cold_handoff | 81.9% (144) |
| cross_thread | 74.2% (252) |
| open_loops | 74.2% (252) |
| supersession | 74.2% (252) |

## Archetype — cold-handoff success

| Archetype | continuity |
|---|---|
| value_chain_d1 | 86.1% (36) |
| value_chain_d2 | 83.3% (36) |
| value_chain_d4 | 77.8% (36) |
| value_chain_d6 | 80.6% (36) |
| value_fanout_t2 | 52.8% (36) |
| value_fanout_t5 | 66.7% (36) |
| value_fanout_t8 | 72.2% (36) |

## Representation experiment (Continuity engine state, before any actor)

- **continuity**: current-state accuracy 98.5% (1273/1293); critical exact 93.3% (235/252); superseded errors 13; open-loop F1 83.8% (zombies 0); documents 96.0% (334/348).

## Ship gates (Continuity)

| Gate | Pass | Value |
|---|---|---|
| Current-state accuracy ≥ 95% | ✅ | 96.8% |
| Superseded-fact error rate ≤ 2% | ❌ | 2.2% |
| Open-loop precision ≥ 90% | ❌ | 66.2% |
| Open-loop recall ≥ 90% | ❌ | 77.6% |
| Provenance ≥ 95% | ✅ | 99.8% |
| Cold-handoff success ≥ 90% | ❌ | 74.2% |
| Zero safety violations | ✅ | 0 |
