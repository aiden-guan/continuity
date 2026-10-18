# Continuity benchmark — value-fig1

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 3 · cases: 84 · splits: undefined · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| full-history | 42.9% (108/252) [36.9%–48.8%] | 63.1% (159/252) | 63.5% (160/252) | 91.5% (1183/1293) | 17/495 · 9/495 | 62.8% (240) | 93.2% (1089/1168) | 0 | 2243 | $0.00310 | $0.00000 |
| primitive-native | 41.7% (105/252) [35.7%–48.0%] | 60.7% (153/252) | 59.9% (151/252) | 61.3% (792/1293) | 31/495 · 20/495 | 62.1% (258) | 97.6% (765/784) | 0 | 2599 | $0.00475 | $0.00000 |
| continuity | 70.6% (178/252) [64.7%–76.2%] | 77.8% (196/252) | 82.9% (209/252) | 96.4% (1247/1293) | 16/495 · 18/495 | 73.4% (122) | 99.6% (1222/1227) | 0 | 1872 | $0.00225 | $0.00273 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Paired comparison vs Continuity

| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |
|---|---|---|---|---|
| full-history (n=84) | +27.8 pp [17.5, 37.7] | 32 / 6, p=0.000024 | 4.9 pp [2.7, 7.2] | -570 [-745, -410] |
| primitive-native (n=84) | +29.0 pp [20.2, 38.1] | 29 / 3, p=0.0000026 | 35.3 pp [31.9, 38.5] | -817 [-935, -700] |

## Vertical — cold-handoff success

| Vertical | full-history | primitive-native | continuity |
|---|---|---|---|
| procurement | 42.9% (252) | 41.7% (252) | 70.6% (252) |

## Capability — cold-handoff success

| Capability | full-history | primitive-native | continuity |
|---|---|---|---|
| cold_handoff | 57.6% (144) | 47.2% (144) | 75.0% (144) |
| cross_thread | 42.9% (252) | 41.7% (252) | 70.6% (252) |
| open_loops | 42.9% (252) | 41.7% (252) | 70.6% (252) |
| supersession | 42.9% (252) | 41.7% (252) | 70.6% (252) |

## Archetype — cold-handoff success

| Archetype | full-history | primitive-native | continuity |
|---|---|---|---|
| value_chain_d1 | 72.2% (36) | 63.9% (36) | 91.7% (36) |
| value_chain_d2 | 72.2% (36) | 41.7% (36) | 63.9% (36) |
| value_chain_d4 | 52.8% (36) | 47.2% (36) | 75.0% (36) |
| value_chain_d6 | 33.3% (36) | 36.1% (36) | 69.4% (36) |
| value_fanout_t2 | 19.4% (36) | 52.8% (36) | 63.9% (36) |
| value_fanout_t5 | 25.0% (36) | 11.1% (36) | 58.3% (36) |
| value_fanout_t8 | 25.0% (36) | 38.9% (36) | 72.2% (36) |

## Representation experiment (Continuity engine state, before any actor)

- **continuity**: current-state accuracy 98.1% (1269/1293); critical exact 90.9% (229/252); superseded errors 18; open-loop F1 71.6% (zombies 52); documents 87.4% (304/348).

## Ship gates (Continuity)

| Gate | Pass | Value |
|---|---|---|
| Current-state accuracy ≥ 95% | ✅ | 96.4% |
| Superseded-fact error rate ≤ 2% | ❌ | 3.2% |
| Open-loop precision ≥ 90% | ❌ | 67.0% |
| Open-loop recall ≥ 90% | ❌ | 81.2% |
| Provenance ≥ 95% | ✅ | 99.6% |
| Cold-handoff success ≥ 90% | ❌ | 70.6% |
| Zero safety violations | ✅ | 0 |
| Within 5 pp of full history on next-action success | ✅ | -14.7 pp behind |
| ≥ 60% fewer memory tokens than full history | ❌ | 16.5% |
