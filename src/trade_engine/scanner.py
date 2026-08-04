#!/usr/bin/env python3
"""Market Scanner — Python port of the n8n workflow 3YahxqOguET3pifj.

Ported from the live workflow's three JavaScript nodes, read 2026-07-28:
`Analyse Edge` (filtering + rung selection), `Run Market Simulations`
(Monte Carlo dispatch) and `Build Run Summary` (bucketing). The filter logic
below is a deliberate line-by-line port — where a rule looks odd, it is odd in
the same way n8n is, because the two run side by side and must agree.

Four places this intentionally does NOT match n8n, all agreed before build:

1. `/markets?limit=200` silently returns 100 — Gamma caps limit at 100, so the
   n8n node has been under-fetching by half. This paginates to the intended 200.
2. `edge` is a raw fraction everywhere here. n8n is inconsistent: it buckets on
   the fraction but writes `edge * 100` into its summary rows. Position sizing
   is fraction-based, so a percent leak would misprice by 100x.
3. Deduplication happens on BOTH `conditionId` (at fetch) and n8n's original
   `id || conditionId` seen-set (inside analyse_edge).
4. `market_url` is constructed here; n8n never produced one.

The n8n scanner keeps running throughout — nothing here touches it.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Optional

import httpx

from src.trade_engine.config import config
from src.trade_engine.approval import ApprovalGate, ApprovalGateBusy
from src.trade_engine.models import ScannerCandidate, ScannerRunSummary

if TYPE_CHECKING:  # avoids a circular import at runtime
    from src.trade_engine.analyst import TradeAnalyst
    from src.trade_engine.approval import ApprovalGate

log = logging.getLogger("trade_engine.scanner")

GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets"
GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events"
POLYMARKET_MARKET_URL = "https://polymarket.com/market/{slug}"

# tag_id 1312 is the crypto/commodities event tag the n8n scanner targets.
EVENTS_TAG_ID = "1312"
GAMMA_PAGE_LIMIT = 100          # hard cap enforced by the Gamma API
MARKETS_TARGET_COUNT = 200      # what the n8n node asks for and never gets
EVENTS_PAGES = 2                # p1 offset=0, p2 offset=100
USER_AGENT = "Mozilla/5.0"

# Matches the n8n httpRequest node: timeout 60000, batchSize 1, batchInterval 500.
SIM_TIMEOUT_SECONDS = 60.0
SIM_INTERVAL_SECONDS = 0.5

# --- Analyse Edge constants, verbatim from the n8n node ----------------------

ASSET_KEYWORDS: dict[str, list[str]] = {
    "btc": ["bitcoin", "btc"],
    "eth": ["ethereum", "eth price", "ether ", "eth hit", "eth reach", "eth above",
            "eth to ", "eth at ", "eth cross", "ethereum hit", "ethereum reach",
            "ethereum above"],
    "sol": ["solana", "sol price", "sol hit", "sol reach", "sol above", "sol to ",
            "sol at "],
    "xrp": ["xrp", "ripple"],
    "gold": ["gold price", "gold hit", "price of gold", "xau", "gold above",
             "gold reach", "gold to ", "gold at ", "gold cross", "gold exceed",
             "gold surpass", "gold breaks", "gold past"],
    "silver": ["silver price", "silver hit", "price of silver", "xag",
               "silver above", "silver reach", "silver to ", "silver at ",
               "silver cross", "silver exceed", "silver surpass"],
    "wti": ["wti", "crude oil price", "west texas", "crude oil", "oil price",
            "oil above", "oil reach", "oil hit"],
    "brent": ["brent", "brent crude", "brent oil"],
    "natgas": ["natural gas", "nat gas", "natgas", "henry hub"],
}

SPORTS_EXCLUDE = re.compile(
    r"stanley cup|nba|nfl|nhl|warriors|knights|oilers|lakers|nuggets|cavaliers|"
    r"celtics|76ers|super bowl|world cup|premier league|championship|playoffs|"
    r"olympics|finals|win the|grand prix|gold medal|gold cards|golden globe|"
    r"golden bachelor|olympic gold",
    re.IGNORECASE,
)

# Per-asset sanity floor — rejects a parsed "target" that is implausibly small
# for the asset (e.g. "bitcoin to 5" is a percentage, not a price).
MIN_PRICE: dict[str, float] = {
    "btc": 10000, "eth": 500, "sol": 5, "xrp": 0.1, "gold": 1000,
    "silver": 10, "wti": 30, "brent": 30, "natgas": 1,
}

TRIGGER_REGEX = re.compile(
    r"(?:above|over|reach(?:es|ed)?|hit(?:s|ting)?|cross(?:es|ed)?|"
    r"exceed(?:s|ed)?|surpass(?:es|ed)?|past|to|at)\s+\$?([\d,]+\.?\d*[kmb]?)",
    re.IGNORECASE,
)
DOLLAR_REGEX = re.compile(r"\$[\d,]+\.?\d*[kmb]?", re.IGNORECASE)

# Crypto trades at weekends; commodities do not.
WEEKEND_ASSETS = {"btc", "eth", "sol", "xrp"}

MIN_PRESIM_VOLUME = 20000
HORIZON_MAX_DAYS = 35
YES_PRICE_MIN = 0.01
YES_PRICE_MAX = 0.99
RUNGS_PER_EVENT = 3
GLOBAL_CAP = 30

# Position sizing: $3 at the high-edge threshold, $10 at edge 0.15+.
AMOUNT_MIN_USDC = 3.0
AMOUNT_MAX_USDC = 10.0
AMOUNT_EDGE_FLOOR = 0.07
AMOUNT_EDGE_CEILING = 0.15

# Session 5 will enforce this before any execution; here it only gates the
# best_trade suggestion.
MAX_CONCURRENT_POSITIONS = 2

# Populated after each run so /health can report scanner freshness.
_last_run: dict[str, Any] = {"at": None, "high_edge_count": None}


def last_run_state() -> dict[str, Any]:
    return dict(_last_run)


def record_run(summary: "ScannerRunSummary") -> None:
    """Stash run freshness for /health. Called by run() and by the /scan route,
    which drives the stages individually so it can persist the raw simulations."""
    _last_run["at"] = summary.run_at
    _last_run["high_edge_count"] = len(summary.high_edge)


def _js_parse_float(text: str) -> Optional[float]:
    """Mimic JavaScript parseFloat: read the leading numeric prefix, ignore the
    rest, return None where JS returns NaN. Python's float() raises on trailing
    junk, which would change which markets survive the filter."""
    match = re.match(r"\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?", text)
    if not match or not match.group(0).strip():
        return None
    try:
        value = float(match.group(0))
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def _parse_numeric(raw: str) -> Optional[float]:
    """Port of the n8n `parseNumeric` helper: k/m/b suffix expansion."""
    if not raw:
        return None
    suffix = raw[-1].lower()
    clean = re.sub(r"[,kmb]", "", raw, flags=re.IGNORECASE)
    value = _js_parse_float(clean)
    if value is None:
        return None
    if suffix == "k":
        return value * 1_000
    if suffix == "m":
        return value * 1_000_000
    if suffix == "b":
        return value * 1_000_000_000
    return value


def _outcome_yes_price(market: dict[str, Any]) -> Optional[float]:
    """outcomePrices arrives as a JSON *string* like '["0.505", "0.495"]'."""
    raw = market.get("outcomePrices")
    try:
        prices = raw
        if isinstance(raw, str):
            import json

            prices = json.loads(raw)
        if prices and prices[0] is not None:
            return float(prices[0])
    except Exception:
        return None
    return None


def _amount_usdc(edge: float) -> float:
    """Linear $3-$10 on edge magnitude, clamped.

    Uses abs(edge) so a NO-side candidate sizes on conviction too. For the
    high-edge bucket (edge > 0) this is identical to the briefed formula; only
    best_trade ever drives money, and best_trade only comes from high_edge.
    """
    span = AMOUNT_EDGE_CEILING - AMOUNT_EDGE_FLOOR
    scaled = AMOUNT_MIN_USDC + (abs(edge) - AMOUNT_EDGE_FLOOR) / span * (
        AMOUNT_MAX_USDC - AMOUNT_MIN_USDC
    )
    return round(max(AMOUNT_MIN_USDC, min(AMOUNT_MAX_USDC, scaled)), 2)


class PolymarketScanner:
    """Fetch → filter → simulate → bucket → pick, matching the n8n pipeline."""

    def __init__(
        self,
        client: Optional[httpx.AsyncClient] = None,
        analyst: Optional["TradeAnalyst"] = None,
        approval_gate: Optional["ApprovalGate"] = None,
    ) -> None:
        self._client = client
        self._owns_client = client is None
        # Injectable so tests can drive the pipeline without hitting Claude.
        self.analyst = analyst
        # Optional: with no gate the pipeline still runs and best_trade is
        # still selected, it just carries no approval_result. Nothing in
        # Session 4 executes either way.
        self.approval_gate = approval_gate

    async def __aenter__(self) -> "PolymarketScanner":
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(30.0, connect=10.0),
                headers={"User-Agent": USER_AGENT},
                follow_redirects=True,
            )
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    # --- fetch ------------------------------------------------------------

    async def fetch_markets(self) -> list[dict[str, Any]]:
        """Flat /markets plus /events sub-markets, merged and deduplicated.

        Deduplication keys on conditionId first, falling back to id — event
        ladders repeat the same conditionId across pages.
        """
        assert self._client is not None, "use PolymarketScanner as an async context manager"

        flat = await self._fetch_flat_markets()
        events = await self._fetch_event_markets()

        merged: list[dict[str, Any]] = []
        seen: set[str] = set()
        for market in [*flat, *events]:
            key = str(market.get("conditionId") or market.get("id") or "")
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(market)

        log.info(
            "fetched %d markets (%d flat, %d event sub-markets, %d after dedup)",
            len(merged), len(flat), len(events), len(merged),
        )
        return merged

    async def _fetch_flat_markets(self) -> list[dict[str, Any]]:
        """Paginate to MARKETS_TARGET_COUNT. The n8n node asks for limit=200 in
        one call and silently receives 100 — Gamma caps limit at 100."""
        out: list[dict[str, Any]] = []
        offset = 0
        while len(out) < MARKETS_TARGET_COUNT:
            batch = await self._get_json(
                GAMMA_MARKETS_URL,
                {"closed": "false", "limit": str(GAMMA_PAGE_LIMIT), "offset": str(offset)},
            )
            if not batch:
                break
            out.extend(batch)
            if len(batch) < GAMMA_PAGE_LIMIT:
                break
            offset += GAMMA_PAGE_LIMIT
        return out[:MARKETS_TARGET_COUNT]

    async def _fetch_event_markets(self) -> list[dict[str, Any]]:
        """Port of `Fetch Events p1/p2` + `Flatten Events`: each event's
        sub-markets become standalone markets carrying event context."""
        out: list[dict[str, Any]] = []
        for page in range(EVENTS_PAGES):
            events = await self._get_json(
                GAMMA_EVENTS_URL,
                {
                    "closed": "false",
                    "tag_id": EVENTS_TAG_ID,
                    "order": "volume24hr",
                    "ascending": "false",
                    "limit": str(GAMMA_PAGE_LIMIT),
                    "offset": str(page * GAMMA_PAGE_LIMIT),
                },
            )
            for event in events or []:
                for sub in event.get("markets") or []:
                    out.append({
                        **sub,
                        "event_title": event.get("title"),
                        "event_slug": event.get("slug"),
                        "source": "polymarket",
                    })
        return out

    async def _get_json(self, url: str, params: dict[str, str]) -> list[dict[str, Any]]:
        assert self._client is not None
        try:
            response = await self._client.get(url, params=params)
        except httpx.HTTPError as exc:
            log.error("polymarket fetch failed %s params=%s: %s", url, params, exc)
            return []
        if response.status_code >= 300:
            log.error(
                "polymarket fetch %s params=%s -> HTTP %s: %s",
                url, params, response.status_code, response.text[:300],
            )
            return []
        payload = response.json()
        return payload if isinstance(payload, list) else []

    # --- analyse ----------------------------------------------------------

    async def analyse_edge(self, markets: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Port of the `Analyse Edge` node.

        Weekend is evaluated in UTC. n8n used the container's local `getDay()`;
        both hosts run UTC, so this matches while being explicit about it.
        """
        now = datetime.now(timezone.utc)
        is_weekend = now.weekday() in (5, 6)  # JS getDay() 0=Sun,6=Sat

        results: list[dict[str, Any]] = []
        seen: set[str] = set()

        for market in markets:
            question = (market.get("question") or "").lower()
            description = (market.get("description") or "").lower()
            full_text = question + " " + description
            end_date = market.get("endDate") or market.get("end_date_iso")
            market_id = market.get("id") or market.get("conditionId")

            if market_id in seen:
                continue
            seen.add(market_id)

            if SPORTS_EXCLUDE.search(market.get("question") or ""):
                continue

            asset = None
            for candidate_asset, keywords in ASSET_KEYWORDS.items():
                if any(k in full_text for k in keywords):
                    asset = candidate_asset
                    break
            if not asset:
                continue
            if is_weekend and asset not in WEEKEND_ASSETS:
                continue

            dollar_matches = [m.replace("$", "", 1) for m in DOLLAR_REGEX.findall(question)]
            trigger_matches = TRIGGER_REGEX.findall(question)
            prices = [
                p for p in (_parse_numeric(m) for m in [*dollar_matches, *trigger_matches])
                if p is not None and p > 0
            ]

            floor = MIN_PRICE.get(asset, 1)
            valid = [p for p in prices if p >= floor]
            if not valid:
                continue

            horizon_days = self._horizon_days(end_date, now)
            if horizon_days <= 0 or horizon_days > HORIZON_MAX_DAYS:
                continue

            yes_price = _outcome_yes_price(market)
            if yes_price is None or yes_price < YES_PRICE_MIN or yes_price > YES_PRICE_MAX:
                continue

            volume = _js_parse_float(str(market.get("volume") or 0)) or 0.0
            if volume < MIN_PRESIM_VOLUME:
                continue

            results.append({
                "market_id": market_id,
                "condition_id": market.get("conditionId"),
                "slug": market.get("slug"),
                "question": market.get("question"),
                "asset": asset,
                "target": max(valid),
                "yes_price": yes_price,
                "horizon_days": horizon_days,
                "end_date": end_date,
                "volume": volume,
                "needs_simulation": True,
                "source": market.get("source") or "polymarket",
                "event_slug": market.get("event_slug"),
                "event_title": market.get("event_title"),
            })

        selected = self._select_rungs(results)
        log.info(
            "analyse_edge: %d markets in, %d passed filters, %d after rung/cap selection",
            len(markets), len(results), len(selected),
        )
        return selected

    @staticmethod
    def _horizon_days(end_date: Optional[str], now: datetime) -> int:
        """Math.ceil((endDate - now) / 86400000); absent endDate defaults to 30."""
        if not end_date:
            return 30
        try:
            parsed = datetime.fromisoformat(str(end_date).replace("Z", "+00:00"))
        except ValueError:
            return 30
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return math.ceil((parsed - now).total_seconds() / 86400.0)

    @staticmethod
    def _select_rungs(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Keep <=3 rungs nearest yes~0.5 per event ladder, then global top-30 by
        volume. Bounds the number of /simulate calls per run."""
        by_event: dict[str, list[dict[str, Any]]] = {}
        for row in results:
            key = row.get("event_slug") or ("single:" + str(row["market_id"]))
            by_event.setdefault(key, []).append(row)

        selected: list[dict[str, Any]] = []
        for rungs in by_event.values():
            rungs.sort(key=lambda r: abs(r["yes_price"] - 0.5))
            selected.extend(rungs[:RUNGS_PER_EVENT])

        selected.sort(key=lambda r: r["volume"], reverse=True)
        return selected[:GLOBAL_CAP]

    # --- simulate ---------------------------------------------------------

    async def run_simulations(
        self, candidates: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], int]:
        """POST each candidate to the Monte Carlo worker, sequentially.

        Sequential by design — yfinance is not thread-safe, and the n8n node
        pins batchSize=1 with a 500ms interval for the same reason. A failed or
        non-finite simulation drops that market and increments the error count;
        it never aborts the run (the continueOnFail equivalent).

        Returns (candidates with `simulation` attached, sim_error_count).
        """
        assert self._client is not None
        simulated: list[dict[str, Any]] = []
        errors = 0
        url = f"{config.monte_carlo_host}/simulate"

        for index, candidate in enumerate(candidates):
            if index:
                await asyncio.sleep(SIM_INTERVAL_SECONDS)
            body = {
                "asset": candidate["asset"],
                "target": candidate["target"],
                "question": candidate["question"],
                "horizon_days": candidate["horizon_days"],
            }
            try:
                response = await self._client.post(
                    url, json=body, timeout=SIM_TIMEOUT_SECONDS
                )
            except httpx.TimeoutException:
                errors += 1
                log.warning(
                    "simulate timeout after %ss, skipping market %s (%s)",
                    SIM_TIMEOUT_SECONDS, candidate["market_id"], candidate["asset"],
                )
                continue
            except httpx.HTTPError as exc:
                errors += 1
                log.warning(
                    "simulate transport error for market %s: %s",
                    candidate["market_id"], exc,
                )
                continue

            if response.status_code >= 300:
                errors += 1
                log.warning(
                    "simulate HTTP %s for market %s (%s): %s",
                    response.status_code, candidate["market_id"],
                    candidate["asset"], response.text[:300],
                )
                continue

            try:
                sim = response.json()
            except ValueError:
                errors += 1
                log.warning("simulate returned non-JSON for market %s", candidate["market_id"])
                continue

            probability = sim.get("probability")
            if probability is None or not isinstance(probability, (int, float)) \
                    or not math.isfinite(float(probability)):
                # monte_carlo sanitises non-finite floats to null before jsonify.
                errors += 1
                log.warning(
                    "simulate returned non-finite probability for market %s (%s): %r",
                    candidate["market_id"], candidate["asset"], probability,
                )
                continue

            simulated.append({**candidate, "simulation": sim})

        log.info("run_simulations: %d ok, %d skipped", len(simulated), errors)
        return simulated, errors

    # --- summarise --------------------------------------------------------

    async def build_run_summary(
        self,
        simulated: list[dict[str, Any]],
        *,
        markets_fetched: int,
        candidates_analysed: int,
        sim_errors: int,
        open_positions: int,
    ) -> ScannerRunSummary:
        """Port of `Build Run Summary`. edge = sim probability - market YES price,
        kept as a raw fraction throughout (n8n multiplies by 100 in its summary
        rows but buckets on the fraction; the fraction is the correct unit)."""
        high_edge: list[ScannerCandidate] = []
        no_edge: list[ScannerCandidate] = []
        neutral_count = 0

        for row in simulated:
            sim = row["simulation"]
            sim_probability = float(sim["probability"])
            edge = sim_probability - row["yes_price"]
            volume = row["volume"]

            if edge >= config.high_edge_threshold and volume >= config.min_alert_volume:
                high_edge.append(self._to_candidate(row, edge, sim_probability))
            elif edge <= config.no_edge_threshold and volume >= config.min_alert_volume:
                no_edge.append(self._to_candidate(row, edge, sim_probability))
            else:
                neutral_count += 1

        summary = ScannerRunSummary(
            run_at=datetime.now(timezone.utc),
            markets_fetched=markets_fetched,
            candidates_analysed=candidates_analysed,
            simulations_run=len(simulated),
            sim_errors=sim_errors,
            high_edge=high_edge,
            no_edge=no_edge,
            neutral_count=neutral_count,
            best_trade=None,
            open_positions=open_positions,
        )
        log.info(
            "build_run_summary: %d high-edge, %d no-edge, %d neutral",
            len(high_edge), len(no_edge), neutral_count,
        )
        return summary

    @staticmethod
    def _to_candidate(
        row: dict[str, Any], edge: float, sim_probability: float
    ) -> ScannerCandidate:
        slug = row.get("slug") or ""
        return ScannerCandidate(
            market_id=str(row["market_id"]),
            question=row["question"] or "",
            asset=row["asset"],
            direction="YES" if edge > 0 else "NO",
            edge=edge,
            sim_probability=sim_probability,
            market_probability=row["yes_price"],
            volume=row["volume"],
            horizon_days=row["horizon_days"],
            market_url=POLYMARKET_MARKET_URL.format(slug=slug) if slug else "",
            amount_usdc=_amount_usdc(edge),
        )

    # --- select -----------------------------------------------------------

    def select_best_trade(self, summary: ScannerRunSummary) -> Optional[ScannerCandidate]:
        """Highest-conviction high-edge market, subject to the position cap.

        Not present in n8n — the n8n scanner only notifies. Returns None when
        there is nothing to trade or when the cap is already reached, so a
        caller can treat None as 'stand down' without inspecting counts.
        """
        if not summary.high_edge:
            return None
        if summary.open_positions >= MAX_CONCURRENT_POSITIONS:
            log.info(
                "position cap reached (%d open >= %d), no best_trade selected",
                summary.open_positions, MAX_CONCURRENT_POSITIONS,
            )
            return None
        return max(summary.high_edge, key=lambda c: abs(c.edge))

    # --- analyst ----------------------------------------------------------

    async def apply_analyst(self, summary: ScannerRunSummary) -> None:
        """Run the Analyst over best_trade and apply its verdict to the summary.

        Advisory only. 'reduce' halves the *proposed* position size (floored at
        $3) on the candidate object; no live position is touched, and nothing
        here executes. With no best_trade there is nothing to review, so the
        Analyst is skipped entirely rather than called on an empty candidate.
        """
        if summary.best_trade is None or self.analyst is None:
            summary.analyst_recommendation = None
            summary.analyst_skip = False
            return

        recommendation = await self.analyst.analyse(summary.best_trade)
        summary.analyst_recommendation = recommendation

        if recommendation.recommendation == "pass":
            summary.analyst_skip = True
            log.info("Analyst PASS: %s", recommendation.reasoning)
        elif recommendation.recommendation == "reduce":
            before = summary.best_trade.amount_usdc
            summary.best_trade.amount_usdc = round(
                max(AMOUNT_MIN_USDC, before / 2), 2
            )
            log.info(
                "Analyst REDUCE: %s, new size $%.2f (was $%.2f)",
                recommendation.reasoning, summary.best_trade.amount_usdc, before,
            )
        else:
            log.info("Analyst PROCEED: %s", recommendation.reasoning)

    # --- approval ---------------------------------------------------------

    async def apply_approval(self, summary: ScannerRunSummary) -> None:
        """Ask for human approval on best_trade and record the outcome.

        Sets summary.approval_result and nothing else — no position is opened
        here, and `approved` means only that the executor (Session 5) would be
        permitted to act. A missing gate, a missing analyst verdict or no
        best_trade all leave approval_result None.

        NOTE: this blocks for up to APPROVAL_TIMEOUT_SECONDS (default 1800).
        A caller serving an HTTP request will hold that request open for the
        full window — see the /scan docstring in main.py.
        """
        summary.approval_result = None

        if summary.best_trade is None:
            return

        recommendation = summary.analyst_recommendation
        if recommendation is None:
            # No verdict means no gate: PendingApproval requires a
            # recommendation, and asking for approval without one would put an
            # unreviewed trade in front of a one-tap Execute button.
            log.info("no analyst recommendation, approval gate skipped")
            return

        if summary.analyst_skip:
            # The Analyst already said pass. Record it as a decision rather
            # than sending a Telegram message nobody needs to answer.
            summary.approval_result = ApprovalGate.analyst_skip_result(
                summary.best_trade, recommendation
            )
            log.info("Trade ANALYST_SKIP: %s", summary.best_trade.question)
            return

        if self.approval_gate is None:
            log.info("no approval gate configured, best_trade left unapproved")
            return

        try:
            pending = await self.approval_gate.send_approval_request(
                summary.best_trade, recommendation
            )
        except ApprovalGateBusy as exc:
            # Max one outstanding approval. A second opportunity is dropped
            # rather than queued — by the time the first resolves this scan's
            # prices are stale anyway.
            log.info("approval gate busy, trade skipped: %s", exc)
            return

        result = await self.approval_gate.wait_for_decision(pending)
        summary.approval_result = result
        log.info(
            "Trade %s: %s",
            result.status.value.upper(), summary.best_trade.question,
        )

    # --- orchestration ----------------------------------------------------

    async def run(self, *, open_positions: int = 0) -> ScannerRunSummary:
        """fetch → analyse → simulate → summarise → select → approve."""
        markets = await self.fetch_markets()
        candidates = await self.analyse_edge(markets)
        simulated, sim_errors = await self.run_simulations(candidates)
        summary = await self.build_run_summary(
            simulated,
            markets_fetched=len(markets),
            candidates_analysed=len(candidates),
            sim_errors=sim_errors,
            open_positions=open_positions,
        )
        summary.best_trade = self.select_best_trade(summary)
        await self.apply_analyst(summary)
        await self.apply_approval(summary)
        record_run(summary)

        if summary.best_trade:
            log.info(
                "best_trade: %s %s edge=%.4f amount=$%.2f",
                summary.best_trade.asset, summary.best_trade.direction,
                summary.best_trade.edge, summary.best_trade.amount_usdc,
            )
        return summary


def simulation_rows(summary_source: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Map simulated candidates onto trading_simulations rows.

    `market_id` is deliberately omitted. The column is uuid with an FK to
    trading_markets.id; Polymarket ids are numeric strings and conditionIds are
    66-char hex, neither of which is a UUID, and trading_markets is empty so
    there is nothing to map to. All 5,649 existing rows have market_id NULL and
    carry the Polymarket id at raw_output.polymarket_market_id — this follows
    that convention rather than inventing a second one.
    """
    rows: list[dict[str, Any]] = []
    for row in summary_source:
        sim = row["simulation"]
        sim_probability = float(sim["probability"])
        rows.append({
            "asset": row["asset"],
            "simulation_count": sim.get("simulations") or 10000,
            "probability": sim_probability,
            "current_price": sim.get("current_price"),
            "edge": sim_probability - row["yes_price"],
            "implied_odds": row["yes_price"],
            "macro_factors": sim.get("macro_factors"),
            "confidence_lower": sim.get("confidence_lower"),
            "confidence_upper": sim.get("confidence_upper"),
            "raw_output": {
                "polymarket_market_id": row["market_id"],
                "polymarket_condition_id": row.get("condition_id"),
                "question": row["question"],
                "target": row["target"],
                "horizon_days": row["horizon_days"],
                "end_date": row["end_date"],
                "volume": row["volume"],
                "source": row["source"],
                "event_slug": row.get("event_slug"),
                "daily_mu": sim.get("daily_mu"),
                "daily_sigma": sim.get("daily_sigma"),
                "macro_adjustment": sim.get("macro_adjustment"),
                "market_type": sim.get("market_type"),
            },
        })
    return rows
