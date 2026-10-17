# Architecture and tradeoffs

## The core idea

An email is **evidence**. State is an **interpretation** of the evidence. Continuity never lets the two blur:

| Layer | Can it change? | Who writes it |
|---|---|---|
| `events` (each inbound/outbound email with raw payload, threading headers and auth verdicts) | append-only | transport/normalizer |
| `extractions` (the proposal an extractor returned for each event) | append-only | extractor (LLM or rules) |
| `claims`, `obligations`, `artifacts`, `checks` | revisable projection | **the resolver, and nothing else** |
| `transitions` (every state change, tagged with the event that caused it) | append-only | resolver |

Language is interpreted by the LLM; what actually changes is decided by deterministic code. One uncertain model answer
therefore cannot quietly overwrite established state. At most it produces a *tentative* claim, shown but not applied.

## Pipeline

1. **Normalize** (`src/ingest/normalize.ts`). A Primitive `email.received` webhook (or a REST `EmailDetail`) becomes an
   `EventInput`. Primitive's email id is the dedupe key, so a webhook delivered twice does nothing the second time.
2. **Link to a task** (`src/ingest/link.ts`). Only explicit signals count, tried from strongest to weakest:
   1. the message was sent through Continuity for this task;
   2. its Primitive `thread_id` is already mapped to the task;
   3. `reply_to_sent_email_id` points at one of our sent emails;
   4. `In-Reply-To` / `References` name a Message-ID we know;
   5. the subject or body contains an explicit task alias (`PO-4817`).

   If none applies, the event stays **unlinked**: visible, and linkable by hand. Embedding similarity is deliberately
   not used, because merging the wrong conversation without telling anyone is worse than asking.
3. **Store** the event immutably and map its thread to the task.
4. **Artifacts**. Attachment bytes (inline, or downloaded from Primitive) are turned into text (plain/CSV/JSON, and
   text PDFs with Flate streams) and recorded as an `artifacts` row with kind, version label and sha256.
5. **Extract** (`src/extract/`) into `Proposal { claims, obligations, resolutions, artifacts, injection_flags }`.
   - The rule-based extractor errs on the side of caution. It skips quoted reply history, never takes facts from
     questions, gives hedged language low confidence, and quarantines sentences that look like instructions.
   - The Claude extractor is given the vocabulary, the current terms and the open obligations (with their ids) so it can
     resolve referents. The email and its attachments are wrapped in `<untrusted_*>` tags, and the model answers in
     strict JSON. If that fails, the pipeline drops back to the rules and flags the event.
6. **Resolve** (`src/engine/resolver.ts`) according to these rules:

   | Situation | Transition |
   |---|---|
   | same speaker, same term, same value | *corroborate*: add the evidence (e.g. the quote PDF backing the email) |
   | same speaker, new value, newer evidence | *supersede*: the old claim gets `superseded_by` and a reason ("explicit correction by supplier in ev_6") |
   | same speaker, new value, **older** evidence (a forward that arrives late) | stored as already superseded; the current value stays (`stale_evidence`) |
   | a different speaker in the same deal group disagrees | **both contested**, neither replaced; surfaced as a conflict ("newer is not truer") |
   | hedged, confidence < 0.6, speaker lacks authority for the term, or sender unknown | *tentative* (`proposed`), not applied |
   | "the remaining 200 now arrive Friday" (an update to part of a lot) | merged into the current schedule, or flagged if no match is found |
   | a question/request whose debtor later addresses its topic | *answered*, linked to the event that answered it |
   | a commitment to send a document | *fulfilled only once that document really arrives*; "here it is" with no attachment stays open, with a note |
   | a newer document of the same kind from the same party | the older artifact is *superseded* |
   | a claim backed by an artifact gets superseded | the artifact becomes *partially stale*, listing exactly which terms |

7. **Derive** with pure functions: artifact currency and the domain **checks**. For procurement these are: every unit
   by the deadline, quantity, price ≤ approved budget, and budget approved. Checks are recomputed from active claims
   after each event, so no model ever has to "remember" a conflict; conflicts are a function of the current state.
   Whenever a check changes status, a `conflict_detected` or `conflict_resolved` transition is written.

## Context compiler (`src/compiler/`)

What goes into the context is chosen **by structure**, not by similarity search. The following always appear, no
matter what the latest message is about:

- who acts next, plus suggested actions (P1 = we have to act; P2 = mention when writing; P3 = already raised, waiting
  for a reply). They are derived deterministically from: a failing check we have not raised since our last message to
  that party; an open obligation on our side; open commitments on their side; missing terms nobody has asked about yet;
  and "everything passes → accept".
- conflicts (failing checks and contradictory claims)
- current terms per party, **superseded terms (do not use)**, and tentative statements (not applied)
- what we are waiting on from others, and what we owe
- **already answered — do not re-ask**
- documents, split into still-current and stale terms
- changes since this agent's cursor (for a brand-new agent: since our last outbound message). Only transitions that
  changed state are listed; messages that changed nothing are folded into a single line.
- flags (quarantined injection, unknown senders, attachments that could not be read) and a compact evidence index.

The output comes in two forms: JSON for programs and a rendered text briefing for LLMs. Both carry evidence ids for
drilling down (`/explain`, `/items/:id/provenance`, `/events/:id`). The briefing is bounded: its size follows the
number of open items, terms and documents, not the number of messages (`eval/scale.ts`).

The compiler reports *what is true and what is open*. It does not write the email; the acting agent (LLM or offline
policy) picks the words. Every outbound action then passes a **send guard** that checks it against state:

- every recipient must be a participant in the task;
- the body must contain no credentials;
- binding language (accept / place order / approve payment) is refused as long as any requirement fails or any term is
  contested.

## How a cold handoff works

- Agents run as separate OS processes (`src/agent/run.ts`) and reach Continuity only over HTTP. They have no access to
  the event store.
- What identifies an agent is its cursor (`/cursor`, mirrored to Primitive Memories in live mode), which defines
  "changes since you last acted". Task state is owned by the task, never by an agent.
- Every agent run records what it was given (briefing, token estimate, process memory size, which is 0 for a fresh
  process), what it decided and what it sent. The UI shows this for each run.

## Storage, processing and actions (`src/store/`, `supabase/migrations/`)

Supabase Postgres is the store of record. SQLite and memory are offline modes that must be selected explicitly, and
all three sit behind the same contract. The resolver and compiler remain synchronous: they operate on an in-memory
**task working set** (`MemoryStore`) rather than on the database.

1. **Receive** (one short transaction). Dedupe on `(org, dedupe_key)`, link the event, and store it immutably (a trigger
   blocks edits to the evidence columns). Cache the attachment bytes in a private Storage bucket, keyed by sha256 and
   tagged with the Primitive email id. Enqueue an `interpret_event` job. Mail is durable before any interpretation
   happens.
2. **Interpret** (worker). Lease the job with `FOR UPDATE SKIP LOCKED`; within a task, events are processed strictly in
   order. Load the task's working set in a single repeatable-read transaction, then run the extractor (LLM or rules)
   with **no transaction open**.
3. **Commit** (one short transaction). Lock the task row and check `state_version`. Lock the id counters, apply the
   resolver to the working set, upsert exactly the rows it touched, complete the job and enqueue deadline jobs, all in
   one atomic step. If the version has moved, reload and interpret again. A job delivered a second time finds its event
   already interpreted and exits without doing anything.
4. **Recover**. Another worker picks up any lease that has expired. A job that keeps failing is dead-lettered and noted
   in the task state (`interpretation_failed`, `processing.failed_events`). Delivering that email again re-arms it.
5. **Deadlines**. Every due obligation whose condition is met gets exactly one `deadline` job, deduped on
   (obligation, due date). When the date passes the job writes `obligation_overdue`, which wakes waiting agents even
   though no new mail arrived.
6. **Sends** are durable `outbound_actions` carrying a stable provider idempotency key built from org instance, task,
   agent, the version the decision was based on, recipient and body hash. A send is refused while mail is pending or
   failed, and also if anything besides the agent's own sends has changed the task since `based_on_version`. At most one
   send per task can be in flight (enforced by a partial unique index). If a failure is ambiguous the action stays
   `attempted` and is reconciled by retrying with the same key: the provider dedupes, and a replay of our own earlier
   attempt is recorded as `replayed`. A replay on a *first* attempt means a key collision and fails loudly.
   Reconciliation stops once new mail arrives, and the task notes that delivery was not confirmed.

Ids such as `ev_6` and `cl_9` are unique within an organization, and every table is scoped by `org_id`. API callers
present hashed, scoped tokens (org, optional task list, optional agent id). The schema is invisible to the Data API.
RLS is enabled on every table; org members can read only `tasks` and `transitions` (enough for a console).

## Tradeoffs and decisions

- **Postgres (Supabase) through Postgres.js, with no ORM and no build step.** An event log with relational projections
  answers every question an agent asks. The load → interpret → version-checked-commit cycle keeps the resolver
  synchronous and easy to test, and avoids a database round trip for every state operation. The jobs table is plain
  Postgres rather than pgmq, so that strict per-task ordering can live in the same transaction as receipt and commit.
  Realtime is not used, and long inbox loops run in the Node worker rather than in Edge Functions.
- **Domain pack** (`src/domain/procurement.ts`): a small, typed vocabulary of terms plus pure check functions. This is
  where the system is opinionated. With generic claims, "does the schedule break the deadline?" would be a judgement
  call for an LLM; with typed terms it is a comparison.
- **Claims are scoped to their speaker.** "The supplier says delivery is Wednesday" is stored as the supplier's claim,
  never as a fact about the world. `participants[].authority` says who may set which term (finance sets the budget; the
  supplier sets price and delivery). `participants[].group` defines who is able to contradict whom.
- **The rule-based extractor stays a first-class fallback.** It lets the whole system run and be tested offline, and
  keeps CI deterministic. It is not general NLU; the LLM extractor is the intended production path. Both produce the
  same proposal format, so the resolver's guarantees apply to either.
- **Explicit task linkage instead of clever matching.** Continuity across threads comes from Primitive thread ids,
  reply headers and explicit references. Mail that cannot be linked is surfaced, never guessed.
- **Briefing versus transcript.** On short threads the briefing is bigger than the transcript. We accept this and
  measure it.
- **Serial per task, any number of workers.** A task's jobs run in event order, separate tasks run in parallel, and the
  version check at commit makes concurrent writers safe.

## Replay (event sourcing, `src/engine/replay.ts`)

Since events and extraction proposals are append-only, state can always be rebuilt:

- **As of any event** (`GET /tasks/:id/context?as_of=ev_6`, or "state as of here" in the UI). This answers "what did we
  believe when we sent ev_7?". The tests show that a full replay reproduces the live projection exactly and that a
  partial replay matches a snapshot taken at that point (`test/replay.test.ts`).
- **Re-interpretation**: run the same evidence through a different extractor (for example after improving the LLM
  prompt). The original events are left alone; only the projection changes.

## Obligation deadlines

"I'll send a revised quote by tomorrow" gets a `due_at`, resolved against the date of the message. Questions never get
one: "can you deliver by Friday?" is about the goods, not a deadline for replying. Commitments past due are marked
`OVERDUE` and turn into P1 follow-ups in the compiled context.

## Known gaps

- Valid time and learned time are not modelled separately. We store `learned_at` and the source event's
  `occurred_at`, so replay can answer "what did we know when", but not "when was it true in the world".
- There are two domain packs: procurement, and a small vendor-onboarding pack that proves the boundary. Compound
  questions are split into one issue each, and an issue closes only when its debtor states that term. Rule-based answer
  detection still relies on patterns; the explicit `resolutions` from the LLM extractor are better.
- The rule-based extractor matches English patterns tuned on the scenario family. It is the offline/CI fallback, not
  the production interpreter.
- In the offline modes (SQLite/memory) auth is off by design; hosted mode requires tokens. Revoking a token means
  setting a column (`revoked_at`); there is no API for that yet.
- Quarantine, the guard and version checks lower the risk from injected or stale content. They do not amount to a
  general guarantee against prompt injection.
