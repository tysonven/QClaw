-- 2026-05-05  Phase 4 Slice 0 Sub-project A — Heartbeat infrastructure foundation
--
-- Why: n8n's executions table is a global FIFO capped at EXECUTIONS_DATA_PRUNE_MAX_COUNT
-- (default 10000). On the FlowOS host one webhook (TikJkWLzpreI6iTa "Morning Light WL→HL")
-- generates ~24k executions/day and consumes 99.15% of that buffer, evicting every other
-- workflow's history within ~7 hours. The n8n public API can therefore not be trusted to
-- answer "did workflow X fire in the last N days." This migration adds a Supabase-side
-- heartbeat table that workflows POST to from a node at trigger entry + terminal node, so
-- Charlie's bootstrap probe and downstream dashboards have a truthful, retention-controlled
-- source of dormancy/health data.
--
-- Project: fdabygmromuqtysitodp (n8n database, main QClaw Supabase). Not the LinkedIn
-- secondary (zshmlgtvhdneekbfcyjc).
--
-- Companion doc: HEARTBEAT_PATTERN.md at repo root.

create extension if not exists pgcrypto;

create table public.workflow_heartbeats (
  id              uuid primary key default gen_random_uuid(),
  workflow_id     text not null,
  workflow_name   text,
  execution_id    text,
  started_at      timestamptz not null default now(),
  status          text not null check (status in ('started','success','error','partial')),
  metadata        jsonb,
  created_at      timestamptz not null default now()
);

comment on table public.workflow_heartbeats is
  'Heartbeat-on-execute observability for n8n workflows. Bypasses n8n''s pruned executions table. Written via record_heartbeat() RPC from a heartbeat node at trigger entry + terminal node of each workflow.';

comment on column public.workflow_heartbeats.workflow_id is
  'n8n workflow ID (short alphanumeric, e.g. dHceOMijUOcnEowO).';
comment on column public.workflow_heartbeats.workflow_name is
  'Denormalised workflow name. May be stale if the workflow is renamed; not authoritative — workflow_id is.';
comment on column public.workflow_heartbeats.execution_id is
  'n8n execution ID when available. Nullable because some early-trigger heartbeats fire before $execution.id is bound.';
comment on column public.workflow_heartbeats.started_at is
  'When the heartbeat was recorded. Falls back to now() if not provided. NOT necessarily the workflow execution start time.';
comment on column public.workflow_heartbeats.status is
  'started | success | error | partial. Enforced by check constraint.';
comment on column public.workflow_heartbeats.metadata is
  'Workflow-specific payload. e.g. {row_count, edge_count, queued_items, last_error_node}. Free-form jsonb.';

create index workflow_heartbeats_workflow_id_idx
  on public.workflow_heartbeats (workflow_id);

create index workflow_heartbeats_started_at_desc_idx
  on public.workflow_heartbeats (started_at desc);

create index workflow_heartbeats_workflow_started_idx
  on public.workflow_heartbeats (workflow_id, started_at desc);

-- Idempotency key: same (workflow_id, execution_id) collapses to one row.
-- Partial because execution_id is nullable.
create unique index workflow_heartbeats_unique_exec_idx
  on public.workflow_heartbeats (workflow_id, execution_id)
  where execution_id is not null;

-- RLS: anon = no access. authenticated = read-only. service_role = full (bypasses RLS).
alter table public.workflow_heartbeats enable row level security;

create policy "authenticated read"
  on public.workflow_heartbeats
  for select
  to authenticated
  using (true);

-- record_heartbeat: the write choke point. Webhook calls this RPC instead of inserting
-- directly so we have one place to add validation, sanitization, or schema migrations.
-- SECURITY DEFINER so the function bypasses RLS regardless of caller role; EXECUTE granted
-- only to service_role so anon/authenticated cannot invoke it.
create or replace function public.record_heartbeat(
  p_workflow_id   text,
  p_status        text,
  p_workflow_name text default null,
  p_execution_id  text default null,
  p_metadata      jsonb default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_workflow_id is null or length(p_workflow_id) = 0 then
    raise exception 'workflow_id is required';
  end if;
  if p_status not in ('started','success','error','partial') then
    raise exception 'invalid status %, must be one of: started, success, error, partial', p_status;
  end if;

  if p_execution_id is not null then
    insert into public.workflow_heartbeats
      (workflow_id, workflow_name, execution_id, status, metadata)
    values
      (p_workflow_id, p_workflow_name, p_execution_id, p_status, p_metadata)
    on conflict (workflow_id, execution_id) where execution_id is not null
    do update set
      status        = excluded.status,
      metadata      = coalesce(excluded.metadata, public.workflow_heartbeats.metadata),
      workflow_name = coalesce(excluded.workflow_name, public.workflow_heartbeats.workflow_name)
    returning id into v_id;
  else
    insert into public.workflow_heartbeats
      (workflow_id, workflow_name, status, metadata)
    values
      (p_workflow_id, p_workflow_name, p_status, p_metadata)
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

comment on function public.record_heartbeat(text,text,text,text,jsonb) is
  'Record a workflow heartbeat. Idempotent on (workflow_id, execution_id) when execution_id is provided — repeat calls update status/metadata in place. Without execution_id, every call inserts a new row.';

revoke all on function public.record_heartbeat(text,text,text,text,jsonb) from public;
grant execute on function public.record_heartbeat(text,text,text,text,jsonb) to service_role;
