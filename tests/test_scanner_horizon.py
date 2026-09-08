"""Tests for the scanner's horizon arithmetic and tradeable-horizon refusal.

src/trade_engine/scanner.py had no test file at all before this one, which is
how PolymarketScanner._horizon_days shipped a math.ceil that rounded a
3,558-second market up to a full day and priced position e09b82fe into a
maximum-size loss.

Two separate things are covered:

  * _horizon_days now returns exact fractional days, and the guards downstream
    of it are UNCHANGED by that (they were equivalent under ceil, and the tests
    assert the equivalence rather than assuming it).
  * MIN_HORIZON_TRADEABLE_DAYS is a hard refusal, enforced here before the
    market is ever simulated. TradeExecutor GATE 7 enforces the same floor
    independently, see tests/test_executor.py.

No network: analyse_edge is driven with hand-built Gamma market dicts.

Run:
    python3 -m unittest tests/test_scanner_horizon.py
"""

import asyncio
import math
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

for _key in (
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY",
    "TELEGRAM_BOT_TOKEN", "OWNER_TELEGRAM_CHAT_ID",
    "POLYMARKET_PRIVATE_KEY", "POLYMARKET_FUNDER_ADDRESS",
):
    os.environ.setdefault(_key, f"test-{_key.lower()}")

from src.trade_engine.config import (  # noqa: E402
    DEFAULT_MIN_HORIZON_TRADEABLE_DAYS,
    Config,
    config,
)
from src.trade_engine.horizon import horizon_days  # noqa: E402
from src.trade_engine.models import (  # noqa: E402
    AnalystRecommendation,
    ScannerCandidate,
    ScannerRunSummary,
)
from src.trade_engine.scanner import (  # noqa: E402
    DEFAULT_HORIZON_DAYS,
    HORIZON_MAX_DAYS,
    PolymarketScanner,
)

NOW = datetime(2026, 8, 31, 15, 0, 42, 96934, tzinfo=timezone.utc)
E09B82FE_END = "2026-08-31T16:00:00Z"     # 3,557.903 seconds after NOW
E09B82FE_HORIZON = 0.04117943363425926    # exactly 3557.903066 / 86400


def run(coro):
    return asyncio.run(coro)


def make_market(end_date, **overrides):
    """A Gamma market dict that clears every filter except the one under test.

    btc so the weekend filter never applies (crypto trades at weekends), volume
    and yes_price comfortably inside their bands, target above the btc price
    floor of 10,000.
    """
    market = {
        "id": "3257355",
        "conditionId": "0x" + "ab" * 32,
        "slug": "bitcoin-above-60000",
        "question": "Will Bitcoin reach $60,000 in September?",
        "description": "",
        "endDate": end_date,
        "outcomePrices": '["0.50", "0.50"]',
        "volume": "279582.74",
        "event_slug": "what-price-will-bitcoin-hit",
    }
    market.update(overrides)
    return market


class HorizonDaysTest(unittest.TestCase):
    """_horizon_days returns exact fractional days."""

    def test_the_e09b82fe_horizon_is_not_rounded_up(self):
        """The bug, stated as a test: 3,558 seconds is not one day."""
        horizon = PolymarketScanner._horizon_days(E09B82FE_END, NOW)
        self.assertAlmostEqual(horizon, E09B82FE_HORIZON, places=9)
        self.assertNotEqual(horizon, 1)
        self.assertLess(horizon, 0.05)

    def test_returns_a_float(self):
        horizon = PolymarketScanner._horizon_days(E09B82FE_END, NOW)
        self.assertIsInstance(horizon, float)

    def test_fractional_multi_day_horizons_are_exact(self):
        """The four historical touch_* positions were all rounded up too, by
        0.33 to 0.67 days. Values taken from their persisted simulation rows."""
        cases = [
            # simulation row, scan time, exact horizon, what ceil() used
            ("cee4eacd", datetime(2026, 8, 11, 14, 0, 37, 831454,
                                  tzinfo=timezone.utc), 20.58289546928241, 21),
            ("d0892076", datetime(2026, 8, 11, 20, 0, 29, 266616,
                                  tzinfo=timezone.utc), 20.33299459935185, 21),
            ("d23ba1d9", datetime(2026, 8, 20, 18, 1, 0, 531793,
                                  tzinfo=timezone.utc), 11.415966067210649, 12),
            ("d9905812", datetime(2026, 8, 27, 12, 0, 45, 952146,
                                  tzinfo=timezone.utc), 4.666134813125, 5),
        ]
        for sim_id, now, expected, old in cases:
            with self.subTest(simulation=sim_id):
                horizon = PolymarketScanner._horizon_days(
                    "2026-09-01T04:00:00Z", now
                )
                self.assertAlmostEqual(horizon, expected, places=9)
                self.assertEqual(math.ceil(horizon), old)
                self.assertLess(horizon, old)

    def test_absent_end_date_defaults_to_a_float(self):
        for absent in (None, ""):
            with self.subTest(end_date=absent):
                horizon = PolymarketScanner._horizon_days(absent, NOW)
                self.assertEqual(horizon, DEFAULT_HORIZON_DAYS)
                self.assertIsInstance(horizon, float)

    def test_unparseable_end_date_defaults_to_a_float(self):
        horizon = PolymarketScanner._horizon_days("not-a-date", NOW)
        self.assertEqual(horizon, DEFAULT_HORIZON_DAYS)
        self.assertIsInstance(horizon, float)

    def test_naive_timestamps_are_treated_as_utc(self):
        aware = PolymarketScanner._horizon_days("2026-08-31T16:00:00Z", NOW)
        naive = PolymarketScanner._horizon_days("2026-08-31T16:00:00", NOW)
        self.assertAlmostEqual(aware, naive, places=9)

    def test_a_past_end_date_is_negative(self):
        """Feeds the `horizon_days <= 0` rejection below."""
        self.assertLess(PolymarketScanner._horizon_days("2026-08-30T16:00:00Z", NOW), 0)


class GuardEquivalenceTest(unittest.TestCase):
    """The two downstream guards are UNCHANGED by the fractional horizon.

    ceil(T) <= 0 iff T <= 0, and ceil(T) <= 35 iff T <= 35. Asserting the
    equivalence directly is what justifies leaving those guards alone: it
    proves the fix changes only the VALUE passed downstream, not which markets
    survive filtering.
    """

    def test_zero_guard_is_equivalent_under_ceil(self):
        for t in (-5.0, -1.0, -0.5, -1e-9, 0.0, 1e-9, 0.0412, 0.5, 1.0, 2.5):
            with self.subTest(t=t):
                self.assertEqual(t <= 0, math.ceil(t) <= 0)

    def test_max_days_guard_is_equivalent_under_ceil(self):
        for t in (0.5, 1.0, 34.0, 34.2, 34.999, 35.0, 35.0001, 35.4, 36.0, 40.0):
            with self.subTest(t=t):
                self.assertEqual(
                    t > HORIZON_MAX_DAYS, math.ceil(t) > HORIZON_MAX_DAYS
                )

    def test_lookback_selector_is_equivalent_under_ceil(self):
        """monte_carlo picks a 21d vol window when horizon <= 35."""
        for t in (0.0412, 1.0, 34.9, 35.0, 35.1, 90.0):
            with self.subTest(t=t):
                self.assertEqual(t <= 35, math.ceil(t) <= 35)


class TradeableFloorTest(unittest.TestCase):
    """MIN_HORIZON_TRADEABLE_DAYS: a refusal, not a penalty."""

    def analyse(self, *markets):
        scanner = PolymarketScanner()
        return run(scanner.analyse_edge(list(markets)))

    def end_in(self, **delta):
        return (datetime.now(timezone.utc) + timedelta(**delta)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )

    def test_default_floor_is_one_day(self):
        self.assertEqual(DEFAULT_MIN_HORIZON_TRADEABLE_DAYS, 1.0)
        self.assertEqual(config.min_horizon_tradeable_days, 1.0)

    def test_a_sub_day_market_is_refused(self):
        """A 59-minute market, e09b82fe's shape, never reaches the simulator."""
        selected = self.analyse(make_market(self.end_in(seconds=3558)))
        self.assertEqual(selected, [])

    def test_refused_across_the_sub_day_range(self):
        for seconds in (60, 3558, 3600 * 6, 3600 * 23):
            with self.subTest(seconds=seconds):
                self.assertEqual(self.analyse(make_market(self.end_in(seconds=seconds))), [])

    def test_a_market_above_the_floor_survives(self):
        """The floor refuses SHORT markets, not fractional ones."""
        selected = self.analyse(make_market(self.end_in(days=20, hours=13)))
        self.assertEqual(len(selected), 1)
        self.assertAlmostEqual(selected[0]["horizon_days"], 20.54, delta=0.02)

    def test_the_surviving_horizon_is_fractional_not_rounded(self):
        selected = self.analyse(make_market(self.end_in(days=4, hours=16)))
        self.assertEqual(len(selected), 1)
        horizon = selected[0]["horizon_days"]
        self.assertNotEqual(horizon, math.ceil(horizon))
        self.assertAlmostEqual(horizon, 4.666, delta=0.01)

    def test_refusal_is_independent_of_edge(self):
        """No simulation has run at the point of refusal, so no edge exists yet.

        This is what makes the floor a second, independent control rather than
        a restatement of the edge threshold: analyse_edge drops the market
        before run_simulations is ever called.
        """
        selected = self.analyse(make_market(self.end_in(seconds=3558)))
        self.assertEqual(selected, [])
        # And the market is otherwise perfectly valid, same dict, longer clock.
        self.assertEqual(len(self.analyse(make_market(self.end_in(days=10)))), 1)

    def test_env_can_raise_the_floor_but_never_lower_it(self):
        """A typo or an over-eager override must not re-open the sub-day path."""
        saved = os.environ.get("MIN_HORIZON_TRADEABLE_DAYS")
        try:
            for attempt in ("0", "0.0", "-5", "0.5", "0.041"):
                with self.subTest(value=attempt):
                    os.environ["MIN_HORIZON_TRADEABLE_DAYS"] = attempt
                    self.assertEqual(Config().min_horizon_tradeable_days, 1.0)
            os.environ["MIN_HORIZON_TRADEABLE_DAYS"] = "3"
            self.assertEqual(Config().min_horizon_tradeable_days, 3.0)
        finally:
            if saved is None:
                os.environ.pop("MIN_HORIZON_TRADEABLE_DAYS", None)
            else:
                os.environ["MIN_HORIZON_TRADEABLE_DAYS"] = saved


class CandidateCarriesEndDateTest(unittest.TestCase):
    """The scanner must hand the executor what GATE 7 needs to recompute.

    GATE 7 fails closed on a missing end_date, so if _to_candidate stopped
    carrying it the result would not be a wrong trade, it would be EVERY trade
    refused: a total outage that looks like a working safety gate. Nothing
    tested this until a mutant removing the field survived the whole suite.
    """

    def test_to_candidate_carries_end_date_from_the_scanner_row(self):
        end_date = "2026-09-30T04:00:00Z"
        row = {
            "market_id": "3257355",
            "condition_id": "0x" + "ab" * 32,
            "slug": "bitcoin-above-60000",
            "question": "Will Bitcoin reach $60,000 in September?",
            "asset": "btc",
            "yes_price": 0.42,
            "volume": 279582.74,
            "horizon_days": 20.333,
            "end_date": end_date,
        }
        candidate = PolymarketScanner._to_candidate(row, 0.14, 0.56)
        self.assertEqual(candidate.end_date, end_date)

    def test_the_pipeline_produces_a_candidate_the_executor_can_gate(self):
        """End to end through analyse_edge, so the field survives the real path."""
        end_date = (datetime.now(timezone.utc) + timedelta(days=10)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        selected = run(PolymarketScanner().analyse_edge([make_market(end_date)]))
        self.assertEqual(len(selected), 1)
        candidate = PolymarketScanner._to_candidate(selected[0], 0.14, 0.56)
        self.assertEqual(candidate.end_date, end_date)
        # And it is parseable by the same helper GATE 7 uses.
        self.assertIsNotNone(
            horizon_days(candidate.end_date, datetime.now(timezone.utc))
        )


class ReduceNeverIncreasesTest(unittest.TestCase):
    """The Analyst's REDUCE must reduce.

    It was max(AMOUNT_MIN_USDC, before / 2) with a $3 floor. On a $1.23 Kelly
    position that returns $3.00: a 2.4x INCREASE, on the exact path where the
    Analyst has just said it is less confident. A safety inversion, invisible
    while the old ramp never sized below $3, and live the moment Kelly does.
    """

    def summary_with(self, amount, price=0.40, minimum=5.0):
        candidate = ScannerCandidate(
            market_id="1", condition_id="0x" + "ab" * 32, question="q",
            asset="btc", direction="YES", edge=0.20, sim_probability=0.60,
            market_probability=price, volume=50000.0, horizon_days=5.0,
            market_url="", amount_usdc=amount, min_order_size=minimum,
        )
        summary = ScannerRunSummary(
            run_at=datetime.now(timezone.utc), markets_fetched=1,
            candidates_analysed=1, simulations_run=1, sim_errors=0,
        )
        summary.best_trade = candidate
        summary.analyst_recommendation = AnalystRecommendation(
            recommendation="reduce", confidence=0.4, reasoning="thin", flags=[],
        )
        return summary

    def reduce_to(self, amount, **kw):
        summary = self.summary_with(amount, **kw)
        scanner = PolymarketScanner(analyst=_StubAnalyst(summary.analyst_recommendation))
        run(scanner.apply_analyst(summary))
        return summary.best_trade.amount_usdc

    def test_reduce_never_increases_at_any_size(self):
        """The property, across the whole range including sub-$3 Kelly sizes."""
        for before in (0.25, 0.5, 1.23, 2.99, 3.0, 5.0, 10.0):
            with self.subTest(before=before):
                after = self.reduce_to(before)
                self.assertLess(after, before, "REDUCE must reduce")
                self.assertAlmostEqual(after, before / 2, places=6)

    def test_the_old_floor_would_have_tripled_a_kelly_position(self):
        """Pins the specific defect rather than only the general property."""
        self.assertLess(self.reduce_to(1.23), 1.23)
        self.assertAlmostEqual(self.reduce_to(1.23), 0.615, places=6)

    def test_reducing_under_the_exchange_minimum_marks_it_unsizeable(self):
        """Halving can make a position unplaceable. That is a refusal, not a
        smaller trade, and nobody should be asked to approve it."""
        # $3.00 at price 0.40 is 7.5 shares, comfortably over. Halved it is
        # $1.50, or 3.75 shares, which the exchange would reject.
        summary = self.summary_with(3.0, price=0.40, minimum=5.0)
        scanner = PolymarketScanner(analyst=_StubAnalyst(summary.analyst_recommendation))
        run(scanner.apply_analyst(summary))
        self.assertEqual(summary.best_trade.amount_usdc, 1.5)
        self.assertEqual(summary.best_trade.sizing_refusal, "below_exchange_minimum")

    def test_a_reduction_that_still_clears_the_minimum_is_not_marked(self):
        """Exactly at the minimum is admitted, matching GATE 8's comparison.
        $4.00 at 0.40 halves to $2.00, which is exactly 5 shares."""
        summary = self.summary_with(4.0, price=0.40, minimum=5.0)
        scanner = PolymarketScanner(analyst=_StubAnalyst(summary.analyst_recommendation))
        run(scanner.apply_analyst(summary))
        self.assertEqual(summary.best_trade.amount_usdc, 2.0)
        self.assertIsNone(summary.best_trade.sizing_refusal)


class SelectSkipsUnsizeableTest(unittest.TestCase):
    """best_trade must never be a candidate that cannot be sized.

    A mutant removing this filter survived the entire suite: nothing asserted
    that an unsizeable candidate stays out of best_trade, only that sizing
    refuses. GATE 8 would catch it at execution, but by then a human has been
    asked to approve a trade the exchange will reject.
    """

    def candidate(self, market_id, edge, refusal=None):
        return ScannerCandidate(
            market_id=market_id, condition_id="0x" + "cd" * 32, question="q",
            asset="btc", direction="YES", edge=edge, sim_probability=0.60,
            market_probability=0.40, volume=50000.0, horizon_days=5.0,
            market_url="", amount_usdc=2.0, min_order_size=5.0,
            sizing_refusal=refusal,
        )

    def summary(self, *candidates):
        s = ScannerRunSummary(
            run_at=datetime.now(timezone.utc), markets_fetched=1,
            candidates_analysed=len(candidates), simulations_run=len(candidates),
            sim_errors=0,
        )
        s.high_edge = list(candidates)
        return s

    def test_the_widest_edge_is_skipped_when_it_cannot_be_sized(self):
        """The unsizeable one has the BIGGEST edge, so a filter that is absent
        picks it. That is what makes this test able to fail."""
        summary = self.summary(
            self.candidate("big", 0.40, refusal="below_exchange_minimum"),
            self.candidate("small", 0.12),
        )
        best = PolymarketScanner().select_best_trade(summary)
        self.assertIsNotNone(best)
        self.assertEqual(best.market_id, "small")

    def test_none_sizeable_means_no_trade(self):
        summary = self.summary(
            self.candidate("a", 0.40, refusal="below_exchange_minimum"),
            self.candidate("b", 0.30, refusal="price_below_sizing_floor"),
        )
        self.assertIsNone(PolymarketScanner().select_best_trade(summary))

    def test_unsizeable_candidates_are_still_REPORTED(self):
        """They stay in the bucket. The refusal is the measurement."""
        summary = self.summary(
            self.candidate("a", 0.40, refusal="below_exchange_minimum"),
        )
        PolymarketScanner().select_best_trade(summary)
        self.assertEqual(len(summary.high_edge), 1)


class _StubAnalyst:
    def __init__(self, recommendation):
        self._recommendation = recommendation

    async def analyse(self, candidate):
        return self._recommendation


class CandidateModelTest(unittest.TestCase):
    """ScannerCandidate.horizon_days must accept a fractional value.

    Left as int, pydantic v2 raises int_from_float and _to_candidate takes down
    the entire scan rather than one market, because it runs for every high-edge
    AND no-edge row.
    """

    def make(self, horizon):
        return ScannerCandidate(
            market_id="3257355", condition_id="0x" + "ab" * 32,
            question="Will Bitcoin reach $60,000 in September?", asset="btc",
            direction="YES", edge=0.14, sim_probability=0.56,
            market_probability=0.42, volume=279582.74, horizon_days=horizon,
            market_url="https://polymarket.com/market/x", amount_usdc=9.5,
        )

    def test_accepts_a_fractional_horizon(self):
        for horizon in (E09B82FE_HORIZON, 4.666135, 20.582884, 1.0, 30.0):
            with self.subTest(horizon=horizon):
                self.assertAlmostEqual(
                    self.make(horizon).horizon_days, horizon, places=9
                )

    def test_an_int_horizon_still_validates(self):
        """Persisted approvals written before this change must still load."""
        self.assertEqual(self.make(21).horizon_days, 21.0)


if __name__ == "__main__":
    unittest.main()
