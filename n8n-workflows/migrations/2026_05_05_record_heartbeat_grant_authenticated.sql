-- 2026-05-05  Sub-project B Batch 0 prep — fix record_heartbeat EXECUTE grants.
--
-- Two separate fixes here:
--
-- 1. Close anon access. The sub-A migration did `REVOKE ALL ... FROM PUBLIC` then
--    `GRANT EXECUTE ... TO service_role`, intending only service_role to call this
--    function. But Supabase's default privileges (alter default privileges in
--    schema public grant execute on functions to anon, authenticated, service_role)
--    silently re-granted EXECUTE to anon when the function was created. Combined
--    with SECURITY DEFINER, that meant anyone holding the anon key could call
--    record_heartbeat() and forge heartbeat rows. Confirmed live before this
--    migration: routine_privileges showed grantee=anon. Explicit REVOKE here.
--
-- 2. Widen to authenticated. Batch 0's inverse-alerter calls the function via
--    n8n's Postgres node using the existing 'Supabase Postgres DB' credential
--    (id=qGUxEHfEZkZGdAcZ), which connects as a non-service_role user. The
--    function is SECURITY DEFINER, so adding `authenticated` does not weaken the
--    security model — RLS still applies through the choke-point function, and
--    the function still runs as its owner regardless of caller. It just lets
--    the authenticated role invoke the choke point.

revoke execute on function public.record_heartbeat(text,text,text,text,jsonb)
  from anon;

grant execute on function public.record_heartbeat(text,text,text,text,jsonb)
  to authenticated;
