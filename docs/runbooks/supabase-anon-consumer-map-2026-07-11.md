# Supabase anon-role consumer map — Phase 2 pre-flight (2026-07-11)

**Project:** `fdabygmromuqtysitodp`. **Parent plan:** `supabase-anon-rls-remediation-2026-07-11.md`.
**Status:** 🛑 **Phase 2 (`REVOKE ALL FROM anon`) BLOCKED — nothing revoked.** Pre-flight found that **every**
table in the exposed set still has at least one live anon-role consumer, so no table is safe to lock yet
(not even `trading_*`, which was assumed clean). No DB/host/code changes were made tonight.

## Headline finding — the anon key is hardcoded, widely
Phase 1 migrated 10 n8n workflows by grepping for the **env var** `SUPABASE_ANON_KEY`. That undercounted the
surface badly: the anon **JWT literal** (`eyJ…role":"anon"…6JJ…x5x8Dk`) is **hardcoded in committed source and
in workflow definitions** in many more places. A real Phase 2 must migrate all of these off anon first, then
revoke table-by-table.

> **Security note (new):** the publishable anon key is fine to expose, but hardcoding a credential literal
> ~13× in `server.js` and in `polymarket_scanner.py` (both committed to the repo) is poor practice and makes
> rotation/lockdown a multi-file code change. Worth cleaning up to `$env` / service-role regardless of Phase 2.

## Full consumer map (exposed tables → who still uses anon)

| Table | Consumer | Location / id | Auth | R/W |
|---|---|---|---|---|
| `crete_content_queue` | QClaw dashboard | `server.js` Crete routes (~1548–1676) | env `SUPABASE_ANON_KEY` | R/W (7) |
| `marketing_drafts` | QClaw dashboard | `server.js` GHL routes (~1719–1861) | env `SUPABASE_ANON_KEY` | R/W (5) |
| `social_clip_schedules` | QClaw dashboard | `server.js` `/api/content-studio/schedule-clip` (1245) | **hardcoded anon JWT** | W |
| `trading_positions` | QClaw dashboard | `server.js` (1303/1304/1367…) | **hardcoded anon JWT (~13×)** | R/W |
| `trading_simulations` | QClaw dashboard | `server.js` (1329 POST, 1378…) | hardcoded anon JWT | R/W |
| `trading_config` | QClaw dashboard | `server.js` (1389/1402/1410) | hardcoded anon JWT | R/W |
| `trading_markets` | **polymarket_scanner.py** | `src/trading/polymarket_scanner.py:25,129` | **hardcoded anon JWT** | W (POST) |
| `trading_*` | Trading Market Scanner | n8n `3YahxqOguET3pifj` (active) | REST, auth **unverified** (no anon-lit/env/svc/cred detected) | ? |
| `trading_*` | Trading Weekly Analyst | n8n `vjj2uBIPc07FpIxx` (active) | REST, auth **unverified** | ? |
| `trading_*` | Trading Trade Executor | n8n `fq7spfyiNcpt8Mf7` (**inactive**) | REST, auth **unverified** | ? |
| `ad_creation_sessions` | Meta Ads Telegram Bot Router | n8n `lu39mAN7epBRK3Kw` (active) | **hardcoded anon JWT inline** | R |
| `ad_creation_sessions` | Meta Ads Ad Creation Agent | n8n `lrGcirtmOHb1xTq8` (active) | hardcoded anon JWT + `httpHeaderAuth`(FSC no-op) | R/W/DELETE |
| `competitor_ads` | Competitor Ad Research | n8n `QnCEES9T7WxW5vVR` (active) | `httpHeaderAuth` = FSC no-op — **auth unverified** (may already 401) | R/W |
| `copy_agent_output` | Meta Ads Copy Agent | n8n `0sIugM5o5wTwpflq` (active) | `httpHeaderAuth` = FSC no-op — **auth unverified** | W |
| `workout_logs` / `workout_settings` | triple-a-tracker | `App.jsx` (hardcoded anon) | hardcoded anon JWT | R/W — **DEFERRED** |

Already migrated in Phase 1 (now service_role, ✓): the 10 workflows (crete-*, ghl-marketing-*, Trading
Position Monitor `UYA0JppH7eqyI7fQ`). Already-locked tables (26, service_role/deny-all/0-policy) are untouched.

## Why nothing was locked tonight
Every one of the 13 exposed tables has a live anon consumer. Revoking anon on any of them (or replacing its
`allow_anon_all` policy) would break the dashboard, the Polymarket scanner, live Meta Ads workflows, or
triple-a-tracker. There is **no safe single-table lockdown available** until the consumers are migrated.

## Recommended sequence for next session
1. **Migrate `server.js`** (the big one) — it's the dominant anon consumer (Crete + GHL + Content Studio +
   Trading routes). It's server-side, so switch to the **service-role** key from `.env` (never exposed to
   browser); remove the ~13 hardcoded anon literals. One dashboard, one redeploy (`pm2 restart quantumclaw`).
2. **Migrate `polymarket_scanner.py`** — swap hardcoded anon JWT → `SUPABASE_SERVICE_ROLE_KEY` from env
   (note: clipper-worker-style env caching — restart the service after).
3. **Characterize + migrate the remaining workflows** — the 2 FSC-cred Meta Ads (`QnCEES9T7WxW5vVR`,
   `0sIugM5o5wTwpflq`) and the 3 trading (`3YahxqOguET3pifj`, `vjj2uBIPc07FpIxx`, `fq7spfyiNcpt8Mf7`): resolve
   their actual auth (FSC no-op likely already broken — verify executions), migrate to the
   `Supabase Service Role (main)` cred (`fgbywZowo5p5iu9F`) or code env-swap as appropriate. The 2 hardcoded-anon
   Meta Ads (`lu39mAN7epBRK3Kw`, `lrGcirtmOHb1xTq8`) → cred or env-swap.
4. **Then** Phase 2/3 **per table**, once its consumers are all off anon: `REVOKE ALL … FROM anon` on the
   table + replace `allow_anon_all` (or misnamed `TO public USING(true)`) with a `service_role` policy, verify
   with the anon probe (expect permission-denied), move to the next.
5. **`workout_*`** stays deferred (triple-a-tracker Supabase-Auth migration — separate issue).

## Verification tooling
- Anon probe (read-only, count-only) — the n8n-container `fetch` with `Prefer: count=exact` + `Range: 0-0`.
- Find hardcoded anon literals: grep for the fingerprint `x5x8Dk` (end of the anon JWT) across source + n8n
  `workflow_entity.nodes`, **not** just the env-var name `SUPABASE_ANON_KEY`.
