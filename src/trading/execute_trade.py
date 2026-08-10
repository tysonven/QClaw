#!/usr/bin/env python3
"""Execute a trade on Polymarket via py-clob-client."""

import argparse
import json
import os
import sys
from dotenv import load_dotenv

# Load env from ~/.quantumclaw/.env
env_path = os.path.join(os.path.expanduser("~"), ".quantumclaw", ".env")
load_dotenv(env_path)

PRIVATE_KEY = os.getenv("POLYMARKET_PRIVATE_KEY")
FUNDER_ADDRESS = os.getenv("POLYMARKET_FUNDER_ADDRESS")
CLOB_HOST = "https://clob.polymarket.com"
CHAIN_ID = 137  # Polygon mainnet


def execute_trade(market_id, direction, amount_usdc, price=None):
    """Execute a market order on Polymarket."""
    if not PRIVATE_KEY:
        return {"error": "POLYMARKET_PRIVATE_KEY not set in ~/.quantumclaw/.env"}
    if not FUNDER_ADDRESS:
        return {"error": "POLYMARKET_FUNDER_ADDRESS not set in ~/.quantumclaw/.env"}

    try:
        from py_clob_client.client import ClobClient
        from py_clob_client.clob_types import MarketOrderArgs
        from py_clob_client.order_builder.constants import BUY

        client = ClobClient(
            CLOB_HOST,
            key=PRIVATE_KEY,
            chain_id=CHAIN_ID,
            funder=FUNDER_ADDRESS,
        )
        # post_order requires Level 2 auth; derive CLOB API creds from the
        # private key (deterministic, no extra secrets in .env)
        client.set_api_creds(client.create_or_derive_api_creds())

        # Get market info to find token_id
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

        # Create and execute market order
        order_kwargs = {
            "token_id": token_id,
            "amount": float(amount_usdc),
            "side": BUY,
        }
        if price is not None and float(price) > 0:
            order_kwargs["price"] = float(price)
        order_args = MarketOrderArgs(**order_kwargs)

        # TODO: add max_price/slippage bound before live trading at scale
        # Current: market order, no slippage protection
        # Acceptable for $25 USDC max position on liquid Polymarket markets
        # Revisit if max_position_usdc > 50 or markets become thin
        signed = client.create_market_order(order_args)
        resp = client.post_order(signed, orderType=order_args.order_type)

        return {
            "success": True,
            "market_id": market_id,
            "direction": direction.upper(),
            "amount_usdc": amount_usdc,
            "token_id": token_id,
            "response": resp,
        }

    except Exception as e:
        return {"error": str(e)}


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
