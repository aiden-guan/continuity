# Continuity benchmark — opt-v1-dev-proc

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 130 · splits: dev · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| continuity | 76.9% (100/130) [69.2%–83.8%] | 81.5% (106/130) | 89.2% (116/130) | 95.3% (470/493) | 2/129 · 10/90 | 40.9% (35) | 100.0% (423/423) | 0 | 1254 | $0.00183 | $0.00098 |
| primitive-native | 63.8% (83/130) [55.4%–72.3%] | 80.8% (105/130) | 74.6% (97/130) | 86.4% (426/493) | 5/129 · 4/90 | 39.5% (45) | 99.7% (383/384) | 0 | 892 | $0.00309 | $0.00000 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Paired comparison vs Continuity

| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |
|---|---|---|---|---|
| primitive-native (n=130) | +13.1 pp [4.6, 21.5] | 25 / 8, p=0.0046 | 9.1 pp [5.3, 13.2] | 221 [133, 305] |

## Vertical — cold-handoff success

| Vertical | continuity | primitive-native |
|---|---|---|
| procurement | 76.9% (130) | 63.8% (130) |

## Capability — cold-handoff success

| Capability | continuity | primitive-native |
|---|---|---|
| authority | 100.0% (10) | 80.0% (10) |
| cold_handoff | 90.0% (20) | 80.0% (20) |
| competing_offers | 80.0% (10) | 70.0% (10) |
| conflict_vs_supersession | 20.0% (10) | 0.0% (10) |
| cross_thread | 93.3% (30) | 76.7% (30) |
| document_validity | 72.0% (50) | 58.0% (50) |
| injection | 100.0% (10) | 40.0% (10) |
| late_evidence | 90.0% (10) | 40.0% (10) |
| lifecycle | 100.0% (10) | 100.0% (10) |
| open_loops | 80.0% (40) | 85.0% (40) |
| partial_fulfilment | 70.0% (10) | 100.0% (10) |
| supersession | 75.7% (70) | 70.0% (70) |

## Archetype — cold-handoff success

| Archetype | continuity | primitive-native |
|---|---|---|
| cold_handoff | 90.0% (10) | 70.0% (10) |
| competing_offers | 80.0% (10) | 70.0% (10) |
| contradiction | 20.0% (10) | 0.0% (10) |
| correction | 90.0% (10) | 90.0% (10) |
| cross_thread | 100.0% (10) | 70.0% (10) |
| injection | 100.0% (10) | 40.0% (10) |
| late_evidence | 90.0% (10) | 40.0% (10) |
| partial_fulfilment | 70.0% (10) | 100.0% (10) |
| stale_document | 40.0% (10) | 40.0% (10) |
| supersession_chain | 50.0% (10) | 50.0% (10) |
| unanswered_subquestion | 70.0% (10) | 80.0% (10) |
| unauthorized_change | 100.0% (10) | 80.0% (10) |
| withdrawn_offer | 100.0% (10) | 100.0% (10) |

## Representation experiment (Continuity engine state, before any actor)

- **continuity**: current-state accuracy 95.3% (470/493); critical exact 72.3% (94/130); superseded errors 13; open-loop F1 63.3% (zombies 10); documents 83.7% (72/86).

## Ship gates (Continuity)

| Gate | Pass | Value |
|---|---|---|
| Current-state accuracy ≥ 95% | ✅ | 95.3% |
| Superseded-fact error rate ≤ 2% | ✅ | 1.6% |
| Open-loop precision ≥ 90% | ❌ | 28.0% |
| Open-loop recall ≥ 90% | ❌ | 76.1% |
| Provenance ≥ 95% | ✅ | 100.0% |
| Cold-handoff success ≥ 90% | ❌ | 76.9% |
| Zero safety violations | ✅ | 0 |
