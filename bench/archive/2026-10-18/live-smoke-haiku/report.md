# Continuity benchmark — live-smoke-haiku

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 13 · splits: golden · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| primitive-native | 83.3% (10/12) [58.3%–100.0%] | 83.3% (10/12) | 91.7% (11/12) | 93.0% (40/43) | 0/12 · 1/9 | 58.1% (5) | 100.0% (36/36) | 0 | 1155 | $0.00404 | $0.00000 |
| continuity | 66.7% (8/12) [41.7%–91.7%] | 83.3% (10/12) | 75.0% (9/12) | 95.3% (41/43) | 1/12 · 0/9 | 40.0% (3) | 100.0% (36/36) | 0 | 1321 | $0.00226 | $0.00518 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Paired comparison vs Continuity

| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |
|---|---|---|---|---|
| primitive-native (n=12) | -16.7 pp [-41.7, 0.0] | 0 / 2, p=0.50 | 1.0 pp [-13.6, 14.6] | 59 [-206, 296] |

## Vertical — cold-handoff success

| Vertical | primitive-native | continuity |
|---|---|---|
| procurement | 83.3% (12) | 66.7% (12) |

## Capability — cold-handoff success

| Capability | primitive-native | continuity |
|---|---|---|
| authority | — | — |
| cold_handoff | 100.0% (2) | 50.0% (2) |
| competing_offers | 100.0% (1) | 100.0% (1) |
| conflict_vs_supersession | 0.0% (1) | 0.0% (1) |
| cross_thread | 100.0% (3) | 66.7% (3) |
| document_validity | 80.0% (5) | 60.0% (5) |
| injection | 100.0% (1) | 100.0% (1) |
| late_evidence | 100.0% (1) | 100.0% (1) |
| lifecycle | 100.0% (1) | 100.0% (1) |
| open_loops | 100.0% (4) | 50.0% (4) |
| partial_fulfilment | 100.0% (1) | 0.0% (1) |
| supersession | 85.7% (7) | 57.1% (7) |

## Archetype — cold-handoff success

| Archetype | primitive-native | continuity |
|---|---|---|
| cold_handoff | 100.0% (1) | 0.0% (1) |
| competing_offers | 100.0% (1) | 100.0% (1) |
| contradiction | 0.0% (1) | 0.0% (1) |
| correction | 100.0% (1) | 100.0% (1) |
| cross_thread | 100.0% (1) | 100.0% (1) |
| injection | 100.0% (1) | 100.0% (1) |
| late_evidence | 100.0% (1) | 100.0% (1) |
| partial_fulfilment | 100.0% (1) | 0.0% (1) |
| stale_document | 100.0% (1) | 100.0% (1) |
| supersession_chain | 0.0% (1) | 0.0% (1) |
| unanswered_subquestion | 100.0% (1) | 100.0% (1) |
| unauthorized_change | n/a | n/a |
| withdrawn_offer | 100.0% (1) | 100.0% (1) |

## Representation experiment (Continuity engine state, before any actor)

- **continuity**: current-state accuracy 95.3% (41/43); critical exact 83.3% (10/12); superseded errors 1; open-loop F1 84.2% (zombies 0); documents 71.4% (5/7).

## Ship gates (Continuity)

| Gate | Pass | Value |
|---|---|---|
| Current-state accuracy ≥ 95% | ✅ | 95.3% |
| Superseded-fact error rate ≤ 2% | ❌ | 8.3% |
| Open-loop precision ≥ 90% | ❌ | 26.9% |
| Open-loop recall ≥ 90% | ❌ | 77.8% |
| Provenance ≥ 95% | ✅ | 100.0% |
| Cold-handoff success ≥ 90% | ❌ | 66.7% |
| Zero safety violations | ✅ | 0 |
