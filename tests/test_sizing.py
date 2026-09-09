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
    maker_amount,
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

# The most the cent floor can take off a notional: maker_amount iterates to the
# fixed point of the client's floor, and consecutive whole-cent values can all
# be float hazards (1.13 through 1.16 are), so the drop can exceed one cent.
# MakerAmountTest measures the real worst case over every cent up to $25.
MAX_FLOOR_DROP = 0.06


def size(p, price, direction="YES", minimum=MIN_SHARES, **over):
    kw = dict(LIVE)
    kw.update(over)
    return size_position(
        sim_probability=p, yes_price=price, direction=direction,
        min_order_size=minimum, **kw,
    )


def assert_debit_fills_the_cap(test, s, cap):
    """The debit is the cap less at most the cent floor: never above it, and
    exactly what the whole-cent notional costs at the fee."""
    test.assertLessEqual(s.debit, cap + 1e-9)
    test.assertEqual(s.notional, maker_amount(cap / (1 + fee_ratio(s.side_price))))
    test.assertEqual(s.debit, round(s.notional * (1 + fee_ratio(s.fill_price)), 6))
    test.assertLess(cap - s.debit, MAX_FLOOR_DROP * (1 + FEE_RATE))


def probability_for_exact_minimum(price, minimum, **over):
    """The smallest p whose whole-cent notional is exactly `minimum * price`."""
    target = minimum * price
    lo, hi = price, 1.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if size(mid, price, minimum=minimum, **over).notional >= target:
            hi = mid
        else:
            lo = mid
    return hi


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


class ParametersAreUsedNotAssumedTest(unittest.TestCase):
    """Every parameter must TRACK its argument, not equal a hardcoded default.

    Two parameters could be discarded entirely and replaced with the shipped
    constant, and the suite stayed green:

        fraction = 0.10 * full_kelly      # kelly_fraction ignored
        if price < 0.10:                  # price_floor ignored

    Invisible because 0.10 IS the live value on both, so every assertion
    comparing against it passes either way. Same shape as a wire-through test
    whose expected value is a literal that also appears at the call site: it
    proves the constant, not that the argument is used.

    The mutants that DO die are the ones substituting an obviously wrong value.
    Those are the easy ones. The survivor is the one that looks right.

    Every test here passes a value that is NOT the default and asserts the
    output moves with it.
    """

    def test_kelly_fraction_is_used(self):
        """Halving the fraction must halve the stake."""
        base = size(0.80, 0.20, kelly_fraction=0.10)
        half = size(0.80, 0.20, kelly_fraction=0.05)
        quarter = size(0.80, 0.20, kelly_fraction=0.025)
        self.assertAlmostEqual(half.kelly_debit, base.kelly_debit / 2, places=9)
        self.assertAlmostEqual(quarter.kelly_debit, base.kelly_debit / 4, places=9)
        # The notional is whole cents at the client's fixed point, so it
        # tracks to within the floor rather than to six places.
        self.assertAlmostEqual(half.notional, base.notional / 2, delta=MAX_FLOOR_DROP)

    def test_kelly_fraction_tracks_across_valid_values(self):
        for fraction in (0.02, 0.05, 0.10, 0.25, 1.0):
            with self.subTest(kelly_fraction=fraction):
                s = size(0.80, 0.20, kelly_fraction=fraction)
                expected = fraction * (0.80 - 0.20) / (1 - 0.20)
                self.assertAlmostEqual(s.kelly_fraction, expected, places=12)

    def test_a_larger_fraction_produces_a_larger_stake(self):
        previous = 0.0
        for fraction in (0.02, 0.05, 0.10, 0.25):
            stake = size(0.80, 0.20, kelly_fraction=fraction).notional
            self.assertGreater(stake, previous)
            previous = stake

    def test_price_floor_is_used(self):
        """A market at 0.15 is refused under a 0.20 floor and sized under 0.10.

        Neither probe is the default, so a hardcoded 0.10 fails the first and a
        hardcoded 0.20 fails the second.
        """
        under = size(0.60, 0.15, price_floor=0.20)
        self.assertEqual(under.refusal, "price_below_sizing_floor")
        over = size(0.60, 0.15, price_floor=0.10)
        self.assertNotEqual(over.refusal, "price_below_sizing_floor")

    def test_price_floor_tracks_across_valid_values(self):
        price = 0.25
        for floor, refused in ((0.05, False), (0.20, False),
                               (0.30, True), (0.50, True)):
            with self.subTest(price_floor=floor):
                s = size(0.80, price, price_floor=floor)
                self.assertEqual(
                    s.refusal == "price_below_sizing_floor", refused,
                    f"floor {floor} against price {price}",
                )

    def test_bankroll_is_used(self):
        base = size(0.80, 0.20, bankroll=25.0)
        half = size(0.80, 0.20, bankroll=12.5)
        self.assertAlmostEqual(half.kelly_debit, base.kelly_debit / 2, places=9)

    def test_min_order_size_is_used(self):
        """Already covered by the exchange-minimum tests, asserted here as a
        parameter so all four sit together and none can regress alone."""
        for minimum in (1.0, 7.5, 50.0):
            with self.subTest(min_order_size=minimum):
                s = size(0.80, 0.20, minimum=minimum)
                self.assertEqual(s.required_shares, minimum)
                self.assertAlmostEqual(s.min_notional, minimum * 0.20, places=12)

    def test_the_ceilings_are_used(self):
        for ceiling in (1.0, 6.0, 13.5):
            with self.subTest(max_position_usdc=ceiling):
                s = size(1.0, 0.50, bankroll=10_000.0, max_position_usdc=ceiling)
                assert_debit_fills_the_cap(self, s, ceiling)


class FeeAwareTest(unittest.TestCase):
    """The cap is the DEBIT, not the notional."""

    def test_fee_ratio_matches_the_verified_receipt(self):
        """10.501189 debited against 10.00 notional at price 0.284."""
        self.assertAlmostEqual(1 + fee_ratio(0.284), 10.501189 / 10.0, places=4)

    def test_debit_fills_the_cap_to_the_cent_and_notional_is_below_it(self):
        s = size(1.0, 0.50)  # kelly_debit is the binding cap here
        assert_debit_fills_the_cap(self, s, s.kelly_debit)
        self.assertLess(s.notional, s.debit, "the fee is charged on top")

    def test_sizing_the_notional_to_the_cap_would_overspend(self):
        """What the old code did, stated as a number.

        Sizing the notional to the cap makes the wallet pay cap * (1 + fee),
        which at price 0.10 is 6.3% more than intended, every single trade.
        """
        s = size(1.0, 0.10)
        naive_debit = s.kelly_debit * (1 + fee_ratio(0.10))
        self.assertGreater(naive_debit - s.kelly_debit, 0.15)
        assert_debit_fills_the_cap(self, s, s.kelly_debit)

    def test_shares_are_derived_from_the_notional_actually_sent(self):
        """Not from an unrounded intermediate, and not from a 6dp figure.

        The relay hands amount_usdc to py-clob-client-v2, which submits
        round_down(amount, 2) / marginal_ask. So the notional is whole cents,
        at the fixed point of that floor (a value the client's floor leaves
        unchanged), and shares and debit are derived from it. An earlier
        version of this test asserted a 6dp rounding and said the exchange
        divided that by price; it does not, and sizing at 6dp produced sub-cent
        notionals whose share count was systematically above the one the
        exchange computed. At the boundary that is the difference between a
        clean refusal and an order rejected after a human approved it.
        """
        for p_true, price in ((0.90, 0.20), (0.35, 0.10), (0.60, 0.40)):
            with self.subTest(price=price):
                s = size(p_true, price)
                self.assertEqual(s.notional, math.floor(s.notional * 100.0) / 100.0,
                                 "a fixed point of the client's floor")
                self.assertEqual(s.notional, maker_amount(s.notional))
                self.assertAlmostEqual(s.shares, s.notional / price, places=12)
                self.assertEqual(
                    s.debit, round(s.notional * (1 + fee_ratio(price)), 6),
                    "debit must follow the whole-cent notional, not an intermediate",
                )


class CeilingTest(unittest.TestCase):
    """Kelly only ever sizes DOWN. The ceiling sits above it."""

    def test_ceiling_binds_and_is_recorded(self):
        s = size(1.0, 0.50, bankroll=10_000.0)
        self.assertEqual(s.clamped_by, "max_position_usdc")
        assert_debit_fills_the_cap(self, s, LIVE["max_position_usdc"])

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

    def test_refusal_carries_the_arithmetic_BY_VALUE(self):
        """A refusal is a measurement. Item (c) needs these numbers.

        Asserting the LABELS is not asserting the numbers. An earlier version
        of this test checked `assertIn("price=", ...)` and friends, which are
        substrings of the implementation's own f-string, so every value in the
        line could be zeroed and the suite stayed green. The whole log could be
        emptied to bare labels and nothing noticed.

        That is the same defect as a wire-through test comparing against a
        literal: it proves the format string, not the data. This log IS the
        deliverable of the sizing decision, so every field is pinned to its
        own value here.
        """
        # minimum=12.0 on one fixture, deliberately NOT the shipped 5. Both
        # fixtures previously used 5, so `required_shares={5.0:.4f}` (the value
        # hardcoded) matched them and survived. A fixture that agrees with the
        # plausible hardcode cannot tell it from the real thing, which is the
        # same reason the per-market minimum needs a non-default probe.
        for s in (size(0.6149, 0.279, minimum=12.0),          # refused, unclamped
                  size(1.0, 0.50, bankroll=10_000.0)):        # tradeable, clamped
            with self.subTest(clamped=s.clamped_by):
                self.assert_every_field_pinned(s)

    def assert_every_field_pinned(self, s):
        line = s.log_fields()
        for label, value in (
            ("price", f"{s.side_price:.4f}"),
            ("fill_price", f"{s.fill_price:.4f}"),
            ("edge", f"{s.edge:+.4f}"),
            ("kelly_f", f"{s.kelly_fraction:.5f}"),
            ("kelly_debit", f"{s.kelly_debit:.4f}"),
            ("sized_notional", f"{s.notional:.4f}"),
            ("debit", f"{s.debit:.4f}"),
            ("shares", f"{s.shares:.4f}"),
            ("required_shares", f"{s.required_shares:.4f}"),
            ("min_notional", f"{s.min_notional:.4f}"),
            ("min_debit", f"{s.min_debit:.4f}"),
        ):
            with self.subTest(field=label):
                self.assertIn(f"{label}={value}", line)
        self.assertGreater(s.notional, 0, "the computed size is still reported")

    def test_every_logged_number_is_distinct_so_a_swap_is_visible(self):
        """Pinning values only helps if the values differ.

        If two fields happen to be equal, printing one under the other's label
        passes. This picks a case where price, edge, notional, debit, shares and
        the two minima are all different, so any swap shows.
        """
        s = size(0.6149, 0.279, minimum=12.0)
        # kelly_debit is EXCLUDED here: when nothing clamps it equals debit by
        # construction, which is the "cap IS the debit" invariant rather than a
        # coincidence. The clamped fixture in the test above is what
        # distinguishes those two, and it is why the value pinning runs over
        # both a clamped and an unclamped case.
        values = [s.side_price, s.edge, s.kelly_fraction, s.notional, s.debit,
                  s.shares, s.required_shares, s.min_notional, s.min_debit]
        rounded = [round(v, 4) for v in values]
        self.assertEqual(len(set(rounded)), len(rounded),
                         f"fixture makes a swap invisible: {rounded}")

        clamped = size(1.0, 0.50, bankroll=10_000.0)
        self.assertNotAlmostEqual(
            clamped.kelly_debit, clamped.debit, places=2,
            msg="the clamped fixture must separate kelly_debit from debit",
        )

        # fill_price equals side_price whenever no fill is given, so a swap
        # between the two labels is invisible at the fixtures above. A fixture
        # WITH a fill price separates them, and both must print as themselves.
        filled = size(0.6149, 0.279, minimum=12.0, fill_price=0.30)
        self.assertNotAlmostEqual(filled.fill_price, filled.side_price, places=4)
        self.assertIn("price=0.2790 fill_price=0.3000", filled.log_fields())

    def test_the_log_does_not_call_the_sized_notional_a_kelly_notional(self):
        """The label used to name the wrong quantity.

        kelly_debit is the PRE-clamp ask; the sized notional is what survives
        any clamp. They differ whenever clamped_by is set, and a log that calls
        one by the other's name misreports exactly the case worth reading.
        """
        s = size(1.0, 0.50, bankroll=10_000.0)
        self.assertEqual(s.clamped_by, "max_position_usdc")
        line = s.log_fields()
        self.assertNotIn("kelly_notional=", line)
        self.assertIn(f"kelly_debit={s.kelly_debit:.4f}", line)
        self.assertIn("clamped_by=max_position_usdc", line)
        # THE POINT: sized_notional must carry the notional, not the pre-clamp
        # ask. This test was named for that defect and did not detect it,
        # because it never asserted what sized_notional actually prints.
        self.assertIn(f"sized_notional={s.notional:.4f}", line)
        self.assertNotIn(f"sized_notional={s.kelly_debit:.4f}", line)
        self.assertNotAlmostEqual(s.kelly_debit, s.notional, places=2)
        self.assertNotAlmostEqual(s.kelly_debit, s.notional, places=2)

    def test_the_two_minima_are_exact(self):
        """min_notional and min_debit are what the caller needs to know how far
        short it fell. Pinned exactly: min_notional was only ever asserted from
        BELOW (doubling it strengthened the assertion), and min_debit was never
        asserted at any value, so dropping its fee term survived."""
        for p, price, minimum in ((0.6149, 0.279, 5.0), (0.35, 0.10, 12.0)):
            with self.subTest(price=price, minimum=minimum):
                s = size(p, price, minimum=minimum)
                self.assertAlmostEqual(s.min_notional, minimum * price, places=12)
                self.assertAlmostEqual(
                    s.min_debit, minimum * price * (1 + fee_ratio(price)),
                    places=12,
                )
                self.assertGreater(
                    s.min_debit, s.min_notional,
                    "min_debit must include the fee, or it is min_notional",
                )

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


class BoundaryTest(unittest.TestCase):
    """The comparison against the exchange minimum, pinned on BOTH sides.

    Mutants moving it either way survived the suite: `<=` instead of `<`, and
    admitting 1% under. Nothing sat at the boundary, and the boundary is the
    entire question this code exists to answer.
    """

    def shares_for(self, notional, price):
        return notional / price

    def test_exactly_the_minimum_is_admitted(self):
        """5.000000 shares trades. GATE 8 uses the same comparison."""
        price, minimum = 0.20, 5.0
        # Choose p so the sized notional lands exactly on 5 shares.
        target_notional = minimum * price
        lo, hi = price, 1.0
        for _ in range(200):
            mid = (lo + hi) / 2
            if size(mid, price).notional >= target_notional:
                hi = mid
            else:
                lo = mid
        s = size(hi, price)
        self.assertGreaterEqual(s.shares, minimum)
        self.assertTrue(s.tradeable, s.log_fields())

    def test_a_hair_under_the_minimum_is_refused(self):
        """Kills `shares <= required` and any epsilon slack.

        The notional moves in whole cents now, so a hair cannot be produced
        through p: the nearest step below 5.000 shares at price 0.20 is 4.95.
        The fill price is continuous, so the hair is produced there: exactly
        $1.00 against an ask one part in a million above the quote.
        """
        price, minimum = 0.20, 5.0
        p = probability_for_exact_minimum(price, minimum)
        exact = size(p, price)
        self.assertAlmostEqual(exact.shares, minimum, places=9, msg="pick the exact case")
        just_under = size(p, price, fill_price=price * (1 + 1e-6))
        self.assertLess(just_under.shares, minimum)
        self.assertFalse(just_under.tradeable, just_under.log_fields())
        self.assertGreater(just_under.shares, minimum * 0.9999,
                           "must be a HAIR under, or it proves nothing")

    def test_one_percent_under_is_refused(self):
        """Kills `shares < required * 0.99`, which survived the whole suite.

        Two probes. The notional moves in whole cents, so the largest notional
        under $1.00 at the quote is $0.99, which is exactly 1% under; and the
        fill price is continuous, so 0.5% and 0.1% under are produced there.
        """
        price, minimum = 0.20, 5.0
        p = probability_for_exact_minimum(price, minimum)
        one_cent_under = size(p, price, bankroll=LIVE["bankroll"] * 0.995)
        self.assertEqual(one_cent_under.notional, 0.99, "the step below $1.00")
        self.assertLess(one_cent_under.shares, minimum)
        self.assertFalse(one_cent_under.tradeable, one_cent_under.log_fields())
        for fraction in (0.99, 0.995, 0.999):
            with self.subTest(fraction=fraction):
                s = size(p, price, fill_price=price / fraction)
                # Unconditional. Wrapping the assertion in `if s.shares <
                # minimum` made it pass vacuously for any mutant that lifted
                # shares above the floor, which is the mutant class it exists
                # to catch.
                self.assertLess(s.shares, minimum, "probe landed above the floor")
                self.assertAlmostEqual(s.shares, minimum * fraction, places=9)
                self.assertFalse(s.tradeable, s.log_fields())


class ProbabilityRangeTest(unittest.TestCase):
    """The headline result depends on p <= 1, so p is range-checked.

    Measured before this existed: p = 1.05 at price 0.98 returned a TRADEABLE
    $8.74 notional, inside the region this module calls impossible. The old
    linear ramp clamped every input to $10; Kelly is linear in the edge, so the
    same unit slip now runs to the ceiling.
    """

    def test_a_probability_above_one_is_refused(self):
        for p in (1.0000001, 1.04, 1.05, 70.0):
            with self.subTest(p=p):
                s = size(p, 0.40)
                self.assertFalse(s.tradeable)
                self.assertEqual(s.refusal, "invalid_probability")

    def test_it_cannot_reopen_the_impossible_region(self):
        """The specific measured case."""
        s = size(1.05, 0.98)
        self.assertFalse(s.tradeable)
        self.assertEqual(s.notional, 0.0)

    def test_a_negative_probability_is_refused(self):
        self.assertEqual(size(-0.1, 0.40).refusal, "invalid_probability")

    def test_the_valid_endpoints_are_still_accepted(self):
        for p in (0.0, 1.0):
            with self.subTest(p=p):
                self.assertNotEqual(size(p, 0.40).refusal, "invalid_probability")

    def test_a_bad_kelly_fraction_is_named_correctly(self):
        """It used to produce a NEGATIVE notional refused as
        below_exchange_minimum, mislabelling a bad input as a small trade in
        the very logs decision (c) is mined from."""
        for fraction in (-0.10, 0.0, float("nan")):
            with self.subTest(fraction=fraction):
                s = size(0.60, 0.40, kelly_fraction=fraction)
                self.assertEqual(s.refusal, "invalid_kelly_fraction")
                self.assertGreaterEqual(s.notional, 0.0)


class EnforcedCeilingTest(unittest.TestCase):
    """Size against the ceiling the executor enforces FIRST."""

    def test_the_configured_ceiling_binds_before_the_hard_one(self):
        s = size(1.0, 0.50, bankroll=10_000.0,
                 max_position_usdc=10.0, absolute_max_usdc=25.0)
        assert_debit_fills_the_cap(self, s, 10.0)
        self.assertEqual(s.clamped_by, "max_position_usdc")

    def test_the_hard_ceiling_binds_when_it_is_the_lower(self):
        s = size(1.0, 0.50, bankroll=10_000.0,
                 max_position_usdc=100.0, absolute_max_usdc=25.0)
        assert_debit_fills_the_cap(self, s, 25.0)
        self.assertEqual(s.clamped_by, "absolute_max_position_usdc")

    def test_it_never_proposes_above_what_gate_5_enforces(self):
        """A $12 proposal against a $10 configured cap would be refused after
        approval, putting a figure in front of a human the system will not
        honour."""
        s = size(1.0, 0.30, bankroll=10_000.0,
                 max_position_usdc=10.0, absolute_max_usdc=25.0)
        self.assertLessEqual(s.debit, 10.0)


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


class MakerAmountTest(unittest.TestCase):
    """maker_amount mirrors py-clob-client-v2 1.1.0's round_down(amount, 2), to
    its fixed point. Read from the wheel, not assumed: floor(x * 100) / 100 in
    IEEE doubles, applied once by the client to whatever it is sent."""

    def test_every_cent_value_is_a_fixed_point_of_the_clients_floor(self):
        """The property. For every whole-cent value up to $25, the result is
        left unchanged by the client's floor, never exceeds the input, and the
        float hazard costs a bounded number of cents."""
        worst, hazards = 0.0, 0
        for cents in range(1, 2501):
            x = cents / 100
            m = maker_amount(x)
            self.assertEqual(math.floor(m * 100.0) / 100.0, m, f"{x} -> {m} is not a fixed point")
            self.assertLessEqual(m, x, "never rounds up")
            worst = max(worst, x - m)
            hazards += m != x
        self.assertGreater(hazards, 0, "the hazard is real; some cent values are not fixed points")
        self.assertLess(worst, MAX_FLOOR_DROP, f"worst drop {worst:.4f} exceeds the documented bound")

    def test_the_hazard_values_are_pinned(self):
        """0.29 * 100 is 28.999999999999996 in a double, so the client floors
        0.29 to 0.28, and 0.58 goes to 0.57 and then to 0.56. Pinned so that a
        "simpler" single floor, which would return 0.57 for 0.58, fails."""
        self.assertEqual(maker_amount(0.29), 0.28)
        self.assertEqual(maker_amount(0.58), 0.56)
        self.assertEqual(maker_amount(2.01), 2.00)
        self.assertEqual(maker_amount(0.28), 0.28)
        self.assertEqual(maker_amount(2.00), 2.00)

    def test_sub_cent_amounts_floor_and_never_round_up(self):
        for raw, expected_at_most in ((1.875, 1.87), (2.399232, 2.39), (0.999, 0.99)):
            with self.subTest(raw=raw):
                m = maker_amount(raw)
                self.assertLessEqual(m, expected_at_most)
                self.assertGreater(m, expected_at_most - MAX_FLOOR_DROP)
        self.assertEqual(maker_amount(0.009), 0.0)

    def test_garbage_is_zero_not_an_exception(self):
        for bad in (0.0, -1.0, float("nan"), float("inf")):
            with self.subTest(x=bad):
                self.assertEqual(maker_amount(bad), 0.0)

    def test_sizing_sends_a_fixed_point(self):
        """What is sent survives the client's floor unchanged, so the figure a
        human approves, the figure the relay receives and the figure the client
        submits are one number."""
        for p, price in ((0.90, 0.20), (0.6149, 0.279), (1.0, 0.50), (0.35, 0.10)):
            with self.subTest(p=p, price=price):
                n = size(p, price).notional
                self.assertEqual(math.floor(n * 100.0) / 100.0, n)


class FillPriceTest(unittest.TestCase):
    """The divisor is the price the order FILLS at, when the caller has it.

    Executor GATE 8 divides the whole-cent notional by the marginal ask from
    the live book. Sizing at the quoted price alone was systematically
    optimistic: across 24 live markets on 2026-09-09 the ask ran a median of
    1.8% above the quote, so a candidate sized to exactly the minimum at the
    quote was refused by the gate at every price in the band, after a human
    had been asked to approve it. The scanner now passes the walked fill price
    in, and this class pins what that changes and what it must not.
    """

    def test_shares_divide_by_the_fill_price(self):
        s = size(0.90, 0.20, fill_price=0.25)
        self.assertEqual(s.fill_price, 0.25)
        self.assertAlmostEqual(s.shares, s.notional / 0.25, places=12)
        self.assertNotAlmostEqual(s.shares, s.notional / 0.20, places=6)

    def test_the_notional_does_not_move_with_the_fill_price(self):
        """Kelly is NOT re-run at the fill. The notional is the budget for the
        edge measured at the quote; letting the fill move it would move the
        walk that produced the fill, and the two would chase each other."""
        quoted = size(0.90, 0.20)
        for fill in (0.15, 0.20, 0.25, 0.45):
            with self.subTest(fill=fill):
                s = size(0.90, 0.20, fill_price=fill)
                self.assertEqual(s.notional, quoted.notional)
                self.assertEqual(s.side_price, 0.20)
                self.assertAlmostEqual(s.edge, quoted.edge, places=12)
                self.assertAlmostEqual(s.kelly_debit, quoted.kelly_debit, places=12)

    def test_exactly_the_minimum_at_the_quote_is_refused_at_the_median_ask(self):
        """The defect, stated as a number. Sized to 5.000 shares at a 0.20
        quote; the median live spread puts the ask at 0.2036, which is 4.91
        shares, and the gate refuses that."""
        p = probability_for_exact_minimum(price=0.20, minimum=5.0)
        at_quote = size(p, 0.20)
        self.assertAlmostEqual(at_quote.shares, 5.0, places=9)
        self.assertTrue(at_quote.tradeable)
        at_ask = size(p, 0.20, fill_price=0.2036)
        self.assertLess(at_ask.shares, 5.0)
        self.assertFalse(at_ask.tradeable)
        self.assertEqual(at_ask.refusal, "below_exchange_minimum")

    def test_an_ask_below_the_quote_admits_what_the_quote_refused(self):
        """Measured live 2026-09-09: Gamma 0.265 against a best ask of 0.070.
        A verdict at the quote is wrong in both directions, which is why the
        scanner walks every proposable candidate rather than only the ones the
        quote admits."""
        refused = size(0.6149, 0.279)      # f4be9ee8, historical, refused
        self.assertFalse(refused.tradeable)
        admitted = size(0.6149, 0.279, fill_price=0.07)
        self.assertTrue(admitted.tradeable, admitted.log_fields())
        self.assertEqual(admitted.notional, refused.notional)

    def test_the_minima_and_the_fee_use_the_fill_price(self):
        s = size(0.90, 0.20, minimum=12.0, fill_price=0.25)
        self.assertAlmostEqual(s.min_notional, 12.0 * 0.25, places=12)
        self.assertAlmostEqual(
            s.min_debit, 12.0 * 0.25 * (1 + fee_ratio(0.25)), places=12
        )
        self.assertEqual(s.debit, round(s.notional * (1 + fee_ratio(0.25)), 6))

    def test_an_unusable_fill_price_is_refused_by_name(self):
        for bad in (0.0, 1.0, -0.2, 1.5, float("nan"), float("inf"), "0.25", True):
            with self.subTest(fill_price=bad):
                self.assertEqual(size(0.90, 0.20, fill_price=bad).refusal, "invalid_fill_price")

    def test_absent_means_the_quoted_price_stands_in(self):
        s = size(0.90, 0.20)
        self.assertEqual(s.fill_price, s.side_price)
        self.assertIn("fill_price=0.2000", s.log_fields())


if __name__ == "__main__":
    unittest.main()
