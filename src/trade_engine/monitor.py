#!/usr/bin/env python3
"""Position Monitor — Python port of the n8n workflow UYA0JppH7eqyI7fQ.

Ported from the published version's `Evaluate Positions` and `Update
Positions` Code nodes (workflow_history 4211a924, read 2026-08-05), plus
resolution detection the n8n workflow never had. Runs every 15 minutes via
APScheduler (Session 6) and on demand via /monitor/run.

Rule order per position — first match wins:

1. RESOLUTION (new, not in n8n). A market reporting active=false AND
   closed=true, or whose direction-side price has finalised at exactly 1.0 or
   0.0, is settled: close at the final price with exit_reason 'resolved_win' /
   'resolved_loss'. The n8n TP/SL rules caught most settlements implicitly (a
   resolved-YES market trips take_profit at 1.0) but mislabelled the exit and
   missed one case entirely: a position entered at <= 0.20 that resolves
   against us fails the stop-loss entry_price guard and stays open forever.
2. TAKE PROFIT / STOP LOSS (verbatim port): currentPrice > 0.85 exits as
   take_profit; entry_price > 0.20 and currentPrice < 0.08 exits as stop_loss.
3. WEAKENING ALERT (verbatim port): entry_price > 0.50 and currentPrice < 0.30
   sends a Telegram warning, no DB write.

Prices are DIRECTION-SIDE throughout, matching the n8n `priceFor(conditionId,
direction)` helper: for a NO position, currentPrice is outcomePrices[1] and a
NO win closes at exit_price 1.0. exit_usdc = shares * exit_price and
pnl = exit_usdc - usdc_amount are only self-consistent with the direction-side
price, so 'exit_price is the final YES price' would be wrong for NO positions.

DESIGN RULES (inherited from the n8n node and the executor)
-----------------------------------------------------------
- check_positions() NEVER raises. Each position is evaluated inside its own
  try/except; one bad position must not abort the sweep and leave healthy
  positions unmonitored.
- No price means no exit decision. Never fall back to entry_price — that
  silently guarantees the position never exits.
- entry_price NULL disables the rules that depend on it rather than being
  evaluated against 0, which would silently disable the stop loss.
- exit_usdc/pnl are NULL when shares/usdc_amount are absent, never guessed —
  a wrong pnl feeds the executor's daily-loss gate (Gate 3).
- The DB write happens before the Telegram send: a notification failure never
  un-closes a position, and a close is never reported before it is recorded.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from src.trade_engine.config import config, install_bot_token_redaction
from src.trade_engine.database import (
    SupabaseError,
    get_open_positions,
    get_simulations_by_ids,
    update_position,
)
from src.trade_engine.models import MonitorRunResult, TradePosition

log = logging.getLogger("trade_engine.monitor")

install_bot_token_redaction()

GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets"
TELEGRAM_API_BASE = "https://api.telegram.org"

# Evaluate Positions thresholds, verbatim from the published n8n node.
TAKE_PROFIT_PRICE = 0.85
STOP_LOSS_PRICE = 0.08
STOP_LOSS_MIN_ENTRY = 0.20
WEAKENING_PRICE = 0.30
WEAKENING_MIN_ENTRY = 0.50

# Populated after each sweep so /health can report monitor freshness.
# resolved_total is a process-lifetime running count of settlement closes.
_last_monitor: dict[str, Any] = {"at": None, "resolved_total": 0}


def last_monitor_state() -> dict[str, Any]:
    return dict(_last_monitor)


def record_monitor_run(result: MonitorRunResult) -> None:
    _last_monitor["at"] = result.run_at
    _last_monitor["resolved_total"] = (
        int(_last_monitor["resolved_total"]) + result.positions_resolved
    )


class PositionMonitor:
    """Sweep open positions: settle resolved markets, apply TP/SL, alert."""

    def __init__(
        self,
        *,
        client: Optional[httpx.AsyncClient] = None,
        token: Optional[str] = None,
        chat_id: Optional[str] = None,
    ) -> None:
        self._client = client
        self._owns_client = client is None
        # approval_bot_token = TRADE_TELEGRAM_BOT_TOKEN, falling back to the
        # quantumclaw bot when unset. sendMessage has no single-consumer
        # constraint, so the fallback is safe here (unlike getUpdates).
        self._token = token if token is not None else config.approval_bot_token
        self._chat_id = chat_id if chat_id is not None else config.owner_telegram_chat_id

    async def __aenter__(self) -> "PositionMonitor":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=10.0))
        return self._client

    # --- sweep ------------------------------------------------------------

    async def check_positions(self) -> MonitorRunResult:
        """Evaluate every open position once. Never raises."""
        run_at = datetime.now(timezone.utc)

        try:
            positions = await get_open_positions()
        except Exception as exc:  # noqa: BLE001 - a DB blip must not kill the job
            log.error("monitor: could not fetch open positions: %s", exc)
            result = MonitorRunResult(run_at=run_at, positions_checked=0, errors=1)
            record_monitor_run(result)
            return result

        if not positions:
            log.info("monitor: no open positions")
            result = MonitorRunResult(run_at=run_at, positions_checked=0)
            record_monitor_run(result)
            return result

        counts = {"resolved": 0, "tp_sl": 0, "alert": 0, "unpriceable": 0, "error": 0}
        for position in positions:
            try:
                outcome = await self._check_one(position)
            except Exception:  # noqa: BLE001 - one bad position never aborts the sweep
                log.exception("monitor: unexpected error on position %s", position.id)
                outcome = "error"
            if outcome in counts:
                counts[outcome] += 1

        result = MonitorRunResult(
            run_at=run_at,
            positions_checked=len(positions),
            positions_resolved=counts["resolved"],
            positions_tp_sl=counts["tp_sl"],
            positions_unpriceable=counts["unpriceable"],
            alerts_sent=counts["alert"],
            errors=counts["error"],
        )
        log.info(
            "monitor: checked=%d resolved=%d tp_sl=%d alerts=%d unpriceable=%d errors=%d",
            result.positions_checked, result.positions_resolved, result.positions_tp_sl,
            result.alerts_sent, result.positions_unpriceable, result.errors,
        )
        record_monitor_run(result)
        return result

    # --- one position -----------------------------------------------------

    async def _check_one(self, position: TradePosition) -> str:
        """Evaluate one position. Returns an outcome tag for the sweep counts:
        'resolved' | 'tp_sl' | 'alert' | 'unpriceable' | 'error' | 'open'."""
        if not position.simulation_id:
            # M3 gap: pre-Session-6 positions opened without a persisted
            # simulation row. There is no route back to a market — skip.
            log.warning(
                "monitor: position %s has no simulation_id — unpriceable, skipped",
                position.id,
            )
            return "unpriceable"

        condition_id, question = await self._resolve_condition_id(position.simulation_id)
        if not condition_id:
            log.warning(
                "monitor: position %s: simulation %s carries no condition_id — skipped",
                position.id, position.simulation_id,
            )
            return "unpriceable"

        market = await self._fetch_market(condition_id)
        if market is None:
            log.warning(
                "monitor: market not found on Gamma for %s… (position %s) — skipped",
                condition_id[:12], position.id,
            )
            return "unpriceable"

        yes_price, no_price = self._outcome_prices(market)
        if yes_price is None or no_price is None:
            log.warning(
                "monitor: no price available for %s… (position %s) — skipped",
                condition_id[:12], position.id,
            )
            return "unpriceable"

        direction = (position.direction or "").upper()
        current_price = yes_price if direction == "YES" else no_price
        question = question or f"{condition_id[:10]}…"

        # 1. RESOLUTION — settled markets close at the final price.
        resolved_flags = market.get("active") is False and market.get("closed") is True
        if resolved_flags or current_price in (0.0, 1.0):
            if current_price not in (0.0, 1.0):
                # active=false/closed=true but outcomePrices not finalised
                # (e.g. voided or still settling): there is no defensible
                # win/loss to write, so wait for the next sweep.
                log.warning(
                    "monitor: %s… reports closed but price %.4f is not final "
                    "(position %s) — skipped", condition_id[:12], current_price,
                    position.id,
                )
                return "unpriceable"
            won = current_price == 1.0
            return await self._close(
                position,
                exit_price=current_price,
                exit_reason="resolved_win" if won else "resolved_loss",
                question=question,
            )

        entry_price = None if position.entry_price is None else float(position.entry_price)

        # 2. TAKE PROFIT — independent of entry price, so it still fires when
        # entry_price is NULL.
        if current_price > TAKE_PROFIT_PRICE:
            return await self._close(
                position, exit_price=current_price, exit_reason="take_profit",
                question=question,
            )

        # 2b. STOP LOSS — requires a real entry price.
        if (
            entry_price is not None
            and current_price < STOP_LOSS_PRICE
            and entry_price > STOP_LOSS_MIN_ENTRY
        ):
            return await self._close(
                position, exit_price=current_price, exit_reason="stop_loss",
                question=question,
            )

        # 3. WEAKENING ALERT — notify only, no DB write.
        if (
            entry_price is not None
            and current_price < WEAKENING_PRICE
            and entry_price > WEAKENING_MIN_ENTRY
        ):
            await self._notify(
                f"⚠️ Weakening: {question}\n"
                f"now {current_price * 100:.0f}%"
                f" (entered {entry_price * 100:.0f}%)"
            )
            return "alert"

        if entry_price is None:
            log.warning(
                "monitor: position %s has no entry_price — stop loss disabled",
                position.id,
            )
            return "unpriceable"

        log.debug("Position %s still open (price %.4f)", position.id, current_price)
        return "open"

    # --- close + notify ---------------------------------------------------

    async def _close(
        self,
        position: TradePosition,
        *,
        exit_price: float,
        exit_reason: str,
        question: str,
    ) -> str:
        """Write the close, then notify. Returns the sweep outcome tag."""
        exit_usdc = (
            round(float(position.shares) * exit_price, 6)
            if position.shares is not None else None
        )
        pnl = (
            round(exit_usdc - float(position.usdc_amount), 6)
            if exit_usdc is not None and position.usdc_amount is not None else None
        )

        try:
            await update_position(position.id, {
                "status": "closed",
                "exit_price": exit_price,
                "exit_usdc": exit_usdc,
                "pnl": pnl,
                "exit_reason": exit_reason,
                "closed_at": datetime.now(timezone.utc).isoformat(),
            })
        except (SupabaseError, ValueError) as exc:
            # The position stays open in the DB; the next sweep retries. Do
            # NOT notify — a close must never be reported before it is
            # recorded.
            log.error(
                "monitor: failed to close position %s (%s): %s",
                position.id, exit_reason, exc,
            )
            return "error"

        log.info(
            "monitor: closed position %s %s exit_price=%.4f exit_usdc=%s pnl=%s",
            position.id, exit_reason, exit_price, exit_usdc, pnl,
        )
        await self._notify(self._close_message(exit_reason, question, exit_price,
                                               exit_usdc, pnl))
        return "resolved" if exit_reason.startswith("resolved") else "tp_sl"

    @staticmethod
    def _close_message(
        exit_reason: str,
        question: str,
        exit_price: float,
        exit_usdc: Optional[float],
        pnl: Optional[float],
    ) -> str:
        if exit_reason == "resolved_win":
            if pnl is not None and exit_usdc is not None:
                return (
                    f"💰 Trade won: {question}\n"
                    f"+${pnl:.2f} USDC | {exit_usdc:.2f} returned"
                )
            return f"💰 Trade won: {question}\n(pnl unknown — shares not recorded)"
        if exit_reason == "resolved_loss":
            if pnl is not None:
                return f"📉 Trade lost: {question}\n-${abs(pnl):.2f} USDC"
            return f"📉 Trade lost: {question}\n(pnl unknown — shares not recorded)"

        label = "💰 Take profit" if exit_reason == "take_profit" else "🛑 Stop loss"
        text = f"{label}: {question}\nExited @ {exit_price:.2f}"
        if pnl is not None:
            text += f" | pnl {'+' if pnl >= 0 else '-'}${abs(pnl):.2f} USDC"
        return text

    # --- lookups ----------------------------------------------------------

    async def _resolve_condition_id(
        self, simulation_id: str
    ) -> tuple[Optional[str], Optional[str]]:
        """simulation_id -> (conditionId, question) via trading_simulations.

        trading_positions stores no Polymarket identifier of its own
        (market_id is a uuid FK to trading_markets and stays NULL), so the
        simulation row is the only route back to a priceable market. Key
        fallback order matches the n8n node: polymarket_condition_id first,
        then condition_id.
        """
        rows = await get_simulations_by_ids([simulation_id])
        raw = (rows[0].get("raw_output") if rows else None) or {}
        condition_id = raw.get("polymarket_condition_id") or raw.get("condition_id")
        question = raw.get("question")
        return (
            str(condition_id) if condition_id else None,
            str(question) if question else None,
        )

    async def _fetch_market(self, condition_id: str) -> Optional[dict[str, Any]]:
        """GET /markets?condition_ids=<id> — query param, NOT the path form:
        the path form resolves Gamma's numeric ids and 404s for a conditionId."""
        try:
            response = await self._get_client().get(
                GAMMA_MARKETS_URL, params={"condition_ids": condition_id}
            )
        except httpx.HTTPError as exc:
            log.warning("monitor: gamma fetch failed for %s…: %s", condition_id[:12], exc)
            return None
        if response.status_code >= 300:
            log.warning(
                "monitor: gamma HTTP %s for %s…: %s",
                response.status_code, condition_id[:12], response.text[:200],
            )
            return None
        try:
            payload = response.json()
        except ValueError:
            log.warning("monitor: gamma returned non-JSON for %s…", condition_id[:12])
            return None
        market = payload[0] if isinstance(payload, list) and payload else payload
        return market if isinstance(market, dict) else None

    @staticmethod
    def _outcome_prices(
        market: dict[str, Any]
    ) -> tuple[Optional[float], Optional[float]]:
        """(YES, NO) prices. outcomePrices arrives as a JSON *string* like
        '["0.505", "0.495"]'; [0] is YES, [1] is NO."""
        raw = market.get("outcomePrices")
        try:
            prices = json.loads(raw) if isinstance(raw, str) else raw
            if not prices or len(prices) < 2:
                return None, None
            yes = float(prices[0]) if prices[0] is not None else None
            no = float(prices[1]) if prices[1] is not None else None
            return yes, no
        except Exception:  # noqa: BLE001 - unparseable price == no price
            return None, None

    # --- telegram ---------------------------------------------------------

    async def _notify(self, text: str) -> None:
        """Best-effort Telegram send. A notification failure never fails a close."""
        if not self._token or not self._chat_id:
            log.error("monitor: telegram notification skipped: not configured")
            return
        url = f"{TELEGRAM_API_BASE}/bot{self._token}/sendMessage"
        try:
            response = await self._get_client().post(url, json={
                "chat_id": self._chat_id,
                "text": text,
                "disable_web_page_preview": True,
            })
            if response.status_code != 200:
                log.error(
                    "monitor: telegram sendMessage returned HTTP %d",
                    response.status_code,
                )
        except Exception as exc:  # noqa: BLE001
            log.error(
                "monitor: telegram sendMessage failed: %s", type(exc).__name__
            )
