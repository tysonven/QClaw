#!/usr/bin/env python3
"""Manual position logging — the learning-loop path for hand-executed trades.

When the automated executor is blocked (e.g. the Polymarket "maker address
not allowed" rejection), trades happen in the Polymarket UI and never reach
trading_positions, so the Analyst learns nothing from them. This module
records such a trade after the fact: resolve the market to a conditionId,
link it to the most recent Monte Carlo simulation of that market if one
exists, and write a trading_positions row shaped exactly like the executor's.
From that row on, the Position Monitor and Analyst treat the position like
any automated one.

tx_hash is always None here — automated entries always record a real hash,
so NULL tx_hash is the durable marker for "entered by hand".

Nothing in this module talks to the CLOB or moves money.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import urlparse

import httpx

from src.trade_engine.database import (
    get_latest_simulation_for_condition,
    write_position,
)
from src.trade_engine.models import ManualPositionRequest

log = logging.getLogger("trade_engine.manual")

GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets"
CONDITION_ID_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")

# How far back to look for a simulation of the same market. A scan runs every
# two hours, so 24h comfortably covers "Tyson traded off a recent scan" while
# refusing to attribute a stale week-old probability to today's entry.
SIMULATION_LINK_WINDOW_HOURS = 24

RESOLVE_TIMEOUT = httpx.Timeout(20.0, connect=10.0)


class ManualPositionError(ValueError):
    """Invalid manual-position input. The message is operator-facing and is
    returned verbatim in the 400 body — never include internals in it."""


def _validated(req: ManualPositionRequest) -> ManualPositionRequest:
    """Range/format checks beyond what pydantic types give us. Raises
    ManualPositionError with a message that tells the caller how to fix it."""
    if not req.market_url and not req.condition_id:
        raise ManualPositionError(
            "provide market_url or condition_id to identify the market"
        )
    if req.condition_id and not CONDITION_ID_RE.match(req.condition_id):
        raise ManualPositionError(
            "condition_id must be 0x followed by 64 hex characters"
        )
    if req.direction.upper() not in ("YES", "NO"):
        raise ManualPositionError("direction must be YES or NO")
    if not 0 < req.entry_price < 1:
        raise ManualPositionError(
            "entry_price must be between 0 and 1 exclusive (65 cents = 0.65)"
        )
    if req.usdc_amount <= 0:
        raise ManualPositionError("usdc_amount must be greater than 0")
    if req.shares is not None and req.shares <= 0:
        raise ManualPositionError("shares, when given, must be greater than 0")
    return req


async def _resolve_from_url(
    market_url: str, client: httpx.AsyncClient
) -> tuple[str, Optional[str]]:
    """Market URL -> (conditionId, question) via the Gamma slug lookup.

    Tries the last two path segments as slugs, which covers both
    /market/<slug> and /event/<event-slug>/<market-slug> URL shapes. Each
    slug is queried twice: the Gamma LIST endpoint silently omits closed
    markets unless closed=true is passed (verified 2026-08-11 against market
    3257488), and a manual trade may well be logged after its market
    resolves.
    """
    parsed = urlparse(
        market_url if "://" in market_url else f"https://{market_url}"
    )
    segments = [
        s for s in parsed.path.split("/") if s and s not in ("event", "market")
    ]
    if not segments:
        raise ManualPositionError(
            f"could not extract a market slug from {market_url!r} — "
            "pass condition_id instead"
        )

    for slug in reversed(segments[-2:]):
        for params in ({"slug": slug}, {"slug": slug, "closed": "true"}):
            try:
                response = await client.get(GAMMA_MARKETS_URL, params=params)
            except httpx.HTTPError as exc:
                raise ManualPositionError(
                    "Gamma market lookup failed — retry, or pass condition_id "
                    "instead"
                ) from exc
            if response.status_code >= 300:
                continue
            try:
                rows = response.json()
            except ValueError:
                continue
            if isinstance(rows, list) and rows and isinstance(rows[0], dict):
                condition_id = str(rows[0].get("conditionId") or "")
                if CONDITION_ID_RE.match(condition_id):
                    question = rows[0].get("question")
                    return condition_id, (str(question) if question else None)

    raise ManualPositionError(
        f"no Polymarket market found for {market_url!r} — check the URL or "
        "pass condition_id instead"
    )


async def log_manual_position(
    req: ManualPositionRequest, *, client: Optional[httpx.AsyncClient] = None
) -> dict[str, Any]:
    """Validate, resolve, link and record one manually-executed trade.

    Returns the response body for POST /positions/manual. Raises
    ManualPositionError for anything the caller can fix (-> 400) and lets
    SupabaseError propagate (-> 503 in the route).
    """
    _validated(req)
    direction = req.direction.upper()
    entry_price = float(req.entry_price)
    usdc_amount = float(req.usdc_amount)

    question: Optional[str] = None
    if req.condition_id:
        condition_id = req.condition_id.lower()
    else:
        owns_client = client is None
        if owns_client:
            client = httpx.AsyncClient(timeout=RESOLVE_TIMEOUT)
        try:
            condition_id, question = await _resolve_from_url(
                str(req.market_url), client
            )
        finally:
            if owns_client:
                await client.aclose()
        condition_id = condition_id.lower()

    since = (
        datetime.now(timezone.utc)
        - timedelta(hours=SIMULATION_LINK_WINDOW_HOURS)
    ).isoformat()
    simulation = await get_latest_simulation_for_condition(condition_id, since)

    simulation_id: Optional[str] = None
    entry_simulation_probability: Optional[float] = None
    entry_edge: Optional[float] = None
    if simulation is not None:
        simulation_id = simulation.get("id")
        raw = simulation.get("raw_output") or {}
        question = question or raw.get("question")
        probability = simulation.get("probability")
        if probability is not None:
            # trading_simulations.probability is the YES probability; the
            # position stores the DIRECTION-SIDE probability (matching the
            # executor, whose tradeable candidates are always YES-side), and
            # the edge is anchored to the price actually paid rather than the
            # scan-time market price the stored `edge` column used.
            side_probability = (
                float(probability) if direction == "YES"
                else 1.0 - float(probability)
            )
            entry_simulation_probability = round(side_probability, 6)
            entry_edge = round(side_probability - entry_price, 6)

    shares = (
        float(req.shares) if req.shares is not None
        else round(usdc_amount / entry_price, 6)
    )

    row = await write_position({
        # Same row shape the executor writes, minus the CLOB fill:
        # market_id stays NULL (uuid FK to the empty trading_markets table)
        # and simulation_id is the only route back to a priceable market.
        "market_id": None,
        "simulation_id": simulation_id,
        "direction": direction,
        "usdc_amount": usdc_amount,
        "entry_price": entry_price,
        "shares": shares,
        "entry_edge": entry_edge,
        "entry_simulation_probability": entry_simulation_probability,
        # The direction-side price paid IS the market's implied odds at entry.
        "entry_implied_odds": entry_price,
        "status": "open",
        "opened_at": datetime.now(timezone.utc).isoformat(),
        # NULL tx_hash marks a manual entry — automated trades always record
        # a real transaction hash.
        "tx_hash": None,
    })

    position_id = str(row.get("id")) if row.get("id") is not None else None
    linked = simulation_id is not None
    label = question or f"{condition_id[:10]}…"
    message = (
        f"Position logged: {direction} @ {entry_price:.2f}, "
        f"${usdc_amount:.2f} ({shares:g} shares) on {label}. "
        + (
            f"Linked to scan {simulation_id} — the Analyst will learn from "
            "this trade's outcome."
            if linked else
            "No scan of this market in the last 24h — logged without "
            "simulation context."
        )
    )
    log.info(
        "manual position %s: %s @ %.4f $%.2f cid=%s… sim=%s",
        position_id, direction, entry_price, usdc_amount,
        condition_id[:12], simulation_id,
    )

    return {
        "position_id": position_id,
        "simulation_id_linked": linked,
        "simulation_id": simulation_id,
        "condition_id": condition_id,
        "question": question,
        "direction": direction,
        "entry_price": entry_price,
        "shares": shares,
        "usdc_amount": usdc_amount,
        "entry_simulation_probability": entry_simulation_probability,
        "entry_edge": entry_edge,
        "message": message,
    }
