# Phase 1 — migrate anon-key consumers to service-role (DRAFT — awaiting sign-off)

**Parent plan:** `docs/runbooks/supabase-anon-rls-remediation-2026-07-11.md` (Phase 1).
**Project:** Supabase `fdabygmromuqtysitodp`. **Branch:** `cc/supabase-phase1-anon-consumer-migration-20260711`.
**Status:** 🔴 DRAFT — **nothing executed.** No credential created, no workflow edited, no DB/host touched. All
prep is local: the transform script + this runbook. Live apply is gated on Tyson sign-off.
**Tool:** `scripts/n8n/phase1-anon-to-service-role.mjs` (pure local transform; never connects to n8n).

> Goal: every n8n consumer that currently authenticates to Supabase PostgREST with the **publishable anon key**
> switches to the **service-role key** *before* Phase 2/3 revoke anon + lock RLS. Until RLS is locked, both keys
> still work — so this phase is verifiable now (a wrong credential 401s) and de-risks the later phases.

---

## 1. Scope — 10 of 11 workflows, 20 nodes

`content-studio-pipeline` (`Qf39NEOEgz2W0uls`) is **EXCLUDED** — see §2. All 10 included workflows are `active`
with real success history.

| Workflow | id | nodes migrated | table(s) |
|---|---|---|---|
| Crete – Content Generator | `tnvXFYvODL1PrhJa` | 1 http | `crete_content_queue` |
| Crete – Content Publish | `zXKBjp3yjW2oR2Mj` | 4 http | `crete_content_queue` |
| Crete – Scheduled Publisher | `9kTWhh9PlxMpyMlp` | 1 http | `crete_content_queue` |
| GHL Marketing: Content Generator | `Awo65rdSe5BvDHtC` | 2 http | `marketing_drafts` |
| GHL Marketing: Publisher | `fonuRTyqepxdyIdf` | 3 http | `marketing_drafts` |
| GHL Marketing: Scheduled Publisher | `dHceOMijUOcnEowO` | 1 http | `marketing_drafts` |
| GHL Marketing: Approval Handler | `ptHK2TZq5XppKOOg` | 4 http | `marketing_drafts` |
| GHL Marketing: Platform Retry | `OnuJyXpNP488bXnH` | 2 http | `marketing_drafts` |
| GHL Marketing: Weekly Report | `jRiiOsWneQAtfVPD` | 1 http | `marketing_drafts` (read) |
| Trading – Position Monitor | `UYA0JppH7eqyI7fQ` | **1 code** | `trading_positions` |
| **Total** | | **19 http + 1 code = 20** | |

Note: `Awo65rdSe5BvDHtC` and `OnuJyXpNP488bXnH` are `active` but have very few recorded executions (1 and 6) —
trigger them manually during verification (§6) rather than waiting for a natural fire.

---

## 2. Content Studio Pipeline — verification result (why excluded)

Per instruction, checked before touching it. Read-only query of `execution_entity`:

- `Qf39NEOEgz2W0uls` is `active=true`, `triggerCount=1`, **0 executions ever**.
- Global execution history spans **2025-09-17 → 2026-07-11** (10,148 rows, not pruned) — so 0 executions is
  real, not a pruning artifact. It has never run.
- It is the **only** target that writes `content_studio_jobs`, which is **service-role-only** in RLS — so its
  anon writes would `403` (RLS) *if it ever fired*. It is effectively dormant + would-fail.

**Decision:** excluded from this slice (dormant, unverifiable — we can't confirm a successful migration by
re-running it). Tracked for separate triage: *why has it never executed?* Migrate it only once it actually
runs (or retire it).

---

## 3. The credential — `httpCustomAuth` "Supabase Service Role (main)"

One reusable credential injects both Supabase headers from the service-role key; the 19 http nodes reference it.

- **n8n → Credentials → New → "HTTP Custom Auth"** (type `httpCustomAuth`). Name it **`Supabase Service Role (main)`**.
- JSON body (both headers, apikey + Bearer):
  ```json
  { "headers": {
      "apikey": "<SUPABASE_SERVICE_ROLE_KEY>",
      "Authorization": "Bearer <SUPABASE_SERVICE_ROLE_KEY>"
  } }
  ```
  Paste the current service-role key from the host `.env` (`/root/.quantumclaw/.env` or n8n `.env`). **Do not
  commit the key.** This one credential becomes the single rotation point (Phase 6 updates it, not 11 nodes).
  - *Alternative* (single source of truth with env): value `={{ $env.SUPABASE_SERVICE_ROLE_KEY }}` — only if your
    n8n resolves `$env` inside credential fields; verify on one node before relying on it. Literal is the safe default.
- Create via the **UI** (DB-inserting an encrypted credential by hand is error-prone). **Copy the resulting
  credential id** — it's the `--cred-id` for the transform. Same owner/project as the workflows (Tyson personal).

---

## 4. What the transform does (reviewed dry-run)

For each **httpRequest** node with inline `apikey`/`Authorization: Bearer {{$env.SUPABASE_ANON_KEY}}`:
remove those two headers, keep any `Content-Type`/`Prefer`, set `authentication=genericCredentialType` +
`genericAuthType=httpCustomAuth`, attach `credentials.httpCustomAuth`, and drop the no-op `Supabase FSC`
(`Nd2uuX5t9KEwbQPv`) `httpHeaderAuth` cred. For the **code** node (Trading), swap `$env.SUPABASE_ANON_KEY` →
`$env.SUPABASE_SERVICE_ROLE_KEY` in `jsCode` (code nodes can't use an n8n credential for `fetch()`).

Verbatim dry-run (`node scripts/n8n/phase1-anon-to-service-role.mjs --in <export>`), verified idempotent and
all-JSON-valid:

```
• 9kTWhh9PlxMpyMlp: [http GET] "Query Approved Due": -headers[apikey,Authorization] +httpCustomAuth sendHeaders=false (dropped FSC no-op)
• Awo65rdSe5BvDHtC: [http GET]  "Fetch Recent Hooks": -[apikey,Authorization] +httpCustomAuth sendHeaders=false
              [http POST] "Save to Supabase": -[apikey,Authorization] +httpCustomAuth keep[Content-Type,Prefer]
• OnuJyXpNP488bXnH: [http GET]  "Fetch Draft": -[apikey,Authorization] +httpCustomAuth sendHeaders=false
              [http PATCH]"Update Supabase": -[apikey,Authorization] +httpCustomAuth keep[Prefer,Content-Type]
• UYA0JppH7eqyI7fQ: [code] "Update Positions": swapped 4× $env.SUPABASE_ANON_KEY -> $env.SUPABASE_SERVICE_ROLE_KEY
• dHceOMijUOcnEowO: [http GET]  "Fetch Due Drafts": -[apikey,Authorization] +httpCustomAuth sendHeaders=false
• fonuRTyqepxdyIdf: [http GET]  "Fetch Draft" / "LI Guard Check": -[apikey,Authorization] +httpCustomAuth sendHeaders=false
              [http PATCH]"Update Supabase": -[apikey,Authorization] +httpCustomAuth keep[Prefer,Content-Type]
• jRiiOsWneQAtfVPD: [http GET]  "Fetch Marketing Stats": -[apikey,Authorization] +httpCustomAuth sendHeaders=false (dropped FSC no-op)
• ptHK2TZq5XppKOOg: [http PATCH]"Approve in Supabase"/"Save Feedback"/[GET]"Fetch Original"/[POST]"Save New Draft" (dropped FSC no-op)
• tnvXFYvODL1PrhJa: [http POST] "Insert to Supabase": -[apikey,Authorization] +httpCustomAuth keep[Content-Type,Prefer]
• zXKBjp3yjW2oR2Mj: [http GET]"Get Content" + [http PATCH]×3 "Update Status"/"Mark Failed"/"Patch Attempts"

summary: 19 httpRequest -> httpCustomAuth, 1 code env-swapped.
```

---

## 5. Deploy procedure (run on the **n8n host**, on sign-off — NOT now)

> Prereq: credential created (§3), its id in hand. n8n Postgres = container `n8n-postgres`, `-U n8nuser -d n8n`.

```bash
# 0) BACKUP — export current nodes for all 10 (rollback baseline). Keep off-container.
IDS="tnvXFYvODL1PrhJa zXKBjp3yjW2oR2Mj 9kTWhh9PlxMpyMlp Awo65rdSe5BvDHtC fonuRTyqepxdyIdf \
dHceOMijUOcnEowO ptHK2TZq5XppKOOg OnuJyXpNP488bXnH jRiiOsWneQAtfVPD UYA0JppH7eqyI7fQ"
mkdir -p ~/phase1-backup ~/phase1-in ~/phase1-out
for id in $IDS; do
  docker exec -i n8n-postgres psql -U n8nuser -d n8n -tAc \
    "SELECT nodes FROM workflow_entity WHERE id='$id'" > ~/phase1-in/$id.nodes.json
  cp ~/phase1-in/$id.nodes.json ~/phase1-backup/$id.nodes.json
done

# 1) TRANSFORM (writes new nodes to ~/phase1-out; still no DB change)
node scripts/n8n/phase1-anon-to-service-role.mjs \
  --in ~/phase1-in --out ~/phase1-out \
  --cred-id "<CREDENTIAL_ID>" --cred-name "Supabase Service Role (main)"

# 2) APPLY per workflow — new nodes + fresh versionId + updatedAt. Output is single-line JSON.
for id in $IDS; do
  docker exec -i n8n-postgres psql -U n8nuser -d n8n \
    -v nn="$(cat ~/phase1-out/$id.nodes.json)" \
    -c "UPDATE workflow_entity
        SET nodes = :'nn'::jsonb, \"versionId\" = gen_random_uuid(), \"updatedAt\" = now()
        WHERE id = '$id';"
done

# 3) RELOAD — restart n8n so active workflows re-read from DB
docker restart n8n-project-n8n-1
```

**Rollback** (any/all): re-apply the backup, same UPDATE with `~/phase1-backup/$id.nodes.json`, restart n8n.
The credential can stay (harmless when unreferenced) or be deleted.

---

## 6. Verification (must pass before calling Phase 1 done)
- **No new anon nodes:** re-export nodes and re-run the transform in dry-run → expect `no anon nodes (skip)` for all 10.
- **Each workflow succeeds on service_role** (a wrong credential 401s, so this is a real test):
  - Trading Position Monitor (`UYA0JppH7eqyI7fQ`) — runs frequently; confirm next executions are `success`, not `error`.
  - Crete publish/generate/scheduler — trigger a test content item through, confirm `crete_content_queue` GET/PATCH succeed.
  - GHL marketing — manually execute Content Generator + Platform Retry (low natural volume); confirm `marketing_drafts` writes succeed.
  - Weekly Report — manual run; confirm it now returns non-empty stats.
- **n8n executions clean:** `SELECT "workflowId",status,count(*) FROM execution_entity WHERE "startedAt">now()-interval '1 hour' GROUP BY 1,2;` — no new `error` rows for the 10.
- **Repo snapshots:** re-export the 10 workflows and refresh `n8n-workflows/*.json` (add `OnuJyXpNP488bXnH` which is missing) in a follow-up commit so source-of-truth matches live.

---

## 7. Sign-off checklist
- [ ] Credential `Supabase Service Role (main)` created (UI), id captured
- [ ] Backup export of all 10 workflows saved off-container
- [ ] Transform run with real `--cred-id`; `~/phase1-out` reviewed
- [ ] UPDATEs applied (10) + `versionId` bumped + n8n restarted
- [ ] Verification §6 green (esp. Trading Monitor + a Crete + a GHL write)
- [ ] Repo `n8n-workflows/*.json` snapshots refreshed (incl. platform-retry)
- [ ] Content Studio Pipeline triage ticket opened (excluded item)
- [ ] → clears the way for Phase 2 (`REVOKE ALL FROM anon`) + Phase 3 (RLS lock)

## Appendix — not changed here
No RLS/GRANT change (Phase 2/3), no `workout_*` (Tyson opening a triple-a-tracker issue separately;
short-term risk accepted), no JWT rotation (Phase 6), no host `.env`/PM2 change. This PR = the transform
script + this runbook only.
