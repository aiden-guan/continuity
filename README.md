# Continuity

**Primitive hands an AI agent an inbox. Continuity hands each conversation in that inbox a state.**

Continuity is a communication-state engine for agents whose mail runs through [Primitive](https://primitive.dev).
It reads everything an agent sends and receives and keeps, for each task, an answer backed by evidence to one question:

> *Where does this task stand, what has changed, who owes what to whom, and what must I know to pick it up?*

An agent process that starts with no memory makes one HTTP call (or one MCP tool call) and receives a short briefing.
It lists the terms in force and the ones that were replaced, open conflicts with hard requirements, commitments still
outstanding in both directions, questions that already have answers (so they are not asked again), document terms that
have gone stale, and who has to move next. Every line points back to the email or attachment it came from.

```
Primitive mail (webhook or long-poll)
        │  signed email.received payloads · threading headers · attachments
        ▼
 append-only event log ─► extractor (Claude or rules) ─► proposal ─► deterministic resolver ─► state projection
   (the evidence)          reads the language            (claims,     makes every state change   claims · obligations ·
                                                          acts, docs)  and logs each transition   artifacts · checks
                                                                                                        │
                    fresh agent ◄── context compiler (mandatory items first, token-budgeted, cited) ◄───┘
                         │
                         └── guarded, threaded send ──► Primitive
```

## Demo in 60 seconds

```bash
npm install
npm run demo
```

Open http://localhost:4100 and watch. Everything runs on your machine (see "What is real and what is simulated"):

1. **Agent A**, a long-lived process, starts the PO-4817 negotiation: an RFQ goes to the supplier and a budget request
   goes to finance.
2. The supplier answers *500 units Friday at $11.40, quote attached*, with a real PDF. Agent A chooses to wait for finance.
3. **Agent A is killed with `SIGKILL`.** From this point no agent process is running.
4. Finance approves *up to $11.50/unit*, and does so in a **separate thread**.
5. The supplier writes: *"Correction: only 300 units can arrive Friday. The other 200 won't arrive until Wednesday, Oct 28. I'll send a revised quote."*
   With nobody running, Continuity replaces the delivery term (and nothing else), flags the quote as **partially stale**,
   opens a **commitment** on the supplier's side, and spots the **conflict** with the hard Friday requirement.
6. **Agent B** starts: a new process with a new identity and no memory of the conversation. It calls
   `GET /tasks/PO-4817/context` (~1.4k tokens) and writes:
   > *the updated schedule (200 units arrive Wed Oct 28) doesn't work for us: all 500 units need to arrive by Fri Oct 23 …
   > Can you get the remaining units to us by Fri Oct 23 … Also, we're still expecting the revised quote you mentioned.*
7. The supplier expedites and sends *quote rev 2*. The commitment becomes **fulfilled**, quote v1 becomes **superseded**
   and the conflict becomes **resolved**. **Agent C**, yet another fresh process, accepts. The send guard lets binding
   language through only after every check passes.

**Whoever wrote that email had never seen the earlier conversation.**

## Live demo over real Primitive mail (one command)

```bash
npm run demo:live              # ~1.5 min with Claude; --step pauses at every beat, --fast makes no Claude calls
```

This is the same story, except every message (agent to supplier/finance, their replies, the PDF quotes) travels through
Primitive between three inboxes on your own domain. Put `PRIMITIVE_API_KEY` and `CONTINUITY_{SELF,SUPPLIER,FINANCE}_ADDRESS`
in `.env`. If `ANTHROPIC_API_KEY` is also set, Claude handles extraction and the agents. The UI on :4100 follows along live.

## Demo-day website (one command)

```bash
npm run stage                  # http://localhost:4000 (story) · http://localhost:4000/live (engine console)
```

`site/` needs no build. It holds two pages:

- `index.html`, a scroll story that plays back real engine output for PO-4817 from `site/assets/snapshot.json`
  (regenerate it with `npm run site:snapshot`);
- `live.html`, a live console that steps the local-simulation story one beat at a time (→ / Space) using real agent
  processes. It streams their output and shows each email, transition, handoff briefing and state change as it happens.

`--offline` forces the rule-based extractor and the policy agents. If the console is served without the stage (from any
static host), it plays back the recording instead.

## Demo video (automated)

```bash
cd video && npm install && npm run make     # record the real run → narrate → render out/continuity-demo.mp4
```

Playwright walks the live presenter view through every beat while Chrome's screencast captures the screen. Remotion
then edits the footage together with narration and captions. Details are in [video/README.md](video/README.md).

## Quick start

You need Node ≥ 22.18 (it relies on the built-in TypeScript type-stripping; development used Node 24). There is no
build step.

```bash
npm install
npm test                 # every test on the in-memory backend (Supabase cases are skipped unless configured)
npm run eval             # 10 scenarios, 41 state assertions, plus offline handoff grading
node eval/scale.ts       # briefing size against history length
npm run demo             # full cold handoff, OFFLINE (SQLite file + simulated mail), UI on :4100
npm run agent -- --task PO-4817 --agent my-agent --once      # one fresh agent against a server that is already up
```

### Storage modes

| Mode | Chosen by | Purpose |
|---|---|---|
| **Supabase Postgres** (authoritative) | `SUPABASE_DB_URL` (or `CONTINUITY_STORE=postgres`) | Hosted operation. Auth is required by default. |
| SQLite (offline) | `CONTINUITY_STORE=sqlite` or `CONTINUITY_DB=<file>` | Local demos (`npm run demo`, `npm run stage`). One org per file. |
| Memory (offline) | `CONTINUITY_STORE=memory` | Tests, evals, replay. Nothing persists. |

If none of these is configured the server will not start; it never quietly falls back to a local file. A missing schema
or a database it cannot reach is also a startup error. `GET /api/health` returns `storage.mode`, `storage.authoritative`,
the target with credentials redacted, the auth setting, the transport (`primitive` / `local-sim`), and worker and job
counts.

### Supabase (the hosted path)

```bash
supabase start                      # local stack on ports 584xx (see supabase/config.toml)
npm run db:migrate:local            # applies supabase/migrations/*.sql to the LOCAL database
npm run test:supabase               # whole suite including Postgres, Storage, auth/tenant and import tests (local only)
npm run demo:supabase -- --exit     # the canonical story on Supabase Postgres, auth on, one scoped token per agent

# point the service at Supabase
export SUPABASE_DB_URL=postgresql://…          # server-side only; direct or session-pooler URL (6543 = transaction pooler, prepared statements off)
export SUPABASE_URL=https://<ref>.supabase.co  # optional: private Storage bucket for attachment bytes
export SUPABASE_SECRET_KEY=…                   # server-side only; agents never receive it
npm start                                      # API plus embedded worker (CONTINUITY_WORKER=off + `npm run worker` to run workers separately)
npm run token -- --org org_acme --kind operator                                  # prints the token once
npm run token -- --org org_acme --kind agent --agent agent-b --task PO-4817     # scoped agent token → CONTINUITY_TOKEN
```

Pushing the migration to a **hosted** project is a step someone reviews (`supabase link` then `supabase db push`); no
script here does it for you. To roll the schema back, run `drop schema continuity cascade;` and delete the
`continuity-attachments` bucket. Doing so wipes every piece of Continuity data in that project.

**Agents receive Continuity API tokens, never database credentials or Supabase keys.** Each token is bound to one org
and may be narrowed to particular tasks and a single agent id. Being allowed to call the API is a different thing from
a mail sender's authority to set terms (`participants[].authority`). The `continuity` schema is not exposed through the
Data API, anon/authenticated hold no table grants, every table has RLS enabled, and the attachment bucket is private.

**Bringing over existing SQLite data** is an explicit command. The source file is opened read-only and left unchanged:

```bash
npm run import:sqlite -- --db data/live-demo.db                          # dry run: inventory only
npm run import:sqlite -- --db data/live-demo.db --org org_demo --apply   # copy (ids kept) + integrity checks
npm run import:sqlite -- --db data/demo.db --org org_x --apply --mode replay   # re-run saved proposals through the current resolver
npm run import:sqlite -- --org org_demo --task PO-4817 --rollback        # take that imported task out again
```

Each import ends with integrity checks. The evidence (events and extraction proposals) has to match exactly, and in
copy mode so does the projection. The report also points out where today's resolver would read the old data
differently. Importing the same file twice changes nothing the second time. Colliding tasks or ids are refused.

### Environment

| Variable | Default | What it does |
|---|---|---|
| `PRIMITIVE_API_KEY` | unset → **local simulation** | Turns on real Primitive sending (`client.send`), attachment download and Memories checkpoints. The sim endpoints switch off when it is set. |
| `PRIMITIVE_WEBHOOK_SECRET` | `local-sim-webhook-secret` in sim; unset in live → **signatures not verified (warning)** | Secret used to check `Primitive-Signature` (SDK `verifyWebhookSignature`). |
| `ANTHROPIC_API_KEY` | unset → rule-based extractor + offline policy agent | Turns on the Claude extractor (`src/extract/llm.ts`) and the LLM agent (`src/agent/llm-agent.ts`). |
| `ANTHROPIC_WORKSPACE_ID` | unset | Only for keys without a workspace scope (`wrkspc_…`); sent as `anthropic-workspace-id`. |
| `CONTINUITY_EXTRACTOR` | `auto` | `auto` \| `llm` \| `heuristic` |
| `CONTINUITY_EXTRACTOR_MODEL` / `CONTINUITY_AGENT_MODEL` | `claude-opus-5-5` | Model ids. |
| `CONTINUITY_SELF_ADDRESS` | `procurement@acme-buyer.primitive.email` | The agent's own Primitive address. |
| `CONTINUITY_SUPPLIER_ADDRESS`, `CONTINUITY_FINANCE_ADDRESS` | made-up `.example` addresses | The scenario's counterparties. |
| `CONTINUITY_SENDER_AUTH` | `enforce` | `enforce`: a sender's statements carry authority only if Primitive's SPF/DKIM/DMARC results authenticate the From address (SDK `isTrustedSender`); otherwise they stay tentative, cannot close obligations or replace documents, and are flagged. `flag`: apply anyway, flag only (`demo:live` uses this until verified on real mail). |
| `CONTINUITY_DKIM_WITHOUT_DMARC` | `1` | A domain with no DMARC record still authenticates through a passing DKIM signature by exactly the From domain; `0` turns that off. |
| `CONTINUITY_AUTH_TEMPERROR_RETRIES` | `3` | Webhook deliveries answered 503 (redeliver) while DMARC reports a temporary DNS error; after that the email is stored with an `unknown` sender and flagged. |
| `CONTINUITY_AUTH_RETRY_DELAY_MS` | `5000` | Pause between re-fetches on the pull receiver, which has no redelivery. |
| `SUPABASE_DB_URL` | unset | Supabase Postgres connection string; selects hosted (authoritative) mode. |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | unset | Private Storage bucket for attachment bytes (without it, bytes stay inline in Postgres). Server-side only. |
| `CONTINUITY_STORE` | inferred | `postgres` \| `sqlite` \| `memory`. With nothing configured the server fails to start. |
| `CONTINUITY_DB` | unset | SQLite file; setting it selects offline SQLite mode. |
| `CONTINUITY_AUTH` | `required` with Postgres, otherwise `off` | Bearer tokens on every API route. |
| `CONTINUITY_ORG` | `org_local` | Org used for signed webhooks and when auth is off. |
| `CONTINUITY_TOKEN` | unset | Token that `npm run agent`, the MCP server and the scripts send. |
| `CONTINUITY_WORKER` | on | `off` disables the embedded job worker (run `npm run worker` instead). |
| `PORT` | `4100` | HTTP port. |
| `CONTINUITY_URL` | `http://localhost:4100` | Server address for the agent, the MCP server and scripts. |

## Agent-facing interface

HTTP. Every task route takes either the id or the alias (e.g. `PO-4817`):

| What the agent wants to know | Call |
|---|---|
| What should a freshly started agent be told? | `GET /tasks/:id/context?agent=<agent-id>` (`&format=text` for the briefing, `&party=<addr>` to focus on one party) |
| What did we believe at the moment we sent ev_7? | `GET /tasks/:id/context?as_of=ev_7` (state rebuilt by replaying the event log) |
| Which commitments are overdue? | `waiting_on_them[].overdue` and the P1 follow-up actions in the context |
| What are we waiting for, what do we owe, what is already answered? | `GET /tasks/:id/open-loops` |
| What changed since we last interacted? | `GET /tasks/:id/changes?since=<seq>` (or the context's `changes_since_last_action` section, driven by the agent's cursor) |
| Why does the system think the delivery date moved? | `GET /tasks/:id/explain?term=delivery.schedule` |
| Which quote terms are out of date? | `documents[].stale_terms` in the context, or `GET /tasks/:id/state` |
| Where did this item come from? | `GET /items/{cl_|ob_|ar_|ev_}*/provenance` |
| Send a reply (threaded, recorded, guarded) | `POST /tasks/:id/send {agent_id, to, body, subject?, based_on_version}`. Returns 409 while mail is still being interpreted, or when someone else has changed the task since `based_on_version`. Hosted mode requires `based_on_version`. |
| Is the state complete, and how large may it get? | `context.processing` (`complete`, pending/failed events, sends in flight) · `&max_tokens=N` → `budget {unit, used, fits, trimmed}`. Blockers and open obligations are never cut; a result over budget says so. |
| What became of my send? | `GET /tasks/:id/actions` (`pending` / `attempted` / `delivered` / `replayed` / `failed`) |
| I have acted; remember my position | `POST /tasks/:id/cursor {agent_id, seq}` |
| Wake me when something changes | `GET /tasks/:id/wait?since=<seq>` (long-poll) |

Ingestion goes through `POST /webhooks/primitive` (Primitive webhook / Function payloads, signature-verified) and
`POST /ingest/primitive-email` (REST `EmailDetail`, which the long-poll receiver uses). Mail that matches no task stays
unlinked: list it with `GET /events?unlinked=1` and attach it with `POST /events/:id/link {task_id}`.

**MCP**: `node src/mcp.ts` runs a stdio MCP server exposing `continuity_get_context`, `continuity_open_loops`,
`continuity_explain_term`, `continuity_provenance`, `continuity_changes`, `continuity_send` and `continuity_mark_seen`.
It can be mounted alongside Primitive's own MCP server (`https://www.primitive.dev/mcp`):
`claude mcp add continuity -- node /abs/path/src/mcp.ts`.

## Live Primitive

Built against `@primitivedotdev/sdk@2.4.0` and **verified live on 2026-10-17** with a real account. The whole story
(RFQ → offer plus PDF quote → finance approval in a second thread → correction → fresh Agent B raises the conflict →
expedite plus revised quote → fresh Agent C accepts) ran over real Primitive mail between three addresses on a single
`*.primitive.email` domain. Keys live in `.env`; `npm run keys` asks for them with hidden input and `npm run check:keys`
confirms they work. Then:

```bash
# .env: PRIMITIVE_API_KEY, CONTINUITY_SELF_ADDRESS=procurement@<you>.primitive.email,
#       CONTINUITY_SUPPLIER_ADDRESS=supplier@<you>.primitive.email, CONTINUITY_FINANCE_ADDRESS=finance@<you>.primitive.email
npm start &                          # server (sim endpoints off in live mode)
npm run receive &                    # long-polls the inbox into Continuity; cursor checkpointed in Primitive Memories
npm run live:task
npm run live:counterparty &          # plays supplier and finance over real Primitive mail, replying in-thread (restart-safe)
npm run agent -- --agent agent-a --once     # RFQ + budget request; then wait until the correction has been ingested
npm run agent -- --agent agent-b --once     # fresh process: raises the delivery conflict
npm run agent -- --agent agent-c --once     # once the revised quote is in: accepts
```

Instead of long-polling you can aim a Primitive webhook endpoint (or a Function) at `POST /webhooks/primitive` and set
`PRIMITIVE_WEBHOOK_SECRET`.

| Primitive capability | How Continuity uses it | Status |
|---|---|---|
| Agent identity (`*.primitive.email`) | the task's `self_address`; every send goes `from` it | **verified live** |
| Send / threaded replies | `client.send({thread:{inReplyTo,references}})` with one idempotency key per action; Message-ID/thread_id read back with `getSentEmail` | **verified live** (status `delivered`, ids returned) |
| Receive | signed `email.received` webhook (`verifyWebhookSignature`) **or** `client.inbox.stream()` long-poll + `getEmail` | long-poll **verified live**; webhook path exercised locally with SDK-signed, SDK-schema-valid payloads |
| Threading metadata | `thread_id`, `Message-ID`, `In-Reply-To`, `References` and `reply_to_sent_email_id` decide task linkage, never an LLM | **verified live** (both thread_id and reply_to_sent_email_id used) |
| Attachments | inline bytes (sim) or `downloadEmailAttachmentPart`; PDF/text extraction; provenance per term | **verified live** (quote PDFs downloaded and parsed, v1 superseded by rev 2) |
| Auth verdicts | kept as provenance metadata, not treated as truth | exercised locally |
| Primitive Memories | inbox cursor (`continuity:inbox-cursor`) and per-agent cursors (`continuity:cursor:<task>:<agent>`): checkpoints, not semantic truth | **verified live** (writes succeed) |

## What is real and what is simulated

**Real, and tested locally**
- The event store, the extraction → proposal → resolver pipeline, the transition log, per-term artifact currency,
  constraint checks, the context compiler, the briefing renderer, the send guard, the HTTP API, the MCP server and the
  observability UI.
- Primitive webhook verification and normalization. The simulator signs its payloads with the SDK's `signWebhookPayload`,
  they pass the SDK's `safeValidateEmailReceivedEvent`, and they reach the real endpoint over HTTP.
- The cold handoff. Agents are separate OS processes that speak to Continuity only over HTTP. Agent A gets `SIGKILL`;
  B and C start with no memory and no cursor.

**Simulated**
- Mail transport when there is no `PRIMITIVE_API_KEY`. The local mailbox hands out Message-IDs and thread ids and quotes
  earlier messages in replies the way a mail client would. The UI badge and every API response report `local-sim`.
- The counterparties (supplier, finance). They are scripted fixtures that respond to whatever the agent actually sent.
  **Our agent's emails are never scripted.**

**Claude path (verified 2026-10-17)**
- When `ANTHROPIC_API_KEY` is set, Claude (`claude-opus-5-5`) performs extraction and makes every agent decision. This
  was checked end to end: the demo runs on Claude agents, and a fresh Claude Agent C kept a promise that Agent A had made
  to finance. Claude extraction passes all 41 state assertions.
- With no key, a cautious rule-based extractor (`src/extract/heuristic.ts`) and a rule-based policy agent that writes
  only from compiled state (`src/agent/policy.ts`) take over. The policy agent's *wording is templated*; *the content*
  comes from state.

## Evaluation (measured, not claimed)

`npm run eval` runs 10 scenarios covering corrections, outstanding commitments, answered questions, conflicting claims,
stale artifacts, cross-thread continuity, untrusted content and cold handoff. Result: **41/41 state assertions** and
**6/6 offline policy-agent handoffs**, graded by rubric.

Cold handoff to a fresh **Claude agent** (in-app API run, Claude also extracting, n=1 per cell; every email and the
grader caveats are saved in `eval/results/llm-api-2026-10-17/`):

| Scenario | compiled briefing | last 3 emails | full transcript |
|---|---|---|---|
| canonical handoff | ✅ | ✅ | ✅ |
| long backlog (10 emails after the correction) | ✅ | ❌ misses the late 200 units and the owed quote | ✅ |
| already-answered questions | ✅ | ❌ asks the supplier again | ✅ |
| revised quote fulfils commitment | ✅ | ✅ | ✅ |
| contested delivery claims | ✅ | ✅ | ✅ |
| prompt injection (email + PDF) | ✅ | ❌ accepts without budget approval | ❌ accepts without budget approval |
| **total** | **6/6** | **3/6** | **5/6** |

What the table says:
- **Recency windows** break as soon as the critical state is older than the window.
- **Full transcripts** handle short histories well, but they get more expensive with every email and carry no
  provenance. Their one failure here (accepting without budget approval) is something the send guard would have stopped
  in the running system.
- A **generic LLM summary** (an earlier manual run, `eval/results/llm-2026-10-17/`) passed the long backlog as well.

Context size from `node eval/scale.ts` (chars/4 estimate; the transcript includes mail-client quoting):

| messages | transcript ≈ tokens | briefing ≈ tokens |
|---:|---:|---:|
| 10 | 1,563 | 856 |
| 37 | 19,369 | 1,032 |
| 137 | 448,620 | 1,632 |
| 267 | 2,769,083 | 2,442 |

A caveat worth stating: on short histories (about 10 emails or fewer, without heavy quoting) the briefing is **bigger**
than the raw transcript. In that range its value is structure, guarantees and provenance, not compression.

## Layout

```
src/types.ts              data model
src/store/                storage boundary: in-memory task working set + Postgres (Supabase), SQLite, memory backends
supabase/migrations/      Postgres schema (private `continuity` schema, RLS, attachment bucket)
src/ingest/               Primitive payload normalization, task-linkage cascade, attachment text (PDF/text)
src/extract/              proposal schema, rule-based extractor, Claude extractor, date resolution
src/domain/               domain packs: procurement, vendor onboarding (vocabulary, checks, action prerequisites)
src/engine/               engine (pipeline), resolver (state transitions), guard (send policy)
src/compiler/             context compiler + briefing renderer
src/transport/            Primitive transport (SDK) and local simulator
src/agent/                agent process, offline policy, Claude policy
src/server.ts, src/mcp.ts HTTP API + webhook + UI; MCP server
src/sim/                  scenario fixtures, PDF writer, mailbox simulator, test harness
ui/index.html             observability UI
site/, scripts/stage.ts   demo-day website + the stage server that runs the story from the browser
video/                    automated demo video (Playwright recording, narration, Remotion edit)
test/, eval/              tests; eval scenarios, runner, scaling, LLM results
```

Further reading: [ARCHITECTURE.md](ARCHITECTURE.md) (design and tradeoffs) · [DEMO.md](DEMO.md) (a 2–3 minute
walkthrough) · [PROGRESS.md](PROGRESS.md) (build log, status, next steps).
