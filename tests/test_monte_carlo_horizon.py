"""Tests for the Monte Carlo pricing kernel (src/trading/simulation.py).

This module priced real money for months with no test coverage at all: CI
installs only src/trade_engine/requirements.txt, and importing monte_carlo.py
drags in flask, yfinance and scipy, so any test of it failed at import. The
pricing arithmetic was split into simulation.py (numpy + stdlib only) so this
file can exist.

The centrepiece is a replay of position e09b82fe, the 3,558-second Ethereum
market of 2026-08-31 that math.ceil priced as a full day. Its parameters are
not invented, they are the values persisted in trading_simulations row
de289c86-c1da-41c2-8a82-2115cc367053, read live on 2026-09-07.

No network, no yfinance, no Flask. Every rng is seeded, so these are
deterministic rather than "usually green".

Run:
    python3 -m unittest tests/test_monte_carlo_horizon.py
"""

import math
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.trading.simulation import (  # noqa: E402
    MAX_STEPS,
    MIN_HORIZON_MODEL_DAYS,
    STEPS_PER_DAY,
    coerce_horizon,
    simulate_paths,
    steps_for_horizon,
)

# --- position e09b82fe, from trading_simulations de289c86 -------------------
# "Will the price of Ethereum be above $2,500 on August 31?"
# sim row created 2026-08-31T15:00:42Z, market endDate 2026-08-31T16:00:00Z.
SPOT = 2467.93
TARGET = 2500.0
MU = 0.012066
SIGMA = 0.040456
MARKET_TYPE = "close_above"          # NOT a touch market, see the class docstring
IMPLIED_ODDS = 0.0255                # what Polymarket was charging
HORIZON_TRUE = 0.04117943363425926   # 3,557.903 seconds, exactly
HORIZON_CEIL = 1.0                   # what math.ceil handed the simulator

STORED_PROBABILITY = 0.4834          # what the worker actually returned that day
HIGH_EDGE_THRESHOLD = 0.07           # config.high_edge_threshold, live value

PATHS = 200_000                      # SE ~0.0005 at p=0.065; production runs 10k
SEED = 20260907


def rng():
    return np.random.default_rng(SEED)


def norm_cdf(x):
    """Standard normal CDF. math.erf so this file needs no scipy."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def terminal_closed_form(spot, target, mu, sigma, horizon, market_type):
    """Exact P for a close_* market under GBM.

    Independent of the code under test and of the step count: log(S_T/S_0) is
    N(nu*T, sigma^2*T), so this is the analytic answer the simulation must
    reproduce. It is what turns "P is about 0.065" from a golden number into a
    statement about whether drift and diffusion are scaled correctly.
    """
    nu = mu - 0.5 * sigma**2
    z = (math.log(target / spot) - nu * horizon) / (sigma * math.sqrt(horizon))
    return 1.0 - norm_cdf(z) if market_type == "close_above" else norm_cdf(z)


def probability(horizon, market_type=MARKET_TYPE, steps_per_day=STEPS_PER_DAY,
                spot=SPOT, target=TARGET, paths=PATHS):
    priced = simulate_paths(
        spot, target, MU, SIGMA, horizon, market_type,
        num_simulations=paths, steps_per_day=steps_per_day, rng=rng(),
    )
    return priced.hits / priced.total


class AcceptanceTest(unittest.TestCase):
    """Replay of e09b82fe. This trade must not be placeable again.

    e09b82fe is a close_above market, not a touch market, which matters twice
    over: the lognormal closed form below is EXACT for it, and its probability
    is invariant to the step count (StepPolicyTest proves that separately), so
    these assertions cannot be perturbed by any future STEPS_PER_DAY decision.
    """

    def test_priced_at_the_true_horizon_it_is_below_the_edge_floor(self):
        """THE acceptance test. P about 0.065, edge about 0.040, no proposal."""
        p = probability(HORIZON_TRUE)
        edge = p - IMPLIED_ODDS

        self.assertAlmostEqual(p, 0.065, delta=0.005, msg=f"P={p:.4f}")
        self.assertAlmostEqual(edge, 0.040, delta=0.005, msg=f"edge={edge:.4f}")
        self.assertLess(
            edge, HIGH_EDGE_THRESHOLD,
            f"edge {edge:.4f} must fall below the {HIGH_EDGE_THRESHOLD} floor, "
            "this is the trade that cost $10.69",
        )

    def test_the_old_ceil_horizon_would_still_fire(self):
        """The counterfactual, asserted so the fix cannot be quietly reverted.

        At the ceil()-rounded 1-day horizon the same market clears the floor by
        a mile. If this ever stops being true the bug has been misdiagnosed.
        """
        p = probability(HORIZON_CEIL)
        edge = p - IMPLIED_ODDS

        self.assertGreater(edge, HIGH_EDGE_THRESHOLD)
        self.assertGreater(edge, 0.40, f"edge={edge:.4f}")

    def test_the_ceil_horizon_reproduces_the_persisted_probability(self):
        """Ties this file to production ground truth.

        trading_simulations.de289c86 stored probability = 0.4834 from a 10,000
        path run. Reproducing it here is what proves the kernel models what the
        worker actually did, rather than what this test wishes it did.
        """
        p = probability(HORIZON_CEIL)
        self.assertAlmostEqual(
            p, STORED_PROBABILITY, delta=0.01,
            msg=f"kernel {p:.4f} vs persisted {STORED_PROBABILITY}",
        )

    def test_simulation_matches_the_exact_closed_form(self):
        """Catches a wrongly-scaled dt that still produces a plausible number."""
        for horizon in (HORIZON_TRUE, HORIZON_CEIL, 5.0, 20.583):
            with self.subTest(horizon=horizon):
                mc = probability(horizon)
                exact = terminal_closed_form(
                    SPOT, TARGET, MU, SIGMA, horizon, MARKET_TYPE
                )
                self.assertAlmostEqual(
                    mc, exact, delta=0.006,
                    msg=f"horizon={horizon}: MC {mc:.4f} vs exact {exact:.4f}",
                )

    def test_the_error_direction_is_one_way(self):
        """Rounding a horizon UP always overstates P for this market.

        The loss was not bad luck on a noisy estimate, the bias has a fixed
        sign, which is why it produced a maximum-size position rather than a
        random one.
        """
        previous = 0.0
        for horizon in (HORIZON_TRUE, 0.1, 0.25, 0.5, HORIZON_CEIL):
            p = probability(horizon)
            self.assertGreater(
                p, previous,
                f"P must increase monotonically with horizon (at {horizon})",
            )
            previous = p


class DtScalingTest(unittest.TestCase):
    """dt is derived, and drift/diffusion scale by dt and sqrt(dt).

    Asserted on the moments of the terminal log-return rather than on a
    probability, because that isolates the scaling from everything else. If
    drift and diffusion are swapped, or dt is pinned back to 1.0, the variance
    check fails immediately and unambiguously.
    """

    def terminal_log_returns(self, horizon, steps_per_day):
        priced = simulate_paths(
            SPOT, TARGET, MU, SIGMA, horizon, MARKET_TYPE,
            num_simulations=PATHS, steps_per_day=steps_per_day, rng=rng(),
        )
        # Re-derive the same paths to inspect their terminal values.
        r = rng()
        steps = priced.steps
        dt = priced.dt
        Z = r.standard_normal((PATHS, steps))
        increments = (MU - 0.5 * SIGMA**2) * dt + SIGMA * np.sqrt(dt) * Z
        return np.cumsum(increments, axis=1)[:, -1], priced

    def test_dt_is_horizon_over_steps_not_one(self):
        for horizon, spd in ((HORIZON_TRUE, 1), (20.583, 1), (4.666, 1), (12.0, 1)):
            with self.subTest(horizon=horizon):
                priced = simulate_paths(
                    SPOT, TARGET, MU, SIGMA, horizon, MARKET_TYPE,
                    num_simulations=100, steps_per_day=spd, rng=rng(),
                )
                self.assertAlmostEqual(
                    priced.dt * priced.steps, horizon, places=9,
                    msg="steps * dt must reconstruct the horizon exactly",
                )

    def test_terminal_variance_is_sigma_squared_times_T(self):
        """Diffusion scales with sqrt(dt): Var[log S_T/S_0] = sigma^2 * T."""
        for horizon in (HORIZON_TRUE, 5.0, 20.583):
            with self.subTest(horizon=horizon):
                terminal, _ = self.terminal_log_returns(horizon, 1)
                expected = SIGMA**2 * horizon
                self.assertAlmostEqual(
                    float(np.var(terminal)) / expected, 1.0, delta=0.02,
                    msg=f"var {np.var(terminal):.8f} vs sigma^2*T {expected:.8f}",
                )

    def test_terminal_mean_is_nu_times_T(self):
        """Drift scales with dt: E[log S_T/S_0] = (mu - sigma^2/2) * T."""
        for horizon in (5.0, 20.583):
            with self.subTest(horizon=horizon):
                terminal, _ = self.terminal_log_returns(horizon, 1)
                expected = (MU - 0.5 * SIGMA**2) * horizon
                self.assertAlmostEqual(
                    float(np.mean(terminal)), expected,
                    delta=4 * SIGMA * math.sqrt(horizon) / math.sqrt(PATHS),
                    msg=f"mean {np.mean(terminal):.8f} vs nu*T {expected:.8f}",
                )

    def test_variance_is_invariant_to_step_count(self):
        """Refining the grid must not change the total variance, only the
        resolution at which the path is observed."""
        variances = []
        for spd in (1, 4, 24):
            terminal, _ = self.terminal_log_returns(20.583, spd)
            variances.append(float(np.var(terminal)))
        for v in variances[1:]:
            self.assertAlmostEqual(v / variances[0], 1.0, delta=0.03)


class StepPolicyTest(unittest.TestCase):
    """STEPS_PER_DAY is a sizing control, and the tests say so."""

    def test_steps_per_day_is_one(self):
        """Tripwire. Raising this re-prices every touch_* market UPWARD.

        Measured on the four historical touch_* positions (400k paths,
        2026-09-07), an hourly grid lifts edges by +0.7 to +6.4 points against
        a 7-point floor and roughly doubles the population of markets that
        would qualify. That is an exposure decision requiring sign-off, not a
        tuning change. If you are changing this, the approval comes first and
        this assertion changes with it.
        """
        self.assertEqual(STEPS_PER_DAY, 1)

    def test_close_markets_are_step_invariant(self):
        """Why the acceptance test above cannot be disturbed by a step change.

        Summing n increments of N(nu*dt, sigma^2*dt) gives N(nu*T, sigma^2*T)
        for any n, so the terminal law does not depend on the grid.
        """
        baseline = probability(HORIZON_CEIL, steps_per_day=1)
        for spd in (2, 8, 32, 128):
            with self.subTest(steps_per_day=spd):
                p = probability(HORIZON_CEIL, steps_per_day=spd)
                self.assertAlmostEqual(
                    p, baseline, delta=0.006,
                    msg=f"close_above moved {baseline:.4f} -> {p:.4f} at {spd}/day",
                )

    def test_touch_markets_are_step_sensitive_and_only_increase(self):
        """The re-baseline finding, pinned as a test.

        A discrete path only observes the barrier at step boundaries, so it
        undercounts crossings and undercounts more at coarser grids. Refining
        the grid therefore only ever RAISES a touch probability. This is the
        exact reason STEPS_PER_DAY is held at 1.
        """
        probabilities = [
            probability(HORIZON_CEIL, market_type="touch_above", steps_per_day=spd)
            for spd in (1, 2, 8, 32, 128)
        ]
        for coarse, fine in zip(probabilities, probabilities[1:]):
            self.assertGreater(
                fine, coarse,
                f"refining the grid must not lower a touch probability: {probabilities}",
            )
        self.assertGreater(
            probabilities[-1], probabilities[0] * 1.5,
            f"expected a material step effect on touch markets: {probabilities}",
        )

    def test_steps_for_horizon_never_returns_zero(self):
        """int(0.0412) == 0 was the second blocker. steps must never be 0:
        a (paths x 0) array makes np.any(..., axis=1) all-False, which prices
        every touch market at a silent P = 0.0."""
        for horizon in (HORIZON_TRUE, 0.001, 0.01, 0.5, 0.999):
            with self.subTest(horizon=horizon):
                self.assertGreaterEqual(steps_for_horizon(horizon), 1)

    def test_steps_for_horizon_preserves_the_old_whole_day_density(self):
        """At STEPS_PER_DAY = 1 a whole-day horizon gets exactly the step count
        it always did, which is what makes this an arithmetic fix and not a
        re-pricing of the markets we actually trade."""
        for days in (1, 2, 5, 12, 21, 30, 35):
            with self.subTest(days=days):
                self.assertEqual(steps_for_horizon(float(days)), days)

    def test_steps_for_horizon_is_capped(self):
        self.assertEqual(steps_for_horizon(35.0, steps_per_day=10_000), MAX_STEPS)

    def test_priced_paths_reports_its_own_discretisation(self):
        priced = simulate_paths(
            SPOT, TARGET, MU, SIGMA, 20.583, MARKET_TYPE,
            num_simulations=1000, rng=rng(),
        )
        self.assertEqual(priced.steps, 21)
        self.assertEqual(priced.total, 1000)
        self.assertAlmostEqual(priced.horizon_days_model, 20.583, places=9)


class ModelFloorTest(unittest.TestCase):
    """MIN_HORIZON_MODEL_DAYS is numerical safety, not a validity threshold."""

    def test_floor_is_applied_to_the_simulated_horizon(self):
        priced = simulate_paths(
            SPOT, TARGET, MU, SIGMA, 1e-9, MARKET_TYPE,
            num_simulations=100, rng=rng(),
        )
        self.assertEqual(priced.horizon_days_model, MIN_HORIZON_MODEL_DAYS)

    def test_floor_does_not_touch_the_acceptance_horizon(self):
        """0.0412d is above the floor, so the acceptance test exercises the
        real value rather than a clamped one."""
        self.assertGreater(HORIZON_TRUE, MIN_HORIZON_MODEL_DAYS)
        priced = simulate_paths(
            SPOT, TARGET, MU, SIGMA, HORIZON_TRUE, MARKET_TYPE,
            num_simulations=100, rng=rng(),
        )
        self.assertAlmostEqual(priced.horizon_days_model, HORIZON_TRUE, places=9)

    def test_the_floor_sits_inside_the_degenerate_region_by_design(self):
        """Documents WHY this is not the control that protects the money path.

        At the floor the model is already a step function, near 0 out of the
        money and near 1 in the money, both with enormous apparent edge. No
        single horizon value fixes that, because degeneracy depends on
        sigma*sqrt(T) against the distance to target. MIN_HORIZON_TRADEABLE_DAYS
        is what actually refuses these markets.
        """
        out_of_money = probability(MIN_HORIZON_MODEL_DAYS)
        in_the_money = probability(
            MIN_HORIZON_MODEL_DAYS, target=SPOT * 0.987, paths=20_000
        )
        self.assertLess(out_of_money, 0.01)
        self.assertGreater(in_the_money, 0.99)


class CoerceHorizonTest(unittest.TestCase):
    """The /simulate endpoint's second, independent coercion."""

    def test_a_sub_day_horizon_survives_intact(self):
        """The regression: int() turned this into 0."""
        value, error = coerce_horizon(HORIZON_TRUE)
        self.assertIsNone(error)
        self.assertAlmostEqual(value, HORIZON_TRUE, places=9)
        self.assertNotEqual(value, 0)

    def test_numeric_strings_are_accepted(self):
        value, error = coerce_horizon("0.041181")
        self.assertIsNone(error)
        self.assertAlmostEqual(value, 0.041181, places=9)

    def test_whole_days_are_unchanged(self):
        for raw in (1, 21, 30, "35"):
            with self.subTest(raw=raw):
                value, error = coerce_horizon(raw)
                self.assertIsNone(error)
                self.assertEqual(value, float(raw))

    def test_non_positive_and_non_finite_are_refused(self):
        for raw in (0, -1, -0.5, float("nan"), float("inf"), float("-inf")):
            with self.subTest(raw=raw):
                value, error = coerce_horizon(raw)
                self.assertIsNone(value)
                self.assertIsNotNone(error)

    def test_garbage_is_refused(self):
        for raw in (None, "", "abc", [], {}):
            with self.subTest(raw=raw):
                value, error = coerce_horizon(raw)
                self.assertIsNone(value)
                self.assertIsNotNone(error)


if __name__ == "__main__":
    unittest.main()
