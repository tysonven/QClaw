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
import contextlib
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
from src.trade_engine.database import SupabaseError  # noqa: E402
from src.trade_engine.models import (  # noqa: E402
    AnalystRecommendation,
    ScannerCandidate,
    ScannerRunSummary,
    TradingConfig,
)
import src.trade_engine.scanner as scanner_mod  # noqa: E402
from src.trade_engine.executor import ABSOLUTE_MAX_POSITION_USDC  # noqa: E402
from src.trade_engine.sizing import size_position  # noqa: E402
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
        "orderMinSize": 5,
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


class SizingWireThroughTest(unittest.TestCase):
    """Every value that crosses the module boundary onto the money path.

    ASSERT THAT THE VALUE TRACKS, NEVER THAT IT EQUALS A LITERAL.

    The first version of this class did the latter:

        self.assertEqual(captured["bankroll"], config.bankroll_usdc)
        self.assertEqual(captured["bankroll"], 25.0)

    In the test environment those are the same number, so the first assertion is
    vacuous and the second is satisfied by a call site that HARDCODES 25.0. It
    killed every mutant substituting a value different from the shipped default
    and none substituting the default itself. `min_order_size=5.0` was the worst
    survivor: verbatim the hardcode-a-remote-value pattern four docstrings in
    this module warn against, so a market whose real orderMinSize is 50 would be
    sized tradeable and proposed to a human.

    A test comparing against a constant proves the constant, not the wiring, and
    the gap is invisible precisely when the config value equals its default,
    which is always in a test environment.

    So every test here VARIES the source and asserts the captured value MOVES
    with it. A hardcoded call site fails them all.
    """

    ROW = {
        "market_id": "3257355", "condition_id": "0x" + "ab" * 32,
        "slug": "s", "question": "Will Bitcoin reach $60,000 in September?",
        "asset": "btc", "yes_price": 0.20, "volume": 279582.74,
        "horizon_days": 20.333, "end_date": "2026-09-30T04:00:00Z",
        "min_order_size": 5.0,
    }

    def capture(self, row=None, edge=0.40, probability=0.60, ceiling=10.0):
        captured = {}
        real = scanner_mod.size_position

        def spy(**kwargs):
            captured.update(kwargs)
            return real(**kwargs)

        scanner_mod.size_position = spy
        try:
            candidate = PolymarketScanner._to_candidate(
                dict(row or self.ROW), edge, probability, ceiling
            )
        finally:
            scanner_mod.size_position = real
        return captured, candidate

    @contextlib.contextmanager
    def config_value(self, attribute, value):
        """Move a config attribute and put it back."""
        original = getattr(scanner_mod.config, attribute)
        setattr(scanner_mod.config, attribute, value)
        try:
            yield
        finally:
            setattr(scanner_mod.config, attribute, original)

    def assert_tracks(self, attribute, kwarg, values):
        """The captured kwarg must FOLLOW the config attribute, not match a
        literal. Two distinct non-default values, so a hardcode of either the
        default or one probe still fails."""
        seen = []
        for value in values:
            with self.config_value(attribute, value):
                captured, _ = self.capture()
            self.assertEqual(
                captured[kwarg], value,
                f"{kwarg} did not track config.{attribute}: expected {value}, "
                f"got {captured[kwarg]}. A hardcoded call site looks like this.",
            )
            seen.append(captured[kwarg])
        self.assertEqual(len(set(seen)), len(values), "the value never moved")

    # --- configured values must TRACK config ------------------------------

    def test_bankroll_tracks_config(self):
        self.assert_tracks("bankroll_usdc", "bankroll", [7.5, 19.25])

    def test_kelly_fraction_tracks_config(self):
        self.assert_tracks("kelly_fraction", "kelly_fraction", [0.03, 0.075])

    def test_price_floor_tracks_config(self):
        self.assert_tracks("sizing_price_floor", "price_floor", [0.11, 0.185])

    # --- per-market values must track the ROW, not a constant -------------

    def test_min_order_size_tracks_the_market(self):
        """THE worst survivor. 5 is what every sampled market happens to
        return, so a hardcoded 5.0 is invisible against a fixture that also
        says 5. A market requiring 50 must be sized against 50."""
        for minimum in (1.0, 50.0, 12.5):
            with self.subTest(orderMinSize=minimum):
                captured, candidate = self.capture(
                    row=dict(self.ROW, min_order_size=minimum)
                )
                self.assertEqual(captured["min_order_size"], minimum)
                self.assertEqual(candidate.min_order_size, minimum)

    def test_a_stricter_market_minimum_actually_refuses(self):
        """Tracking is only meaningful if it changes the verdict."""
        loose = self.capture(row=dict(self.ROW, min_order_size=1.0))[1]
        strict = self.capture(row=dict(self.ROW, min_order_size=50.0))[1]
        self.assertIsNone(loose.sizing_refusal)
        self.assertEqual(strict.sizing_refusal, "below_exchange_minimum")

    def test_an_unknown_market_minimum_fails_closed_through_the_caller(self):
        _, candidate = self.capture(row=dict(self.ROW, min_order_size=None))
        self.assertEqual(candidate.sizing_refusal, "unknown_min_order_size")

    def test_price_and_probability_track_their_inputs(self):
        for price, probability in ((0.20, 0.60), (0.33, 0.81), (0.47, 0.99)):
            with self.subTest(price=price):
                captured, _ = self.capture(
                    row=dict(self.ROW, yes_price=price), probability=probability
                )
                self.assertEqual(captured["yes_price"], price)
                self.assertEqual(captured["sim_probability"], probability)

    def test_the_ceiling_tracks_the_argument(self):
        for ceiling in (4.0, 9.5, 17.0):
            with self.subTest(ceiling=ceiling):
                captured, _ = self.capture(ceiling=ceiling)
                self.assertEqual(captured["max_position_usdc"], ceiling)
                self.assertEqual(
                    captured["absolute_max_usdc"], ABSOLUTE_MAX_POSITION_USDC
                )

    def test_it_passes_the_direction_it_derived(self):
        for edge, expected in ((0.40, "YES"), (-0.40, "NO")):
            with self.subTest(edge=edge):
                captured, _ = self.capture(edge=edge)
                self.assertEqual(captured["direction"], expected)

    # --- the answer lands in the right field -----------------------------

    def test_amount_usdc_is_the_NOTIONAL_not_the_debit(self):
        """Also asserted across varying config, so it cannot pass by landing on
        a value that happens to match at the default bankroll."""
        # orderMinSize 1.0 so the candidate stays SIZEABLE at both bankrolls;
        # at the shipped minimum of 5 the smaller bankroll refuses and the
        # notional-vs-debit distinction stops being exercised.
        row = dict(self.ROW, min_order_size=1.0)
        for bankroll in (25.0, 12.0):
            with self.subTest(bankroll=bankroll):
                with self.config_value("bankroll_usdc", bankroll):
                    captured, candidate = self.capture(row=row)
                expected = size_position(**captured)
                self.assertTrue(expected.tradeable, "pick a sizeable case")
                self.assertGreater(expected.debit, expected.notional)
                self.assertEqual(candidate.amount_usdc, expected.notional)
                self.assertNotEqual(candidate.amount_usdc, round(expected.debit, 6))

    def test_amount_usdc_moves_when_the_bankroll_moves(self):
        """A hardcoded notional cannot do this."""
        with self.config_value("bankroll_usdc", 25.0):
            big = self.capture()[1].amount_usdc
        with self.config_value("bankroll_usdc", 12.5):
            small = self.capture()[1].amount_usdc
        self.assertAlmostEqual(small, big / 2, places=5)

    def test_the_sizing_refusal_is_recorded_on_the_candidate(self):
        row = dict(self.ROW, yes_price=0.05)
        _, candidate = self.capture(row=row)
        self.assertEqual(candidate.sizing_refusal, "price_below_sizing_floor")

    def test_a_sizeable_candidate_records_no_refusal(self):
        _, candidate = self.capture()
        self.assertIsNone(candidate.sizing_refusal)


class RunSummaryCeilingTest(unittest.TestCase):
    """build_run_summary reads the ceiling GATE 5 enforces. Untested until now.

    Neither build_run_summary nor its trading_config lookup appeared in any test
    file, so five mutants survived, including one turning `edge` into
    `abs(edge)`, which makes every NO-edge market a proposed YES.
    """

    def rows(self, sim_probability=0.60, yes_price=0.20):
        return [{
            "market_id": "1", "condition_id": "0x" + "ab" * 32, "slug": "s",
            "question": "q", "asset": "btc", "yes_price": yes_price,
            "volume": 279582.74, "horizon_days": 20.333,
            "end_date": "2026-09-30T04:00:00Z", "min_order_size": 1.0,
            "simulation": {"probability": sim_probability},
        }]

    def summarise(self, rows, config_value=10.0, raises=None):
        captured = {}
        real_size, real_cfg = scanner_mod.size_position, scanner_mod.get_trading_config

        def spy(**kw):
            captured.update(kw)
            return real_size(**kw)

        async def fake_config():
            if raises is not None:
                raise raises
            return TradingConfig(id=1, max_position_usdc=config_value)

        scanner_mod.size_position = spy
        scanner_mod.get_trading_config = fake_config
        try:
            summary = run(PolymarketScanner().build_run_summary(
                rows, markets_fetched=1, candidates_analysed=1,
                sim_errors=0, open_positions=0,
            ))
        finally:
            scanner_mod.size_position = real_size
            scanner_mod.get_trading_config = real_cfg
        return captured, summary

    def test_the_configured_ceiling_reaches_sizing(self):
        for configured in (4.0, 10.0, 17.0):
            with self.subTest(configured=configured):
                captured, _ = self.summarise(self.rows(), config_value=configured)
                self.assertEqual(captured["max_position_usdc"], configured)

    def test_the_hard_ceiling_bounds_an_absurd_config(self):
        """min(configured, ABSOLUTE_MAX). A trading_config edited to 10000 must
        not raise the real ceiling."""
        captured, _ = self.summarise(self.rows(), config_value=10_000.0)
        self.assertEqual(captured["max_position_usdc"], ABSOLUTE_MAX_POSITION_USDC)

    def test_an_unreadable_config_falls_back_to_the_hard_ceiling(self):
        captured, _ = self.summarise(
            self.rows(), raises=SupabaseError("GET", "/c", 500, "boom")
        )
        self.assertEqual(captured["max_position_usdc"], ABSOLUTE_MAX_POSITION_USDC)

    def test_a_zero_or_absent_config_falls_back_rather_than_sizing_to_zero(self):
        captured, _ = self.summarise(self.rows(), config_value=0.0)
        self.assertEqual(captured["max_position_usdc"], ABSOLUTE_MAX_POSITION_USDC)

    def test_edge_keeps_its_SIGN(self):
        """abs(edge) survived the suite and is the worst of the five.

        With it, a market priced ABOVE the simulation becomes a high-edge YES
        candidate: the system proposes buying the side it believes is
        overpriced.
        """
        _, summary = self.summarise(self.rows(sim_probability=0.05, yes_price=0.60))
        self.assertEqual(summary.high_edge, [], "a negative edge is not high edge")
        self.assertEqual(len(summary.no_edge), 1)
        self.assertLess(summary.no_edge[0].edge, 0)
        self.assertEqual(summary.no_edge[0].direction, "NO")


class MarketMinimumIsReadNotAssumedTest(unittest.TestCase):
    """analyse_edge must put the MARKET's orderMinSize on the row.

    The wire-through tests hand a row straight to _to_candidate, so they cover
    the second half of the journey and not the first. A mutant hardcoding 5.0
    in the row builder survived them all: the gap simply moved one level up,
    which is the same class of miss a third time.

    5 is what every sampled market returns, so a hardcoded 5 is invisible
    against any fixture that also says 5. Every test here uses a value that is
    NOT 5.
    """

    def analyse(self, *markets):
        return run(PolymarketScanner().analyse_edge(list(markets)))

    def end_in(self, **delta):
        return (datetime.now(timezone.utc) + timedelta(**delta)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )

    def test_the_row_carries_the_markets_own_minimum(self):
        for minimum in (1, 12, 50, 2.5):
            with self.subTest(orderMinSize=minimum):
                market = make_market(self.end_in(days=10), orderMinSize=minimum)
                selected = self.analyse(market)
                self.assertEqual(len(selected), 1)
                self.assertEqual(selected[0]["min_order_size"], float(minimum))

    def test_an_absent_minimum_becomes_None_not_five(self):
        """Fail-closed depends on this. Defaulting to the usual 5 would size
        against a floor nobody read."""
        market = make_market(self.end_in(days=10))
        market.pop("orderMinSize")
        self.assertIsNone(self.analyse(market)[0]["min_order_size"])

    def test_a_malformed_minimum_becomes_None(self):
        for bad in ("many", None, 0, -5, float("nan")):
            with self.subTest(orderMinSize=bad):
                market = make_market(self.end_in(days=10), orderMinSize=bad)
                self.assertIsNone(self.analyse(market)[0]["min_order_size"])

    def test_a_numeric_string_is_accepted(self):
        market = make_market(self.end_in(days=10), orderMinSize="12")
        self.assertEqual(self.analyse(market)[0]["min_order_size"], 12.0)

    def test_the_helper_reads_the_field_it_claims_to(self):
        self.assertEqual(scanner_mod._market_min_order_size({"orderMinSize": 50}), 50.0)
        self.assertIsNone(scanner_mod._market_min_order_size({}))
        self.assertIsNone(scanner_mod._market_min_order_size({"minOrderSize": 50}))


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


class ApprovalGuardTest(unittest.TestCase):
    """An unsizeable best_trade must not reach a human.

    K12's sibling, one function later, in the same change. select_best_trade
    filters unsizeable candidates, but the Analyst's REDUCE can make a
    candidate unsizeable AFTER that filter has run, and only this guard stops
    it. Removing the guard survived the whole suite: the failure direction is
    "shows a human a button that cannot fire", which reads as harmless and so
    went untested.
    """

    def summary_with_refusal(self, refusal):
        candidate = ScannerCandidate(
            market_id="1", condition_id="0x" + "ab" * 32, question="q",
            asset="btc", direction="YES", edge=0.20, sim_probability=0.60,
            market_probability=0.40, volume=50000.0, horizon_days=5.0,
            market_url="", amount_usdc=1.5, min_order_size=5.0,
            sizing_refusal=refusal,
        )
        summary = ScannerRunSummary(
            run_at=datetime.now(timezone.utc), markets_fetched=1,
            candidates_analysed=1, simulations_run=1, sim_errors=0,
        )
        summary.best_trade = candidate
        summary.analyst_recommendation = AnalystRecommendation(
            recommendation="proceed", confidence=0.8, reasoning="ok", flags=[],
        )
        return summary

    def test_no_approval_is_requested_for_an_unsizeable_trade(self):
        summary = self.summary_with_refusal("below_exchange_minimum")
        gate = _RecordingGate()
        scanner = PolymarketScanner(approval_gate=gate)
        run(scanner.apply_approval(summary))
        self.assertEqual(gate.requests, [], "no button for an unplaceable trade")
        self.assertIsNone(summary.approval_result)

    def test_a_sizeable_trade_still_reaches_the_gate(self):
        """Or the guard would be indistinguishable from the gate being broken."""
        summary = self.summary_with_refusal(None)
        gate = _RecordingGate()
        scanner = PolymarketScanner(approval_gate=gate)
        run(scanner.apply_approval(summary))
        self.assertEqual(len(gate.requests), 1)


class _RecordingGate:
    def __init__(self):
        self.requests = []

    async def send_approval_request(self, candidate, recommendation):
        self.requests.append(candidate)
        return object()

    async def wait_for_decision(self, pending):
        from src.trade_engine.models import ApprovalResult, ApprovalStatus
        return ApprovalResult(
            approval_id="a", status=ApprovalStatus.timeout,
            candidate=self.requests[-1],
            recommendation=AnalystRecommendation(
                recommendation="proceed", confidence=0.8, reasoning="r", flags=[]),
            decided_at=datetime.now(timezone.utc), decision_source="timeout",
        )


class SizingConfigClampTest(unittest.TestCase):
    """The sizing dials may only move in the conservative direction.

    DEFAULT_BANKROLL_USDC's docstring says raising it is a capital decision and
    "not a config edit". That was false while this was a bare env read:
    BANKROLL_USDC=200 was exactly a config edit, unclamped and unlogged. Two
    paragraphs of prose were the only guard on the number the whole sizing
    model rests on.
    """

    def with_env(self, **env):
        saved = {k: os.environ.get(k) for k in env}
        try:
            for k, v in env.items():
                os.environ[k] = v
            return Config()
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_bankroll_cannot_be_raised_by_env(self):
        """The $180 that would make Kelly and the exchange compatible is a
        DEPOSIT, not a config edit. The code now agrees with the comment."""
        for attempt in ("200", "180", "25.01", "1e9"):
            with self.subTest(value=attempt):
                self.assertEqual(self.with_env(BANKROLL_USDC=attempt).bankroll_usdc, 25.0)

    def test_bankroll_can_be_lowered(self):
        self.assertEqual(self.with_env(BANKROLL_USDC="10").bankroll_usdc, 10.0)

    def test_kelly_fraction_cannot_be_raised_by_env(self):
        for attempt in ("1.0", "0.5", "5.0"):
            with self.subTest(value=attempt):
                self.assertEqual(
                    self.with_env(KELLY_FRACTION=attempt).kelly_fraction, 0.10
                )

    def test_kelly_fraction_can_be_lowered(self):
        self.assertEqual(self.with_env(KELLY_FRACTION="0.05").kelly_fraction, 0.05)

    def test_the_price_floor_can_only_be_RAISED(self):
        self.assertEqual(self.with_env(SIZING_PRICE_FLOOR="0.0").sizing_price_floor, 0.10)
        self.assertEqual(self.with_env(SIZING_PRICE_FLOOR="0.25").sizing_price_floor, 0.25)


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
