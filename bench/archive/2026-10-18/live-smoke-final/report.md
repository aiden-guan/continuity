# Continuity benchmark — live-smoke-final

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 13 · splits: golden · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| primitive-native | 58.3% (7/12) [33.3%–83.3%] | 75.0% (9/12) | 75.0% (9/12) | 86.0% (37/43) | 0/12 · 1/9 | 50.0% (6) | 87.9% (29/33) | 0 | 1085 | $0.00311 | $0.00000 |
| continuity | 75.0% (9/12) [50.0%–100.0%] | 75.0% (9/12) | 91.7% (11/12) | 95.3% (41/43) | 0/12 · 1/9 | 42.4% (2) | 100.0% (37/37) | 0 | 1119 | $0.00181 | $0.00108 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Paired comparison vs Continuity

| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |
|---|---|---|---|---|
| primitive-native (n=12) | +16.7 pp [-25.0, 58.3] | 4 / 2, p=0.69 | 5.1 pp [-5.3, 16.3] | -145 [-599, 228] |

## Vertical — cold-handoff success

| Vertical | primitive-native | continuity |
|---|---|---|
| procurement | 58.3% (12) | 75.0% (12) |

## Capability — cold-handoff success

| Capability | primitive-native | continuity |
|---|---|---|
| authority | — | — |
| cold_handoff | 50.0% (2) | 100.0% (2) |
| competing_offers | 0.0% (1) | 100.0% (1) |
| conflict_vs_supersession | 0.0% (1) | 0.0% (1) |
| cross_thread | 66.7% (3) | 100.0% (3) |
| document_validity | 60.0% (5) | 60.0% (5) |
| injection | 100.0% (1) | 100.0% (1) |
| late_evidence | 0.0% (1) | 100.0% (1) |
| lifecycle | 100.0% (1) | 100.0% (1) |
| open_loops | 50.0% (4) | 100.0% (4) |
| partial_fulfilment | 0.0% (1) | 100.0% (1) |
| supersession | 57.1% (7) | 71.4% (7) |

## Archetype — cold-handoff success

| Archetype | primitive-native | continuity |
|---|---|---|
| cold_handoff | 100.0% (1) | 100.0% (1) |
| competing_offers | 0.0% (1) | 100.0% (1) |
| contradiction | 0.0% (1) | 0.0% (1) |
| correction | 0.0% (1) | 100.0% (1) |
| cross_thread | 100.0% (1) | 100.0% (1) |
| injection | 100.0% (1) | 100.0% (1) |
| late_evidence | 0.0% (1) | 100.0% (1) |
| partial_fulfilment | 0.0% (1) | 100.0% (1) |
| stale_document | 100.0% (1) | 0.0% (1) |
| supersession_chain | 100.0% (1) | 0.0% (1) |
| unanswered_subquestion | 100.0% (1) | 100.0% (1) |
| unauthorized_change | n/a | n/a |
| withdrawn_offer | 100.0% (1) | 100.0% (1) |

## Representation experiment (Continuity engine state, before any actor)

- **continuity**: current-state accuracy 95.3% (41/43); critical exact 75.0% (9/12); superseded errors 1; open-loop F1 62.5% (zombies 0); documents 71.4% (5/7).

## Ship gates (Continuity)

| Gate | Pass | Value |
|---|---|---|
| Current-state accuracy ≥ 95% | ✅ | 95.3% |
| Superseded-fact error rate ≤ 2% | ✅ | 0.0% |
| Open-loop precision ≥ 90% | ❌ | 29.2% |
| Open-loop recall ≥ 90% | ❌ | 77.8% |
| Provenance ≥ 95% | ✅ | 100.0% |
| Cold-handoff success ≥ 90% | ❌ | 75.0% |
| Zero safety violations | ✅ | 0 |
