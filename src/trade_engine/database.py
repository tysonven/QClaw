#!/usr/bin/env python3
"""Supabase access via direct PostgREST calls over httpx.

Deliberately not supabase-py: httpx is already installed on this host and
used elsewhere, and PostgREST is a plain REST surface. Fewer dependencies,
no sync/async client split to reason about.

Every request carries the service_role key. All four trading_* tables have
RLS enabled with a single `service_role_all` policy, so anon credentials get
zero rows (not an error) — using service_role is required, not optional.

Errors are never swallowed: any non-2xx raises SupabaseError carrying the
status code and response body.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from src.trade_engine.config import config
from src.trade_engine.models import TradingConfig, TradePosition

log = logging.getLogger("trade_engine.database")

REQUEST_TIMEOUT = httpx.Timeout(20.0, connect=10.0)

_client: Optional[httpx.AsyncClient] = None


class SupabaseError(RuntimeError):
    """Non-2xx from PostgREST, or a malformed/absent expected row."""

    def __init__(self, method: str, path: str, status_code: int, body: str) -> None:
        self.method = method
        self.path = path
        self.status_code = status_code
        self.body = body
        super().__init__(f"{method} {path} -> HTTP {status_code}: {body[:500]}")


def get_client() -> httpx.AsyncClient:
    """Lazily create the shared async client. Reused across requests so we
    keep connections warm rather than reconnecting per call."""
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            base_url=config.supabase_rest_url, timeout=REQUEST_TIMEOUT
        )
    return _client


async def close_client() -> None:
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None


async def _request(
    method: str,
    path: str,
    *,
    params: Optional[dict[str, Any]] = None,
    json_body: Any = None,
    write: bool = False,
) -> Any:
    """Issue a PostgREST request and return the decoded JSON body.

    Logs request and response at DEBUG. Headers are never logged — they carry
    the service_role key.
    """
    client = get_client()
    log.debug("-> %s %s params=%s body=%s", method, path, params, json_body)

    response = await client.request(
        method,
        path,
        params=params,
        json=json_body,
        headers=config.supabase_headers(write=write),
    )

    log.debug(
        "<- %s %s HTTP %s body=%s",
        method,
        path,
        response.status_code,
        response.text[:1000],
    )

    if response.status_code >= 300:
        raise SupabaseError(method, path, response.status_code, response.text)

    if response.status_code == 204 or not response.content:
        return None
    return response.json()


async def get_trading_config() -> TradingConfig:
    """Read the single trading_config row (id=1). Raises if absent."""
    rows = await _request("GET", "/trading_config", params={"id": "eq.1"})
    if not rows:
        raise SupabaseError("GET", "/trading_config", 200, "no row with id=1")
    return TradingConfig.model_validate(rows[0])


async def get_open_positions() -> list[TradePosition]:
    """All positions with status='open', newest first."""
    rows = await _request(
        "GET",
        "/trading_positions",
        params={"status": "eq.open", "order": "opened_at.desc"},
    )
    return [TradePosition.model_validate(r) for r in (rows or [])]


async def get_resolved_positions(limit: int = 20) -> list[TradePosition]:
    """Most recently closed positions — context for the Analyst (Session 4)."""
    rows = await _request(
        "GET",
        "/trading_positions",
        params={
            "status": "eq.closed",
            "order": "closed_at.desc",
            "limit": str(limit),
        },
    )
    return [TradePosition.model_validate(r) for r in (rows or [])]


async def write_position(position: dict[str, Any]) -> dict[str, Any]:
    """Insert a position and return the created row.

    Untested against live data in Session 1 — trading_positions is empty and
    nothing in this session calls it. First real exercise is Session 5.
    """
    rows = await _request(
        "POST", "/trading_positions", json_body=position, write=True
    )
    if not rows:
        raise SupabaseError(
            "POST", "/trading_positions", 200, "insert returned no representation"
        )
    return rows[0]


async def update_position(
    position_id: str, updates: dict[str, Any]
) -> dict[str, Any]:
    """Patch one position by id and return the updated row."""
    rows = await _request(
        "PATCH",
        "/trading_positions",
        params={"id": f"eq.{position_id}"},
        json_body=updates,
        write=True,
    )
    if not rows:
        raise SupabaseError(
            "PATCH",
            "/trading_positions",
            200,
            f"no row updated for id={position_id}",
        )
    return rows[0]


async def get_simulations_by_ids(sim_ids: list[str]) -> list[dict[str, Any]]:
    """Fetch trading_simulations rows by id.

    Read-only. Used by the Analyst to resolve a resolved position's asset and
    market question: trading_positions carries neither, only a simulation_id
    FK. Returns raw dicts rather than SimulationResult because the caller only
    needs `asset` and `raw_output`.
    """
    if not sim_ids:
        return []
    quoted = ",".join(f'"{s}"' for s in sim_ids)
    rows = await _request(
        "GET",
        "/trading_simulations",
        params={"id": f"in.({quoted})", "select": "id,asset,raw_output"},
    )
    return rows or []


async def get_recent_simulations(limit: int = 10) -> list[dict[str, Any]]:
    """Most recent trading_simulations rows, newest first.

    Read-only, for GET /simulations (the Charlie trading-api skill). raw_output
    is included deliberately: it carries `question` and
    `polymarket_condition_id`, which is how a market someone names in chat
    gets mapped to a condition_id for /positions/manual.
    """
    rows = await _request(
        "GET",
        "/trading_simulations",
        params={
            "select": "id,asset,probability,edge,implied_odds,current_price,"
                      "created_at,raw_output",
            "order": "created_at.desc",
            "limit": str(limit),
        },
    )
    return rows or []


async def get_latest_simulation_for_condition(
    condition_id: str, since_iso: str
) -> Optional[dict[str, Any]]:
    """Newest simulation of one market since `since_iso`, or None.

    Matches on raw_output->>polymarket_condition_id — the only place a
    simulation row records which Polymarket market it simulated (market_id is
    a uuid FK to the empty trading_markets table). PostgREST accepts the JSON
    operator directly as a query key; verified live 2026-08-11.
    """
    rows = await _request(
        "GET",
        "/trading_simulations",
        params={
            "select": "id,asset,probability,edge,implied_odds,created_at,"
                      "raw_output",
            "raw_output->>polymarket_condition_id": f"eq.{condition_id}",
            "created_at": f"gte.{since_iso}",
            "order": "created_at.desc",
            "limit": "1",
        },
    )
    return rows[0] if rows else None


async def write_simulation(sim: dict[str, Any]) -> dict[str, Any]:
    """Insert one trading_simulations row and return it.

    Callers must NOT set `market_id`: the column is uuid with an FK to
    trading_markets.id, while Polymarket ids are numeric strings and
    conditionIds are 66-char hex. The Polymarket identifier belongs in
    raw_output.polymarket_market_id, which is what every existing row does.
    """
    if "market_id" in sim:
        raise ValueError(
            "market_id must not be set on trading_simulations — it is a uuid FK "
            "to trading_markets.id; put the Polymarket id in "
            "raw_output.polymarket_market_id instead"
        )
    rows = await _request("POST", "/trading_simulations", json_body=sim, write=True)
    if not rows:
        raise SupabaseError(
            "POST", "/trading_simulations", 200, "insert returned no representation"
        )
    return rows[0]


async def get_daily_pnl() -> float:
    """Sum pnl over positions closed since UTC midnight.

    Summed in Python because PostgREST aggregate functions are disabled on
    this project. Rows with a NULL pnl count as 0. Negative result = loss,
    which is what the daily_loss_limit brake compares against.
    """
    midnight = datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    rows = await _request(
        "GET",
        "/trading_positions",
        params={
            "status": "eq.closed",
            "closed_at": f"gte.{midnight.isoformat()}",
            "select": "pnl",
        },
    )
    return float(sum((r.get("pnl") or 0) for r in (rows or [])))


async def count_open_positions() -> int:
    """Cheap count for /health — asks PostgREST for the count header only."""
    return await _count_positions({"status": "eq.open", "select": "id"})


async def count_all_positions() -> int:
    """Total rows in trading_positions, open and closed. /health only."""
    return await _count_positions({"select": "id"})


async def _count_positions(params: dict[str, Any]) -> int:
    """Shared count-header read. Raises SupabaseError on anything unparseable —
    a count that silently returns 0 would read as "no exposure" to the caller."""
    client = get_client()
    response = await client.get(
        "/trading_positions",
        params=params,
        headers={**config.supabase_headers(), "Prefer": "count=exact", "Range": "0-0"},
    )
    log.debug("<- GET /trading_positions (count) HTTP %s", response.status_code)
    if response.status_code >= 300:
        raise SupabaseError(
            "GET", "/trading_positions", response.status_code, response.text
        )
    # Content-Range looks like "0-0/12", or "*/0" when the table is empty.
    content_range = response.headers.get("content-range", "")
    total = content_range.split("/")[-1] if "/" in content_range else ""
    if not total.isdigit():
        raise SupabaseError(
            "GET",
            "/trading_positions",
            response.status_code,
            f"unparseable content-range: {content_range!r}",
        )
    return int(total)
