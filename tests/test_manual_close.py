"""Tests for POST /positions/manual-close, POST /positions/{id}/hold and
GET /positions/{id} in src/trade_engine/main.py.

Stdlib unittest, matching tests/test_manual_position.py. No network, no
Supabase: database._request is replaced by an in-memory PostgREST stand-in
that honours the two filters these routes depend on (eq. and is.null), so the
real database.py functions run and the PARAMS they send are what the tests
pin. A fake that ignored the status filter would pass against a handler that
never sent one, which is the fixture-agrees-with-the-hardcode trap in
docs/trade-engine-handoff.md.

Background (2026-09-10 audit of the 2026-08-27 composed-id incident):

  * a composed id like "solana-110-aug-2026" got a 404 from the close route
    but a 503 from the hold route, and a real id on a CLOSED position got a
    200 from hold;
  * two overlapping closes of the same open position both returned 200 and
    the last writer's numbers stayed on the row, because the PATCH filtered
    on id alone;
  * nothing could read one position by id regardless of status, which the
    approval prompt and the post-error re-read both need.

Run:
    python3 -m unittest tests/test_manual_close.py
"""

import asyncio
import json
import os
import sys
import unittest
from typing import Any, Optional

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

for _key in (
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY",
    "TELEGRAM_BOT_TOKEN", "OWNER_TELEGRAM_CHAT_ID",
    "POLYMARKET_PRIVATE_KEY", "POLYMARKET_FUNDER_ADDRESS",
):
    os.environ.setdefault(_key, f"test-{_key.lower()}")

import httpx  # noqa: E402
from fastapi import Request  # noqa: E402

from src.trade_engine import database as db_mod  # noqa: E402
from src.trade_engine import main as main_mod  # noqa: E402
from src.trade_engine.database import PositionStateConflict, SupabaseError  # noqa: E402

OPEN_ID = "b3cecdef-9948-40c7-9691-1b9c4ce579bc"
CLOSED_ID = "f4be9ee8-15e5-4793-908f-0968944a1cec"
UNKNOWN_ID = "00000000-0000-4000-8000-000000000000"
COMPOSED_ID = "solana-110-aug-2026"  # the 2026-08-27 incident value
SIM_ID = "d9905812-6a34-4b5b-923a-866b4d42e57f"
QUESTION = "Will Solana reach $110 in August?"


def run(coro):
    return asyncio.run(coro)


class FakePostgrest:
    """Just enough PostgREST: eq./is.null filters over three tables, PATCH
    applied only to the rows the filter matches, every call recorded."""

    def __init__(self) -> None:
        self.positions: dict[str, dict[str, Any]] = {}
        self.alerts: list[dict[str, Any]] = []
        self.simulations: dict[str, dict[str, Any]] = {}
        self.calls: list[tuple[str, str, dict[str, Any], Any]] = []
        self.after_positions_read = None  # async hook, runs after a GET is evaluated
        self.fail_paths: set[tuple[str, str]] = set()  # (method, path) -> raise

    async def request(self, method, path, *, params=None, json_body=None, write=False):
        params = dict(params or {})
        self.calls.append((method, path, params, json_body))
        if (method, path) in self.fail_paths:
            raise SupabaseError(method, path, 500, "injected failure")
        if path == "/trading_positions":
            if method == "GET":
                rows = [dict(r) for r in self.positions.values() if self._match(r, params)]
                if self.after_positions_read is not None:
                    await self.after_positions_read()
                return rows
            if method == "PATCH":
                matched = [r for r in self.positions.values() if self._match(r, params)]
                for r in matched:
                    r.update(json_body)
                return [dict(r) for r in matched]
        if path == "/trading_position_alerts":
            matched = [a for a in self.alerts if self._match(a, params)]
            if method == "PATCH":
                for a in matched:
                    a.update(json_body)
            return [dict(a) for a in matched]
        if path == "/trading_simulations" and method == "GET":
            inner = params["id"][len("in.("):-1]
            ids = [s.strip('"') for s in inner.split(",")]
            return [self.simulations[i] for i in ids if i in self.simulations]
        raise AssertionError(f"unexpected {method} {path} {params}")

    @staticmethod
    def _match(row: dict[str, Any], params: dict[str, Any]) -> bool:
        for key, value in params.items():
            if key in ("order", "limit", "select"):
                continue
            if value == "is.null":
                if row.get(key) is not None:
                    return False
            elif isinstance(value, str) and value.startswith("eq."):
                if str(row.get(key)) != value[3:]:
                    return False
            else:
                raise AssertionError(f"unsupported filter {key}={value!r}")
        return True

    def patches(self, path="/trading_positions"):
        return [(p, b) for (m, pth, p, b) in self.calls if m == "PATCH" and pth == path]


def position_row(pid: str, status: str, **extra) -> dict[str, Any]:
    base = {
        "id": pid, "status": status, "direction": "YES", "entry_price": 0.483,
        "shares": 20.7, "usdc_amount": 10.36, "simulation_id": SIM_ID,
        "opened_at": "2026-08-27T12:15:30+00:00", "manual_hold": False,
        "exit_price": None, "exit_usdc": None, "pnl": None, "closed_at": None,
    }
    base.update(extra)
    return base


def make_close_request(body: dict) -> Request:
    """A Request the handler coroutine can consume directly, so two closes
    can genuinely overlap. Through the HTTP client they serialise."""
    raw = json.dumps(body).encode()

    async def receive():
        return {"type": "http.request", "body": raw, "more_body": False}

    scope = {
        "type": "http", "method": "POST", "path": "/positions/manual-close",
        "headers": [(b"content-type", b"application/json")], "query_string": b"",
    }
    return Request(scope, receive)


class CloseTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.pg = FakePostgrest()
        self.pg.positions[OPEN_ID] = position_row(OPEN_ID, "open")
        self.pg.positions[CLOSED_ID] = position_row(
            CLOSED_ID, "closed", exit_price=0.565, exit_usdc=19.89, pnl=9.89,
            closed_at="2026-08-25T10:42:19+00:00",
        )
        self.pg.simulations[SIM_ID] = {
            "id": SIM_ID, "asset": "sol", "raw_output": {"question": QUESTION},
        }
        self.pg.alerts.append({
            "id": "alert-1", "position_id": OPEN_ID, "alert_type": "take_profit",
            "trigger_price": 0.8555, "triggered_at": "2026-08-27T16:55:06+00:00",
            "resolved_at": None, "resolution_note": None,
        })
        self._orig_request = db_mod._request
        db_mod._request = self.pg.request

    def tearDown(self) -> None:
        db_mod._request = self._orig_request

    # --- helpers ----------------------------------------------------------

    def http(self, method: str, path: str, body: Optional[dict] = None) -> httpx.Response:
        async def _do():
            transport = httpx.ASGITransport(app=main_mod.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
                return await c.request(method, path, json=body)
        return run(_do())

    def close(self, body: dict) -> httpx.Response:
        return self.http("POST", "/positions/manual-close", body)


# ── GET /positions/{id} ──────────────────────────────────────────────────

class PositionByIdTests(CloseTestCase):
    def test_closed_row_is_returned_with_status_and_question(self):
        r = self.http("GET", f"/positions/{CLOSED_ID}")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["status"], "closed")
        self.assertEqual(body["position"]["exit_usdc"], 19.89)
        self.assertEqual(body["question"], QUESTION)
        self.assertEqual(body["unresolved_alert_count"], 0)
        self.assertEqual(body["lookups"], {"question": "ok", "alerts": "ok"})

    def test_open_row_reports_live_alert_count(self):
        r = self.http("GET", f"/positions/{OPEN_ID}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "open")
        self.assertEqual(r.json()["unresolved_alert_count"], 1)

    def test_unknown_uuid_is_404(self):
        r = self.http("GET", f"/positions/{UNKNOWN_ID}")
        self.assertEqual(r.status_code, 404, r.text)
        self.assertIn(UNKNOWN_ID, r.json()["error"])

    def test_composed_id_is_404_and_never_reaches_postgrest(self):
        r = self.http("GET", f"/positions/{COMPOSED_ID}")
        self.assertEqual(r.status_code, 404, r.text)
        self.assertIn("not one", r.json()["hint"])
        self.assertEqual(self.pg.calls, [], "a non-uuid must be refused locally")

    def test_alerts_path_is_not_captured_by_the_id_route(self):
        r = self.http("GET", "/positions/alerts")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("alerts", r.json())
        self.assertEqual(r.json()["count"], 1)

    def test_failed_secondary_lookups_are_labelled_not_defaulted(self):
        self.pg.fail_paths.add(("GET", "/trading_simulations"))
        self.pg.fail_paths.add(("GET", "/trading_position_alerts"))
        r = self.http("GET", f"/positions/{OPEN_ID}")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["status"], "open")
        self.assertIsNone(body["question"])
        self.assertIsNone(body["unresolved_alert_count"])
        self.assertEqual(body["lookups"], {"question": "failed", "alerts": "failed"})


# ── POST /positions/manual-close ─────────────────────────────────────────

class ManualCloseTests(CloseTestCase):
    def test_composed_id_is_404_and_writes_nothing(self):
        r = self.close({"position_id": COMPOSED_ID, "exit_price": 0.863, "exit_usdc": 17.86})
        self.assertEqual(r.status_code, 404, r.text)
        self.assertIn("not one", r.json()["hint"])
        self.assertEqual(self.pg.patches(), [])
        self.assertEqual(self.pg.calls, [], "refused before any read or write")

    def test_unknown_uuid_is_404_and_writes_nothing(self):
        r = self.close({"position_id": UNKNOWN_ID, "exit_price": 0.863, "exit_usdc": 17.86})
        self.assertEqual(r.status_code, 404, r.text)
        self.assertEqual(self.pg.patches(), [])

    def test_success_path_writes_once_and_resolves_the_alert(self):
        r = self.close({"position_id": OPEN_ID, "exit_price": 0.863, "exit_usdc": 17.86})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["position"]["status"], "closed")
        self.assertEqual(body["position"]["pnl"], 7.5)
        self.assertEqual(len(body["resolved_alerts"]), 1)
        self.assertEqual(len(self.pg.patches()), 1)

    def test_patch_is_conditional_on_status_open(self):
        """The guarantee is the filter PostgREST evaluates, so pin the params
        the handler sends rather than the fake's outcome alone."""
        self.close({"position_id": OPEN_ID, "exit_price": 0.863, "exit_usdc": 17.86})
        params, _body = self.pg.patches()[0]
        self.assertEqual(params, {"id": f"eq.{OPEN_ID}", "status": "eq.open"})

    def test_second_sequential_close_is_404(self):
        first = self.close({"position_id": OPEN_ID, "exit_price": 0.863, "exit_usdc": 17.86})
        second = self.close({"position_id": OPEN_ID, "exit_price": 0.50, "exit_usdc": 10.0})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 404, second.text)
        self.assertEqual(len(self.pg.patches()), 1)
        self.assertEqual(self.pg.positions[OPEN_ID]["exit_usdc"], 17.86)

    def test_closed_between_read_and_write_is_409_and_resolves_no_alert(self):
        """The row is open when the handler reads it and closed by the time
        it writes. The conditional PATCH matches nothing: 409, no alert
        resolution, the other writer's numbers stay."""
        async def close_underneath():
            self.pg.positions[OPEN_ID].update(
                status="closed", exit_price=0.50, exit_usdc=10.0, pnl=-0.36,
            )
        self.pg.after_positions_read = close_underneath

        r = self.close({"position_id": OPEN_ID, "exit_price": 0.863, "exit_usdc": 17.86})
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("nothing written", r.json()["error"])
        self.assertEqual(len(self.pg.patches()), 1, "the PATCH was attempted")
        self.assertEqual(self.pg.patches("/trading_position_alerts"), [],
                         "no alert may be resolved by a close that did not land")
        self.assertEqual(self.pg.positions[OPEN_ID]["exit_usdc"], 10.0)
        self.assertIsNone(self.pg.alerts[0]["resolved_at"])

    def test_concurrent_double_close_exactly_one_succeeds(self):
        """Both requests read the position as open before either writes (a
        barrier in the fake read guarantees the interleaving). Before the
        conditional PATCH both returned 200 and both wrote."""
        barrier = asyncio.Barrier(2)

        async def wait_for_both_reads():
            await barrier.wait()
        self.pg.after_positions_read = wait_for_both_reads

        async def _do():
            return await asyncio.wait_for(asyncio.gather(
                main_mod.positions_manual_close(make_close_request(
                    {"position_id": OPEN_ID, "exit_price": 0.863, "exit_usdc": 17.86})),
                main_mod.positions_manual_close(make_close_request(
                    {"position_id": OPEN_ID, "exit_price": 0.50, "exit_usdc": 10.0})),
            ), timeout=5)
        a, b = run(_do())
        statuses = sorted([a.status_code, b.status_code])
        self.assertEqual(statuses, [200, 409], f"{a.body!r} {b.body!r}")
        applied = [p for p in self.pg.patches() if p[0].get("status") == "eq.open"]
        self.assertEqual(len(applied), 2, "both attempted the conditional PATCH")
        winner = a if a.status_code == 200 else b
        won = json.loads(winner.body)["position"]
        self.assertEqual(self.pg.positions[OPEN_ID]["exit_usdc"], won["exit_usdc"],
                         "the row carries the winner's numbers, not the last writer's")
        self.assertEqual(len(self.pg.patches("/trading_position_alerts")), 1,
                         "exactly one close resolved the alert")

    def test_market_url_instead_of_position_id_is_400(self):
        r = self.close({"market_url": "https://polymarket.com/event/x", "exit_price": 0.863})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(self.pg.calls, [])


# ── POST /positions/{id}/hold ────────────────────────────────────────────

class HoldTests(CloseTestCase):
    def test_composed_id_is_404_not_503_and_never_reaches_postgrest(self):
        r = self.http("POST", f"/positions/{COMPOSED_ID}/hold", {"hold": True})
        self.assertEqual(r.status_code, 404, r.text)
        self.assertIn("no OPEN position", r.json()["error"])
        self.assertEqual(self.pg.calls, [])

    def test_closed_position_is_404_and_flag_unchanged(self):
        r = self.http("POST", f"/positions/{CLOSED_ID}/hold", {"hold": True})
        self.assertEqual(r.status_code, 404, r.text)
        self.assertIn("no OPEN position", r.json()["error"])
        self.assertFalse(self.pg.positions[CLOSED_ID]["manual_hold"])

    def test_unknown_uuid_is_404(self):
        r = self.http("POST", f"/positions/{UNKNOWN_ID}/hold", {"hold": True})
        self.assertEqual(r.status_code, 404, r.text)

    def test_open_position_hold_and_release_are_200_and_conditional(self):
        r = self.http("POST", f"/positions/{OPEN_ID}/hold", {"hold": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(self.pg.positions[OPEN_ID]["manual_hold"])
        r = self.http("POST", f"/positions/{OPEN_ID}/hold", {"hold": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(self.pg.positions[OPEN_ID]["manual_hold"])
        for params, _body in self.pg.patches():
            self.assertEqual(params, {"id": f"eq.{OPEN_ID}", "status": "eq.open"})

    def test_transport_failure_is_still_503(self):
        self.pg.fail_paths.add(("PATCH", "/trading_positions"))
        r = self.http("POST", f"/positions/{OPEN_ID}/hold", {"hold": True})
        self.assertEqual(r.status_code, 503, r.text)


# ── database.update_position contract ────────────────────────────────────

class UpdatePositionContractTests(CloseTestCase):
    def test_unconditional_default_keeps_old_error_type(self):
        with self.assertRaises(SupabaseError) as ctx:
            run(db_mod.update_position(UNKNOWN_ID, {"manual_hold": True}))
        self.assertNotIsInstance(ctx.exception, PositionStateConflict)
        self.assertEqual(self.pg.patches()[0][0], {"id": f"eq.{UNKNOWN_ID}"})

    def test_conditional_miss_raises_conflict_subclass(self):
        with self.assertRaises(PositionStateConflict):
            run(db_mod.update_position(CLOSED_ID, {"manual_hold": True}, require_status="open"))

    def test_get_position_returns_none_for_no_row(self):
        self.assertIsNone(run(db_mod.get_position(UNKNOWN_ID)))
        row = run(db_mod.get_position(CLOSED_ID))
        self.assertEqual(row.status, "closed")


if __name__ == "__main__":
    unittest.main()
