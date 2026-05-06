-- 2026-05-06  Content Studio EP68 prep — incremental writes + RLS gate
--
-- Why: Workflow A/B decoupling for Content Studio Pipeline requires durable mid-flight
-- state per Phase-1 of the EP68 P0. EP66 + EP67 both lost runtime-only artifacts
-- (Substack draft, AI text) when n8n's docker restart did not flush in-memory runData.
-- Adding columns + a status enum lets the workflow checkpoint each external system's
-- output as soon as it lands, so a stop/restart can resume from the last persisted
-- state instead of regenerating.
--
-- Also closes the RLS gap on clip_jobs and charlie_tasks (Pillar 3 / security gate).
-- service_role bypasses RLS by default, so n8n + clipper-worker continue working;
-- anon loses access — correct.

BEGIN;

ALTER TABLE public.content_studio_jobs
  ADD COLUMN IF NOT EXISTS buzzsprout_url text,
  ADD COLUMN IF NOT EXISTS wordpress_post_id text,
  ADD COLUMN IF NOT EXISTS wordpress_slug text,
  ADD COLUMN IF NOT EXISTS wordpress_status text,
  ADD COLUMN IF NOT EXISTS transcript_id text,
  ADD COLUMN IF NOT EXISTS substack_draft_id text,
  ADD COLUMN IF NOT EXISTS linkedin_post_id text,
  ADD COLUMN IF NOT EXISTS clip_count integer,
  ADD COLUMN IF NOT EXISTS poll_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.content_studio_jobs
  ADD CONSTRAINT content_studio_jobs_status_check
  CHECK (status IN (
    'pending',
    'a_running',
    'a_complete',
    'clipper_pending',
    'clipper_complete',
    'clipper_error',
    'clipper_timeout',
    'full_complete',
    'error'
  )) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_csj_clipper_pending
  ON public.content_studio_jobs (clip_job_id)
  WHERE status = 'clipper_pending';

ALTER TABLE public.clip_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.charlie_tasks ENABLE ROW LEVEL SECURITY;
-- service_role bypasses RLS by default; n8n + clipper-worker
-- continue working. Anon loses access — correct.

COMMIT;
