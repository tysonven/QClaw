---
title: Trading Room
---

# Trading Room Skill

Charlie uses this skill to monitor, analyse, and manage the Polymarket
prediction market trading system.

## System Architecture

Three-agent system:
- Agent 1: Monte Carlo worker (Python Flask, port 4001, PM2: trading-worker)
- Agent 2: Trade Scout — n8n Market Scanner (workflow 3YahxqOguET3pifj)
- Agent 3: Weekly Analyst — Claude Sonnet, Mondays 9am (workflow vjj2uBIPc07FpIxx)

Two additional workflows:
- Trade Executor (fq7spfyiNcpt8Mf7) — webhook /webhook/trading-execute
- Position Monitor (UYA0JppH7eqyI7fQ) — runs every 15 min

## n8n Access

n8n runs at https://webhook.flowos.tech — never localhost from qclaw.
For any workflow lookup, details, or execution inspection, use the
dynamic queries in charlie-cto.md → "n8n Diagnostics". Do not keep
a static list of workflow IDs here — they go stale.

## Current Trading Config

Stored in Supabase table: trading_config (key/value)
- trading_enabled: false (ALWAYS confirm before enabling)
- max_position_usdc: 10
- min_edge_threshold: 0.30 (30%)
- daily_loss_limit_usdc: 20

## Key API Endpoints (localhost:4000)

GET  /trading/status          — current config + wallet balance
GET  /trading/positions       — all open positions
POST /trading/simulate        — run Monte Carlo simulation
POST /trading/execute         — place a trade (requires TRADING_WEBHOOK_SECRET header)
GET  /trading/history         — closed positions + P&L

## Wallet

Address: 0x8f35F9626f4AcCe44449fC9BFD7fFb0231948431
Credentials: POLYMARKET_PRIVATE_KEY + POLYMARKET_FUNDER_ADDRESS
             stored in ~/.quantumclaw/.env (never log or expose these)

## Supabase Tables

- trading_positions: all trades (open + closed)
- trading_config: live config key/value pairs
- trading_analyst_reports: weekly analyst output

## Safety Rules

1. NEVER enable trading (set trading_enabled: true) without explicit
   confirmation from Tyson in the current conversation.
2. Max position is $10 USDC. Never suggest or execute trades above this
   without config change approval.
3. Daily loss limit is $20 USDC. If this is hit, trading must stop for the day.
4. Min edge threshold is 30%. Do not recommend markets below this.
5. All trade executions require the TRADING_WEBHOOK_SECRET header — never
   expose this value in responses.
6. The Monte Carlo worker must be running (PM2: trading-worker) before
   any simulation or execution calls.

## Checking System Health

1. Verify trading-worker is running: check PM2 process list on ssh qclaw
2. Check wallet balance: GET /trading/status
3. Check open positions: GET /trading/positions
4. Check today's P&L: query trading_positions where date = today

## Weekly Analyst

Runs automatically every Monday at 9am UTC.
Reviews last 7 days of trades, calls Claude Sonnet for analysis,
saves report to trading_analyst_reports, sends summary to Telegram.
Charlie can trigger manually via n8n workflow vjj2uBIPc07FpIxx.
