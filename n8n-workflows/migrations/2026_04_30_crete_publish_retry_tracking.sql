-- Migration: add publish retry tracking and last error capture to crete_content_queue
-- Applied 2026-04-30 via Supabase MCP (project fdabygmromuqtysitodp).

ALTER TABLE public.crete_content_queue
  ADD COLUMN IF NOT EXISTS publish_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_crete_content_queue_publishable
  ON public.crete_content_queue (status, scheduled_for, publish_attempts)
  WHERE status = 'approved';

COMMENT ON COLUMN public.crete_content_queue.publish_attempts IS
  'Incremented on every publish attempt. Scheduled Publisher skips rows where this is >= 3.';
COMMENT ON COLUMN public.crete_content_queue.last_error IS
  'Most recent error message from a failed publish attempt. NULL when row has never failed.';
COMMENT ON COLUMN public.crete_content_queue.last_attempt_at IS
  'Timestamp of most recent publish attempt (success or failure).';
