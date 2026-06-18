-- Slice 5 — Claude Code delegation bridge (Component 6 v1, step 1)
-- Supabase project: fdabygmromuqtysitodp
--
-- Dedicated dispatch table + atomic claim/reaper RPCs + RLS lockdown.
-- The dispatch row is UNTRUSTED end-to-end; the `provenance` columns are written
-- ONLY by the dispatcher at write-back and are what the gates bind to (a directly
-- fabricated `complete` row, lacking them, mints no completion evidence).
--
-- Applied 2026-06-11 via Supabase migrations: slice5_claude_code_dispatches +
-- slice5_pin_trigger_search_path. This file is the source of record.

create table if not exists public.claude_code_dispatches (
  id uuid primary key default gen_random_uuid(),                -- = task_id returned to Charlie
  status text not null default 'queued'
    check (status in ('queued','awaiting_authorisation','authorised','in_progress','complete','failed','timeout')),
  scope text not null
    check (scope in ('audit','read_only','write','infra','critical')),  -- all 5 schema-legal (Slice 6 neutral); v1 dispatcher RUNS only audit/read_only
  mode text
    check (mode in ('audit_only','audit_then_implement','implement_with_audit_gate')),
  priority int not null default 5,                              -- dispatcher: priority desc, created_at asc
  repo text not null default 'tysonven/QClaw',                  -- validated ^[\w.-]+/[\w.-]+$ at the tool
  brief text not null,                                          -- passed to CC as file/stdin, never interpolated
  pinned_commit text,                                           -- repo SHA pinned at enqueue (deterministic audit target)
  business_unit text,
  session_id text,                                              -- Charlie's turn correlation (gate scoping + surfacing)
  created_by text not null default 'charlie',
  authorisation_required boolean not null default false,        -- v1 audit/read_only = false; write/infra = true (steps 6+)
  authorisation_note text,
  authorised_by text,
  authorised_at timestamptz,
  -- ── provenance: dispatcher-only; gate integrity depends on these ──
  claimed_by text,
  claim_token uuid,
  started_at timestamptz,
  completed_at timestamptz,
  exit_code int,
  cc_session_id text,
  cost_usd numeric,                                             -- spend attribution (Slice 3g)
  result text,
  result_summary text,
  error_message text,
  attempts int not null default 0,                             -- v1 cap = 1, no retry
  surfaced_at timestamptz,                                      -- set when Charlie surfaced it (poll dedupe)
  timeout_seconds int not null default 600,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ccd_poll on public.claude_code_dispatches (status, priority desc, created_at);
create index if not exists idx_ccd_surface on public.claude_code_dispatches (session_id, status, surfaced_at);

-- updated_at touch trigger
create or replace function public.ccd_touch_updated_at() returns trigger
  language plpgsql set search_path = pg_catalog
  as $fn$ begin new.updated_at = now(); return new; end; $fn$;
drop trigger if exists trg_ccd_touch on public.claude_code_dispatches;
create trigger trg_ccd_touch before update on public.claude_code_dispatches
  for each row execute function public.ccd_touch_updated_at();

-- ── RLS: enable + FORCE + revoke all non-service-role grants ──
-- Grants persist independently of RLS (both pre-existing tables had full anon grants),
-- so REVOKE is belt-and-suspenders alongside enable+force. No policies => service_role only.
alter table public.claude_code_dispatches enable row level security;
alter table public.claude_code_dispatches force row level security;
revoke all on public.claude_code_dispatches from anon, authenticated;

-- ── Atomic claim RPC ──
-- FOR UPDATE SKIP LOCKED cannot be expressed over PostgREST (codebase is 100% REST),
-- so the claim is wrapped in a SECURITY DEFINER function callable only by service_role.
create or replace function public.claim_next_dispatch(p_dispatcher text)
returns setof public.claude_code_dispatches
language plpgsql security definer set search_path = public as $fn$
begin
  return query
  update public.claude_code_dispatches d
     set status = 'in_progress',
         started_at = now(),
         claimed_by = p_dispatcher,
         claim_token = gen_random_uuid(),
         attempts = d.attempts + 1
   where d.id = (
     select c.id from public.claude_code_dispatches c
      where c.status = 'queued'
      order by c.priority desc, c.created_at asc
      for update skip locked
      limit 1
   )
  returning d.*;
end; $fn$;

-- ── Reaper RPC ──
-- in_progress rows past started_at + timeout_seconds + grace => timeout. Covers a
-- dispatcher that died/hung mid-run (the in-process timer died with it); run on
-- dispatcher startup and periodically so work is never silently lost.
create or replace function public.reap_stale_dispatches(p_grace_seconds int default 30)
returns setof public.claude_code_dispatches
language plpgsql security definer set search_path = public as $fn$
begin
  return query
  update public.claude_code_dispatches d
     set status = 'timeout',
         completed_at = now(),
         error_message = coalesce(d.error_message, 'reclaimed: dispatcher died or hung mid-run')
   where d.status = 'in_progress'
     and d.started_at < now() - make_interval(secs => (d.timeout_seconds + p_grace_seconds))
  returning d.*;
end; $fn$;

-- functions: service_role-only (revoke default PUBLIC execute)
revoke all on function public.claim_next_dispatch(text) from public, anon, authenticated;
revoke all on function public.reap_stale_dispatches(int) from public, anon, authenticated;
grant execute on function public.claim_next_dispatch(text) to service_role;
grant execute on function public.reap_stale_dispatches(int) to service_role;
