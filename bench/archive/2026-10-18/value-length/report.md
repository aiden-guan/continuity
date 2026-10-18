# Continuity benchmark — value-length

Model (every condition, actor and judge): `claude-haiku-5-5` · judge: `claude-haiku-5-5` · trials: 1 · cases: 24 · splits: undefined · live model calls

## Headline

| Condition | Cold-handoff success (95% CI) | Next-action success | Critical state exact | Current-state accuracy | Superseded-fact errors (state / action) | Open-loop F1 (zombies) | Provenance | Safety violations | Memory tokens (median) | Cost / decision | Ingestion / case |
|---|---|---|---|---|---|---|---|---|---|---|---|
| full-history | 45.8% (11/24) [25.0%–66.7%] | 62.5% (15/24) | 83.3% (20/24) | 96.0% (121/126) | 1/50 · 0/50 | 62.9% (30) | 93.3% (111/119) | 0 | 5436 | $0.00413 | $0.00000 |
| primitive-native | 33.3% (8/24) [16.7%–54.2%] | 54.2% (13/24) | 58.3% (14/24) | 54.8% (69/126) | 2/50 · 0/50 | 64.6% (24) | 95.6% (65/68) | 0 | 5100 | $0.00637 | $0.00000 |
| continuity | 62.5% (15/24) [41.7%–83.3%] | 79.2% (19/24) | 79.2% (19/24) | 97.6% (123/126) | 0/50 · 0/50 | 63.4% (9) | 100.0% (121/121) | 0 | 1672 | $0.00226 | $0.00741 |

Cold-handoff success = next action correct (all required, no prohibited) AND every critical state item right. Costs are provider-reported usage priced at the dated table in bench/core/llm.ts; judge cost excluded.

## Paired comparison vs Continuity

| Condition | Δ cold-handoff (95% CI) | McNemar (Continuity-only wins / other-only wins, p) | Δ current-state acc (95% CI) | Δ memory tokens (95% CI) |
|---|---|---|---|---|
| full-history (n=24) | +16.7 pp [0.0, 37.5] | 5 / 1, p=0.22 | 1.7 pp [-1.2, 4.9] | -3851 [-4549, -3171] |
| primitive-native (n=24) | +29.2 pp [8.3, 50.0] | 8 / 1, p=0.039 | 43.2 pp [35.8, 50.0] | -3948 [-4600, -3322] |

## Vertical — cold-handoff success

| Vertical | full-history | primitive-native | continuity |
|---|---|---|---|
| procurement | 45.8% (24) | 33.3% (24) | 62.5% (24) |

## Capability — cold-handoff success

| Capability | full-history | primitive-native | continuity |
|---|---|---|---|
| cold_handoff | 45.8% (24) | 33.3% (24) | 62.5% (24) |
| cross_thread | 45.8% (24) | 33.3% (24) | 62.5% (24) |
| open_loops | 45.8% (24) | 33.3% (24) | 62.5% (24) |
| scale | 45.8% (24) | 33.3% (24) | 62.5% (24) |
| supersession | 45.8% (24) | 33.3% (24) | 62.5% (24) |

## Archetype — cold-handoff success

| Archetype | full-history | primitive-native | continuity |
|---|---|---|---|
| value_chain_d4 | 45.8% (24) | 33.3% (24) | 62.5% (24) |

## Backlog — cold-handoff success

| Backlog | full-history | primitive-native | continuity |
|---|---|---|---|
| 0040 | 33.3% (12) | 33.3% (12) | 66.7% (12) |
| 0120 | 58.3% (12) | 33.3% (12) | 58.3% (12) |

### Context size vs backlog (median memory tokens)

| Backlog | full-history | primitive-native | continuity |
|---|---|---|---|
| 40 | 3994 | 4329 | 1736 |
| 120 | 7048 | 7238 | 1583 |

## Representation experiment (Continuity engine state, before any actor)

- **continuity**: current-state accuracy 100.0% (126/126); critical exact 100.0% (24/24); superseded errors 0; open-loop F1 64.7% (zombies 8); documents 100.0% (32/32).

## Ship gates (Continuity)

| Gate | Pass | Value |
|---|---|---|
| Current-state accuracy ≥ 95% | ✅ | 97.6% |
| Superseded-fact error rate ≤ 2% | ✅ | 0.0% |
| Open-loop precision ≥ 90% | ❌ | 56.5% |
| Open-loop recall ≥ 90% | ❌ | 72.2% |
| Provenance ≥ 95% | ✅ | 100.0% |
| Cold-handoff success ≥ 90% | ❌ | 62.5% |
| Zero safety violations | ✅ | 0 |
| Within 5 pp of full history on next-action success | ✅ | -16.7 pp behind |
| ≥ 60% fewer memory tokens than full history | ✅ | 69.3% |
