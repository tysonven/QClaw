---
name: trading
category: on-demand
surface: prompt
keywords: [trade, trading, scanner, position]
description: Polymarket prediction-market trading system — three-agent architecture, safety rules, system health
# tool-registration intentionally disabled — see Slice 2 audit T10 (uses "## Key API Endpoints" not "## Endpoints")
---

# Trading Room Skill

Charlie uses this skill to monitor, analyse, and manage the Polymarket
prediction market trading system.

## Cluster State & Guard

Before any trading action, confirm the relevant n8n workflow is **active**
and the Monte Carlo worker is up. If a workflow (or the whole cluster) is
**deactivated**, do NOT attempt to trigger it or call its endpoints —
surface that the cluster is offline and stop. Never silently retry against a
dead workflow.

Live execution requires BOTH `trading_config.trading_enabled = true` AND the
Trade Executor workflow active. Never enable either without explicit
confirmation from Tyson in the current conversation.

Status snapshot (2026-08-14, verify via the n8n API before acting):
- **ALL FOUR n8n trading workflows are now INACTIVE.** Market Scanner, Trade
  Executor and Position Monitor were deactivated 2026-08-05; Weekly Analyst
  2026-08-14. The n8n trading cluster is retired, not paused.
- Scanning, analysis, approval, execution and position monitoring are now owned
  by the standalone trade engine (PM2: trade-engine). See System Architecture.
- `trading_config.trading_enabled` = **true**, and the engine's scheduler is
  running, so live execution is ARMED through the engine (not through n8n).
- `trading_positions` holds 2 rows, both with tx_hash NULL. See Supabase
  Tables: neither is a confirmed on-chain fill.

## System Architecture

CURRENT (since 2026-08-05): the standalone trade engine, PM2 `trade-engine`,
src/trade_engine/. One process owns scanner, analyst, approval gate, executor
and position monitor, on an internal scheduler. It still calls out to the
Monte Carlo worker (Python Flask, port 4001, PM2: trading-worker), which
remains live and is the one piece carried over from the old system.

RETIRED (all INACTIVE, kept for history only):
- Market Scanner (3YahxqOguET3pifj), deactivated 2026-08-05
- Trade Executor (fq7spfyiNcpt8Mf7), deactivated 2026-08-05
- Position Monitor (UYA0JppH7eqyI7fQ), deactivated 2026-08-05
- Weekly Analyst (vjj2uBIPc07FpIxx), deactivated 2026-08-14

Shared Error Handler (7kpNnMtnuDWXgWcX) remains the errorWorkflow on those
workflow definitions, but receives nothing while they are inactive.

## n8n Access

n8n runs at https://webhook.flowos.tech — never localhost from qclaw.
For live workflow lookup, details, or execution inspection, use the dynamic
queries in charlie-cto.md → "n8n Diagnostics". The IDs above are a
convenience — always verify active-state via the API before acting.

## Current Trading Config

Supabase table `trading_config` — a single-row table (id=1) with columns
(NOT a key/value store):
- trading_enabled (boolean): **true** as of 2026-07-28 — the live execution
  gate, currently OPEN. ALWAYS confirm with Tyson before changing it in
  either direction.
- max_position_usdc: 10
- min_edge_threshold: 7, whole-number percent (7 = 7%). CORRECTION
  (2026-08-14): this is no longer reference-only. The trade engine enforces it
  in executor.py GATE 4, which compares candidate.edge (a raw fraction) against
  min_edge_threshold / 100. Lowering this value now widens what the engine will
  actually trade. (Updated 2026-07-23 from the stale pre-April value 30.)
- daily_loss_limit: 20 (USDC)

## Scanner Calibration (live values, verified 2026-07-23)

Thresholds live in the **Build Run Summary** node of the Market Scanner
workflow (3YahxqOguET3pifj) — NOT in trading_config:
- Edge = simulated probability − market YES price (fraction).
- High-edge: **+0.07** — sim probability ≥7 points above the market.
- No-edge: **−0.20** — sim probability ≥20 points below the market.
  (Raised from −0.10 on 2026-07-23: the fixed 90d GBM lookback was
  systematically pessimistic on short-dated OTM crypto rungs and the
  −0.10 band was mostly calibration noise, not alpha.)
- Volume floors (two, both live): **20,000 USDC** pre-simulation filter in
  the Analyse Edge node; **5,000 USDC** alert floor in Build Run Summary.
- The scanner only considers markets resolving within **35 days**
  (Analyse Edge horizon gate).
- Monte Carlo lookback is horizon-adaptive (since 2026-07-23): the last
  **21 trading days** of returns when horizon ≤35d (i.e. every scanner
  market), the full 90-calendar-day window otherwise.
- trading_config.min_edge_threshold mirrors the high-edge value (7) for
  reference only.

## Key API Endpoints

Monte Carlo worker — http://localhost:4001 (PM2: trading-worker):
- GET  /health    — liveness; returns {"status":"ok","service":"monte-carlo-worker"}
- POST /simulate  — run a Monte Carlo simulation (JSON body: asset, target, horizon_days)

Trade execution path (rewritten 2026-08-14): execution belongs entirely to the
standalone trade engine, src/trade_engine/executor.py, which invokes
src/trading/execute_trade.py as a subprocess behind six pre-flight gates
(trading_enabled, position cap, daily loss, edge floor, size, conditionId).

There is NO HTTP execution route any more. The dashboard's
POST /api/trading/execute was removed on 2026-08-14. It bypassed the edge
floor, conditionId validation, the Analyst and the approval gate. Its only
caller, the "Trading - Trade Executor" n8n workflow (fq7spfyiNcpt8Mf7), was
deactivated on 2026-08-05. Do not reintroduce an HTTP execution route: route
through the engine so the gates cannot be skipped.

The trade engine runs at http://127.0.0.1:4003 (PM2: trade-engine) and is
loopback-bound. Its health endpoint reports scanner, analyst, approval and
monitor state, and is surfaced on the dashboard Trading Room through the
read-only proxy route GET /api/trading/engine.

## Wallet

Address: 0x8f35F9626f4AcCe44449fC9BFD7fFb0231948431
Credentials: POLYMARKET_PRIVATE_KEY + POLYMARKET_FUNDER_ADDRESS
             stored in ~/.quantumclaw/.env (never log or expose these)

## Supabase Tables

- trading_positions: all trades (open + closed). As of 2026-08-14 it holds 2
  rows (1 open BTC, 1 closed XRP), both REAL money trades executed by hand on
  the Polymarket UI and logged through POST /positions/manual. Verified against
  the live Polymarket activity log.

  **tx_hash NULL does NOT mean paper.** tx_hash is written only by the
  automated executor.py path, and automated execution is currently blocked by
  the Polymarket maker-address restriction. Manual logging is therefore the
  only route a real trade takes into this table today, so every genuine
  position currently in it has tx_hash NULL by construction. Never treat
  tx_hash IS NULL as "not a real trade" or exclude those rows from PnL: doing
  so would zero out 100% of real trading history. There is no way to log a
  paper trade in this system at present.

  Caveat on accuracy: the manual-logging flow records whatever price and amount
  the user reports, which is often the PROPOSED trade from the Telegram
  approval message rather than the confirmed fill. Treat logged entry_price /
  usdc_amount as approximate until reconciled against the Polymarket activity
  log. The BTC row was corrected this way on 2026-08-14.
- trading_simulations: scanner Monte Carlo output. Written ONLY by
  src/trade_engine/scanner.py. The market's identity lives in
  raw_output (question, polymarket_condition_id), not in a column.
- trading_config: live config (single row, see above)
- trading_analyst_reports: weekly analyst output (legacy). The "Trading -
  Weekly Analyst" n8n workflow that wrote this was deactivated 2026-08-14;
  the engine's own Analyst (src/trade_engine/analyst.py) supersedes it.

## Safety Rules

1. NEVER enable trading (set trading_enabled: true) without explicit
   confirmation from Tyson in the current conversation.
2. NEVER reactivate the Trade Executor workflow without explicit
   confirmation from Tyson.
3. If a trading workflow or the cluster is deactivated, do NOT attempt tool
   calls against it — surface that it is offline instead of retrying.
4. Max position is $10 USDC. Never suggest or execute trades above this
   without config change approval.
5. Daily loss limit is $20 USDC. If this is hit, trading must stop for the day.
6. The high-edge bar is +7% edge (scanner Build Run Summary node — see
   Scanner Calibration). Do not recommend markets below this edge.
7. There is no HTTP execution route and no TRADING_WEBHOOK_SECRET path any
   more (both retired 2026-08-14). Execution runs only through the trade
   engine's executor, behind its six gates plus the Telegram approval gate.
   Never propose reinstating an HTTP execution route.
8. The Monte Carlo worker must be running (PM2: trading-worker) before any
   simulation or execution calls.

## Checking System Health

1. Verify trade-engine is running: PM2 process list on ssh qclaw, or
   GET http://127.0.0.1:4003/health (also on the dashboard Trading Room via
   the Engine Status panel). That one response covers scanner freshness,
   scheduler, analyst availability, pending approvals and daily PnL.
2. Verify trading-worker is running: PM2 list, or GET http://localhost:4001/health
3. Check open positions: query trading_positions
4. Check today's P&L: query trading_positions where date = today

## Weekly Analyst

RETIRED 2026-08-14. The n8n Weekly Analyst (vjj2uBIPc07FpIxx) ran Mondays 9am
UTC, reviewed the last 7 days, and wrote trading_analyst_reports. It is now
INACTIVE and must not be triggered: the trade engine's own Analyst
(src/trade_engine/analyst.py) supersedes it and runs per-candidate, inline with
the approval gate, rather than weekly.
