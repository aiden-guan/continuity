# Continuity benchmark — value-dev1c

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 21 · splits: undefined · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| full-history | 47.6% (10/21) [28.6%–66.7%] | 61.9% (13/21) | 81.0% (17/21) | 94.4% (101/107) | 0/48 · 1/48 | 58.8% (17) | 94.9% (94/99) | 0 | 2334 | $0.00303 | $0.00000 |
| primitive-native | 28.6% (6/21) [9.5%–47.6%] | 38.1% (8/21) | 61.9% (13/21) | 63.6% (68/107) | 5/48 · 4/48 | 51.2% (18) | 100.0% (66/66) | 0 | 2462 | $0.00489 | $0.00000 |
| oracle | 85.7% (18/21) [71.4%–100.0%] | 85.7% (18/21) | 100.0% (21/21) | 100.0% (107/107) | 0/48 · 0/48 | 82.1% (7) | 100.0% (105/105) | 0 | 358 | $0.00165 | $0.00000 |
| continuity | 61.9% (13/21) [42.9%–81.0%] | 66.7% (14/21) | 85.7% (18/21) | 96.3% (103/107) | 0/48 · 1/48 | 61.8% (9) | 100.0% (101/101) | 0 | 1861 | $0.00234 | $0.00303 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Paired comparison vs Continuity

| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |
|---|---|---|---|---|
| full-history (n=21) | +14.3 pp [-14.3, 42.9] | 6 / 3, p=0.51 | 2.1 pp [-1.4, 5.7] | -437 [-736, -167] |
| primitive-native (n=21) | +33.3 pp [4.8, 61.9] | 9 / 2, p=0.065 | 33.0 pp [26.3, 39.7] | -672 [-1020, -358] |

## Vertical — cold-handoff success

| Vertical | full-history | primitive-native | oracle | continuity |
|---|---|---|---|---|
| procurement | 47.6% (21) | 28.6% (21) | 85.7% (21) | 61.9% (21) |

## Capability — cold-handoff success

| Capability | full-history | primitive-native | oracle | continuity |
|---|---|---|---|---|
| cold_handoff | 66.7% (12) | 41.7% (12) | 91.7% (12) | 66.7% (12) |
| cross_thread | 47.6% (21) | 28.6% (21) | 85.7% (21) | 61.9% (21) |
| open_loops | 47.6% (21) | 28.6% (21) | 85.7% (21) | 61.9% (21) |
| supersession | 47.6% (21) | 28.6% (21) | 85.7% (21) | 61.9% (21) |

## Archetype — cold-handoff success

| Archetype | full-history | primitive-native | oracle | continuity |
|---|---|---|---|---|
| value_chain_d1 | 66.7% (3) | 33.3% (3) | 66.7% (3) | 66.7% (3) |
| value_chain_d2 | 66.7% (3) | 33.3% (3) | 100.0% (3) | 100.0% (3) |
| value_chain_d4 | 66.7% (3) | 66.7% (3) | 100.0% (3) | 33.3% (3) |
| value_chain_d6 | 66.7% (3) | 33.3% (3) | 100.0% (3) | 66.7% (3) |
| value_fanout_t2 | 33.3% (3) | 33.3% (3) | 66.7% (3) | 33.3% (3) |
| value_fanout_t5 | 0.0% (3) | 0.0% (3) | 66.7% (3) | 66.7% (3) |
| value_fanout_t8 | 33.3% (3) | 0.0% (3) | 100.0% (3) | 66.7% (3) |

## Representation experiment (Continuity engine state, before any actor)

- **continuity**: current-state accuracy 98.1% (105/107); critical exact 95.2% (20/21); superseded errors 0; open-loop F1 70.5% (zombies 6); documents 100.0% (31/31).

## Ship gates (Continuity)

| Gate | Pass | Value |
|---|---|---|
| Current-state accuracy ≥ 95% | ✅ | 96.3% |
| Superseded-fact error rate ≤ 2% | ✅ | 0.0% |
| Open-loop precision ≥ 90% | ❌ | 58.3% |
| Open-loop recall ≥ 90% | ❌ | 65.6% |
| Provenance ≥ 95% | ✅ | 100.0% |
| Cold-handoff success ≥ 90% | ❌ | 61.9% |
| Zero safety violations | ✅ | 0 |
| Within 5 pp of full history on next-action success | ✅ | -4.8 pp behind |
| ≥ 60% fewer memory tokens than full history | ❌ | 20.3% |
