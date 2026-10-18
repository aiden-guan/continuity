# Changelog

## Presentation refresh — 2026-10-18

Bring the repository overview up to date with the interactive inbox and memory graph, the saved Claude extraction
evaluation, and the current demo controls. This entry covers changes since presentation checkpoint `de1b3ab`;
the value benchmark already existed there and is now surfaced in the README.

| Area | Change | Result |
| :--- | :--- | :--- |
| Browser demo | Five beats, an inbox beside a memory graph, agent compose animations and a visible approval decision. | Visitors can follow corrections, process death, fresh-agent handoffs and a held commitment. |
| Evaluation evidence | Check in the realistic-email Claude result and distinguish it from the five-domain and value benchmarks. | The overview shows both improvements and the low complete-checkpoint accuracy on messy text. |
| Send guard | Exclude our own non-authoritative echo of a term from proposed-claim warnings. | A budget request can repeat the amount for finance to decide without relying on an unverified budget approval. |

### Added

- **Realistic email:** Record the Claude extractor run over 30 synthetic threads and 87 checkpoints, including per-thread
  misses and hard-case breakdowns in `eval/realistic/results/latest-llm.json`.
- **Product captures:** Add two actual browser screenshots showing the corrected deal after Agent A dies and Agent C’s
  held order. Captures use a separate local SQLite database, simulated mail, rule extraction and policy agents.

### Changed / Refactored

- **Stage:** Use live Primitive transport when its key and three inbox addresses are configured; expose explicit
  `--sim` and `--offline` paths and show the human’s approval or rejection in the browser.
- **Website:** Update the product narrative around growing email histories, add interactive benchmark views, and use
  the current Continuity mark and social card. Website comparison claims are not independently re-evaluated here.

### Fixed

- **Guard:** Keep an agent’s earlier request for an amount separate from an authoritative finance decision, with
  focused regression coverage.

### Documentation & Presentation

- **README:** Add a product screenshot grid, a demo-mode comparison, value-benchmark findings, messy-email results and
  direct paths to the current evidence. Preserve the five-domain counts and history-growth chart with their caveats.
- **Operations:** Correct the browser-stage transport selection, five-beat controls and distinction between the stage’s
  policy Agent A and optionally Claude-powered B and C.
- **Realistic evaluation:** Document the saved model results alongside the historical rule-extractor run. Distinguish
  Claude extraction from offline policy-agent handoffs, and note the quote-header fix made after the saved rule run.
- **Media provenance:** Record screenshot routes, dimensions, states and reproduction steps in
  [the asset guide](assets/readme/README.md). Include suggested GitHub metadata without changing remote settings.
- **Agent setup:** Match the HTTP and MCP examples to the browser quick start’s port 4000, and document the endpoint
  in `.env.example` while retaining the standalone server’s default port 4100.

### Verification

- **Local suite:** 236 tests passed, no failures; eight Supabase tests skipped without a configured test database.
- **TypeScript:** `npm run typecheck` passed.
- **Offline scenarios:** 42/42 state assertions and 6/6 policy-agent handoffs passed.
- **Agent interfaces:** The HTTP briefing example returned the current task state through the stage proxy; stdio MCP
  initialized, listed 16 tools and returned the cited briefing.
- **Benchmark integrity:** All 1,365 generated cases validated and passed scorer calibration; all 161 value cases
  validated and passed their scorer self-test. All 30 realistic-email fixtures validated.
- **Visual sources:** All three generated README SVGs match their source data. Two 1440 × 900 product captures were
  inspected, and the local five-beat stage completed through the simulated approval and send.
- **Documentation:** Links, cross-document anchors, numeric result tables, images and package commands validate.
  The presenter’s strict checker used a temporary parser correction for `npm ci` and script names containing colons;
  the installed skill was unchanged.
- **Scope:** Live email, Claude evaluations, hosted Supabase persistence and GitHub rendering/settings were not rerun
  or changed during this presentation refresh. Historical results below retain their original verification scope.

## Unreleased — 2026-10-18

Make the repository easier to explore with evidence-backed charts, a system graph and explicit MIT licensing.

| Area | Change | Result |
| :--- | :--- | :--- |
| Project overview | Rebuild the README around the cold-handoff workflow, capabilities and source-linked architecture. | Readers can understand the engine before opening the full operations guide. |
| Measurements | Visualize the recorded 650-case comparison and rerun the deterministic context-scaling experiment. | Charts include source data, denominators, token-estimate definitions and limitations. |
| Licensing | Add the MIT license and matching package metadata. | Reuse terms are visible in the README and repository root. |

### Documentation & Presentation

- **README:** Add a branded workflow illustration, benchmark charts, an architecture graph and numeric text equivalents.
- **Operations guide:** Preserve the detailed demo, configuration, sender-authentication, storage and API instructions in `docs/guide.md`.
- **Evidence:** Keep the recorded model comparison separate from locally rerun measurements; identify the missing raw benchmark runs.

### Tooling & Hygiene

- **Graphics:** Add a dependency-free SVG generator with a check mode and a source-checked benchmark snapshot.
- **License:** Declare MIT in `LICENSE`, `package.json` and the root lockfile metadata.

### Verification

- Offline scenario eval: **42/42** state assertions and **6/6** policy-agent handoffs.
- Benchmark validation and scorer calibration: **1,365 cases** each, without provider calls.
- Deterministic scaling: rerun all six history lengths and record the resulting token estimates.
- TypeScript checking, generated-asset checks and README numeric/source checks pass.
- Documentation links, headings and package commands validate. The presenter's checker was adjusted in a temporary copy to recognize `npm ci` and script names containing colons; the installed skill was unchanged.
- Charts and the README hero were inspected in a local browser preview. GitHub's remote rendering and settings were not changed.
