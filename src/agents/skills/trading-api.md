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
GET /positions/alerts - Live threshold alerts needing attention; an alert is NOT a close, the position is still open
GET /positions/{{position_id}}/alerts - Full alert history for one position, resolved ones included
POST /positions/{{position_id}}/hold - Mark a position manually managed so alerts stop; body hold true or false
POST /positions/manual-close - Log a position Tyson closed by hand; body position_id, exit_price, optional exit_usdc, exit_reason, note

## Permissions
- http: [localhost:4003]
- shell: none
- file: none

## Usage Notes
- Use /simulations to check the latest sim results and /positions to check open Polymarket positions
- Use /positions/manual when Tyson says he took a trade manually (e.g. "I bought YES on that BTC market at 65 cents for $5") - extract market, direction, price and amount from his message and call this endpoint
- Tyson must state market, direction, price and amount explicitly: the scanner/approval bot is a separate Telegram thread you cannot see, so never infer trade details from context you do not have
- Finding the market for /positions/manual: if Tyson gives a URL, pass it as market_url; if he only names the market, FIRST call GET /simulations and match his description against raw_output.question, then pass that row's raw_output.polymarket_condition_id as condition_id; if neither matches, ask him for the market URL
- The /positions/manual body accepts ONLY these fields: market_url or condition_id, direction, entry_price, usdc_amount, shares (optional) - there is no question field and unknown fields are rejected with a 400, so never call it with a market name alone
- entry_price is the price paid for HIS side as a fraction (65 cents = 0.65); usdc_amount is total dollars spent; omit shares unless he states them (the engine computes usdc_amount / entry_price)
- After logging, confirm back to Tyson exactly what was recorded, including whether it linked to a recent scan (simulation_id_linked true/false)
- A trade on a market the scanner never simulated still logs fine with simulation_id_linked false - that only means less context for the Analyst
- POST calls here are skill HTTP writes, so the ApprovalGate will ask Tyson for a Telegram approval tap before they execute - tell him to expect it

## Exit alerts and manual closes

- The Position Monitor CANNOT sell. Polymarket execution is manual-only while the signer/maker-address issue is open, so when a take-profit, stop-loss or weakening threshold fires the monitor raises an ALERT and leaves the position OPEN
- An alert is never a close. If you see an alert, the correct statement is "the stop-loss threshold was hit and it is still open, you need to close it on Polymarket" - never "the position was closed" or "it stopped out"
- unrealized_pnl_estimate on an alert is an ESTIMATE marked to the trigger price, not a realised loss. Say "estimated unrealized" every time you quote it. The real number only exists after Tyson closes and it is logged
- When Tyson mentions closing a position: FIRST call GET /positions/alerts (or GET /positions/{{position_id}}/alerts) to see whether an alert already exists for it, THEN call POST /positions/manual-close, THEN tell him which alert it resolved - e.g. "logged, that resolves the stop-loss alert from 15:39". Do not log a close without checking, and do not claim an alert preceded it unless the response says so
- The manual-close response carries preceded_by_alert. If it is empty, say the close was logged with no prior alert rather than implying one existed
- exit_usdc is the USDC actually received. Ask Tyson for it. If you omit it the engine derives shares times exit_price and returns exit_usdc_estimated true, which you must surface to him as an approximation rather than reporting it as the settled figure
- If Tyson says he is already handling an exit himself and does not want repeated alerts, call POST /positions/{{position_id}}/hold with hold true. Alerts stop, price tracking continues. Clear it with hold false
- A held position still appears in GET /positions with manual_hold true, so never read "no alerts" on a held position as "nothing is wrong"
