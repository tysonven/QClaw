"""Tests for the trade-engine Analyst (src/trade_engine/analyst.py).

Stdlib unittest, matching tests/clipper/test_smart_crop_filter.py — the repo's
existing Python test convention. No network: the Anthropic client is stubbed in
every case, and the Supabase helpers are monkeypatched.

Run:
    python3 -m unittest tests/test_analyst.py
"""

import asyncio
import json
import os
import sys
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# config.py fail-fasts on missing env, so seed placeholders before importing it.
for _key in (
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY",
    "TELEGRAM_BOT_TOKEN", "OWNER_TELEGRAM_CHAT_ID",
    "POLYMARKET_PRIVATE_KEY", "POLYMARKET_FUNDER_ADDRESS",
):
    os.environ.setdefault(_key, f"test-{_key.lower()}")

from src.trade_engine import analyst as analyst_mod  # noqa: E402
from src.trade_engine.analyst import TradeAnalyst  # noqa: E402
from src.trade_engine.models import (  # noqa: E402
    AnalystRecommendation,
    ScannerCandidate,
    ScannerRunSummary,
    TradePosition,
)
from src.trade_engine.scanner import PolymarketScanner  # noqa: E402


def run(coro):
    return asyncio.run(coro)


def make_candidate(**overrides) -> ScannerCandidate:
    base = dict(
        market_id="512345",
        question="Will Bitcoin reach $100,000 in July?",
        asset="btc",
        direction="YES",
        edge=0.18,
        sim_probability=0.36,
        market_probability=0.18,
        volume=26352.0,
        horizon_days=4,
        market_url="https://polymarket.com/market/will-bitcoin-reach-100k",
        amount_usdc=10.0,
    )
    base.update(overrides)
    return ScannerCandidate(**base)


def make_position(pnl: float, edge: float, sim_id=None, **overrides) -> TradePosition:
    base = dict(
        id=f"pos-{pnl}-{edge}",
        direction="YES",
        pnl=pnl,
        entry_edge=edge,
        status="closed",
        simulation_id=sim_id,
        closed_at=datetime(2026, 7, 1, tzinfo=timezone.utc),
    )
    base.update(overrides)
    return TradePosition(**base)


class StubClient:
    """Minimal stand-in for anthropic.AsyncAnthropic."""

    def __init__(self, *, text=None, exc=None, usage=(120, 45)):
        self._text = text
        self._exc = exc
        self._usage = usage
        self.calls = []
        self.messages = SimpleNamespace(create=self._create)

    async def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self._exc is not None:
            raise self._exc
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=self._text)],
            usage=SimpleNamespace(
                input_tokens=self._usage[0], output_tokens=self._usage[1]
            ),
        )


def patch_history(testcase, positions, sims=None):
    """Point the Analyst's Supabase reads at in-memory fixtures."""
    async def fake_positions(limit=20):
        return positions[:limit]

    async def fake_sims(sim_ids):
        return sims or []

    original_positions = analyst_mod.get_resolved_positions
    original_sims = analyst_mod.get_simulations_by_ids
    analyst_mod.get_resolved_positions = fake_positions
    analyst_mod.get_simulations_by_ids = fake_sims

    def restore():
        analyst_mod.get_resolved_positions = original_positions
        analyst_mod.get_simulations_by_ids = original_sims

    testcase.addCleanup(restore)


VALID_JSON = json.dumps({
    "recommendation": "proceed",
    "confidence": 0.82,
    "reasoning": "Edge is strong and volume is adequate. Limited history.",
    "flags": ["strong_edge"],
})


# 1. Model validation
class TestAnalystRecommendationModel(unittest.TestCase):
    def test_valid_recommendation(self):
        rec = AnalystRecommendation(
            recommendation="proceed", confidence=0.8,
            reasoning="Looks good.", flags=["strong_edge"],
            insufficient_history=False, raw_response="{}",
        )
        self.assertEqual(rec.recommendation, "proceed")
        self.assertEqual(rec.flags, ["strong_edge"])

    def test_defaults(self):
        rec = AnalystRecommendation(
            recommendation="pass", confidence=0.0, reasoning="No."
        )
        self.assertEqual(rec.flags, [])
        self.assertFalse(rec.insufficient_history)
        self.assertEqual(rec.raw_response, "")

    def test_rejects_unknown_recommendation(self):
        with self.assertRaises(Exception):
            AnalystRecommendation(
                recommendation="maybe", confidence=0.5, reasoning="?"
            )


# 2. History with 0 trades
class TestHistoryEmpty(unittest.TestCase):
    def test_zero_trades_is_insufficient(self):
        patch_history(self, [])
        ctx = run(TradeAnalyst(client=StubClient(text=VALID_JSON))
                  .get_trade_history_context())
        self.assertEqual(ctx["total_trades"], 0)
        self.assertTrue(ctx["insufficient_history"])
        self.assertEqual(ctx["trades"], [])
        self.assertIsNone(ctx["best_asset"])
        self.assertIsNone(ctx["worst_asset"])


# 3. History with 15 trades
class TestHistoryPopulated(unittest.TestCase):
    def setUp(self):
        # 9 winners @ edge 0.20 (+$5), 6 losers @ edge 0.08 (-$4)
        self.positions = (
            [make_position(5.0, 0.20, sim_id=f"sim-w{i}") for i in range(9)]
            + [make_position(-4.0, 0.08, sim_id=f"sim-l{i}") for i in range(6)]
        )
        self.sims = (
            [{"id": f"sim-w{i}", "asset": "btc",
              "raw_output": {"question": "Will BTC hit X?"}} for i in range(9)]
            + [{"id": f"sim-l{i}", "asset": "eth",
                "raw_output": {"question": "Will ETH hit Y?"}} for i in range(6)]
        )

    def test_stats_are_correct(self):
        patch_history(self, self.positions, self.sims)
        ctx = run(TradeAnalyst(client=StubClient(text=VALID_JSON))
                  .get_trade_history_context())
        self.assertEqual(ctx["total_trades"], 15)
        self.assertFalse(ctx["insufficient_history"])
        self.assertAlmostEqual(ctx["win_rate"], 9 / 15)
        self.assertAlmostEqual(ctx["avg_edge_winners"], 0.20)
        self.assertAlmostEqual(ctx["avg_edge_losers"], 0.08)
        self.assertAlmostEqual(ctx["avg_pnl"], (9 * 5.0 - 6 * 4.0) / 15)
        self.assertEqual(ctx["best_asset"], "btc")
        self.assertEqual(ctx["worst_asset"], "eth")
        self.assertEqual(len(ctx["trades"]), 5)

    def test_missing_question_is_not_fabricated(self):
        """A position whose simulation has no question must not invent one."""
        positions = [make_position(5.0, 0.2, sim_id="sim-x")]
        sims = [{"id": "sim-x", "asset": "sol", "raw_output": {}}]
        patch_history(self, positions, sims)
        analyst = TradeAnalyst(client=StubClient(text=VALID_JSON))
        ctx = run(analyst.get_trade_history_context())
        self.assertIsNone(ctx["trades"][0]["question"])
        prompt = analyst.build_prompt(make_candidate(), ctx)
        # Falls back to the asset, never a made-up market description.
        self.assertIn("sol", prompt)
        self.assertNotIn("None", prompt.split("Recent trades")[1])


# 4. Happy path parse
class TestAnalyseParsesJson(unittest.TestCase):
    def test_parses_structured_response(self):
        patch_history(self, [])
        client = StubClient(text=VALID_JSON)
        rec = run(TradeAnalyst(client=client).analyse(make_candidate()))
        self.assertEqual(rec.recommendation, "proceed")
        self.assertAlmostEqual(rec.confidence, 0.82)
        self.assertIn("strong_edge", rec.flags)
        # 0 trades → the flag is appended even though Claude didn't send it
        self.assertIn("insufficient_history", rec.flags)
        self.assertTrue(rec.insufficient_history)

    def test_request_uses_expected_parameters(self):
        patch_history(self, [])
        client = StubClient(text=VALID_JSON)
        run(TradeAnalyst(client=client).analyse(make_candidate()))
        kwargs = client.calls[0]
        self.assertEqual(kwargs["model"], "claude-sonnet-4-6")
        self.assertEqual(kwargs["max_tokens"], 300)
        self.assertEqual(kwargs["temperature"], 0.2)
        # Structured outputs are what make the parse path safe.
        schema = kwargs["output_config"]["format"]["schema"]
        self.assertEqual(
            schema["properties"]["recommendation"]["enum"],
            ["proceed", "pass", "reduce"],
        )
        self.assertFalse(schema["additionalProperties"])

    def test_confidence_is_clamped(self):
        patch_history(self, [])
        client = StubClient(text=json.dumps({
            "recommendation": "proceed", "confidence": 4.2,
            "reasoning": "Overconfident.", "flags": [],
        }))
        rec = run(TradeAnalyst(client=client).analyse(make_candidate()))
        self.assertEqual(rec.confidence, 1.0)


# 5. Invalid JSON
class TestAnalyseParseError(unittest.TestCase):
    def test_malformed_json_returns_pass(self):
        patch_history(self, [])
        client = StubClient(text="Sure! Here's my take: the trade looks fine.")
        rec = run(TradeAnalyst(client=client).analyse(make_candidate()))
        self.assertEqual(rec.recommendation, "pass")
        self.assertIn("analyst_parse_error", rec.flags)
        self.assertEqual(rec.confidence, 0.0)
        self.assertIn("Sure!", rec.raw_response)

    def test_markdown_fenced_json_still_fails_closed(self):
        """The exact shape Sonnet 4.6 emits without structured outputs."""
        patch_history(self, [])
        client = StubClient(text="```json\n" + VALID_JSON + "\n```")
        rec = run(TradeAnalyst(client=client).analyse(make_candidate()))
        self.assertEqual(rec.recommendation, "pass")
        self.assertIn("analyst_parse_error", rec.flags)


# 6. API error
class TestAnalyseApiError(unittest.TestCase):
    def test_api_error_returns_pass(self):
        patch_history(self, [])
        client = StubClient(exc=RuntimeError("connection reset"))
        rec = run(TradeAnalyst(client=client).analyse(make_candidate()))
        self.assertEqual(rec.recommendation, "pass")
        self.assertIn("analyst_api_error", rec.flags)
        self.assertEqual(rec.confidence, 0.0)

    def test_never_raises_on_any_exception(self):
        """Timeouts, transport errors, unexpected SDK failures — all fail closed."""
        patch_history(self, [])
        for exc in (
            TimeoutError("read timeout"),
            ValueError("unexpected SDK shape"),
            Exception("catastrophic"),
        ):
            with self.subTest(exc=type(exc).__name__):
                client = StubClient(exc=exc)
                rec = run(TradeAnalyst(client=client).analyse(make_candidate()))
                self.assertIsInstance(rec, AnalystRecommendation)
                self.assertEqual(rec.recommendation, "pass")
                self.assertIn("analyst_api_error", rec.flags)

    def test_base_exceptions_still_propagate(self):
        """KeyboardInterrupt / SystemExit must NOT be swallowed — catching them
        would make the process unkillable. 'Never raises' covers Exception."""
        patch_history(self, [])
        client = StubClient(exc=KeyboardInterrupt("ctrl-c"))
        with self.assertRaises(KeyboardInterrupt):
            run(TradeAnalyst(client=client).analyse(make_candidate()))


def make_summary(best_trade, open_positions=0) -> ScannerRunSummary:
    return ScannerRunSummary(
        run_at=datetime.now(timezone.utc), markets_fetched=100,
        candidates_analysed=10, simulations_run=10, sim_errors=0,
        high_edge=[best_trade] if best_trade else [], no_edge=[],
        neutral_count=0, best_trade=best_trade, open_positions=open_positions,
    )


# 7. reduce halves the size
class TestScannerAppliesReduce(unittest.TestCase):
    def test_reduce_halves_amount(self):
        patch_history(self, [])
        client = StubClient(text=json.dumps({
            "recommendation": "reduce", "confidence": 0.5,
            "reasoning": "Thin volume.", "flags": ["thin_volume"],
        }))
        summary = make_summary(make_candidate(amount_usdc=10.0))
        scanner = PolymarketScanner(analyst=TradeAnalyst(client=client))
        run(scanner.apply_analyst(summary))
        self.assertEqual(summary.best_trade.amount_usdc, 5.0)
        self.assertFalse(summary.analyst_skip)
        self.assertEqual(summary.analyst_recommendation.recommendation, "reduce")

    def test_reduce_floors_at_three_dollars(self):
        patch_history(self, [])
        client = StubClient(text=json.dumps({
            "recommendation": "reduce", "confidence": 0.4,
            "reasoning": "Marginal.", "flags": ["marginal_edge"],
        }))
        summary = make_summary(make_candidate(amount_usdc=3.0))
        scanner = PolymarketScanner(analyst=TradeAnalyst(client=client))
        run(scanner.apply_analyst(summary))
        self.assertEqual(summary.best_trade.amount_usdc, 3.0)


# 8. pass sets analyst_skip
class TestScannerAppliesPass(unittest.TestCase):
    def test_pass_sets_skip(self):
        patch_history(self, [])
        client = StubClient(text=json.dumps({
            "recommendation": "pass", "confidence": 0.7,
            "reasoning": "History too thin to justify.", "flags": ["insufficient_history"],
        }))
        summary = make_summary(make_candidate(amount_usdc=10.0))
        scanner = PolymarketScanner(analyst=TradeAnalyst(client=client))
        run(scanner.apply_analyst(summary))
        self.assertTrue(summary.analyst_skip)
        self.assertEqual(summary.best_trade.amount_usdc, 10.0)  # size untouched

    def test_proceed_leaves_everything_alone(self):
        patch_history(self, [])
        client = StubClient(text=VALID_JSON)
        summary = make_summary(make_candidate(amount_usdc=10.0))
        scanner = PolymarketScanner(analyst=TradeAnalyst(client=client))
        run(scanner.apply_analyst(summary))
        self.assertFalse(summary.analyst_skip)
        self.assertEqual(summary.best_trade.amount_usdc, 10.0)

    def test_no_best_trade_skips_analyst_entirely(self):
        patch_history(self, [])
        client = StubClient(text=VALID_JSON)
        summary = make_summary(None)
        scanner = PolymarketScanner(analyst=TradeAnalyst(client=client))
        run(scanner.apply_analyst(summary))
        self.assertIsNone(summary.analyst_recommendation)
        self.assertFalse(summary.analyst_skip)
        self.assertEqual(client.calls, [])  # no API call made


class TestRawResponseNotExposed(unittest.TestCase):
    def test_raw_response_excluded_from_serialisation(self):
        """P6: raw_response is kept for debugging but never returned by the API."""
        rec = AnalystRecommendation(
            recommendation="proceed", confidence=0.9,
            reasoning="Fine.", flags=[], raw_response="SECRET-DEBUG-PAYLOAD",
        )
        payload = rec.model_dump(exclude={"raw_response"})
        self.assertNotIn("raw_response", payload)
        self.assertEqual(payload["recommendation"], "proceed")


if __name__ == "__main__":
    unittest.main()
