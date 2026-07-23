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

Status snapshot (2026-07-23, verify via the n8n API before acting):
- Position Monitor, Market Scanner, Weekly Analyst — ACTIVE (monitoring /
  analysis / notification only; none of these place trades).
- Trade Executor — INACTIVE by design. Live execution is OFF.
- `trading_config.trading_enabled` = false.

## System Architecture

Three-agent system:
- Agent 1: Monte Carlo worker (Python Flask, port 4001, PM2: trading-worker)
- Agent 2: Trade Scout — n8n Market Scanner (workflow 3YahxqOguET3pifj)
- Agent 3: Weekly Analyst — Claude Sonnet, Mondays 9am (workflow vjj2uBIPc07FpIxx)

Two additional workflows:
- Trade Executor (fq7spfyiNcpt8Mf7) — webhook /webhook/trading-execute; the
  ONLY workflow that places trades (gated on trading_enabled)
- Position Monitor (UYA0JppH7eqyI7fQ) — runs every 15 min

Shared Error Handler (7kpNnMtnuDWXgWcX) is the errorWorkflow for the trading
workflows (receives their failures).

## n8n Access

n8n runs at https://webhook.flowos.tech — never localhost from qclaw.
For live workflow lookup, details, or execution inspection, use the dynamic
queries in charlie-cto.md → "n8n Diagnostics". The IDs above are a
convenience — always verify active-state via the API before acting.

## Current Trading Config

Supabase table `trading_config` — a single-row table (id=1) with columns
(NOT a key/value store):
- trading_enabled (boolean): false — the live execution gate. ALWAYS confirm
  with Tyson before setting true.
- max_position_usdc: 10
- min_edge_threshold: 7 — whole-number percent (7 = 7%). Mirrors the
  scanner's high-edge threshold for reference ONLY; nothing enforces it
  (the executor reads only trading_enabled + max_position_usdc). The
  operational thresholds live in the scanner workflow — see Scanner
  Calibration below. (Updated 2026-07-23 from the stale pre-April value 30.)
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

Trade execution path: the Trade Executor n8n workflow calls the main app on
port 4000 (/trading/execute, requires the TRADING_WEBHOOK_SECRET header). The
4001 worker does NOT serve /trading/* paths — verify the exact port-4000
route surface before relying on it.

## Wallet

Address: 0x8f35F9626f4AcCe44449fC9BFD7fFb0231948431
Credentials: POLYMARKET_PRIVATE_KEY + POLYMARKET_FUNDER_ADDRESS
             stored in ~/.quantumclaw/.env (never log or expose these)

## Supabase Tables

- trading_positions: all trades (open + closed) — currently empty (no trades placed to date)
- trading_config: live config (single row, see above)
- trading_analyst_reports: weekly analyst output

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
7. All trade executions require the TRADING_WEBHOOK_SECRET header — never
   expose this value in responses.
8. The Monte Carlo worker must be running (PM2: trading-worker) before any
   simulation or execution calls.

## Checking System Health

1. Verify trading-worker is running: PM2 process list on ssh qclaw, or
   GET http://localhost:4001/health
2. Verify each workflow's active-state via the n8n API before acting
3. Check open positions: query trading_positions
4. Check today's P&L: query trading_positions where date = today

## Weekly Analyst

Runs automatically every Monday at 9am UTC.
Reviews last 7 days of trades, calls Claude Sonnet for analysis, saves report
to trading_analyst_reports, sends summary to Telegram.
Charlie can trigger manually via n8n workflow vjj2uBIPc07FpIxx.
