---
name: trading-api
category: on-demand
surface: both
keywords: [trade, trading, scanner, position]
description: Trading room HTTP surface — simulations, positions, config, Monte Carlo runs (localhost:4000)
---

# Trading Room

## Auth
Base URL: http://localhost:4000/api/trading
Header: Authorization: Bearer {{config.dashboard.authToken}}
# Note: resolves from live config at call time — no drift on restart.
# Supersedes the dashboard_auth_token secret, which is left in the store
# (unreferenced) rather than deleted.

## Endpoints
GET /simulations - Returns last 10 trading simulations
GET /positions - Returns open trading positions
GET /config - Returns trading config (enabled, limits)
POST /simulate - Runs Monte Carlo simulation (body: asset, target, horizon_days, question)

## Permissions
- http: [localhost:4000]
- shell: none
- file: none

## Usage Notes
- Use /simulations to check latest prices and sim results
- Use /positions to check open Polymarket positions
- Use /simulate to run a new Monte Carlo analysis on demand
