-- 2026-05-06  Rollback RLS on clip_jobs (and charlie_tasks)
--
-- Why: the prior migration (2026_05_06_content_studio_jobs_incremental_writes.sql)
-- enabled RLS on clip_jobs and charlie_tasks under the assumption that all
-- consumers use service_role (which bypasses RLS). That assumption was wrong:
--
--   - clipper-worker (src/clipper/main.py:81-82) hardcodes SUPABASE_ANON_KEY
--     for all clip_jobs INSERT/UPDATE/SELECT. With RLS on and no policy for anon,
--     all writes return 401 Unauthorized — Generate Clips returns 500 to n8n —
--     Workflow A errors at the clipper handoff.
--
--   - The active n8n workflow "Charlie - Task Handler" (dHoqL8Ph8kmFHwyx)
--     uses inline SUPABASE_ANON_KEY for charlie_tasks POST/PATCH/GET. /task,
--     /tasks, /done, /run Telegram commands would all 401 with RLS on.
--
-- Disabling RLS restores prior behavior. The original security intent (lock
-- direct anon access to operational tables) is tracked as a separate dispatch
-- to switch the consumers to service_role keys (clipper-worker first, then the
-- inline jsCode in the Charlie task handler).

BEGIN;

ALTER TABLE public.clip_jobs DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.charlie_tasks DISABLE ROW LEVEL SECURITY;

COMMIT;
