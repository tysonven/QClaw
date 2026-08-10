#!/usr/bin/env python3
"""Execute a Polymarket trade by relaying to the Amsterdam execution relay.

Polymarket geoblocks CLOB order placement from this droplet's region (UK, 403
"restricted in your region"), so the ENTIRE Polymarket-facing interaction now
happens on the relay droplet in Amsterdam (NL), where the CLOB API is not
restricted. Every CLOB call for a trade originates from the relay's single IP —
the flow is never split between here and the relay.

This script keeps the exact CLI and stdout contract its callers depend on
(src/trade_engine/executor.py and the dashboard /api/trading/execute route):
same args, same JSON shape on stdout, same exit codes (0 success / 1 error). All
it does now is POST the already-gate-approved trade to the relay and echo the
relay's response. It no longer imports py_clob_client, constructs a ClobClient,
or touches the Polymarket private key — that logic lives only on the relay.
"""

import argparse
import json
import os
import sys

import requests
from dotenv import load_dotenv

# Load env from ~/.quantumclaw/.env (same source the previous version used).
env_path = os.path.join(os.path.expanduser("~"), ".quantumclaw", ".env")
load_dotenv(env_path)

RELAY_URL = os.getenv("RELAY_URL", "http://68.183.13.219:8000").rstrip("/")
RELAY_SHARED_SECRET = os.getenv("RELAY_SHARED_SECRET")

# 30s leaves headroom under executor.py's 60s subprocess timeout, so a slow
# relay surfaces here as a clean error rather than a killed subprocess.
RELAY_TIMEOUT_SECONDS = 30


def execute_trade(market_id, direction, amount_usdc, price=None):
    """POST the trade to the relay and return its JSON response as a dict.

    Every failure mode — missing secret, connection refused, timeout, DNS
    failure, non-200, non-JSON — is turned into the same {"error": ...} shape the
    old script produced, so a caller never sees an unhandled exception from the
    money path.
    """
    if not RELAY_SHARED_SECRET:
        return {"error": "RELAY_SHARED_SECRET not set in ~/.quantumclaw/.env"}

    payload = {
        "market_id": market_id,
        "direction": direction.upper(),
        "amount_usdc": amount_usdc,
        "price": price,
    }
    headers = {
        "Authorization": f"Bearer {RELAY_SHARED_SECRET}",
        "Content-Type": "application/json",
    }

    try:
        resp = requests.post(
            f"{RELAY_URL}/execute",
            json=payload,
            headers=headers,
            timeout=RELAY_TIMEOUT_SECONDS,
        )
    except requests.exceptions.RequestException as e:
        # Connection refused, timeout, DNS failure — the relay never confirmed
        # an order. Treated as execution failure, never as a placed trade.
        return {"error": f"relay_unreachable: {type(e).__name__}"}

    if resp.status_code != 200:
        # Auth failure (401), misconfig (503), or anything else non-200. The
        # relay returns 200 for both order success and handled trade errors, so
        # a non-200 is a relay-level problem, normalised into the error shape.
        try:
            detail = str(resp.json())[:300]
        except ValueError:
            detail = (resp.text or "")[:300]
        return {"error": f"relay_error_{resp.status_code}: {detail}"}

    try:
        return resp.json()
    except ValueError:
        return {"error": "relay returned non-JSON response"}


def main():
    parser = argparse.ArgumentParser(description="Execute a Polymarket trade")
    parser.add_argument("--market", required=True, help="Polymarket market/condition ID")
    parser.add_argument("--direction", required=True, choices=["YES", "NO"], help="Trade direction")
    parser.add_argument("--amount", required=True, type=float, help="Amount in USDC")
    parser.add_argument("--price", required=False, type=float, default=None, help="Fallback price if the market order can't derive one")
    args = parser.parse_args()

    result = execute_trade(args.market, args.direction, args.amount, price=args.price)
    print(json.dumps(result, indent=2, default=str))

    if "error" in result:
        sys.exit(1)


if __name__ == "__main__":
    main()
