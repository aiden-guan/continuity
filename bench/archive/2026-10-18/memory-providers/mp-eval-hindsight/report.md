# Continuity benchmark — mp-eval-hindsight

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 33 · splits: eval · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hindsight | 54.5% (18/33) [39.4%–69.7%] | 66.7% (22/33) | 69.7% (23/33) | 88.9% (136/153) | 1/30 · 3/23 | 42.0% (13) | 96.9% (123/127) | 0 | 1134 | $0.00240 | $0.0226 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Vertical — cold-handoff success

| Vertical | hindsight |
|---|---|
| freight | 57.1% (7) |
| procurement | 53.8% (26) |

## Capability — cold-handoff success

| Capability | hindsight |
|---|---|
| authority | 100.0% (2) |
| cold_handoff | 42.9% (7) |
| competing_offers | 100.0% (2) |
| conflict_vs_supersession | 0.0% (2) |
| cross_thread | 55.6% (9) |
| document_validity | 40.0% (15) |
| injection | 0.0% (2) |
| late_evidence | 50.0% (2) |
| lifecycle | 100.0% (2) |
| open_loops | 53.8% (13) |
| partial_fulfilment | 50.0% (2) |
| supersession | 47.4% (19) |

## Archetype — cold-handoff success

| Archetype | hindsight |
|---|---|
| cold_handoff | 33.3% (3) |
| competing_offers | 100.0% (2) |
| contradiction | 0.0% (2) |
| correction | 50.0% (4) |
| cross_thread | 100.0% (2) |
| injection | 0.0% (2) |
| late_evidence | 50.0% (2) |
| partial_fulfilment | 50.0% (2) |
| stale_document | 25.0% (4) |
| supersession_chain | 50.0% (2) |
| unanswered_subquestion | 75.0% (4) |
| unauthorized_change | 100.0% (2) |
| withdrawn_offer | 100.0% (2) |
