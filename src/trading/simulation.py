#!/usr/bin/env python3
"""Pricing kernel for the Monte Carlo worker. Pure, no network, no Flask.

Split out of monte_carlo.py on 2026-09-07 so the pricing ARITHMETIC can be
tested directly against known parameters. monte_carlo.py keeps the Flask app,
the yfinance fetching and the macro adjustment, and calls into here for the
maths, so the served path and the tested path cannot diverge.

The split is also what makes the tests runnable: CI installs only
src/trade_engine/requirements.txt, and importing monte_carlo.py drags in flask,
yfinance and scipy. This module needs numpy and the stdlib, which is why the
module that prices real money finally has a test suite.

NOTHING IN HERE MAY IMPORT flask, yfinance OR scipy.
"""

from collections import namedtuple
import math
import re

import numpy as np

NUM_SIMULATIONS = 10_000

# --- horizon discretisation --------------------------------------------------
#
# `horizon_days` is a FLOAT and is a TOTAL TIME, not a step count.
#
# Until 2026-09-07 the scanner rounded it up with math.ceil before it ever
# arrived here, and the worker then used the result as both the total time AND
# the step count with dt hardwired to 1.0. A 3,558-second market (0.0412d) was
# therefore priced over a full day: P 0.0648 -> 0.4834, edge +3.9pts ->
# +45.8pts, and position e09b82fe fired at the $10 cap for a total loss. The
# error direction was constant, a shorter real horizon rounded up means the
# price diffuses for longer than the market has, which overstates the
# probability of reaching the target, which inflates the edge, which maximises
# position size.
#
# STEPS_PER_DAY is deliberately 1, which is the density that has always been in
# force (steps == whole days). RAISING IT IS A SIZING DECISION, NOT A TUNING
# KNOB. It needs its own approval before it ships, and the reason is not
# conservatism:
#
# A discrete path only observes the barrier at step boundaries, so it
# undercounts crossings, and undercounts more at coarser grids. Refining the
# grid therefore RAISES every touch_* probability, which raises edge, which
# raises position size and, the effect that actually matters, recruits
# markets that currently sit below the 7-point edge floor. Measured on the four
# historical touch_* positions (400k paths, 2026-09-07), an hourly grid lifts
# edges by +0.7 to +6.4 points against a 7-point floor; cee4eacd moves from
# 6.13 to 6.80 points, i.e. 0.2 points short of qualifying. On that sample it
# roughly doubles the population of markets that would propose while barely
# resizing the ones already taken. That is an exposure change wearing the
# costume of an accuracy fix.
#
# close_above / close_below are unaffected by this constant either way: summing
# n increments of N(nu*dt, sigma^2*dt) gives N(nu*T, sigma^2*T) for any n, so
# the terminal law, and every close_* probability, is step-invariant.
# test_monte_carlo_horizon.py asserts both halves of that claim.
STEPS_PER_DAY = 1

# Bound on the path array so a future STEPS_PER_DAY increase cannot silently
# allocate gigabytes: the arrays are (NUM_SIMULATIONS x steps) float64, so at
# the 35-day scanner ceiling an hourly grid is already ~200MB per call.
MAX_STEPS = 2_000

# NUMERICAL SAFETY FLOOR ONLY. This is NOT a validity threshold, and relaxing
# it does not make short-horizon pricing sound.
#
# As T -> 0 the diffusion term sigma*sqrt(T) -> 0 and the model collapses into a
# step function. At e09b82fe's own parameters, measured 2026-09-07: an
# out-of-the-money target gives P = 0.0008 at T = 0.01d and 0.0000 by T = 0.001d,
# while an in-the-money target gives P = 0.9995 at T = 0.01d and 1.0000 below
# that, a confident, maximum-size +97-point edge. That is the same bug as the
# ceil() above with the sign flipped.
#
# 0.01 SITS INSIDE THAT DEGENERATE REGION BY DESIGN. Its job is to stop T = 0
# and to stop the simulator emitting a hard 0.0000/1.0000. No single value can
# make the model valid, because degeneracy depends on sigma*sqrt(T) relative to
# the distance to target, which is per-market.
#
# The control that actually protects the money path is
# MIN_HORIZON_TRADEABLE_DAYS = 1.0, enforced in PolymarketScanner.analyse_edge
# and again in TradeExecutor GATE 7. If you are reading this because a
# short-dated market was refused, THAT is the constant you are looking for.
# Lowering this one instead would strip the arithmetic guard and leave the
# refusal exactly where it was.
MIN_HORIZON_MODEL_DAYS = 0.01

# What the kernel actually priced, carried back so a persisted simulation row
# records its own discretisation. The ceil() bug survived 5,649 stored rows
# partly because none of them recorded the effective horizon or the step count.
PricedPaths = namedtuple("PricedPaths", "hits total steps dt horizon_days_model")


def wilson_interval(successes, total, z=1.96):
    """Wilson score interval for binomial proportion."""
    if total == 0:
        return 0.0, 0.0, 0.0
    p_hat = successes / total
    denom = 1 + z**2 / total
    centre = (p_hat + z**2 / (2 * total)) / denom
    spread = z * math.sqrt((p_hat * (1 - p_hat) + z**2 / (4 * total)) / total) / denom
    return round(centre, 4), round(max(0, centre - spread), 4), round(min(1, centre + spread), 4)


def detect_market_type(question, target, current_price):
    """
    Detect whether this is a touch market or close-on-date market.

    Touch market: "will X dip to/reach/hit Y", checks any path touch
    Close-on-date: "will X be above/below Y on [date]", checks final price only

    Returns: 'touch_above' | 'touch_below' | 'close_above' | 'close_below'
    """
    q = (question or '').lower()

    # Close-on-date patterns: "above X on [date]" or "over X on [date]"
    if re.search(r'\b(above|over)\b', q) and re.search(r'\bon\b', q):
        return 'close_above'

    # Close-on-date patterns: "below X on [date]" or "under X on [date]"
    if re.search(r'\b(below|under)\b', q) and re.search(r'\bon\b', q):
        return 'close_below'

    # Touch market: direction based on target vs current price
    if target < current_price:
        return 'touch_below'
    return 'touch_above'


def coerce_horizon(raw):
    """Parse a request's horizon_days. Returns (value, error), never raises.

    float(), NOT int(). The int() this replaced was a SECOND, independent
    truncation sitting downstream of the scanner's math.ceil, and fixing only
    the scanner would have made things WORSE rather than better:

      int(0.0412) == 0  ->  steps == 0  ->  a (num_simulations x 0) path array.

    np.any(empty, axis=1) is all-False, so every touch_* market would have
    priced at a SILENT P = 0.0 and been persisted as real data. close_* markets
    fail loudly instead, paths[:, -1] raises IndexError on the empty axis.
    A silent wrong number is the worse of the two, so this rejects rather than
    coerces anything that is not a usable positive horizon.
    """
    try:
        value = float(raw)
    except (ValueError, TypeError):
        return None, "horizon_days must be numeric"
    if not math.isfinite(value):
        return None, "horizon_days must be finite"
    if value <= 0:
        return None, "horizon_days must be greater than zero"
    return value, None


def steps_for_horizon(horizon_days, steps_per_day=STEPS_PER_DAY):
    """Step count for a horizon, decoupled from the horizon's magnitude.

    At the default STEPS_PER_DAY = 1 this returns exactly the old
    `steps = horizon_days` for whole-day horizons, so the discretisation of
    every market at or above the 1-day tradeable floor is unchanged by the
    fractional fix, that is what makes this a pure arithmetic correction and
    not a re-pricing. Sub-day horizons get 1 step rather than the 0 that
    truncation used to produce.
    """
    return int(min(MAX_STEPS, max(1, math.ceil(horizon_days * steps_per_day))))


def simulate_paths(current_price, target, mu, sigma, horizon_days, market_type,
                   num_simulations=NUM_SIMULATIONS, steps_per_day=STEPS_PER_DAY,
                   rng=None):
    """Price one market by GBM path simulation.

    `mu` and `sigma` are per DAY. `horizon_days` is the TOTAL time in days and
    may be fractional; dt is DERIVED from it as horizon/steps rather than
    assumed to be 1.0, so drift scales with dt and diffusion with sqrt(dt).
    Getting that pair the wrong way round is the whole bug class this function
    exists to contain, so it is asserted directly in the tests.

    `rng` is injectable so a test can be deterministic. Production leaves it
    None, which reseeds from the OS per call, matching the np.random.seed(None)
    the old inline implementation did.
    """
    horizon_model = max(float(horizon_days), MIN_HORIZON_MODEL_DAYS)
    steps = steps_for_horizon(horizon_model, steps_per_day)
    dt = horizon_model / steps

    if rng is None:
        rng = np.random.default_rng()
    Z = rng.standard_normal((num_simulations, steps))

    drift = (mu - 0.5 * sigma**2) * dt
    diffusion = sigma * np.sqrt(dt) * Z

    log_increments = drift + diffusion
    log_paths = np.cumsum(log_increments, axis=1)
    paths = current_price * np.exp(log_paths)

    if market_type == 'close_above':
        hits = (paths[:, -1] >= target).sum()
    elif market_type == 'close_below':
        hits = (paths[:, -1] <= target).sum()
    elif market_type == 'touch_above':
        hits = np.any(paths >= target, axis=1).sum()
    else:  # touch_below
        hits = np.any(paths <= target, axis=1).sum()

    return PricedPaths(int(hits), num_simulations, steps, dt, horizon_model)
