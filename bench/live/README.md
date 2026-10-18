# Live Primitive mode

The benchmark normally replays each case's mailbox locally, in Primitive's data shapes. Live mode sends the same
cases as **real email through Primitive** between inboxes on your own domain, then runs the conditions against what
Primitive actually stored:

- **Primitive only** (`primitive-native`): the agent's read tools call the real Primitive API: list, search, email,
  sent email, thread, conversation and attachment.
- **Primitive + Continuity** (`continuity`): Continuity ingests each message the way production does
  (`GET /emails/{id}`, attachment bytes downloaded from Primitive, our own sends from `GET /sent-emails/{id}`).

```bash
node --env-file=.env bench/run.ts live-check                                         # read-only account preflight
node --env-file=.env bench/run.ts live-deliver --live smoke --split golden --verticals procurement   # prints the plan, sends nothing
node --env-file=.env bench/run.ts live-deliver --live smoke --split golden --verticals procurement --yes-send
node --env-file=.env bench/run.ts run --live smoke --split golden --verticals procurement --conditions primitive-native,continuity
node bench/run.ts run --live dry --fake --mock --split golden --verticals procurement   # whole pipeline in memory: nothing sent, no model calls
```

`live-deliver` writes `bench/results/live/<name>/manifest.json` after every message. Re-running it resumes, and every send
carries an idempotency key derived from (run, case, message), so a crash or a repeat never sends a message twice.
`run --live` only reads: its client has a send cap of zero.

## What is real and what is mapped

| | Live run |
|---|---|
| Delivery, Message-IDs, threading (`thread_id`, In-Reply-To, References) | real |
| Bodies as Primitive parsed them, cc, attachments (bytes stored by Primitive, downloaded and extracted) | real |
| SPF/DKIM/DMARC verdicts, `awaiting`, `reply_count`, `automated`, search results and ranking | real |
| Row ids the agent sees and cites | real Primitive ids (mapped back to oracle keys for scoring) |
| Addresses | each case address gets a unique address on your domain; agents see the case's own addresses |
| Domain inside Message-IDs | Primitive mints every id on your domain; agents see the sender's case domain (In-Reply-To and References stay consistent) |
| Timestamps | mapped to the case's scripted clock (deadlines and "overdue" are written against it) |

Each case address becomes `b<run><case>.<name>-<domain hash>@<your domain>`. The run and case tags keep runs and cases
apart in one inbox. The domain hash keeps look-alike domains distinct.

## Delivery checks

After a case is delivered, every message is compared with what the case says was sent. **Faults** take the case out of
the live run, and the report lists them:
- a message that never arrived or was rejected;
- the wrong sender or subject, or broken In-Reply-To;
- an author's text missing from the stored body;
- an attachment missing or losing lines;
- a sender that did not authenticate.

**Differences** are real Primitive behaviour, so they are kept and listed:
- quoted history reformatted;
- a sender name changed;
- a reply placed in a new thread;
- cc not echoed;
- `awaiting` differing from what an outside counterparty would give.

## Latency

The receiver long-polls Primitive's inbox tail: the server answers as soon as mail lands, and a direct lookup is the
fallback. There are no fixed sleeps. Within a case, each inbound message must arrive before the next is sent, so
Primitive sees the case's order. Cases run side by side (`--live-concurrency`), and sends are paced at 90% of the
account's hourly limit (`--per-hour`). Arrival latency (p50/p95) is in the delivery summary; time spent in Primitive
calls is in each row's diagnostics (`primitive_ms`). The agents' clock is the case's clock, so delivery latency cannot
change a result.

## Safety

- Mail is only ever addressed to your own domain. This is checked before every send, and the fake refuses anything else.
- `live-deliver` sends nothing without `--yes-send`. `--max-sends` (default 300) is a hard cap per process.
- Benchmark mail contains prompt injections and fake bank-detail changes. Delivery refuses to start while a webhook or
  Function processes the inbox, unless you pass `--allow-processing`.
- Agents only draft. Nothing a benchmark agent writes is ever sent.
- The read tools only return rows that belong to the case. Ids from anywhere else come back `not_found`, and list and
  search are filtered by the case's inbox address and the run's start time.
- Signed download links and account internals are never passed to a model or written to results.
- The API key stays in the SDK client, and error text is redacted before it is printed or stored.

## First live run (2026-10-18, golden procurement, `--live smoke`)

- **82 emails sent, 0 lost, 0 duplicated.** Three sends were retried after the fix below; Primitive's idempotency key
  handed back the original send each time.
- **12 of 13 cases delivered with no faults.** The spoofed-sender case stayed replay-only.
- **Arrival latency** from send to visible in the agent's inbox: p50 113 ms, p95 806 ms, max 2.6 s. The read tools
  averaged ~97 ms per call.
- **Continuity on real Primitive mail produced exactly the same engine state as the replay** on all 12 cases: briefing
  size, state scores and linkage. This was checked with the rule extractor, so no model calls were made.
- **Primitive-native tools returned exactly each case's own rows** (inbox, sent, thread, conversation, search,
  attachments): 130 results checked, none containing our domain or run tag, and 32/32 reply chains intact.

Primitive behaviours found, and handled:
- **A sent row's Message-ID lags the send by ~300 ms.** The client re-reads the row until the Message-ID is there.
- **A non-ASCII subject on a message sent with a Cc is stored still RFC 2047-encoded**, e.g.
  `=?UTF-8?Q?Re=3A_RFQ_…_=E2=80=94_PO-4?= =?UTF-8?Q?817?=`. This happened on 6 of 85 rows, all of them messages with a
  Cc; the same subject without a Cc decoded fine 24 times.
  - Continuity's ingestion now decodes encoded words (`decodeMimeWords` in `src/ingest/normalize.ts`).
  - The Primitive-native agent sees the subject as Primitive's API returns it.
  - The delivery check records this as a difference, not a fault.

## Limits

- **Spoofed-sender cases are replay-only.** Mail sent from your own domain always passes DMARC, so a forged From cannot
  be reproduced. These cases are listed as n/a with the reason.
- **Every party shares one Primitive org.** The counterparty's copy of a message is a row too. The delivery check flags
  any case where that makes `awaiting` differ.
- **Send limits:** 1,000/hour and 10,000/day on the current plan. All 65 golden cases are about 465 emails (~32 min).
  The full dev or eval split (~650 cases) does not fit in a day. Live mode is for the golden set and samples; the
  replay covers the full splits.
- **Semantic search is not offered to the agent.** It has no recipient filter, so it cannot be scoped to one case.
- **Benchmark mail stays in the inbox after a run.** Delete it from the Primitive dashboard if you want it gone.
