#!/usr/bin/env python3
"""Polymarket execution relay.

Owns 100% of the Polymarket CLOB interaction for a trade, from an Amsterdam (NL)
IP where the CLOB API is not geoblocked. qclaw's execute_trade.py POSTs the
already-gate-approved trade here instead of talking to the CLOB itself.

DESIGN CONSTRAINT (do not violate)
----------------------------------
Every CLOB call for a given trade — get_market, create_and_post_market_order —
originates from THIS host's IP, start to finish. The flow is never split with
qclaw: a mixed-origin request pattern for one trade is indistinguishable from
geoblock evasion. This service is the sole Polymarket-facing side.

This service does exactly one thing: place one already-approved order. The six
financial execution gates run on qclaw BEFORE anything reaches this relay.

CLIENT: py-clob-client-v2 (CLOB API v2). The archived v1 client is rejected by
the CLOB with "invalid order version". The account uses Polymarket's deposit
wallet flow: the funder is an ERC-1271 deposit wallet contract whose owner() is
the signer EOA, so signature_type=3 (POLY_1271). Confirmed by Polymarket
support and verified on-chain via isValidSignature (2026-08-20).
"""

import hmac
import json
import logging
import os
from contextlib import asynccontextmanager

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import Response

# Env comes from THIS droplet's own .env — never qclaw's.
ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
load_dotenv(ENV_PATH)

PRIVATE_KEY = os.getenv("POLYMARKET_PRIVATE_KEY")
FUNDER_ADDRESS = os.getenv("POLYMARKET_FUNDER_ADDRESS")
RELAY_SHARED_SECRET = os.getenv("RELAY_SHARED_SECRET")

CLOB_HOST = "https://clob.polymarket.com"
CHAIN_ID = 137  # Polygon mainnet

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
)
log = logging.getLogger("polymarket-relay")


def _geoblock_check() -> dict:
    """Is this relay geoblocked from placing CLOB orders?

    Two signals are collected, but only one decides `blocked`:

      * polymarket.com/api/geoblock reflects FRONTEND policy. NL is
        "close-only" on the frontend, so it reports blocked=true from here even
        though the API is open. We keep it ONLY for the country/region/ip it
        reports; its `blocked` is recorded as `frontend_blocked` and is NOT the
        health signal.
      * The signal that actually matters is whether the CLOB *API* geoblocks
        this IP. An empty-body POST to /order is rejected long before any order
        can form; a 403 "restricted in your region" is the geoblock, anything
        else (e.g. 401 missing auth header) means we are through the geo check.
    """
    result = {
        "blocked": None,
        "frontend_blocked": None,
        "country": None,
        "region": None,
        "ip": None,
        "api_status": None,
    }
    try:
        r = requests.get("https://polymarket.com/api/geoblock", timeout=8)
        j = r.json()
        result["frontend_blocked"] = j.get("blocked")
        result["country"] = j.get("country")
        result["region"] = j.get("region")
        result["ip"] = j.get("ip")
    except Exception as e:  # noqa: BLE001 - informational only, never fatal
        result["frontend_error"] = f"{type(e).__name__}: {e}"

    try:
        r = requests.post(f"{CLOB_HOST}/order", json={}, timeout=8)
        result["api_status"] = r.status_code
        result["blocked"] = bool(
            r.status_code == 403 and "restricted" in (r.text or "").lower()
        )
    except Exception as e:  # noqa: BLE001
        result["api_error"] = f"{type(e).__name__}: {e}"
        result["blocked"] = None  # unknown, not "fine"
    return result


@asynccontextmanager
async def lifespan(app: FastAPI):
    check = _geoblock_check()
    if check.get("blocked"):
        log.warning(
            "STARTUP GEOBLOCK WARNING: CLOB API reports this relay is GEOBLOCKED "
            "(country=%s region=%s api_status=%s) — orders will fail; this relay "
            "must run from a non-restricted region.",
            check.get("country"), check.get("region"), check.get("api_status"),
        )
    else:
        log.info(
            "startup geoblock check OK: country=%s region=%s api_status=%s",
            check.get("country"), check.get("region"), check.get("api_status"),
        )
    yield


app = FastAPI(lifespan=lifespan)


def _require_auth(authorization: str | None) -> None:
    """Reject unless the Bearer token matches RELAY_SHARED_SECRET.

    Fails CLOSED: if the secret is not configured the relay refuses everything
    rather than accepting unauthenticated order placement. Constant-time compare
    so the secret is not discoverable by timing.
    """
    if not RELAY_SHARED_SECRET:
        raise HTTPException(status_code=503, detail="relay secret not configured")
    expected = f"Bearer {RELAY_SHARED_SECRET}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


def execute_trade(market_id, direction, amount_usdc, price=None) -> dict:
    """Place one market order on Polymarket via py-clob-client-v2.

    This relay is the ONLY place this logic runs. Returns the same dict shape the
    qclaw CLI expects: {success, market_id, direction, amount_usdc, token_id,
    response} on success, or {error} on any handled failure.
    """
    if not PRIVATE_KEY:
        return {"error": "POLYMARKET_PRIVATE_KEY not set in relay .env"}
    if not FUNDER_ADDRESS:
        return {"error": "POLYMARKET_FUNDER_ADDRESS not set in relay .env"}

    try:
        from py_clob_client_v2 import ClobClient, MarketOrderArgs, OrderType, Side

        # Deposit wallet flow (POLY_1271): the funder is an ERC-1271 deposit
        # wallet contract whose owner() is the signer EOA. Under type 3 the
        # order's maker AND signer fields are both the funder; the EOA key makes
        # a nested ERC-7739 signature the wallet validates via isValidSignature.
        client = ClobClient(
            host=CLOB_HOST,
            chain_id=CHAIN_ID,
            key=PRIVATE_KEY,
            signature_type=3,
            funder=FUNDER_ADDRESS,
        )
        # Posting requires Level 2 auth; derive CLOB API creds from the private
        # key (deterministic, no extra secrets in .env). v2 renamed v1's
        # create_or_derive_api_creds -> create_or_derive_api_key.
        client.set_api_creds(client.create_or_derive_api_key())

        # Get market info to find token_id. v2 get_market returns the same dict
        # shape as v1 (tokens[].{token_id, outcome, price}); outcome is "Yes"/"No"
        # so the .upper() comparison below is unchanged.
        market = client.get_market(market_id)
        if not market:
            return {"error": f"Market {market_id} not found"}

        tokens = market.get("tokens", [])
        if not tokens:
            return {"error": "No tokens found for market"}

        # Select token based on direction
        token_id = None
        for t in tokens:
            outcome = (t.get("outcome") or "").upper()
            if direction.upper() == "YES" and outcome == "YES":
                token_id = t.get("token_id")
            elif direction.upper() == "NO" and outcome == "NO":
                token_id = t.get("token_id")

        if not token_id:
            # Fallback: YES = first token, NO = second
            if direction.upper() == "YES" and len(tokens) >= 1:
                token_id = tokens[0].get("token_id")
            elif direction.upper() == "NO" and len(tokens) >= 2:
                token_id = tokens[1].get("token_id")

        if not token_id:
            return {"error": f"Could not find {direction} token for market"}

        # Option (B): do NOT cap the order at the scanner's implied price. Pass
        # price=0 so v2's create_market_order computes the true marketable price
        # via calculate_market_price — correct market-order behaviour, and it
        # avoids a FOK kill when the ask sits above the implied price. v2 also
        # auto-resolves tick_size and neg_risk. create_and_post_market_order wraps
        # the post in _retry_on_version_update — the built-in fix for the
        # "invalid order version" rejection. The `price` request field is still
        # accepted for contract compatibility but is intentionally not used to
        # bound the order.
        order_args = MarketOrderArgs(
            token_id=token_id,
            amount=float(amount_usdc),
            side=Side.BUY,
            price=0,
            order_type=OrderType.FOK,
        )
        resp = client.create_and_post_market_order(order_args, order_type=OrderType.FOK)

        return {
            "success": True,
            "market_id": market_id,
            "direction": direction.upper(),
            "amount_usdc": amount_usdc,
            "token_id": token_id,
            "response": resp,
        }

    except Exception as e:  # noqa: BLE001 - mirror the CLI: handled error, not a crash
        return {"error": str(e)}


@app.get("/health")
async def health():
    check = _geoblock_check()
    if check.get("blocked"):
        log.warning(
            "GEOBLOCK on /health: CLOB API reports this relay is GEOBLOCKED "
            "(country=%s region=%s api_status=%s)",
            check.get("country"), check.get("region"), check.get("api_status"),
        )
    return {"status": "ok", "geoblock_check": check}


@app.post("/execute")
async def execute(request: Request, authorization: str | None = Header(default=None)):
    _require_auth(authorization)

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = None
    if not isinstance(body, dict):
        return _error_response("invalid or missing JSON body")

    market_id = body.get("market_id")
    direction = body.get("direction")
    amount_usdc = body.get("amount_usdc")
    price = body.get("price")

    if not market_id or not isinstance(market_id, str):
        return _error_response("missing/invalid market_id")
    if not isinstance(direction, str) or direction.upper() not in ("YES", "NO"):
        return _error_response("missing/invalid direction (YES|NO)")
    if amount_usdc is None:
        return _error_response("missing amount_usdc")

    log.info(
        "execute: market=%s... direction=%s amount=%s",
        str(market_id)[:12], str(direction).upper(), amount_usdc,
    )
    result = execute_trade(market_id, direction, amount_usdc, price=price)

    # Serialize with default=str to match the qclaw CLI's json.dumps(default=str):
    # the CLOB response can carry non-JSON-native types. qclaw keys success vs
    # failure on the presence of an "error" field in this body, so both success
    # and handled-error return HTTP 200 with a JSON body.
    return Response(
        content=json.dumps(result, default=str),
        media_type="application/json",
        status_code=200,
    )


def _error_response(message: str) -> Response:
    return Response(
        content=json.dumps({"error": message}),
        media_type="application/json",
        status_code=200,
    )
