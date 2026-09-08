#!/usr/bin/env python3
"""Monte Carlo simulation worker for gold and BTC price prediction.

Data fetching, the macro adjustment and the HTTP surface live here. The pricing
ARITHMETIC lives in simulation.py and is imported, see that module's docstring
for why the split exists.
"""

from flask import Flask, request, jsonify
import yfinance as yf
import numpy as np
from scipy import stats
from datetime import datetime, timedelta

# PM2 runs this file as a SCRIPT (`python3 /root/QClaw/src/trading/monte_carlo.py`,
# cwd /root/QClaw), which puts src/trading on sys.path but NOT the repo root, so
# the packaged import fails there. The test suite and any future in-process
# caller import it the packaged way. Both forms are supported explicitly rather
# than relying on whichever one happens to work.
try:
    from src.trading.simulation import (
        MAX_STEPS,
        MIN_HORIZON_MODEL_DAYS,
        NUM_SIMULATIONS,
        STEPS_PER_DAY,
        coerce_horizon,
        coerce_target,
        detect_market_type,
        simulate_paths,
        steps_for_horizon,
        wilson_interval,
    )
except ImportError:  # pragma: no cover - exercised by the PM2 script invocation
    from simulation import (  # type: ignore[no-redef]
        MAX_STEPS,
        MIN_HORIZON_MODEL_DAYS,
        NUM_SIMULATIONS,
        STEPS_PER_DAY,
        coerce_horizon,
        coerce_target,
        detect_market_type,
        simulate_paths,
        steps_for_horizon,
        wilson_interval,
    )

app = Flask(__name__)

TICKERS = {
    "sol": "SOL-USD",
    "xrp": "XRP-USD",
    "natgas": "NG=F",
    "gold": "GC=F",
    "btc": "BTC-USD",
    "wti": "CL=F",
    "brent": "BZ=F",
    "silver": "SI=F",
    "eth": "ETH-USD",
}
MACRO_TICKERS = {
    "dxy": "DX-Y.NYB",
    "tnx": "^TNX",
}

TRADING_DAYS_YEAR = 252

# NUM_SIMULATIONS, STEPS_PER_DAY, MAX_STEPS, MIN_HORIZON_MODEL_DAYS,
# wilson_interval, detect_market_type, coerce_horizon, steps_for_horizon and
# simulate_paths are imported from simulation.py above. They are re-exported by
# that import so existing callers of monte_carlo.<name> keep working.


def fetch_macro():
    """Fetch macro factors: DXY and 10Y yield."""
    factors = {}
    try:
        for name, ticker in MACRO_TICKERS.items():
            data = yf.download(ticker, period="5d", progress=False, auto_adjust=True)
            if len(data) >= 2:
                close = data["Close"].values.flatten()
                current = float(close[-1])
                prev = float(close[-2])
                change_pct = (current - prev) / prev * 100
                factors[name] = {"current": round(current, 4), "change_pct": round(change_pct, 4)}
            else:
                factors[name] = {"current": None, "change_pct": 0}
    except Exception as e:
        factors["error"] = str(e)
    return factors


def run_simulation(asset, target, horizon_days=30.0, question=''):
    """Run Monte Carlo simulation for an asset."""
    ticker_symbol = TICKERS.get(asset)
    if not ticker_symbol:
        return None, f"Unknown asset: {asset}"

    # Fetch 90 days of historical data
    data = yf.download(ticker_symbol, period="90d", progress=False, auto_adjust=True)
    if len(data) < 10:
        return None, f"Insufficient data for {asset}"

    prices = data["Close"].values.flatten()

    # Short-horizon markets (<35d): 21d lookback matches the vol regime more
    # closely than 90d; avoids systematic conservatism on OTM short-dated
    # crypto rungs. Sliced from the tail of the single 90d download so the
    # window is 21 TRADING days (yfinance `period` counts calendar days);
    # horizon >35d keeps the full window — long-dated path is unchanged.
    lookback_days = 21 if horizon_days <= 35 else 90
    if lookback_days == 21:
        prices = prices[-(lookback_days + 1):]

    current_price = float(prices[-1])

    # Calculate daily returns
    log_returns = np.diff(np.log(prices))
    mu = float(np.mean(log_returns))
    sigma = float(np.std(log_returns))

    if not np.isfinite(mu) or not np.isfinite(sigma) or sigma <= 0:
        return None, f"Invalid statistics for {asset}: mu={mu}, sigma={sigma} (possible NaN/sparse data)"

    # mu and sigma are per DAY. horizon_days is a total time in days, not a
    # step count, dt comes out of simulate_paths as horizon/steps.
    market_type = detect_market_type(question, target, current_price)
    priced = simulate_paths(
        current_price, target, mu, sigma, horizon_days, market_type,
        num_simulations=NUM_SIMULATIONS,
    )

    market_type_used = market_type
    prob, ci_lower, ci_upper = wilson_interval(priced.hits, priced.total)

    # Macro adjustment for gold
    macro = fetch_macro()
    macro_adj = 0.0
    if asset == "gold":
        dxy_change = macro.get("dxy", {}).get("change_pct", 0) or 0
        tnx_change = macro.get("tnx", {}).get("change_pct", 0) or 0
        # Rising yields + strengthening USD → bearish for gold
        if dxy_change > 0 and tnx_change > 0:
            macro_adj = -0.05
        elif dxy_change < 0 and tnx_change < 0:
            macro_adj = 0.03
        prob = round(max(0, min(1, prob + macro_adj)), 4)
        ci_lower = round(max(0, ci_lower + macro_adj), 4)
        ci_upper = round(min(1, ci_upper + macro_adj), 4)

    return {
        "probability": prob,
        "confidence_lower": ci_lower,
        "confidence_upper": ci_upper,
        "current_price": round(current_price, 2),
        "target": target,
        "asset": asset,
        "horizon_days": horizon_days,
        # What was actually priced. horizon_days is what the caller asked for;
        # these three say how it was discretised, so a stored simulation row
        # can be re-derived later instead of guessed at.
        "horizon_days_model": priced.horizon_days_model,
        "steps": priced.steps,
        # priced.steps_per_day, NOT the module constant. simulate_paths takes
        # steps_per_day as an argument, so the constant is only the default;
        # reporting it would make a persisted row claim a density that was not
        # used the moment anything passes an override. Issue #119 is exactly
        # that change.
        "steps_per_day": priced.steps_per_day,
        "market_type": market_type_used,
        "question": question or f"Will {asset} hit ${target}?",
        "simulations": NUM_SIMULATIONS,
        "daily_mu": round(mu, 6),
        "daily_sigma": round(sigma, 6),
        "macro_adjustment": macro_adj,
        "macro_factors": macro,
    }, None


@app.route("/simulate", methods=["POST"])
def simulate():
    try:
        body = request.get_json(force=True, silent=True) or {}
        asset = body.get("asset", "gold").lower()
        target = body.get("target")
        horizon = body.get("horizon_days", 30.0)

        if target is None:
            return jsonify({"error": "target is required"}), 400

        # Both coercions live in simulation.py so the suite can reach them;
        # see coerce_target's docstring for why an inline guard here was not a
        # guard at all.
        target, target_error = coerce_target(target)
        if target_error:
            return jsonify({"error": target_error}), 400

        # coerce_horizon, NOT int(). See simulation.coerce_horizon for why the
        # int() this replaced was a second, independent truncation that failed
        # SILENTLY on touch markets.
        horizon, horizon_error = coerce_horizon(horizon)
        if horizon_error:
            return jsonify({"error": horizon_error}), 400

        question = body.get("question", "")
        result, error = run_simulation(asset, target, horizon, question)
        if error:
            return jsonify({"error": error}), 400

        def _sanitize(v):
            if isinstance(v, float) and not np.isfinite(v):
                return None
            return v
        result = {k: _sanitize(v) for k, v in result.items()}

        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e), "type": type(e).__name__}), 500


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "monte-carlo-worker"})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=4001, debug=False)
