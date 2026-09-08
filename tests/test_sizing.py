"""Tests for fractional-Kelly position sizing (src/trade_engine/sizing.py).

sizing.py imports nothing but the stdlib, so these need no env, no config, no
network and no numpy. That is deliberate and is the same reason horizon.py and
simulation.py were split out: the arithmetic that decides how much money leaves
the wallet has to be testable on its own.

The historical positions here are the four from
docs/trade-engine-horizon-rebaseline.md, at their re-baselined probabilities.

Run:
    python3 -m unittest tests.test_sizing
"""

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.trade_engine.sizing import (  # noqa: E402
    FEE_RATE,
    fee_ratio,
    side_price_for,
    size_position,
)

# The shipped configuration.
LIVE = dict(bankroll=25.0, kelly_fraction=0.10, max_position_usdc=25.0,
            price_floor=0.10)
MIN_SHARES = 5.0

# position, simulated p, market YES price
HISTORICAL = [
    ("cee4eacd XRP", 0.9863, 0.925),
    ("71f8a608 BTC", 0.5459, 0.415),
    ("f4be9ee8 ETH", 0.6149, 0.279),
    ("b3cecdef SOL", 0.7062, 0.396),
]


def size(p, price, direction="YES", minimum=MIN_SHARES, **over):
    kw = dict(LIVE)
    kw.update(over)
    return size_position(
        sim_probability=p, yes_price=price, direction=direction,
        min_order_size=minimum, **kw,
    )


class KellyArithmeticTest(unittest.TestCase):
    """The formula, against a closed form computed independently here."""

    def test_fraction_matches_the_closed_form(self):
        for p, price in ((0.60, 0.40), (0.30, 0.20), (0.99, 0.90), (0.52, 0.50)):
            with self.subTest(p=p, price=price):
                s = size(p, price)
                expected = LIVE["kelly_fraction"] * (p - price) / (1 - price)
                self.assertAlmostEqual(s.kelly_fraction, expected, places=12)

    def test_zero_edge_is_a_refusal_not_a_zero_bet(self):
        s = size(0.40, 0.40)
        self.assertFalse(s.tradeable)
        self.assertEqual(s.refusal, "no_positive_edge")

    def test_certainty_gives_the_whole_kelly_fraction(self):
        """At p=1 the full-Kelly fraction is 1, so the stake is exactly
        KELLY_FRACTION of bankroll: $2.50. This is the ceiling on any position
        at this bankroll, and it is what makes the exchange minimum binding."""
        s = size(1.0, 0.50)
        self.assertAlmostEqual(s.kelly_debit, 2.50, places=9)

    def test_edge_scales_the_stake_monotonically(self):
        previous = 0.0
        for p in (0.45, 0.50, 0.60, 0.80, 0.99):
            s = size(p, 0.40)
            self.assertGreater(s.notional, previous)
            previous = s.notional


class FeeAwareTest(unittest.TestCase):
    """The cap is the DEBIT, not the notional."""

    def test_fee_ratio_matches_the_verified_receipt(self):
        """10.501189 debited against 10.00 notional at price 0.284."""
        self.assertAlmostEqual(1 + fee_ratio(0.284), 10.501189 / 10.0, places=4)

    def test_debit_equals_the_cap_and_notional_is_below_it(self):
        s = size(1.0, 0.50)  # kelly_debit is the binding cap here
        self.assertAlmostEqual(s.debit, s.kelly_debit, places=9)
        self.assertLess(s.notional, s.debit, "the fee is charged on top")

    def test_sizing_the_notional_to_the_cap_would_overspend(self):
        """What the old code did, stated as a number.

        Sizing the notional to the cap makes the wallet pay cap * (1 + fee),
        which at price 0.10 is 6.3% more than intended, every single trade.
        """
        s = size(1.0, 0.10)
        naive_debit = s.kelly_debit * (1 + fee_ratio(0.10))
        self.assertGreater(naive_debit - s.kelly_debit, 0.15)
        self.assertAlmostEqual(s.debit, s.kelly_debit, places=9)

    def test_shares_are_derived_from_the_notional_actually_sent(self):
        """Not from an unrounded intermediate.

        The relay is sent the ROUNDED notional, and the exchange divides that by
        price to get the order size. Deriving shares from anything else means
        the count checked against the minimum is not the count the exchange
        computes, which at the boundary is the difference between a clean
        refusal and a rejected order.
        """
        for p_true, price in ((0.90, 0.20), (0.35, 0.10), (0.60, 0.40)):
            with self.subTest(price=price):
                s = size(p_true, price)
                self.assertEqual(s.notional, round(s.notional, 6))
                self.assertAlmostEqual(s.shares, s.notional / price, places=12)
                self.assertEqual(
                    s.debit, round(s.notional * (1 + fee_ratio(price)), 6),
                    "debit must follow the rounded notional, not an intermediate",
                )


class CeilingTest(unittest.TestCase):
    """Kelly only ever sizes DOWN. The ceiling sits above it."""

    def test_ceiling_binds_and_is_recorded(self):
        s = size(1.0, 0.50, bankroll=10_000.0)
        self.assertEqual(s.clamped_by, "max_position_usdc")
        self.assertAlmostEqual(s.debit, LIVE["max_position_usdc"], places=9)

    def test_ceiling_does_not_bind_at_the_live_bankroll(self):
        """At $25 and a tenth of Kelly the largest possible stake is $2.50, so
        the ceiling can never bind. It still has to exist: bankroll is config."""
        for p, price in ((1.0, 0.10), (1.0, 0.50), (0.99, 0.30)):
            with self.subTest(p=p, price=price):
                self.assertIsNone(size(p, price).clamped_by)

    def test_the_ceiling_never_raises_a_small_kelly(self):
        s = size(0.50, 0.415)
        self.assertLess(s.debit, LIVE["max_position_usdc"])
        self.assertIsNone(s.clamped_by)


class ExchangeMinimumTest(unittest.TestCase):
    """The finding that reshaped this change."""

    def test_every_historical_position_is_refused(self):
        """Correct sizing puts all four under the 5-share floor.

        Not a regression. These are the trades the old ramp sized at $10 each.
        """
        for name, p, price in HISTORICAL:
            with self.subTest(position=name):
                s = size(p, price)
                self.assertFalse(s.tradeable)
                self.assertEqual(s.refusal, "below_exchange_minimum")
                self.assertLess(s.shares, MIN_SHARES)

    def test_refusal_still_carries_the_arithmetic(self):
        """A refusal is a measurement. Item (c) needs these numbers."""
        s = size(0.6149, 0.279)
        self.assertFalse(s.tradeable)
        for field in ("price=", "edge=", "shares=", "required_shares=",
                      "min_notional=", "kelly_notional="):
            self.assertIn(field, s.log_fields())
        self.assertGreater(s.notional, 0, "the computed size is still reported")

    def test_it_never_rounds_up_to_reach_the_minimum(self):
        """The one thing that must not happen.

        A stake raised to clear an exchange floor is a stake chosen by the
        exchange, not by the edge, and it is larger than Kelly says is safe.
        """
        s = size(0.6149, 0.279)
        self.assertLess(s.shares, s.required_shares)
        self.assertLess(s.notional, s.min_notional)

    def test_above_price_one_half_it_is_impossible_at_any_edge(self):
        """The correction to the original audit.

        edge can never exceed (1 - price), so requiring edge >= 2*price*(1-price)
        requires price <= 0.5. Deep favourites are the region that is
        arithmetically impossible, NOT the region that survives. Checked at
        p = 1, which is the best case there is.
        """
        for price in (0.50, 0.60, 0.75, 0.90, 0.964, 0.99):
            with self.subTest(price=price):
                s = size(1.0, price)
                self.assertFalse(
                    s.tradeable,
                    f"price {price} cleared the minimum at certainty: {s.log_fields()}",
                )

    def test_below_price_one_half_a_large_enough_edge_does_clear(self):
        """The band that survives is real, just narrow."""
        for price, p in ((0.10, 0.35), (0.20, 0.60), (0.30, 0.80), (0.40, 0.95)):
            with self.subTest(price=price, p=p):
                s = size(p, price)
                self.assertTrue(s.tradeable, s.log_fields())
                self.assertGreaterEqual(s.shares, MIN_SHARES)

    def test_the_seven_point_edge_floor_can_never_be_placed(self):
        """At the minimum qualifying edge nothing is placeable anywhere in the
        sizeable price range."""
        for price in (0.10, 0.20, 0.30, 0.40, 0.45):
            with self.subTest(price=price):
                self.assertFalse(size(price + 0.07, price).tradeable)

    def test_the_minimum_is_read_not_assumed(self):
        """A market with a different orderMinSize sizes against ITS value."""
        generous = size(0.35, 0.10, minimum=1.0)
        strict = size(0.35, 0.10, minimum=50.0)
        self.assertTrue(generous.tradeable)
        self.assertFalse(strict.tradeable)
        self.assertEqual(strict.required_shares, 50.0)


class FailClosedTest(unittest.TestCase):
    def test_unknown_minimum_is_refused_never_assumed_to_be_five(self):
        for bad in (None, 0, -1, float("nan"), float("inf")):
            with self.subTest(minimum=bad):
                s = size(0.35, 0.10, minimum=bad)
                self.assertFalse(s.tradeable)
                self.assertEqual(s.refusal, "unknown_min_order_size")

    def test_a_market_that_would_otherwise_trade_is_still_refused(self):
        """The fail-closed path must not be reachable only for bad trades."""
        self.assertTrue(size(0.35, 0.10, minimum=5.0).tradeable)
        self.assertFalse(size(0.35, 0.10, minimum=None).tradeable)

    def test_invalid_prices_are_refused(self):
        for price in (0.0, 1.0, -0.5, 1.5):
            with self.subTest(price=price):
                self.assertEqual(size(0.5, price).refusal, "invalid_price")

    def test_non_finite_inputs_are_refused(self):
        for p in (float("nan"), float("inf")):
            with self.subTest(p=p):
                self.assertEqual(size(p, 0.40).refusal, "invalid_input")

    def test_non_positive_bankroll_is_refused(self):
        for bank in (0.0, -25.0):
            with self.subTest(bankroll=bank):
                self.assertEqual(size(0.9, 0.20, bankroll=bank).refusal,
                                 "invalid_bankroll")


class PriceFloorTest(unittest.TestCase):
    """A proposal filter, not a clamp on price in the formula."""

    def test_below_the_floor_is_refused(self):
        s = size(0.50, 0.05)
        self.assertFalse(s.tradeable)
        self.assertEqual(s.refusal, "price_below_sizing_floor")

    def test_the_floor_is_not_applied_as_a_clamp(self):
        """If price were clamped to 0.10 rather than filtered, a 0.05 market
        would return a SIZE. It must return a refusal instead."""
        self.assertEqual(size(0.50, 0.05).notional, 0.0)

    def test_at_and_above_the_floor_it_sizes(self):
        self.assertNotEqual(size(0.50, 0.10).refusal, "price_below_sizing_floor")

    def test_the_floor_is_separate_from_inclusion(self):
        """YES_PRICE_MIN is 0.01 and governs which markets are scanned. This
        floor is 0.10 and governs which can be sized. A market between them is
        scanned and reported, and refused only for sizing."""
        s = size(0.50, 0.05)
        self.assertEqual(s.refusal, "price_below_sizing_floor")
        self.assertGreater(s.edge, 0, "it still has a real edge, it is reported")


class NoSideTest(unittest.TestCase):
    """Sizing the NO side, which the old abs(edge) hack got wrong."""

    def test_side_price_is_complemented(self):
        self.assertAlmostEqual(side_price_for("NO", 0.30), 0.70)
        self.assertAlmostEqual(side_price_for("YES", 0.30), 0.30)

    def test_no_side_uses_complemented_probability_and_price(self):
        """Buying NO at 0.70 believing 0.80 is the same Kelly problem as
        buying YES at 0.70 believing 0.80."""
        no = size(0.20, 0.30, direction="NO")     # p(NO)=0.80, price(NO)=0.70
        yes = size(0.80, 0.70, direction="YES")
        self.assertAlmostEqual(no.kelly_fraction, yes.kelly_fraction, places=12)
        self.assertAlmostEqual(no.notional, yes.notional, places=9)

    def test_no_side_with_no_edge_is_refused(self):
        self.assertEqual(size(0.80, 0.30, direction="NO").refusal, "no_positive_edge")

    def test_fee_uses_the_side_actually_bought(self):
        self.assertAlmostEqual(fee_ratio(0.70), FEE_RATE * 0.30, places=12)


if __name__ == "__main__":
    unittest.main()
