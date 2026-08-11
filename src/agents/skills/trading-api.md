---
name: trading-api
category: on-demand
surface: both
keywords: [trade, trading, scanner, position, bought, buy, sell, sold, polymarket, market]
description: Trade engine HTTP surface - simulations, positions, config, manual trade logging (localhost:4003)
---

# Trade Engine

## Auth
Base URL: http://localhost:4003
# No auth header: the trade engine binds 127.0.0.1 only, so loopback IS the
# access control and its endpoints are unauthenticated by design. The old
# localhost:4000/api/trading base with the dashboard.authToken bearer was the
# pre-trade-engine dashboard - do not point back at it.

## Endpoints
GET /health - Engine liveness: trading enabled, open-position count, last scan and monitor times, daily pnl
GET /config - Returns trading config (enabled, limits)
GET /simulations - Returns the 10 most recent trading simulations; raw_output carries question and polymarket_condition_id
GET /positions - Returns open trading positions
POST /simulate - Runs one Monte Carlo simulation (body: asset, target, horizon_days, question)
POST /positions/manual - Log a manually-executed trade so it is tracked and the Analyst learns from its outcome (body: market_url or condition_id, direction YES or NO, entry_price, usdc_amount, optional shares)
POST /monitor/run - Run the Position Monitor sweep once, on demand

## Permissions
- http: [localhost:4003]
- shell: none
- file: none

## Usage Notes
- Use /simulations to check the latest sim results and /positions to check open Polymarket positions
- Use /positions/manual when Tyson says he took a trade manually (e.g. "I bought YES on that BTC market at 65 cents for $5") - extract market, direction, price and amount from his message and call this endpoint
- Tyson must state market, direction, price and amount explicitly: the scanner/approval bot is a separate Telegram thread you cannot see, so never infer trade details from context you do not have
- Finding the market for /positions/manual: if Tyson gives a URL, pass it as market_url; if he only names the market, GET /simulations and match his description against raw_output.question, then pass that row's raw_output.polymarket_condition_id as condition_id; if neither matches, ask him for the market URL
- entry_price is the price paid for HIS side as a fraction (65 cents = 0.65); usdc_amount is total dollars spent; omit shares unless he states them (the engine computes usdc_amount / entry_price)
- After logging, confirm back to Tyson exactly what was recorded, including whether it linked to a recent scan (simulation_id_linked true/false)
- A trade on a market the scanner never simulated still logs fine with simulation_id_linked false - that only means less context for the Analyst
- POST calls here are skill HTTP writes, so the ApprovalGate will ask Tyson for a Telegram approval tap before they execute - tell him to expect it
