---
name: trading
category: on-demand
surface: prompt
keywords: [trade, trading, scanner, position]
description: Polymarket prediction-market trading system: standalone trade engine, execution gates, safety rules, system health
# tool-registration intentionally disabled — see Slice 2 audit T10 (uses "## Key API Endpoints" not "## Endpoints")
---

# Trading Room Skill

Charlie uses this skill to monitor, analyse, and manage the Polymarket
prediction market trading system.

## Armed State & Guard

**Live execution is armed by the trade engine alone.** The condition is
`trading_config.trading_enabled = true` AND the `trade-engine` process running
with its scheduler up. n8n is NOT part of this condition any more: every n8n
trading workflow is retired, and their inactive state says nothing about
whether real money can move. Do not infer "not armed" from a dead n8n workflow.

Before any trading action, check the engine, not n8n:
`GET http://127.0.0.1:4003/health` (or the dashboard Engine Status panel).
If the engine is down, say so and stop; never retry blindly.

Never change `trading_enabled` in either direction without explicit
confirmation from Tyson in the current conversation.

Status snapshot (verified live 2026-08-14, re-verify before acting):
- `trading_config.trading_enabled` = **true**, engine scheduler running.
  **Live execution is ARMED.**
- **ALL FOUR n8n trading workflows are INACTIVE** (Market Scanner, Trade
  Executor, Position Monitor 2026-08-05; Weekly Analyst 2026-08-14). Retired,
  not paused. This does NOT mean trading is off. See above.
- Scanning, analysis, approval, execution and position monitoring are owned by
  the standalone trade engine (PM2: trade-engine). See System Architecture.
- `trading_positions` holds 2 rows, both REAL money trades. Both have tx_hash
  NULL, which does NOT mean paper. See Supabase Tables before drawing any
  conclusion from that column.

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
- trading_enabled (boolean): **true**, verified live 2026-08-14. The execution
  gate (executor.py GATE 1), currently OPEN. ALWAYS confirm with Tyson before
  changing it in either direction.
- max_position_usdc: 10
- min_edge_threshold: 7, whole-number percent (7 = 7%). CORRECTION
  (2026-08-14): this is no longer reference-only. The trade engine enforces it
  in executor.py GATE 4, which compares candidate.edge (a raw fraction) against
  min_edge_threshold / 100. Lowering this value now widens what the engine will
  actually trade. (Updated 2026-07-23 from the stale pre-April value 30.)
- daily_loss_limit: 20 (USDC)

## Scanner Calibration

SOURCE CORRECTION (2026-08-14): these thresholds no longer live in the
retired n8n Market Scanner's "Build Run Summary" node. They are now constants
in **src/trade_engine/scanner.py** and settings in
**src/trade_engine/config.py**. Several are environment-overridable, so read
the running values rather than trusting the numbers below.

Verified in code 2026-08-14:
- Edge = simulated probability − market YES price (a raw fraction, so 0.07 is
  7 percentage points).
- High-edge floor: **0.07** (`scanner.AMOUNT_EDGE_FLOOR`).
- Pre-simulation volume floor: **20,000 USDC** (`scanner.MIN_PRESIM_VOLUME`).
- Horizon cap: **35 days** (`scanner.HORIZON_MAX_DAYS`).
- No-edge band and the alert volume floor come from
  `config.no_edge_threshold` and `config.min_alert_volume`, both read from the
  environment. Historically −0.20 and 5,000 USDC, but these are NOT hardcoded:
  check the live config before quoting them.
- Monte Carlo lookback is horizon-adaptive: the last **21 trading days** of
  returns when horizon ≤35d (i.e. every scanner market), the full
  90-calendar-day window otherwise.
- `trading_config.min_edge_threshold` is ENFORCED, not decorative. See
  Current Trading Config and executor.py GATE 4.

## Key API Endpoints

Monte Carlo worker — http://localhost:4001 (PM2: trading-worker):
- GET  /health    — liveness; returns {"status":"ok","service":"monte-carlo-worker"}
- POST /simulate  — run a Monte Carlo simulation (JSON body: asset, target, horizon_days)

Trade execution path (rewritten 2026-08-14): execution belongs entirely to the
standalone trade engine, src/trade_engine/executor.py, which invokes
src/trading/execute_trade.py as a subprocess behind SIX pre-flight gates.
Verified against the code 2026-08-14. Every one of these can refuse a trade
the Analyst and Tyson have already approved, so check them before telling
Tyson a trade "will" go through:

| # | Gate | Refuses when | Limit |
|---|------|--------------|-------|
| 1 | trading_disabled | `trading_config.trading_enabled` is not true | — |
| 2 | position_cap | too many positions already open | **MAX_CONCURRENT_POSITIONS = 2** (hardcoded in executor.py, NOT in trading_config) |
| 3 | daily_loss_limit | today's realised loss meets the limit | `daily_loss_limit` (20 USDC) |
| 4 | edge_below_threshold | `candidate.edge < min_edge_threshold / 100` | 7% |
| 5 | invalid_amount | size ≤ 0, above config, or above a hard ceiling | `max_position_usdc` (10) AND **ABSOLUTE_MAX_POSITION_USDC = 25.0** (hardcoded ceiling that config cannot raise) |
| 6 | invalid_market_identifier | no well-formed Polymarket conditionId | — |

Gates 2 and 5's hard limits are code constants, not database config: raising
`max_position_usdc` above 25 does NOT raise the real ceiling, and there is no
config key for the 2-position cap.

**Gate 3 depends on manual logging (changed 2026-08-20).** The Position Monitor
no longer writes a close when a stop-loss or take-profit threshold fires: it
cannot sell, so it raises an alert and leaves the position open. `get_daily_pnl`
sums `pnl` over positions closed since UTC midnight, and only a real close
logged via `POST /positions/manual-close` populates that field.

The tradeoff, stated plainly: **a real loss on a position closed by hand and not
yet logged is invisible to the daily-loss brake.** Gate 3 will under-count and
may allow an entry it would otherwise have blocked. This is deliberate and is
better than the previous behaviour, which fed the gate a *phantom* loss from a
close that never happened, but it means logging a manual close promptly is now
load-bearing for risk control, not just for the Analyst's learning loop.

If Tyson mentions closing a position, log it the same session.


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

  **Column semantics (canonical, 2026-08-28). Do not infer these from
  precedent: precedent is what drifted.**

  - `entry_price` is the RAW FILL price, exactly as the fill reports it. It is
    NOT the scan price, NOT the simulation's `implied_odds`, and NOT the
    fee-inclusive effective price.
  - `usdc_amount` is the FEE-INCLUSIVE entry cost: everything that left the
    funder wallet in the entry settlement, notional plus taker fee.
  - `exit_usdc` is the NET proceeds: what arrived at the funder wallet, gross
    minus taker fee.
  - `exit_price` is net-effective, `exit_usdc / shares`.
  - `pnl` is `exit_usdc - usdc_amount`.
  - Effective ENTRY price (`usdc_amount / shares`) is DERIVED and is NEVER
    stored. Writing it into `entry_price` is exactly the drift this rule exists
    to stop.

  The asymmetry is deliberate and is the easiest thing here to get wrong:
  `entry_price` is raw, `exit_price` is net-effective. Both stay consistent with
  `pnl` because the entry fee lives in `usdc_amount` while the exit fee is
  already subtracted out of `exit_usdc`.

  **Reconcile against the settlement RECEIPT, not the Polymarket UI.** The two
  disagree by construction: the CLOB data-api `/trades` feed reports the raw
  fill price and GROSS proceeds, while the UI's average price is fee-inclusive.
  Position 71f8a608 stored `entry_price` 0.4170 against a 0.4000 fill precisely
  because 0.4170 is 10.388740 / 24.925, the UI number. Corrected 2026-08-28.
  Taking a gross figure from `/trades` as `exit_usdc` fails the same way in the
  other direction: b3cecdef's exit is 17.86 net, not the 18.02 gross.

  To decode a receipt, sum the 6dp token Transfer events into and out of funder
  `0xE44f7511023d668A2467db5B74168611656eAA50`, with fee recipient
  `0x115f48dc2a731aa16251c6d6e1befc42f92accc9`. The contract set MUST include
  `0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb` (Polymarket wrapped collateral)
  alongside the two USDC addresses. Filtering on the USDC pair alone matches
  ZERO logs and returns a clean-looking "no transfers" result that is entirely
  false. `polygon-bor-rpc.publicnode.com` returns HTTP 403 without a User-Agent
  header, and prunes receipts for older transactions (July 2026 entries no
  longer decode).

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
2. NEVER reactivate any retired n8n trading workflow (all four are inactive by
   decision) without explicit confirmation from Tyson. The Trade Executor in
   particular posts to an HTTP route that no longer exists.
3. Judge armed state from the trade engine, never from n8n. If the engine is
   down, surface that and stop; do not conclude trading is safe because an n8n
   workflow is inactive.
4. Max position is $10 USDC (`max_position_usdc`), with a hardcoded
   $25 ceiling that config cannot exceed. Never suggest or execute trades
   above the config value without approval.
5. Daily loss limit is $20 USDC. If this is hit, trading must stop for the day.
6. The high-edge bar is +7% edge (`scanner.AMOUNT_EDGE_FLOOR`, and enforced
   again at executor.py GATE 4 via min_edge_threshold). Do not recommend
   markets below this edge.
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
