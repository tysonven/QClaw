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
| Crete | 4 | pending |
| Flow OS GHL Marketing | 5 | pending |
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

## Maintenance log

This section captures changes to the workflow index over time. Most recent at top.

- **2026-05-04 — v1 created with Trading cluster (5 of 46 workflows documented).** Format conventions locked: cron in backticks, workflow IDs in backticks, "S→M when X" notation for conditional workflows, cross-references to `FLOW_OS_SPECIALISTS.md` and `FLOW_OS_STATE.md`, `[needs Tyson input]` preferred over synthesised purpose. Trading cluster used as template-establishing first pass. Notable findings: Trading - Weekly Analyst silently dormant since 2026-04-04 (cron registration likely cleared by n8n restart event); Trading - Market Scanner has ongoing post-JSON-fix error mode that needs separate diagnostic; Trading - Error Handler rename decision logged (to be executed in separate dispatch). Authored by Tyson + Claude (chat) per Phase 3 Component 2.
