-- GET /approvals (org-wide) asks the database which tasks have an approval card still open as recorded
-- (src/store/postgres.ts openApprovalTaskIds) instead of loading every task. Approvals are folded from the
-- transition log (src/engine/approval-log.ts); this partial index holds only the four transition types the
-- fold reads, so the lookup scans the org's cards and their decisions, not its whole history.
create index if not exists transitions_approval on continuity.transitions (org_id, type, task_id, seq)
  where type in ('approval_requested', 'claim_held_for_verification', 'approval_decided', 'approval_expired');
