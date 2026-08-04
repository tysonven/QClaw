#!/usr/bin/env python3
"""Telegram approval gate — the human brake in front of the executor.

Direct Telegram HTTP API via httpx. No bot framework: grammY is Charlie's
(JS) dependency and this process is Python, but more importantly the sending
path here must stay a thin, auditable POST — the same shape as the
`sendTelegram` helper in src/dashboard/server.js and src/observability/*.js.

TOKEN SEPARATION (read before changing anything in here)
--------------------------------------------------------
Telegram permits exactly ONE getUpdates consumer per bot. The quantumclaw
process long-polls TELEGRAM_BOT_TOKEN continuously. A second poller on that
token does not merely miss callbacks — it steals Charlie's message updates.
So the poller runs only against a dedicated TRADE_TELEGRAM_BOT_TOKEN, and
config.telegram_poller_enabled is the single gate on that. Sending is
unconstrained and falls back to the shared token; the failure mode of a
missing dedicated token is therefore "approval times out", never "trade
executes unreviewed" and never "Charlie's bot breaks".

Session 4 is advisory end-to-end: this module returns an ApprovalStatus and
nothing else. No execution path exists yet.
"""

import asyncio
import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx

from src.trade_engine.config import config
from src.trade_engine.models import (
    AnalystRecommendation,
    ApprovalResult,
    ApprovalStatus,
    PendingApproval,
    ScannerCandidate,
)

log = logging.getLogger("trade_engine.approval")

TELEGRAM_API_BASE = "https://api.telegram.org"

# Long-poll for 30s server-side; the client must outlive that or every poll
# ends in a spurious ReadTimeout.
POLL_TIMEOUT_SECONDS = 30
POLL_HTTP_TIMEOUT_SECONDS = 40.0

# getUpdates backoff on network/API failure.
POLL_BACKOFF_INITIAL = 1.0
POLL_BACKOFF_MAX = 60.0

CALLBACK_PREFIX_APPROVE = "approve"
CALLBACK_PREFIX_SKIP = "skip"

# Decided results are normally collected by the waiting wait_for_decision call.
# One is orphaned whenever the waiter is gone (a cancelled /scan request), so
# the map is capped rather than left to grow for the life of the process.
MAX_RETAINED_RESULTS = 32


class ApprovalGateBusy(RuntimeError):
    """Raised when a second approval is requested while one is outstanding.

    One pending approval at a time is a hard rule: two live Telegram messages
    would let a single tap resolve the wrong trade, and the position cap makes
    a second concurrent opportunity worthless anyway.
    """


def _scrub(text: str, *tokens: str) -> str:
    """Remove bot tokens from text destined for a log.

    httpx puts the full request URL in its exception strings, and the URL
    embeds the bot token in its path — logging a raw httpx error is the
    2026-05-14 token-leak incident class (see the `silent: true` note in
    src/channels/manager.js). Every log line that could carry an exception
    string goes through this first.
    """
    out = text
    for token in tokens:
        if token:
            out = out.replace(token, "***")
    return out


class ApprovalGate:
    """Sends a trade opportunity to Telegram and waits for a button tap.

    State is in-process and deliberately not persisted: a restart drops
    pending approvals, which is correct — an approval that outlives the
    process that asked for it has no scan context to execute against, and
    Session 5's executor must never act on a decision it cannot trace.
    """

    def __init__(
        self,
        *,
        client: Optional[httpx.AsyncClient] = None,
        token: Optional[str] = None,
        chat_id: Optional[str] = None,
        timeout_seconds: Optional[int] = None,
        poll_interval_seconds: Optional[float] = None,
    ) -> None:
        self._client = client
        self._owns_client = client is None
        self._token = token if token is not None else config.approval_bot_token
        self._chat_id = chat_id if chat_id is not None else config.owner_telegram_chat_id
        self.timeout_seconds = (
            timeout_seconds
            if timeout_seconds is not None
            else config.approval_timeout_seconds
        )
        self.poll_interval_seconds = (
            poll_interval_seconds
            if poll_interval_seconds is not None
            else config.approval_poll_interval_seconds
        )

        self._pending: dict[str, PendingApproval] = {}
        self._results: dict[str, ApprovalResult] = {}
        self._lock = asyncio.Lock()

    # --- lifecycle --------------------------------------------------------

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(POLL_HTTP_TIMEOUT_SECONDS, connect=10.0)
            )
        return self._client

    # --- introspection ----------------------------------------------------

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    @property
    def has_pending(self) -> bool:
        return bool(self._pending)

    # --- telegram transport ----------------------------------------------

    async def _api(self, method: str, payload: dict[str, Any]) -> Optional[dict[str, Any]]:
        """POST one Telegram API method. Returns `result` on success, else None.

        Never raises and never logs the URL — see _scrub. A failed send is
        reported and swallowed so a Telegram outage degrades the gate to
        "times out" rather than taking down the scan.
        """
        if not self._token or not self._chat_id:
            log.error("telegram %s skipped: bot token or chat id not configured", method)
            return None

        url = f"{TELEGRAM_API_BASE}/bot{self._token}/{method}"
        try:
            response = await self._get_client().post(url, json=payload)
        except Exception as exc:  # noqa: BLE001 - transport errors must not escape
            log.error(
                "telegram %s failed: %s: %s",
                method, type(exc).__name__, _scrub(str(exc), self._token),
            )
            return None

        if response.status_code != 200:
            log.error(
                "telegram %s returned HTTP %d: %s",
                method, response.status_code,
                _scrub(response.text[:300], self._token),
            )
            return None

        try:
            body = response.json()
        except ValueError:
            log.error("telegram %s returned non-JSON body", method)
            return None

        if not body.get("ok"):
            log.error(
                "telegram %s rejected: %s",
                method, _scrub(str(body.get("description"))[:300], self._token),
            )
            return None
        return body.get("result") if isinstance(body.get("result"), dict) else {}

    # --- message construction --------------------------------------------

    @staticmethod
    def build_message(
        candidate: ScannerCandidate, recommendation: AnalystRecommendation
    ) -> str:
        """The approval message body.

        Sent as PLAIN TEXT with no parse_mode on purpose: `question` and
        `reasoning` are untrusted input (Polymarket copy and Claude output),
        and a stray '*' or '_' under Markdown would either corrupt the render
        or let market text inject formatting into a money decision.

        `edge` is signed rather than hardcoded '+' — best_trade only ever
        comes from the high_edge bucket today, but a '+-5.0%' render on any
        future caller would be worse than a correct '-5.0%'.
        """
        verdict = recommendation.recommendation.upper()
        return (
            "🎯 Trade Opportunity\n"
            "\n"
            f"{candidate.question}\n"
            f"Direction: BUY {candidate.direction}\n"
            f"Edge: {candidate.edge:+.1%} "
            f"(Sim: {candidate.sim_probability:.1%} vs "
            f"Market: {candidate.market_probability:.1%})\n"
            f"Volume: ${candidate.volume:,.0f} | "
            f"Horizon: {candidate.horizon_days}d\n"
            f"Position: ${candidate.amount_usdc:.2f}\n"
            "\n"
            f"📊 Analyst: {verdict} ({recommendation.confidence:.0%} confidence)\n"
            f"\"{recommendation.reasoning}\"\n"
            "\n"
            f"{candidate.market_url}"
        )

    @staticmethod
    def build_keyboard(approval_id: str) -> dict[str, Any]:
        """Two-button inline keyboard.

        callback_data carries the approval_id and nothing else — no market id,
        no size, no direction. Telegram caps callback_data at 64 bytes and the
        longest form here is 'approve:' + uuid4 = 44, so it cannot truncate.
        """
        return {
            "inline_keyboard": [[
                {"text": "✅ Execute", "callback_data": f"{CALLBACK_PREFIX_APPROVE}:{approval_id}"},
                {"text": "❌ Skip", "callback_data": f"{CALLBACK_PREFIX_SKIP}:{approval_id}"},
            ]]
        }

    # --- send -------------------------------------------------------------

    async def send_approval_request(
        self,
        candidate: ScannerCandidate,
        recommendation: AnalystRecommendation,
    ) -> PendingApproval:
        """Post the opportunity to Telegram and register it as pending.

        Raises ApprovalGateBusy if one is already outstanding. Registration
        happens BEFORE the network call so a callback that somehow lands
        between send and registration still finds its approval.
        """
        async with self._lock:
            self._sweep_expired_locked()
            if self._pending:
                raise ApprovalGateBusy(
                    f"an approval is already pending ({len(self._pending)} outstanding)"
                )

            approval_id = str(uuid.uuid4())
            created_at = datetime.now(timezone.utc)
            pending = PendingApproval(
                approval_id=approval_id,
                candidate=candidate,
                recommendation=recommendation,
                created_at=created_at,
                expires_at=created_at + timedelta(seconds=self.timeout_seconds),
            )
            self._pending[approval_id] = pending

        result = await self._api("sendMessage", {
            "chat_id": self._chat_id,
            "text": self.build_message(candidate, recommendation),
            "reply_markup": self.build_keyboard(approval_id),
            "disable_web_page_preview": True,
        })

        if result is None:
            # Delivery failed. Drop the registration rather than leave a
            # pending approval nobody can see or answer — it would block the
            # next scan for the full timeout window for no reason.
            async with self._lock:
                self._pending.pop(approval_id, None)
            log.error(
                "approval request not delivered for %s %s — gate cleared",
                candidate.asset, candidate.direction,
            )
            raise ApprovalGateBusy("approval message could not be delivered")

        message_id = result.get("message_id")
        if isinstance(message_id, int):
            pending.message_id = message_id

        log.info(
            "approval requested: %s %s edge=%.4f size=$%.2f (expires in %ds)",
            candidate.asset, candidate.direction, candidate.edge,
            candidate.amount_usdc, self.timeout_seconds,
        )
        log.debug("approval_id=%s message_id=%s", approval_id, pending.message_id)
        return pending

    # --- callback handling ------------------------------------------------

    async def handle_callback(
        self, callback_query: dict[str, Any]
    ) -> Optional[ApprovalResult]:
        """Resolve one inline-keyboard tap.

        Returns the ApprovalResult on a valid approve/skip, else None.
        answerCallbackQuery is called on EVERY path, including rejections —
        an unanswered query leaves a spinner on the user's button forever.
        """
        query_id = callback_query.get("id")
        data = callback_query.get("data")

        if not isinstance(data, str) or ":" not in data:
            await self._answer(query_id, "Unrecognised action")
            return None

        action, _, approval_id = data.partition(":")
        if action not in (CALLBACK_PREFIX_APPROVE, CALLBACK_PREFIX_SKIP):
            await self._answer(query_id, "Unrecognised action")
            return None

        # P4: the approval_id is unguessable, but the sender is checked anyway.
        # The dedicated bot is discoverable by username, so anyone could open a
        # chat with it; only the owner may decide a trade.
        sender_id = (callback_query.get("from") or {}).get("id")
        if sender_id is not None and str(sender_id) != str(self._chat_id):
            log.warning("approval callback from non-owner sender rejected")
            await self._answer(query_id, "Not authorised")
            return None

        async with self._lock:
            pending = self._pending.get(approval_id)
            if pending is None:
                log.info("approval callback for unknown or already-decided request")
                log.debug("unknown approval_id=%s", approval_id)
                await self._answer(query_id, "Expired")
                return None

            if datetime.now(timezone.utc) >= pending.expires_at:
                log.info(
                    "approval callback arrived after expiry: %s %s",
                    pending.candidate.asset, pending.candidate.direction,
                )
                self._pending.pop(approval_id, None)
                expired_result = self._build_result(
                    pending, ApprovalStatus.timeout, "timeout"
                )
                self._publish_result(approval_id, expired_result)
                await self._answer(query_id, "Expired")
                await self._edit_message(
                    pending, "⏰ EXPIRED — 30min timeout, trade not taken"
                )
                return None

            self._pending.pop(approval_id, None)
            status = (
                ApprovalStatus.approved
                if action == CALLBACK_PREFIX_APPROVE
                else ApprovalStatus.skipped
            )
            result = self._build_result(pending, status, "user")
            self._publish_result(approval_id, result)

        await self._answer(
            query_id, "Approved" if status is ApprovalStatus.approved else "Skipped"
        )
        await self._edit_message(
            pending,
            "✅ APPROVED — executing trade"
            if status is ApprovalStatus.approved
            else "❌ SKIPPED — trade passed",
        )

        log.info(
            "Trade %s: %s",
            status.value.upper(), pending.candidate.question,
        )
        return result

    async def _answer(self, query_id: Optional[str], text: str) -> None:
        """Dismiss the button spinner. Best-effort — never blocks a decision."""
        if not query_id:
            return
        await self._api("answerCallbackQuery", {
            "callback_query_id": query_id,
            "text": text,
        })

    async def _edit_message(self, pending: PendingApproval, outcome: str) -> None:
        """Rewrite the original message to its outcome and drop the keyboard.

        Removing reply_markup is what stops a second tap producing a spinner
        against an approval that no longer exists.
        """
        if pending.message_id is None:
            return
        await self._api("editMessageText", {
            "chat_id": self._chat_id,
            "message_id": pending.message_id,
            "text": (
                f"{self.build_message(pending.candidate, pending.recommendation)}"
                f"\n\n{outcome}"
            ),
            "disable_web_page_preview": True,
        })

    # --- waiting ----------------------------------------------------------

    async def wait_for_decision(
        self,
        pending: PendingApproval,
        timeout_seconds: Optional[int] = None,
    ) -> ApprovalResult:
        """Block until the approval is decided or the window closes.

        Polls rather than using an Event so a decision resolved by any path —
        the update poller, the webhook endpoint, or the expiry sweep — is
        picked up identically. Deadline is monotonic, so an NTP step during
        the 30-minute window cannot expire an approval early or hang it.
        """
        limit = timeout_seconds if timeout_seconds is not None else self.timeout_seconds
        deadline = time.monotonic() + limit
        approval_id = pending.approval_id

        while True:
            result = self._results.pop(approval_id, None)
            if result is not None:
                return result

            if approval_id not in self._pending:
                # Resolved by a path that left no result (should not happen);
                # treat as a timeout rather than inventing an approval.
                log.warning("approval vanished without a result — recording timeout")
                return self._build_result(pending, ApprovalStatus.timeout, "timeout")

            if time.monotonic() >= deadline:
                break

            await asyncio.sleep(
                min(self.poll_interval_seconds, max(0.0, deadline - time.monotonic()))
            )

        result = await self._expire(approval_id, pending)
        # _expire publishes to _results for any other waiter; this waiter has
        # the value in hand, so clear it rather than leaving an orphan behind.
        self._results.pop(approval_id, None)
        return result

    async def _expire(
        self, approval_id: str, pending: PendingApproval
    ) -> ApprovalResult:
        """Time out one approval. Idempotent — safe to race with a tap."""
        async with self._lock:
            still_pending = self._pending.pop(approval_id, None)
            if still_pending is None:
                decided = self._results.pop(approval_id, None)
                if decided is not None:
                    return decided
                return self._build_result(pending, ApprovalStatus.timeout, "timeout")
            result = self._build_result(pending, ApprovalStatus.timeout, "timeout")
            # Publish before notifying: a wait_for_decision blocked on this
            # approval must read the same result the sweep produced, not fall
            # through to its "vanished without a result" guard.
            self._publish_result(approval_id, result)

        minutes = max(1, self.timeout_seconds // 60)
        await self._api("sendMessage", {
            "chat_id": self._chat_id,
            "text": (
                f"⏰ Trade opportunity expired ({minutes}min timeout): "
                f"{pending.candidate.question}"
            ),
            "disable_web_page_preview": True,
        })
        await self._edit_message(
            pending, f"⏰ EXPIRED — {minutes}min timeout, trade not taken"
        )
        log.info("Trade TIMEOUT: %s", pending.candidate.question)
        return result

    # --- expiry sweep -----------------------------------------------------

    def _sweep_expired_locked(self) -> None:
        """Drop expired entries. Caller must hold the lock.

        Purely local: the notification for a swept approval is sent by
        check_pending_expirations, which can await. This exists so a stale
        entry cannot block a new request just because nothing swept yet.
        """
        now = datetime.now(timezone.utc)
        for approval_id, pending in list(self._pending.items()):
            if now >= pending.expires_at:
                self._pending.pop(approval_id, None)
                if approval_id not in self._results:
                    self._publish_result(
                        approval_id,
                        self._build_result(pending, ApprovalStatus.timeout, "timeout"),
                    )

    async def check_pending_expirations(self) -> None:
        """Notify and clear approvals that outlived their window.

        Called from the update poller each cycle. wait_for_decision normally
        gets there first; this catches approvals whose waiter is gone — e.g.
        the /scan request was cancelled by the client mid-wait.
        """
        now = datetime.now(timezone.utc)
        async with self._lock:
            expired = [
                pending for pending in self._pending.values() if now >= pending.expires_at
            ]

        for pending in expired:
            await self._expire(pending.approval_id, pending)

    # --- helpers ----------------------------------------------------------

    def _publish_result(self, approval_id: str, result: ApprovalResult) -> None:
        """Record a decision for whichever waiter collects it, oldest evicted.

        dicts preserve insertion order, so popping the first key drops the
        least recent orphan.
        """
        self._results[approval_id] = result
        while len(self._results) > MAX_RETAINED_RESULTS:
            self._results.pop(next(iter(self._results)))

    @staticmethod
    def _build_result(
        pending: PendingApproval, status: ApprovalStatus, source: str
    ) -> ApprovalResult:
        return ApprovalResult(
            approval_id=pending.approval_id,
            status=status,
            candidate=pending.candidate,
            recommendation=pending.recommendation,
            decided_at=datetime.now(timezone.utc),
            decision_source=source,
        )

    @staticmethod
    def analyst_skip_result(
        candidate: ScannerCandidate, recommendation: AnalystRecommendation
    ) -> ApprovalResult:
        """The no-Telegram outcome: the Analyst passed, so nothing was asked.

        approval_id is still a uuid4 rather than a sentinel so downstream
        consumers can key on it uniformly.
        """
        return ApprovalResult(
            approval_id=str(uuid.uuid4()),
            status=ApprovalStatus.analyst_skip,
            candidate=candidate,
            recommendation=recommendation,
            decided_at=datetime.now(timezone.utc),
            decision_source="analyst_skip",
        )


async def run_update_poller(
    gate: ApprovalGate,
    *,
    token: Optional[str] = None,
    client: Optional[httpx.AsyncClient] = None,
    stop_after: Optional[int] = None,
) -> None:
    """Long-poll getUpdates and route callback_query updates into the gate.

    Only ever started when config.telegram_poller_enabled is True — see the
    module docstring for why running this against the shared quantumclaw token
    would break Charlie's Telegram channel.

    Cancellation-safe: the surrounding asyncio task is cancelled in the FastAPI
    lifespan, and CancelledError is allowed to propagate.

    stop_after bounds the loop iterations for tests; production passes None.
    """
    poll_token = token or config.trade_telegram_bot_token
    if not poll_token:
        log.warning("update poller not started: no dedicated bot token")
        return

    owns_client = client is None
    http = client or httpx.AsyncClient(
        timeout=httpx.Timeout(POLL_HTTP_TIMEOUT_SECONDS, connect=10.0)
    )
    url = f"{TELEGRAM_API_BASE}/bot{poll_token}/getUpdates"

    offset: Optional[int] = None
    backoff = POLL_BACKOFF_INITIAL
    iterations = 0

    log.info("telegram update poller started (callback_query only)")
    try:
        while stop_after is None or iterations < stop_after:
            iterations += 1
            params: dict[str, Any] = {
                "timeout": POLL_TIMEOUT_SECONDS,
                # Only callbacks. This bot has no chat role, and not fetching
                # messages keeps its update queue empty.
                "allowed_updates": '["callback_query"]',
            }
            if offset is not None:
                params["offset"] = offset

            try:
                response = await http.get(url, params=params)
                if response.status_code != 200:
                    raise RuntimeError(f"HTTP {response.status_code}")
                body = response.json()
                if not body.get("ok"):
                    raise RuntimeError(str(body.get("description"))[:200])
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - the loop must survive
                log.error(
                    "getUpdates failed (%s: %s), retrying in %.0fs",
                    type(exc).__name__, _scrub(str(exc), poll_token), backoff,
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, POLL_BACKOFF_MAX)
                continue

            backoff = POLL_BACKOFF_INITIAL
            for update in body.get("result") or []:
                update_id = update.get("update_id")
                if isinstance(update_id, int):
                    # Advance past this update so a crash cannot replay it.
                    offset = max(offset or 0, update_id + 1)
                callback_query = update.get("callback_query")
                if isinstance(callback_query, dict):
                    try:
                        await gate.handle_callback(callback_query)
                    except asyncio.CancelledError:
                        raise
                    except Exception:  # noqa: BLE001
                        log.exception("failed to handle approval callback")

            try:
                await gate.check_pending_expirations()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("expiry sweep failed")
    finally:
        if owns_client:
            await http.aclose()
        log.info("telegram update poller stopped")
