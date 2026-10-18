# README visual sources

The SVGs are generated diagrams and charts. The JPEGs are captures of the running product. The warm paper, ink and
orange palette and project mark follow the existing presentation in [site/index.html](../../site/index.html).

| Asset | Evidence | Scope |
| :--- | :--- | :--- |
| `hero.svg` | [Engine](../../src/engine/engine.ts), [compiler](../../src/compiler/compile.ts), [demo](../../scripts/demo.ts) | Conceptual cold-handoff workflow. |
| `handoff.svg` | [metrics.json](metrics.json), transcribed from [bench/FINDINGS.md](../../bench/FINDINGS.md) | Reported 2026-10-18 final comparison: 650 synthetic cases, one trial per cell, five domains. Per-case raw runs are not checked in. |
| `context-growth.svg` | [scale.json](../../eval/results/scale.json), produced by [eval/scale.ts](../../eval/scale.ts) | Offline deterministic rerun on 2026-10-18. Token counts are chars/4 estimates with quoted reply history. The y-axis is logarithmic. |
| `inbox-state.jpg` | [Stage](../../scripts/stage.ts), [presenter](../../site/live.html), [memory graph](../../site/assets/graph.js) | Actual browser capture, 2026-10-18: beat 2 complete, Agent A killed, corrected delivery, stale quote and revised-quote obligation. Simulated mail and offline agents. |
| `human-approval.jpg` | [Stage](../../scripts/stage.ts), [presenter](../../site/assets/live.js), [approvals](../../src/approvals.ts) | Actual browser capture, 2026-10-18: beat 5, Agent C’s order held for a person; revised quote current and the promise fulfilled. Simulated mail and offline agents. |

From the repository root:

```bash
node eval/scale.ts
npm run readme:assets
npm run readme:assets -- --check
```

The generator has no external dependencies and makes no network calls. It checks the benchmark snapshot against the
source report, calculates percentages from raw domain counts and compares generated SVGs byte-for-byte in check mode.
The numeric tables and methodology caveats remain in the main README for accessible text equivalents.

The model benchmark is not rerun by this command. To reproduce it with provider calls, follow
[bench/README.md](../../bench/README.md); use a new run name and publish the raw result directory deliberately.

## Reproduce the product captures

```bash
npm run stage -- --sim --offline --db .scratch/readme-capture.db
```

Open `http://localhost:4000/live` at **1440 × 900** in the light theme. Leave captions enabled and capture the browser
content without OS or browser chrome. Both JPEGs use the same viewport and contain only the scenario’s fictional parties.

1. Press **→** twice, waiting for each beat to finish. The title is “Agent A dies.” The inbox shows the supplier’s
   correction; the graph shows 300 Friday + 200 Wednesday, a stale quote, and a revised quote owed. Save to
   `assets/readme/inbox-state.jpg` after the transient SIGKILL overlay disappears.
2. Press **→** for beats 3–5, waiting each time. Leave Agent C’s order **held**, with “Approve and send” and “Reject”
   visible. Save to `assets/readme/human-approval.jpg` before deciding.

The capture pass used the running engine at port 4418, the stage at port 4417 and a separate database under
`.scratch/repo-presentation-20261018/`. It exercised the simulated approval after saving the second capture.
No live email or Claude calls were used. These JPEGs are captured manually; `readme:assets` regenerates only the SVGs.

## Suggested GitHub surfaces

These settings are recommendations, not remote changes made by this presentation pass:

- **Description:** Turn long email threads into cited task state that fresh agents can act on. HTTP, MCP, replay and human approvals.
- **Topics:** `ai-agents`, `agent-memory`, `event-sourcing`, `email`, `mcp`, `typescript`, `postgresql`, `sqlite`.
- **Homepage:** use a verified public deployment when available. The local demo routes are not public URLs.
- **Social preview:** [site/assets/og.png](../../site/assets/og.png) is the existing website card; check its crop in GitHub
  before choosing it. No repository social preview was uploaded here.
