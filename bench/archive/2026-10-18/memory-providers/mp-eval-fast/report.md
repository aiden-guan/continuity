# Continuity benchmark — mp-eval-fast

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 130 · splits: eval · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| primitive-native | 41.5% (54/130) [33.1%–50.0%] | 69.2% (90/130) | 58.5% (76/130) | 83.5% (761/911) | 12/140 · 5/89 | 34.1% (39) | 98.6% (685/695) | 0 | 1261 | $0.00429 | $0.00000 |
| continuity | 70.8% (92/130) [63.1%–78.5%] | 80.0% (104/130) | 86.9% (113/130) | 96.9% (883/911) | 2/140 · 1/89 | 39.5% (33) | 100.0% (815/815) | 0 | 1572 | $0.00270 | $0.00174 |
| zep-graphiti | 48.5% (63/130) [40.0%–56.9%] | 70.0% (91/130) | 64.6% (84/130) | 91.9% (837/911) | 9/140 · 8/89 | 34.9% (46) | 98.4% (757/769) | 0 | 1881 | $0.00274 | $0.0575 |
| mem0 | 55.4% (72/130) [46.9%–63.8%] | 76.9% (100/130) | 66.9% (87/130) | 90.5% (824/911) | 6/140 · 8/89 | 35.9% (42) | 98.2% (744/758) | 0 | 764 | $0.00305 | $0.0221 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Paired comparison vs Continuity

| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |
|---|---|---|---|---|
| primitive-native (n=130) | +29.2 pp [18.5, 40.0] | 49 / 11, p=7.6e-7 | 12.2 pp [9.1, 15.4] | 256 [147, 366] |
| zep-graphiti (n=130) | +22.3 pp [12.3, 32.3] | 40 / 11, p=0.000057 | 5.2 pp [3.2, 7.3] | -124 [-185, -62] |
| mem0 (n=130) | +15.4 pp [6.2, 24.6] | 31 / 11, p=0.0029 | 6.6 pp [3.8, 9.7] | 771 [700, 844] |

## Vertical — cold-handoff success

| Vertical | primitive-native | continuity | zep-graphiti | mem0 |
|---|---|---|---|---|
| finance | 23.1% (26) | 65.4% (26) | 38.5% (26) | 38.5% (26) |
| freight | 19.2% (26) | 65.4% (26) | 23.1% (26) | 38.5% (26) |
| hotel | 61.5% (26) | 69.2% (26) | 65.4% (26) | 69.2% (26) |
| legal | 53.8% (26) | 80.8% (26) | 57.7% (26) | 69.2% (26) |
| procurement | 50.0% (26) | 73.1% (26) | 57.7% (26) | 61.5% (26) |

## Capability — cold-handoff success

| Capability | primitive-native | continuity | zep-graphiti | mem0 |
|---|---|---|---|---|
| authority | 40.0% (10) | 80.0% (10) | 70.0% (10) | 70.0% (10) |
| cold_handoff | 45.0% (20) | 70.0% (20) | 20.0% (20) | 30.0% (20) |
| competing_offers | 40.0% (10) | 70.0% (10) | 40.0% (10) | 50.0% (10) |
| conflict_vs_supersession | 40.0% (10) | 80.0% (10) | 80.0% (10) | 70.0% (10) |
| cross_thread | 40.0% (30) | 66.7% (30) | 33.3% (30) | 36.7% (30) |
| document_validity | 36.5% (52) | 61.5% (52) | 30.8% (52) | 42.3% (52) |
| injection | 50.0% (10) | 80.0% (10) | 50.0% (10) | 80.0% (10) |
| late_evidence | 30.0% (10) | 70.0% (10) | 20.0% (10) | 30.0% (10) |
| lifecycle | 60.0% (10) | 100.0% (10) | 80.0% (10) | 100.0% (10) |
| open_loops | 47.5% (40) | 72.5% (40) | 37.5% (40) | 40.0% (40) |
| partial_fulfilment | 50.0% (10) | 60.0% (10) | 40.0% (10) | 50.0% (10) |
| supersession | 40.3% (62) | 62.9% (62) | 30.6% (62) | 43.5% (62) |

## Archetype — cold-handoff success

| Archetype | primitive-native | continuity | zep-graphiti | mem0 |
|---|---|---|---|---|
| cold_handoff | 40.0% (10) | 50.0% (10) | 20.0% (10) | 30.0% (10) |
| competing_offers | 40.0% (10) | 70.0% (10) | 40.0% (10) | 50.0% (10) |
| contradiction | 40.0% (10) | 80.0% (10) | 80.0% (10) | 70.0% (10) |
| correction | 50.0% (10) | 90.0% (10) | 20.0% (10) | 30.0% (10) |
| cross_thread | 30.0% (10) | 60.0% (10) | 60.0% (10) | 50.0% (10) |
| injection | 50.0% (10) | 80.0% (10) | 50.0% (10) | 80.0% (10) |
| late_evidence | 30.0% (10) | 70.0% (10) | 20.0% (10) | 30.0% (10) |
| partial_fulfilment | 50.0% (10) | 60.0% (10) | 40.0% (10) | 50.0% (10) |
| stale_document | 10.0% (10) | 40.0% (10) | 20.0% (10) | 40.0% (10) |
| supersession_chain | 50.0% (10) | 50.0% (10) | 60.0% (10) | 70.0% (10) |
| unanswered_subquestion | 50.0% (10) | 90.0% (10) | 70.0% (10) | 50.0% (10) |
| unauthorized_change | 40.0% (10) | 80.0% (10) | 70.0% (10) | 70.0% (10) |
| withdrawn_offer | 60.0% (10) | 100.0% (10) | 80.0% (10) | 100.0% (10) |

## Representation experiment (Continuity engine state, before any actor)

- **continuity**: current-state accuracy 97.3% (886/911); critical exact 86.9% (113/130); superseded errors 4; open-loop F1 60.7% (zombies 13); documents 92.0% (126/137).

## Ship gates (Continuity)

| Gate | Pass | Value |
|---|---|---|
| Current-state accuracy ≥ 95% | ✅ | 96.9% |
| Superseded-fact error rate ≤ 2% | ✅ | 1.4% |
| Open-loop precision ≥ 90% | ❌ | 26.5% |
| Open-loop recall ≥ 90% | ❌ | 77.6% |
| Provenance ≥ 95% | ✅ | 100.0% |
| Cold-handoff success ≥ 90% | ❌ | 70.8% |
| Zero safety violations | ✅ | 0 |
