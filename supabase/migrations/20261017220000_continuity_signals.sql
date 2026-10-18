-- Signal (src/signal.ts): alerts raised by scanning every task — failing requirements, contradictions,
-- overdue or due-soon promises, approaching deadlines, security flags, stalled tasks. One row per distinct
-- alert (its key names the condition), kept after the condition clears (resolved_at), so each scan reports
-- only what is new and a webhook never repeats an alert. Derived data: it can be dropped and rebuilt.

create table continuity.signals (
  org_id      text not null references continuity.orgs(id) on delete cascade,
  key         text not null,
  task_id     text not null,
  rule        text not null,
  severity    text not null check (severity in ('high', 'medium', 'low')),
  summary     text not null,
  detail      jsonb not null default '{"evidence": []}',
  first_seen  timestamptz not null,
  last_seen   timestamptz not null,
  resolved_at timestamptz,
  primary key (org_id, key),
  foreign key (org_id, task_id) references continuity.tasks(org_id, id) on delete cascade
);
create index signals_open on continuity.signals (org_id, first_seen) where resolved_at is null;

-- same access model as the core schema: private, RLS on, no anon/authenticated access, the service role only
alter table continuity.signals enable row level security;
revoke all on continuity.signals from anon, authenticated;
grant select, insert, update, delete on continuity.signals to continuity_service;
create policy service_all on continuity.signals for all to continuity_service using (true) with check (true);
