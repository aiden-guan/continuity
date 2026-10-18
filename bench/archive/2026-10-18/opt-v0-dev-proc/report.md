# Continuity benchmark — opt-v0-dev-proc

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 130 · splits: dev · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| primitive-native | 66.2% (86/130) [57.7%–73.8%] | 83.8% (109/130) | 73.1% (95/130) | 87.2% (430/493) | 4/129 · 8/90 | 40.8% (59) | 99.7% (387/388) | 0 | 894 | $0.00352 | $0.00000 |
| continuity | 70.8% (92/130) [63.1%–78.5%] | 80.8% (105/130) | 79.2% (103/130) | 93.9% (463/493) | 11/129 · 11/90 | 40.8% (52) | 100.0% (417/417) | 0 | 1329 | $0.00224 | $0.00606 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Paired comparison vs Continuity

| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |
|---|---|---|---|---|
| primitive-native (n=130) | +4.6 pp [-4.6, 13.8] | 22 / 16, p=0.42 | 6.8 pp [3.4, 10.3] | 291 [215, 367] |

## Vertical — cold-handoff success

| Vertical | primitive-native | continuity |
|---|---|---|
| procurement | 66.2% (130) | 70.8% (130) |

## Capability — cold-handoff success

| Capability | primitive-native | continuity |
|---|---|---|
| authority | 90.0% (10) | 80.0% (10) |
| cold_handoff | 80.0% (20) | 80.0% (20) |
| competing_offers | 60.0% (10) | 50.0% (10) |
| conflict_vs_supersession | 0.0% (10) | 30.0% (10) |
| cross_thread | 76.7% (30) | 86.7% (30) |
| document_validity | 68.0% (50) | 68.0% (50) |
| injection | 40.0% (10) | 100.0% (10) |
| late_evidence | 60.0% (10) | 100.0% (10) |
| lifecycle | 100.0% (10) | 80.0% (10) |
| open_loops | 80.0% (40) | 75.0% (40) |
| partial_fulfilment | 60.0% (10) | 60.0% (10) |
| supersession | 71.4% (70) | 68.6% (70) |

## Archetype — cold-handoff success

| Archetype | primitive-native | continuity |
|---|---|---|
| cold_handoff | 70.0% (10) | 70.0% (10) |
| competing_offers | 60.0% (10) | 50.0% (10) |
| contradiction | 0.0% (10) | 30.0% (10) |
| correction | 90.0% (10) | 90.0% (10) |
| cross_thread | 70.0% (10) | 100.0% (10) |
| injection | 40.0% (10) | 100.0% (10) |
| late_evidence | 60.0% (10) | 100.0% (10) |
| partial_fulfilment | 60.0% (10) | 60.0% (10) |
| stale_document | 50.0% (10) | 60.0% (10) |
| supersession_chain | 70.0% (10) | 20.0% (10) |
| unanswered_subquestion | 100.0% (10) | 80.0% (10) |
| unauthorized_change | 90.0% (10) | 80.0% (10) |
| withdrawn_offer | 100.0% (10) | 80.0% (10) |

## Representation experiment (Continuity engine state, before any actor)

- **continuity**: current-state accuracy 94.3% (465/493); critical exact 80.0% (104/130); superseded errors 13; open-loop F1 63.2% (zombies 20); documents 82.6% (71/86).

## Ship gates (Continuity)

| Gate | Pass | Value |
|---|---|---|
| Current-state accuracy ≥ 95% | ❌ | 93.9% |
| Superseded-fact error rate ≤ 2% | ❌ | 8.5% |
| Open-loop precision ≥ 90% | ❌ | 27.3% |
| Open-loop recall ≥ 90% | ❌ | 80.4% |
| Provenance ≥ 95% | ✅ | 100.0% |
| Cold-handoff success ≥ 90% | ❌ | 70.8% |
| Zero safety violations | ✅ | 0 |
