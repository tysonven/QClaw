"""Tests for the trade-engine approval gate (src/trade_engine/approval.py).

Stdlib unittest, matching tests/test_analyst.py — the repo's Python test
convention. No network: every Telegram call goes through a recording stub, so
these run offline and never touch a real bot.

Run:
    python3 -m unittest tests/test_approval.py
"""

import asyncio
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# config.py fail-fasts on missing env, so seed placeholders before importing it.
for _key in (
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY",
    "TELEGRAM_BOT_TOKEN", "OWNER_TELEGRAM_CHAT_ID",
    "POLYMARKET_PRIVATE_KEY", "POLYMARKET_FUNDER_ADDRESS",
):
    os.environ.setdefault(_key, f"test-{_key.lower()}")

from src.trade_engine.approval import (  # noqa: E402
    ApprovalGate,
    ApprovalGateBusy,
    run_update_poller,
)
from src.trade_engine.models import (  # noqa: E402
    AnalystRecommendation,
    ApprovalResult,
    ApprovalStatus,
    PendingApproval,
    ScannerCandidate,
    ScannerRunSummary,
)
from src.trade_engine.scanner import PolymarketScanner  # noqa: E402

OWNER_CHAT_ID = "1375806243"


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


def make_recommendation(**overrides) -> AnalystRecommendation:
    base = dict(
        recommendation="proceed",
        confidence=0.72,
        reasoning="Edge is wide and the horizon is short.",
        flags=[],
        raw_response="{...}",
    )
    base.update(overrides)
    return AnalystRecommendation(**base)


class StubGate(ApprovalGate):
    """ApprovalGate with the Telegram transport replaced by a recorder.

    Overriding _api rather than stubbing httpx keeps the test surface at the
    API-method boundary: assertions read as "sendMessage was called with this
    payload", which is what the contract with Telegram actually is.
    """

    def __init__(self, **kwargs):
        kwargs.setdefault("chat_id", OWNER_CHAT_ID)
        kwargs.setdefault("token", "test-token")
        super().__init__(**kwargs)
        self.calls: list[tuple[str, dict]] = []
        self.fail_methods: set[str] = set()
        self._message_id = 4200

    async def _api(self, method, payload):
        self.calls.append((method, payload))
        if method in self.fail_methods:
            return None
        if method == "sendMessage":
            self._message_id += 1
            return {"message_id": self._message_id}
        return {}

    def calls_to(self, method: str) -> list[dict]:
        return [payload for name, payload in self.calls if name == method]


def callback(data: str, *, query_id: str = "cbq-1", sender: str = OWNER_CHAT_ID) -> dict:
    return {"id": query_id, "data": data, "from": {"id": sender}}


class PendingApprovalModelTest(unittest.TestCase):
    def test_expires_at_is_thirty_minutes_after_created_at(self):
        gate = StubGate()
        self.assertEqual(gate.timeout_seconds, 1800)

        pending = run(gate.send_approval_request(make_candidate(), make_recommendation()))

        self.assertEqual(
            pending.expires_at - pending.created_at, timedelta(minutes=30)
        )

    def test_model_accepts_explicit_fields(self):
        created = datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc)
        pending = PendingApproval(
            approval_id="a-1",
            candidate=make_candidate(),
            recommendation=make_recommendation(),
            created_at=created,
            expires_at=created + timedelta(minutes=30),
        )
        self.assertIsNone(pending.message_id)


class ApprovalResultModelTest(unittest.TestCase):
    def test_validates_and_serialises_status_as_plain_string(self):
        result = ApprovalResult(
            approval_id="a-1",
            status=ApprovalStatus.approved,
            candidate=make_candidate(),
            recommendation=make_recommendation(),
            decided_at=datetime.now(timezone.utc),
            decision_source="user",
        )
        self.assertEqual(result.status, "approved")
        self.assertEqual(result.model_dump()["status"], "approved")

    def test_rejects_unknown_status(self):
        with self.assertRaises(Exception):
            ApprovalResult(
                approval_id="a-1",
                status="definitely_not_a_status",
                candidate=make_candidate(),
                recommendation=make_recommendation(),
                decided_at=datetime.now(timezone.utc),
                decision_source="user",
            )

    def test_summary_defaults_approval_result_to_none(self):
        summary = ScannerRunSummary(
            run_at=datetime.now(timezone.utc),
            markets_fetched=0, candidates_analysed=0,
            simulations_run=0, sim_errors=0,
        )
        self.assertIsNone(summary.approval_result)


class SendApprovalRequestTest(unittest.TestCase):
    def test_message_shape_and_inline_keyboard(self):
        gate = StubGate()
        candidate = make_candidate()
        recommendation = make_recommendation()

        pending = run(gate.send_approval_request(candidate, recommendation))

        sends = gate.calls_to("sendMessage")
        self.assertEqual(len(sends), 1)
        payload = sends[0]
        self.assertEqual(payload["chat_id"], OWNER_CHAT_ID)

        text = payload["text"]
        self.assertIn("🎯 Trade Opportunity", text)
        self.assertIn("Will Bitcoin reach $100,000 in July?", text)
        self.assertIn("Direction: BUY YES", text)
        self.assertIn("Edge: +18.0% (Sim: 36.0% vs Market: 18.0%)", text)
        self.assertIn("Volume: $26,352 | Horizon: 4d", text)
        self.assertIn("Position: $10.00", text)
        self.assertIn("📊 Analyst: PROCEED (72% confidence)", text)
        self.assertIn('"Edge is wide and the horizon is short."', text)
        self.assertIn(candidate.market_url, text)

        # Plain text: a market question containing Markdown must not be parsed.
        self.assertNotIn("parse_mode", payload)

        buttons = payload["reply_markup"]["inline_keyboard"][0]
        self.assertEqual(len(buttons), 2)
        self.assertEqual(buttons[0]["callback_data"], f"approve:{pending.approval_id}")
        self.assertEqual(buttons[1]["callback_data"], f"skip:{pending.approval_id}")
        self.assertIn("Execute", buttons[0]["text"])
        self.assertIn("Skip", buttons[1]["text"])

        # callback_data must fit Telegram's 64-byte cap.
        for button in buttons:
            self.assertLessEqual(len(button["callback_data"].encode()), 64)

        self.assertEqual(pending.message_id, 4201)
        self.assertEqual(gate.pending_count, 1)

    def test_negative_edge_renders_signed_not_double_signed(self):
        gate = StubGate()
        run(gate.send_approval_request(
            make_candidate(edge=-0.05), make_recommendation()
        ))
        self.assertIn("Edge: -5.0%", gate.calls_to("sendMessage")[0]["text"])

    def test_failed_delivery_clears_the_gate(self):
        gate = StubGate()
        gate.fail_methods = {"sendMessage"}

        with self.assertRaises(ApprovalGateBusy):
            run(gate.send_approval_request(make_candidate(), make_recommendation()))

        # A message nobody received must not hold the gate for 30 minutes.
        self.assertEqual(gate.pending_count, 0)


class HandleCallbackTest(unittest.TestCase):
    def test_approve_path_returns_approved_result(self):
        gate = StubGate()
        pending = run(gate.send_approval_request(make_candidate(), make_recommendation()))

        result = run(gate.handle_callback(callback(f"approve:{pending.approval_id}")))

        self.assertIsNotNone(result)
        self.assertEqual(result.status, ApprovalStatus.approved)
        self.assertEqual(result.decision_source, "user")
        self.assertEqual(result.approval_id, pending.approval_id)
        self.assertEqual(result.candidate.market_id, "512345")
        self.assertEqual(gate.pending_count, 0)

        # Spinner dismissed, message rewritten, keyboard dropped.
        answers = gate.calls_to("answerCallbackQuery")
        self.assertEqual(len(answers), 1)
        self.assertEqual(answers[0]["callback_query_id"], "cbq-1")
        edits = gate.calls_to("editMessageText")
        self.assertEqual(len(edits), 1)
        self.assertIn("✅ APPROVED — executing trade", edits[0]["text"])
        self.assertNotIn("reply_markup", edits[0])

    def test_skip_path_returns_skipped_result(self):
        gate = StubGate()
        pending = run(gate.send_approval_request(make_candidate(), make_recommendation()))

        result = run(gate.handle_callback(callback(f"skip:{pending.approval_id}")))

        self.assertEqual(result.status, ApprovalStatus.skipped)
        self.assertEqual(result.decision_source, "user")
        self.assertEqual(gate.pending_count, 0)
        self.assertIn(
            "❌ SKIPPED — trade passed", gate.calls_to("editMessageText")[0]["text"]
        )

    def test_expired_approval_returns_none_and_answers_callback(self):
        gate = StubGate()
        pending = run(gate.send_approval_request(make_candidate(), make_recommendation()))
        # Force expiry without waiting out the window.
        gate._pending[pending.approval_id].expires_at = datetime.now(
            timezone.utc
        ) - timedelta(seconds=1)

        result = run(gate.handle_callback(callback(f"approve:{pending.approval_id}")))

        self.assertIsNone(result)
        self.assertEqual(gate.pending_count, 0)
        self.assertEqual(gate.calls_to("answerCallbackQuery")[0]["text"], "Expired")

    def test_unknown_approval_id_returns_none(self):
        gate = StubGate()

        result = run(gate.handle_callback(callback("approve:not-a-real-id")))

        self.assertIsNone(result)
        self.assertEqual(gate.calls_to("answerCallbackQuery")[0]["text"], "Expired")
        # Nothing to edit — no message was ever sent for this id.
        self.assertEqual(gate.calls_to("editMessageText"), [])

    def test_malformed_callback_data_returns_none_but_still_answers(self):
        gate = StubGate()

        self.assertIsNone(run(gate.handle_callback(callback("garbage-no-colon"))))
        self.assertIsNone(run(gate.handle_callback(callback("delete:some-id"))))

        answers = gate.calls_to("answerCallbackQuery")
        self.assertEqual(len(answers), 2)
        self.assertTrue(all(a["text"] == "Unrecognised action" for a in answers))

    def test_callback_from_non_owner_is_rejected(self):
        gate = StubGate()
        pending = run(gate.send_approval_request(make_candidate(), make_recommendation()))

        result = run(gate.handle_callback(
            callback(f"approve:{pending.approval_id}", sender="9999999")
        ))

        self.assertIsNone(result)
        self.assertEqual(gate.calls_to("answerCallbackQuery")[0]["text"], "Not authorised")
        # The approval survives — a stranger's tap must not consume it.
        self.assertEqual(gate.pending_count, 1)


class WaitForDecisionTest(unittest.TestCase):
    def test_timeout_path_returns_timeout_result_and_notifies(self):
        gate = StubGate(timeout_seconds=1, poll_interval_seconds=0.01)
        pending = run(gate.send_approval_request(make_candidate(), make_recommendation()))

        result = run(gate.wait_for_decision(pending, timeout_seconds=0))

        self.assertEqual(result.status, ApprovalStatus.timeout)
        self.assertEqual(result.decision_source, "timeout")
        self.assertEqual(result.approval_id, pending.approval_id)
        self.assertEqual(gate.pending_count, 0)

        # Original send + the expiry notification.
        sends = gate.calls_to("sendMessage")
        self.assertEqual(len(sends), 2)
        self.assertIn("⏰ Trade opportunity expired", sends[1]["text"])
        self.assertIn("Will Bitcoin reach $100,000 in July?", sends[1]["text"])
        self.assertIn("EXPIRED", gate.calls_to("editMessageText")[0]["text"])

    def test_returns_decision_made_while_waiting(self):
        gate = StubGate(timeout_seconds=30, poll_interval_seconds=0.01)

        async def scenario():
            pending = await gate.send_approval_request(
                make_candidate(), make_recommendation()
            )
            waiter = asyncio.create_task(gate.wait_for_decision(pending))
            await asyncio.sleep(0.05)
            await gate.handle_callback(callback(f"approve:{pending.approval_id}"))
            return await asyncio.wait_for(waiter, timeout=5)

        result = run(scenario())
        self.assertEqual(result.status, ApprovalStatus.approved)

    def test_expiry_sweep_and_waiter_do_not_double_notify(self):
        gate = StubGate(timeout_seconds=0, poll_interval_seconds=0.01)

        async def scenario():
            pending = await gate.send_approval_request(
                make_candidate(), make_recommendation()
            )
            await gate.check_pending_expirations()
            return await gate.wait_for_decision(pending, timeout_seconds=0)

        result = run(scenario())
        self.assertEqual(result.status, ApprovalStatus.timeout)
        # Exactly one expiry notification, not two.
        expiry_sends = [
            payload for payload in gate.calls_to("sendMessage")
            if "expired" in payload["text"]
        ]
        self.assertEqual(len(expiry_sends), 1)


class MaxOnePendingTest(unittest.TestCase):
    def test_second_request_raises_while_one_is_outstanding(self):
        gate = StubGate()
        run(gate.send_approval_request(make_candidate(), make_recommendation()))

        with self.assertRaises(ApprovalGateBusy):
            run(gate.send_approval_request(
                make_candidate(market_id="999", asset="eth"), make_recommendation()
            ))

        self.assertEqual(gate.pending_count, 1)
        self.assertEqual(len(gate.calls_to("sendMessage")), 1)

    def test_scanner_skips_second_trade_without_raising(self):
        gate = StubGate()
        run(gate.send_approval_request(make_candidate(), make_recommendation()))

        scanner = PolymarketScanner(approval_gate=gate)
        summary = ScannerRunSummary(
            run_at=datetime.now(timezone.utc),
            markets_fetched=1, candidates_analysed=1,
            simulations_run=1, sim_errors=0,
            best_trade=make_candidate(market_id="999", asset="eth"),
            analyst_recommendation=make_recommendation(),
        )

        run(scanner.apply_approval(summary))

        # Dropped, not queued, and no second Telegram message.
        self.assertIsNone(summary.approval_result)
        self.assertEqual(len(gate.calls_to("sendMessage")), 1)

    def test_gate_frees_after_a_decision(self):
        gate = StubGate()
        first = run(gate.send_approval_request(make_candidate(), make_recommendation()))
        run(gate.handle_callback(callback(f"skip:{first.approval_id}")))

        second = run(gate.send_approval_request(make_candidate(), make_recommendation()))
        self.assertNotEqual(second.approval_id, first.approval_id)


class AnalystSkipPathTest(unittest.TestCase):
    def test_analyst_skip_sends_no_telegram_message(self):
        gate = StubGate()
        scanner = PolymarketScanner(approval_gate=gate)
        candidate = make_candidate()
        recommendation = make_recommendation(
            recommendation="pass", reasoning="Thin volume, wide spread."
        )
        summary = ScannerRunSummary(
            run_at=datetime.now(timezone.utc),
            markets_fetched=1, candidates_analysed=1,
            simulations_run=1, sim_errors=0,
            best_trade=candidate,
            analyst_recommendation=recommendation,
            analyst_skip=True,
        )

        run(scanner.apply_approval(summary))

        self.assertEqual(gate.calls, [])
        self.assertIsNotNone(summary.approval_result)
        self.assertEqual(summary.approval_result.status, ApprovalStatus.analyst_skip)
        self.assertEqual(summary.approval_result.decision_source, "analyst_skip")
        self.assertEqual(summary.approval_result.candidate.market_id, candidate.market_id)
        self.assertEqual(gate.pending_count, 0)

    def test_no_best_trade_leaves_approval_result_none(self):
        gate = StubGate()
        scanner = PolymarketScanner(approval_gate=gate)
        summary = ScannerRunSummary(
            run_at=datetime.now(timezone.utc),
            markets_fetched=1, candidates_analysed=0,
            simulations_run=0, sim_errors=0,
        )

        run(scanner.apply_approval(summary))

        self.assertIsNone(summary.approval_result)
        self.assertEqual(gate.calls, [])

    def test_missing_recommendation_does_not_ask_for_approval(self):
        gate = StubGate()
        scanner = PolymarketScanner(approval_gate=gate)
        summary = ScannerRunSummary(
            run_at=datetime.now(timezone.utc),
            markets_fetched=1, candidates_analysed=1,
            simulations_run=1, sim_errors=0,
            best_trade=make_candidate(),
        )

        run(scanner.apply_approval(summary))

        self.assertIsNone(summary.approval_result)
        self.assertEqual(gate.calls, [])

    def test_approved_path_attaches_result_to_summary(self):
        gate = StubGate(timeout_seconds=30, poll_interval_seconds=0.01)
        scanner = PolymarketScanner(approval_gate=gate)
        summary = ScannerRunSummary(
            run_at=datetime.now(timezone.utc),
            markets_fetched=1, candidates_analysed=1,
            simulations_run=1, sim_errors=0,
            best_trade=make_candidate(),
            analyst_recommendation=make_recommendation(),
        )

        async def scenario():
            task = asyncio.create_task(scanner.apply_approval(summary))
            await asyncio.sleep(0.05)
            approval_id = next(iter(gate._pending))
            await gate.handle_callback(callback(f"approve:{approval_id}"))
            await asyncio.wait_for(task, timeout=5)

        run(scenario())

        self.assertIsNotNone(summary.approval_result)
        self.assertEqual(summary.approval_result.status, ApprovalStatus.approved)


class TokenSeparationTest(unittest.TestCase):
    """The poller must never run against the shared quantumclaw bot token."""

    def test_poller_refuses_to_start_without_a_token(self):
        """An explicit empty token must mean "do not poll", not "use config".

        A client that would raise on any request is injected: if the poller
        ever falls back to the configured token this test fails loudly instead
        of silently issuing a live getUpdates against the real bot.
        """
        class ExplodingClient:
            async def get(self, url, params=None):
                raise AssertionError("poller made a request with no token")

            async def aclose(self):
                pass

        gate = StubGate()
        run(run_update_poller(gate, token="", client=ExplodingClient(), stop_after=1))
        self.assertEqual(gate.calls, [])

    def test_config_gate_rejects_shared_and_absent_tokens(self):
        from src.trade_engine.config import Config

        cfg = Config()
        shared = cfg.telegram_bot_token

        cfg.trade_telegram_bot_token = ""
        self.assertFalse(cfg.telegram_poller_enabled)
        self.assertEqual(cfg.approval_bot_token, shared)

        cfg.trade_telegram_bot_token = shared
        self.assertFalse(cfg.telegram_poller_enabled)

        cfg.trade_telegram_bot_token = "a-different-dedicated-token"
        self.assertTrue(cfg.telegram_poller_enabled)
        self.assertEqual(cfg.approval_bot_token, "a-different-dedicated-token")


class UpdatePollerTest(unittest.TestCase):
    def test_routes_callback_queries_and_advances_offset(self):
        gate = StubGate()
        pending = run(gate.send_approval_request(make_candidate(), make_recommendation()))
        requests: list[dict] = []

        class StubResponse:
            status_code = 200

            def __init__(self, payload):
                self._payload = payload

            def json(self):
                return self._payload

        class StubClient:
            def __init__(self):
                self.calls = 0

            async def get(self, url, params=None):
                requests.append(params or {})
                self.calls += 1
                if self.calls == 1:
                    return StubResponse({"ok": True, "result": [{
                        "update_id": 77,
                        "callback_query": callback(f"approve:{pending.approval_id}"),
                    }]})
                return StubResponse({"ok": True, "result": []})

            async def aclose(self):
                pass

        run(run_update_poller(gate, token="dedicated", client=StubClient(), stop_after=2))

        self.assertEqual(gate.pending_count, 0)
        self.assertEqual(len(gate.calls_to("answerCallbackQuery")), 1)
        # Second poll must not replay update 77.
        self.assertEqual(requests[1]["offset"], 78)
        self.assertEqual(requests[0]["allowed_updates"], '["callback_query"]')

    def test_transport_failure_backs_off_and_keeps_polling(self):
        gate = StubGate()
        slept: list[float] = []

        class BoomClient:
            async def get(self, url, params=None):
                raise RuntimeError("connection reset")

            async def aclose(self):
                pass

        async def scenario():
            import src.trade_engine.approval as approval_mod

            real_sleep = asyncio.sleep

            async def fake_sleep(seconds):
                slept.append(seconds)
                await real_sleep(0)

            approval_mod.asyncio.sleep = fake_sleep
            try:
                await run_update_poller(
                    gate, token="dedicated", client=BoomClient(), stop_after=3
                )
            finally:
                approval_mod.asyncio.sleep = real_sleep

        run(scenario())

        # Exponential, not a hot loop.
        self.assertEqual(slept, [1.0, 2.0, 4.0])


class LogHygieneTest(unittest.TestCase):
    def test_bot_token_is_scrubbed_from_error_text(self):
        from src.trade_engine.approval import _scrub

        token = "8895488594:AAH-secret-material"
        leaked = f"Request URL: https://api.telegram.org/bot{token}/getUpdates"

        self.assertNotIn(token, _scrub(leaked, token))
        self.assertIn("***", _scrub(leaked, token))

    def test_httpx_request_log_redacts_the_bot_token(self):
        """httpx logs every request URL at INFO, and Telegram puts the token in
        the PATH — so an unfiltered httpx logger writes the bot token to PM2 on
        every poll. Caught on the live 4013 run, not by the stubbed tests."""
        import logging as logging_mod

        from src.trade_engine.config import install_bot_token_redaction

        install_bot_token_redaction()
        token = "8895488594:AAHXKwF5CdEMNPtk0rLAdi-hudTtv-5NUOA"

        with self.assertLogs("httpx", level="INFO") as captured:
            logging_mod.getLogger("httpx").info(
                "HTTP Request: GET https://api.telegram.org/bot%s/getUpdates"
                "?timeout=30 \"HTTP/1.1 200 OK\"", token,
            )

        rendered = "\n".join(record.getMessage() for record in captured.records)
        self.assertNotIn(token, rendered)
        self.assertIn("/bot***/getUpdates", rendered)

    def test_redaction_leaves_supabase_request_logs_intact(self):
        import logging as logging_mod

        from src.trade_engine.config import install_bot_token_redaction

        install_bot_token_redaction()
        url = "https://fdabygmromuqtysitodp.supabase.co/rest/v1/trading_positions"

        with self.assertLogs("httpx", level="INFO") as captured:
            logging_mod.getLogger("httpx").info("HTTP Request: GET %s", url)

        self.assertIn(url, captured.records[0].getMessage())

    def test_approval_id_only_appears_at_debug_level(self):
        gate = StubGate()

        with self.assertLogs("trade_engine.approval", level="INFO") as captured:
            pending = run(
                gate.send_approval_request(make_candidate(), make_recommendation())
            )
            run(gate.handle_callback(callback(f"approve:{pending.approval_id}")))

        info_and_above = [
            record.getMessage() for record in captured.records
            if record.levelno > 10  # above DEBUG
        ]
        self.assertTrue(info_and_above, "expected some INFO output")
        for message in info_and_above:
            self.assertNotIn(pending.approval_id, message)


if __name__ == "__main__":
    unittest.main()
