# Continuity benchmark — value-smoke-mock

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 14 · splits: undefined · **MOCK RUN (no model calls; numbers are meaningless)**

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| full-history | 0.0% (0/14) [0.0%–0.0%] | 0.0% (0/14) | 0.0% (0/14) | 0.0% (0/71) | 0/37 · 0/37 | 0.0% (0) | — (0/0) | 0 | 2128 | $0.00000 | $0.00000 |
| oracle | 0.0% (0/14) [0.0%–0.0%] | 0.0% (0/14) | 0.0% (0/14) | 0.0% (0/71) | 0/37 · 0/37 | 0.0% (0) | — (0/0) | 0 | 374 | $0.00000 | $0.00000 |
| primitive-native | 0.0% (0/14) [0.0%–0.0%] | 0.0% (0/14) | 0.0% (0/14) | 0.0% (0/71) | 0/37 · 0/37 | 0.0% (0) | — (0/0) | 0 | 5 | $0.00000 | $0.00000 |
| continuity | 0.0% (0/14) [0.0%–0.0%] | 0.0% (0/14) | 0.0% (0/14) | 0.0% (0/71) | 0/37 · 0/37 | 0.0% (0) | — (0/0) | 0 | 1567 | $0.00000 | $0.00000 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Paired comparison vs Continuity

| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |
|---|---|---|---|---|
| full-history (n=14) | +0.0 pp [0.0, 0.0] | 0 / 0, p=1.0 | 0.0 pp [0.0, 0.0] | -692 [-1121, -321] |
| primitive-native (n=14) | +0.0 pp [0.0, 0.0] | 0 / 0, p=1.0 | 0.0 pp [0.0, 0.0] | 1595 [1478, 1722] |

## Vertical — cold-handoff success

| Vertical | full-history | oracle | primitive-native | continuity |
|---|---|---|---|---|
| procurement | 0.0% (14) | 0.0% (14) | 0.0% (14) | 0.0% (14) |

## Capability — cold-handoff success

| Capability | full-history | oracle | primitive-native | continuity |
|---|---|---|---|---|
| cold_handoff | 0.0% (8) | 0.0% (8) | 0.0% (8) | 0.0% (8) |
| cross_thread | 0.0% (14) | 0.0% (14) | 0.0% (14) | 0.0% (14) |
| open_loops | 0.0% (14) | 0.0% (14) | 0.0% (14) | 0.0% (14) |
| supersession | 0.0% (14) | 0.0% (14) | 0.0% (14) | 0.0% (14) |

## Archetype — cold-handoff success

| Archetype | full-history | oracle | primitive-native | continuity |
|---|---|---|---|---|
| value_chain_d1 | 0.0% (2) | 0.0% (2) | 0.0% (2) | 0.0% (2) |
| value_chain_d2 | 0.0% (2) | 0.0% (2) | 0.0% (2) | 0.0% (2) |
| value_chain_d4 | 0.0% (2) | 0.0% (2) | 0.0% (2) | 0.0% (2) |
| value_chain_d6 | 0.0% (2) | 0.0% (2) | 0.0% (2) | 0.0% (2) |
| value_fanout_t2 | 0.0% (2) | 0.0% (2) | 0.0% (2) | 0.0% (2) |
| value_fanout_t5 | 0.0% (2) | 0.0% (2) | 0.0% (2) | 0.0% (2) |
| value_fanout_t8 | 0.0% (2) | 0.0% (2) | 0.0% (2) | 0.0% (2) |

## Representation experiment (Continuity engine state, before any actor)

- **continuity**: current-state accuracy 76.1% (54/71); critical exact 0.0% (0/14); superseded errors 13; open-loop F1 57.1% (zombies 5); documents 44.4% (8/18).

## Ship gates (Continuity)

| Gate | Pass | Value |
|---|---|---|
| Current-state accuracy ≥ 95% | ❌ | 0.0% |
| Superseded-fact error rate ≤ 2% | ✅ | 0.0% |
| Open-loop precision ≥ 90% | ❌ | 0.0% |
| Open-loop recall ≥ 90% | ❌ | 0.0% |
| Provenance ≥ 95% | ❌ | 0.0% |
| Cold-handoff success ≥ 90% | ❌ | 0.0% |
| Zero safety violations | ✅ | 0 |
| Within 5 pp of full history on next-action success | ✅ | 0.0 pp behind |
| ≥ 60% fewer memory tokens than full history | ❌ | 26.4% |
