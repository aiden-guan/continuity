# Continuity benchmark — opt-final2-eval-all

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 650 · splits: eval · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| primitive-native | 49.2% (320/650) [45.4%–53.1%] | 76.6% (498/650) | 61.7% (401/650) | 83.1% (3789/4560) | 41/706 · 30/456 | 34.7% (221) | 98.8% (3422/3462) | 0 | 1254 | $0.00425 | $0.00000 |
| continuity | 68.8% (447/650) [65.1%–72.3%] | 78.8% (512/650) | 84.0% (546/650) | 96.3% (4389/4560) | 19/706 · 26/456 | 37.7% (171) | 99.9% (4053/4056) | 0 | 1547 | $0.00259 | $0.00184 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Paired comparison vs Continuity

| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |
|---|---|---|---|---|
| primitive-native (n=650) | +19.5 pp [14.8, 24.0] | 192 / 65, p=9.8e-16 | 11.9 pp [10.3, 13.7] | 258 [209, 304] |

## Vertical — cold-handoff success

| Vertical | primitive-native | continuity |
|---|---|---|
| finance | 28.5% (130) | 49.2% (130) |
| freight | 39.2% (130) | 70.8% (130) |
| hotel | 62.3% (130) | 66.9% (130) |
| legal | 59.2% (130) | 82.3% (130) |
| procurement | 56.9% (130) | 74.6% (130) |

## Capability — cold-handoff success

| Capability | primitive-native | continuity |
|---|---|---|
| authority | 44.0% (50) | 78.0% (50) |
| cold_handoff | 38.0% (100) | 74.0% (100) |
| competing_offers | 56.0% (50) | 60.0% (50) |
| conflict_vs_supersession | 48.0% (50) | 62.0% (50) |
| cross_thread | 37.3% (150) | 70.7% (150) |
| document_validity | 42.3% (260) | 63.1% (260) |
| injection | 58.0% (50) | 94.0% (50) |
| late_evidence | 34.0% (50) | 54.0% (50) |
| lifecycle | 62.0% (50) | 86.0% (50) |
| open_loops | 52.0% (200) | 72.5% (200) |
| partial_fulfilment | 56.0% (50) | 66.0% (50) |
| supersession | 44.2% (310) | 62.6% (310) |

## Archetype — cold-handoff success

| Archetype | primitive-native | continuity |
|---|---|---|
| cold_handoff | 42.0% (50) | 62.0% (50) |
| competing_offers | 56.0% (50) | 60.0% (50) |
| contradiction | 48.0% (50) | 62.0% (50) |
| correction | 34.0% (50) | 86.0% (50) |
| cross_thread | 36.0% (50) | 64.0% (50) |
| injection | 58.0% (50) | 94.0% (50) |
| late_evidence | 34.0% (50) | 54.0% (50) |
| partial_fulfilment | 56.0% (50) | 66.0% (50) |
| stale_document | 36.0% (50) | 64.0% (50) |
| supersession_chain | 58.0% (50) | 42.0% (50) |
| unanswered_subquestion | 76.0% (50) | 76.0% (50) |
| unauthorized_change | 44.0% (50) | 78.0% (50) |
| withdrawn_offer | 62.0% (50) | 86.0% (50) |

## Representation experiment (Continuity engine state, before any actor)

- **continuity**: current-state accuracy 96.8% (4415/4560); critical exact 82.0% (533/650); superseded errors 35; open-loop F1 60.4% (zombies 40); documents 89.3% (598/670).

## Ship gates (Continuity)

| Gate | Pass | Value |
|---|---|---|
| Current-state accuracy ≥ 95% | ✅ | 96.3% |
| Superseded-fact error rate ≤ 2% | ❌ | 2.7% |
| Open-loop precision ≥ 90% | ❌ | 24.8% |
| Open-loop recall ≥ 90% | ❌ | 77.9% |
| Provenance ≥ 95% | ✅ | 99.9% |
| Cold-handoff success ≥ 90% | ❌ | 68.8% |
| Zero safety violations | ✅ | 0 |
