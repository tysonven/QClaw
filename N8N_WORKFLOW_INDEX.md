# N8N Workflow Index

This is the canonical workflow registry for every active workflow on `webhook.flowos.tech`. Charlie reads it at session bootstrap (per the Phase 3 Component 1 bootstrap design) so he never reasons about workflows from name alone — every workflow has a documented purpose, owner, trigger, and known-issue context grounded in the workflow's actual node structure.

This file is the sixth canonical doc Charlie reads at session start, after `CEO_OPERATING_MODEL.md`, `CHARLIE_ROLE.md`, `LOCATIONS.md`, `FLOW_OS_STATE.md`, and `FLOW_OS_SPECIALISTS.md`.

**Last updated:** 2026-05-04

## Maintenance rules

- **Charlie writes autonomously to:** Recent activity fields (execution counts, last-successful timestamps), heartbeat status changes, error workflow setting changes (when verified by probe).
- **Charlie surfaces for Tyson approval before writing:** new workflow entries, category changes, bucket promotions/demotions, ownership changes, purpose paragraph rewrites.
- **Tyson edits directly (with Claude (chat) help):** structural changes (e.g. splitting the file when it grows beyond manageable), category definitions, format conventions.
- **Refresh cadence:** Charlie probes workflow execution stats at every bootstrap (per Phase 3 Component 1 Layer 5). Static fields (purpose, trigger, ownership) refresh only on Tyson-approved updates.

## Architectural principles for this doc

- **Single file for v1.** The doc is structured by category internally. If the file grows beyond manageable (rough threshold: 100+ workflows or 5000+ lines), it splits into `n8n-workflows/<category>.md` files with this file becoming the index. Migration is locked via the Single Source of Location pattern (`LOCATIONS.md` updates point to the new structure; nothing else breaks).
- **Workflow IDs are canonical.** Names can change; IDs cannot. Every reference to a workflow in this doc, in `FLOW_OS_SPECIALISTS.md`, and in code uses the workflow ID.
- **Live data pulled from n8n at bootstrap.** This doc captures static structure (purpose, trigger, ownership). Execution stats are pulled live by Charlie from n8n's API at every bootstrap so the "Recent activity" fields are never more than one bootstrap stale.
- **Cross-references are authoritative.** Ownership references `FLOW_OS_SPECIALISTS.md`. Operational state references `FLOW_OS_STATE.md`. Skill file references the relevant skill files. Charlie reads through cross-references rather than duplicating content.

## Categories index

11 categories identified in the discovery audit (2026-05-04). Status legend: `documented` = full entries written, `pending` = entries to come.

| Category | Workflow count | Status |
|---|---|---|
| Trading | 5 | documented |
| Crete | 4 | documented |
| Flow OS GHL Marketing | 5 | documented |
| Ad Agency | 6 | pending |
| Tyson personal brand — LinkedIn | 5 | pending |
| Tyson personal brand — Instagram | 3 | pending |
| Flow OS — Client integrations | 3 | pending |
| Cross-cutting + token refresh | 3 | pending |
| Flow OS Blog | 1 | pending |
| Flow OS Infographics | 1 | pending |
| FSC Content Studio | 1 | pending |
| Various utilities and standalone | 9 | pending |

Total: 46 active workflows.

---

## Trading cluster

5 workflows. All belong to **Personal** (Tyson's own setup) per `FLOW_OS_SPECIALISTS.md`. Specialist owner: **Trading Operator** (monitoring scoped, no execution). Skill file: `trading.md` (with known config drift flagged in the relevant entries below).

### Trading - Market Scanner

- **ID:** `3YahxqOguET3pifj`
- **Belongs to:** Personal (Tyson's own setup)
- **Specialist owner:** Trading Operator (per `FLOW_OS_SPECIALISTS.md` — monitoring scoped, no execution)
- **Trigger:** `scheduleTrigger` "Smart Schedule" with three asymmetric cron expressions: `0 */1 * * 1` (hourly on Mondays), `0 */2 * * 2-5` (every 2h Tue–Fri), `0 */4 * * 0,6` (every 4h weekends) — all UTC.
- **Purpose:** Polymarket prediction-market edge scanner. Fetches four pages of Polymarket market data, merges them into a single feed, runs a `code` node (`Analyse Edge`) that filters markets by question type and minimum volume, then dispatches each candidate to the local Monte Carlo worker (`Run Market Simulations` → `http://localhost:4001/simulate` per `trading-api.md`) for probability simulation. The downstream `Build Run Summary` code node partitions sims into `highEdge / noEdge / neutral` buckets using **asymmetric thresholds (+0.07 high, −0.10 no, volume ≥ 5000)** — these were rewritten in the Apr 29 fix commit (`ca41c2c`) and now diverge from the `min_edge_threshold: 0.30` value documented in `trading.md` line 305 (Phase 2 audit flagged this drift). On `Has Edge?` true, fires `Notify Edge` Telegram alert; either way fires `Notify Heartbeat` and `Save Simulations` (Supabase) before terminating in `NoOp End`.
- **Heartbeat:** Y (`Notify Heartbeat` httpRequest node).
- **Error workflow:** `7kpNnMtnuDWXgWcX` (Trading - Error Handler).
- **Recent activity:** 76 executions in last 7 days. Last successful execution `2026-05-04T05:00:00 UTC`. Most recent execution `2026-05-04T09:00:00 UTC` returned `status=error, finished=False`.
- **Bucket:** M
- **Known issues:** Elevated error rate visible in last 7 days (heuristic count: ~50 of 76 unfinished/errored). The Error Handler is firing on each one (26 successful Error Handler runs in 7d, well-correlated with Scanner errors), so failures are surfacing — but the underlying error path is still active despite today's `monte_carlo.py` `/simulate` JSON fix (commit `deb6970` deployed ~08:02 UTC). Confirmed by Tyson: today's 09:00 UTC run errored, and a subsequent error fired at ~12:00 Athens time post-fix. The JSON fix addressed one failure mode but not all. **Follow-up dispatch needed**: read recent error executions, identify the post-fix failure path, scope a fix. Bundle with the broader heartbeat + errorWorkflow backlog dispatch since both are mission-critical Trading reliability work. The `trading.md` skill file's `min_edge_threshold: 0.30 (30%)` documentation is stale relative to the current `+0.07 / −0.10` thresholds in the workflow.
- **Last verified:** 2026-05-04
- **Notes:** Created 2026-04-03; major rewrite Apr 29 (`updatedAt: 2026-04-29T20:14 UTC`) per build log "Trading - Market Scanner JSON fix" session. Reads `TELEGRAM_TRADING_CHAT_ID` and `SIM_HOST` from n8n env. Uses `Save Simulations` to persist to Supabase `trading_positions` table per `trading.md`. Skill file: `trading.md` (with known config drift).

### Trading - Position Monitor

- **ID:** `UYA0JppH7eqyI7fQ`
- **Belongs to:** Personal (Tyson's own setup)
- **Specialist owner:** Trading Operator
- **Trigger:** `scheduleTrigger` "Every 15 Minutes" (`minutesInterval: 15`).
- **Purpose:** Runs every 15 minutes to keep Polymarket open-position state current. `Fetch Open Positions` calls the local trading worker, `Evaluate Positions` (code node) computes any state transitions or alerts based on current prices, `Update Positions` writes the new state back, and the `Has Alerts?` IF gates the `Notify Monitor` Telegram message so only meaningful changes notify (not every 15-minute heartbeat).
- **Heartbeat:** N (no node named heartbeat; the workflow itself is the high-frequency probe).
- **Error workflow:** none.
- **Recent activity:** 100+ executions in last 7 days (API limit hit). Last successful execution `2026-05-04T09:15:36 UTC`. 100 successes / 0 errors in returned window — workflow is healthy.
- **Bucket:** M
- **Known issues:** No `errorWorkflow` set despite mission-critical financial-adjacent monitoring. Backlog item per discovery audit (heartbeat + errorWorkflow gap on 13 mission-critical workflows).
- **Last verified:** 2026-05-04
- **Notes:** `updatedAt: 2026-04-06` — has not been touched in nearly 4 weeks; current 100% success rate in 7d window suggests it's stable. Talks to local trading worker (port 4001) and Supabase `trading_positions`. Skill file: `trading.md`.

### Trading - Trade Executor

- **ID:** `fq7spfyiNcpt8Mf7`
- **Belongs to:** Personal (Tyson's own setup)
- **Specialist owner:** Trading Operator (read-only scope; this workflow executes trades but is gated)
- **Trigger:** `webhook` POST `/webhook/trading-execute` (responseMode: `responseNode`).
- **Purpose:** Externally invokable trade-execution endpoint. `Validate Secret` code node checks the inbound `TRADING_WEBHOOK_SECRET` header, `Fetch Config` reads the `trading_config` Supabase table, and the `Trading Enabled?` IF gates execution: when false (the current state per `FLOW_OS_STATE.md` "trading_enabled: false") the webhook responds via `Respond Disabled`; when true, `Prepare Trade` → `Execute Trade` → `Save Position` → `Notify Trade` → `Respond OK`. The hard gate at the trading_enabled config flag is a safety mechanism — even with valid webhook + secret, no trade executes unless Tyson has flipped the config.
- **Heartbeat:** N
- **Error workflow:** none.
- **Recent activity:** 0 executions in last 7 days. No finished executions in the last 100 returned by the API. **Expected** — `trading_enabled` is false per `trading.md` and `FLOW_OS_STATE.md`, so the webhook is intentionally not being called.
- **Bucket:** S→M when `trading_enabled` flips to true (intentionally idle until trading is enabled; not a silent failure)
- **Known issues:** None — zero executions is the desired state. When trading is eventually enabled, this workflow becomes mission-critical and should get heartbeat + errorWorkflow before flipping the config.
- **Last verified:** 2026-05-04
- **Notes:** `updatedAt: 2026-04-04` — stable. `TRADING_WEBHOOK_SECRET` validation per `trading.md` rule 5. Reads/writes `trading_config` and `trading_positions` Supabase tables. Skill file: `trading.md`.

### Trading - Weekly Analyst

- **ID:** `vjj2uBIPc07FpIxx`
- **Belongs to:** Personal (Tyson's own setup)
- **Specialist owner:** Trading Operator
- **Trigger:** `scheduleTrigger` "Monday 9am" with cron expression `0 9 * * 1` (Monday 09:00 UTC).
- **Purpose:** Weekly analyst pass over the previous 7 days of trading activity. `Fetch Week Trades` reads `trading_positions` from Supabase, `Calculate Stats` (code) produces summary metrics, `Claude Analysis` calls Anthropic for narrative analysis, `Save Report` writes to `trading_analyst_reports` Supabase table, and `Send Report` posts the summary to Telegram per `trading.md` line 351-354.
- **Heartbeat:** N
- **Error workflow:** none.
- **Recent activity:** **0 executions in last 30 days.** Probe earlier today (`/tmp/trading_weekly_analyst_probe.md`) confirmed: trigger config is correct, workflow is `active=true`, but the four Mondays it should have fired (Apr 7, 14, 21, 28) all show no execution row. Silent failure — exactly the pattern heartbeat + errorWorkflow are designed to surface, and didn't, because this workflow has neither.
- **Bucket:** M (silent failure currently — formerly S given low frequency)
- **Known issues:** **Schedule registration appears unbound in n8n's scheduler.** Most likely cause: cron registration didn't survive an n8n restart/upgrade event after the workflow's last update (`2026-04-07T09:03 UTC`). Fix is mechanical (deactivate/reactivate forces re-registration) but should be done with heartbeat + errorWorkflow added first so the next outage surfaces within hours. Investigation recommended before fix to confirm root cause and check for sibling workflows with the same dormancy pattern.
- **Last verified:** 2026-05-04
- **Notes:** Skill file `trading.md` line 81 says "Charlie can trigger manually via n8n workflow vjj2uBIPc07FpIxx" — that manual path may still work even though the schedule is dark. Worth probing as part of the fix. Probe report: `/tmp/trading_weekly_analyst_probe.md`.

### Trading - Error Handler

- **ID:** `7kpNnMtnuDWXgWcX`
- **Belongs to:** Cross-cutting (despite the `Trading -` name prefix; **also serving Crete workflows** per Phase 2 audit and discovery report — see Notes)
- **Specialist owner:** Trading Operator (current owner; rename + re-scope decided 2026-05-04 — see Known issues)
- **Trigger:** `errorTrigger` (n8n's built-in error trigger node — fires when any other workflow with `settings.errorWorkflow` set to this ID raises an unhandled error).
- **Purpose:** Centralised error notifier. Two-node workflow: `Error Trigger` receives the failing-workflow context payload from n8n; `Notify Telegram` posts a structured Telegram alert with workflow name, last node executed, error message, and execution ID. Created Apr 29 as part of the Trading Market Scanner remediation session (`ca41c2c`) so future Scanner regressions surface within minutes rather than the 25-hour detection lag of the Apr 28 incident.
- **Heartbeat:** N (a heartbeat on an error handler would be redundant — its own silent failure would not be visible from inside it).
- **Error workflow:** none (don't recurse).
- **Recent activity:** 26 executions in last 7 days (oldest `2026-04-30T00:00:06 UTC`, most recent `2026-05-04T09:00:07 UTC`). All 26 finished successfully — i.e. the handler reliably notifies when invoked. Notification volume tracks Market Scanner error rate.
- **Bucket:** M
- **Known issues:** Naming + scope mismatch — currently named "Trading - Error Handler" but actually serves four workflows: `3YahxqOguET3pifj` (Trading Market Scanner), `tnvXFYvODL1PrhJa` (Crete - Content Generator), `zXKBjp3yjW2oR2Mj` (Crete - Content Publish), `9kTWhh9PlxMpyMlp` (Crete - Scheduled Publisher). Three of those four are Crete, not Trading. **Decision (2026-05-04 by Tyson)**: rename to neutral identity — proposed "Shared Error Handler" — with functionality unchanged. Per-domain handlers deferred to Phase 5+ if needed. Rename to be executed as a separate small dispatch (workflow rename + update of `settings.errorWorkflow` references in dependent workflows is mechanical but needs careful verification that all four references update consistently). Until rename ships, this entry remains under the current name with this note as the canonical reference.
- **Last verified:** 2026-05-04
- **Notes:** `availableInMCP: false` (the only Trading workflow with this set false — it's an internal handler, not for direct invocation). Created and last-updated identical timestamps `2026-04-29T20:00:29 UTC` matching commit `ca41c2c`. As more workflows get the heartbeat + errorWorkflow pattern (per the discovery audit's mission-critical backlog), invocation volume on this workflow will grow substantially. Skill file: `trading.md` (mentioned in the Apr 29 fix narrative).

---

---

## Crete cluster

4 workflows. All belong to **Crete** (village development project + personal-business automations) per `FLOW_OS_SPECIALISTS.md`. Specialist owner across all 4: **Crete Marketing Operator** (content creation + distribution for Crete projects). Skill file: `crete-marketing.md` (with load-bearing operational detail per Phase 2 audit; **stale on the 2026-04-30 schema additions** — reconciliation pending in Phase 4 Slice 2).

Recent significant change: 2026-04-30 publishing pipeline hardening session per `QCLAW_BUILD_LOG.md`. Scope was a **resilience layer** addressing four visibility-related failure modes: silent inserts of broken rows (fixed by throw-on-missing-URL + photo library fallback), hourly retry loops on permanently-broken rows (fixed by `publish_attempts` column with `<3` filter + `Validate Media` flipping Instagram-with-null-media to `failed` pre-Blotato), failures with no diagnostic trail (fixed by `last_error` and `last_attempt_at` columns + error-output branches capturing exception messages), and silent-success-but-no-output (fixed by per-workflow heartbeat node firing regardless of item count). Explicit non-goals of the hardening: fixing the agentboardroom image generator endpoint (deferred, blocked on dashboard auth at the time), reducing Blotato API failure rates, network/timeout issues, anything upstream of the n8n workflow boundary.

### Crete - Content Generator

- **ID:** `tnvXFYvODL1PrhJa`
- **Belongs to:** Crete
- **Specialist owner:** Crete Marketing Operator (per `FLOW_OS_SPECIALISTS.md`)
- **Trigger:** `scheduleTrigger` "Schedule 08:00 UTC" with cron expression `0 0 8 * * *` (6-field n8n format with leading second; fires daily at 08:00:00 UTC).
- **Purpose:** Daily generator for Crete marketing content. `Fetch Calendar` reads scheduled slots from `crete_content_queue` Supabase, `Filter Due Slots` keeps only today's pending rows, `Build Prompt` + `Claude API` produce the post copy, `Build Row` shapes the record, `Insert to Supabase` writes a `status=pending_review` row. The image leg is a router: `Image Router` + `Needs Image?` IF gates whether the row needs an image asset; if yes, `Generate Text Card` calls the dashboard text-card endpoint (per Apr 30 build log diagnosis at `src/dashboard/server.js:1926`); if photo-based content, `Needs Photo?` IF + `Fetch Photo Library` → `Select Random Photo` pulls from the R2 photo library, with `Photo Fallback` + `Telegram Fallback Alert` covering the case where the library lookup fails. Final `Telegram Notify` posts a "ready for review" alert with the row ID; `Heartbeat` notifies success per the standard pattern.
- **Heartbeat:** Y (`Heartbeat` httpRequest node).
- **Error workflow:** `7kpNnMtnuDWXgWcX` (Trading - Error Handler — pending rename to "Shared Error Handler" per Trading cluster decision).
- **Recent activity:** 6 executions in last 7 days. 5 successes / 1 error (heuristic). Last successful execution `2026-05-03T12:00:00 UTC`.
- **Bucket:** M
- **Known issues:** Image generator root cause from the Apr 30 session is **still unresolved** — per `QCLAW_BUILD_LOG.md`, code review of `src/dashboard/server.js` couldn't find a smoking gun and the diagnosis was deferred until n8n-host shell access lands. As of the 2026-05-04 SSH probe (separate session work today), n8n SSH is now infrastructure-unblocked, so this investigation can resume in the next available quiet slot. The `Photo Fallback` + library-lookup work added on 2026-04-30 is the workaround that keeps the pipeline running; the underlying text-card generation issue (failures since Apr 21 per build log) is non-blocking but unfixed.
- **Last verified:** 2026-05-04
- **Notes:** `updatedAt: 2026-05-02T08:35 UTC` — the Apr 30 hardening session's commit landed Apr 30 but the workflow itself was last tweaked May 2 (likely the cap-hashtags / JPEG-fix work per recent commits `e4ad82c` "Cap Hashtags" and `bdc0e6f` "force JPEG output"). Inserts to Supabase `crete_content_queue` table. Image library lives in Cloudflare R2 (Crete Marketing bucket scope per `LOCATIONS.md`). Skill file: `crete-marketing.md`.

### Crete - Content Publish

- **ID:** `zXKBjp3yjW2oR2Mj`
- **Belongs to:** Crete
- **Specialist owner:** Crete Marketing Operator
- **Trigger:** `webhook` POST `/webhook/crete-content-publish` (responseMode: `responseNode`).
- **Purpose:** Per-row publisher invoked by Scheduled Publisher (and on-demand from the dashboard). Receives a Crete content row ID; `Get Content` fetches it from `crete_content_queue`; `Extract Item` shapes the publish payload; `Validate Media` runs platform-specific media checks; `Validation Failed?` IF short-circuits to `Mark Failed (Validation)` + `Telegram Validation Failed` + `Respond Validation Failed` if media is missing or malformed (this is the path the Apr 30 hardening session added to stop the silent-fail cascade where `media_url=NULL` rows were being posted to Blotato and silently rejected). On success: `Platform Switch` routes to one of `Facebook Post` (httpRequest), `LinkedIn Post (Blotato)`, `Instagram Post (Blotato)`, or `Other Platform Skip`; per-platform `Restore Fields` `set` nodes preserve canonical row state across the platform-specific transformations; `Update Status` writes `published` back to Supabase; `Telegram Notify` posts the success message; `Respond` returns the success payload. Failure path uses `Increment Attempts` + `Patch Attempts` to update the new `publish_attempts` column added Apr 30, plus `Telegram Publish Failed` + `Respond Publish Failed`. `Heartbeat` fires at the end.
- **Heartbeat:** Y (`Heartbeat` httpRequest node).
- **Error workflow:** `7kpNnMtnuDWXgWcX` (pending rename).
- **Recent activity:** 100+ executions in last 7 days (API limit). **14 successes / 86 errors-or-unfinished (heuristic).** Last successful execution `2026-05-02T15:02:34 UTC` — i.e. no successes in nearly 2 days at audit time despite continued invocations.
- **Bucket:** M
- **Known issues:** 86% failure rate over 7d (14 successes / 86 errors-or-unfinished). Last successful publish: `2026-05-02T15:02:34 UTC`. **This is the visibility layer working, not a regression.** The Apr 30 hardening session was a resilience layer (silent-fail prevention, retry-loop suppression, error capture, heartbeat coverage), not a root-cause fix on the underlying APIs or upstream content quality. Pre-Apr-30 the same failures occurred but were invisible — silent NULL-media inserts, hourly retry loops on broken rows, no error trail. Post-Apr-30 they show as loud failures with `last_error` populated. The next layer of work is identifying what is consistently failing now that it's visible. Diagnostic SQL to start with:

  ```sql
  SELECT last_error, COUNT(*), MIN(last_attempt_at), MAX(last_attempt_at), array_agg(DISTINCT platform) FROM crete_content_queue WHERE last_error IS NOT NULL AND last_attempt_at > now() - interval '7 days' GROUP BY last_error ORDER BY COUNT(*) DESC
  ```

  Group by error → dispatch list. Tracked as a high-priority follow-up dispatch alongside the Market Scanner post-fix diagnostic. Also: `crete-marketing.md` skill file is stale on the Apr 30 schema additions (`publish_attempts`, `last_error`, `last_attempt_at`) — Phase 4 Slice 2 reconciliation list per `FLOW_OS_SPECIALISTS.md`.
- **Last verified:** 2026-05-04
- **Notes:** `updatedAt: 2026-04-30T14:00:39 UTC` — matches the hardening session timestamp. Talks to: Facebook Graph API, Blotato API (LinkedIn + Instagram), Supabase `crete_content_queue`, Telegram Bot API. Migration that added the retry-tracking columns committed at `n8n-workflows/migrations/2026_04_30_crete_publish_retry_tracking.sql`. Skill file: `crete-marketing.md` (stale).

### Crete - Content Regenerate

- **ID:** `KKjw893zwzHwv1o6`
- **Belongs to:** Crete
- **Specialist owner:** Crete Marketing Operator
- **Trigger:** `webhook` POST `/webhook/crete-content-regenerate` (responseMode: `responseNode`).
- **Purpose:** On-demand regeneration of a single Crete content row. Invoked from the dashboard (per `crete-marketing.md`: "Dashboard approve/reject buttons trigger n8n webhooks") when an operator rejects a generated row and wants new copy. `Get Content` reads the original row, `Build Prompt` constructs a regenerate prompt using the original calendar slot context, `Claude API` produces new copy, `Parse Response` extracts the new content, `Update Row` writes the new copy back to the same `crete_content_queue` row (rather than creating a new row), `Telegram Notify` posts the "regenerated, ready for review" alert, `Respond` returns success.
- **Heartbeat:** N
- **Error workflow:** none.
- **Recent activity:** 4 executions in last 7 days. All 4 successful. Last successful execution `2026-05-02T15:01:25 UTC`.
- **Bucket:** S
- **Known issues:** No `errorWorkflow` set — out of step with the other 3 Crete workflows which all wire to `7kpNnMtnuDWXgWcX`. The on-demand nature of this workflow (low volume, human-initiated) makes silent failure less likely to go unnoticed (operator notices the regenerate button didn't work), so urgency is lower than for the scheduled workflows — but worth adding for consistency in the heartbeat-pattern sweep dispatch.
- **Last verified:** 2026-05-04
- **Notes:** `updatedAt: 2026-04-11T11:25 UTC` — has not been touched since the original Crete pipeline build, predating the Apr 30 hardening. Talks to: Anthropic API (Claude), Supabase `crete_content_queue`, Telegram. Skill file: `crete-marketing.md`.

### Crete - Scheduled Publisher

- **ID:** `9kTWhh9PlxMpyMlp`
- **Belongs to:** Crete
- **Specialist owner:** Crete Marketing Operator
- **Trigger:** `scheduleTrigger` "Hourly Schedule" with cron expression `0 0 * * * *` (6-field n8n format with leading second; fires at the top of every hour, every day).
- **Purpose:** Hourly poller that drives the publishing leg of the Crete pipeline. `Query Approved Due` reads `crete_content_queue` for rows with `status=approved` and `scheduled_for <= now`, indexed by the partial index `idx_crete_content_queue_publishable` added in the Apr 30 migration. For each due row, `Trigger Publish` POSTs to the Content Publish webhook (`zXKBjp3yjW2oR2Mj` via `/webhook/crete-content-publish`). `Build Summary` aggregates per-run stats (rows attempted, successes, failures); `Heartbeat` notifies completion regardless of outcome. The hourly cadence means a typical day fires 24 times; many fires find no due rows and complete without invoking Content Publish.
- **Heartbeat:** Y (`Heartbeat` httpRequest node).
- **Error workflow:** `7kpNnMtnuDWXgWcX` (pending rename).
- **Recent activity:** 100+ executions in last 7 days (API limit). 97 successes / 3 errors (heuristic). Last successful execution `2026-05-04T09:00:00 UTC` — running healthy at the hour level.
- **Bucket:** M
- **Known issues:** This workflow itself is healthy, but its downstream dependency (Content Publish, `zXKBjp3yjW2oR2Mj`) has been failing for ~86% of the rows it dispatches. So Scheduled Publisher's "successful" runs include cases where it dispatched a row that subsequently failed at Content Publish. Charlie's reporting on Crete pipeline health needs to combine **both** workflows' status to give Tyson an accurate picture — Scheduled Publisher's heartbeat alone says "I ran" but doesn't say "the rows I dispatched actually published."

  **Structural reporting note for Phase 4 Slice 1 design:** This workflow is an orchestrator — it invokes Content Publish 0-N times per hour depending on queue state. Its own heartbeat says "I dispatched X rows, completed without error" but does not report whether those X rows actually published successfully (that's downstream Content Publish's job). Scheduled Publisher can be 100% green while Content Publish is 86% red, and a Charlie digest reading just heartbeats would conclude "Crete pipeline healthy" when reality is broken. Charlie's digest must combine heartbeats AND downstream success rates for orchestration workflows. General principle, not Crete-specific — applies to any workflow whose primary job is invoking other workflows.
- **Last verified:** 2026-05-04
- **Notes:** `updatedAt: 2026-04-30T14:59 UTC` — second touch of the Apr 30 hardening session. The Hourly Schedule's 6-field cron leverages n8n's seconds-precision; same pattern as Content Generator's daily 08:00 trigger. Skill file: `crete-marketing.md` (note: skill file is stale on the schema additions per Phase 2 audit).

---

## Flow OS GHL Marketing cluster

5 workflows. All belong to **Flow OS** per `FLOW_OS_SPECIALISTS.md`. Specialist owner across all 5: **Flow OS GHL Marketing**. Skill file: `ghl-marketing.md` (load-bearing per Phase 2 audit; **stale on the distribution architecture** — see Publisher entry).

Cluster-level findings:
- **Heartbeat + errorWorkflow gap is total: 0/5** workflows have either. This cluster is the largest single contributor to the 13-workflow heartbeat-pattern backlog from the discovery audit.
- **Orchestrator + downstream pattern present** — Scheduled Publisher (every 15 min poller) invokes Publisher (per-row publishing webhook). Same structural reporting note as Crete: orchestrator can be 100% green while downstream is failing, so Charlie's digest must combine orchestrator heartbeats AND downstream success rates.
- **Schedule timezone interpretation:** cron expressions in this cluster appear to fire in `America/New_York` despite node names stating `UTC` — surfaced per-workflow; tracked as a system-wide cluster-sweep item in the maintenance log.
- **Bot identity split confirmed (2026-05-04):** Content Generator delivers approval-pending Telegram messages via `flowstatesads_bot` while Approval Handler's `telegramTrigger` listens on a different bot. End-to-end approval loop broken at the bot-identity boundary, not at trigger registration. Tracked as work-list item.

### GHL Marketing: Approval Handler

- **ID:** `ptHK2TZq5XppKOOg`
- **Belongs to:** Flow OS
- **Specialist owner:** Flow OS GHL Marketing (per `FLOW_OS_SPECIALISTS.md`)
- **Trigger:** Two triggers in one workflow — `telegramTrigger` "Telegram Trigger" (listens for `message` updates) and `webhook` POST `/webhook/ghl-marketing-regenerate` "Dashboard Regenerate Webhook" (responseMode: `onReceived`).
- **Purpose:** Two-track approval flow for generated GHL Marketing draft posts. Track A (Telegram): when Tyson replies to the approval-pending Telegram message, `Telegram Trigger` fires, `Parse Reply` extracts the action (approve / regenerate / feedback), `Route Action` switches to: **approve** → `Approve in Supabase` (sets row `status=approved`) → `Trigger Publisher` (POSTs to the Publisher webhook) → `Confirm Approval` (Telegram acknowledgement); **regenerate** → `Save Feedback to Supabase` (captures Tyson's regenerate prompt) → `Fetch Original Draft` → `Regenerate Content (Claude)` → `Parse Regenerated` → `Save New Draft` → `Send Revised to Telegram` (new approval-pending message). Track B (Dashboard): `Dashboard Regenerate Webhook` + `Parse Dashboard Input` + `Normalize Trigger` lets the dashboard's reject/regenerate UI feed into the same regenerate path. The whole workflow is the human-in-the-loop layer that gates publishing on Tyson's explicit approval per `ghl-marketing.md` line 686-691 distribution flow.
- **Heartbeat:** N
- **Error workflow:** none.
- **Recent activity:** 0 executions in last 7 days. **Per probe `/tmp/approval_handler_probe.md` (2026-05-04): 0 executions in API's last 200 rows.** With Content Generator producing 2 approval-pending drafts in the same window, this should have shown some activity — see Known issues for confirmed root cause.
- **Bucket:** M (silent failure here breaks the GHL Marketing approval loop end-to-end)
- **Known issues:** Approval Handler's Telegram trigger listens on a bot that does not match the bot Content Generator publishes through. Per probe (`/tmp/content_generator_telegram_probe.md` + Tyson direct verification 2026-05-04): Content Generator delivers approval-pending messages to chat thread `flowstatesads_bot`. If Approval Handler's `telegramTrigger` is configured against `@tyson_quantumbot` or any other bot's API token, replies in the `flowstatesads_bot` thread never reach this workflow's trigger — the approval loop is broken at the bot-identity boundary, not at the trigger-registration layer. The workflow is not necessarily dormant in the Trading Weekly Analyst sense; it has nothing to react to because upstream Telegram delivery is split across bots. Fix is part of the same bot-consolidation dispatch as Content Generator's bug (a) below. Plus: no heartbeat/errorWorkflow — joins cluster-wide gap. The dashboard regenerate webhook path remains functional independent of the Telegram bot question (Tyson confirmed working dashboard reject-with-feedback flow on 2026-05-04).
- **Last verified:** 2026-05-04
- **Notes:** `updatedAt: 2026-04-22T11:20 UTC`. The two-trigger pattern is unusual — most workflows in the index have one trigger. Talks to: Telegram Bot API (read + write), Anthropic API (Claude regenerate), Supabase. Cross-references the Publisher webhook by URL (not workflow ID). Skill file: `ghl-marketing.md` (stale on distribution architecture).

### GHL Marketing: Content Generator

- **ID:** `Awo65rdSe5BvDHtC`
- **Belongs to:** Flow OS
- **Specialist owner:** Flow OS GHL Marketing
- **Trigger:** `scheduleTrigger` "Cron MWF 07:00 UTC" with cron expression `0 7 * * 1,3,5` (Mon/Wed/Fri at minute 0, hour 7).
- **Purpose:** 3×/week content generator for the GHL Support Specialist marketing campaign. `Determine Post Type` rotates between the Mon/Wed/Fri archetype (per `ghl-marketing.md` line 656: Monday pain-led, Wednesday value-led, Friday offer-led), `Fetch Recent Hooks` pulls recent post hooks from Supabase to enforce the "no repeat hook within 2 weeks" rule (line 662), `Prepare Prompt Data` builds the LLM prompt from the day's archetype + audience segment + tone rules from the skill file, `Generate Content (Claude)` produces the draft via Anthropic API, `Parse Response` extracts copy + hashtags + suggested image, `Save to Supabase` writes a `status=pending_approval` draft row, `Assign Image URL` assigns an image asset, and `Send to Telegram` posts the approval-pending message that Tyson reacts to via the Approval Handler workflow.
- **Heartbeat:** N
- **Error workflow:** none.
- **Recent activity:** 2 executions in last 7 days. Both successful end-to-end (per probe `/tmp/content_generator_telegram_probe.md` — all 9 nodes ran, no errors, Telegram API returned `ok:true` with assigned message IDs). Last successful execution `2026-05-01T11:00:00 UTC`. Note: the cron `0 7 * * 1,3,5` named "07:00 UTC" actually fires at 11:00 UTC — see Known issues.
- **Bucket:** M
- **Known issues:** Two confirmed bugs (per probe at `/tmp/content_generator_telegram_probe.md`, executions 723440 + 724863):

  **(a) Bot identity split.** Send to Telegram delivers messages successfully (Telegram API returns `ok:true` with message IDs) — but to chat thread `flowstatesads_bot` (8622820007 / "Flow States Ads Agent"), not the operations bot Tyson normally monitors (`@tyson_quantumbot` per `ui.html:570`). Approval Handler's `telegramTrigger` appears to listen on a different bot, breaking the approval loop end-to-end. Tyson can see the messages by opening the `flowstatesads_bot` chat directly, but the design intent (single approval thread visible alongside other ops alerts) is broken. Fix dispatch needed: consolidate to single bot, OR explicitly document the multi-bot split as intentional.

  **(b) Empty Draft ID in Telegram message.** Template at Send to Telegram uses `{{ $json[0].id }}` — at that node `$json` is the Save-to-Supabase response object, not an array, so the expression evaluates undefined and the message reads "Draft ID:" with nothing after it. Confirmed by Tyson's screenshot 2026-05-04. Fix: change to `{{ $json.id }}` or equivalent. Trivial dispatch.

  Schedule timezone naming mismatch (cron "07:00 UTC" actually fires at 11:00 UTC due to n8n's NY-timezone evaluation) — see cluster-sweep correction pass tracked in maintenance log. No heartbeat/errorWorkflow — joins cluster-wide gap.
- **Last verified:** 2026-05-04
- **Notes:** `updatedAt: 2026-04-27T13:12 UTC`. Talks to: Anthropic API, Supabase (`marketing_drafts` table per probe), Telegram Bot API (via `flowstatesads_bot` credential). Cross-reference: `ghl-marketing.md` for ICA archetypes (line 530-535), tone rules (line 545-553), three core pain points (line 559-565), content calendar (line 656-660). Skill file: `ghl-marketing.md`.

### GHL Marketing: Publisher

- **ID:** `fonuRTyqepxdyIdf`
- **Belongs to:** Flow OS
- **Specialist owner:** Flow OS GHL Marketing
- **Trigger:** `webhook` POST `/webhook/ghl-marketing-publish` (responseMode: `responseNode`).
- **Purpose:** Per-draft publisher that distributes an approved row to multiple platforms. `Fetch Draft` reads the row from Supabase, `Prepare` builds per-platform payloads. The LinkedIn leg has special handling: `LI Guard Check` queries Blotato for recent LinkedIn post timing (Blotato enforces a minimum gap between LinkedIn posts to avoid rate limiting), `LI Guard Apply` decides whether to defer this LinkedIn post, and `Skip LinkedIn?` IF either skips (defer) or proceeds via `LinkedIn Post (Blotato)`. In parallel: `Facebook Post` posts to Facebook Graph API directly, `IG Post (Blotato)` posts to Instagram via Blotato. After all platforms attempted, `Compute Final` aggregates per-platform results into a row state, `Update Supabase` writes the publish state back, `Telegram Notify` posts a per-publish summary, `Respond` returns the response payload to the caller. **Note:** this implementation contradicts `ghl-marketing.md` line 690 which says "On approval → pushed to GHL Social Planner via API → GHL Social Planner distributes" — actual implementation distributes directly.
- **Heartbeat:** N
- **Error workflow:** none.
- **Recent activity:** 1 execution in last 7 days. Successful. Last successful execution `2026-04-30T09:24:55 UTC`.
- **Bucket:** M
- **Known issues:** **Skill file mismatch on distribution architecture** — `ghl-marketing.md` describes a GHL Social Planner intermediate; actual workflow goes direct-to-platform via Facebook Graph API + Blotato. Skill file reconciliation pending Phase 4 Slice 2. No heartbeat or errorWorkflow. Low recent activity (1 execution in 7d) is consistent with the Mon/Wed/Fri generator cadence + Tyson's approval throughput — and with the bot identity split confirmed in Content Generator's entry: if approvals aren't reaching Approval Handler via the right bot, Publisher only fires on the dashboard regenerate path or scheduled-publisher path, not via approve-via-Telegram.
- **Last verified:** 2026-05-04
- **Notes:** `updatedAt: 2026-04-29T19:11 UTC`. Talks to: Facebook Graph API, Blotato API (LinkedIn + Instagram), Supabase. The `LI Guard Check` + `LI Guard Apply` pattern is a workflow-internal rate-limiter for LinkedIn — interesting precedent for cross-cluster reuse. Skill file: `ghl-marketing.md` (stale on architecture).

### GHL Marketing: Scheduled Publisher

- **ID:** `dHceOMijUOcnEowO`
- **Belongs to:** Flow OS
- **Specialist owner:** Flow OS GHL Marketing
- **Trigger:** `scheduleTrigger` "Every 15 min" (`minutesInterval: 15`).
- **Purpose:** Every-15-minute orchestrator for time-scheduled GHL Marketing publishing. `Fetch Due Drafts` queries Supabase for rows with `status=approved` and `scheduled_for <= now`, `Split Rows` fans out one item per due draft, `Fire Publisher` POSTs each to the Publisher webhook (`fonuRTyqepxdyIdf` via `/webhook/ghl-marketing-publish`). The 15-minute cadence means Approval Handler can mark a row `approved` with a future `scheduled_for` and this orchestrator will pick it up at the right window.
- **Heartbeat:** N (despite firing every 15 min — same pattern as Crete Scheduled Publisher).
- **Error workflow:** none.
- **Recent activity:** 100+ executions in last 7 days (API limit). 100 successes / 0 errors (heuristic). Last successful execution `2026-05-04T10:30:54 UTC` — running healthy at the 15-minute level.
- **Bucket:** M
- **Known issues:** **Same orchestrator/downstream reporting trap as Crete Scheduled Publisher.** This workflow is 100% green on its own heartbeat-equivalent (it simply succeeds when it polls), but a green status here says nothing about whether the rows it dispatched to Publisher actually published successfully. Charlie's digest reading just this workflow's status would conclude "GHL Marketing pipeline healthy" when reality could be "fan-out succeeded, downstream Publisher failed silently". The general principle from the Crete cluster applies: orchestrator workflows need composite heartbeat + downstream-success reporting. Most pressing because the Publisher workflow doesn't have heartbeat/errorWorkflow either, so the orchestrator's green status is the only signal the pipeline emits.
- **Last verified:** 2026-05-04
- **Notes:** `updatedAt: 2026-04-22T11:20 UTC`. Talks to: Supabase (read), Publisher workflow (HTTP). Stable since the original GHL Marketing build. Skill file: `ghl-marketing.md`.

### GHL Marketing: Weekly Report

- **ID:** `jRiiOsWneQAtfVPD`
- **Belongs to:** Flow OS
- **Specialist owner:** Flow OS GHL Marketing
- **Trigger:** `scheduleTrigger` "Sunday 20:00 UTC" with cron expression `0 20 * * 0` (Sunday at minute 0, hour 20).
- **Purpose:** Weekly Sunday-evening recap of the GHL Marketing campaign performance. `Calculate Date Range` resolves the 7-day window, `Fetch Marketing Stats` pulls the week's draft + publish + engagement metrics from Supabase, `Aggregate Stats` computes summary numbers, `Generate Report (Claude Haiku)` produces a narrative (Haiku per `ghl-marketing.md` line 698 cost-efficiency rule: "All copy generation uses Claude Sonnet (cost-efficient)" — Weekly Report uses Haiku, even cheaper, appropriate for summary narration), `Format Report` shapes the message, `Send Report to Telegram` posts to Tyson's chat.
- **Heartbeat:** N
- **Error workflow:** none.
- **Recent activity:** 1 execution in last 7 days. Successful. Last successful execution `2026-05-04T00:00:00 UTC`. Note: the cron `0 20 * * 0` named "Sunday 20:00 UTC" fires at 00:00 UTC Monday, which is 20:00 NY time Sunday — confirming the cluster-wide NY-timezone interpretation. Tyson would have received the report at 03:00 Athens time Monday, not 23:00 Athens time Sunday as a UTC reading would imply.
- **Bucket:** S
- **Known issues:** **Schedule timezone naming mismatch** (same pattern as Content Generator) — actual fire is Sunday 20:00 NY = Monday 00:00 UTC, not "Sunday 20:00 UTC" as the node name suggests. Worth rolling into the cluster-wide schedule audit. No heartbeat/errorWorkflow, but low frequency and weekly visibility in Tyson's Telegram makes silent failure detectable. Note: this report posts via the same Telegram node configuration as Content Generator — likely also via `flowstatesads_bot`, so same bot-identity-split implications apply (Tyson would need to check the `flowstatesads_bot` thread to find the weekly report).
- **Last verified:** 2026-05-04
- **Notes:** `updatedAt: 2026-04-21T13:24 UTC`. Talks to: Supabase (read), Anthropic API (Claude Haiku), Telegram. Skill file: `ghl-marketing.md`.

## Maintenance log

This section captures changes to the workflow index over time. Most recent at top.

- **2026-05-04 — Pending cluster-sweep tracked: schedule timezone correction across N clusters.** n8n cron evaluation runs in America/New_York (UTC-4 EDT) not UTC despite node names. Affects at minimum: Crete Content Generator (committed, technically-misleading UTC claim), GHL Marketing Content Generator + Weekly Report (this commit). Likely affects unevaluated clusters too. Sweep correction post-cluster-11 will decide between: rename nodes (cosmetic), compensate cron (functional), or change n8n timezone config (cleanest fix). Tracked as work-list item.

- **2026-05-04 — v1 created with Trading cluster (5 of 46 workflows documented).** Format conventions locked: cron in backticks, workflow IDs in backticks, "S→M when X" notation for conditional workflows, cross-references to `FLOW_OS_SPECIALISTS.md` and `FLOW_OS_STATE.md`, `[needs Tyson input]` preferred over synthesised purpose. Trading cluster used as template-establishing first pass. Notable findings: Trading - Weekly Analyst silently dormant since 2026-04-04 (cron registration likely cleared by n8n restart event); Trading - Market Scanner has ongoing post-JSON-fix error mode that needs separate diagnostic; Trading - Error Handler rename decision logged (to be executed in separate dispatch). Authored by Tyson + Claude (chat) per Phase 3 Component 2.
