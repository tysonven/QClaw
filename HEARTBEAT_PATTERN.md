# Heartbeat-on-execute pattern for n8n workflows

## Why we don't trust n8n's executions API

n8n stores executions in a global FIFO that prunes by count, not by age (`EXECUTIONS_DATA_PRUNE_MAX_COUNT`, default 10000). On the FlowOS host, a single high-volume webhook (`TikJkWLzpreI6iTa` "Morning Light WL→HL") generates ~24,000 executions/day and consumes 99.15% of that buffer. Every other workflow's history is evicted within ~7 hours — by the time a probe asks "did workflow X fire in the last 7 days?", the rows have been deleted from Postgres. Cursor pagination and date filters do not help; the data is physically gone. Full investigation: [`workspace/n8n_api_reliability_investigation.md`](https://...) (saved 2026-05-05).

The fix is to record a heartbeat from each workflow itself into a Supabase table we control, with retention we choose. Charlie's bootstrap probe and downstream dashboards read that table instead of the n8n API.

## What to record

Two heartbeats per execution:

1. **At the trigger entry** — immediately after the trigger node, before any downstream work runs. Status = `started`. This proves the trigger fired.
2. **At each terminal node** — one path per outcome, status = `success` or `error` (or `partial` if the workflow handles partial failure explicitly). Idempotency on `(workflow_id, execution_id)` means the same row gets upgraded in place from `started` → `success`/`error`.

Do **not** fire one heartbeat per item in a batch. The point is "did the workflow run", not "what did each item do." Item-level data goes in `metadata` if it matters.

## Standard node config

Add an HTTP Request node named **"Heartbeat (start)"** wired off the trigger, and **"Heartbeat (success)"** / **"Heartbeat (error)"** wired off the terminal nodes.

| Field | Value |
|---|---|
| Method | `POST` |
| URL | `https://fdabygmromuqtysitodp.supabase.co/rest/v1/rpc/record_heartbeat` |
| Authentication | None (set headers manually below) |
| Send Headers | yes |
| Headers | `apikey: ={{$env.SUPABASE_SERVICE_ROLE_KEY}}`<br>`Authorization: =Bearer {{$env.SUPABASE_SERVICE_ROLE_KEY}}`<br>`Content-Type: application/json` |
| Send Body | yes, JSON |
| Body | see snippets below |
| **On Error** | **`Continue (using error output)`** — heartbeat failure must NEVER fail the workflow |
| Retry on Fail | 1 attempt, 2s wait |

> **Why service role key (not anon):** the `record_heartbeat` RPC is `SECURITY DEFINER` with `EXECUTE` granted only to `service_role`. Anon and authenticated cannot call it. This is intentional — it's the choke point.
>
> **Why a separate env var, not the existing `SUPABASE_ANON_KEY`:** the anon key cannot insert. Per the existing FSC-credential memo, do not strip the inline `apikey` header thinking the FSC credential covers it — the FSC `httpHeaderAuth` is a no-op; this header is what actually authenticates.

### Body — start heartbeat (off the trigger)

```json
{
  "p_workflow_id":   "{{$workflow.id}}",
  "p_status":        "started",
  "p_workflow_name": "{{$workflow.name}}",
  "p_execution_id":  "{{$execution.id}}"
}
```

### Body — success heartbeat (off terminal node)

```json
{
  "p_workflow_id":   "{{$workflow.id}}",
  "p_status":        "success",
  "p_workflow_name": "{{$workflow.name}}",
  "p_execution_id":  "{{$execution.id}}",
  "p_metadata":      { "rows": "={{$json.length}}" }
}
```

`p_metadata` is optional and free-form. Use it for anything dashboards need to surface — row counts, queued items, last-error-node, etc. Omit if not needed.

### Body — error heartbeat (off error branch / Error Trigger)

```json
{
  "p_workflow_id":   "{{$workflow.id}}",
  "p_status":        "error",
  "p_workflow_name": "{{$workflow.name}}",
  "p_execution_id":  "{{$execution.id}}",
  "p_metadata":      {
    "node":  "={{$json.error.node?.name || 'unknown'}}",
    "message": "={{$json.error.message || $json.message || 'no message'}}"
  }
}
```

## Wiring rules

- **Wire heartbeats off always-emits parents** — the trigger node itself (Schedule, Webhook, Manual, Cron), or a node that always fires. Per the existing memo on n8n empty-input behaviour: a heartbeat downstream of a node that may emit zero items will be silently skipped, defeating the whole point.
- **Branch the start heartbeat on a separate path from the main work.** Don't put it in the main pipeline — that couples its failure to the workflow's failure. Put it on a parallel branch with `Continue (using error output)`.
- **The terminal-node success heartbeat goes after the last business-critical node**, not after the heartbeat itself. Heartbeats are observability, not state.
- **Error Trigger workflows or the workflow's own error branch should always end in an error heartbeat.** `partial` is reserved for workflows that explicitly handle "some items succeeded, some failed" (e.g. fan-out batch jobs).

## Idempotency contract

The `record_heartbeat` RPC is idempotent on `(workflow_id, execution_id)` when `execution_id` is provided:

- First call inserts the row.
- Subsequent calls with the same `(workflow_id, execution_id)` **update the existing row in place** — `status`, `metadata`, and `workflow_name` are overwritten. The `id` and `created_at` are preserved.
- This is what lets the same row transition `started` → `success`/`error`/`partial` without leaving stale `started` rows around.
- Without `execution_id`, every call inserts a new row (no idempotency available — the workflow is responsible for not double-firing).

## Reading the data

Charlie's bootstrap probe and dashboards should read via Supabase REST/RPC with the **authenticated** role (read-only). Example query — last 30 days of heartbeats per workflow:

```sql
select workflow_id,
       workflow_name,
       count(*) filter (where status = 'success') as ok,
       count(*) filter (where status = 'error')   as err,
       max(started_at) as last_seen
from public.workflow_heartbeats
where started_at > now() - interval '30 days'
group by workflow_id, workflow_name
order by last_seen desc;
```

Dormancy rule of thumb: if `last_seen` is older than 2× the workflow's expected fire interval, treat it as suspicious and investigate.

## Retention

Default Supabase retention is unbounded — heartbeat rows live forever. The proposal in the work-list is to keep 30 days of detail and archive older rows (target schema for the archive: same shape, `workflow_heartbeats_archive`, repointed by a nightly `move-and-delete` job). That archive job is **not part of this sub-project**; defer until after Sub-projects B and C land and we can see real volume.

Estimated volume at steady state with all 20 instrumented workflows + Morning Light: ~50,000 heartbeats/day. 30 days ≈ 1.5M rows. Comfortable on Supabase's free tier; no immediate concern.

## Schema reference

See [`n8n-workflows/migrations/2026_05_05_workflow_heartbeats.sql`](n8n-workflows/migrations/2026_05_05_workflow_heartbeats.sql) for the canonical DDL. RPC signature:

```
record_heartbeat(
  p_workflow_id   text          NOT NULL,
  p_status        text          NOT NULL,  -- started | success | error | partial
  p_workflow_name text          DEFAULT NULL,
  p_execution_id  text          DEFAULT NULL,
  p_metadata      jsonb         DEFAULT NULL
) RETURNS uuid
```
