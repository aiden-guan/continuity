# Value benchmark

A complementary track to the correctness benchmark in `bench/` (owned by the optimization session). It asks
narrower questions that follow from Continuity's architecture, an append-only event log plus a deterministic
resolver plus a compiled briefing, and measures them against fair Primitive-only baselines on cases built for
the purpose.

It reuses `bench/core` (mailbox, actor, judge, scorer, statistics) and `bench/conditions` unchanged. Only the
cases and the runners are new; everything lives in `bench/value/`, results in `bench/results/value-*`.

## Hypotheses

| # | Architectural property | Hypothesis | Figure |
|---|---|---|---|
| H1 | The resolver applies every change in order; the agent reads the result instead of re-deriving it | The more interdependent changes a deal has gone through, the larger Continuity's lead over agents that rebuild the state from mail | Fig 1: success vs dependency depth |
| H2 | The linker joins threads into one task; state is per task, not per thread | Spreading the same changes over more threads hurts mail-reading agents more than Continuity | Fig 1b: success vs thread count |
| H3 | State is built once as mail arrives and reused at every wake | Lifetime cost per correct decision is lower for Continuity, and the gap grows with the number of wakes | Fig 2: cost vs wakes |
| H4 | The log keeps superseded values with the message that replaced them, and can rebuild the state as of any event | "What did we know at message X?" and "which message replaced value V?" are answered more accurately from the log than from mail, a summary or a latest-state snapshot | Fig 3: history questions |

Commitment tracking and supersession are not separate figures. They are steps inside the Fig 1 chains
(promised quote owed, "attached" with no attachment, partial answers; corrections, reverts, budget
re-approvals), and their per-item results are reported there.

## Cases (`chain.ts`)

One procurement deal: RFQ, quote PDF, finance approval in its own thread. Then D changes drawn from:

| change | what happens | what a correct answer must reflect |
|---|---|---|
| `price_up` | supplier corrects the unit price upward, above the approved cap | new price; old price dead; over budget |
| `budget_raise` | finance approves a higher cap (we ask, they approve; or they raise it unprompted) | new cap; old cap dead; over-budget resolved |
| `price_hold` | supplier goes back to its original price | original price current again; the raised price dead |
| `split` | only part arrives by the deadline; revised quote promised | late units; revised quote owed |
| `restore` | full delivery by the deadline again; updated quote promised | late units resolved; updated quote owed |
| `revised_quote` | the promised quote arrives as a PDF with the current terms | promise kept; earlier PDFs superseded |
| `quote_missing` | "quote attached", nothing attached | still owed |
| `forwarder_date` | the supplier's forwarder states a later delivery date | disputed date (neither side settled) |
| `settle` | supplier and forwarder confirm the supplier's date | dispute resolved |
| `ops_price` | supplier operations (no pricing authority) mentions a price | not applied; must not be used |
| `partial_answer` | we ask two things; the supplier answers only the easy one | the hard question still open; the easy one must not be re-asked |

Finance then asks whether the order can be placed. The fresh agent must report the state and act: tell finance
every open problem (or that nothing blocks the order), press the supplier on what is theirs, and not use a dead
fact or commit while blocked.

- **Depth family** (`value_chain_d1/d2/d4/d6`): D = 1, 2, 4, 6. Total task mail is fixed at 16 messages at every
  depth (state-neutral chatter fills the gap), so depth varies and volume does not. Background mail (a look-alike
  deal with the same supplier, promos) is mixed in as in `bench/`.
- **Fan-out family** (`value_fanout_t2/t5/t8`): the same six changes with identical text, spread over 2, 5 or 8
  state threads (only the threading differs between levels, so the comparison is paired across thread counts too).
- About a third of cases end "all clear" at every depth, so over-caution is tested as well as missed problems.

**Labels.** The generator simulates the chain on plain numbers to sample it, then writes the mail while tracking
evidence per term; the two passes must agree or generation throws. Nothing under `bench/value/` that builds
cases imports from `src/`. `node bench/value/run.ts validate` runs the structural validator and the scorer
self-test on every case.

**Splits.** Variants 1–10 are dev (grader calibration only), 11–22 are eval, frozen by hash in
`manifest.json`. Graders were calibrated on dev against the *oracle* condition only (an actor handed the true
state), until it reached 90.5%. Each change is commented at its condition in `chain.ts`. One generator change was
made after freezing and before any eval result was read (commit `da21ea7`: no supplier schedule change after
the forwarder has stated a date, because the label for that pattern was ambiguous). It changed 3 eval cases,
none of which had been run.

## Conditions

All conditions use the same model (`claude-haiku-5-5`), the same actor prompt and schema, the same judge, and
the same task header. Only the memory differs (see `bench/README.md`):

- `primitive-native`: the new message plus up to 6 Primitive-shaped read tools (list/search inbox, sent,
  thread, conversation, attachment).
- `full-history`: every task email, handed ground-truth task membership (generous).
- `rolling-summary`: a ≤700-word summary rewritten after every task email (economics and history figures).
- `agent-notes`: model-maintained structured notes, a latest-state snapshot (history figure).
- `continuity`: the whole inbox replayed through the engine (model extractor, resolver, compiler) at the
  extractor setting the optimization track uses (`CONTINUITY_EXTRACTOR_THINKING=off`,
  `CONTINUITY_EXTRACT_ROUTE=skip-empty,outbound-plain-rules`).
- `oracle`: the true state as a briefing; the actor ceiling, not a competitor.

## Metrics

- **Handoff success**: the decision meets every required condition and breaks no prohibited one, *and* every
  critical state item is right (price, cap, schedule, owed quote, open conflicts, no superseded fact reported
  as current). Same definition as `bench/` cold-handoff success.
- **Blockers caught**: share of required decision conditions met (one per open problem, or the go-ahead when
  there is none). Channel checks (`to_finance`, `to_supplier`) are excluded.
- **Used a dead fact**, **committed while blocked**: from the stale and commitment conditions.
- **Cost**: provider-reported tokens priced at `bench/core/llm.ts`. Reported all-in (ingestion + reads + actor;
  judge excluded) and cold-cache (every input token at the full price).
- **Statistics**: per-case means over trials; 95% CIs by bootstrap over cases; paired sign-flip permutation
  test on per-case differences; McNemar over (case, trial) pairs for comparison with `bench/` reports.

## Commands

```bash
node bench/value/run.ts validate
node bench/value/run.ts run --name fig1 --variants 11,12,13,14,15,16,17,18,19,20,21,22 --conditions continuity,primitive-native,full-history --trials 3
node bench/value/analyze.ts bench/results/value-fig1
node bench/value/wakes.ts --name wakes --archetypes value_chain_d6 --variants 11,12,13,14,15,16
node bench/value/economics.ts bench/results/value-fig1 bench/results/value-wakes
node bench/value/history.ts --name history --trials 3
```

## Coordination

- The engine is a read-only snapshot of the optimization session's working tree (commit `af69a53` on branch
  `value/bench`), so these numbers measure its Round 2 engine. Nothing in `src/` was changed here.
- Engine defects these cases turned up were sent to that session as notes, not edits.
- Runs stay at ≤ 8 provider requests in flight: both tracks share the organisation's concurrency limit.
