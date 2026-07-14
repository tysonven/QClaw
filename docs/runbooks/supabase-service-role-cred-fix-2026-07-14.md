# Fix the service-role credential + FSC nodes (findings + scoped plan) — 2026-07-14

**Branch:** `cc/supabase-fix-service-role-cred-20260714`. **Status:** 🔎 findings only — **no credential/workflow
changes made.** Fix is presented for sign-off. Precursor to re-attempting Phase 2.
**Why:** the 2026-07-13 Phase 2 REVOKE broke production (Position Monitor + GHL Scheduled Publisher, 42501) and
was rolled back. Root cause: the "service_role migration" (Phase 1, PR #61) never actually used service_role.

## Root cause — two broken credentials

### 1. `fgbywZowo5p5iu9F` "Supabase Service Role (main)" (httpCustomAuth) — malformed nested expression
Decrypted `data.json` is stored as:
```
={ "headers": { "apikey": "={{ $env.SUPABASE_SERVICE_ROLE_KEY }}",
                "Authorization": "=Bearer {{ $env.SUPABASE_SERVICE_ROLE_KEY }}" } }
```
The **entire `json` field is an n8n expression** (leading `=`) that **wraps** per-value expressions (`={{ … }}`).
n8n does not resolve this double-nesting to the service_role key — nodes using this credential authenticate as
**anon** (proven: `dHceOMijUOcnEowO` "Fetch Due Drafts" uses only this credential and returned 42501 after the
revoke). The n8n process *does* hold the correct service_role key in `$env` (PID1 verified), and code-node
`$env.SUPABASE_SERVICE_ROLE_KEY` works — but the credential's json-field expression form does not deliver it.

**This credential is referenced by all ~19 Phase-1-migrated http nodes** (crete-*, ghl-marketing-*), so **every
one of them is currently on anon.** Fixing this one credential fixes all 19 at once (they reference it by id).

### 2. `Nd2uuX5t9KEwbQPv` "Supabase FSC" (httpHeaderAuth) — NOT empty; hardcodes the anon key
Decrypted: `name="apikey"`, `value=<literal anon JWT>`. It injects `apikey: <anon key>`. **This corrects the
prior "FSC is an empty no-op" note** (memory `project_n8n_supabase_fsc_credential`) — FSC actively authenticates
as anon. 7 workflows use it (below), and Phase 1 missed them because they reference the credential, not an inline
`SUPABASE_ANON_KEY` env var.

## FSC-cred node inventory (7 workflows)
| Workflow | id | FSC node(s) → table | active | in Phase-2 scope? |
|---|---|---|---|---|
| Trading – Position Monitor | `UYA0JppH7eqyI7fQ` | Fetch Open Positions → `trading_positions` | ✅ | yes |
| Trading – Market Scanner | `3YahxqOguET3pifj` | Save Simulations → `trading_simulations` | ✅ | yes |
| Trading – Weekly Analyst | `vjj2uBIPc07FpIxx` | Fetch Week Trades → `trading_positions`; Save Report → `trading_analyst_reports` (also broken inline `apikey=undefined`) | ✅ | yes |
| Trading – Trade Executor | `fq7spfyiNcpt8Mf7` | Fetch Config → `trading_config`; Save Position → `trading_positions` | ⏸ inactive | yes |
| Meta Ads Copy Agent | `0sIugM5o5wTwpflq` | Save Copy → `copy_agent_output` | ✅ | yes |
| Competitor Ad Research | `QnCEES9T7WxW5vVR` | Save Ad / Fetch Competitor Ads → `competitor_ads` | ✅ | **excluded table** |
| Meta Ads Ad Creation Agent | `lrGcirtmOHb1xTq8` | 6 nodes → `ad_creation_sessions` | ✅ | **excluded table** |

(Note: `lrGcirtmOHb1xTq8` + `lu39mAN7epBRK3Kw` ALSO carry a hardcoded anon JWT literal `x5x8Dk` in other nodes —
tracked separately; `lu39` is not FSC-based.)

## Scoped fix (for sign-off — nothing applied yet)

**Step 1 — fix `fgbywZowo5p5iu9F` (the linchpin).** In the n8n UI, edit the credential's JSON field to a **plain
JSON literal** (no leading `=`, no `$env` expression), with the **literal** service-role key value:
```json
{ "headers": {
    "apikey": "<SERVICE_ROLE_KEY_LITERAL>",
    "Authorization": "Bearer <SERVICE_ROLE_KEY_LITERAL>"
} }
```
Get the literal from `/root/.quantumclaw/.env` `SUPABASE_SERVICE_ROLE_KEY` (or the n8n `.env`); do not commit it.
This one edit converts all ~19 Phase-1 http nodes to genuine service_role.

**Step 2 — verify the credential is REALLY service_role (the test Phase 1 skipped).** Probe a **service-role-only**
table that anon cannot read — `content_studio_jobs` — using the fixed credential's key:
- Expect **HTTP 200**. If 401/42501 → still not service_role; stop.
- (Equivalently: re-run any migrated workflow and confirm it can reach a service-role-only table.)

**Step 3 — migrate the FSC nodes.** Repoint the in-scope FSC workflows' Supabase nodes (Position Monitor,
Market Scanner, Weekly Analyst, Trade Executor, Copy Agent) from `Nd2uuX5t9KEwbQPv` → `fgbywZowo5p5iu9F` (fixed).
Fix Weekly Analyst's broken inline `apikey=undefined` header too. (Competitor Ad Research + Ad Creation Agent hit
excluded tables — migrate later, but they remove an anon dependency so worth doing in the same pass.)

**Step 4 — re-verify EVERY migrated workflow's actual role** (service-role-only-table probe or JWT-role decode) —
not "it succeeds while anon is open." Only then re-attempt Phase 2 (REVOKE + RLS lock).

## Verification method (the Phase-1 mistake, corrected)
"Workflow succeeds after migration" while anon is still open **cannot** distinguish anon from service_role — it's
a false positive. Valid tests: (a) hit a service-role-only table (`content_studio_jobs`) and expect 200 where
anon gets 401/empty; (b) decode the JWT the request sends and confirm `role=service_role`; (c) anon-revoke canary
on one table. Use one of these on every consumer before any REVOKE.

---

## Update 2026-07-14 (later) — credential fixed & verified; FSC migration built

### Step 1 result — `fgbywZowo5p5iu9F` re-saved with the literal key ✅ (with one caveat)
Tyson replaced the value. Decrypted export now shows **no `{{ $env }}`** and the stored `apikey` decodes to
**`role=service_role`**; using that key, `content_studio_jobs` (service-role-only) returns **16 rows** while anon
returns **0**. So the key is genuinely service_role and the interpolation that broke it is gone.
- **Caveat:** the `json` field is still stored in n8n **expression mode** (leading `=`, but no `{{}}`) — the
  plain-JSON toggle didn't persist. With no `{{}}` to interpolate, this resolves to the literal, so it's expected
  to work; not yet proven at *server runtime*.
- **Runtime proof deferred to apply-day canary.** An `n8n execute` CLI probe was attempted but is unreliable here
  (broker-port collision; no `--file`; httpRequest node errors under `--id`) AND the CLI resolves credentials in
  its own context, so it isn't a faithful proxy for the live server. The faithful test is the **canary** below.

### Step 3 built — FSC → service-role migration (NOT applied)
Tool: `scripts/n8n/fsc-to-service-role.mjs` (pure local transform; idempotent; validated all-JSON-valid, 0 FSC
refs remaining, Weekly Analyst's broken `apikey=undefined` stripped). **15 FSC nodes across 7 workflows:**

```
0sIugM5o5wTwpflq  Copy Agent        [POST] Save Copy            -> copy_agent_output        [IN-SCOPE]
3YahxqOguET3pifj  Market Scanner    [POST] Save Simulations     -> trading_simulations      [IN-SCOPE]
UYA0JppH7eqyI7fQ  Position Monitor  [GET]  Fetch Open Positions -> trading_positions        [IN-SCOPE]
fq7spfyiNcpt8Mf7  Trade Executor    [GET]  Fetch Config / [POST] Save Position -> trading_config/positions [IN-SCOPE, inactive]
vjj2uBIPc07FpIxx  Weekly Analyst    [GET]  Fetch Week Trades / [POST] Save Report -> trading_positions/analyst_reports  [IN-SCOPE, strips apikey=undefined]
QnCEES9T7WxW5vVR  Competitor Ad Res [POST] Save Ad / [GET] Fetch -> competitor_ads          [EXCLUDED table — defer]
lrGcirtmOHb1xTq8  Ad Creation Agent 6 nodes                     -> ad_creation_sessions     [EXCLUDED table — defer]
```

**Apply scope (tomorrow):** the **5 IN-SCOPE workflows** (7 nodes) — required before the trading/`copy_agent_output`
REVOKE. Defer the 2 EXCLUDED-table workflows (their tables aren't locked this round; migrating them is anon-cleanup,
optional).

**Deploy mechanism** (same as Phase 1): read-only export of `workflow_entity.nodes` → run the transform `--out` →
transactional psql UPDATE (`nodes::json` + `versionId=gen_random_uuid()::text` + `updatedAt`) →
`docker restart n8n-project-n8n-1`. n8n Postgres = container `n8n-postgres`, `-U n8nuser -d n8n`.

### Apply-day sequence (with the canary that actually proves service_role)
1. Apply the FSC migration to the 5 in-scope workflows; restart n8n.
2. **Canary:** `REVOKE ALL ON public.trading_positions FROM anon` (one table only). Wait for the next Position
   Monitor run (~15 min, live server). If it **succeeds** → the fixed credential genuinely sends service_role →
   proceed. If **42501** → instant rollback (`GRANT`), the credential still isn't right → stop.
3. On green canary: run the full Phase 2 REVOKE + Phase 3 (the 9 tables), then re-verify (anon 401 on all 9,
   service_role 200, consumers green).
