# Continuity benchmark — opt-v2-dev-all

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 650 · splits: dev · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| primitive-native (1 errored, excluded) | 52.1% (338/649) [48.2%–55.9%] | 77.2% (501/649) | 61.9% (402/649) | 83.0% (3751/4521) | 41/707 · 37/454 | 33.4% (209) | 98.9% (3388/3427) | 0 | 1280 | $0.00428 | $0.00000 |
| continuity | 70.5% (458/650) [66.9%–74.0%] | 80.9% (526/650) | 83.2% (541/650) | 96.4% (4365/4530) | 17/708 · 22/455 | 37.2% (186) | 99.9% (4032/4037) | 0 | 1576 | $0.00257 | $0.00181 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Paired comparison vs Continuity

| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |
|---|---|---|---|---|
| primitive-native (n=649) | +18.3 pp [13.4, 23.1] | 197 / 78, p=4.8e-13 | 12.3 pp [10.6, 13.9] | 274 [226, 323] |

## Vertical — cold-handoff success

| Vertical | primitive-native | continuity |
|---|---|---|
| finance | 28.5% (130) | 53.1% (130) |
| freight | 48.5% (130) | 63.8% (130) |
| hotel | 59.2% (130) | 76.2% (130) |
| legal | 60.5% (129) | 79.2% (130) |
| procurement | 63.8% (130) | 80.0% (130) |

## Capability — cold-handoff success

| Capability | primitive-native | continuity |
|---|---|---|
| authority | 46.0% (50) | 90.0% (50) |
| cold_handoff | 50.0% (100) | 76.0% (100) |
| competing_offers | 56.0% (50) | 44.0% (50) |
| conflict_vs_supersession | 54.0% (50) | 64.0% (50) |
| cross_thread | 46.7% (150) | 73.3% (150) |
| document_validity | 41.7% (259) | 68.8% (260) |
| injection | 50.0% (50) | 90.0% (50) |
| late_evidence | 20.4% (49) | 62.0% (50) |
| lifecycle | 76.0% (50) | 72.0% (50) |
| open_loops | 63.0% (200) | 73.5% (200) |
| partial_fulfilment | 66.0% (50) | 66.0% (50) |
| supersession | 46.3% (309) | 69.7% (310) |

## Archetype — cold-handoff success

| Archetype | primitive-native | continuity |
|---|---|---|
| cold_handoff | 38.0% (50) | 70.0% (50) |
| competing_offers | 56.0% (50) | 44.0% (50) |
| contradiction | 54.0% (50) | 64.0% (50) |
| correction | 62.0% (50) | 82.0% (50) |
| cross_thread | 40.0% (50) | 68.0% (50) |
| injection | 50.0% (50) | 90.0% (50) |
| late_evidence | 20.4% (49) | 62.0% (50) |
| partial_fulfilment | 66.0% (50) | 66.0% (50) |
| stale_document | 28.0% (50) | 76.0% (50) |
| supersession_chain | 54.0% (50) | 56.0% (50) |
| unanswered_subquestion | 86.0% (50) | 76.0% (50) |
| unauthorized_change | 46.0% (50) | 90.0% (50) |
| withdrawn_offer | 76.0% (50) | 72.0% (50) |

## Representation experiment (Continuity engine state, before any actor)

- **continuity**: current-state accuracy 97.2% (4405/4530); critical exact 83.5% (543/650); superseded errors 35; open-loop F1 56.6% (zombies 62); documents 86.0% (559/650).

## Ship gates (Continuity)

| Gate | Pass | Value |
|---|---|---|
| Current-state accuracy ≥ 95% | ✅ | 96.4% |
| Superseded-fact error rate ≤ 2% | ❌ | 2.4% |
| Open-loop precision ≥ 90% | ❌ | 24.6% |
| Open-loop recall ≥ 90% | ❌ | 76.6% |
| Provenance ≥ 95% | ✅ | 99.9% |
| Cold-handoff success ≥ 90% | ❌ | 70.5% |
| Zero safety violations | ✅ | 0 |

## Errors

- legal/late_evidence/2|primitive-native|1: Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of concurrent requests across all models has exceeded your organization's limit. Wait for in-flight requests to complete and retry. Limits increase automatically as your organization moves up usage tiers."},"request_id":"req_011Cg9BuAuJfST4oTzeeyN1b"}
