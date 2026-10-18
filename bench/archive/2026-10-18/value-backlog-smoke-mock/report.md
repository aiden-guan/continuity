# Continuity benchmark — value-backlog-smoke-mock

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 1 · splits: undefined · **MOCK RUN (no model calls; numbers are meaningless)**

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| full-history | 0.0% (0/1) [0.0%–0.0%] | 0.0% (0/1) | 0.0% (0/1) | 0.0% (0/5) | 0/3 · 0/3 | 0.0% (0) | — (0/0) | 0 | 3946 | $0.00000 | $0.00000 |
| primitive-native | 0.0% (0/1) [0.0%–0.0%] | 0.0% (0/1) | 0.0% (0/1) | 0.0% (0/5) | 0/3 · 0/3 | 0.0% (0) | — (0/0) | 0 | 5 | $0.00000 | $0.00000 |
| continuity | 0.0% (0/1) [0.0%–0.0%] | 0.0% (0/1) | 0.0% (0/1) | 0.0% (0/5) | 0/3 · 0/3 | 0.0% (0) | — (0/0) | 0 | 1293 | $0.00000 | $0.00000 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Paired comparison vs Continuity

| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |
|---|---|---|---|---|
| full-history (n=1) | +0.0 pp [0.0, 0.0] | 0 / 0, p=1.0 | 0.0 pp [0.0, 0.0] | -2653 [-2653, -2653] |
| primitive-native (n=1) | +0.0 pp [0.0, 0.0] | 0 / 0, p=1.0 | 0.0 pp [0.0, 0.0] | 1288 [1288, 1288] |

## Vertical — cold-handoff success

| Vertical | full-history | primitive-native | continuity |
|---|---|---|---|
| procurement | 0.0% (1) | 0.0% (1) | 0.0% (1) |

## Capability — cold-handoff success

| Capability | full-history | primitive-native | continuity |
|---|---|---|---|
| cold_handoff | 0.0% (1) | 0.0% (1) | 0.0% (1) |
| cross_thread | 0.0% (1) | 0.0% (1) | 0.0% (1) |
| open_loops | 0.0% (1) | 0.0% (1) | 0.0% (1) |
| scale | 0.0% (1) | 0.0% (1) | 0.0% (1) |
| supersession | 0.0% (1) | 0.0% (1) | 0.0% (1) |

## Archetype — cold-handoff success

| Archetype | full-history | primitive-native | continuity |
|---|---|---|---|
| value_chain_d4 | 0.0% (1) | 0.0% (1) | 0.0% (1) |

## Representation experiment (Continuity engine state, before any actor)

- **continuity**: current-state accuracy 80.0% (4/5); critical exact 0.0% (0/1); superseded errors 1; open-loop F1 0.0% (zombies 0); documents 0.0% (0/1).

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
| ≥ 60% fewer memory tokens than full history | ✅ | 67.2% |
