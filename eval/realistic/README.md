# Realistic threads: messy business email with known answers

30 synthetic deal threads (15 procurement, 15 real estate) written in the style of **real** business
email, scored against the real engine.

```bash
npm run eval:realistic                          # offline: rule-based extractor + offline policy agent
npm run eval:realistic -- --extractor llm       # Claude extractor (needs ANTHROPIC_API_KEY)
npm run eval:realistic -- --only P01,R03 --verbose
node eval/realistic/validate.ts                 # check every thread file
```

## How the threads were made

1. **Real email, studied for style.** A sample of real deal threads from the public Enron corpus (CMU 2015
   release, via Hugging Face `corbt/enron-emails`) was mined for threads with several senders and changing
   numbers. What makes them hard — nested "Original Message" history that keeps repeating old values,
   changes written as "change X from A to B" rather than "correction", tables, terse shorthand, distractor
   numbers, empty forwards, subject drift — is written down in [STYLE.md](STYLE.md). No real text, names or
   numbers are reused.
2. **Each deal scripted first.** Who says what and when, which value replaces which, which promise is kept —
   so the correct state at every checkpoint is known by construction, not labelled afterwards.
3. **Emails written to the style guide**, with the script's facts placed inside them.
4. **Validated** ([schema.ts](schema.ts)): every gold term must quote, verbatim, the words that state it in
   the new text (above any quote) of the message it cites; message threading, parties, term keys, value
   formats and checkpoint order are checked. The rules the gold follows are in [AUTHORING.md](AUTHORING.md).
5. **Revised 2026-10-18:** our own offer terms in the real-estate threads are labelled consistently
   ([AUTHORING.md](AUTHORING.md) rule 13). Before, the gold listed our offered price in some threads and not
   others (R13's opening offer but not R01's), and never our offered closing dates.

Each thread names the hard cases it exercises (`features`): buried corrections, from/to changes, partial
updates, contested values between two people on the same side, hedges, speakers without authority, forged
senders, late forwards of old offers, promises "attached" with no attachment, document versions,
answered and unanswered questions, subject drift, distractor numbers, withdrawals, money details held for
a human, terse shorthand, tables, noise mail, long threads, acceptances.

## What is scored (per checkpoint)

| Metric | Meaning |
|---|---|
| checkpoint fully right | every current term right, no wrong extras, disputes contested, replaced and must-not-apply values not current, next actor right |
| current terms found / correct | recall and precision of applied terms (same party, term and normalized value) |
| disputes flagged as contested | same-side disagreements left contested, not silently resolved |
| replaced values no longer current | corrections took effect |
| statements that must not apply, not applied | hedges, unauthorized speakers, forged senders, stale forwards, held money details |
| obligations found / status right | who owes what, and whether it was answered or fulfilled |
| document status, requirement checks, who acts next | as named |
| fresh agent email passes rubric | the offline policy agent's email at the checkpoint, against must / must-not patterns |

Results are broken down by hard case and written to `results/latest-<extractor>.json`.

## First results (rule-based extractor, offline, 2026-10-17)

30 threads, 87 checkpoints, `npm run eval:realistic`:

| Metric | Result |
|---|---|
| checkpoint fully right | 8% (7/87) |
| current terms found | 51% (243/473) |
| current terms correct (no wrong extras) | 68% (243/356) |
| replaced values no longer current | 62% (56/90) |
| statements that must not apply, not applied | 71% (17/24) |
| disputes flagged as contested | 0% (0/8) |
| obligations found / status right | 55% / 59% |
| who acts next right | 56% |
| fresh agent email passes rubric | 27% (12/45) |

On the clean scripted scenarios in `eval/scenarios.ts` the same extractor passes every assertion; on
realistic text it gets most checkpoints at least partly wrong. That gap is what this set exists to show.

**Bug it found:** the rule-based extractor's quote detection (`QUOTE_HEADER` in `src/extract/heuristic.ts`)
only recognises `-----Original Message-----` at the very start of a line. Real Outlook mail (and the Enron
threads this set is modelled on) writes it with a leading space, and Lotus Notes headers
(`Name/ORG@ORG` + date) and `From:` lines without an address are missed too — so the whole quoted history
is read as new statements and old values come back. A one-line fix to those patterns (measured, not
committed) raises current terms found to 64%, terms correct to 88% and replaced values no longer current to
80%. The remaining misses are extraction patterns (units like "/roll", shorthand such as "bal 1100 tue
11/24"), contested detection, and obligation tracking. The Claude extractor run needs an API key.

## Honest limits

- **Synthetic, not real.** The language is modelled on real mail; the deals are invented. This measures how
  Continuity copes with realistic messiness, not real-world accuracy. A real-thread pilot (double-annotated
  Enron threads) is still the stronger evidence.
- **Same model family.** The threads were written with Claude. Continuity's LLM extractor is also Claude,
  which may make the text easier for it than human-written mail would be.
- **The gold follows Continuity's product rules** where a rule is a product decision (hedged statements are
  not applied; only authorized speakers set terms; money details wait for a human). It tests that the
  engine applies its own rules to messy text, not whether those rules are right.
- **The offline extractor is pattern-based** and tuned on clean scenario text; expect it to struggle here.
  That gap is the point of the set. The Claude extractor run needs an API key.
