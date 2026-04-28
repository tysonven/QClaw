#!/usr/bin/env python3
"""Polymarket market scanner — finds commodity/crypto markets via Gamma API."""

import re
import requests
import json
import sys
from datetime import datetime

GAMMA_API = "https://gamma-api.polymarket.com/markets"

KEYWORDS = {
    "gold":    ["gold", "xau", "gold price", "gold above", "gold reach", "gold to", "gold hit", "gold below", "gold over", "gold surpass", "gold fall"],
    "silver":  ["silver", "xag", "silver price", "silver above", "silver reach", "silver to", "silver hit", "silver below", "silver over"],
    "btc":     ["bitcoin", "btc", "bitcoin price", "btc above", "btc reach", "btc hit", "btc to", "bitcoin above", "bitcoin reach", "bitcoin hit"],
    "eth":     ["ethereum", "ether", "eth price", "eth above", "eth reach", "eth hit", "eth to", "ethereum above", "ethereum reach", "ethereum hit"],
    "sol":     ["solana", "solana price", "sol above", "sol reach", "sol hit", "sol to"],
    "xrp":     ["xrp", "ripple", "xrp price", "xrp above", "xrp reach", "xrp hit", "xrp to"],
    "wti":     ["wti", "crude oil", "oil price", "oil above", "oil below", "oil reach", "oil hit"],
    "brent":   ["brent", "brent crude", "brent above", "brent below", "brent reach"],
    "natgas":  ["natural gas", "nat gas", "natgas", "henry hub", "gas price above", "gas price below"],
}

SUPABASE_URL = "https://fdabygmromuqtysitodp.supabase.co/rest/v1"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZkYWJ5Z21yb211cXR5c2l0b2RwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk2NjI2OTQsImV4cCI6MjA3NTIzODY5NH0.6JJMkPXBufpLxlisH1ig32Xm8YM3p0jcXRlBzx5x8Dk"


def fetch_markets():
    """Fetch active markets from Polymarket Gamma API (up to 600 markets)."""
    markets = []
    seen_ids = set()
    offset = 0
    while True:
        resp = requests.get(GAMMA_API, params={
            "closed": "false",
            "limit": 100,
            "offset": offset,
        }, timeout=15)
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        for m in batch:
            mid = m.get("id") or m.get("conditionId", "")
            if mid not in seen_ids:
                seen_ids.add(mid)
                markets.append(m)
        if len(batch) < 100:
            break
        offset += 100
        if offset >= 600:
            break
    return markets


def classify_market(text):
    """Return the asset class for a market question, or None.
    Uses word-boundary matching to avoid false positives (e.g. 'sol' in 'resolved').
    """
    for asset, kws in KEYWORDS.items():
        for kw in kws:
            # Use word boundary for short/ambiguous keywords
            pattern = r'\b' + re.escape(kw) + r'\b'
            if re.search(pattern, text):
                return asset
    return None


def filter_markets(markets):
    """Filter for relevant markets and tag by asset class."""
    filtered = []
    for m in markets:
        question = (m.get("question") or "").lower()
        description = (m.get("description") or "").lower()
        text = question + " " + description
        asset = classify_market(text)
        if not asset:
            continue

        yes_price = None
        outcomes = m.get("outcomePrices")
        if outcomes:
            try:
                prices = json.loads(outcomes) if isinstance(outcomes, str) else outcomes
                if prices:
                    yes_price = float(prices[0])
            except (json.JSONDecodeError, IndexError, TypeError):
                pass

        filtered.append({
            "market_id": m.get("id") or m.get("conditionId", ""),
            "question": m.get("question", ""),
            "asset": asset,
            "yes_price": yes_price,
            "end_date": m.get("endDate"),
            "volume": float(m.get("volume", 0) or 0),
            "condition_id": m.get("conditionId", ""),
            "slug": m.get("slug", ""),
        })
    return filtered


def save_to_supabase(markets):
    """Upsert markets to Supabase trading_markets table."""
    if not markets:
        return 0

    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }

    rows = []
    for m in markets:
        rows.append({
            "market_id": m["market_id"],
            "question": m["question"],
            "yes_price": m["yes_price"],
            "end_date": m["end_date"],
            "volume": m["volume"],
            "condition_id": m["condition_id"],
            "slug": m["slug"],
            "last_scanned_at": datetime.utcnow().isoformat(),
        })

    resp = requests.post(
        f"{SUPABASE_URL}/trading_markets",
        headers=headers,
        json=rows,
        timeout=15,
    )
    if resp.status_code >= 400:
        print(f"Supabase error: {resp.status_code} {resp.text}", file=sys.stderr)
    return len(rows)


def scan():
    """Run a full scan and return results."""
    markets = fetch_markets()
    filtered = filter_markets(markets)
    saved = save_to_supabase(filtered)
    return filtered, saved


if __name__ == "__main__":
    filtered, saved = scan()
    print(json.dumps({"markets": filtered, "saved": saved}, indent=2, default=str))
