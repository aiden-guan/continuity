# Continuity benchmark

**The claim under test:**

> In asynchronous email work where facts change, obligations stay open, evidence is spread across threads and
> attachments, and agents restart, Continuity lets a *fresh* agent recover the right coordination state and take the
> right next action, with less context than replaying the history.

The claim is deliberately narrower than "Continuity is better memory", and it is measurable. Baselines are built as
strong, fair versions of what people actually ship. They are not straw men.

## Verticals

| Vertical | Setting | Why it is here | Continuity pack |
|---|---|---|---|
| **Procurement** | Buyer agent ↔ supplier, freight forwarder, internal finance | The reference domain: quotes, delivery lots, budgets, corrections | ✅ `procurement` |
| **Freight brokerage** | Booking agent ↔ carrier dispatch, driver, consignee, ops | Rate confirmations, pickup/delivery windows, multi-carrier quotes, remit-to fraud | ❌ not yet. The condition reports "unsupported" until a `freight` pack exists |
| **Hotel group sales** | Meeting planner ↔ hotel sales, revenue manager, finance | Contract redlines, nightly room blocks, attrition/cutoff, deposit wire fraud | ❌ not yet (`hotel`) |
| **Finance (AP/AR)** | AP agent ↔ vendor billing, account manager, controller, requester | Invoices and credit memos, installment plans, disputes, 3-way match, business-email-compromise bank changes | ❌ not yet (`finance`) |
| **Legal (contracts)** | Legal-ops agent ↔ vendor counsel, vendor sales lead, General Counsel | Clause-level redlines, fallback positions, sign-off authority, signature pages, spoofed "execution versions" | ❌ not yet (`legal`) |

The freight, hotel, finance and legal scenario sets exist so the next domain packs are judged on cases written *before* the packs
were. They are not fitted to them afterwards.

## Scenario archetypes (13 per vertical)

Each archetype isolates a capability and contains a **trap** that defeats a predictable shortcut. The full table is in
[AUTHORING.md](AUTHORING.md).

- **P0:** `correction`, `unanswered_subquestion`, `stale_document`, `cold_handoff`, `unauthorized_change`, `injection`.
- **P1:** `cross_thread`, `partial_fulfilment`, `withdrawn_offer`, `contradiction`, `late_evidence`, `competing_offers`, `supersession_chain`.

Every archetype has variant 0 (golden, hand-written), variants 1–10 (`dev`) and variants 11–20 (`eval`, frozen by
hash). That makes 13 × 21 = **273 cases per vertical**, **1,365** across the five.

Variants change:
- the wording (at least 3 paraphrases per key message);
- names, amounts, quantities and dates (always calendar-correct);
- the date style (weekday only, "Oct 23", "10/23");
- the structure (in-thread or a new thread using the deal reference, event order, who speaks);
- the amount of background mail (other deals, including a **look-alike deal with the same counterparty**, plus
  promos and newsletters) and of state-neutral chatter.

**Scale axis.** `--backlog N` appends N state-neutral messages after the last meaningful event. The labels don't
change, but the critical facts drift away from the newest mail. Plotting accuracy and context size against N
(e.g. 0, 40, 160) gives the scaling curve.

**Robustness axis.** `--mess 1,2,3` applies the real-world mess transform (`core/perturb.ts`):
- `[EXTERNAL]` tags, signatures, mobile footers and legal disclaimers;
- HTML-to-text artefacts;
- out-of-office replies and read receipts;
- forwards of unrelated threads and newsletters with tracking links.

It is meaning-preserving by construction: no digit, date, weekday or amount is added to or moved within task mail, and `assertMeaningPreserved` checks this for every case.

## Conditions

Every condition uses the **same model** (default `claude-haiku-5-5`) for every call, the same system prompt, the
same output schema, the same task header (goal, parties with authority, hard requirements, current time) and the
same new message. Only the memory block differs.

| Condition | What the fresh agent gets | Model calls before acting |
|---|---|---|
| `primitive-native` | The new message as a Primitive `EmailDetail` (with thread-level `awaiting`). Then up to **6 calls** to Primitive-shaped read tools: list/search inbox (inbound only, as in Primitive), list sent, get email, get thread (no bodies), get conversation, get attachment. Everything it read becomes its memory. | tool loop at decision time |
| `retrieval` | The top 8 chunks (emails and attachments, from **task and unrelated mail**) by BM25 against goal + new message, up to about 2,000 tokens. A **substitute** for Primitive `/semantic-search`, which needs the Pro plan (this account is on Developer). | — |
| `rolling-summary` | A summary of at most 700 words, rewritten by the model after every task email | one per email (ingestion) |
| `agent-notes` | Structured JSON notes in the same schema as the state report, rewritten by the model after every task email. This is the model-only competitor: does the deterministic resolver beat letting the model keep its own state? | one per email (ingestion) |
| `full-history` | Every task email in order, quoted replies included as delivered, plus attachment text. The expensive reference. | — |
| `continuity` | The whole inbox replayed through the real engine (Primitive webhook payload → normaliser → linker → model extractor → deterministic resolver → compiler). The agent gets the compiled briefing. | one extraction per linked email (ingestion) |
| `continuity-rules` | The same with the rule-based extractor. Diagnostic: how much depends on the extractor? | — |
| `oracle` | The ground-truth state rendered as a briefing. This is the **actor ceiling**, not a competitor. | — |

**Generous to the baselines.** Full history, the rolling summary and the notes are handed *ground-truth* task
membership, so they never see unrelated mail. Continuity replays the whole inbox and has to do its own linking.

## Two experiments, one run

1. **Representation.** How right is the state the agent works from? Every condition's actor writes a structured state
   report, which is scored deterministically. For Continuity, the engine's own state is also scored directly, before
   any actor reads it.
2. **Utility.** Does that state make the agent act correctly? The decision is scored against required, optional and
   prohibited conditions. These are deterministic checks where possible (recipients, binding language with negation
   handling, emails to outsiders); everything else goes to a **blind judge**. The judge sees only the case's
   ground-truth facts, the drafts and plain-language statements under neutral ids. It never learns which system wrote
   the drafts or whether a statement is required or prohibited. Its agreement with hand labels is measured by
   `npm run bench:judge-calibration`.

## Metrics

| Metric | Definition |
|---|---|
| **Cold-handoff success (CHS)**, the headline | The next action is correct **and** every critical state item is right. |
| Next-action success (NAS) | All required conditions met, no prohibited one, and the right kind of action (send or wait). |
| Current-state accuracy (CSA) | The share of labelled (party, term) keys with the right canonical value and status, with no contradicting value also reported as current. Reported micro, and macro over archetypes. |
| Superseded-fact error rate | Superseded values reported as current (state), or relied on in the emails (action). |
| Open-loop P / R / F1 | Loops are identified by (debtor, subject). An answered or fulfilled loop reported as open counts as a "zombie" false positive. |
| Provenance (EPA) | The share of correctly valued current terms that cite an allowed source message. |
| Safety violations | Prohibited safety conditions met (obeying injected text, emailing a spoofer, adopting unverified bank details). Zero tolerance. |
| Tokens | Memory tokens (an estimate) and provider-reported actor input tokens. |
| Cost | Provider-reported usage priced with the dated table in `core/llm.ts`. Reported as cost per decision (retrieval + actor) and ingestion cost per case. The judge is excluded. |

## Statistics

- Every condition sees the same cases, so all comparisons are **paired**.
- Paired bootstrap 95% CIs are computed over cases (10,000 resamples) for differences in CHS, CSA and tokens.
- An **exact McNemar** test is run on binary outcomes.
- Raw numerators and denominators are always printed next to percentages.
- `--trials N` repeats every cell (it has its own cache key), because Haiku 5.5 has no temperature control.
- The golden cases are unit tests. They are not statistics.

## Guarding against fooling ourselves

- **The labels are independent of the code under test.** Generators may import only `core/types` and `core/util`;
  `test/bench-leakage.test.ts` fails if any scenario code imports from `src/`. Labels follow the semantics a
  domain expert would assign.
- **Held-out split.** `node bench/run.ts freeze` writes sha256 hashes of every eval case to `bench/manifest.json`.
  A run on `eval` refuses to start if any case has changed. Tune on `dev` only.
- **Scorer calibration.** `node bench/run.ts selftest` scores synthetic outputs for every case:
  - a perfect report must score exactly 1;
  - a report using stale values must register superseded-fact errors;
  - reporting closed loops as open must register zombie loops;
  - an empty report must fail its critical items.

  It also checks binding-language and negation detection.
- **Determinism.** Generating the same variant twice gives a byte-identical case, and a cached response is reused
  only for the same request and trial.
- **Shared mailbox.** One materialisation feeds every condition: the same message ids, quoting, threads and
  attachment text.

## Layered evidence (beyond the head-to-head)

| Layer | What it shows | Where |
|---|---|---|
| Scorer calibration | A perfect report scores 1, stale values and zombie loops are caught, and empty reports fail, on every case | `node bench/run.ts selftest` |
| Label independence | Generators cannot import the system under test | `test/bench-leakage.test.ts` |
| Label audits | Each vertical was reviewed by an agent that didn't write it, acting as a domain expert; fixes were applied, judgement calls recorded | the file headers in `bench/verticals/*` |
| Judge reliability | 200+ hand-labelled drafts (strong, flawed, adversarial edge cases) across all five verticals, with per-condition agreement and false-met / false-unmet counts. Each fixture snapshots its condition text, so rewording forces a relabel. | `npm run bench:judge-calibration`, `test/bench-judge-fixtures.test.ts` |
| Resolver guarantees | Property-based fuzzing of the deterministic resolver (about 3,000 random event sequences). Covered: replay determinism, no silent overwrite by uncertain extraction, authority, idempotent redelivery, newer ≠ truer, late evidence, structural invariants. Known gaps are recorded as `todo` findings. | `test/resolver-properties.test.ts` |
| Robustness | The same cases with meaning-preserving mail mess | `--mess 1,2,3`, `test/bench-perturb.test.ts` |
| Scale | The same cases with growing backlogs | `--backlog 0,40,160` |

## What has to be true before claiming "frontier"

1. Continuity beats `primitive-native`, `retrieval`, `rolling-summary` **and `agent-notes`** on cold-handoff success on the
   **frozen eval split**, with paired CIs that exclude 0.
2. It stays within 5 pp of `full-history`, and wins on the backlog curve and on cost.
3. It has **zero** safety violations.
4. That holds in more than one vertical. Today only procurement has a domain pack, so freight, hotel, finance and legal
   report Continuity as *unsupported* until their packs exist. Those cases were written first, so the packs cannot be
   fitted to them.
5. The `oracle` row shows that remaining failures are the actor's, not the memory's.

## Running

```bash
npm run bench -- list                                        # 1,365 cases (5 verticals × 13 archetypes × 21)
npm run bench -- validate && npm run bench -- selftest       # no model calls
npm run bench -- show procurement/correction/3 --condition retrieval   # exactly what that actor would see
npm run bench -- estimate --split dev --verticals procurement          # cost estimate, no model calls
npm run bench -- run --mock --split golden                   # whole pipeline, no provider calls
npm run bench:judge-calibration                              # judge vs hand labels (model calls)
npm run bench -- freeze                                      # once, before the first eval run
npm run bench -- run --split golden --verticals procurement  # smallest real run
npm run bench -- run --split dev --backlog 0,40,160 --trials 3
npm run bench -- report bench/results/<name>
```

Results go to `bench/results/<name>/`: `rows.jsonl` holds every cell (agent output, all scores, usage, diagnostics),
alongside `report.md` and `summary.json`. Runs resume: cells already in `rows.jsonl` are skipped, and cached responses
in `.scratch/bench-cache/` are reused.

## Honest limits

- The scenarios are synthetic, though realistic and reviewed. Real anonymised threads labelled by domain experts are
  the next step before claiming production readiness, followed by shadow-mode agreement with humans on live traffic.
- Primitive-native runs on a replayed mailbox with Primitive's documented shapes, not the live API. That keeps it
  deterministic, but live smoke tests belong in `npm run demo:live`.
- The retrieval baseline is lexical (BM25), because Primitive semantic search is Pro-gated on this account.
- The ship gates in the report are engineering targets, not academic standards.
