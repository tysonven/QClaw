-- Phase 5 Session 1 — add 'cancelled' terminal status to claude_code_dispatches.
--
-- Applied live to project fdabygmromuqtysitodp on 2026-07-01 (Supabase apply_migration
-- "ccd_add_cancelled_status"); this file is the repo-tracked record for parity.
--
-- Why: the write-scope approval gate (Phase 5 Session 1) adds a cancellation path —
-- the owner replies "❌ <task_id8>" to a write/infra dispatch awaiting authorisation,
-- and the channel handler sets status='cancelled'. The original CHECK constraint
-- (migration 2026_06_11) did not include 'cancelled', so the PATCH would have been
-- rejected. This widens the constraint; it is purely additive.
--
-- Reap/index review (done before applying): reap_stale_dispatches only moves
-- in_progress→timeout (cancelled is terminal, never in_progress); claim_next_dispatch
-- and the dispatcher queue-depth probe filter only status='queued'; idx_ccd_poll and
-- idx_ccd_surface are B-trees that index the new value with no rebuild. No other
-- code path references 'cancelled' beyond the ❌ handler.

alter table public.claude_code_dispatches
  drop constraint claude_code_dispatches_status_check;

alter table public.claude_code_dispatches
  add constraint claude_code_dispatches_status_check
  check (status in ('queued','awaiting_authorisation','authorised','in_progress','complete','failed','timeout','cancelled'));
