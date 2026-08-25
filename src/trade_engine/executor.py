#!/usr/bin/env python3
"""Trade executor — the only component in this repo that spends real money.

Sits behind the approval gate: nothing here runs until a human has tapped
Execute on a Telegram message. Even then, six independent gates are re-checked
against LIVE state before the order goes out, because the approval may be up to
30 minutes stale by the time it is acted on and the world moves in between.

DESIGN RULES (violating any of these is a financial bug, not a style issue)
--------------------------------------------------------------------------
1. Every gate fails CLOSED. A Supabase error is a refusal, never a pass.
2. execute() NEVER raises. It returns a TradeExecutionResult so the scanner
   pipeline cannot be aborted halfway by an exception from the money path.
3. The subprocess is invoked with an ARG ARRAY. No shell=True, ever — the
   market identifier is remote data and would otherwise be shell-injectable.
4. Secrets never reach a log or an argv. The Polymarket key is read by the
   child from ~/.quantumclaw/.env; it is never passed as an argument.
5. A subprocess failure means "could not CONFIRM an order", not "no order was
   placed". Nothing here retries automatically.

IDENTIFIER HAZARD (Session 5 audit, F1)
---------------------------------------
The CLOB resolves markets by on-chain conditionId only. ScannerCandidate
carries Gamma's numeric id in `market_id`, and passing that to execute_trade.py
returns HTTP 404 "market not found" — verified live 2026-08-05. So the executor
trades `condition_id` and gates hard on its shape. A candidate without a
well-formed conditionId is refused rather than sent with the wrong identifier.
"""

import asyncio
import json
import logging
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx

from src.trade_engine.approval import _scrub
from src.trade_engine.config import config, install_bot_token_redaction
from src.trade_engine.database import (
    SupabaseError,
    count_open_positions,
    get_daily_pnl,
    get_trading_config,
    write_position,
)
from src.trade_engine.models import (
    ApprovalResult,
    ApprovalStatus,
    ExecutionGateError,
    ScannerCandidate,
    TradeExecutionResult,
)

log = logging.getLogger("trade_engine.executor")

install_bot_token_redaction()

# Resolved from this file rather than hardcoded so the tests and a non-/root
# checkout exercise the same path production does.
EXECUTE_TRADE_SCRIPT = str(
    (Path(__file__).resolve().parent.parent / "trading" / "execute_trade.py")
)

SUBPROCESS_TIMEOUT_SECONDS = 60

# Hard ceiling independent of trading_config. If the DB row is ever edited to
# something absurd, this still refuses. Defence in depth against a bad write.
ABSOLUTE_MAX_POSITION_USDC = 25.0

MAX_CONCURRENT_POSITIONS = 2

# An approval is consent to trade AT A PRICE. The approval gate allows 30
# minutes to answer, but a verdict that old is about a market that has moved,
# so execution requires a FRESH decision. Anything older is refused rather than
# filled at a price the human never saw.
APPROVAL_MAX_AGE_SECONDS = 300

# Tolerance for a decided_at slightly ahead of our clock (NTP skew between the
# approving process and this one). Beyond it the timestamp is not trusted —
# without this a far-future decided_at would never expire.
APPROVAL_MAX_SKEW_SECONDS = 60

# Polymarket conditionId: 0x + 64 hex. Matched with fullmatch, not match:
# Python's `$` also matches before a trailing newline, so re.match would accept
# "0x<64 hex>\n" and pass it to the CLI as a market identifier.
CONDITION_ID_RE = re.compile(r"0x[0-9a-fA-F]{64}")

TELEGRAM_API_BASE = "https://api.telegram.org"


class TradeExecutor:
    """Re-checks the financial gates, then places one order.

    Stateless between calls apart from the HTTP client. The gates read live
    Supabase state every time precisely so that two executions in the same
    process cannot share a stale view of the position count.
    """

    def __init__(
        self,
        *,
        client: Optional[httpx.AsyncClient] = None,
        token: Optional[str] = None,
        chat_id: Optional[str] = None,
        script_path: Optional[str] = None,
    ) -> None:
        self._client = client
        self._owns_client = client is None
        self._token = token if token is not None else config.approval_bot_token
        self._chat_id = chat_id if chat_id is not None else config.owner_telegram_chat_id
        self._script_path = script_path or EXECUTE_TRADE_SCRIPT

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=10.0))
        return self._client

    # --- entry point ------------------------------------------------------

    async def execute(self, result: ApprovalResult) -> TradeExecutionResult:
        """Run the gates and, if they all pass, place the order.

        Never raises. Every failure path returns a TradeExecutionResult and
        notifies Telegram, because a silent refusal on a money path is
        indistinguishable from a silent success.
        """
        candidate = result.candidate

        if result.status is not ApprovalStatus.approved:
            # Defence in depth: the scanner already checks this, but /execute
            # accepts a caller-supplied body and must not trust it.
            log.warning(
                "execute() called with status=%s, refusing", result.status.value
            )
            return self._blocked(candidate, "not_approved")

        stale_reason = self._staleness_reason(result.decided_at)
        if stale_reason is not None:
            log.warning(
                "refusing stale approval (%s): %s %s decided_at=%s",
                stale_reason, candidate.asset, candidate.direction,
                result.decided_at.isoformat() if result.decided_at else None,
            )
            await self._notify(
                f"⛔ Trade blocked: stale_approval — {candidate.question}"
            )
            return self._blocked(candidate, "stale_approval")

        try:
            await self._run_gates(candidate)
        except ExecutionGateError as exc:
            log.warning(
                "GATE BLOCKED %s: %s %s $%.2f",
                exc.gate, candidate.asset, candidate.direction, candidate.amount_usdc,
            )
            await self._notify(
                f"⛔ Trade blocked: {exc.gate} — {candidate.question}"
            )
            return self._blocked(candidate, exc.gate)
        except Exception:  # noqa: BLE001 - an unexpected gate error is a refusal
            log.exception("gate evaluation failed, refusing trade")
            await self._notify(
                f"⛔ Trade blocked: gate_error — {candidate.question}"
            )
            return self._blocked(candidate, "gate_error")

        return await self._place_order(candidate)

    @staticmethod
    def _staleness_reason(decided_at: Optional[datetime]) -> Optional[str]:
        """Why this approval is not fresh enough to act on, or None if it is.

        A naive datetime is read as UTC rather than rejected: /execute accepts a
        caller-supplied body and json bodies routinely drop the offset, and
        comparing naive to aware would raise TypeError — which would surface as
        the generic gate_error and hide the real reason.
        """
        if decided_at is None:
            return "missing_decided_at"

        moment = decided_at
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)

        age = (datetime.now(timezone.utc) - moment).total_seconds()
        if age > APPROVAL_MAX_AGE_SECONDS:
            return f"age {age:.0f}s > {APPROVAL_MAX_AGE_SECONDS}s"
        if age < -APPROVAL_MAX_SKEW_SECONDS:
            # Dated in the future beyond plausible clock skew. Trusting it would
            # make the approval effectively immortal.
            return f"decided_at is {abs(age):.0f}s in the future"
        return None

    # --- gates ------------------------------------------------------------

    async def _run_gates(self, candidate: ScannerCandidate) -> None:
        """Six checks against live state. Raises ExecutionGateError on refusal.

        Ordered cheapest-and-most-decisive first: the global brake before the
        per-trade arithmetic, so a disabled system does not spend three
        Supabase round trips discovering it is disabled.
        """
        # GATE 1 — the global brake, re-read live.
        try:
            cfg = await get_trading_config()
        except SupabaseError as exc:
            log.error("gate 1 could not read trading_config: %s", exc)
            raise ExecutionGateError("trading_disabled") from exc
        if cfg.trading_enabled is not True:
            raise ExecutionGateError("trading_disabled")
        log.debug("gate 1 ok: trading_enabled=True")

        # GATE 2 — concurrent exposure.
        try:
            open_count = await count_open_positions()
        except SupabaseError as exc:
            log.error("gate 2 could not count open positions: %s", exc)
            raise ExecutionGateError("position_cap") from exc
        if open_count >= MAX_CONCURRENT_POSITIONS:
            raise ExecutionGateError("position_cap")
        log.debug("gate 2 ok: %d open < %d", open_count, MAX_CONCURRENT_POSITIONS)

        # GATE 3 — today's realised losses.
        limit = cfg.daily_loss_limit
        try:
            daily_pnl = await get_daily_pnl()
        except SupabaseError as exc:
            log.error("gate 3 could not read daily pnl: %s", exc)
            raise ExecutionGateError("daily_loss_limit") from exc
        # Only losses count. A profitable day must not unlock a bigger one, and
        # a positive pnl must never satisfy abs() >= limit.
        if limit is not None and daily_pnl < 0 and abs(daily_pnl) >= float(limit):
            raise ExecutionGateError("daily_loss_limit")
        log.debug("gate 3 ok: daily_pnl=%.2f limit=%s", daily_pnl, limit)

        # GATE 4 — the edge must still clear the configured floor.
        # min_edge_threshold is stored in PERCENTAGE POINTS (live value 7),
        # candidate.edge is a fraction (0.07). Divide, never compare raw.
        threshold = cfg.min_edge_threshold
        if threshold is not None and candidate.edge < float(threshold) / 100.0:
            raise ExecutionGateError("edge_below_threshold")
        log.debug("gate 4 ok: edge=%.4f >= %s%%", candidate.edge, threshold)

        # GATE 5 — position size, against both the config and a hard ceiling.
        amount = candidate.amount_usdc
        max_allowed = float(cfg.max_position_usdc or 0)
        if not (amount > 0):
            raise ExecutionGateError("invalid_amount")
        if max_allowed <= 0 or amount > max_allowed:
            raise ExecutionGateError("invalid_amount")
        if amount > ABSOLUTE_MAX_POSITION_USDC:
            raise ExecutionGateError("invalid_amount")
        log.debug("gate 5 ok: $%.2f <= $%.2f", amount, max_allowed)

        # GATE 6 — the identifier must be one the CLOB can actually resolve.
        # Without this the order goes out against a numeric Gamma id and the
        # child exits 1 with "market not found" (audit F1).
        condition_id = candidate.condition_id or ""
        if not CONDITION_ID_RE.fullmatch(condition_id):
            log.error(
                "gate 6: candidate has no valid conditionId (market_id=%s)",
                candidate.market_id,
            )
            raise ExecutionGateError("invalid_market_identifier")
        log.debug("gate 6 ok: conditionId well-formed")

    # --- execution --------------------------------------------------------

    async def _place_order(self, candidate: ScannerCandidate) -> TradeExecutionResult:
        """Invoke execute_trade.py and persist the resulting position."""
        argv = [
            "python3",
            self._script_path,
            "--market", candidate.condition_id or "",
            "--direction", candidate.direction.upper(),
            "--amount", str(candidate.amount_usdc),
            "--price", str(candidate.market_probability),
        ]
        # argv is logged deliberately: it contains no secret, and knowing the
        # exact command that spent money is worth more than the noise.
        log.info(
            "executing: %s %s $%.2f (condition_id=%s...)",
            candidate.asset, candidate.direction, candidate.amount_usdc,
            (candidate.condition_id or "")[:12],
        )

        try:
            completed = await self._run_script(argv)
        except subprocess.TimeoutExpired:
            # The child may have posted an order before the clock ran out.
            log.error(
                "execute_trade.py timed out after %ds — ORDER STATUS UNKNOWN, "
                "reconcile against Polymarket by hand",
                SUBPROCESS_TIMEOUT_SECONDS,
            )
            await self._notify(
                f"❌ Trade failed: {candidate.question}\n"
                "Error: execution_timeout — ORDER STATUS UNKNOWN, check Polymarket"
            )
            return TradeExecutionResult(
                success=False,
                error="execution_timeout",
                executed_at=datetime.now(timezone.utc),
            )
        except Exception as exc:  # noqa: BLE001 - never let the money path raise
            log.error("could not launch execute_trade.py: %s", type(exc).__name__)
            await self._notify(
                f"❌ Trade failed: {candidate.question}\nError: execution_failed (check logs)"
            )
            return TradeExecutionResult(
                success=False,
                error="execution_failed",
                executed_at=datetime.now(timezone.utc),
            )

        payload = self._parse_stdout(completed.stdout)

        if completed.returncode != 0 or "error" in payload:
            # execute_trade.py reports handled errors as JSON on STDOUT and
            # exits 1; stderr only carries unhandled tracebacks. Log both, but
            # only the extracted `error` string, never the whole stdout.
            detail = str(payload.get("error") or "")[:300]
            log.error(
                "execute_trade.py exited %s: %s",
                completed.returncode, _scrub(detail, config.polymarket_private_key),
            )
            if completed.stderr:
                log.error(
                    "execute_trade.py stderr: %s",
                    _scrub(completed.stderr[:500], config.polymarket_private_key),
                )
            await self._notify(
                f"❌ Trade failed: {candidate.question}\nError: execution_failed (check logs)"
            )
            return TradeExecutionResult(
                success=False,
                error="execution_failed",
                executed_at=datetime.now(timezone.utc),
            )

        # Succeeded. From here the money is spent — a failure to persist is
        # reported loudly but must NOT be reported as a failed trade.
        entry_price, shares, entry_cost = self._derive_entry(candidate, payload)
        tx_hash = self._extract_tx_hash(payload)

        position_id: Optional[str] = None
        try:
            row = await write_position({
                # market_id is a uuid FK to trading_markets; Polymarket ids are
                # not uuids and that table is empty, so it stays NULL — the
                # same convention trading_simulations already follows.
                "market_id": None,
                # The ONLY link from this position back to a priceable market:
                # trading_positions carries no Polymarket identifier, so the
                # Position Monitor resolves simulation_id ->
                # trading_simulations.raw_output.polymarket_condition_id. A
                # NULL here produces a position that never prices and never
                # exits (Session 5 audit, F4).
                "simulation_id": candidate.simulation_id,
                "direction": candidate.direction.upper(),
                # Real cash out of the wallet when observable (relay cash_out,
                # fee included), NEVER the pre-approval proposal: pnl on close
                # is exit_usdc minus this, and exit_usdc is real net proceeds.
                "usdc_amount": entry_cost,
                "entry_price": entry_price,
                "shares": shares,
                "entry_edge": candidate.edge,
                "entry_simulation_probability": candidate.sim_probability,
                "entry_implied_odds": candidate.market_probability,
                "status": "open",
                "opened_at": datetime.now(timezone.utc).isoformat(),
                "tx_hash": tx_hash,
            })
            position_id = str(row.get("id")) if row.get("id") is not None else None
        except (SupabaseError, ValueError) as exc:
            # An untracked open position is the worst state this system can be
            # in: real exposure the monitor cannot see. Shout about it.
            log.error(
                "TRADE PLACED BUT POSITION NOT RECORDED (%s) — reconcile by hand: "
                "%s %s $%.2f",
                type(exc).__name__, candidate.asset, candidate.direction,
                candidate.amount_usdc,
            )
            await self._notify(
                f"⚠️ Trade placed but NOT recorded: {candidate.question}\n"
                f"BUY {candidate.direction} @ ${candidate.amount_usdc:.2f} USDC\n"
                "Position is open and untracked — reconcile manually."
            )
            return TradeExecutionResult(
                success=True,
                tx_hash=tx_hash,
                error="position_not_recorded",
                executed_at=datetime.now(timezone.utc),
            )

        await self._notify(
            f"✅ Trade placed: {candidate.question}\n"
            f"BUY {candidate.direction} @ ${candidate.amount_usdc:.2f} USDC\n"
            f"Edge: {candidate.edge:.1%} | {candidate.market_url}"
        )
        log.info(
            "trade executed and recorded: position_id=%s %s %s $%.2f",
            position_id, candidate.asset, candidate.direction, candidate.amount_usdc,
        )
        return TradeExecutionResult(
            success=True,
            position_id=position_id,
            tx_hash=tx_hash,
            executed_at=datetime.now(timezone.utc),
        )

    async def _run_script(self, argv: list[str]) -> "subprocess.CompletedProcess[str]":
        """Run execute_trade.py. The single point where this process spends money.

        `argv` is a LIST and shell=True is absent — the market identifier comes
        from a remote API, and a shell would make it injectable. Do not
        "simplify" this into a string command.

        subprocess.run goes through a worker thread because this coroutine
        shares an event loop with the approval poller and /health; a 60s
        blocking call in-loop would freeze both.
        """
        return await asyncio.to_thread(
            subprocess.run,
            argv,
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT_SECONDS,
        )

    # --- payload handling -------------------------------------------------

    @staticmethod
    def _parse_stdout(stdout: str) -> dict[str, Any]:
        """Decode the child's JSON. Returns {} when it is not JSON.

        The full stdout is logged at DEBUG only, scrubbed of the Polymarket key
        first. It should never contain the key — the child never echoes it —
        but the scrub means a future change to that script cannot turn this
        into a credential leak.
        """
        text = (stdout or "").strip()
        if text:
            log.debug(
                "execute_trade.py stdout: %s",
                _scrub(text[:2000], config.polymarket_private_key),
            )
        if not text:
            return {}
        try:
            parsed = json.loads(text)
        except ValueError:
            log.error("execute_trade.py returned non-JSON stdout")
            return {}
        return parsed if isinstance(parsed, dict) else {}

    @staticmethod
    def _as_float(raw: Any) -> Optional[float]:
        """float(raw) or None. The CLOB serialises amounts as strings."""
        try:
            if raw is None or isinstance(raw, bool):
                return None
            return float(raw)
        except (TypeError, ValueError):
            return None

    @classmethod
    def _derive_entry(
        cls, candidate: ScannerCandidate, payload: dict[str, Any]
    ) -> tuple[Optional[float], Optional[float], Optional[float]]:
        """(entry_price, shares, usdc_amount) for the position row.

        Preference order, best real data first (audit 2026-08-25: position
        f4be9ee8 recorded the scan-time proposal while the real fill was
        0.284 x 35.211266 shares with a $0.50 fee on top):

        entry_price / shares:
          1. The order response's matched amounts: for a market BUY,
             makingAmount is the real USDC notional and takingAmount the real
             shares, so price = making/taking. Only trusted when the order
             reports status "matched".
          2. Legacy price keys (price/avgPrice/...) kept from the pre-audit
             code. No current CLOB response carries them, but a shape change
             should degrade gracefully, not silently.
          3. Scan-time price, shares = proposed amount / price.
          NULL, never 0.0, when nothing is usable: a zero entry_price reads
          as a real price downstream (it disables the stop-loss rule and
          poisons pnl, which feeds Gate 3's daily-loss sum).

        usdc_amount (the figure every pnl is computed against):
          1. The relay's `cash_out`: true wallet debit including the fee the
             CLOB API never reports, decoded from the settlement tx. Refused
             (with a log) if it is somehow below the matched notional, since a
             negative fee is not a thing.
          2. The matched notional (makingAmount).
          3. The proposed amount, exactly the pre-audit behaviour.
        """
        response = payload.get("response")

        price: Optional[float] = None
        shares: Optional[float] = None
        notional: Optional[float] = None

        # 1. Real matched amounts.
        if isinstance(response, dict):
            status = str(response.get("status") or "").lower()
            taking = cls._as_float(response.get("takingAmount"))
            making = cls._as_float(response.get("makingAmount"))
            if status == "matched" and taking and taking > 0 and making and making > 0:
                implied = making / taking
                if 0 < implied <= 1:
                    price = round(implied, 6)
                    shares = round(taking, 6)
                    notional = round(making, 6)
                else:
                    log.error(
                        "matched amounts imply price %.6f outside (0,1], "
                        "ignoring fill amounts", implied,
                    )

        # 2. Legacy price keys.
        if price is None and isinstance(response, dict):
            for key in ("price", "avgPrice", "average_price", "fillPrice", "matchedPrice"):
                value = cls._as_float(response.get(key))
                if value is not None and 0 < value <= 1:
                    price = value
                    break

        # 3. Scan-time fallback.
        if price is None:
            price = float(candidate.market_probability or 0) or None
            if price is not None:
                log.info(
                    "no fill data in CLOB response, recording scan-time price %.4f",
                    price,
                )

        requested = cls._as_float(candidate.amount_usdc)

        if not price or price <= 0:
            log.error("no usable entry price — recording NULL entry_price/shares")
            price, shares = None, None
        elif shares is None and requested is not None:
            shares = round(requested / price, 6)

        # usdc_amount: real cash out > matched notional > proposed amount.
        cash_out = cls._as_float(payload.get("cash_out"))
        if cash_out is not None and cash_out > 0:
            if notional is not None and cash_out < notional:
                log.error(
                    "relay cash_out %.6f is below matched notional %.6f, "
                    "distrusting it and recording the notional", cash_out, notional,
                )
                usdc_amount = notional
            else:
                usdc_amount = cash_out
                log.info(
                    "recording real cash out %.6f USDC (notional %s)",
                    cash_out, notional,
                )
        elif notional is not None:
            log.warning(
                "no usable cash_out from relay (%s), recording notional %.6f, "
                "which EXCLUDES any fee",
                str(payload.get("cash_out_error") or "absent")[:200], notional,
            )
            usdc_amount = notional
        else:
            usdc_amount = requested

        return price, shares, usdc_amount

    @staticmethod
    def _extract_tx_hash(payload: dict[str, Any]) -> Optional[str]:
        """The settlement transaction hash, or a labelled fallback identifier.

        The CLOB response carries settlement hashes under `transactionsHashes`
        (plural, a list). The pre-audit code looked for `transactionHash`
        singular, never matched, and fell through to orderID, which is why
        every automated position before 2026-08-25 stores the ORDER id in
        tx_hash, not a real transaction hash. Order of preference:

          1. transactionsHashes[0], the real settlement tx.
          2. Legacy singular keys, in case the response shape changes back.
          3. orderID, still stored (NULL tx_hash is the manual-entry marker,
             see manual.py) but logged loudly as a fallback so it is never
             again mistaken for an on-chain hash.
        """
        response = payload.get("response")
        if not isinstance(response, dict):
            return None

        hashes = response.get("transactionsHashes")
        if isinstance(hashes, list):
            for value in hashes:
                if isinstance(value, str) and value:
                    return value[:200]

        for key in ("transactionHash", "transaction_hash", "txHash"):
            value = response.get(key)
            if isinstance(value, str) and value:
                return value[:200]

        for key in ("orderID", "orderId", "id"):
            value = response.get(key)
            if isinstance(value, str) and value:
                log.warning(
                    "no settlement hash in CLOB response, storing order id "
                    "%s… in tx_hash as fallback", value[:12],
                )
                return value[:200]
        return None

    # --- helpers ----------------------------------------------------------

    @staticmethod
    def _blocked(candidate: ScannerCandidate, gate: str) -> TradeExecutionResult:
        return TradeExecutionResult(
            success=False,
            gate_blocked=gate,
            executed_at=datetime.now(timezone.utc),
        )

    async def _notify(self, text: str) -> None:
        """Best-effort Telegram send. A notification failure never fails a trade."""
        if not self._token or not self._chat_id:
            log.error("telegram notification skipped: not configured")
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
                    "telegram sendMessage returned HTTP %d: %s",
                    response.status_code, _scrub(response.text[:200], self._token),
                )
        except Exception as exc:  # noqa: BLE001
            log.error(
                "telegram sendMessage failed: %s: %s",
                type(exc).__name__, _scrub(str(exc), self._token),
            )
