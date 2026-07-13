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
