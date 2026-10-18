# Continuity benchmark — opt-v3-dev-all

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 650 · splits: dev · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| primitive-native | 52.2% (339/650) [48.5%–56.0%] | 77.2% (502/650) | 62.0% (403/650) | 83.0% (3760/4530) | 41/708 · 37/455 | 33.5% (209) | 98.9% (3397/3436) | 0 | 1279 | $0.00428 | $0.00000 |
| continuity | 70.2% (456/650) [66.6%–73.7%] | 80.3% (522/650) | 83.7% (544/650) | 96.5% (4373/4530) | 17/708 · 20/455 | 38.0% (184) | 99.9% (4042/4047) | 0 | 1577 | $0.00269 | $0.00182 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Paired comparison vs Continuity

| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |
|---|---|---|---|---|
| primitive-native (n=650) | +18.0 pp [13.2, 22.8] | 194 / 77, p=8.1e-13 | 12.1 pp [10.5, 13.8] | 274 [226, 323] |

## Vertical — cold-handoff success

| Vertical | primitive-native | continuity |
|---|---|---|
| finance | 28.5% (130) | 56.2% (130) |
| freight | 48.5% (130) | 64.6% (130) |
| hotel | 59.2% (130) | 73.1% (130) |
| legal | 60.8% (130) | 76.9% (130) |
| procurement | 63.8% (130) | 80.0% (130) |

## Capability — cold-handoff success

| Capability | primitive-native | continuity |
|---|---|---|
| authority | 46.0% (50) | 90.0% (50) |
| cold_handoff | 50.0% (100) | 78.0% (100) |
| competing_offers | 56.0% (50) | 46.0% (50) |
| conflict_vs_supersession | 54.0% (50) | 66.0% (50) |
| cross_thread | 46.7% (150) | 72.7% (150) |
| document_validity | 41.9% (260) | 67.3% (260) |
| injection | 50.0% (50) | 92.0% (50) |
| late_evidence | 22.0% (50) | 56.0% (50) |
| lifecycle | 76.0% (50) | 68.0% (50) |
| open_loops | 63.0% (200) | 75.5% (200) |
| partial_fulfilment | 66.0% (50) | 68.0% (50) |
| supersession | 46.5% (310) | 68.7% (310) |

## Archetype — cold-handoff success

| Archetype | primitive-native | continuity |
|---|---|---|
| cold_handoff | 38.0% (50) | 74.0% (50) |
| competing_offers | 56.0% (50) | 46.0% (50) |
| contradiction | 54.0% (50) | 66.0% (50) |
| correction | 62.0% (50) | 82.0% (50) |
| cross_thread | 40.0% (50) | 62.0% (50) |
| injection | 50.0% (50) | 92.0% (50) |
| late_evidence | 22.0% (50) | 56.0% (50) |
| partial_fulfilment | 66.0% (50) | 68.0% (50) |
| stale_document | 28.0% (50) | 72.0% (50) |
| supersession_chain | 54.0% (50) | 58.0% (50) |
| unanswered_subquestion | 86.0% (50) | 78.0% (50) |
| unauthorized_change | 46.0% (50) | 90.0% (50) |
| withdrawn_offer | 76.0% (50) | 68.0% (50) |

## Representation experiment (Continuity engine state, before any actor)

- **continuity**: current-state accuracy 97.3% (4409/4530); critical exact 84.0% (546/650); superseded errors 30; open-loop F1 56.0% (zombies 63); documents 90.3% (587/650).

## Ship gates (Continuity)

| Gate | Pass | Value |
|---|---|---|
| Current-state accuracy ≥ 95% | ✅ | 96.5% |
| Superseded-fact error rate ≤ 2% | ❌ | 2.4% |
| Open-loop precision ≥ 90% | ❌ | 25.2% |
| Open-loop recall ≥ 90% | ❌ | 76.8% |
| Provenance ≥ 95% | ✅ | 99.9% |
| Cold-handoff success ≥ 90% | ❌ | 70.2% |
| Zero safety violations | ✅ | 0 |
