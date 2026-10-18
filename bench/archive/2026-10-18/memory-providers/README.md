# Memory providers vs Continuity

Held-out eval split, variants 11–12: 130 cases across 5 verticals. Every condition runs on Claude Haiku 5.5. Setup is in
`bench/providers/README.md`.

| Condition | Cold-handoff success | Next action | Critical state | Memory cost / case | Cost / decision |
|---|---|---|---|---|---|
| Continuity | 70.8% (92) | 80.0% | 86.9% | $0.0017 | $0.0027 |
| Mem0 (OSS) | 55.4% (72) | 76.9% | 66.9% | $0.0221 | $0.0031 |
| Zep (Graphiti OSS) | 48.5% (63) | 70.0% | 64.6% | $0.0575 | $0.0027 |
| Primitive alone | 41.5% (54) | 69.2% | 58.5% | — | $0.0043 |

Continuity's lead on cold-handoff success, paired McNemar test:

| Compared with | Lead | 95% CI | Wins / losses | p |
|---|---|---|---|---|
| Mem0 | +15.4 pp | [6.2, 24.6] | 31 / 11 | 0.003 |
| Zep | +22.3 pp | [12.3, 32.3] | 40 / 11 | 0.00006 |
| Primitive alone | +29.2 pp | [18.5, 40.0] | 49 / 11 | 8e-7 |

Continuity is ahead in every vertical:

| Vertical | Continuity | Mem0 | Zep | Primitive |
|---|---|---|---|---|
| finance | 65% | 38% | 38% | 23% |
| freight | 65% | 38% | 23% | 19% |
| hotel | 69% | 69% | 65% | 62% |
| legal | 81% | 69% | 58% | 54% |
| procurement | 73% | 62% | 58% | 50% |

## Folders

- `mp-eval-fast`: Continuity, Mem0, Zep and Primitive alone, on all 130 cases.
- `mp-eval-hindsight`: Hindsight, partial (33 of 130 cases). It was stopped to save time.
  - Hindsight 55%, Continuity 73%, Mem0 55%, Zep 48% and Primitive 45% on those same 33 cases.
  - Memory cost: $0.0226 per case.
- `mp-smoke`: the 2-case golden smoke test.

## Caveats

- **Generous membership:** the providers get ground-truth task membership. Continuity links mail to the task itself.
- **Mem0 rerun:** all 130 Mem0 cases were rerun after a concurrency bug in Qdrant's local mode corrupted its index. The
  first attempt is not used.
- **Single trial:** each case ran once.
