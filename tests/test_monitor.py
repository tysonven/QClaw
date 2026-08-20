"""Tests for the trade-engine Position Monitor (src/trade_engine/monitor.py).

Stdlib unittest, matching tests/test_analyst.py and tests/test_executor.py.
No network, no Supabase: the database helpers are monkeypatched and the Gamma
and Telegram HTTP surfaces are served by an httpx.MockTransport, so the real
_fetch_market / _notify request paths are exercised end to end.

The monitor writes position closes that feed the executor's daily-loss gate,
so the close-path assertions are exact-row, and every failure mode asserts the
sweep CONTINUES — one bad position must never abort monitoring of the rest.

Run:
    python3 -m unittest tests/test_monitor.py
"""

import asyncio
import json
import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

for _key in (
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY",
    "TELEGRAM_BOT_TOKEN", "OWNER_TELEGRAM_CHAT_ID",
    "POLYMARKET_PRIVATE_KEY", "POLYMARKET_FUNDER_ADDRESS",
):
    os.environ.setdefault(_key, f"test-{_key.lower()}")

import httpx  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from src.trade_engine import monitor as monitor_mod  # noqa: E402
from src.trade_engine.monitor import PositionMonitor  # noqa: E402
from src.trade_engine.database import SupabaseError  # noqa: E402
from src.trade_engine.models import MonitorRunResult, TradePosition  # noqa: E402

CID = "0x" + "ab" * 32
CID2 = "0x" + "cd" * 32
QUESTION = "Will the price of Ethereum be above $1,900 on August 4?"


def run(coro):
    return asyncio.run(coro)


def make_position(**overrides) -> TradePosition:
    base = dict(
        id="pos-1",
        simulation_id="sim-1",
        direction="YES",
        entry_price=0.35,
        shares=14.285714,
        usdc_amount=5.0,
        status="open",
        opened_at=datetime.now(timezone.utc),
    )
    base.update(overrides)
    return TradePosition(**base)


def sim_row(sim_id="sim-1", condition_id=CID, question=QUESTION) -> dict:
    raw = {"question": question}
    if condition_id is not None:
        raw["polymarket_condition_id"] = condition_id
    return {"id": sim_id, "asset": "eth", "raw_output": raw}


def gamma_market(yes="0.5", no="0.5", active=True, closed=False) -> list:
    return [{
        "active": active,
        "closed": closed,
        "outcomePrices": json.dumps([yes, no]),
    }]


class MonitorTestCase(unittest.TestCase):
    """Shared harness: monkeypatched DB helpers + MockTransport HTTP."""

    def setUp(self) -> None:
        self._orig = {
            "get_open_positions": monitor_mod.get_open_positions,
            "get_simulations_by_ids": monitor_mod.get_simulations_by_ids,
            "update_position": monitor_mod.update_position,
            "insert_alert": monitor_mod.insert_alert,
            "mark_alert_notified": monitor_mod.mark_alert_notified,
        }
        monitor_mod._last_monitor.update({"at": None, "resolved_total": 0})

        self.positions = []
        self.positions_exc = None
        self.sim_rows = {}          # sim_id -> row dict
        self.sims_exc = None
        self.sim_lookups = []
        self.update_calls = []      # (position_id, updates)
        self.update_exc_for = {}    # position_id -> exception
        # Alert layer. `live_alerts` emulates the partial unique index: a
        # (position_id, alert_type) already present means insert_alert returns
        # None, which is the monitor's "already alerted, stay quiet" signal.
        self.alert_inserts = []     # list of alert dicts the monitor tried to write
        self.live_alerts = set()    # {(position_id, alert_type)}
        self.alert_insert_exc = None
        self.notified_alert_ids = []

        self.gamma_by_cid = {}      # condition_id -> list payload or Exception
        self.gamma_requests = []
        self.telegram_requests = []
        self.telegram_status = 200

        tests = self

        async def _get_open():
            if tests.positions_exc is not None:
                raise tests.positions_exc
            return list(tests.positions)

        async def _get_sims(sim_ids):
            tests.sim_lookups.append(list(sim_ids))
            if tests.sims_exc is not None:
                raise tests.sims_exc
            return [tests.sim_rows[s] for s in sim_ids if s in tests.sim_rows]

        async def _update(position_id, updates):
            exc = tests.update_exc_for.get(position_id)
            if exc is not None:
                raise exc
            tests.update_calls.append((position_id, dict(updates)))
            return {"id": position_id, **updates}

        async def _insert_alert(alert):
            if tests.alert_insert_exc is not None:
                raise tests.alert_insert_exc
            tests.alert_inserts.append(dict(alert))
            key = (alert["position_id"], alert["alert_type"])
            if key in tests.live_alerts:
                return None          # partial unique index conflict -> deduped
            tests.live_alerts.add(key)
            return {"id": f"alert-{len(tests.live_alerts)}", **alert}

        async def _mark_notified(alert_id):
            tests.notified_alert_ids.append(alert_id)

        monitor_mod.get_open_positions = _get_open
        monitor_mod.get_simulations_by_ids = _get_sims
        monitor_mod.update_position = _update
        monitor_mod.insert_alert = _insert_alert
        monitor_mod.mark_alert_notified = _mark_notified

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "api.telegram.org":
                tests.telegram_requests.append(json.loads(request.content))
                return httpx.Response(tests.telegram_status, json={"ok": True})
            if request.url.host == "gamma-api.polymarket.com":
                tests.gamma_requests.append(str(request.url))
                cid = request.url.params.get("condition_ids")
                payload = tests.gamma_by_cid.get(cid)
                if isinstance(payload, Exception):
                    raise payload
                if payload is None:
                    return httpx.Response(200, json=[])
                return httpx.Response(200, json=payload)
            raise AssertionError(f"unexpected host: {request.url.host}")

        self.client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.monitor = PositionMonitor(
            client=self.client, token="test-token", chat_id="12345"
        )

    def tearDown(self) -> None:
        for name, fn in self._orig.items():
            setattr(monitor_mod, name, fn)
        run(self.client.aclose())

    def sweep(self) -> MonitorRunResult:
        return run(self.monitor.check_positions())


class TestMonitorRunResultModel(MonitorTestCase):
    def test_valid_result(self):
        result = MonitorRunResult(
            run_at=datetime.now(timezone.utc),
            positions_checked=3,
            positions_resolved=1,
            positions_unpriceable=1,
            errors=1,
        )
        self.assertEqual(result.positions_checked, 3)
        self.assertEqual(result.positions_tp_sl, 0)
        self.assertEqual(result.alerts_sent, 0)

    def test_missing_required_fields_raise(self):
        with self.assertRaises(ValidationError):
            MonitorRunResult(run_at=datetime.now(timezone.utc))
        with self.assertRaises(ValidationError):
            MonitorRunResult(positions_checked=0)


class TestEmptySweep(MonitorTestCase):
    def test_no_open_positions_no_api_calls(self):
        result = self.sweep()
        self.assertEqual(result.positions_checked, 0)
        self.assertEqual(result.errors, 0)
        self.assertEqual(self.sim_lookups, [])
        self.assertEqual(self.gamma_requests, [])
        self.assertEqual(self.telegram_requests, [])


class TestLookups(MonitorTestCase):
    def test_position_with_simulation_id_fetches_gamma(self):
        self.positions = [make_position()]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="0.55", no="0.45")
        result = self.sweep()
        self.assertEqual(self.sim_lookups, [["sim-1"]])
        self.assertEqual(len(self.gamma_requests), 1)
        self.assertIn(f"condition_ids={CID}", self.gamma_requests[0])
        self.assertEqual(result.positions_checked, 1)

    def test_position_without_simulation_id_skipped(self):
        self.positions = [make_position(simulation_id=None)]
        with self.assertLogs("trade_engine.monitor", level="WARNING") as logs:
            result = self.sweep()
        self.assertEqual(result.positions_unpriceable, 1)
        self.assertEqual(self.sim_lookups, [])
        self.assertEqual(self.gamma_requests, [])
        self.assertEqual(self.update_calls, [])
        self.assertTrue(any("no simulation_id" in line for line in logs.output))

    def test_simulation_without_condition_id_skipped(self):
        self.positions = [make_position()]
        self.sim_rows["sim-1"] = sim_row(condition_id=None)
        result = self.sweep()
        self.assertEqual(result.positions_unpriceable, 1)
        self.assertEqual(self.gamma_requests, [])

    def test_market_not_found_skipped(self):
        self.positions = [make_position()]
        self.sim_rows["sim-1"] = sim_row()
        # gamma_by_cid left empty -> Gamma returns []
        result = self.sweep()
        self.assertEqual(result.positions_unpriceable, 1)
        self.assertEqual(self.update_calls, [])


class TestUnresolved(MonitorTestCase):
    def test_unresolved_market_no_write_no_notify(self):
        self.positions = [make_position()]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="0.55", no="0.45")
        result = self.sweep()
        self.assertEqual(result.positions_resolved, 0)
        self.assertEqual(result.positions_tp_sl, 0)
        self.assertEqual(self.update_calls, [])
        self.assertEqual(self.telegram_requests, [])


class TestResolution(MonitorTestCase):
    def test_resolved_yes_direction_yes_won(self):
        self.positions = [make_position(direction="YES")]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="1", no="0", active=False, closed=True)
        result = self.sweep()
        self.assertEqual(result.positions_resolved, 1)
        (pos_id, updates), = self.update_calls
        self.assertEqual(pos_id, "pos-1")
        self.assertEqual(updates["exit_reason"], "resolved_win")
        self.assertEqual(updates["exit_price"], 1.0)
        self.assertAlmostEqual(updates["exit_usdc"], 14.285714, places=6)
        self.assertAlmostEqual(updates["pnl"], 9.285714, places=6)

    def test_resolved_yes_direction_yes_lost(self):
        self.positions = [make_position(direction="YES")]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="0", no="1", active=False, closed=True)
        result = self.sweep()
        self.assertEqual(result.positions_resolved, 1)
        (_, updates), = self.update_calls
        self.assertEqual(updates["exit_reason"], "resolved_loss")
        self.assertEqual(updates["exit_price"], 0.0)
        self.assertEqual(updates["exit_usdc"], 0.0)
        self.assertAlmostEqual(updates["pnl"], -5.0, places=6)

    def test_resolved_no_direction_no_won(self):
        self.positions = [make_position(direction="NO")]
        self.sim_rows["sim-1"] = sim_row()
        # YES lost -> NO side finalises at 1.0; exit price is DIRECTION-side.
        self.gamma_by_cid[CID] = gamma_market(yes="0", no="1", active=False, closed=True)
        result = self.sweep()
        self.assertEqual(result.positions_resolved, 1)
        (_, updates), = self.update_calls
        self.assertEqual(updates["exit_reason"], "resolved_win")
        self.assertEqual(updates["exit_price"], 1.0)
        self.assertAlmostEqual(updates["pnl"], 9.285714, places=6)

    def test_resolution_wins_over_take_profit_label(self):
        # A settled market also satisfies currentPrice > 0.85; the close must
        # be labelled resolved_win, not take_profit — settlement is ground
        # truth for the learning loop.
        self.positions = [make_position()]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="1", no="0", active=False, closed=True)
        self.sweep()
        (_, updates), = self.update_calls
        self.assertEqual(updates["exit_reason"], "resolved_win")

    def test_low_entry_loss_still_closes_on_resolution(self):
        # The n8n gap this port fixes: entry 0.15 fails the stop-loss guard
        # (entry > 0.20), so a resolved-against-us market stayed open forever.
        self.positions = [make_position(entry_price=0.15)]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="0", no="1", active=False, closed=True)
        result = self.sweep()
        self.assertEqual(result.positions_resolved, 1)
        (_, updates), = self.update_calls
        self.assertEqual(updates["exit_reason"], "resolved_loss")

    def test_flags_resolved_but_price_not_final_skipped(self):
        # active=false/closed=true with mid prices (voided / still settling):
        # no defensible win/loss, wait for the next sweep.
        self.positions = [make_position()]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="0.6", no="0.4", active=False, closed=True)
        result = self.sweep()
        self.assertEqual(result.positions_resolved, 0)
        self.assertEqual(result.positions_unpriceable, 1)
        self.assertEqual(self.update_calls, [])

    def test_update_fields_exact_on_close(self):
        self.positions = [make_position()]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="1", no="0", active=False, closed=True)
        self.sweep()
        (_, updates), = self.update_calls
        self.assertEqual(
            set(updates),
            {"status", "exit_price", "exit_usdc", "pnl", "exit_reason", "closed_at"},
        )
        self.assertEqual(updates["status"], "closed")
        # closed_at must be an ISO-8601 UTC timestamp PostgREST can ingest.
        parsed = datetime.fromisoformat(updates["closed_at"])
        self.assertIsNotNone(parsed.tzinfo)

    def test_null_shares_closes_with_null_pnl(self):
        # shares/usdc absent -> exit_usdc/pnl NULL, never guessed (they feed
        # the executor's daily-loss gate).
        self.positions = [make_position(shares=None, usdc_amount=None)]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="1", no="0", active=False, closed=True)
        result = self.sweep()
        self.assertEqual(result.positions_resolved, 1)
        (_, updates), = self.update_calls
        self.assertIsNone(updates["exit_usdc"])
        self.assertIsNone(updates["pnl"])


class TestTakeProfitStopLoss(MonitorTestCase):
    """Threshold crossings ALERT; they do not close.

    Rewritten 2026-08-20. These tests previously asserted that a TP/SL crossing
    wrote status='closed'. That behaviour was the defect: the monitor cannot
    sell, so the row claimed a close that had not happened. The contract now is
    "flag it, notify once, leave it open".
    """

    def _assert_no_position_write(self):
        # THE core regression guard. If this ever fails, the monitor is once
        # again claiming closes it did not perform (the 2026-08-19 incident).
        self.assertEqual(
            self.update_calls, [],
            "monitor wrote to trading_positions on a threshold crossing; it "
            "cannot sell, so it must never mark a position closed",
        )

    def test_take_profit_alerts_and_leaves_position_open(self):
        self.positions = [make_position()]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="0.9", no="0.1")
        result = self.sweep()

        self.assertEqual(result.alerts_raised, 1)
        self.assertEqual(result.positions_resolved, 0)
        self._assert_no_position_write()

        (alert,) = self.alert_inserts
        self.assertEqual(alert["alert_type"], "take_profit")
        self.assertEqual(alert["trigger_price"], 0.9)
        # Estimate is recorded on the ALERT only, never on the position.
        self.assertIn("unrealized_pnl_estimate", alert)

        text = " ".join(r["text"] for r in self.telegram_requests)
        self.assertIn("TAKE-PROFIT THRESHOLD HIT", text)
        self.assertIn("NOT closed", text)

    def test_take_profit_fires_without_entry_price(self):
        # Verbatim n8n behaviour: TP is independent of entry price.
        self.positions = [make_position(entry_price=None)]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="0.9", no="0.1")
        result = self.sweep()
        self.assertEqual(result.alerts_raised, 1)
        self._assert_no_position_write()

    def test_stop_loss_alerts_and_leaves_position_open(self):
        self.positions = [make_position(entry_price=0.35)]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="0.05", no="0.95")
        result = self.sweep()

        self.assertEqual(result.alerts_raised, 1)
        self._assert_no_position_write()

        (alert,) = self.alert_inserts
        self.assertEqual(alert["alert_type"], "stop_loss")

        text = " ".join(r["text"] for r in self.telegram_requests)
        self.assertIn("STOP-LOSS THRESHOLD HIT", text)
        self.assertIn("NOT closed", text)
        self.assertIn("manual-only", text)

    def test_repeat_sweep_does_not_re_alert(self):
        """The anti-spam contract: one alert per threshold crossing.

        A stop-loss condition persists for as long as the price stays low, so
        without dedup the 15-minute sweep would Telegram every 15 minutes. Dedup
        lives in a partial unique index; the harness emulates it.
        """
        self.positions = [make_position(entry_price=0.35)]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="0.05", no="0.95")

        first = self.sweep()
        self.assertEqual(first.alerts_raised, 1)
        self.assertEqual(len(self.telegram_requests), 1)

        second = self.sweep()
        self.assertEqual(second.alerts_raised, 0)
        self.assertEqual(second.alerts_deduped, 1)
        self.assertEqual(
            len(self.telegram_requests), 1,
            "second sweep re-notified on an already-live alert",
        )
        self._assert_no_position_write()

    def test_manual_hold_suppresses_alerts_but_still_prices(self):
        """manual_hold silences alerting without blinding the monitor."""
        self.positions = [make_position(entry_price=0.35, manual_hold=True)]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="0.05", no="0.95")

        result = self.sweep()
        self.assertEqual(result.positions_held, 1)
        self.assertEqual(result.alerts_raised, 0)
        self.assertEqual(self.alert_inserts, [])
        self.assertEqual(self.telegram_requests, [])
        self._assert_no_position_write()
        # Still priced: the market was fetched, so dashboard/Analyst stay live.
        self.assertTrue(self.gamma_requests)

    def test_alert_write_failure_does_not_notify(self):
        """No Telegram without a recorded alert.

        A message Tyson can see but the system has no row for would re-notify on
        the next sweep with no dedup, which is the spam failure mode.
        """
        self.positions = [make_position(entry_price=0.35)]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="0.05", no="0.95")
        self.alert_insert_exc = RuntimeError("supabase down")

        result = self.sweep()
        self.assertEqual(result.errors, 1)
        self.assertEqual(result.alerts_raised, 0)
        self.assertEqual(self.telegram_requests, [])
        self._assert_no_position_write()

    def test_stop_loss_guard_low_entry_stays_open(self):
        # Verbatim n8n behaviour: entry <= 0.20 disables the stop loss. The
        # position stays open until RESOLUTION closes it (tested above).
        self.positions = [make_position(entry_price=0.15)]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="0.05", no="0.95")
        result = self.sweep()
        self.assertEqual(result.alerts_raised, 0)
        self.assertEqual(self.alert_inserts, [])
        self.assertEqual(self.update_calls, [])

    def test_weakening_alert_no_db_write(self):
        self.positions = [make_position(entry_price=0.60)]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="0.25", no="0.75")
        result = self.sweep()
        self.assertEqual(result.alerts_raised, 1)
        (alert,) = self.alert_inserts
        self.assertEqual(alert["alert_type"], "weakening")
        self._assert_no_position_write()
        text = " ".join(r["text"] for r in self.telegram_requests)
        self.assertIn("weakening", text.lower())
        self.assertIn("Nothing has been closed", text)


class TestNotifications(MonitorTestCase):
    def test_telegram_sent_on_resolution(self):
        self.positions = [make_position()]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="1", no="0", active=False, closed=True)
        self.sweep()
        self.assertEqual(len(self.telegram_requests), 1)
        request = self.telegram_requests[0]
        self.assertEqual(request["chat_id"], "12345")
        self.assertIn("Trade won", request["text"])
        self.assertIn(QUESTION, request["text"])
        self.assertIn("+$9.29", request["text"])

    def test_loss_notification_format(self):
        self.positions = [make_position()]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="0", no="1", active=False, closed=True)
        self.sweep()
        request = self.telegram_requests[0]
        self.assertIn("Trade lost", request["text"])
        self.assertIn("-$5.00", request["text"])

    def test_notify_failure_does_not_undo_close(self):
        self.telegram_status = 500
        self.positions = [make_position()]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="1", no="0", active=False, closed=True)
        result = self.sweep()
        self.assertEqual(result.positions_resolved, 1)
        self.assertEqual(len(self.update_calls), 1)
        self.assertEqual(result.errors, 0)


class TestFailureIsolation(MonitorTestCase):
    def _two_positions(self):
        self.positions = [
            make_position(id="pos-1", simulation_id="sim-1"),
            make_position(id="pos-2", simulation_id="sim-2"),
        ]
        self.sim_rows["sim-1"] = sim_row("sim-1", CID)
        self.sim_rows["sim-2"] = sim_row("sim-2", CID2)

    def test_gamma_error_skips_position_continues(self):
        self._two_positions()
        self.gamma_by_cid[CID] = httpx.ConnectError("boom")
        self.gamma_by_cid[CID2] = gamma_market(yes="1", no="0", active=False, closed=True)
        result = self.sweep()
        self.assertEqual(result.positions_checked, 2)
        self.assertEqual(result.positions_unpriceable, 1)
        self.assertEqual(result.positions_resolved, 1)
        (pos_id, _), = self.update_calls
        self.assertEqual(pos_id, "pos-2")

    def test_update_position_error_logged_continues(self):
        self._two_positions()
        self.gamma_by_cid[CID] = gamma_market(yes="1", no="0", active=False, closed=True)
        self.gamma_by_cid[CID2] = gamma_market(yes="1", no="0", active=False, closed=True)
        self.update_exc_for["pos-1"] = SupabaseError(
            "PATCH", "/trading_positions", 500, "boom"
        )
        with self.assertLogs("trade_engine.monitor", level="ERROR") as logs:
            result = self.sweep()
        self.assertEqual(result.errors, 1)
        self.assertEqual(result.positions_resolved, 1)
        (pos_id, _), = self.update_calls
        self.assertEqual(pos_id, "pos-2")
        # The failed close must NOT be announced — only pos-2's message goes out.
        self.assertEqual(len(self.telegram_requests), 1)
        self.assertTrue(any("failed to close position pos-1" in line
                            for line in logs.output))

    def test_sim_lookup_error_counts_error_continues(self):
        self._two_positions()
        self.sims_exc = RuntimeError("supabase down")
        result = self.sweep()
        self.assertEqual(result.positions_checked, 2)
        self.assertEqual(result.errors, 2)
        self.assertEqual(self.update_calls, [])

    def test_never_raises_on_fetch_failure(self):
        self.positions_exc = RuntimeError("connection refused")
        result = self.sweep()  # must not raise
        self.assertEqual(result.positions_checked, 0)
        self.assertEqual(result.errors, 1)


class TestHealthState(MonitorTestCase):
    def test_lifetime_resolved_count_accumulates(self):
        self.positions = [make_position()]
        self.sim_rows["sim-1"] = sim_row()
        self.gamma_by_cid[CID] = gamma_market(yes="1", no="0", active=False, closed=True)
        self.sweep()
        state = monitor_mod.last_monitor_state()
        self.assertEqual(state["resolved_total"], 1)
        self.assertIsNotNone(state["at"])
        # Second sweep finds nothing (position now closed upstream) — the
        # lifetime count must not reset.
        self.positions = []
        self.sweep()
        self.assertEqual(monitor_mod.last_monitor_state()["resolved_total"], 1)


if __name__ == "__main__":
    unittest.main()
