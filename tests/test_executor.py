"""Tests for the trade-engine executor (src/trade_engine/executor.py).

Stdlib unittest, matching tests/test_analyst.py and tests/test_approval.py.
No network, no Supabase, no real subprocess against Polymarket: the database
helpers are monkeypatched and the script runner is stubbed.

This is the money path, so the assertions lean paranoid — every gate is tested
for the REFUSAL, and the happy path asserts on the exact row written.

Run:
    python3 -m unittest tests/test_executor.py
"""

import asyncio
import contextlib
import json
import os
import subprocess
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

from src.trade_engine import executor as executor_mod  # noqa: E402
from src.trade_engine.executor import TradeExecutor  # noqa: E402
from src.trade_engine.models import (  # noqa: E402
    AnalystRecommendation,
    ApprovalResult,
    ApprovalStatus,
    ExecutionGateError,
    ScannerCandidate,
    ScannerRunSummary,
    TradeExecutionResult,
    TradingConfig,
)
from src.trade_engine.scanner import PolymarketScanner  # noqa: E402

VALID_CONDITION_ID = "0x" + "a1b2c3d4" * 8  # 0x + 64 hex


def run(coro):
    return asyncio.run(coro)


def make_candidate(**overrides) -> ScannerCandidate:
    base = dict(
        market_id="3158105",
        condition_id=VALID_CONDITION_ID,
        question="Will the price of Ethereum be above $1,900 on August 4?",
        asset="eth",
        direction="YES",
        edge=0.2164,
        sim_probability=0.3039,
        market_probability=0.0875,
        volume=37494.25,
        horizon_days=1,
        # GATE 7 recomputes the horizon from end_date against the live clock,
        # so every candidate needs one. Far future by default; the GATE 7 tests
        # below override it to put the market at a specific distance from the
        # floor.
        end_date=(datetime.now(timezone.utc) + timedelta(days=21)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        ),
        market_url="https://polymarket.com/market/eth-above-1900",
        amount_usdc=5.0,
    )
    base.update(overrides)
    return ScannerCandidate(**base)


@contextlib.contextmanager
def frozen_clock(moment):
    """Freeze executor.datetime.now() at `moment` for the duration.

    Only .now() is controlled; horizon.py keeps its own real datetime, so
    end_date parsing is untouched and the test varies exactly one thing.

    executor._staleness_reason reads the same clock, which is why every caller
    also pins decided_at to `moment`: otherwise moving the clock forward trips
    stale_approval first and the horizon gate is never reached.
    """
    real = executor_mod.datetime
    executor_mod.datetime = type(
        "FrozenDatetime", (), {"now": staticmethod(lambda tz=None: moment)}
    )
    try:
        yield
    finally:
        executor_mod.datetime = real


def make_approval(status=ApprovalStatus.approved, decided_at=None, **cand) -> ApprovalResult:
    return ApprovalResult(
        approval_id="ap-1",
        status=status,
        candidate=make_candidate(**cand),
        recommendation=AnalystRecommendation(
            recommendation="reduce", confidence=0.45,
            reasoning="Edge is wide but history is thin.", flags=[],
        ),
        decided_at=decided_at or datetime.now(timezone.utc),
        decision_source="user",
    )


SUCCESS_STDOUT = json.dumps({
    "success": True,
    "market_id": VALID_CONDITION_ID,
    "direction": "YES",
    "amount_usdc": 5.0,
    "token_id": "3233822019007135141",
    "response": {"orderID": "0xorder123", "status": "matched", "price": "0.09"},
})


class _FakeClob:
    """httpx-shaped client returning a scripted payload per CLOB path."""

    def __init__(self, market=None, book=None, status=200, raises=None):
        self._market, self._book = market, book
        self._status, self._raises = status, raises
        self.calls = []
        self.timeouts = []

    async def get(self, url, params=None, timeout=None):
        self.calls.append((url, params))
        self.timeouts.append(timeout)
        payload = self._book if "/book" in url else self._market
        return _FakeResponse(payload, self._status, self._raises)


def _client_calls(self):
    return self._client.calls


class _FakeResponse:
    def __init__(self, payload, status, raises):
        self._payload, self.status_code, self._raises = payload, status, raises

    def json(self):
        if self._raises is not None:
            raise self._raises
        return self._payload


class StubExecutor(TradeExecutor):
    """TradeExecutor with the subprocess and Telegram edges replaced."""

    def __init__(self, *, stdout=SUCCESS_STDOUT, returncode=0, raises=None,
                 order_constraints=(5.0, 0.0875), **kw):
        kw.setdefault("token", "test-token")
        kw.setdefault("chat_id", "1375806243")
        super().__init__(**kw)
        self.stdout = stdout
        self.returncode = returncode
        self.raises = raises
        self.argv_calls: list[list[str]] = []
        self.notifications: list[str] = []
        # GATE 8 walks the live CLOB book. Stubbed here so the rest of the suite
        # makes no network calls. Given as (minimum, fill_price); shares are
        # DERIVED from the notional, so a test changing the amount changes the
        # verdict the way the real gate would. None exercises the fail-closed
        # path. The walk itself and the HTTP layer have their own direct tests.
        self.order_constraints = order_constraints
        self.constraint_calls: list[tuple] = []

    async def _fetch_order_constraints(self, condition_id, direction, notional):
        self.constraint_calls.append((condition_id, direction, notional))
        if self.order_constraints is None:
            return None
        minimum, fill_price = self.order_constraints
        return executor_mod.OrderConstraints(
            minimum=minimum, shares=notional / fill_price, fill_price=fill_price,
            observed_at=datetime.now(timezone.utc),
        )

    async def _run_script(self, argv):
        self.argv_calls.append(argv)
        if self.raises is not None:
            raise self.raises
        return subprocess.CompletedProcess(
            args=argv, returncode=self.returncode, stdout=self.stdout, stderr=""
        )

    async def _notify(self, text):
        self.notifications.append(text)


class DBStub:
    """Monkeypatches the executor's database helpers for one test."""

    def __init__(
        self, *, trading_enabled=True, open_positions=0, daily_pnl=0.0,
        max_position=10.0, min_edge=7.0, loss_limit=20.0,
        write_raises=None, config_raises=None, count_raises=None, pnl_raises=None,
    ):
        self.cfg = TradingConfig(
            id=1, trading_enabled=trading_enabled, max_position_usdc=max_position,
            min_edge_threshold=min_edge, daily_loss_limit=loss_limit,
        )
        self.open_positions = open_positions
        self.daily_pnl = daily_pnl
        self.write_raises = write_raises
        self.config_raises = config_raises
        self.count_raises = count_raises
        self.pnl_raises = pnl_raises
        self.written: list[dict] = []
        self._saved = {}

    def __enter__(self):
        async def get_trading_config():
            if self.config_raises:
                raise self.config_raises
            return self.cfg

        async def count_open_positions():
            if self.count_raises:
                raise self.count_raises
            return self.open_positions

        async def get_daily_pnl():
            if self.pnl_raises:
                raise self.pnl_raises
            return self.daily_pnl

        async def write_position(row):
            self.written.append(row)
            if self.write_raises:
                raise self.write_raises
            return {"id": "pos-uuid-1", **row}

        for name, fn in (
            ("get_trading_config", get_trading_config),
            ("count_open_positions", count_open_positions),
            ("get_daily_pnl", get_daily_pnl),
            ("write_position", write_position),
        ):
            self._saved[name] = getattr(executor_mod, name)
            setattr(executor_mod, name, fn)
        return self

    def __exit__(self, *exc):
        for name, fn in self._saved.items():
            setattr(executor_mod, name, fn)
        return False


class ModelTest(unittest.TestCase):
    def test_execution_result_validates(self):
        result = TradeExecutionResult(
            success=True, position_id="p1", tx_hash="0xabc",
            executed_at=datetime.now(timezone.utc),
        )
        self.assertTrue(result.success)
        self.assertIsNone(result.gate_blocked)
        self.assertEqual(result.model_dump()["position_id"], "p1")

    def test_gate_error_carries_gate_name(self):
        exc = ExecutionGateError("position_cap")
        self.assertEqual(exc.gate, "position_cap")
        self.assertIn("position_cap", str(exc))

    def test_summary_defaults_execution_result_to_none(self):
        summary = ScannerRunSummary(
            run_at=datetime.now(timezone.utc), markets_fetched=0,
            candidates_analysed=0, simulations_run=0, sim_errors=0,
        )
        self.assertIsNone(summary.execution_result)


class GateTest(unittest.TestCase):
    """Each gate must REFUSE, and refusing must place no order."""

    def assert_blocked(self, gate, db_kwargs=None, **cand):
        ex = StubExecutor()
        with DBStub(**(db_kwargs or {})):
            result = run(ex.execute(make_approval(**cand)))
        self.assertFalse(result.success)
        self.assertEqual(result.gate_blocked, gate)
        self.assertEqual(ex.argv_calls, [], "a blocked trade must not run the script")
        self.assertTrue(any("⛔" in n for n in ex.notifications))
        return result

    def test_gate1_trading_disabled(self):
        self.assert_blocked("trading_disabled", {"trading_enabled": False})

    def test_gate1_fails_closed_on_supabase_error(self):
        self.assert_blocked(
            "trading_disabled",
            {"config_raises": executor_mod.SupabaseError("GET", "/c", 500, "boom")},
        )

    def test_gate2_position_cap(self):
        self.assert_blocked("position_cap", {"open_positions": 2})

    def test_gate2_fails_closed_on_supabase_error(self):
        self.assert_blocked(
            "position_cap",
            {"count_raises": executor_mod.SupabaseError("GET", "/p", 500, "boom")},
        )

    def test_gate3_daily_loss_limit(self):
        self.assert_blocked("daily_loss_limit", {"daily_pnl": -20.0})

    def test_gate3_fails_closed_on_supabase_error(self):
        self.assert_blocked(
            "daily_loss_limit",
            {"pnl_raises": executor_mod.SupabaseError("GET", "/p", 500, "boom")},
        )

    def test_gate3_profit_does_not_block(self):
        """A +$50 day must not trip a $20 LOSS limit via abs()."""
        ex = StubExecutor()
        with DBStub(daily_pnl=50.0):
            result = run(ex.execute(make_approval()))
        self.assertTrue(result.success)

    def test_gate4_edge_below_threshold(self):
        # min_edge_threshold is 7 (percentage points) -> 0.07
        self.assert_blocked("edge_below_threshold", edge=0.05)

    def test_gate4_percent_vs_fraction_not_confused(self):
        """edge=0.08 clears a threshold of 7; a raw compare would refuse it."""
        ex = StubExecutor()
        with DBStub():
            result = run(ex.execute(make_approval(edge=0.08)))
        self.assertTrue(result.success)

    def test_gate5_amount_above_max(self):
        self.assert_blocked("invalid_amount", amount_usdc=25.0)

    def test_gate5_amount_zero_and_negative(self):
        self.assert_blocked("invalid_amount", amount_usdc=0.0)
        self.assert_blocked("invalid_amount", amount_usdc=-5.0)

    def test_gate5_absolute_ceiling_beats_a_bad_config(self):
        """Even if trading_config is edited to something absurd."""
        self.assert_blocked(
            "invalid_amount", {"max_position": 10000.0}, amount_usdc=500.0
        )

    def test_gate6_missing_condition_id(self):
        self.assert_blocked("invalid_market_identifier", condition_id=None)

    def test_gate6_rejects_numeric_gamma_id(self):
        """The F1 bug: a numeric market id must never reach the CLOB."""
        self.assert_blocked("invalid_market_identifier", condition_id="3158105")

    def test_gate6_rejects_malformed_hex(self):
        self.assert_blocked("invalid_market_identifier", condition_id="0xdeadbeef")

    # --- GATE 7, the tradeable-horizon floor ------------------------------
    #
    # GATE 7 RECOMPUTES the horizon from end_date against the clock at
    # execution. It does not read candidate.horizon_days, which is frozen at
    # scan time. These tests drive it by end_date for that reason, and the
    # decay test below is the one that distinguishes the two.

    @staticmethod
    def ends_in(**delta):
        return (datetime.now(timezone.utc) + timedelta(**delta)).strftime(
            "%Y-%m-%dT%H:%M:%S.%fZ"
        )

    def test_gate7_refuses_the_e09b82fe_horizon(self):
        """0.0412d, the 3,558-second market that cost $10.69.

        Edge is left at the fixture's healthy 0.2164 on purpose: this must be
        refused on horizon ALONE, with nothing wrong with the edge.
        """
        self.assert_blocked("horizon_below_minimum", end_date=self.ends_in(seconds=3558))

    def test_gate7_refuses_just_under_the_floor(self):
        self.assert_blocked("horizon_below_minimum", end_date=self.ends_in(days=0.999))

    def test_gate7_refuses_a_market_that_has_already_resolved(self):
        self.assert_blocked("horizon_below_minimum", end_date=self.ends_in(days=-1))

    def test_gate7_admits_a_market_with_headroom(self):
        """The gate refuses SHORT markets, not fractional ones.

        horizon_days is fractional here as well as end_date, because every real
        candidate carries one since 2026-09-08 and the money path must accept it
        end to end. Without this the executor suite passes with
        ScannerCandidate.horizon_days back as an int.
        """
        ex = StubExecutor()
        with DBStub():
            result = run(ex.execute(make_approval(
                end_date=self.ends_in(days=20.58), horizon_days=20.582881944,
            )))
        self.assertTrue(result.success)

    # --- the decay case, which is the whole reason GATE 7 exists -----------

    def test_gate7_refuses_a_market_that_decayed_below_the_floor_since_the_scan(self):
        """THE independence test. The scanner admitted it; the executor must not.

        A market at EXACTLY the 1.00d floor when the scanner proposed it is
        0.976d by the time the order can go out: APPROVAL_TIMEOUT_SECONDS
        (1800) plus APPROVAL_MAX_AGE_SECONDS (300) is 2100s of decay. Reading
        the frozen candidate.horizon_days passes it. Recomputing refuses it.

        The candidate carries horizon_days=1.0, the honest scan-time value, so
        this fails the moment the gate goes back to trusting that field. That is
        what makes the two layers independent rather than one check written
        twice: they evaluate the same property against different clocks.
        """
        decay = executor_mod.APPROVAL_MAX_AGE_SECONDS + 1800
        self.assertEqual(decay, 2100)
        scan_time = datetime.now(timezone.utc) - timedelta(seconds=decay)
        end_date = (scan_time + timedelta(days=1.0)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")

        # The scanner, at scan time, would have admitted this: exactly the floor.
        at_scan = PolymarketScanner._horizon_days(end_date, scan_time)
        self.assertAlmostEqual(at_scan, 1.0, places=6)
        self.assertGreaterEqual(at_scan, executor_mod.config.min_horizon_tradeable_days)

        # The executor, now, must refuse it.
        self.assert_blocked(
            "horizon_below_minimum", end_date=end_date, horizon_days=at_scan
        )

    def test_gate7_is_evaluated_at_execution_time_not_at_import(self):
        """Hold the candidate FIXED and move the CLOCK. One variable.

        The decay test above moves the END DATE back 2100s. That separates
        "recomputed from end_date" from "reads the frozen horizon_days", and it
        cannot separate "recomputed at execution" from "recomputed at import":
        every other gate-7 test builds end_date relative to the instant it runs,
        so an import-time clock and an execution-time clock are milliseconds
        apart and agree on every one of them.

        A build that captured the clock once at module scope therefore passed
        the entire suite 75/75, including the decay sentinel run alone, while
        being a real regression: at T+2.5s it places an order the correct build
        refuses.

        The SAME candidate, byte for byte, must be admitted at t and refused at
        t+2100s. Nothing but the clock changes.
        """
        base = datetime.now(timezone.utc)
        # 1.0007d at base: over the floor, and under it after 2100s of decay.
        end_date = (base + timedelta(days=1.0, seconds=60)).strftime(
            "%Y-%m-%dT%H:%M:%S.%fZ"
        )

        admitted = StubExecutor()
        with DBStub(), frozen_clock(base):
            ok = run(admitted.execute(
                make_approval(end_date=end_date, decided_at=base)
            ))
        self.assertTrue(ok.success, "must be admitted at t")
        self.assertEqual(len(admitted.argv_calls), 1)

        later = base + timedelta(seconds=2100)
        refused = StubExecutor()
        with DBStub(), frozen_clock(later):
            blocked = run(refused.execute(
                make_approval(end_date=end_date, decided_at=later)
            ))
        self.assertFalse(blocked.success, "must be refused at t+2100s")
        self.assertEqual(blocked.gate_blocked, "horizon_below_minimum")
        self.assertEqual(
            refused.argv_calls, [], "a blocked trade must not run the script"
        )

    def test_gate7_uses_the_clock_not_the_frozen_field(self):
        """Same property from the other side: a stale field must not save it.

        horizon_days claims a healthy 21 days. end_date says 10 minutes. The
        gate must believe end_date.
        """
        self.assert_blocked(
            "horizon_below_minimum",
            end_date=self.ends_in(minutes=10),
            horizon_days=21.0,
        )

    # --- fail closed -------------------------------------------------------

    def test_gate7_fails_closed_on_missing_end_date(self):
        """An unknown resolution time is refused, never backfilled from the
        scan-time snapshot."""
        for absent in (None, ""):
            with self.subTest(end_date=absent):
                self.assert_blocked(
                    "horizon_below_minimum", end_date=absent, horizon_days=21.0
                )

    def test_gate7_fails_closed_on_unparseable_end_date(self):
        for bad in ("not-a-date", "2026-13-45T99:99:99Z", "soon"):
            with self.subTest(end_date=bad):
                self.assert_blocked(
                    "horizon_below_minimum", end_date=bad, horizon_days=21.0
                )

    # --- GATE 8, the exchange's share minimum -----------------------------
    #
    # The gate WALKS THE BOOK: it computes how many shares the notional buys at
    # the prices the exchange will actually charge. These drive it through the
    # executor; the walk and the HTTP layer have their own tests below.

    def test_gate8_refuses_an_order_below_the_share_minimum(self):
        """$0.25 at a 0.40 fill price is 0.625 shares."""
        self.assert_blocked(
            "below_exchange_minimum", db_kwargs=None,
            amount_usdc=0.25, market_probability=0.40,
        )

    def test_gate8_admits_an_order_that_clears_it(self):
        ex = StubExecutor(order_constraints=(5.0, 0.40))
        with DBStub():
            result = run(ex.execute(make_approval(
                amount_usdc=4.0, market_probability=0.40
            )))
        self.assertTrue(result.success, "10 shares clears a 5-share minimum")

    def test_gate8_passes_the_notional_and_direction_to_the_book_walk(self):
        """The walk must be for THIS order, not a generic depth check."""
        ex = StubExecutor(order_constraints=(5.0, 0.40))
        with DBStub():
            run(ex.execute(make_approval(amount_usdc=4.0, market_probability=0.40)))
        self.assertEqual(
            ex.constraint_calls, [(VALID_CONDITION_ID, "YES", 4.0)],
        )

    def test_gate8_reads_the_LIVE_minimum_not_the_candidates_copy(self):
        ex = StubExecutor(order_constraints=(50.0, 0.40))
        with DBStub():
            result = run(ex.execute(make_approval(
                amount_usdc=4.0, market_probability=0.40, min_order_size=1.0
            )))
        self.assertFalse(result.success)
        self.assertEqual(result.gate_blocked, "below_exchange_minimum")
        self.assertEqual(ex.argv_calls, [])

    def test_gate8_uses_the_live_minimum_exactly_not_the_stricter_of_the_two(self):
        ex = StubExecutor(order_constraints=(5.0, 0.40))
        with DBStub():
            result = run(ex.execute(make_approval(
                amount_usdc=4.0, market_probability=0.40, min_order_size=500.0
            )))
        self.assertTrue(result.success, "10 shares clears the LIVE minimum of 5")

    def test_gate8_ignores_the_candidates_price_entirely(self):
        """THE property. The share count comes from the BOOK, not the candidate.

        A candidate whose scan-time price would give a comfortable 40 shares is
        refused when the live fill price says 2.5. If the gate divided by the
        candidate's price, or by any mid, this passes.
        """
        ex = StubExecutor(order_constraints=(5.0, 0.80))
        with DBStub():
            result = run(ex.execute(make_approval(
                amount_usdc=2.0, market_probability=0.05
            )))
        self.assertFalse(result.success)
        self.assertEqual(result.gate_blocked, "below_exchange_minimum")

    # --- the boundary, pinned on both sides ------------------------------

    def test_gate8_admits_exactly_the_minimum(self):
        ex = StubExecutor(order_constraints=(5.0, 0.40))
        with DBStub():
            result = run(ex.execute(make_approval(
                amount_usdc=2.0, market_probability=0.40
            )))
        self.assertTrue(result.success, "2.00 / 0.40 is exactly 5 shares")

    def test_gate8_refuses_a_hair_under_the_minimum(self):
        for amount, shares in ((1.999996, 4.99999), (1.98, 4.95), (1.9, 4.75)):
            with self.subTest(shares=shares):
                ex = StubExecutor(order_constraints=(5.0, 0.40))
                with DBStub():
                    result = run(ex.execute(make_approval(
                        amount_usdc=amount, market_probability=0.40
                    )))
                self.assertFalse(result.success, f"{shares} shares must refuse")
                self.assertEqual(result.gate_blocked, "below_exchange_minimum")

    # --- fail closed -------------------------------------------------------

    def test_gate8_fails_closed_when_constraints_cannot_be_read(self):
        """The candidate CARRIES a permissive minimum, because that is the only
        case in which a fallback is possible and therefore the only case that
        tests fail-closed."""
        for copy in (1.0, 0.001, 5.0):
            with self.subTest(candidate_min=copy):
                ex = StubExecutor(order_constraints=None)
                with DBStub():
                    result = run(ex.execute(make_approval(
                        amount_usdc=9.0, market_probability=0.40,
                        min_order_size=copy,
                    )))
                self.assertFalse(result.success)
                self.assertEqual(result.gate_blocked, "below_exchange_minimum")
                self.assertEqual(ex.argv_calls, [])

    def test_gate8_refuses_a_candidate_the_scanner_never_sized(self):
        self.assert_blocked(
            "below_exchange_minimum", sizing_refusal="below_exchange_minimum"
        )

class Gate8LogValuesTest(unittest.TestCase):
    """The refusal log is the deliverable, so its NUMBERS are asserted.

    "Every refusal is logged with its numbers so the suppression rate becomes
    data" is the stated justification for accepting near-total suppression. No
    value in that line was asserted anywhere: mutants swapping shares for the
    minimum, printing min_notional as a division instead of a product, and
    reporting the minimum where the share count belongs all survived.

    Asserting a label proves the format string; the label is written by the same
    line that writes the value and cannot witness it.
    """

    def capture(self, **cand):
        ex = StubExecutor(order_constraints=(7.0, 0.40))
        with DBStub(), self.assertLogs("trade_engine.executor", level="INFO") as logs:
            result = run(ex.execute(make_approval(**cand)))
        return result, "\n".join(logs.output)

    def test_the_refusal_line_carries_every_number_by_value(self):
        # $2.00 at 0.40 is 5 shares against a required 7.
        result, text = self.capture(amount_usdc=2.0, market_probability=0.40)
        self.assertFalse(result.success)
        for fragment in ("notional=2.0000", "fill_price=0.4000",
                         "shares=5.0000", "required_shares=7.0000",
                         "min_notional=2.8000"):
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, text)

    def test_min_notional_is_a_PRODUCT_not_a_quotient(self):
        """7 shares at 0.40 is $2.80. Printed as a division it reads $17.50,
        which is the same shape of wrong number in the same log line."""
        _, text = self.capture(amount_usdc=2.0, market_probability=0.40)
        self.assertIn("min_notional=2.8000", text)
        self.assertNotIn("min_notional=17.5000", text)

    def test_shares_and_required_are_not_interchangeable(self):
        """Distinct fixture values, so a swap is visible at all."""
        _, text = self.capture(amount_usdc=2.0, market_probability=0.40)
        self.assertIn("shares=5.0000 required_shares=7.0000", text)
        self.assertNotIn("shares=7.0000 required_shares=5.0000", text)

    def test_the_refusal_line_carries_the_as_of_timestamp(self):
        _, text = self.capture(amount_usdc=2.0, market_probability=0.40)
        self.assertIn(" as of ", text)
        self.assertRegex(text, r"as of \d{4}-\d{2}-\d{2}T")

    def test_the_admit_line_reports_the_share_count_not_the_minimum(self):
        ex = StubExecutor(order_constraints=(5.0, 0.40))
        with DBStub(), self.assertLogs("trade_engine.executor", level="INFO") as logs:
            result = run(ex.execute(make_approval(
                amount_usdc=4.0, market_probability=0.40)))
        text = "\n".join(logs.output)
        self.assertTrue(result.success)
        # BOTH halves. Asserting only the leading share count left a mutant
        # reporting the share count again in the "required" position alive.
        self.assertIn(
            "gate 8 ok: 10.0000 shares at fill price 0.4000", text)
        self.assertIn(">= 5.0000 required", text)
        self.assertNotIn(">= 10.0000 required", text)


class BookWalkTest(unittest.TestCase):
    """_shares_for_notional must mirror py-clob-client-v2, not intuition.

    The first version returned the VWAP of the levels consumed, which is what a
    human means by "the price it fills at" and is NOT what the client submits.
    Read from py_clob_client_v2 1.1.0, the version the relay pins:

      calculate_buy_market_price   returns the price of THE LEVEL at which the
                                   cumulative notional first reaches `amount`,
                                   i.e. the MARGINAL price
      get_market_order_amounts     raw_maker_amt = round_down(amount, 2)
                                   raw_taker_amt = raw_maker_amt / raw_price

    VWAP <= marginal whenever the order spans levels, so the old model
    OVERSTATED the share count, in the same unsafe direction as the Gamma mid
    this gate replaced.
    """

    walk = staticmethod(TradeExecutor._shares_for_notional)

    def test_a_single_deep_level_fills_at_that_price(self):
        shares, price = self.walk([(0.40, 10_000.0)], 2.0)
        self.assertAlmostEqual(shares, 5.0, places=9)
        self.assertAlmostEqual(price, 0.40, places=9)

    def test_it_returns_the_MARGINAL_price_not_the_average(self):
        """THE property. $2 against 1 share at 0.40 then depth at 0.50.

        VWAP would be 2.00/4.2 = 0.476 and would report 4.2 shares. The client
        divides by the marginal 0.50 and submits 4.0. A 5-share minimum refuses
        the real order and the VWAP model would have admitted it.
        """
        shares, price = self.walk([(0.40, 1.0), (0.50, 10_000.0)], 2.0)
        self.assertAlmostEqual(price, 0.50, places=9, msg="marginal, not VWAP")
        self.assertAlmostEqual(shares, 4.0, places=9)
        self.assertNotAlmostEqual(shares, 4.2, places=2, msg="4.2 is the VWAP answer")

    def test_the_notional_is_floored_to_CENTS_before_dividing(self):
        """round_down(amount, 2): round_config.size is 2 for every tick size.

        $1.875 is submitted as $1.87, so at 0.375 the order is 4.9867 shares and
        the exchange refuses it. Sizing routinely produces sub-cent notionals
        and 0.001-tick markets exist, so this is not a corner case.
        """
        shares, price = self.walk([(0.375, 10_000.0)], 1.875)
        self.assertAlmostEqual(price, 0.375, places=9)
        self.assertAlmostEqual(shares, 1.87 / 0.375, places=9)
        self.assertLess(shares, 5.0, "the unfloored 1.875 would give exactly 5")

    def test_flooring_never_rounds_up(self):
        for notional, expected_maker in ((1.879999, 1.87), (2.999, 2.99), (0.259, 0.25)):
            with self.subTest(notional=notional):
                shares, price = self.walk([(0.50, 10_000.0)], notional)
                self.assertAlmostEqual(shares * price, expected_maker, places=9)

    def test_a_sub_cent_notional_cannot_be_submitted(self):
        self.assertIsNone(self.walk([(0.40, 10_000.0)], 0.009))

    def test_a_book_too_thin_to_fill_is_None_not_a_partial(self):
        """The client raises "no match" for a FOK order that the book cannot
        reach, so a partial fill is not the alternative."""
        self.assertIsNone(self.walk([(0.40, 1.0)], 2.0))
        self.assertIsNone(self.walk([], 2.0))

    def test_a_level_exactly_exhausting_the_budget_fills(self):
        """The boundary the >= comparison sits on, pinned in both directions.
        5 shares at 0.40 is exactly $2.00."""
        shares, price = self.walk([(0.40, 5.0)], 2.0)
        self.assertAlmostEqual(shares, 5.0, places=9)
        self.assertAlmostEqual(price, 0.40, places=9)
        # A hair more than the level holds must fall through to the next level.
        shares, price = self.walk([(0.40, 5.0), (0.60, 1_000.0)], 2.01)
        self.assertAlmostEqual(price, 0.60, places=9)

    def test_levels_are_consumed_cheapest_first(self):
        """The live API returns asks DESCENDING by price, so the sort is
        load-bearing rather than cosmetic."""
        shares, price = self.walk([(0.60, 100.0), (0.40, 100.0), (0.50, 100.0)], 4.0)
        self.assertAlmostEqual(price, 0.40, places=9)
        self.assertAlmostEqual(shares, 10.0, places=9)

    def test_junk_levels_are_skipped_not_trusted(self):
        shares, _ = self.walk([(0.0, 999.0), (-1.0, 999.0), (0.40, 10_000.0)], 2.0)
        self.assertAlmostEqual(shares, 5.0, places=9)


class OrderConstraintsFetchTest(unittest.TestCase):
    """The two CLOB calls, driven directly. Every gate test stubs this."""

    def market(self, **over):
        m = {
            "condition_id": VALID_CONDITION_ID,
            # NOT 5. Every live market returns 5, so a fixture saying 5 cannot
            # distinguish a parsed minimum from a hardcoded one: a mutant
            # discarding the parsed value for the literal 5 survived every test
            # here. The malformed-input tests prove the PARSE runs; only a
            # non-default value proves the parsed value is what gets compared.
            "minimum_order_size": 12,
            "accepting_orders": True,
            "tokens": [
                {"outcome": "Yes", "token_id": "111", "price": 0.40},
                {"outcome": "No", "token_id": "222", "price": 0.60},
            ],
        }
        m.update(over)
        return m

    def book(self, asks):
        return {
            "asks": [{"price": str(p), "size": str(s)} for p, s in asks],
            "bids": [{"price": "0.39", "size": "100"}],
            "asset_id": "111",
            "market": VALID_CONDITION_ID,
            "min_order_size": "12",
            "timestamp": "1757416800000",
        }

    #: distinguishes "argument not supplied" from "explicitly None", which the
    #: first version of this helper conflated, so the None-payload case
    #: silently exercised the default and asserted nothing.
    DEFAULT = object()

    def fetch(self, market=DEFAULT, book=DEFAULT, direction="YES", notional=2.0, **kw):
        ex = TradeExecutor(
            client=_FakeClob(
                market=self.market() if market is self.DEFAULT else market,
                book=self.book([(0.40, 10_000.0)]) if book is self.DEFAULT else book,
                **kw),
            token="t", chat_id="c",
        )
        return ex, run(ex._fetch_order_constraints(VALID_CONDITION_ID, direction, notional))

    def test_it_returns_the_walked_fill_price_and_shares(self):
        _, c = self.fetch()
        self.assertAlmostEqual(c.minimum, 12.0, msg="the MARKET's minimum, not 5")
        self.assertAlmostEqual(c.shares, 5.0, places=9)
        self.assertAlmostEqual(c.fill_price, 0.40, places=9)

    def test_the_minimum_tracks_the_market_not_a_constant(self):
        for minimum in (1, 12, 50, 2.5):
            with self.subTest(minimum_order_size=minimum):
                # BOTH sources move together: the cross-check refuses when they
                # disagree, which is its job and is tested separately below.
                book = dict(self.book([(0.40, 10_000.0)]),
                            min_order_size=str(minimum))
                _, c = self.fetch(
                    market=self.market(minimum_order_size=minimum), book=book,
                )
                self.assertIsNotNone(c, "market and book agree, this must size")
                self.assertAlmostEqual(c.minimum, float(minimum))

    def test_observed_at_is_the_BOOKS_timestamp_not_the_read_time(self):
        """A quiet market can return a book minutes stale; one sampled live was
        242s old. Logging the read time overstates freshness, which defeats the
        field's only job after a size rejection."""
        _, c = self.fetch()
        self.assertEqual(
            c.observed_at,
            datetime.fromtimestamp(1757416800.0, tz=timezone.utc),
        )
        self.assertLess(
            c.observed_at, datetime.now(timezone.utc),
            "a fixed past timestamp must not be replaced by now",
        )

    def test_observed_at_falls_back_to_now_when_the_book_gives_none(self):
        before = datetime.now(timezone.utc)
        book = self.book([(0.40, 10_000.0)])
        for bad in (None, "", "soon", 0, -1):
            with self.subTest(timestamp=bad):
                book["timestamp"] = bad
                _, c = self.fetch(book=dict(book))
                self.assertGreaterEqual(c.observed_at, before)

    def test_a_book_for_the_wrong_token_or_market_is_refused(self):
        book = self.book([(0.40, 10_000.0)])
        for key, value in (("asset_id", "999"), ("market", "0x" + "cd" * 32)):
            with self.subTest(field=key):
                wrong = dict(book, **{key: value})
                _, c = self.fetch(book=wrong)
                self.assertIsNone(c)

    def test_a_book_minimum_disagreeing_with_the_market_is_refused(self):
        """One of the two is stale and neither can gate an order."""
        book = dict(self.book([(0.40, 10_000.0)]), min_order_size="5")
        _, c = self.fetch(book=book)
        self.assertIsNone(c)

    def test_an_unrecognised_direction_is_refused(self):
        """Regression guard, not a fix. The token lookup already refuses these
        because no outcome matches; the explicit check only improves the log."""
        for direction in ("", "yes ", "BUY", "Y", None, "MAYBE"):
            with self.subTest(direction=direction):
                _, c = self.fetch(direction=direction)
                self.assertIsNone(c)

    def test_the_gate_bounds_its_own_network_calls(self):
        """A gate must not hang the money path. Nothing asserted the timeout was
        passed, so dropping it survived."""
        ex, _ = self.fetch()
        for url, _ in ex.client_calls:
            self.assertIn("clob.polymarket.com", url)
        self.assertEqual(
            ex._client.timeouts,
            [executor_mod.MARKET_LIMITS_TIMEOUT_SECONDS] * len(ex.client_calls),
        )

    def test_every_non_2xx_status_is_refused(self):
        """Only 503 was exercised, so raising the threshold to 500 survived.
        The live CLOB returns 404 with a JSON body for an unknown id."""
        for status in (301, 302, 400, 403, 404, 429, 500, 503):
            with self.subTest(status=status):
                _, c = self.fetch(status=status)
                self.assertIsNone(c)

    def test_the_fill_price_is_the_ASK_not_the_markets_mid(self):
        """THE property mutant this exists to kill.

        The market endpoint reports tokens[].price = 0.40, a mid. The book's
        ask is 0.50. A gate reading the mid computes 5 shares and admits; the
        real fill is 4 shares and the exchange refuses. Keeping the book call
        and the walk while dividing by the mid must NOT pass.
        """
        _, c = self.fetch(book=self.book([(0.50, 10_000.0)]))
        self.assertAlmostEqual(c.fill_price, 0.50, places=9)
        self.assertAlmostEqual(c.shares, 4.0, places=9)
        self.assertNotAlmostEqual(c.fill_price, 0.40, places=6)
        self.assertLess(c.shares, 5.0, "the mid would have said 5")

    def test_it_picks_the_token_by_OUTCOME_not_by_position(self):
        """Retires the outcomePrices[0]-is-YES assumption. A market whose
        outcomes are ordered ["No", "Yes"] must still size the YES side."""
        reversed_market = self.market(tokens=[
            {"outcome": "No", "token_id": "222", "price": 0.60},
            {"outcome": "Yes", "token_id": "111", "price": 0.40},
        ])
        ex, c = self.fetch(market=reversed_market, direction="YES")
        self.assertIsNotNone(c)
        book_call = [p for u, p in ex.client_calls if "/book" in u][0]
        self.assertEqual(book_call["token_id"], "111", "must ask for the YES token")

    def test_the_NO_side_asks_for_the_NO_token(self):
        ex, c = self.fetch(direction="NO")
        book_call = [p for u, p in ex.client_calls if "/book" in u][0]
        self.assertEqual(book_call["token_id"], "222")

    def test_a_market_not_accepting_orders_is_refused(self):
        """A live fail-open before this change: a closed market with a valid
        minimum_order_size passed the gate."""
        for value in (False, None, "false", 0):
            with self.subTest(accepting_orders=value):
                _, c = self.fetch(market=self.market(accepting_orders=value))
                self.assertIsNone(c)

    def test_the_wrong_market_is_refused(self):
        _, c = self.fetch(market=self.market(condition_id="0x" + "cd" * 32))
        self.assertIsNone(c)

    def test_an_empty_book_is_refused(self):
        for book in ({"asks": []}, {}, {"asks": None}, None):
            with self.subTest(book=book):
                _, c = self.fetch(book=book)
                self.assertIsNone(c)

    def test_a_book_too_thin_to_fill_is_refused(self):
        _, c = self.fetch(book=self.book([(0.40, 1.0)]), notional=2.0)
        self.assertIsNone(c)

    def test_a_missing_or_malformed_minimum_is_refused(self):
        for bad in (None, "many", 0, -5):
            with self.subTest(minimum_order_size=bad):
                _, c = self.fetch(market=self.market(minimum_order_size=bad))
                self.assertIsNone(c)

    def test_a_missing_token_for_the_side_is_refused(self):
        _, c = self.fetch(market=self.market(tokens=[
            {"outcome": "No", "token_id": "222", "price": 0.60}]), direction="YES")
        self.assertIsNone(c)

    def test_transport_and_shape_failures_are_refused(self):
        for label, kw in (("http error", dict(status=503)),
                          ("non-JSON", dict(raises=ValueError("no json")))):
            with self.subTest(case=label):
                _, c = self.fetch(**kw)
                self.assertIsNone(c)
        for label, market in (("not a dict", ["a string"]), ("empty", None)):
            with self.subTest(case=label):
                _, c = self.fetch(market=market)
                self.assertIsNone(c)

    def test_a_missing_condition_id_is_refused_without_a_call(self):
        ex = TradeExecutor(client=_FakeClob(), token="t", chat_id="c")
        self.assertIsNone(run(ex._fetch_order_constraints(None, "YES", 2.0)))
        self.assertEqual(ex._client.calls, [])

    def test_it_makes_TWO_calls_the_market_then_the_book(self):
        """Documented as deliberate. If someone collapses this to one call the
        fill price is gone and only a mid remains."""
        ex, c = self.fetch()
        paths = [u for u, _ in ex.client_calls]
        self.assertEqual(len(paths), 2)
        self.assertIn("/markets/", paths[0])
        self.assertIn("/book", paths[1])


    def test_unapproved_status_refused(self):
        for status in (ApprovalStatus.skipped, ApprovalStatus.timeout,
                       ApprovalStatus.analyst_skip, ApprovalStatus.pending):
            ex = StubExecutor()
            with DBStub():
                result = run(ex.execute(make_approval(status=status)))
            self.assertFalse(result.success)
            self.assertEqual(result.gate_blocked, "not_approved")
            self.assertEqual(ex.argv_calls, [])


class StalenessTest(unittest.TestCase):
    """M1: an approval is consent at a price. A stale verdict must not fill."""

    def _run(self, decided_at):
        ex = StubExecutor()
        approval = make_approval()
        approval.decided_at = decided_at
        with DBStub() as db:
            result = run(ex.execute(approval))
        return ex, db, result

    def test_approval_older_than_five_minutes_is_refused(self):
        ex, db, result = self._run(
            datetime.now(timezone.utc) - timedelta(seconds=301)
        )
        self.assertFalse(result.success)
        self.assertEqual(result.gate_blocked, "stale_approval")
        self.assertEqual(ex.argv_calls, [], "a stale approval must place no order")
        self.assertEqual(db.written, [])
        self.assertTrue(any("stale_approval" in n for n in ex.notifications))

    def test_thirty_minute_old_approval_refused(self):
        """The gate allows 30 min to answer; the executor does not honour that."""
        _, _, result = self._run(datetime.now(timezone.utc) - timedelta(minutes=30))
        self.assertEqual(result.gate_blocked, "stale_approval")

    def test_fresh_approval_passes(self):
        _, _, result = self._run(datetime.now(timezone.utc) - timedelta(seconds=10))
        self.assertTrue(result.success)

    def test_just_inside_the_window_passes(self):
        _, _, result = self._run(datetime.now(timezone.utc) - timedelta(seconds=290))
        self.assertTrue(result.success)

    def test_naive_datetime_is_read_as_utc_not_an_error(self):
        """A JSON body without an offset must not surface as gate_error."""
        naive_fresh = datetime.now(timezone.utc).replace(tzinfo=None)
        _, _, result = self._run(naive_fresh)
        self.assertTrue(result.success)

        naive_stale = (
            datetime.now(timezone.utc) - timedelta(minutes=10)
        ).replace(tzinfo=None)
        _, _, result = self._run(naive_stale)
        self.assertEqual(result.gate_blocked, "stale_approval")

    def test_far_future_decided_at_is_refused(self):
        """Otherwise a skewed or forged timestamp never expires."""
        ex, _, result = self._run(datetime.now(timezone.utc) + timedelta(hours=1))
        self.assertEqual(result.gate_blocked, "stale_approval")
        self.assertEqual(ex.argv_calls, [])

    def test_small_clock_skew_is_tolerated(self):
        _, _, result = self._run(datetime.now(timezone.utc) + timedelta(seconds=5))
        self.assertTrue(result.success)

    def test_staleness_checked_before_any_supabase_read(self):
        """Cheap and decisive: a stale approval must not cost three round trips."""
        ex = StubExecutor()
        approval = make_approval()
        approval.decided_at = datetime.now(timezone.utc) - timedelta(minutes=10)
        with DBStub(config_raises=AssertionError("gates must not run")):
            result = run(ex.execute(approval))
        self.assertEqual(result.gate_blocked, "stale_approval")


class ConditionIdMatchingTest(unittest.TestCase):
    """L2: `$` matches before a trailing newline; fullmatch does not."""

    def test_trailing_newline_condition_id_refused(self):
        ex = StubExecutor()
        with DBStub():
            result = run(ex.execute(make_approval(
                condition_id=VALID_CONDITION_ID + "\n"
            )))
        self.assertEqual(result.gate_blocked, "invalid_market_identifier")
        self.assertEqual(ex.argv_calls, [])

    def test_trailing_junk_refused(self):
        for suffix in ("\n\n", " ", "\r\n", "extra", "\t"):
            ex = StubExecutor()
            with DBStub():
                result = run(ex.execute(make_approval(
                    condition_id=VALID_CONDITION_ID + suffix
                )))
            self.assertEqual(result.gate_blocked, "invalid_market_identifier")

    def test_leading_junk_refused(self):
        ex = StubExecutor()
        with DBStub():
            result = run(ex.execute(make_approval(
                condition_id="  " + VALID_CONDITION_ID
            )))
        self.assertEqual(result.gate_blocked, "invalid_market_identifier")


class EntryPriceNullTest(unittest.TestCase):
    """M2: an unknown fill price is NULL, never 0.0."""

    def test_no_price_anywhere_records_null_not_zero(self):
        stdout = json.dumps({"success": True, "response": {"orderID": "0xo"}})
        # GATE 8 needs SOME price to convert the notional into shares, and
        # market_probability=0 removes the candidate's. The live Gamma price
        # supplies it, which is the real arrangement: the gate reads the market,
        # the RECORDING path here still has no fill price to work from. Without
        # this the gate refuses first and this test stops covering _derive_entry.
        ex = StubExecutor(stdout=stdout, order_constraints=(5.0, 0.40))
        with DBStub() as db:
            # market_probability=0 removes the fallback too.
            result = run(ex.execute(make_approval(market_probability=0)))
        self.assertTrue(result.success)
        row = db.written[0]
        self.assertIsNone(row["entry_price"], "0.0 would disable the stop-loss rule")
        self.assertIsNone(row["shares"])

    def test_derive_entry_returns_none_prices_when_unusable(self):
        price, shares, usdc = TradeExecutor._derive_entry(
            make_candidate(market_probability=0), {"response": {}}
        )
        self.assertIsNone(price)
        self.assertIsNone(shares)
        # The proposal is still the best available cost figure.
        self.assertEqual(usdc, 5.0)


class HappyPathTest(unittest.TestCase):
    def test_all_gates_pass_order_placed_position_written_telegram_sent(self):
        ex = StubExecutor()
        with DBStub() as db:
            result = run(ex.execute(make_approval()))

        self.assertTrue(result.success)
        self.assertIsNone(result.gate_blocked)
        self.assertEqual(result.position_id, "pos-uuid-1")
        self.assertEqual(result.tx_hash, "0xorder123")

        self.assertEqual(len(ex.argv_calls), 1)
        argv = ex.argv_calls[0]
        self.assertIsInstance(argv, list)
        self.assertEqual(argv[0], "python3")
        self.assertIn("execute_trade.py", argv[1])
        self.assertEqual(argv[2], "--market")
        self.assertEqual(argv[3], VALID_CONDITION_ID)
        self.assertEqual(argv[4], "--direction")
        self.assertEqual(argv[5], "YES")
        self.assertEqual(argv[6], "--amount")
        self.assertEqual(argv[7], "5.0")

        self.assertEqual(len(db.written), 1)
        row = db.written[0]
        self.assertIsNone(row["market_id"])          # uuid FK stays NULL
        self.assertNotIn("raw_output", row)          # F2: column does not exist
        self.assertNotIn("amount_usdc", row)         # F5: wrong column name
        self.assertNotIn("current_price", row)
        self.assertEqual(row["usdc_amount"], 5.0)
        self.assertEqual(row["direction"], "YES")
        self.assertEqual(row["status"], "open")
        self.assertEqual(row["entry_edge"], 0.2164)
        self.assertEqual(row["entry_simulation_probability"], 0.3039)
        self.assertEqual(row["entry_implied_odds"], 0.0875)
        self.assertEqual(row["tx_hash"], "0xorder123")

        notes = "\n".join(ex.notifications)
        self.assertIn("✅ Trade placed", notes)
        self.assertIn("BUY YES @ $5.00 USDC", notes)
        self.assertIn("Edge: 21.6%", notes)

    def test_fill_price_parsed_from_response(self):
        ex = StubExecutor()
        with DBStub() as db:
            run(ex.execute(make_approval()))
        row = db.written[0]
        self.assertAlmostEqual(row["entry_price"], 0.09)
        self.assertAlmostEqual(row["shares"], round(5.0 / 0.09, 6))

    def test_falls_back_to_scan_price_when_no_fill_in_response(self):
        stdout = json.dumps({"success": True, "response": {"orderID": "0xo"}})
        ex = StubExecutor(stdout=stdout)
        with DBStub() as db:
            result = run(ex.execute(make_approval()))
        self.assertTrue(result.success)
        row = db.written[0]
        self.assertAlmostEqual(row["entry_price"], 0.0875)  # market_probability
        self.assertAlmostEqual(row["shares"], round(5.0 / 0.0875, 6))

    def test_nonsense_fill_price_is_ignored(self):
        """A price outside (0,1] is not a probability — fall back."""
        stdout = json.dumps({"success": True, "response": {"price": "42"}})
        ex = StubExecutor(stdout=stdout)
        with DBStub() as db:
            run(ex.execute(make_approval()))
        self.assertAlmostEqual(db.written[0]["entry_price"], 0.0875)


class RealFillRecordingTest(unittest.TestCase):
    """2026-08-25 audit: record the FILL, not the proposal.

    The reference numbers are position f4be9ee8's real order (0x1938e3c7):
    requested $10, matched 35.211266 shares for a $10.00 notional (avg
    0.284), with a $0.501190 fee visible only in the settlement tx, so the
    true wallet debit was $10.501189.
    """

    @staticmethod
    def real_payload(**overrides):
        payload = {
            "success": True,
            "market_id": VALID_CONDITION_ID,
            "direction": "YES",
            "amount_usdc": 10.0,
            "token_id": "87205176363338",
            "cash_out": 10.501189,
            "cash_out_source": "onchain_receipt",
            "cash_out_error": None,
            "response": {
                "success": True,
                "errorMsg": "",
                "orderID": "0x" + "19" * 32,
                "status": "matched",
                "makingAmount": "10",
                "takingAmount": "35.211266",
                "transactionsHashes": ["0x" + "ae" * 32],
            },
        }
        payload.update(overrides)
        return payload

    def test_matched_amounts_beat_scan_price(self):
        price, shares, usdc = TradeExecutor._derive_entry(
            make_candidate(amount_usdc=10.0, market_probability=0.279),
            self.real_payload(),
        )
        self.assertAlmostEqual(price, 0.284, places=6)
        self.assertAlmostEqual(shares, 35.211266)
        self.assertAlmostEqual(usdc, 10.501189)

    def test_without_cash_out_the_notional_is_recorded(self):
        payload = self.real_payload(cash_out=None, cash_out_error="receipt not available")
        price, shares, usdc = TradeExecutor._derive_entry(
            make_candidate(amount_usdc=10.0, market_probability=0.279), payload
        )
        self.assertAlmostEqual(price, 0.284, places=6)
        self.assertAlmostEqual(usdc, 10.0)

    def test_cash_out_below_notional_is_distrusted(self):
        """A negative fee is not a thing: a cash_out under the matched
        notional means the decode broke, and the notional is the safer lie."""
        payload = self.real_payload(cash_out=4.0)
        _, _, usdc = TradeExecutor._derive_entry(
            make_candidate(amount_usdc=10.0), payload
        )
        self.assertAlmostEqual(usdc, 10.0)

    def test_cash_out_far_above_notional_is_distrusted(self):
        """M1 (PR #94 review): the guard is symmetric. A decode over-count
        (batched settlement, double-transfer chain) must not poison pnl."""
        payload = self.real_payload(cash_out=25.0)  # 2.5x the 10.00 notional
        _, _, usdc = TradeExecutor._derive_entry(
            make_candidate(amount_usdc=10.0), payload
        )
        self.assertAlmostEqual(usdc, 10.0)

    def test_cash_out_just_inside_the_upper_bound_is_accepted(self):
        """The bound is PRICE-AWARE now, so "just inside" is much tighter.

        This used to accept 14.99 against a 10.00 notional, because the flat
        1.5x ceiling was loose by more than 70x at high prices. The real fee
        ratio is 1 + 0.07*(1-price), so at the payload's 0.284 the ceiling is
        1 + 0.0501 + 0.01 tolerance = 1.0601, and 10.60 is the most that can be
        believed.
        """
        payload = self.real_payload(cash_out=10.59)
        _, _, usdc = TradeExecutor._derive_entry(
            make_candidate(amount_usdc=10.0), payload
        )
        self.assertAlmostEqual(usdc, 10.59)

    def test_the_old_flat_ceiling_would_have_believed_a_50_percent_fee(self):
        """What the tightening actually bought.

        14.99 against a 10.00 notional is a 49.9% fee. The old flat 1.5x
        accepted it and wrote it straight into pnl, which feeds Gate 3's
        daily-loss brake. At this price the real fee is 5.01%.
        """
        payload = self.real_payload(cash_out=14.99)
        _, _, usdc = TradeExecutor._derive_entry(
            make_candidate(amount_usdc=10.0), payload
        )
        self.assertAlmostEqual(usdc, 10.0, msg="must fall back to the notional")

    def test_tolerance_has_an_ABSOLUTE_floor_at_small_sizes(self):
        """The ratio alone was worth fractions of a cent at Kelly sizes.

        A false trip records the NOTIONAL, excluding the fee: cost basis
        understated, pnl overstated, GATE 3's daily-loss brake under-triggered.
        That is the unsafe direction, so the floor covers a plausible
        two-price fill rather than being tight.
        """
        # $2 notional at price 0.30: real fee 4.9%, so 2.098. A second maker
        # fill 2c away moves it by ~0.009, which a 1% ratio (0.02) barely
        # covers and the absolute floor (0.03) comfortably does.
        ceiling = executor_mod.TradeExecutor._max_believable_cash_out(2.0, 0.30)
        # The real second-order error for a 2c two-price fill at this size is
        # 0.000045, not the 0.009 an earlier version of this reasoning claimed.
        self.assertGreater(ceiling, 2.098 + 0.000045)
        self.assertAlmostEqual(ceiling, 2.0 * 1.049 + 0.02, places=6)

    def test_the_floor_dominates_at_the_smallest_positions(self):
        small = executor_mod.TradeExecutor._max_believable_cash_out(0.25, 0.30)
        ratio_only = 0.25 * 1.049 + 0.01 * 0.25
        self.assertGreater(small, ratio_only,
                           "a 1% ratio on $0.25 is a quarter of a cent")

    def test_the_ratio_takes_over_at_larger_positions(self):
        big = executor_mod.TradeExecutor._max_believable_cash_out(10.0, 0.30)
        self.assertAlmostEqual(big, 10.0 * 1.049 + 0.10, places=6)

    def test_the_no_price_fallback_is_the_all_prices_worst_case(self):
        """Not the old flat 1.5. That drop is a behaviour change and is pinned
        here because a mutant restoring 1.5 survived the suite."""
        fallback = executor_mod.TradeExecutor._max_believable_cash_out(10.0, None)
        self.assertAlmostEqual(fallback, 10.0 * 1.08 + 0.005, places=6)
        self.assertLess(fallback, 10.0 * 1.5)

    def test_fee_tolerance_constants_are_what_the_reasoning_assumes(self):
        """Pins both, since a mutant widening the ratio 40x survived."""
        self.assertEqual(executor_mod.FEE_TOLERANCE_RATIO, 0.01)
        self.assertEqual(executor_mod.FEE_TOLERANCE_ABS, 0.005)

    def test_the_floor_covers_the_real_second_order_fill_error(self):
        """Derived, not guessed, and the derivation is the corrected one.

        For a symmetric two-price fill the VWAP cancels the first-order term,
        leaving error = 0.07 * shares * (dP/2)^2. At the largest position this
        sizing produces, a full 10c-apart split is 0.00097.
        """
        shares = 2.5 / 0.45
        worst_fill_error = 0.07 * shares * (0.10 / 2) ** 2
        self.assertLess(worst_fill_error, 0.001)
        self.assertGreater(
            executor_mod.FEE_TOLERANCE_ABS, worst_fill_error * 4,
            "the floor must cover the worst plausible fill with headroom",
        )
        self.assertLess(
            executor_mod.FEE_TOLERANCE_ABS, 0.01,
            "wide enough to hide a fee-schedule change defeats the residual check",
        )

    def test_real_fee_ratio_does_not_trip_the_upper_bound(self):
        """The real f4be9ee8 numbers: 10.501189 vs 10.00 notional is 1.05012x,
        against a computed ceiling of 1.0601 at price 0.284. The bound must
        never reject a genuine fee, and the tightened one still does not: the
        margin is 0.0100, which is the tolerance and nothing else."""
        _, _, usdc = TradeExecutor._derive_entry(
            make_candidate(amount_usdc=10.0), self.real_payload()
        )
        self.assertAlmostEqual(usdc, 10.501189)

    def test_upper_bound_uses_proposal_anchor_when_amounts_unparseable(self):
        payload = self.real_payload(cash_out=25.0)
        payload["response"] = {"orderID": "0xo", "status": "matched"}
        _, _, usdc = TradeExecutor._derive_entry(
            make_candidate(amount_usdc=10.0, market_probability=0.279), payload
        )
        self.assertAlmostEqual(usdc, 10.0)

    def test_cash_out_used_even_when_amounts_unparseable(self):
        """Chain truth beats the proposal even if the response shape broke."""
        payload = self.real_payload()
        payload["response"] = {"orderID": "0xo", "status": "matched"}
        price, shares, usdc = TradeExecutor._derive_entry(
            make_candidate(amount_usdc=10.0, market_probability=0.279), payload
        )
        self.assertAlmostEqual(price, 0.279)  # scan fallback
        self.assertAlmostEqual(usdc, 10.501189)

    def test_unmatched_status_never_uses_amounts(self):
        payload = self.real_payload(cash_out=None)
        payload["response"]["status"] = "unmatched"
        price, shares, usdc = TradeExecutor._derive_entry(
            make_candidate(amount_usdc=10.0, market_probability=0.279), payload
        )
        self.assertAlmostEqual(price, 0.279)
        self.assertAlmostEqual(shares, round(10.0 / 0.279, 6))
        self.assertAlmostEqual(usdc, 10.0)

    def test_amounts_implying_impossible_price_are_ignored(self):
        payload = self.real_payload(cash_out=None)
        payload["response"]["makingAmount"] = "50"  # price 50/35.21 > 1
        price, _, usdc = TradeExecutor._derive_entry(
            make_candidate(amount_usdc=10.0, market_probability=0.279), payload
        )
        self.assertAlmostEqual(price, 0.279)
        self.assertAlmostEqual(usdc, 10.0)

    def test_end_to_end_row_records_fill_and_settlement_hash(self):
        ex = StubExecutor(stdout=json.dumps(self.real_payload()))
        with DBStub() as db:
            result = run(ex.execute(make_approval(
                amount_usdc=10.0, market_probability=0.279,
            )))
        self.assertTrue(result.success)
        row = db.written[0]
        self.assertAlmostEqual(row["entry_price"], 0.284, places=6)
        self.assertAlmostEqual(row["shares"], 35.211266)
        self.assertAlmostEqual(row["usdc_amount"], 10.501189)
        # The settlement tx, NOT the order id.
        self.assertEqual(row["tx_hash"], "0x" + "ae" * 32)


class TxHashPreferenceTest(unittest.TestCase):
    def test_settlement_hash_preferred_over_order_id(self):
        got = TradeExecutor._extract_tx_hash({"response": {
            "orderID": "0xorder", "transactionsHashes": ["0xsettle1", "0xsettle2"],
        }})
        self.assertEqual(got, "0xsettle1")

    def test_order_id_fallback_when_no_hashes(self):
        got = TradeExecutor._extract_tx_hash({"response": {
            "orderID": "0xorder", "transactionsHashes": [],
        }})
        self.assertEqual(got, "0xorder")

    def test_non_string_hash_entries_are_skipped(self):
        got = TradeExecutor._extract_tx_hash({"response": {
            "orderID": "0xorder", "transactionsHashes": [None, 7, "0xsettle"],
        }})
        self.assertEqual(got, "0xsettle")


class RelayTimeoutTest(unittest.TestCase):
    """H1 (PR #94 review): a relay READ timeout correlates with the order
    having ALREADY been placed (the relay decodes the settlement after the
    fill), so it must surface as ORDER STATUS UNKNOWN, never 'Trade failed'."""

    def test_relay_read_timeout_reports_status_unknown_not_failed(self):
        stdout = json.dumps(
            {"error": "relay_timeout_order_status_unknown: ReadTimeout"}
        )
        ex = StubExecutor(stdout=stdout, returncode=1)
        with DBStub() as db:
            result = run(ex.execute(make_approval()))

        self.assertFalse(result.success)
        self.assertEqual(result.error, "relay_timeout_status_unknown")
        self.assertEqual(db.written, [], "an unknown-status order writes no row")

        notes = "\n".join(ex.notifications)
        self.assertIn("UNKNOWN", notes)
        self.assertIn("reconcile", notes)
        self.assertNotIn("Trade failed", notes)

    def test_plain_relay_unreachable_still_reports_failed(self):
        stdout = json.dumps({"error": "relay_unreachable: ConnectTimeout"})
        ex = StubExecutor(stdout=stdout, returncode=1)
        with DBStub() as db:
            result = run(ex.execute(make_approval()))
        self.assertEqual(result.error, "execution_failed")
        self.assertEqual(db.written, [])
        self.assertIn("Trade failed", "\n".join(ex.notifications))


class FailurePathTest(unittest.TestCase):
    def test_subprocess_nonzero_exit_returns_failure(self):
        ex = StubExecutor(
            stdout=json.dumps({"error": "Market not found"}), returncode=1
        )
        with DBStub() as db:
            result = run(ex.execute(make_approval()))
        self.assertFalse(result.success)
        self.assertEqual(result.error, "execution_failed")
        self.assertEqual(db.written, [], "a failed trade must not write a position")
        self.assertTrue(any("❌ Trade failed" in n for n in ex.notifications))

    def test_error_json_on_stdout_with_exit_zero_still_fails(self):
        """execute_trade.py reports handled errors on stdout; trust the payload."""
        ex = StubExecutor(stdout=json.dumps({"error": "boom"}), returncode=0)
        with DBStub() as db:
            result = run(ex.execute(make_approval()))
        self.assertFalse(result.success)
        self.assertEqual(db.written, [])

    def test_subprocess_timeout_returns_failure_not_raise(self):
        ex = StubExecutor(
            raises=subprocess.TimeoutExpired(cmd="execute_trade.py", timeout=60)
        )
        with DBStub() as db:
            result = run(ex.execute(make_approval()))
        self.assertFalse(result.success)
        self.assertEqual(result.error, "execution_timeout")
        self.assertEqual(db.written, [])
        self.assertTrue(any("UNKNOWN" in n for n in ex.notifications))

    def test_launch_failure_returns_failure(self):
        ex = StubExecutor(raises=FileNotFoundError("no python3"))
        with DBStub():
            result = run(ex.execute(make_approval()))
        self.assertFalse(result.success)
        self.assertEqual(result.error, "execution_failed")

    def test_non_json_stdout_treated_as_failure(self):
        ex = StubExecutor(stdout="Traceback (most recent call last): ...", returncode=1)
        with DBStub() as db:
            result = run(ex.execute(make_approval()))
        self.assertFalse(result.success)
        self.assertEqual(db.written, [])

    def test_trade_placed_but_write_fails_reports_success_and_shouts(self):
        """Money is spent. Reporting this as a failed trade would be a lie."""
        ex = StubExecutor()
        with DBStub(
            write_raises=executor_mod.SupabaseError("POST", "/p", 400, "bad column")
        ):
            result = run(ex.execute(make_approval()))
        self.assertTrue(result.success)
        self.assertEqual(result.error, "position_not_recorded")
        self.assertEqual(result.tx_hash, "0xorder123")
        self.assertTrue(any("NOT recorded" in n for n in ex.notifications))

    def test_never_raises_on_unexpected_gate_error(self):
        ex = StubExecutor()
        with DBStub(config_raises=RuntimeError("totally unexpected")):
            result = run(ex.execute(make_approval()))
        self.assertFalse(result.success)
        self.assertEqual(result.gate_blocked, "gate_error")


class SubprocessSafetyTest(unittest.TestCase):
    def test_no_secret_in_argv(self):
        ex = StubExecutor()
        with DBStub():
            run(ex.execute(make_approval()))
        argv = ex.argv_calls[0]
        joined = " ".join(argv)
        self.assertNotIn(os.environ["POLYMARKET_PRIVATE_KEY"], joined)
        self.assertNotIn(os.environ["POLYMARKET_FUNDER_ADDRESS"], joined)
        for token in ("--key", "--private-key", "--funder"):
            self.assertNotIn(token, argv)

    def test_a_fractional_notional_reaches_argv_intact(self):
        """5.0 is invariant under round(x,2), round(x,6) AND ceil-to-cent, so
        pinning only that value proves nothing about rounding. A real Kelly
        notional is fractional, and rounding it UP is the one thing sizing.py
        forbids in capitals: it spends more than Kelly sized."""
        for amount in (1.183712, 0.256841, 2.499999):
            with self.subTest(amount=amount):
                ex = StubExecutor(order_constraints=(0.1, 0.40))
                with DBStub():
                    result = run(ex.execute(make_approval(amount_usdc=amount)))
                self.assertTrue(result.success)
                self.assertEqual(ex.argv_calls[0][7], str(amount))
                self.assertEqual(float(ex.argv_calls[0][7]), amount)

    def test_real_runner_uses_arg_array_not_a_shell(self):
        """Proves no shell interpretation: metacharacters stay literal.

        Exercises the REAL _run_script (not the stub) against a harmless
        python3 -c, passing an argument full of shell syntax. Under shell=True
        this would run `echo` and/or truncate; with an arg array it comes back
        verbatim.
        """
        hostile = "; echo pwned > /tmp/pwned; $(whoami) `id` && rm -rf /"
        real = TradeExecutor(token="t", chat_id="c")
        completed = run(real._run_script([
            "python3", "-c", "import sys; print(sys.argv[1])", hostile,
        ]))
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout.strip(), hostile)
        self.assertFalse(
            os.path.exists("/tmp/pwned"), "shell metacharacters were interpreted"
        )

    def test_condition_id_is_what_reaches_the_script(self):
        """F1 regression: the numeric market_id must never be the --market value."""
        ex = StubExecutor()
        with DBStub():
            run(ex.execute(make_approval()))
        argv = ex.argv_calls[0]
        self.assertEqual(argv[argv.index("--market") + 1], VALID_CONDITION_ID)
        self.assertNotIn("3158105", argv)


class ScannerWiringTest(unittest.TestCase):
    def _summary(self, approval):
        return ScannerRunSummary(
            run_at=datetime.now(timezone.utc), markets_fetched=1,
            candidates_analysed=1, simulations_run=1, sim_errors=0,
            best_trade=approval.candidate if approval else None,
            approval_result=approval,
        )

    def test_approved_triggers_execution(self):
        ex = StubExecutor()
        scanner = PolymarketScanner(executor=ex)
        summary = self._summary(make_approval())
        with DBStub():
            run(scanner.apply_execution(summary))
        self.assertIsNotNone(summary.execution_result)
        self.assertTrue(summary.execution_result.success)
        self.assertEqual(len(ex.argv_calls), 1)

    def test_non_approved_statuses_never_execute(self):
        for status in (ApprovalStatus.skipped, ApprovalStatus.timeout,
                       ApprovalStatus.analyst_skip):
            ex = StubExecutor()
            scanner = PolymarketScanner(executor=ex)
            summary = self._summary(make_approval(status=status))
            with DBStub():
                run(scanner.apply_execution(summary))
            self.assertIsNone(summary.execution_result)
            self.assertEqual(ex.argv_calls, [])

    def test_no_approval_result_never_executes(self):
        ex = StubExecutor()
        scanner = PolymarketScanner(executor=ex)
        summary = self._summary(None)
        with DBStub():
            run(scanner.apply_execution(summary))
        self.assertIsNone(summary.execution_result)
        self.assertEqual(ex.argv_calls, [])

    def test_no_executor_configured_places_nothing(self):
        scanner = PolymarketScanner(executor=None)
        summary = self._summary(make_approval())
        with DBStub():
            run(scanner.apply_execution(summary))
        self.assertIsNone(summary.execution_result)

    def test_condition_id_survives_to_candidate(self):
        """The scanner must carry condition_id, or gate 6 refuses everything."""
        row = {
            "market_id": "3158105",
            "condition_id": VALID_CONDITION_ID,
            "slug": "eth-above-1900",
            "question": "Will ETH be above $1,900?",
            "asset": "eth",
            "yes_price": 0.0875,
            "volume": 37494.25,
            "horizon_days": 1,
        }
        candidate = PolymarketScanner._to_candidate(row, 0.2164, 0.3039)
        self.assertEqual(candidate.condition_id, VALID_CONDITION_ID)
        self.assertEqual(candidate.market_id, "3158105")


if __name__ == "__main__":
    unittest.main()
