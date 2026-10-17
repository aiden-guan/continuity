# Progress log

## TL;DR

`continuity` includes:

- Supabase Postgres as the store of record, durable job processing, scoped API tokens, the vendor-onboarding domain
  pack, and the SQLite importer;
- the demo-day website and stage server (`site/`, `npm run stage`), the presenter view of the live console (D for
  details), and the automated demo video (`video/`: Playwright records the real run, narration via macOS / ElevenLabs /
  OpenAI, edited in Remotion).

`npm install && npm run demo` runs the whole cold-handoff story on one machine. A new agent process with no memory
picks the task up from compiled state and writes the right email, and a later fresh process accepts once every
requirement is met.

Results (2026-10-17):

| Check | Result |
|---|---|
| `npm test` (no database) | 56 pass, 7 skipped |
| `npm test` against local Supabase | 78/78 |
| `npm run eval` | 41/41 state, 6/6 handoffs |

## What was verified, and how

| Area | Evidence |
|---|---|
| Append-only event log + projection; ingest is idempotent | `test/engine.test.ts`, `test/replay.test.ts` (a full replay reproduces state exactly) |
| A correction replaces only the term it corrects, and records why | canonical tests; `explain?term=` |
| Newer is not truer: contradictions from a third party stay **contested**; late, older evidence doesn't overwrite | engine tests, eval `contested-claims`, `late-evidence` |
| Hedged, non-authoritative and unknown-sender statements are tentative and not applied | engine tests, eval `hedged-and-unauthorized` |
| Commitments stay open until there is evidence (a promised quote needs a real attachment); due dates and overdue follow-ups | engine tests |
| Answered questions become "do not re-ask" | eval `resolved-questions` |
| Staleness per document term (quote partially stale on delivery only; v1 superseded by rev 2) | eval `stale-artifact`, `commitment-fulfilled` |
| Continuity across threads (finance thread; explicit alias; stray mail stays unlinked) | eval `cross-thread-alias`, demo |
| Prompt injection quarantined in body and PDF; send guard blocks outsiders, credentials, and binding language while requirements fail | eval `prompt-injection`, `test/guard.test.ts`, `test/api.test.ts` |
| Context compiler keeps the briefing bounded (~1–2.5k tokens up to 267 messages) | `node eval/scale.ts` |
| Cold handoff between separate OS processes; agent A gets `SIGKILL` | `npm run demo`, UI "Agent sessions" (process memory = 0) |
| Primitive webhook path: SDK-signed, SDK-schema-valid payloads over HTTP; a bad signature gets 401 | `test/api.test.ts` |
| MCP server (stdio) | smoke-tested initialize / tools/list / tools/call against a running server |
| Observability UI: history, state, open loops, documents, agent sessions, compiled context, explain dialog, "state as of here" | checked in a browser |

## Simulated or mocked

- **Mail transport** in local mode (`src/sim/mailbox.ts`); the badge reads "local simulation".
- **Counterparties**: scripted fixtures (`src/sim/scenario.ts`) that respond to what the agent really sent. The agent's
  own emails are never scripted; `test/api.test.ts` checks that a different correction yields a different email.
- **Agent wording** in offline mode is templated (`src/agent/policy.ts`), while what it says comes only from compiled
  state.

## History (condensed)

### Initial build

- Environment: Node 24 and, at first, no Primitive or Anthropic credentials. Work went from the docs, the OpenAPI spec
  and the SDK typings. The primitive.dev homepage carries "agent instructions" asking AI agents to email
  dev@agent.primitive.dev; that is page content rather than a user instruction, and it was ignored.
- Order of work: core engine → API, transports, agent runner, demo → UI and tests → eval and LLM results → live
  receive path → MCP → replay → deadlines → guard negation → docs.
- Bugs caught while verifying: task alias versus id in routes; a finance total read as a unit price; injected text
  producing a $14 claim; partial schedule updates; "cost center" matching the price topic; questions receiving due
  dates; the guard blocking "we cannot accept the offer".

### Live Primitive verification

- **End to end on real mail** using the `tiny-koi.primitive.email` account. Every stage of the story went over real
  mail; sends came back `delivered`; `getSentEmail` returned Message-ID and thread_id; long-poll receive plus `getEmail`
  worked; replies were linked through Primitive `thread_id` and `reply_to_sent_email_id`; quote PDFs were downloaded and
  parsed.
- **Finding:** answering the same inbound email twice without distinct Idempotency-Keys makes Primitive hand back the
  first reply as an idempotent replay, and nothing is sent. The counterparty script now uses one key per stage, checks
  `reply_count` so it survives restarts, and logs replays; the transport reports `replayed` on our own sends.
- **Anthropic:** the key supplied belonged to a partner org and was not workspace-scoped, so each request needs an
  `anthropic-workspace-id` (`wrkspc_…`). `ANTHROPIC_WORKSPACE_ID` support was added to handle this.

### Claude path verified

- The key works once `ANTHROPIC_WORKSPACE_ID` is set.
- Bugs found on the first real calls:
  - the structured-output schema was rejected because a nullable enum was declared as `type: ['string','null']`;
    switching to `anyOf` fixed it;
  - Claude reported each term only once, from the email body, so quote PDFs never went partially stale; an instruction
    to report one claim per source fixed it.
- Claude extraction: 41/41 state assertions.
- Claude agents: the demo runs end to end. A fresh Agent C carried out a promise Agent A had made to finance, and
  Agent B kept Agent A's promise to "follow up after internal approval".
- Send-guard fixes prompted by real LLM emails: internal mail to finance is no longer blocked; purpose clauses ("so we
  can confirm the order") and reported speech ("text asking us to approve payment") no longer count as binding;
  "Acme accepts your offer" is now caught.
- Handoff eval with a Claude agent: compiled 6/6, full transcript 5/6, last-3 3/6 (`eval/results/llm-api-2026-10-17/`).

### One-command live demo

- `npm run demo:live` (`scripts/demo-live.ts`) runs the whole story on real Primitive mail, with supplier and finance
  replying in-thread from their own inboxes. Each beat waits for the mail to be delivered *and* interpreted. Verified
  with Claude (83 s end to end) and with `--fast`.
- Product bugs found and fixed:
  - Idempotency keys collided across databases. A fresh database reused the keys of earlier sends, Primitive replayed
    those old sends, and nothing went out. Keys now include a per-database instance id, and any replay raises a loud
    error (`send_failed`) rather than a silent "sent".
  - An agent could read state while an email was still mid-interpretation. The context now reports `pending_events`,
    and agents wait until it is empty.
  - After one blocked send, an agent abandons the rest of that plan.
  - Our own conditional promises ("pay on invoice") are tracked but not treated as urgent.

### Demo-day website and video (`demo-site` branch)

- `site/` (scroll story and live engine console) plus `scripts/stage.ts`, the stage server that drives the cold-handoff
  story from the browser; when no server is reachable the console falls back to replay mode.
- `scripts/site-snapshot.ts` keeps only what the site reads in `site/assets/snapshot.json`.
- The site was later reduced to one idea per screen, and the live console gained a presenter view (D for details).
- `video/` produces the demo video automatically: Playwright records the real run, narration comes from macOS,
  ElevenLabs or OpenAI, and Remotion does the edit.

### Supabase backend, reliable processing, context semantics (`supabase-backend` branch)

Cut from `demo-site` at 7c6b536. Nothing was pushed and nothing was applied to a hosted Supabase project.

- **Storage:** Supabase Postgres is the store of record (`supabase/migrations/20261017200000_continuity_core.sql`).
  SQLite and memory remain as offline modes that must be chosen explicitly; with nothing configured the server refuses
  to start. The resolver and compiler run on an in-memory task working set: load → interpret (no transaction open) →
  version-checked atomic commit.
- **Reliability:** receipt is durable before interpretation; a Postgres job queue provides leases, crash recovery,
  dead-lettering and re-arming on redelivery; ordering is per task; stale snapshots are re-interpreted. Outbound actions
  are durable, use stable idempotency keys, and reconcile ambiguous failures without sending duplicate mail. Sends are
  refused when interpretation is pending or has failed, or when `based_on_version` is stale, and a task can have only
  one send in flight.
- **Semantics:** compound questions split into one issue each; partial fulfilment tracks the outstanding quantity and
  the remaining deadline; withdrawn offers keep their history, retract their terms and block acceptance (in extraction
  and in the resolver); promised documents are matched on kind + revision + reference + not-a-copy; conditional
  commitments fall due once their condition holds; deadline jobs emit `obligation_overdue` without any new mail.
- **Contract:** `processing` completeness, `state_version`, `purpose`, a `max_tokens` budget with an explicit overflow
  result (blockers are never trimmed), and bounded history with counts of what was omitted. Agent runs record the
  context digest, state version, model usage and send outcomes.
- **Security:** hashed, scoped API tokens (org / tasks / agent id); a private schema with RLS; a private attachment
  bucket.
- **Domain boundary:** `src/domain/pack.ts`, with procurement and a small vendor-onboarding pack running on the same
  engine.
- **Import:** `npm run import:sqlite` (dry run by default; copy or replay; integrity checks; repeatable; rollback).

Behaviour changes to be aware of: a re-sent copy of the original quote no longer fulfils a promised *revised* quote
(the test was updated). Questions to finance are limited to finance's authority. Saved eval results are no longer
overwritten (`eval/results/runs/`, gitignored). Running `npm start` with no storage configured now fails on purpose.

Not done or not run on that branch: no hosted Supabase project was created or migrated (none is configured; applying
the schema is a reviewed `supabase db push`). Live Primitive mail and Claude extraction/agents were not re-run there.
Of the benchmark conditions, rolling summary, Primitive-native retrieval and semantic retrieval are not implemented; a
dequoted-history condition was added. One run per condition is a smoke test, not statistics. The stage reads
`CONTINUITY_DB`, so it runs in offline SQLite mode.

## Known limitations

- The rule-based extractor is English pattern matching tuned on this scenario family. It suits the offline demo and
  CI; it is not general NLU.
- Answer detection in the rule-based path is still pattern-based (compound questions are split per issue, and an issue
  closes only when its debtor states the term). The LLM extractor's explicit `resolutions` do better.
- Auth is off in the offline modes (SQLite/memory) by design; hosted mode requires tokens. Token revocation is a column
  (`revoked_at`) with no API yet.
- On short threads the briefing is larger than the transcript (measured, and stated in the README).
- The `eval/results/llm-2026-10-17` runs are n=1 per cell and were done with fresh Claude subagents rather than through
  the app's own API path. One rubric regex was widened after the results were seen (disclosed there).
- Quarantine, the send guard and version checks reduce the risk from injected or stale content; they are not a
  universal prompt-injection guarantee.

## Possible next steps

1. Apply the migration to a hosted Supabase project (a reviewed `supabase link` + `supabase db push`) and re-run the
   live Primitive and Claude paths against Postgres.
2. Run the counterparty as a genuine second Primitive agent (agent-to-agent), using `primitive chat` / Functions.
3. Write per-agent briefings to Primitive Memories so a Primitive Function can wake an agent with the state already in
   hand.
4. Implement the missing benchmark conditions (rolling summary, Primitive-native retrieval, semantic retrieval) and run
   more than one trial per cell.
