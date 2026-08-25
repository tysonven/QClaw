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
        market_url="https://polymarket.com/market/eth-above-1900",
        amount_usdc=5.0,
    )
    base.update(overrides)
    return ScannerCandidate(**base)


def make_approval(status=ApprovalStatus.approved, **cand) -> ApprovalResult:
    return ApprovalResult(
        approval_id="ap-1",
        status=status,
        candidate=make_candidate(**cand),
        recommendation=AnalystRecommendation(
            recommendation="reduce", confidence=0.45,
            reasoning="Edge is wide but history is thin.", flags=[],
        ),
        decided_at=datetime.now(timezone.utc),
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


class StubExecutor(TradeExecutor):
    """TradeExecutor with the subprocess and Telegram edges replaced."""

    def __init__(self, *, stdout=SUCCESS_STDOUT, returncode=0, raises=None, **kw):
        kw.setdefault("token", "test-token")
        kw.setdefault("chat_id", "1375806243")
        super().__init__(**kw)
        self.stdout = stdout
        self.returncode = returncode
        self.raises = raises
        self.argv_calls: list[list[str]] = []
        self.notifications: list[str] = []

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
        ex = StubExecutor(stdout=stdout)
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
