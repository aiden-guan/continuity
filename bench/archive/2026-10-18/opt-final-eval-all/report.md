# Continuity benchmark — opt-final-eval-all

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 650 · splits: eval · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| primitive-native | 49.2% (320/650) [45.4%–53.1%] | 76.6% (498/650) | 61.7% (401/650) | 83.1% (3789/4560) | 41/706 · 30/456 | 34.7% (221) | 98.8% (3422/3462) | 0 | 1254 | $0.00425 | $0.00000 |
| continuity | 66.6% (433/650) [62.9%–70.3%] | 78.3% (509/650) | 81.7% (531/650) | 96.1% (4381/4560) | 20/706 · 26/456 | 37.6% (185) | 100.0% (4047/4048) | 0 | 1591 | $0.00249 | $0.00184 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Paired comparison vs Continuity

| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |
|---|---|---|---|---|
| primitive-native (n=650) | +17.4 pp [12.6, 22.0] | 185 / 72, p=1.2e-12 | 11.8 pp [10.2, 13.6] | 293 [245, 339] |

## Vertical — cold-handoff success

| Vertical | primitive-native | continuity |
|---|---|---|
| finance | 28.5% (130) | 46.9% (130) |
| freight | 39.2% (130) | 69.2% (130) |
| hotel | 62.3% (130) | 62.3% (130) |
| legal | 59.2% (130) | 81.5% (130) |
| procurement | 56.9% (130) | 73.1% (130) |

## Capability — cold-handoff success

| Capability | primitive-native | continuity |
|---|---|---|
| authority | 44.0% (50) | 76.0% (50) |
| cold_handoff | 38.0% (100) | 73.0% (100) |
| competing_offers | 56.0% (50) | 58.0% (50) |
| conflict_vs_supersession | 48.0% (50) | 66.0% (50) |
| cross_thread | 37.3% (150) | 67.3% (150) |
| document_validity | 42.3% (260) | 60.4% (260) |
| injection | 58.0% (50) | 96.0% (50) |
| late_evidence | 34.0% (50) | 54.0% (50) |
| lifecycle | 62.0% (50) | 68.0% (50) |
| open_loops | 52.0% (200) | 71.5% (200) |
| partial_fulfilment | 56.0% (50) | 64.0% (50) |
| supersession | 44.2% (310) | 61.0% (310) |

## Archetype — cold-handoff success

| Archetype | primitive-native | continuity |
|---|---|---|
| cold_handoff | 42.0% (50) | 58.0% (50) |
| competing_offers | 56.0% (50) | 58.0% (50) |
| contradiction | 48.0% (50) | 66.0% (50) |
| correction | 34.0% (50) | 88.0% (50) |
| cross_thread | 36.0% (50) | 56.0% (50) |
| injection | 58.0% (50) | 96.0% (50) |
| late_evidence | 34.0% (50) | 54.0% (50) |
| partial_fulfilment | 56.0% (50) | 64.0% (50) |
| stale_document | 36.0% (50) | 64.0% (50) |
| supersession_chain | 58.0% (50) | 42.0% (50) |
| unanswered_subquestion | 76.0% (50) | 76.0% (50) |
| unauthorized_change | 44.0% (50) | 76.0% (50) |
| withdrawn_offer | 62.0% (50) | 68.0% (50) |

## Representation experiment (Continuity engine state, before any actor)

- **continuity**: current-state accuracy 96.8% (4413/4560); critical exact 82.0% (533/650); superseded errors 35; open-loop F1 59.8% (zombies 45); documents 89.3% (598/670).

## Ship gates (Continuity)

| Gate | Pass | Value |
|---|---|---|
| Current-state accuracy ≥ 95% | ✅ | 96.1% |
| Superseded-fact error rate ≤ 2% | ❌ | 2.8% |
| Open-loop precision ≥ 90% | ❌ | 24.8% |
| Open-loop recall ≥ 90% | ❌ | 78.5% |
| Provenance ≥ 95% | ✅ | 100.0% |
| Cold-handoff success ≥ 90% | ❌ | 66.6% |
| Zero safety violations | ✅ | 0 |
