-- Problems found while deriving an inbound email's times (missing, malformed or future Date header;
-- missing receipt time). Part of the immutable evidence row; the engine writes them as task flags
-- when the event is interpreted.
alter table continuity.events add column if not exists time_flags jsonb not null default '[]';

create or replace function continuity.events_immutable() returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.id, new.seq, new.dedupe_key, new.source, new.direction, new.primitive_email_id, new.thread_id, new.message_id,
      new.in_reply_to, new."references", new.from_addr, new.to_addrs, new.cc_addrs, new.subject, new.body_text,
      new.occurred_at, new.received_at, new.attachments, new.raw, new.time_flags)
     is distinct from
     (old.id, old.seq, old.dedupe_key, old.source, old.direction, old.primitive_email_id, old.thread_id, old.message_id,
      old.in_reply_to, old."references", old.from_addr, old.to_addrs, old.cc_addrs, old.subject, old.body_text,
      old.occurred_at, old.received_at, old.attachments, old.raw, old.time_flags) then
    raise exception 'continuity.events evidence is immutable (event %)', old.id;
  end if;
  if old.task_id is not null and new.task_id is distinct from old.task_id then
    raise exception 'event % is already linked to task %', old.id, old.task_id;
  end if;
  return new;
end $$;
