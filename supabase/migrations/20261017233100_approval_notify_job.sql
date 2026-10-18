-- Approval announcements (src/service.ts): a card posted to CONTINUITY_APPROVAL_WEBHOOK is first claimed in
-- the task's transition log (approval_notified, committed version-checked), so it is posted at most once
-- across restarts and processes. A post the webhook did not accept is retried by a durable job of this kind.
alter table continuity.jobs drop constraint if exists jobs_kind_check;
alter table continuity.jobs add constraint jobs_kind_check
  check (kind in ('interpret_event', 'deadline', 'reconcile_action', 'notify_approval'));
