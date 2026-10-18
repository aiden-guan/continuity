<div align="center">

# Continuity

**A communication-state engine that lets fresh AI agents pick up unfinished conversations.**

[Quick start](#quick-start) · [Results](#measured-results) · [Architecture](#how-it-works) · [Operations guide](docs/guide.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-161513?style=flat-square)](LICENSE)
[![Node.js ≥22.18](https://img.shields.io/badge/Node.js-%E2%89%A522.18-161513?style=flat-square)](package.json)

![Continuity: Agents forget. The thread doesn’t. Agent A sends an RFQ, mail keeps arriving, task state evolves, and fresh Agent B reads one briefing.](assets/readme/hero.svg)

</div>

[Primitive](https://primitive.dev) gives an agent an inbox. Continuity gives each conversation in that inbox a state:
current terms, replaced terms, conflicting claims, outstanding commitments, answered questions and document revisions,
with citations to the email or attachment behind each item.

An agent can stop, lose its context or be replaced. The next agent makes one HTTP or MCP call to learn **where the task
stands, who owes what, and who needs to act next**. Task state lives outside the agent process.

**Open source under the [MIT license](LICENSE).** Run it locally, inspect the resolver, or build it into your own agent workflow.

## What survives a handoff

| Terms and evidence | Commitments and questions |
| :--- | :--- |
| Corrections replace the appropriate term. Conflicting speakers stay contested. Every claim keeps its sources. | Track what both sides owe, preserve already-answered questions, and surface overdue commitments. |
| **Document currency** | **Decisions and approvals** |
| Mark exactly which terms in a quote became stale; a revised attachment can fulfil an outstanding promise. | Compile the next agent’s briefing, block sends that violate hard requirements, and hold commitments for a human by default. |

## Quick start

Requires **Node.js 22.18 or newer**. There is no build step. A fresh clone needs no API keys for the local demo.

```bash
git clone https://github.com/aiden-guan/continuity.git
cd continuity
npm ci
npm run demo
```

Open [localhost:4100](http://localhost:4100). The demo uses SQLite and simulated mail; without an Anthropic key,
extraction and agent decisions use offline rules. Existing `.env` settings can enable Claude. The console identifies
the active transport.

The story is an actual process handoff through the engine:

1. **Agent A opens a negotiation:** 500 units by Friday, plus a separate finance request.
2. **Agent A is killed with `SIGKILL`.** Finance approves the budget in another thread, and the supplier corrects delivery to 300 units Friday and 200 Wednesday.
3. **Continuity updates state without an agent running:** delivery conflicts with the deadline, the first quote is partially stale, and the revised quote is still owed.
4. **Fresh Agent B reads the briefing** and raises the delivery conflict and missing quote.
5. **The supplier expedites and revises the quote.** Fresh Agent C drafts acceptance; the send waits for a human approver.

For the browser presentation, run `npm run stage` and open [localhost:4000](http://localhost:4000).
For real mail, Claude, Supabase, tokens and the full API, use the [operations guide](docs/guide.md).

## Measured results

Two different kinds of evidence are shown here: a **recorded model benchmark** and a **locally rerun deterministic
scaling experiment**. Both use synthetic scenarios. These are development measurements, not production accuracy.

### Cold-handoff success

The recorded comparison asks whether the fresh agent takes the **correct next action and reports every critical
fact correctly**. Both conditions use `claude-haiku-5-5`, the same instructions and the same 650 cases across five domains.
Primitive alone reads the mailbox through up to six lookup calls; Continuity supplies the compiled briefing.

![Recorded cold-handoff benchmark. Primitive alone: 320/650, 49.2%. With Continuity: 447/650, 68.8%. Paired domain bars show the five domain results listed below.](assets/readme/handoff.svg)

| Metric | Primitive alone | Primitive + Continuity |
| :--- | ---: | ---: |
| **Cold-handoff success** | **320/650 · 49.2%** | **447/650 · 68.8%** |
| Critical facts correct | 61.7% | 84.0% |
| Current-state accuracy | 83.1% | 96.3% |
| Correct next action | 76.6% | 78.8% |
| Agent input at decision time, rounded | 12.7K tokens | 7.0K tokens |
| Reported cost per case, including ingestion | $0.0043 | $0.0044 |

<details>
<summary>Domain results and how to read this comparison</summary>

| Domain | Primitive alone | Primitive + Continuity |
| :--- | ---: | ---: |
| Finance | 37/130 · 28.5% | 64/130 · 49.2% |
| Freight | 51/130 · 39.2% | 92/130 · 70.8% |
| Hotel | 81/130 · 62.3% | 87/130 · 66.9% |
| Legal | 77/130 · 59.2% | 107/130 · 82.3% |
| Procurement | 74/130 · 56.9% | 97/130 · 74.6% |

- **Evidence:** the final held-out comparison in [bench/FINDINGS.md](bench/FINDINGS.md), recorded 2026-10-18.
  The [chart data](assets/readme/metrics.json) preserves the numerators and source. Per-case raw runs are not checked in,
  so these charts visualize the report; this presentation pass did not independently re-grade those runs.
- **One trial per cell.** Scenarios are synthetic. The findings disclose that the held-out hotel breakdown was
  inspected before a later fix developed on the dev split. Treat the result as preliminary.
- **Token scope matters.** Agent input excludes Continuity’s ingestion work. Cost includes ingestion and excludes the
  judge, using the benchmark’s dated price table. The single-decision cost is similar between conditions.
- **Remaining gap:** open-loop F1 is reported at about 38% for both conditions. Better state accuracy does not imply
  every obligation is recovered.

See the [benchmark methodology](bench/README.md) for conditions, labels, scoring and reproduction commands.
The earlier [six-scenario Claude API demonstration](eval/results/llm-api-2026-10-17/README.md) includes individual
decisions and its own grading caveats; it is a separate experiment.

</details>

### Context size as history grows

![Log-scale chart of estimated context tokens. At 267 messages the full transcript with quoted replies reaches 2,769,089 tokens, while the compiled briefing uses 1,596. All six measurements are listed below.](assets/readme/context-growth.svg)

| Messages | Quoted transcript ≈ tokens | Compiled briefing ≈ tokens |
| ---: | ---: | ---: |
| 10 | 1,569 | 989 |
| 17 | 3,908 | 1,058 |
| 37 | 19,375 | 1,165 |
| 73 | 84,609 | 1,375 |
| 137 | 448,626 | 1,481 |
| 267 | 2,769,089 | 1,596 |

Rerun on **2026-10-18** with `node eval/scale.ts`; all values are `chars / 4` estimates, not model tokenizer counts.
The synthetic mail includes repeated quoted replies, which amplifies transcript growth. This chart does not compare
against a dequoted transcript or measure inference speed. On short, unquoted histories, the briefing can be larger
than the transcript. Its purpose is structured state and evidence, with size driven by retained terms and open items.
Source: [scaling script](eval/scale.ts) and [recorded measurements](eval/results/scale.json).

## How it works

```mermaid
flowchart TB
    subgraph Mail["Primitive mail"]
        Receive["Signed webhook or inbox receiver"]
        Send["Threaded reply"]
    end
    subgraph Engine["Continuity"]
        Log[("Append-only events and proposals")]
        Extract["Claude or rule extractor"]
        Resolve["Deterministic resolver"]
        State[("Terms, obligations, documents and checks")]
        Compile["Cited context compiler"]
        Guard{"Send guard"}
        Human["Human approval when required"]
    end
    Agent["Fresh agent via HTTP or MCP"]
    Receive --> Log --> Extract --> Resolve --> State
    State --> Compile --> Agent
    Agent -->|draft and state version| Guard
    State --> Guard
    Guard -->|allowed| Send
    Guard -->|held| Human --> Send
    Guard -->|blocked| Agent
```

1. [Normalize and link](src/ingest/) mail using provider IDs, reply headers and explicit task references.
2. [Extract](src/extract/) a proposal from the email and attachment text. The model proposes changes.
3. [Resolve](src/engine/resolver.ts) those proposals deterministically, respecting authority, chronology and domain checks.
4. [Compile](src/compiler/) current state into a cited briefing, keeping blockers and open obligations even if they exceed the requested budget.
5. [Guard](src/engine/guard.ts) outgoing drafts against state and version; [approval cards](src/approvals.ts) route held sends to a separate approver.

### Engineering choices

| Constraint | Approach | Tradeoff |
| :--- | :--- | :--- |
| A new email can contradict an established term. | Keep immutable evidence and extraction proposals; only the resolver changes the projection. Claims stay scoped to the speaker and their authority. | Typed domain vocabulary and checks need maintenance. |
| Agents can restart or work from stale state. | Persist task state outside the agent, expose per-agent change cursors, and require state versions for hosted sends. | Stale decisions must be refreshed; sends wait while interpretation is incomplete. |
| Model calls may be slow while mail keeps arriving. | Store mail first, lease ordered jobs, interpret outside a database transaction, then commit with a version check. | A concurrent state change can require re-interpretation. |

Read [ARCHITECTURE.md](ARCHITECTURE.md) for replay, idempotency, worker recovery and approval persistence.

## Use it from an agent

With a running server, retrieve a text briefing over HTTP:

```bash
curl -H "Authorization: Bearer $CONTINUITY_TOKEN" \
  'http://localhost:4100/tasks/PO-4817/context?agent=agent-b&format=text'
```

The task alias works wherever a task ID is accepted. Hosted operation requires a scoped token.
The stdio MCP server exposes context, open loops, term explanations, provenance, changes, guarded sending and cursors:

```bash
node src/mcp.ts
```

See the [API and MCP reference](docs/guide.md#agent-facing-interface) and [configuration table](docs/guide.md#environment).

## Development

```bash
npm test                         # unit and integration tests; Supabase cases require configuration
npm run typecheck                # TypeScript, no build output
npm run eval                     # offline: 10 scenarios, 42 state assertions, 6 policy-agent handoffs
node bench/run.ts validate       # validate 1,365 generated benchmark cases
node bench/run.ts selftest       # calibrate the scorer without model calls
npm run readme:assets -- --check # check generated graphics against their source data
```

Regenerate the graphics with `npm run readme:assets`. See [visual sources](assets/readme/README.md) for provenance.
Claude evaluation and live-mail benchmarks require their provider keys; the [environment template](.env.example)
and [operations guide](docs/guide.md) describe setup. Supabase tests use an explicitly configured local stack.

```text
src/ingest/        Mail normalization, sender authentication, task linkage and attachments
src/extract/       Model and rule extractors producing the same proposal format
src/engine/        Resolver, send guard, replay and transition log
src/compiler/      Context selection and briefing rendering
src/domain/        Typed terms, requirements and checks for each domain
src/store/         Postgres, SQLite and in-memory backends
src/agent/         Fresh-process Claude and offline policy agents
src/server.ts      HTTP API, ingestion endpoints and observability console
src/mcp.ts         Stdio MCP interface
supabase/          Private database schema and local stack configuration
test/, eval/       Tests, scenario evaluations and scaling measurements
bench/             Five-domain comparison harness, findings and methodology
site/, video/      Browser presentation and automated demo-video tooling
```

**Runtime:** TypeScript runs directly on Node. Primitive supplies mail; Claude is the optional language interpreter.
Supabase Postgres is the authoritative hosted store; SQLite and memory are explicit offline modes.

## Status and limits

Continuity is an experimental engine with a runnable local demo, API, MCP interface and benchmark harness.
The rule extractor is an offline fallback tuned to scenario patterns. Real anonymized, independently labelled mail
and human agreement in shadow mode are still needed before claiming production readiness. Guards, sender checks and
approval scopes reduce risk; they do not establish a general guarantee against prompt injection.

For bugs or improvements, include a minimal reproduction, the storage and extractor modes, and the relevant test or
scenario. Remove credentials and private email before sharing. Changes should preserve evidence, authority, replay
and approval behavior; [architecture](ARCHITECTURE.md) explains those boundaries.

[Demo walkthrough](DEMO.md) · [Operations guide](docs/guide.md) · [Benchmark authoring](bench/AUTHORING.md) · [Changelog](CHANGELOG.md)

## License

Continuity is **open source under the [MIT license](LICENSE)**. Use, modify and redistribute it under those terms.
Third-party dependencies retain their own licenses. Live Primitive and Claude usage requires the respective service accounts.
