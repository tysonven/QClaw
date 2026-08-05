#!/usr/bin/env python3
"""Trade engine entry point — FastAPI app plus the uvicorn runner.

Bound to 127.0.0.1:4003. Loopback because /health and /config are unauthenticated
internal endpoints. 4003 rather than 4002 because PM2's clipper-worker already
owns 0.0.0.0:4002 and answers /health there — binding 4002 would have produced a
health check that passed while hitting the wrong service.

Run directly (`python3 src/trade_engine/main.py`) under PM2. The sys.path
insert below makes the absolute `src.trade_engine.*` imports resolve when the
file is executed as a script rather than imported as a module; `src` resolves
as a PEP 420 namespace package, so no src/__init__.py is needed.
"""

import os
import sys

sys.path.insert(
    0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
)

import asyncio  # noqa: E402
import logging  # noqa: E402
from contextlib import asynccontextmanager  # noqa: E402
from typing import Any, Optional  # noqa: E402

import uvicorn  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402
from fastapi.encoders import jsonable_encoder  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

from src.trade_engine.approval import ApprovalGate, run_update_poller  # noqa: E402
from src.trade_engine.executor import TradeExecutor  # noqa: E402
from src.trade_engine.config import config, configure_logging  # noqa: E402
from src.trade_engine.database import (  # noqa: E402
    SupabaseError,
    close_client,
    count_all_positions,
    count_open_positions,
    get_daily_pnl,
    get_trading_config,
    write_simulation,
)
from src.trade_engine.analyst import TradeAnalyst  # noqa: E402
from src.trade_engine.models import (  # noqa: E402
    AnalystRecommendation,
    ApprovalResult,
    HealthResponse,
    ScannerCandidate,
    ScannerRunSummary,
    TradeExecutionResult,
    TradingConfig,
)
from src.trade_engine.scanner import (  # noqa: E402
    PolymarketScanner,
    last_run_state,
    record_run,
    simulation_rows,
)
from src.trade_engine.scheduler import (  # noqa: E402
    is_running,
    shutdown_scheduler,
    start_scheduler,
)

configure_logging(config.log_level)
log = logging.getLogger("trade_engine.main")

# Process-wide singleton. /scan, /health and the update poller must all see the
# same _pending dict, so the gate cannot be constructed per request.
approval_gate = ApprovalGate()

# The only object in this process that can spend money. Constructed once so the
# /scan and /execute paths share one HTTP client; it holds no trade state.
trade_executor = TradeExecutor()

_poller_task: Optional[asyncio.Task] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _poller_task

    log.info("trade-engine %s starting on %s:%s", config.version,
             config.trade_engine_host, config.trade_engine_port)
    start_scheduler()

    # The poller runs ONLY against a dedicated bot token. TELEGRAM_BOT_TOKEN is
    # long-polled by the quantumclaw process and Telegram allows one getUpdates
    # consumer per bot, so reusing it would steal Charlie's updates.
    if config.telegram_poller_enabled:
        _poller_task = asyncio.create_task(run_update_poller(approval_gate))
    elif not config.trade_telegram_bot_token:
        log.warning(
            "TRADE_TELEGRAM_BOT_TOKEN not set — approval callbacks cannot be "
            "received. Approval requests will still send, but every one will "
            "time out. Set a dedicated bot token to enable the gate."
        )
    else:
        log.warning(
            "TRADE_TELEGRAM_BOT_TOKEN equals TELEGRAM_BOT_TOKEN — poller "
            "disabled to avoid stealing updates from the quantumclaw bot. "
            "Approvals will time out until a dedicated token is configured."
        )

    try:
        yield
    finally:
        if _poller_task is not None:
            _poller_task.cancel()
            try:
                await _poller_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            _poller_task = None
        await approval_gate.aclose()
        await trade_executor.aclose()
        shutdown_scheduler()
        await close_client()
        log.info("trade-engine stopped")


app = FastAPI(title="trade-engine", version=config.version, lifespan=lifespan)


@app.get("/health", response_model=HealthResponse)
async def health() -> JSONResponse:
    """Liveness plus a live read of trading state.

    A Supabase failure returns 503 with the error text rather than raising a
    500 — the error is reported, never swallowed, but a DB blip should read as
    'degraded' to a health check instead of an unhandled exception.
    """
    scan_state = last_run_state()
    try:
        cfg = await get_trading_config()
        open_count = await count_open_positions()
        total_count = await count_all_positions()
        daily_pnl = await get_daily_pnl()
    except SupabaseError as exc:
        log.error("health check failed: %s", exc)
        return JSONResponse(
            status_code=503,
            content=jsonable_encoder(HealthResponse(
                status="degraded",
                version=config.version,
                scheduler_running=is_running(),
                last_scan_at=scan_state["at"],
                last_scan_high_edge_count=scan_state["high_edge_count"],
                analyst_available=bool(config.anthropic_api_key),
                pending_approvals=approval_gate.pending_count,
                approval_gate_active=config.telegram_poller_enabled,
                error=str(exc),
            )),
        )

    return JSONResponse(
        content=jsonable_encoder(HealthResponse(
            status="ok",
            version=config.version,
            trading_enabled=cfg.trading_enabled,
            open_positions=open_count,
            scheduler_running=is_running(),
            last_scan_at=scan_state["at"],
            last_scan_high_edge_count=scan_state["high_edge_count"],
            analyst_available=bool(config.anthropic_api_key),
            pending_approvals=approval_gate.pending_count,
            approval_gate_active=config.telegram_poller_enabled,
            total_positions=total_count,
            daily_pnl=daily_pnl,
        ))
    )


@app.get("/config", response_model=TradingConfig)
async def read_config() -> TradingConfig:
    """Current trading_config. No auth — loopback-bound, internal only."""
    return await get_trading_config()


async def _persist_simulations(simulated: list) -> tuple[int, int]:
    """Write every simulation row and stash the created id back on the source.

    Persists all buckets, not just high-edge — the neutral and no-edge rows are
    what make calibration analysis possible later. The created id is written
    back onto the in-memory row so _attach_simulation_id can find it without a
    second round trip.
    """
    written, errors = 0, 0
    rows = simulation_rows(simulated)
    for source, row in zip(simulated, rows):
        try:
            created = await write_simulation(row)
            written += 1
            if isinstance(created, dict) and created.get("id"):
                source["simulation_id"] = str(created["id"])
        except (SupabaseError, ValueError) as exc:
            errors += 1
            log.error("failed to persist simulation for %s: %s", row.get("asset"), exc)
    log.info("persisted %d/%d simulations (%d failed)", written, len(rows), errors)
    return written, errors


def _attach_simulation_id(summary: ScannerRunSummary, simulated: list) -> None:
    """Point best_trade at its persisted simulation row.

    Matches on market_id, which is unique within a run (analyse_edge dedupes on
    it). If the simulation write failed there is nothing to attach — the trade
    can still execute, it just produces a position the monitor cannot price, so
    that case is logged loudly rather than passed over.
    """
    best = summary.best_trade
    if best is None:
        return
    for source in simulated:
        if str(source.get("market_id")) == best.market_id:
            simulation_id = source.get("simulation_id")
            if simulation_id:
                best.simulation_id = str(simulation_id)
                return
            break
    log.error(
        "best_trade has no persisted simulation_id (market_id=%s) — a position "
        "opened from it will not be priceable by the Position Monitor",
        best.market_id,
    )


@app.post("/scan", response_model=ScannerRunSummary)
async def scan() -> JSONResponse:
    """Run the scanner once, on demand.

    No cron is registered yet (Session 4 wires the schedule), so this is the
    only trigger. No auth — loopback-bound, internal only. Nothing here places
    a trade: best_trade is a suggestion, and execution lands in Session 5.

    A full pass makes up to 30 sequential /simulate calls at ~0.5s apart plus
    yfinance latency, so this can take a couple of minutes.

    It can then take a further 30 MINUTES: when a best_trade survives the
    Analyst, the approval gate blocks this request until the button is tapped
    or APPROVAL_TIMEOUT_SECONDS elapses. Call it with a client timeout that
    exceeds the approval window, or set APPROVAL_TIMEOUT_SECONDS lower.
    """
    try:
        open_count = await count_open_positions()
    except SupabaseError as exc:
        log.error("scan aborted, could not read open positions: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"error": "could not read open positions", "detail": str(exc)},
        )

    try:
        scanner_ctx = PolymarketScanner(
            analyst=TradeAnalyst(),
            approval_gate=approval_gate,
            executor=trade_executor,
        )
        async with scanner_ctx as scanner:
            markets = await scanner.fetch_markets()
            candidates = await scanner.analyse_edge(markets)
            simulated, sim_errors = await scanner.run_simulations(candidates)
            summary = await scanner.build_run_summary(
                simulated,
                markets_fetched=len(markets),
                candidates_analysed=len(candidates),
                sim_errors=sim_errors,
                open_positions=open_count,
            )
            summary.best_trade = scanner.select_best_trade(summary)
            await scanner.apply_analyst(summary)

            # Simulations are persisted BEFORE the approval gate, not after,
            # so best_trade can carry its simulation_id into the position row.
            # A position with no simulation_id is unresolvable by the Position
            # Monitor — it would never price, never take profit and never stop
            # out. Ordering this after execution would silently reintroduce
            # that (Session 5 audit, F4).
            written, write_errors = await _persist_simulations(simulated)
            _attach_simulation_id(summary, simulated)

            await scanner.apply_approval(summary)
            await scanner.apply_execution(summary)
            record_run(summary)
    except Exception as exc:  # noqa: BLE001 - surface a clean message, not a stack
        log.exception("scan failed")
        return JSONResponse(
            status_code=500,
            content={"error": "scan failed", "detail": f"{type(exc).__name__}: {exc}"},
        )

    # raw_response is debugging material, not an API surface — strip it from
    # both copies of the recommendation, the top-level one and the one the
    # approval_result carries.
    return JSONResponse(
        content=jsonable_encoder(summary, exclude={
            "analyst_recommendation": {"raw_response"},
            "approval_result": {"recommendation": {"raw_response"}},
        })
    )


@app.post("/analyse", response_model=AnalystRecommendation)
async def analyse(candidate: ScannerCandidate) -> JSONResponse:
    """Run the Analyst against one candidate, without a full scan.

    No auth — loopback-bound, internal only. Advisory: the verdict is returned
    to the caller and nothing is written or executed. Useful for exercising the
    Analyst against a hand-built candidate or a best_trade from a prior /scan.
    """
    recommendation = await TradeAnalyst().analyse(candidate)
    log.info(
        "/analyse %s %s -> %s (confidence %.2f, flags %s)",
        candidate.asset, candidate.direction,
        recommendation.recommendation, recommendation.confidence, recommendation.flags,
    )
    return JSONResponse(
        content=jsonable_encoder(recommendation, exclude={"raw_response"})
    )


@app.post("/execute", response_model=TradeExecutionResult)
async def execute(result: ApprovalResult) -> JSONResponse:
    """Run the executor against one already-approved trade.

    THIS SPENDS REAL MONEY. It bypasses the scanner, the Analyst and the
    approval gate, so the ApprovalResult in the body is the only evidence of
    consent — which is why the executor re-checks `status == approved` itself
    rather than trusting the caller, and re-runs all six financial gates
    against live Supabase state before anything is sent to Polymarket.

    No auth, in the same sense as /scan and /config: the process binds
    127.0.0.1 only. That is the whole access control story — do not expose this
    port. Intended for replaying a stuck approval by hand, not for automation.
    """
    execution = await trade_executor.execute(result)
    log.info(
        "/execute -> success=%s gate_blocked=%s error=%s",
        execution.success, execution.gate_blocked, execution.error,
    )
    return JSONResponse(content=jsonable_encoder(execution))


@app.post("/approval/callback")
async def approval_callback(request: Request) -> JSONResponse:
    """Telegram webhook sink for inline-keyboard taps.

    Unused in the deployed configuration — the bot has no webhook set, so
    callbacks arrive through run_update_poller instead. It exists so switching
    to webhook mode is a setWebhook call and not a code change, and so a
    callback can be replayed by hand against a stuck approval.

    Always answers 200: Telegram retries non-2xx webhook deliveries, and a
    retry storm on a decided approval is worse than a dropped duplicate.
    Unauthenticated in the same sense as /scan and /config — the process is
    bound to loopback. The real check is inside handle_callback, which
    validates the sender against OWNER_TELEGRAM_CHAT_ID and requires an
    unguessable uuid4 approval_id.
    """
    try:
        update: Any = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(content={"ok": True, "handled": False})

    callback_query = (update or {}).get("callback_query") if isinstance(update, dict) else None
    if not isinstance(callback_query, dict):
        return JSONResponse(content={"ok": True, "handled": False})

    try:
        result = await approval_gate.handle_callback(callback_query)
    except Exception:  # noqa: BLE001 - never surface a stack to Telegram
        log.exception("approval callback handling failed")
        return JSONResponse(content={"ok": True, "handled": False})

    return JSONResponse(content={
        "ok": True,
        "handled": result is not None,
        "status": result.status.value if result is not None else None,
    })


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=config.trade_engine_host,
        port=config.trade_engine_port,
        log_level=config.log_level.lower(),
    )
