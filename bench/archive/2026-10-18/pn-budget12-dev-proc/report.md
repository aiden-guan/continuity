# Continuity benchmark — pn-budget12-dev-proc

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 130 · splits: dev · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| primitive-native | 68.5% (89/130) [60.0%–76.2%] | 80.8% (105/130) | 80.8% (105/130) | 91.3% (450/493) | 3/129 · 8/90 | 43.1% (44) | 100.0% (406/406) | 0 | 1203 | $0.00333 | $0.00000 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Vertical — cold-handoff success

| Vertical | primitive-native |
|---|---|
| procurement | 68.5% (130) |

## Capability — cold-handoff success

| Capability | primitive-native |
|---|---|
| authority | 90.0% (10) |
| cold_handoff | 70.0% (20) |
| competing_offers | 100.0% (10) |
| conflict_vs_supersession | 0.0% (10) |
| cross_thread | 66.7% (30) |
| document_validity | 64.0% (50) |
| injection | 70.0% (10) |
| late_evidence | 60.0% (10) |
| lifecycle | 100.0% (10) |
| open_loops | 72.5% (40) |
| partial_fulfilment | 80.0% (10) |
| supersession | 71.4% (70) |

## Archetype — cold-handoff success

| Archetype | primitive-native |
|---|---|
| cold_handoff | 70.0% (10) |
| competing_offers | 100.0% (10) |
| contradiction | 0.0% (10) |
| correction | 70.0% (10) |
| cross_thread | 60.0% (10) |
| injection | 70.0% (10) |
| late_evidence | 60.0% (10) |
| partial_fulfilment | 80.0% (10) |
| stale_document | 50.0% (10) |
| supersession_chain | 70.0% (10) |
| unanswered_subquestion | 70.0% (10) |
| unauthorized_change | 90.0% (10) |
| withdrawn_offer | 100.0% (10) |
