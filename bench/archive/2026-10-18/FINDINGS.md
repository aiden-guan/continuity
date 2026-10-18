# Continuity vs Primitive alone (2026-10-18)

**Question:** with the same Haiku agent, the same instructions and the same cases, does Continuity on top of Primitive
beat Primitive by itself on accuracy and on cost?

- **Primitive alone** (`primitive-native`): the agent wakes up with the new email and reads the inbox through Primitive's
  read tools (list, search, email, thread, conversation, attachment), up to 6 lookups.
- **Primitive + Continuity** (`continuity`): every email is read once as it arrives; the agent wakes up with the compiled
  briefing.

Both sides use prompt caching the way a production caller would: the tool loop caches its growing conversation, and every
agent caches its system prompt. Costs are Anthropic's reported usage at Haiku 5.5 prices, judge excluded, and include
Continuity's cost of reading every email.

## Results

| Run | Cases | Primitive alone | Primitive + Continuity | Cost per case (P / C) |
|---|---|---|---|---|
| Baseline, before this work (dev, procurement) | 130 | 66.2% | 70.8% | $0.0035 / $0.0083 |
| Round 1 (dev, procurement) | 130 | 63.8% | **76.9%** | $0.0031 / **$0.0028** |
| Round 2 (dev, all 5 verticals) | 649 | 52.1% | **70.4%** | $0.0043 / $0.0044 |
| Round 4 (dev, all 5 verticals) | 650 | 52.2% | **69.8%** | $0.0043 / $0.0046 |
| Held-out eval split, first run (round-3 code; shared rate limit) | 650 | 49.2% | **66.6%** | $0.0043 / $0.0043 |
| **Held-out eval split, final** (final code, no fallback reads) | 650 | 49.2% | **68.8%** | $0.0043 / $0.0044 |
| Live Primitive email, before (golden procurement) | 12 | 83% | 67% | $0.0040 / $0.0074 |
| Live Primitive email, after | 12 | 58% | **75%** | $0.0031 / **$0.0029** |

Success is cold-handoff success: the agent's next action is right **and** every critical fact in its state is right.

**Held-out eval, final run (650 frozen cases, never tuned on):** Continuity won 192 cases that Primitive lost and lost 65
that Primitive won, a difference of **+19.5 points** (95% CI 14.8–24.0, McNemar p = 9.8e-16).
- critical facts right: 84.0% vs 61.7%
- current-state accuracy: 96.3% vs 83.1%
- right next action: 78.8% vs 76.6%
- safety violations: 0 for both

By vertical: finance 64 vs 37, freight 92 vs 51, hotel 87 vs 81, legal 107 vs 77, procurement 97 vs 74. The run recorded
no failed and no fallback reads (`meta.code`: base a5e960c plus the uncommitted changes on branch
opt/continuity-beats-primitive-a5).

**Fairness check:** given 12 lookups instead of 6, Primitive alone used only 4.5 on average and went from 83 to 89 out of 130
on dev procurement, against Continuity's 104. The lookup budget is not what holds it back.

### Tokens and cost

- **What the agent reads when it decides:** 7.0k tokens with Continuity against 12.7k for Primitive alone (−45%, held-out).
- **Cost of a single decision:** about equal ($0.0044 vs $0.0043 held-out, +4%; dev rounds +2–7% for Continuity). Continuity
  pays to read every email; Primitive pays for its lookups at decision time.
- **Cost per successful handoff:** $0.0062 vs $0.0082 (−24%, round 2), because Continuity gets more of them right.
- **More than one agent wake per thread:** Continuity's reading is paid once and shared. Break-even is about 1.1 wakes per
  thread. At 2 wakes Continuity is about 20% cheaper, at 3 about 26%, and at 5 about 31% (round 2 costs; this assumes the
  same emails at every wake).
- **Long threads:** the briefing stays flat while history grows, but every email is still read once. Routine mail is now
  read by the rule extractor when it names nothing the deal is about (`skip-empty`).

## What changed

**Reading cost** (from $0.0061 to about $0.0018 per case):
- **Prompt caching in the extractor.** Instructions, vocabulary and output schema form the cached system block, and the
  task and its parties form a second cached block. Only the state and the email vary. Input cost per email fell by about
  86%.
- **No reasoning before the structured answer** (`CONTINUITY_EXTRACTOR_THINKING`, now off by default). Output fell by about a third with
  accuracy unchanged; low effort barely helped.
- **Shortest verbatim phrase as evidence.**
- **Linking.** A known sender's mail about another deal of the same kind (another PO, invoice or group code), and a
  stranger naming our part number, no longer link to the task. Unrelated mail linked fell from 278/583 to 0/583, with
  task mail unchanged at 836/836.
- **Routing** (`CONTINUITY_EXTRACT_ROUTE`, now `skip-empty,outbound-plain-rules` by default). Inbound mail that carries nothing, and our own
  outbound mail that asks, offers, promises and accepts nothing, are read by the rule extractor.

**Accuracy:**
- **Partial deliveries.** Delivered units stay in the schedule. The guidance had contradicted itself, so "first 300
  delivered, remaining 200 Monday" became just "200 Monday".
- **Deadline check.** It no longer passes "all units by Friday" when fewer units than required are scheduled.
- **Settled disputes.** A contest ends when the other side revises its value to agree, or withdraws it.
- **Briefing:**
  - answered questions show the answer;
  - a newer payment-term change held for a human says plainly that the old value no longer stands;
  - a withdrawal appears among current terms and asks for an acknowledgement;
  - a withdrawn document is one line;
  - our own request to finance no longer appears as a tentative budget figure.
- **Engine:**
  - document promises and requests count documents, not goods ("quote 750 units" is one quote, not 750);
  - questions owed by a party that withdraws are answered by the withdrawal;
  - per-party checks only run on terms the party may set;
  - stale-document lines respect a value that came back and name today's value.
- **Subject decoding** (`decodeMimeWords`). Primitive stores a non-ASCII subject undecoded on sends with more than one
  recipient; Continuity decodes it.

**Tried and reverted:**
- reading all of our own outbound mail with rules (it drops our offers, questions and acceptances);
- short field names in the output schema (more wrong extras);
- leaving default fields out of the output (same effect).

## Caveats

- **Synthetic cases.** These are scripted, reviewed scenarios; real anonymised threads are the next step.
- **One trial per cell.** Haiku has no temperature control, and paired churn between runs is about 15–20% of cases. The
  held-out difference is far outside that, but small per-vertical differences are not.
- **Hotel tied (81 vs 81) in the first held-out run.** Withdrawn offers were Continuity's weakest hotel archetype on both
  splits. They were fixed using dev cases only, and hotel led 87 vs 81 in the final run. Looking at the held-out
  breakdown by archetype before that fix is a small leak and is disclosed here.
- **Shared rate limit.** The first held-out run and round 3 overlapped another session's runs on the same rate limit. Some
  of Continuity's reads may have failed over to the rule extractor, which would make it look cheaper and less accurate.
  Runs now record failed and fallback reads (`diag.failed_reads`, `diag.fallback_reads`) and the code they ran
  (`meta.code`).
- **Not addressed yet:** open-loop F1 is still about 38% for both; the judge is strict on "please confirm X still holds".

## Reproduce

```bash
# the reader settings measured here are the defaults (CONTINUITY_EXTRACTOR_THINKING=off, CONTINUITY_EXTRACT_ROUTE=skip-empty,outbound-plain-rules)
node --env-file=.env bench/run.ts run --split eval --conditions primitive-native,continuity --name <name>
node --env-file=.env bench/run.ts run --live smoke --split golden --verticals procurement --conditions primitive-native,continuity
```
