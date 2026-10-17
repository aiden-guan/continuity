-- Continuity core schema for Supabase Postgres.
--
-- Evidence (events, extraction proposals, the attachment cache) is append-only. Claims, obligations,
-- artifacts, checks and flags are the resolver's revisable projection, and transitions record every
-- change together with its cause. Every row belongs to an organization. Ids such as ev_6 or cl_9 are
-- unique per organization because agents see them in their briefings.
--
-- The schema is private. It is not exposed through the Data API, anon and authenticated hold no table
-- privileges, and RLS is on everywhere. The Continuity service connects with a server-side database
-- credential; agents get scoped Continuity API tokens, never database or service keys.

create schema if not exists continuity;
revoke all on schema continuity from public;

-- ==================================================================== organizations and principals

create table continuity.orgs (
  id         text primary key,
  name       text not null,
  created_at timestamptz not null default now()
);

-- console users (Supabase Auth) allowed to read an org's state, e.g. over Realtime; optional
create table continuity.org_members (
  org_id  text not null references continuity.orgs(id) on delete cascade,
  user_id uuid not null,
  role    text not null default 'viewer' check (role in ('viewer', 'operator', 'admin')),
  primary key (org_id, user_id)
);

create table continuity.api_tokens (
  token_hash text primary key,                 -- sha256 of the token; the token itself is never stored
  id         text not null unique,
  org_id     text not null references continuity.orgs(id) on delete cascade,
  kind       text not null check (kind in ('agent', 'operator', 'ingest')),
  agent_id   text,
  scopes     text[] not null,
  task_ids   text[],                           -- null: every task in the org
  label      text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table continuity.meta (
  org_id text not null references continuity.orgs(id) on delete cascade,
  key    text not null,
  value  text not null,
  primary key (org_id, key)
);

create table continuity.counters (
  org_id text not null references continuity.orgs(id) on delete cascade,
  name   text not null,
  value  bigint not null default 0 check (value >= 0),
  primary key (org_id, name)
);

-- ==================================================================== tasks

create table continuity.tasks (
  org_id        text not null references continuity.orgs(id) on delete cascade,
  id            text not null,
  alias         text not null,
  domain        text not null,
  goal          text not null,
  spec          jsonb not null,                -- the canonical TaskSpec (requirements, participants)
  created_at    timestamptz not null,
  state_version bigint not null default 0,     -- the latest transition seq; commits are checked against it
  updated_at    timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, alias)
);

-- participants and their authority, queryable (also part of tasks.spec)
create table continuity.participants (
  org_id    text not null,
  task_id   text not null,
  address   text not null,
  name      text not null,
  label     text not null,
  role      text not null check (role in ('self', 'counterparty', 'internal')),
  authority text[] not null default '{}',      -- term prefixes this party may set (sender authority, not API permission)
  group_key text,
  primary key (org_id, task_id, address),
  foreign key (org_id, task_id) references continuity.tasks(org_id, id) on delete cascade
);

create table continuity.task_threads (
  org_id    text not null,
  thread_id text not null,
  task_id   text not null,
  reason    text not null,
  primary key (org_id, thread_id),
  foreign key (org_id, task_id) references continuity.tasks(org_id, id) on delete cascade
);

-- ==================================================================== evidence (immutable)

create table continuity.events (
  org_id                 text not null references continuity.orgs(id) on delete cascade,
  id                     text not null,
  seq                    bigint not null,
  dedupe_key             text not null,
  task_id                text,
  link_reason            text,
  source                 text not null check (source in ('primitive', 'local-sim')),
  direction              text not null check (direction in ('inbound', 'outbound')),
  primitive_event_id     text,
  primitive_email_id     text,
  reply_to_sent_email_id text,
  thread_id              text,
  message_id             text,
  in_reply_to            text,
  "references"           jsonb not null default '[]',
  from_addr              text not null,
  from_name              text,
  to_addrs               jsonb not null default '[]',
  cc_addrs               jsonb not null default '[]',
  subject                text not null,
  body_text              text not null,
  occurred_at            timestamptz not null,
  received_at            timestamptz not null,
  auth_verdict           text,
  attachments            jsonb not null default '[]',   -- metadata only; the bytes live in the private cache
  raw                    jsonb,
  processing_status      text not null default 'received'
                         check (processing_status in ('unlinked', 'received', 'interpreting', 'interpreted', 'failed')),
  processing_error       text,
  created_at             timestamptz not null default now(),
  primary key (org_id, id),
  unique (org_id, seq),
  unique (org_id, dedupe_key),
  foreign key (org_id, task_id) references continuity.tasks(org_id, id) on delete cascade
);
create index events_task_seq      on continuity.events (org_id, task_id, seq);
create index events_message_id    on continuity.events (org_id, message_id) where message_id is not null;
create index events_primitive_email on continuity.events (org_id, primitive_email_id) where primitive_email_id is not null;
create index events_unlinked      on continuity.events (org_id, seq) where task_id is null;

-- evidence columns never change; only the link (once, from unlinked) and the processing status may
create function continuity.events_immutable() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.id, new.seq, new.dedupe_key, new.source, new.direction, new.primitive_email_id, new.thread_id, new.message_id,
      new.in_reply_to, new."references", new.from_addr, new.to_addrs, new.cc_addrs, new.subject, new.body_text,
      new.occurred_at, new.received_at, new.attachments, new.raw)
     is distinct from
     (old.id, old.seq, old.dedupe_key, old.source, old.direction, old.primitive_email_id, old.thread_id, old.message_id,
      old.in_reply_to, old."references", old.from_addr, old.to_addrs, old.cc_addrs, old.subject, old.body_text,
      old.occurred_at, old.received_at, old.attachments, old.raw) then
    raise exception 'continuity.events evidence is immutable (event %)', old.id;
  end if;
  if old.task_id is not null and new.task_id is distinct from old.task_id then
    raise exception 'event % is already linked to task %', old.id, old.task_id;
  end if;
  return new;
end $$;
create trigger events_immutable before update on continuity.events
  for each row execute function continuity.events_immutable();

-- versioned extraction proposals: interpretations of evidence, never edited
create table continuity.extractions (
  org_id     text not null,
  event_id   text not null,
  version    int not null,
  extractor  text not null,
  proposal   jsonb not null,
  created_at timestamptz not null,
  primary key (org_id, event_id, version),
  foreign key (org_id, event_id) references continuity.events(org_id, id) on delete cascade
);

-- the private attachment cache: bytes in Supabase Storage, or inline when Storage is not configured
create table continuity.attachment_blobs (
  org_id             text not null,
  event_id           text not null,
  part_index         int not null,
  sha256             text not null,
  content_type       text not null,
  size_bytes         bigint not null,
  primitive_email_id text,
  storage            text not null check (storage in ('supabase_storage', 'postgres_inline')),
  storage_path       text,
  inline_bytes       bytea,
  created_at         timestamptz not null default now(),
  primary key (org_id, event_id, part_index),
  foreign key (org_id, event_id) references continuity.events(org_id, id) on delete cascade,
  check ((storage = 'supabase_storage') = (storage_path is not null)),
  check ((storage = 'postgres_inline') = (inline_bytes is not null))
);

-- ==================================================================== projection (owned by the resolver)

create table continuity.artifacts (
  org_id        text not null,
  id            text not null,
  task_id       text not null,
  event_id      text not null,
  filename      text not null,
  content_type  text not null,
  sha256        text not null,
  size_bytes    bigint not null,
  kind          text not null,
  version_label text,
  text          text not null,
  status        text not null check (status in ('current', 'partially_stale', 'superseded', 'withdrawn')),
  superseded_by text,
  owner         text not null,
  primary key (org_id, id),
  foreign key (org_id, task_id) references continuity.tasks(org_id, id) on delete cascade,
  foreign key (org_id, event_id) references continuity.events(org_id, id)
);
create index artifacts_task on continuity.artifacts (org_id, task_id);

create table continuity.claims (
  org_id             text not null,
  id                 text not null,
  task_id            text not null,
  key                text not null,
  value              jsonb not null,
  display            text not null,
  kind               text not null check (kind in ('offer', 'requirement', 'decision', 'info')),
  speaker            text not null,
  source_event_id    text not null,
  source_artifact_id text,
  evidence           text not null,
  status             text not null check (status in ('active', 'superseded', 'contested', 'proposed', 'retracted')),
  superseded_by      text,
  supersede_reason   text,
  learned_at         timestamptz not null,
  confidence         real not null check (confidence >= 0 and confidence <= 1),
  extractor          text not null,
  primary key (org_id, id),
  foreign key (org_id, task_id) references continuity.tasks(org_id, id) on delete cascade,
  foreign key (org_id, source_event_id) references continuity.events(org_id, id)
);
create index claims_task_key on continuity.claims (org_id, task_id, key);

create table continuity.claim_evidence (
  org_id      text not null,
  claim_id    text not null,
  ord         int not null,
  event_id    text not null,
  artifact_id text,
  quote       text not null,
  primary key (org_id, claim_id, ord),
  foreign key (org_id, claim_id) references continuity.claims(org_id, id) on delete cascade,
  foreign key (org_id, event_id) references continuity.events(org_id, id)
);
create index claim_evidence_artifact on continuity.claim_evidence (org_id, artifact_id) where artifact_id is not null;

create table continuity.obligations (
  org_id               text not null,
  id                   text not null,
  task_id              text not null,
  kind                 text not null check (kind in ('question', 'request', 'commitment')),
  debtor               text not null,
  creditor             text not null,
  text                 text not null,
  topic_keys           text[] not null default '{}',
  issue_key            text,
  group_id             text,
  expects_artifact     text,
  artifact_match       jsonb,
  status               text not null check (status in ('open', 'partially_fulfilled', 'answered', 'fulfilled', 'cancelled', 'declined')),
  quantity             numeric,
  fulfilled_quantity   numeric,
  condition            jsonb,
  condition_met_at     timestamptz,
  due_at               date,
  source_event_id      text not null,
  evidence             text not null,
  resolved_by_event_id text,
  resolution_note      text,
  created_at           timestamptz not null,
  resolved_at          timestamptz,
  confidence           real not null,
  notes                jsonb not null default '[]',
  primary key (org_id, id),
  foreign key (org_id, task_id) references continuity.tasks(org_id, id) on delete cascade,
  check (fulfilled_quantity is null or quantity is null or fulfilled_quantity <= quantity)
);
create index obligations_task_open on continuity.obligations (org_id, task_id) where status in ('open', 'partially_fulfilled');

create table continuity.transitions (
  org_id     text not null,
  seq        bigint not null,
  task_id    text not null,
  event_id   text,
  at         timestamptz not null,
  type       text not null,
  subject_id text,
  summary    text not null,
  detail     jsonb not null default '{}',
  primary key (org_id, seq),
  foreign key (org_id, task_id) references continuity.tasks(org_id, id) on delete cascade
);
create index transitions_task_seq on continuity.transitions (org_id, task_id, seq);

create table continuity.checks (
  org_id  text not null,
  task_id text not null,
  id      text not null,
  ord     int not null,
  result  jsonb not null,
  primary key (org_id, task_id, id),
  foreign key (org_id, task_id) references continuity.tasks(org_id, id) on delete cascade
);

create table continuity.flags (
  org_id   text not null,
  id       text not null,
  task_id  text,
  event_id text not null,
  kind     text not null,
  detail   text not null,
  at       timestamptz not null,
  primary key (org_id, id)
);
create index flags_task on continuity.flags (org_id, task_id);

-- ==================================================================== agents, jobs, outbound actions

create table continuity.cursors (
  org_id     text not null,
  agent_id   text not null,
  task_id    text not null,
  last_seq   bigint not null,
  updated_at timestamptz not null,
  primary key (org_id, agent_id, task_id),
  foreign key (org_id, task_id) references continuity.tasks(org_id, id) on delete cascade
);

create table continuity.agent_runs (
  org_id            text not null,
  id                text not null,
  task_id           text not null,
  agent_id          text not null,
  principal_id      text,
  started_at        timestamptz not null,
  mode              text not null,
  purpose           text,
  state_version     bigint,
  context_digest    text,                      -- sha256 of the exact briefing the agent got
  context           jsonb,
  briefing          text,
  budget            jsonb,
  context_tokens    int,
  transcript_tokens int,
  usage             jsonb,                     -- model usage as reported by the provider, when available
  decision          jsonb,
  actions           jsonb,                     -- send outcomes (action ids and statuses)
  sent_event_id     text,
  primary key (org_id, id),
  foreign key (org_id, task_id) references continuity.tasks(org_id, id) on delete cascade
);

create table continuity.jobs (
  id           bigint generated always as identity primary key,
  org_id       text not null references continuity.orgs(id) on delete cascade,
  kind         text not null check (kind in ('interpret_event', 'deadline', 'reconcile_action')),
  task_id      text,
  event_id     text,
  seq          bigint not null default 0,
  dedupe_key   text not null,
  payload      jsonb not null default '{}',
  status       text not null default 'pending' check (status in ('pending', 'running', 'done', 'dead')),
  attempts     int not null default 0,
  max_attempts int not null default 5,
  run_after    timestamptz not null default now(),
  locked_by    text,
  locked_until timestamptz,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, dedupe_key)
);
create index jobs_ready     on continuity.jobs (run_after, seq, id) where status in ('pending', 'running');
create index jobs_task_open on continuity.jobs (org_id, task_id, seq) where status in ('pending', 'running');

create table continuity.outbound_actions (
  org_id             text not null,
  id                 text not null,
  task_id            text not null,
  agent_id           text not null,
  principal_id       text,
  idempotency_key    text not null,            -- sent to the provider; the same on every retry
  based_on_version   bigint not null,
  to_addr            text not null,
  subject            text not null,
  body               text not null,
  body_sha256        text not null,
  in_reply_to        text,
  "references"       jsonb not null default '[]',
  status             text not null check (status in ('pending', 'attempted', 'delivered', 'replayed', 'failed')),
  attempts           int not null default 0,
  provider           jsonb,
  primitive_email_id text,
  event_id           text,
  last_error         text,
  created_at         timestamptz not null,
  updated_at         timestamptz not null,
  primary key (org_id, id),
  unique (org_id, idempotency_key),
  foreign key (org_id, task_id) references continuity.tasks(org_id, id) on delete cascade
);
-- at most one unsettled send per task, so two agents cannot both act on the same state
create unique index outbound_one_in_flight on continuity.outbound_actions (org_id, task_id) where status in ('pending', 'attempted');

-- ==================================================================== access control

-- the server-side role the Continuity service logs in as (LOGIN and password are granted out of band; see README)
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'continuity_service') then
    create role continuity_service nologin;
  end if;
end $$;
grant usage on schema continuity to continuity_service;
grant select, insert, update, delete on all tables in schema continuity to continuity_service;
grant usage, select on all sequences in schema continuity to continuity_service;

-- RLS on every table, no policies for anon; the table owner and service role bypass RLS
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'continuity' loop
    execute format('alter table continuity.%I enable row level security', t);
    execute format('revoke all on continuity.%I from anon, authenticated', t);
  end loop;
end $$;

-- continuity_service is not a superuser, so it gets explicit full-access policies
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'continuity' loop
    execute format('create policy service_all on continuity.%I for all to continuity_service using (true) with check (true)', t);
  end loop;
end $$;

-- read-only console access for org members (Supabase Auth users), e.g. a Realtime-refreshed console;
-- evidence bodies and attachments stay out on purpose: the console reads those through the API
create function continuity.is_member(org text) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from continuity.org_members m where m.org_id = org and m.user_id = (select auth.uid()));
$$;
revoke all on function continuity.is_member(text) from public;
grant execute on function continuity.is_member(text) to authenticated;
grant usage on schema continuity to authenticated;
grant select on continuity.tasks, continuity.transitions to authenticated;
create policy members_read_tasks on continuity.tasks for select to authenticated using (continuity.is_member(org_id));
create policy members_read_transitions on continuity.transitions for select to authenticated using (continuity.is_member(org_id));

-- ==================================================================== private attachment bucket

insert into storage.buckets (id, name, public)
values ('continuity-attachments', 'continuity-attachments', false)
on conflict (id) do update set public = false;
-- no storage.objects policies: only the server-side secret or service key can read or write this bucket

comment on schema continuity is 'Continuity: email evidence, interpretation and task state. Private; accessed by the Continuity service only.';
