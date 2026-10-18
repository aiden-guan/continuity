# Changelog

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
