# Supabase main project — anon-role RLS remediation plan (DRAFT — awaiting sign-off)

**Project:** `fdabygmromuqtysitodp` ("n8n database")
**Author dispatch:** CC Supabase Security Audit (2026-07-11)
**Branch:** `cc/supabase-security-audit-20260711`
**Status:** 🔴 DRAFT — **nothing in this document has been executed.** No SQL applied, no RLS changed, no
workflow edited, no host touched. Every code block below is `-- DO NOT APPLY UNTIL SIGN-OFF`.
**Companion:** audit findings in `QCLAW_BUILD_LOG.md` entry `[2026-07-11] Supabase main project … security audit`.

> **Requires explicit Tyson sign-off** (per dispatch brief: "No RLS policy changes without explicit sign-off").
> The RLS changes are destructive to any consumer still on the anon key, so **ordering is load-bearing** — do
> not skip ahead.

---

## 0. Problem in one paragraph

The `anon` role holds `GRANT ALL` on all 39 `public` tables (Supabase default, never revoked), so RLS is the
only access control. 13 tables carry `anon`/`public`-permissive policies (`allow_anon_all`, or two policies
misleadingly *named* "Service role full access" that are actually `TO public USING(true)`), making them
world-readable/writable by anyone holding the publishable anon key — which is confirmed exposed (hardcoded in
`triple-a-tracker/src/App.jsx`, present in n8n workflows). PoC read 2,569 rows from `trading_simulations`
with the anon key. The tables are *exposed on purpose* — live n8n workflows use the anon key to read/write
them — so the fix must migrate consumers first, or it takes production down.

---

## 1. Confirmed ordering (Tyson-approved shape)

```
(1) consumers off anon  →  (2) REVOKE ALL FROM anon  →  (3) replace policies  →  (4) verify
                                                             │
                          workout_* branch: app adopts Supabase Auth ──┘ (own timeline)
then, separately: (5) .env.bak* cleanup on n8n   ·   (6) JWT service-role rotation (Tasks 3/4)
```

**Why this order:** REVOKE/policy-lock before consumer migration = immediate outage of Crete publishing, GHL
marketing, and the trading monitor. Consumer migration before REVOKE = zero-downtime because service_role
already satisfies every policy. `workout_*` is decoupled — it depends on an app change (Supabase Auth), not on
the n8n work, and must not block the rest.

---

## 2. Phase 1 — migrate anon-key consumers to service_role / `httpCustomAuth`  *(no DB change yet)*

Goal: every process that currently authenticates to PostgREST with `SUPABASE_ANON_KEY` switches to the
service-role key (server-side only) **before** any GRANT/policy change. This is a superset of tracked
follow-up ζ.6 (replace credential `XTzNI4kxIpHcVjlB` / retire no-op "Supabase FSC" `Nd2uuX5t9KEwbQPv`).

### 2a. n8n workflows (live, by id — non-prefixed/`.before-*-fix` copies in the repo are artifacts)
| Workflow | id | Tables touched | Note |
|---|---|---|---|
| Crete – Content Generator | `tnvXFYvODL1PrhJa` | `crete_content_queue` | 2 header pairs (lines 139/143, 846/850) |
| Crete – Content Publish | `zXKBjp3yjW2oR2Mj` | `crete_content_queue` | GET + PATCH status |
| Crete – Scheduled Publisher | `9kTWhh9PlxMpyMlp` | `crete_content_queue` | GET approved-due |
| GHL Marketing: Content Generator | `Awo65rdSe5BvDHtC` | `marketing_drafts` | |
| GHL Marketing: Publisher | `fonuRTyqepxdyIdf` | `marketing_drafts` | |
| GHL Marketing: Scheduled Publisher | `dHceOMijUOcnEowO` | `marketing_drafts` | |
| GHL Marketing: Approval Handler | `ptHK2TZq5XppKOOg` | `marketing_drafts` | |
| GHL Marketing: Platform Retry | `OnuJyXpNP488bXnH` | `marketing_drafts` | |
| GHL Marketing: Weekly Report | `jRiiOsWneQAtfVPD` | `marketing_drafts` (read) | carries no-op "Supabase FSC" cred |
| Content Studio Pipeline | `Qf39NEOEgz2W0uls` | `content_studio_jobs` | ⚠️ table is **already** service-role-only → its anon writes likely already fail RLS; verify current behaviour before/after |
| Trading Position Monitor | `UYA0JppH7eqyI7fQ` | `trading_*` | reads/writes positions/config/simulations |

**Method (per node):** replace the two inline headers
`apikey: {{$env.SUPABASE_ANON_KEY}}` / `Authorization: Bearer {{$env.SUPABASE_ANON_KEY}}`
with a single reusable **`httpCustomAuth`** credential that sends **both** `apikey` and `Authorization: Bearer`
set to `{{$env.SUPABASE_SERVICE_ROLE_KEY}}`. (Do NOT rely on the empty "Supabase FSC" `httpHeaderAuth` — it is
a confirmed no-op; see memory `project_n8n_supabase_fsc_credential`.) Edit via the n8n UI, or the
surgical-UPDATE path (memory `project_n8n_edit_workflow_no_api_key`) — the n8n API key currently 401s
(memory `project_n8n_api_key_401`).

> ⚠️ Once a node uses the **service_role** key it **bypasses RLS entirely**. Confirm each migrated workflow
> filters correctly in-query (e.g. keeps `status=eq.approved`) — RLS is no longer a backstop for it.

### 2b. QClaw source
- `src/dashboard/server.js:1490` — `CRETE_SUPABASE_KEY = creteEnv.SUPABASE_ANON_KEY`. If any Crete dashboard
  route **writes** `crete_content_queue`, switch it to `SUPABASE_SERVICE_ROLE_KEY` (server-side; the dashboard
  server must never leak the service key to the browser). If routes are read-only public, keep anon but they
  will stop working once `crete_content_queue` is locked — decide per route.
- `src/observability/liveness-watcher.js:162` — already prefers `SERVICE_ROLE_KEY`; the `|| SUPABASE_ANON_KEY`
  fallback becomes dead after REVOKE (anon can't read `workflow_heartbeats` anyway). Drop the fallback.
- Read-only probes / log-redaction list / task-runner `.sh` files — no change needed (not write paths).

**Exit criterion for Phase 1:** grep shows no *write* path on the service side using the anon key; every live
workflow above re-tested green against its table using service_role.

---

## 3. Phase 2 — REVOKE the blanket anon GRANT  *(DB change; apply only after Phase 1 verified)*

Defense-in-depth: even with corrected policies, `anon` should not hold table privileges it never needs.

```sql
-- DO NOT APPLY UNTIL SIGN-OFF + Phase 1 complete
BEGIN;

-- 1) anon gets nothing in public. Nothing legitimate uses anon after Phase 1.
REVOKE ALL PRIVILEGES ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM anon;

-- 2) stop FUTURE tables from auto-granting to anon (the mechanism that created this mess).
--    NOTE: default privileges are owner-scoped; run for each role that creates tables here
--    (typically 'postgres' and 'supabase_admin'). Review before applying — dashboard-created
--    tables may still re-grant; treat as hardening, re-audit after any new table.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

-- 'authenticated' is intentionally NOT blanket-revoked here: workflow_heartbeats has an
-- authenticated-read policy, and workout_* will use authenticated after the app migration.
-- If you want least-privilege on authenticated too, revoke-all then re-grant narrowly:
--   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
--   GRANT SELECT ON public.workflow_heartbeats TO authenticated;
--   GRANT SELECT, INSERT, UPDATE ON public.workout_logs, public.workout_settings TO authenticated;  -- post app-migration

COMMIT;
```

**Verify service_role is unaffected** (it has `BYPASSRLS` + its own grants in Supabase; revoking from anon
does not touch it). Post-apply, re-run the audit probe — every exposed table must now read `*/0` for anon
even before policy edits.

**Rollback:** `GRANT ALL ON ALL TABLES IN SCHEMA public TO anon;` (restores prior state). Keep a snapshot of
`role_table_grants` for `anon` before applying.

---

## 4. Phase 3 — replace the permissive policies

### 4a. Service-role-only tables (10 full + 1 insert)
Applies to: `trading_simulations`, `trading_positions`, `trading_config`, `trading_markets`,
`trading_analyst_reports`, `social_clip_schedules`, `ad_creation_sessions`, `competitor_ads`,
`crete_content_queue`, `marketing_drafts`, `copy_agent_output`.

```sql
-- DO NOT APPLY UNTIL SIGN-OFF. Idempotent; wrap per-table or all-in-one transaction.
BEGIN;

-- drop the anon/public-permissive + inert decoy policies
DROP POLICY IF EXISTS "allow_anon_all"          ON public.trading_simulations;
DROP POLICY IF EXISTS "allow_anon_all"          ON public.trading_positions;
DROP POLICY IF EXISTS "allow_anon_all"          ON public.trading_config;
DROP POLICY IF EXISTS "allow_anon_all"          ON public.trading_markets;
DROP POLICY IF EXISTS "allow_anon_all"          ON public.trading_analyst_reports;
DROP POLICY IF EXISTS "allow_anon_all"          ON public.social_clip_schedules;
DROP POLICY IF EXISTS "allow_anon_all"          ON public.ad_creation_sessions;
DROP POLICY IF EXISTS "No public access"        ON public.ad_creation_sessions;   -- inert decoy
DROP POLICY IF EXISTS "allow_anon_all"          ON public.competitor_ads;
DROP POLICY IF EXISTS "No public access"        ON public.competitor_ads;         -- inert decoy
DROP POLICY IF EXISTS "allow_anon_insert"       ON public.copy_agent_output;
DROP POLICY IF EXISTS "No public access"        ON public.copy_agent_output;      -- inert decoy
DROP POLICY IF EXISTS "Service role full access" ON public.crete_content_queue;   -- MISNAMED: was TO public USING(true)
DROP POLICY IF EXISTS "Service role full access" ON public.marketing_drafts;      -- MISNAMED: was TO public USING(true)

-- one correct service-role policy per table
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'trading_simulations','trading_positions','trading_config','trading_markets',
    'trading_analyst_reports','social_clip_schedules','ad_creation_sessions',
    'competitor_ads','copy_agent_output','crete_content_queue','marketing_drafts'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true)',
      'service_role_all', t);
  END LOOP;
END $$;

COMMIT;
```

### 4b. The 6 "RLS-on, 0-policy" tables — add an explicit policy (documents intent, satisfies criterion)
`advisor_conversations`, `charlie_tasks`, `claude_code_dispatches`, `clip_jobs`, `highlevel_tokens_backup`,
`specialist_dispatches` are already secure (implicit deny) but have no explicit policy.

```sql
-- DO NOT APPLY UNTIL SIGN-OFF. Behaviour-neutral (service_role already bypasses RLS).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'advisor_conversations','charlie_tasks','claude_code_dispatches',
    'clip_jobs','highlevel_tokens_backup','specialist_dispatches'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true)',
      'service_role_all', t);
  END LOOP;
END $$;
```

### 4c. `workout_logs` / `workout_settings` — `auth.uid()`-scoped (BLOCKED on app migration)

These belong to `github.com/tysonven/triple-a-tracker`, a real user-facing app — so they get **owner-scoped
RLS**, not service_role. **But the app cannot use `auth.uid()` today:**

- `user_id` is `text NOT NULL`, **no FK to `auth.users`**.
- The app has **no Supabase Auth**: `App.jsx` hardcodes the anon key and derives identity from a
  client-side `crypto.randomUUID()` in `localStorage` (`getUserId()`), also settable via `?uid=` URL param.
- Every request hits PostgREST as `anon` ⇒ `auth.uid()` is `NULL`. **Applying the policy below now would deny
  100% of the app's traffic.**

**Prerequisite (app-team PR, separate from this DB work):**
1. Adopt Supabase Auth — simplest path is `supabase.auth.signInAnonymously()` on load (gives each device a real
   `auth.users` row + uuid) and send the session access token instead of the raw anon key.
2. Backfill: map each device's old `localStorage` uid → its new `auth.uid()` (reuse the existing
   `user_id='legacy'` migration pattern in `App.jsx`), or migrate `user_id` column `text` → `uuid`.
3. Move the hardcoded `SB_KEY` out of source into a build-time env var (still the publishable key, but stop
   committing it).

**Target policy (apply ONLY after the app sends authenticated JWTs whose sub == user_id):**
```sql
-- DO NOT APPLY UNTIL triple-a-tracker authenticates via Supabase Auth. Otherwise it denies all app traffic.
BEGIN;
DROP POLICY IF EXISTS "Users see own logs"      ON public.workout_logs;
DROP POLICY IF EXISTS "Users insert own logs"   ON public.workout_logs;
DROP POLICY IF EXISTS "Users update own logs"   ON public.workout_logs;
DROP POLICY IF EXISTS "Users see own settings"    ON public.workout_settings;
DROP POLICY IF EXISTS "Users insert own settings" ON public.workout_settings;
DROP POLICY IF EXISTS "Users update own settings" ON public.workout_settings;

CREATE POLICY "own rows" ON public.workout_logs
  AS PERMISSIVE FOR ALL TO authenticated
  USING (user_id = (select auth.uid())::text)
  WITH CHECK (user_id = (select auth.uid())::text);

CREATE POLICY "own rows" ON public.workout_settings
  AS PERMISSIVE FOR ALL TO authenticated
  USING (user_id = (select auth.uid())::text)
  WITH CHECK (user_id = (select auth.uid())::text);
COMMIT;
-- Long-term: migrate user_id text→uuid and reference auth.users(id); then drop the ::text cast.
```

Until the app migrates, `workout_*` remains anon-open. Options to discuss: (a) accept the risk short-term
(low-sensitivity fitness data), (b) lock to `service_role` + proxy through a tiny backend, or (c) prioritise
the app auth PR. **Recommend (c) or (a)-with-a-deadline; do not silently leave it open.**

---

## 5. Phase 4 — verify consumers still run
- Re-run the audit inventory (Appendix B) — expect 0 tables with anon/public-permissive policies; every
  formerly-exposed table reads `*/0` for the anon key.
- Trigger each migrated workflow (or wait one cron cycle) and confirm success in n8n executions + the audit.db.
- Confirm Crete publish + GHL marketing weekly report produce non-empty results (they were reading via anon;
  post-migration they read via service_role).
- Confirm `content-studio-pipeline` behaviour is understood (it wrote a service-role-only table via anon —
  was it already failing? verify).

## 6. Phase 5 — n8n `.env.bak*` cleanup (in scope, no execution this session)
11 `*.env.bak*` files under `/home/n8nadmin/n8n-project/` contain the anon JWT (and likely old service-role
keys) in plaintext. Proposed: move them out of the project dir to a `chmod 600` archive outside the compose
context (or delete after confirming no rollback need), and add `*.env.bak*` / `.env.before-*` to
`.gitignore`/ops hygiene. **Do not delete blind** — list and eyeball first (some are dated pre-token-rotation
snapshots that may be the only record of a prior key).

```bash
# INVENTORY ONLY — do not delete without review
ls -la /home/n8nadmin/n8n-project/.env* 
```

## 7. Then, separately — JWT service-role rotation (original Tasks 3/4)
Independent of everything above. Execute the brief's Step 0/Step 1 (generate `sb_secret_*`, update both hosts,
reload PM2 / recreate n8n container), **then** re-dispatch CC to run:
- Task 3: new key authenticates (Shape-C probe → HTTP 200).
- Task 4: legacy JWT returns 401 after you disable it in the dashboard.
Rotating the service-role key does **not** touch the anon exposure above — they are separate keys and separate
problems. Sequence rotation *after* Phase 1 (consumers already re-pointed at the service-role env var, so the
rotation is a value swap, not a re-plumb).

---

## 8. Sign-off checklist (tick before each phase executes)
- [ ] **Phase 1** approved — consumer migration list confirmed; `httpCustomAuth` cred built (service key, both headers)
- [ ] Phase 1 verified — no service-side anon write paths; all 11 workflows green on service_role
- [ ] **Phase 2** approved — `REVOKE … FROM anon` (+ optional authenticated re-grant); `anon` grant snapshot saved
- [ ] **Phase 3a/3b** approved — permissive policies replaced; 0-policy tables documented
- [ ] **Phase 3c** — app-team confirms triple-a-tracker on Supabase Auth **before** workout_* policy applies
- [ ] Phase 4 verified — audit re-run clean; consumers running
- [ ] Phase 5 — `.env.bak*` reviewed + archived
- [ ] Phase 6 — JWT rotation Tasks 3/4 green; legacy key disabled

---

## Appendix A — full exposed-table list (13)
`trading_simulations`, `trading_positions`, `trading_config`, `trading_markets`, `trading_analyst_reports`,
`crete_content_queue`, `marketing_drafts`, `ad_creation_sessions`, `competitor_ads`, `social_clip_schedules`,
`copy_agent_output` (insert), `workout_logs`, `workout_settings`.

## Appendix B — re-audit queries (read-only, reusable)
```sql
-- policies that expose anon/public
SELECT tablename, policyname, roles::text, cmd, qual, with_check
FROM pg_policies WHERE schemaname='public'
  AND roles::text ~ '(anon|public)'
  AND (qual = 'true' OR qual IS NULL)
ORDER BY tablename;

-- anon table grants (should be empty after Phase 2)
SELECT table_name, string_agg(privilege_type, ', ') 
FROM information_schema.role_table_grants
WHERE table_schema='public' AND grantee='anon' GROUP BY table_name ORDER BY table_name;
```
Live anon PoC (count-only, no data printed) is the n8n-container `fetch` with `Prefer: count=exact` + `Range: 0-0`
used in the audit — re-run and expect `*/0` everywhere.

## Appendix C — what was NOT changed this session
DB (no SQL applied), RLS (unchanged), n8n workflows (unread-only), hosts (`.env` untouched, no PM2/docker
action), Supabase dashboard (no key generated/disabled). This document + the `QCLAW_BUILD_LOG.md` entry are the
only artifacts.
