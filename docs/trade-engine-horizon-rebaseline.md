# Fractional horizon re-baseline

Companion to the fractional-horizon fix. Produced 2026-09-07, before that PR
was marked ready, because changing how a market is discretised re-prices
markets we have already traded and that is a sizing question, not a code
review question.

Two things are separated here on purpose:

1. **The arithmetic fix** (shipped). `_horizon_days` returns exact fractional
   days instead of `math.ceil`, and the simulator derives `dt = horizon/steps`
   instead of hardwiring `dt = 1.0`.
2. **The step density** (NOT shipped). `STEPS_PER_DAY` stays at 1. Raising it
   is an exposure decision and is tracked separately.

## Method, and what it cannot tell you

Each historical simulation was rebuilt offline from the values persisted in
`trading_simulations.raw_output`: `current_price`, `target`, `daily_mu`,
`daily_sigma` and `market_type`. Nothing was re-fetched from yfinance, so these
numbers are reproducible and do not drift with market data.

400,000 paths per cell, seed 20260907. Production runs 10,000 paths, so live
figures carry about +/-0.005 of Monte Carlo noise at p = 0.5.

**Reproduction check.** The offline model matches what production actually
returned, which is what makes the rest of this document evidence rather than
opinion:

| position | stored P | reproduced | delta |
|---|---|---|---|
| e09b82fe | 0.4834 | 0.4838 | +0.0004 |
| cee4eacd | 0.9890 | 0.9870 | -0.0020 |
| 71f8a608 | 0.5646 | 0.5593 | -0.0053 |
| f4be9ee8 | 0.6283 | 0.6318 | +0.0035 |
| b3cecdef | 0.7385 | 0.7328 | -0.0057 |

All inside production's own 10,000-path noise.

**Model validity.** The four touch_* figures below are NOT sound probability
estimates and must not be read as edges we believe in. They are like-for-like
re-prices under the model the code already uses, which is the only question a
re-baseline asks. The model assumes GBM with constant volatility estimated from
21 daily closes: no term structure, no volatility clustering, no fat tails, and
a drift estimated from the same 21 points and therefore dominated by sampling
noise. The barrier is checked on a simulated grid, while Polymarket resolves
against a specific reference feed on a schedule that is neither that grid nor
continuous. The continuous-limit column assumes exact continuous monitoring,
which no real market has.

The one exception is e09b82fe. It is a `close_above` market, so the terminal
lognormal closed form is exact for it and the recomputed 6.5% is sound as far
as the vol estimate goes.

## The numbers

Scan-time implied odds, 7-point edge floor.

- **CURRENT**: `steps = ceil(T)`, `dt = 1.0`, so total simulated time is `ceil(T)` days
- **P0**: fractional horizon, step density unchanged at 1/day (what shipped)
- **P1**: fractional horizon, hourly grid (NOT shipped)
- **limit**: continuous first-passage closed form, the steps to infinity ceiling

| position | market | true horizon | ceil | CURRENT P / edge | P0 P / edge | P1 P / edge | limit |
|---|---|---|---|---|---|---|---|
| cee4eacd | XRP `touch_below` | 20.583 d | 21 | 0.9870 / +6.20 | 0.9863 / +6.13 | 0.9930 / +6.80 | 0.9942 / +6.92 |
| 71f8a608 | BTC `touch_below` | 20.333 d | 21 | 0.5593 / +14.43 | 0.5459 / +13.09 | 0.5899 / +17.49 | 0.6023 / +18.73 |
| f4be9ee8 | ETH `touch_above` | 11.416 d | 12 | 0.6318 / +35.28 | 0.6149 / +33.59 | 0.6725 / +39.35 | 0.6901 / +41.11 |
| b3cecdef | SOL `touch_above` | 4.666 d | 5 | 0.7328 / +33.68 | 0.7062 / +31.02 | 0.7704 / +37.44 | 0.7913 / +39.53 |
| e09b82fe | ETH `close_above` | 0.0412 d | 1 | 0.4838 / +45.83 | 0.0648 / +3.93 | 0.0648 / +3.93 | n/a |

Edges are percentage points.

`close_*` markets are step-invariant: summing n increments of
`N(nu*dt, sigma^2*dt)` gives `N(nu*T, sigma^2*T)` for any n. Measured at
e09b82fe's parameters, P moves 0.0648 -> 0.0651 across steps 1 to 128, which is
noise. The same parameters priced as `touch_above` move 0.0648 -> 0.1148 over
the same range. That is the whole issue in one comparison.

## Two effects, opposite signs

**Correcting the horizon (P0) lowers touch probabilities by 0.7 to 2.7 points.**
Safe direction, pure arithmetic, no judgement involved.

**Refining the grid (P1) raises them by 0.7 to 6.4 points over P0**, netting
+0.6 to +4.1 points above today. A discrete path only observes the barrier at
step boundaries, so it undercounts crossings and undercounts more at coarser
grids.

## Which historical trades change

**Under P0, exactly one.**

- **e09b82fe would not have fired.** +45.83 points today, +3.93 recomputed,
  against a 7-point floor. This is the $10.69 loss.
- The other four keep their verdicts. One resize: 71f8a608 $9.50 -> $8.33.
- Nothing that did not fire begins to.

**Under P1, no historical verdict flips either, and that understates the risk.**

`_amount_usdc` saturates at $10 above 15 points, so P1 barely resizes trades we
already took. Its real effect is recruitment at the margin:

- cee4eacd moves 6.13 -> 6.80 points, stopping **0.2 points short** of the floor.
- The measured lift is up to +6.4 points against a 7-point floor, so any touch
  market currently sitting anywhere in the 1 to 7 point band could start
  proposing.
- On this sample that roughly doubles the population of qualifying markets while
  changing sizing on almost none of them.

That is an exposure change, not an accuracy improvement, which is why
`STEPS_PER_DAY` ships at 1 and is guarded by a test that names the approval
requirement.

## What was NOT measured

- Whether any of these markets would have resolved differently. Re-pricing a
  historical simulation says what the scanner would have proposed, not what
  would have happened.
- The 1 to 7 point band population, directly. The "roughly doubles" claim is
  inferred from the size of the lift against the floor on a sample of four, not
  counted from the 5,649 stored simulation rows. Counting it is the first thing
  the P1 work should do, and the newly persisted `steps` / `horizon_days_model`
  fields are what make that possible for rows written from now on.
- Anything about touch model validity. See the method note above.

## Reproducing this

Parameters are in the table plus `trading_simulations.raw_output` for each id.
The kernel is `src/trading/simulation.py`; `simulate_paths` takes
`steps_per_day` directly, so P0 and P1 are one argument apart. The continuous
limit uses the reflection principle:

```
nu = mu - sigma^2/2 ,  b = ln(K/S0) ,  s = sigma*sqrt(T)

touch_above (b > 0):  Phi((-b + nu T)/s) + exp(2 nu b / sigma^2) * Phi((-b - nu T)/s)
touch_below (b < 0):  Phi(( b - nu T)/s) + exp(2 nu b / sigma^2) * Phi(( b + nu T)/s)
```
