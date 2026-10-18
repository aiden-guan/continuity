# Continuity benchmark — opt-v4-dev-all

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 650 · splits: dev · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| primitive-native | 52.2% (339/650) [48.5%–56.0%] | 77.2% (502/650) | 62.0% (403/650) | 83.0% (3760/4530) | 41/708 · 37/455 | 33.5% (209) | 98.9% (3397/3436) | 0 | 1279 | $0.00428 | $0.00000 |
| continuity | 69.8% (454/650) [66.3%–73.4%] | 79.4% (516/650) | 84.3% (548/650) | 96.8% (4385/4530) | 16/708 · 23/455 | 38.5% (175) | 99.9% (4055/4060) | 4 | 1511 | $0.00275 | $0.00186 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Paired comparison vs Continuity

| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |
|---|---|---|---|---|
| primitive-native (n=650) | +17.7 pp [12.9, 22.3] | 188 / 73, p=7.2e-13 | 12.5 pp [10.8, 14.1] | 223 [176, 271] |

## Vertical — cold-handoff success

| Vertical | primitive-native | continuity |
|---|---|---|
| finance | 28.5% (130) | 53.1% (130) |
| freight | 48.5% (130) | 70.0% (130) |
| hotel | 59.2% (130) | 70.8% (130) |
| legal | 60.8% (130) | 75.4% (130) |
| procurement | 63.8% (130) | 80.0% (130) |

## Capability — cold-handoff success

| Capability | primitive-native | continuity |
|---|---|---|
| authority | 46.0% (50) | 88.0% (50) |
| cold_handoff | 50.0% (100) | 77.0% (100) |
| competing_offers | 56.0% (50) | 46.0% (50) |
| conflict_vs_supersession | 54.0% (50) | 56.0% (50) |
| cross_thread | 46.7% (150) | 70.7% (150) |
| document_validity | 41.9% (260) | 68.8% (260) |
| injection | 50.0% (50) | 88.0% (50) |
| late_evidence | 22.0% (50) | 62.0% (50) |
| lifecycle | 76.0% (50) | 84.0% (50) |
| open_loops | 63.0% (200) | 75.0% (200) |
| partial_fulfilment | 66.0% (50) | 72.0% (50) |
| supersession | 46.5% (310) | 69.0% (310) |

## Archetype — cold-handoff success

| Archetype | primitive-native | continuity |
|---|---|---|
| cold_handoff | 38.0% (50) | 72.0% (50) |
| competing_offers | 56.0% (50) | 46.0% (50) |
| contradiction | 54.0% (50) | 56.0% (50) |
| correction | 62.0% (50) | 82.0% (50) |
| cross_thread | 40.0% (50) | 58.0% (50) |
| injection | 50.0% (50) | 88.0% (50) |
| late_evidence | 22.0% (50) | 62.0% (50) |
| partial_fulfilment | 66.0% (50) | 72.0% (50) |
| stale_document | 28.0% (50) | 68.0% (50) |
| supersession_chain | 54.0% (50) | 58.0% (50) |
| unanswered_subquestion | 86.0% (50) | 74.0% (50) |
| unauthorized_change | 46.0% (50) | 88.0% (50) |
| withdrawn_offer | 76.0% (50) | 84.0% (50) |

## Representation experiment (Continuity engine state, before any actor)

- **continuity**: current-state accuracy 97.3% (4407/4530); critical exact 83.5% (543/650); superseded errors 31; open-loop F1 56.8% (zombies 54); documents 90.0% (585/650).

## Ship gates (Continuity)

| Gate | Pass | Value |
|---|---|---|
| Current-state accuracy ≥ 95% | ✅ | 96.8% |
| Superseded-fact error rate ≤ 2% | ❌ | 2.3% |
| Open-loop precision ≥ 90% | ❌ | 25.6% |
| Open-loop recall ≥ 90% | ❌ | 77.5% |
| Provenance ≥ 95% | ✅ | 99.9% |
| Cold-handoff success ≥ 90% | ❌ | 69.8% |
| Zero safety violations | ❌ | 4 |
