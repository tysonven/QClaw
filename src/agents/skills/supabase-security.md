---
name: supabase-security
category: on-demand
surface: prompt
keywords: [supabase, anon, rls, service_role, postgrest]
description: Supabase security playbook — anon-key/RLS traps, service_role migration, n8n 2.4.8 publish model; load before any Supabase-touching work
---

# Supabase Security — CC Skill
**Project:** QClaw / Flow OS  
**Supabase project:** `fdabygmromuqtysitodp` ("n8n database" — correct but misleading label)  
**Last updated:** 2026-07-15 (post Phase 1/2/3 remediation)

---

## Load this skill before any Supabase-touching work

This skill encodes hard lessons from the July 2026 full RLS/key audit and remediation. Do not reason from memory about Supabase security state — read this first.

---

## 1. The anon key trap

### The root cause that created 13 world-readable tables
Supabase's default `GRANT ALL ON ALL TABLES TO anon` is **never revoked on project creation**. This means RLS policies are the only access control. One permissive policy = full public exposure.

**Rule:** Before touching any table's RLS, run:
```sql
SELECT table_name, string_agg(privilege_type, ', ')
FROM information_schema.role_table_grants
WHERE table_schema='public' AND grantee='anon'
GROUP BY table_name ORDER BY table_name;
```
If `anon` has grants, `REVOKE ALL` must be part of the remediation.

### The literal key trap
The anon key was hardcoded as a **literal JWT** throughout `server.js`, `polymarket_scanner.py`, and Meta Ads workflows. A grep for the env var name (`SUPABASE_ANON_KEY`) **will not catch hardcoded literals**.

**Always grep for the literal key fingerprint too:**
```bash
# Get the fingerprint (last 6 chars of the anon key)
sudo grep SUPABASE_ANON_KEY /root/.quantumclaw/.env | tail -c 10

# Then grep for the literal across all source + workflow JSON
grep -rn "<fingerprint>" /root/QClaw/src/ --include="*.js" --include="*.py"
grep -rn "<fingerprint>" /root/QClaw/n8n-workflows/ --include="*.json"
```

Current anon key fingerprint: `x5x8Dk` (the last distinctive chars of the legacy JWT for `fdabygmromuqtysitodp`).

---

## 2. Current security state (post-remediation)

### Locked tables (9) — service_role only
`trading_simulations`, `trading_positions`, `trading_config`, `trading_markets`, `trading_analyst_reports`, `crete_content_queue`, `marketing_drafts`, `social_clip_schedules`, `copy_agent_output`

All carry a single `service_role_all` policy (`AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true)`). Anon has zero grants on these.

### Explicitly deferred (3 tables)
- `ad_creation_sessions` — Meta Ads workflows (`lrGcirtmOHb1xTq8`, `lu39mAN7epBRK3Kw`) still carry hardcoded anon literal. Migrate workflows first, then lock.
- `competitor_ads` — same Meta Ads dependency.
- `workout_logs` / `workout_settings` — `triple-a-tracker` has no Supabase Auth (hardcoded anon key, client-side UUID). Gated behind app adopting `signInAnonymously()`. Do NOT lock until the app authenticates.

### Correctly locked pre-remediation (not touched)
`anthropic_spend_daily`, `anthropic_spend_rollup`, `content_studio_jobs`, `highlevel_tokens`, `device_registry`, `emma_credits`, `message_log`, `sub_accounts`, `tenants`, all `li_*` tables, `advisor_conversations`, `charlie_tasks`, `claude_code_dispatches`, `clip_jobs`, `highlevel_tokens_backup`, `specialist_dispatches`, `workflow_heartbeats`

---

## 3. The credential expression mode trap (n8n-specific)

### What happened
The `httpCustomAuth` credential `fgbywZowo5p5iu9F` ("Supabase Service Role (main)") was created with `={{ $env.SUPABASE_SERVICE_ROLE_KEY }}` in expression mode. This **does not resolve** at n8n runtime — it silently falls back to anon. Three canaries failed before this was diagnosed.

### Rules for n8n Supabase credentials
1. **Always use plain JSON (Fixed mode, no leading `=`)**:
```json
{ "headers": { "apikey": "<literal_key>", "Authorization": "Bearer <literal_key>" } }
```
2. **Never use `$env` expressions inside credential fields** — they do not resolve in httpCustomAuth.
3. **Always verify with a service-role-only table** (`content_studio_jobs`, `highlevel_tokens`) — not an anon-open table. A 200 on an anon-open table is a false positive.
4. **The only trustworthy runtime test is a canary**: REVOKE anon on one table, watch the workflow fire, confirm success. "It works while anon is open" proves nothing.

### Correct credential spec
- **Name:** `Supabase Service Role (main)`
- **ID:** `fgbywZowo5p5iu9F`
- **Type:** HTTP Custom Auth (Fixed mode)
- **Both headers required:** `apikey` + `Authorization: Bearer` — PostgREST derives role from the Bearer JWT. Drop either header and it silently falls back to anon.

---

## 4. The n8n 2.4.8 publish model trap

### What happened
Direct SQL edits to `workflow_entity.nodes` update the **draft** only. n8n 2.4.8 executes the **published version** (`workflow_history[activeVersionId]`). Every Phase 1 migration via SQL was updating drafts that were never executed. This caused weeks of false "migration verified" signals.

### Rules
1. **Never edit workflow nodes via direct SQL** — it only updates the draft.
2. **Use the n8n API (PUT /api/v1/workflows/:id)** to update workflows — this goes through n8n's own logic and creates a valid publishable version.
3. **After any migration, verify `activeVersionId` matches the migrated version** before running a canary.
4. **Syncing the published version** (`UPDATE workflow_history SET nodes = ... WHERE versionId = activeVersionId`) is the fallback if the API is blocked — but leaves orphaned draft versions. Use only as a last resort.
5. **"Version not found" on Publish** = the draft's `versionId` has no matching `workflow_history` row — caused by direct SQL `versionId` bumps.

---

## 5. Misnamed policy trap

Two policies were named "Service role full access" but defined as `TO public USING(true)` — completely open. **Always read the policy `roles` and `qual` fields, never trust the name.**

Re-audit query:
```sql
SELECT tablename, policyname, roles::text, cmd, qual
FROM pg_policies 
WHERE schemaname='public'
  AND roles::text ~ '(anon|public)'
  AND (qual = 'true' OR qual IS NULL)
ORDER BY tablename;
```

Decoy "No public access" policies with `PERMISSIVE` type are neutralised by any other permissive policy. Only `RESTRICTIVE` policies can block. Never treat a policy name as proof of its behaviour.

---

## 6. Consumer migration ordering (load-bearing)

**Always migrate consumers BEFORE revoking grants.** The order is:

1. Identify ALL consumers (env var grep + literal fingerprint grep)
2. Migrate consumers to service_role
3. Verify each consumer is genuinely using service_role (canary on a locked table)
4. REVOKE ALL FROM anon on the target tables
5. Replace permissive policies with service_role_all
6. Verify consumers still work under the lock

Skipping step 3 = false positive. Skipping step 1 = missed consumers (server.js and polymarket_scanner.py were missed in Phase 1 because the literal grep wasn't run).

---

## 7. Remaining security work (as of 2026-07-15)

### Immediate
- `server.js` Crete/GHL dashboard routes — still on `creteEnv.SUPABASE_ANON_KEY` (env ref). Dashboard broken. Fix: swap to `SB_SERVICE_ROLE_KEY`. PR in progress.

### Next session
- Meta Ads workflows (`lrGcirtmOHb1xTq8`, `lu39mAN7epBRK3Kw`) — migrate off hardcoded literal, then lock `ad_creation_sessions` + `competitor_ads`
- `.env.bak*` cleanup on n8n (11 files with old keys in plaintext)
- JWT rotation — generate `sb_secret_*` key for `fdabygmromuqtysitodp`, update both hosts, disable legacy JWT

### Gated on other work
- `workout_*` tables — gated behind `triple-a-tracker` adopting `signInAnonymously()`
- Auth-canary workflow on `fdabygmromuqtysitodp` (5-min cron, Telegram alert on 401/403) — flagged since η.2, still not built

---

## 8. Security gate checklist (run before every Supabase PR)

- [ ] Grep for anon key literal fingerprint (`x5x8Dk`) in all changed files — not just env var name
- [ ] New tables have RLS enabled + explicit policy before first use
- [ ] No `GRANT ALL TO anon` on new tables (check `information_schema.role_table_grants`)
- [ ] n8n credentials use Fixed mode (plain JSON, no `=` prefix, no `$env`)
- [ ] Credential verified against a service-role-only table before any canary
- [ ] Consumer migration verified with canary (REVOKE on one table, watch live run) before blanket REVOKE
- [ ] `workout_*` tables excluded until triple-a-tracker authenticates
- [ ] Trade Executor (`fq7spfyiNcpt8Mf7`) stays deactivated — only trade-placing workflow, gate (`trading_config.trading_enabled`) is erroneously TRUE
