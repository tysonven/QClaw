"""Tests for manual position logging (src/trade_engine/manual.py plus the
POST /positions/manual route in src/trade_engine/main.py).

Stdlib unittest, matching tests/test_monitor.py. No network, no Supabase:
write_position and the simulation-link query are monkeypatched on the manual
module, the Gamma slug lookup is served by an httpx.MockTransport, and the
route is exercised through httpx.ASGITransport against the real FastAPI app
(lifespan is not run, so no scheduler or poller starts).

The invariants that matter here: every invalid input is a 400 with a legible
message (Charlie says the error text back to Tyson), a missing simulation
match must never block the write, and tx_hash is ALWAYS None — it is the
durable marker that separates manual entries from executor ones.

Run:
    python3 -m unittest tests/test_manual_position.py
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

from src.trade_engine import main as main_mod  # noqa: E402
from src.trade_engine import manual as manual_mod  # noqa: E402
from src.trade_engine import monitor as monitor_mod  # noqa: E402
from src.trade_engine.manual import (  # noqa: E402
    ManualPositionError,
    log_manual_position,
)
from src.trade_engine.models import ManualPositionRequest, TradePosition  # noqa: E402
from src.trade_engine.monitor import PositionMonitor  # noqa: E402

CID = "0x" + "ab" * 32
QUESTION = "Will XRP dip to $1.00 in August?"
SLUG = "will-xrp-dip-to-1-in-august-2026"
MARKET_URL = f"https://polymarket.com/event/what-price-will-xrp-hit/{SLUG}"


def run(coro):
    return asyncio.run(coro)


def make_request(**overrides) -> ManualPositionRequest:
    base = dict(
        condition_id=CID, direction="YES", entry_price=0.9, usdc_amount=10.0
    )
    base.update(overrides)
    return ManualPositionRequest(**base)


def gamma_client(
    open_by_slug=None, closed_by_slug=None
) -> httpx.AsyncClient:
    """Mock Gamma: /markets?slug=X serves open_by_slug, adding closed=true
    serves closed_by_slug — mirroring the real list endpoint's behaviour of
    hiding closed markets unless asked."""

    def handler(request: httpx.Request) -> httpx.Response:
        slug = request.url.params.get("slug")
        table = (
            closed_by_slug if request.url.params.get("closed") == "true"
            else open_by_slug
        )
        return httpx.Response(200, json=(table or {}).get(slug, []))

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class ManualTestCase(unittest.TestCase):
    """Shared harness: monkeypatched DB writes and simulation-link reads."""

    def setUp(self) -> None:
        self.written: list[dict] = []
        self.sim_row = None  # what the link query returns
        self.link_calls: list[tuple] = []

        async def fake_write_position(row: dict) -> dict:
            self.written.append(row)
            return {**row, "id": "pos-manual-1",
                    "created_at": datetime.now(timezone.utc).isoformat()}

        async def fake_link(condition_id: str, since_iso: str):
            self.link_calls.append((condition_id, since_iso))
            return self.sim_row

        self._orig = (
            manual_mod.write_position,
            manual_mod.get_latest_simulation_for_condition,
        )
        manual_mod.write_position = fake_write_position
        manual_mod.get_latest_simulation_for_condition = fake_link

    def tearDown(self) -> None:
        (
            manual_mod.write_position,
            manual_mod.get_latest_simulation_for_condition,
        ) = self._orig

    # --- helpers ----------------------------------------------------------

    def post(self, body) -> httpx.Response:
        async def _do():
            transport = httpx.ASGITransport(app=main_mod.app)
            async with httpx.AsyncClient(
                transport=transport, base_url="http://test"
            ) as client:
                return await client.post("/positions/manual", json=body)

        return run(_do())


class MarketResolutionTests(ManualTestCase):
    def test_market_url_resolves_and_writes(self):
        client = gamma_client(
            open_by_slug={SLUG: [{"conditionId": CID, "question": QUESTION}]}
        )
        result = run(log_manual_position(
            make_request(condition_id=None, market_url=MARKET_URL),
            client=client,
        ))
        self.assertEqual(result["condition_id"], CID)
        self.assertEqual(result["question"], QUESTION)
        self.assertEqual(result["position_id"], "pos-manual-1")
        self.assertEqual(len(self.written), 1)

    def test_market_url_resolves_closed_market(self):
        # The Gamma list endpoint omits closed markets unless closed=true is
        # passed — a manual trade logged after resolution must still resolve.
        client = gamma_client(
            open_by_slug={},
            closed_by_slug={SLUG: [{"conditionId": CID, "question": QUESTION}]},
        )
        result = run(log_manual_position(
            make_request(condition_id=None, market_url=MARKET_URL),
            client=client,
        ))
        self.assertEqual(result["condition_id"], CID)

    def test_unresolvable_url_raises(self):
        client = gamma_client(open_by_slug={}, closed_by_slug={})
        with self.assertRaises(ManualPositionError):
            run(log_manual_position(
                make_request(condition_id=None, market_url=MARKET_URL),
                client=client,
            ))
        self.assertEqual(self.written, [])

    def test_condition_id_direct(self):
        result = run(log_manual_position(make_request()))
        self.assertEqual(result["condition_id"], CID)
        self.assertEqual(len(self.written), 1)

    def test_missing_both_identifiers_raises(self):
        with self.assertRaises(ManualPositionError):
            run(log_manual_position(
                make_request(condition_id=None, market_url=None)
            ))

    def test_malformed_condition_id_raises(self):
        for bad in ("0x1234", "abcd" * 16, "0x" + "zz" * 32):
            with self.assertRaises(ManualPositionError):
                run(log_manual_position(make_request(condition_id=bad)))
        self.assertEqual(self.written, [])


class ValidationTests(ManualTestCase):
    def test_invalid_direction_is_400(self):
        response = self.post({
            "condition_id": CID, "direction": "MAYBE",
            "entry_price": 0.9, "usdc_amount": 10,
        })
        self.assertEqual(response.status_code, 400)
        self.assertIn("direction", response.json()["error"])
        self.assertEqual(self.written, [])

    def test_invalid_entry_price_is_400(self):
        for bad in (0, 1, -0.2, 1.5):
            response = self.post({
                "condition_id": CID, "direction": "YES",
                "entry_price": bad, "usdc_amount": 10,
            })
            self.assertEqual(response.status_code, 400, f"entry_price={bad}")
            self.assertIn("entry_price", response.json()["error"])
        self.assertEqual(self.written, [])

    def test_invalid_usdc_amount_is_400(self):
        for bad in (0, -5):
            response = self.post({
                "condition_id": CID, "direction": "YES",
                "entry_price": 0.9, "usdc_amount": bad,
            })
            self.assertEqual(response.status_code, 400, f"usdc_amount={bad}")
            self.assertIn("usdc_amount", response.json()["error"])
        self.assertEqual(self.written, [])

    def test_unknown_field_is_400(self):
        response = self.post({
            "condition_id": CID, "direction": "YES",
            "entry_price": 0.9, "usdc_amount": 10, "sharse": 11,
        })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.written, [])

    def test_route_success_and_direction_normalised(self):
        response = self.post({
            "condition_id": CID, "direction": "yes",
            "entry_price": 0.9, "usdc_amount": 10,
        })
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["position_id"], "pos-manual-1")
        self.assertFalse(payload["simulation_id_linked"])
        self.assertEqual(self.written[0]["direction"], "YES")


class SimulationLinkTests(ManualTestCase):
    def test_simulation_found_links_and_computes_edge(self):
        self.sim_row = {
            "id": "sim-1", "probability": 0.989,
            "raw_output": {
                "question": QUESTION, "polymarket_condition_id": CID,
            },
        }
        result = run(log_manual_position(make_request()))
        self.assertTrue(result["simulation_id_linked"])
        self.assertEqual(result["simulation_id"], "sim-1")
        row = self.written[0]
        self.assertEqual(row["simulation_id"], "sim-1")
        self.assertAlmostEqual(row["entry_simulation_probability"], 0.989)
        self.assertAlmostEqual(row["entry_edge"], 0.089)
        self.assertEqual(result["question"], QUESTION)
        # The link query used the resolved condition id.
        self.assertEqual(self.link_calls[0][0], CID)

    def test_no_direction_uses_complement_probability(self):
        self.sim_row = {"id": "sim-1", "probability": 0.989, "raw_output": {}}
        run(log_manual_position(
            make_request(direction="NO", entry_price=0.05)
        ))
        row = self.written[0]
        self.assertAlmostEqual(row["entry_simulation_probability"], 0.011)
        self.assertAlmostEqual(row["entry_edge"], -0.039)

    def test_no_simulation_still_writes(self):
        self.sim_row = None
        result = run(log_manual_position(make_request()))
        self.assertFalse(result["simulation_id_linked"])
        row = self.written[0]
        self.assertIsNone(row["simulation_id"])
        self.assertIsNone(row["entry_simulation_probability"])
        self.assertIsNone(row["entry_edge"])
        self.assertEqual(row["status"], "open")
        self.assertIn("No scan", result["message"])


class SharesAndMarkerTests(ManualTestCase):
    def test_shares_computed_when_absent(self):
        run(log_manual_position(make_request()))
        self.assertAlmostEqual(self.written[0]["shares"], 11.111111, places=6)

    def test_shares_used_when_provided(self):
        run(log_manual_position(make_request(shares=11.0)))
        self.assertEqual(self.written[0]["shares"], 11.0)

    def test_tx_hash_always_none(self):
        self.sim_row = {"id": "sim-1", "probability": 0.5, "raw_output": {}}
        run(log_manual_position(make_request()))
        self.sim_row = None
        run(log_manual_position(make_request(direction="NO")))
        for row in self.written:
            self.assertIn("tx_hash", row)
            self.assertIsNone(row["tx_hash"])
            self.assertEqual(row["entry_implied_odds"], row["entry_price"])
            self.assertIsNone(row["market_id"])


class MonitorPickupTests(ManualTestCase):
    """A manually-logged position must ride the existing monitor sweep
    unmodified — priced when its linked simulation resolves a market, and
    skipped as unpriceable (never crashed on) when simulation_id is None."""

    def _monitor_sweep(self, position: TradePosition, sim_rows, gamma_market):
        async def fake_open_positions():
            return [position]

        async def fake_sims(ids):
            return sim_rows

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "gamma-api.polymarket.com":
                return httpx.Response(200, json=gamma_market)
            return httpx.Response(200, json={"ok": True})

        orig = (monitor_mod.get_open_positions, monitor_mod.get_simulations_by_ids)
        monitor_mod.get_open_positions = fake_open_positions
        monitor_mod.get_simulations_by_ids = fake_sims
        try:
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            monitor = PositionMonitor(client=client, token="tok", chat_id="chat")
            return run(monitor.check_positions())
        finally:
            (
                monitor_mod.get_open_positions,
                monitor_mod.get_simulations_by_ids,
            ) = orig

    def _logged_position(self, **request_overrides) -> TradePosition:
        result = run(log_manual_position(make_request(**request_overrides)))
        row = dict(self.written[-1])
        row["id"] = result["position_id"]
        return TradePosition(**row)

    def test_monitor_prices_linked_manual_position(self):
        self.sim_row = {
            "id": "sim-1", "probability": 0.6,
            "raw_output": {"polymarket_condition_id": CID, "question": QUESTION},
        }
        position = self._logged_position(entry_price=0.5)
        result = self._monitor_sweep(
            position,
            sim_rows=[{"id": "sim-1", "asset": "xrp", "raw_output": {
                "polymarket_condition_id": CID, "question": QUESTION,
            }}],
            gamma_market=[{
                "active": True, "closed": False,
                "outcomePrices": json.dumps(["0.55", "0.45"]),
            }],
        )
        self.assertEqual(result.positions_checked, 1)
        self.assertEqual(result.errors, 0)
        self.assertEqual(result.positions_unpriceable, 0)

    def test_monitor_skips_unlinked_manual_position_without_error(self):
        self.sim_row = None
        position = self._logged_position()
        result = self._monitor_sweep(position, sim_rows=[], gamma_market=[])
        self.assertEqual(result.positions_checked, 1)
        self.assertEqual(result.positions_unpriceable, 1)
        self.assertEqual(result.errors, 0)


if __name__ == "__main__":
    unittest.main()
