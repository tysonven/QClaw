# Trading Room

## Auth
Base URL: http://localhost:4000/api/trading
Header: Authorization: Bearer {{secrets.dashboard_auth_token}}

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
