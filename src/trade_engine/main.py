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
from datetime import datetime, timezone  # noqa: E402
from typing import Any, Optional  # noqa: E402

import httpx  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402
from fastapi.encoders import jsonable_encoder  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from src.trade_engine.approval import ApprovalGate, run_update_poller  # noqa: E402
from src.trade_engine.executor import TradeExecutor  # noqa: E402
from src.trade_engine.config import config, configure_logging  # noqa: E402
from src.trade_engine.database import (  # noqa: E402
    HEARTBEAT_MONITOR,
    HEARTBEAT_SCANNER,
    SupabaseError,
    close_client,
    count_all_positions,
    count_open_positions,
    get_alerts_for_position,
    get_daily_pnl,
    get_open_positions,
    get_recent_simulations,
    get_trading_config,
    get_unresolved_alerts,
    record_success_heartbeat,
    resolve_alerts_for_position,
    set_manual_hold,
    update_position,
)
from src.trade_engine.manual import (  # noqa: E402
    ManualPositionError,
    log_manual_position,
)
from src.trade_engine.analyst import TradeAnalyst  # noqa: E402
from src.trade_engine.models import (  # noqa: E402
    AnalystRecommendation,
    ApprovalResult,
    ApprovalStatus,
    HealthResponse,
    HoldRequest,
    ManualCloseRequest,
    ManualPositionRequest,
    MonitorRunResult,
    ScannerCandidate,
    ScannerRunSummary,
    TradeExecutionResult,
    TradingConfig,
)
from src.trade_engine.monitor import (  # noqa: E402
    PositionMonitor,
    last_monitor_state,
)
from src.trade_engine.scanner import (  # noqa: E402
    PolymarketScanner,
    last_run_state,
)
from src.trade_engine.scheduler import (  # noqa: E402
    is_running,
    job_count,
    next_scan_time,
    register_jobs,
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


def _scan_summary_message(summary: ScannerRunSummary) -> str:
    """Telegram heartbeat text for one completed scheduled scan.

    Outcome lines report what actually HAPPENED, not what might be pending:
    scanner.run() blocks through the approval gate, so by the time this is
    built every approval is already decided — a literal "awaiting approval"
    line could only ever be stale.
    """
    lines = [
        "🔍 Scan complete",
        f"Markets: {summary.markets_fetched} fetched → "
        f"{summary.simulations_run} simulated",
        f"High-edge: {len(summary.high_edge)} | No-edge: {len(summary.no_edge)} "
        f"| Neutral: {summary.neutral_count}",
    ]
    next_run = next_scan_time()
    if next_run is not None:
        lines.append(f"Next scan: {next_run:%Y-%m-%d %H:%M} UTC")

    if summary.best_trade is None:
        lines.append("No trade opportunity found")
    elif summary.analyst_skip:
        reasoning = (
            summary.analyst_recommendation.reasoning
            if summary.analyst_recommendation is not None else ""
        )
        lines.append(f"⏭ Analyst skipped: {reasoning}")
    elif summary.execution_result is not None:
        lines.append(
            "✅ Trade placed" if summary.execution_result.success
            else "❌ Trade failed"
        )
    elif summary.approval_result is None:
        lines.append("⚠️ No approval requested (gate busy or unavailable)")
    elif summary.approval_result.status is ApprovalStatus.timeout:
        lines.append("⏳ Approval request sent — timed out without a response")
    elif summary.approval_result.status is ApprovalStatus.skipped:
        lines.append("🚫 Trade skipped via Telegram")
    else:
        lines.append(f"Approval: {summary.approval_result.status.value}")

    return "\n".join(lines)


async def scheduled_scan() -> None:
    """Cron entry point: one full scanner pass with the wired pipeline.

    Same pipeline /scan drives — scanner + analyst + approval gate + executor,
    sharing the process-wide gate and executor singletons. Never raises: an
    unhandled exception here would land in APScheduler's error listener and
    silently kill the cadence's usefulness, so failures are logged instead.
    """
    try:
        open_count = await count_open_positions()
    except SupabaseError as exc:
        log.error("scheduled scan aborted, could not read open positions: %s", exc)
        return
    try:
        scanner_ctx = PolymarketScanner(
            analyst=TradeAnalyst(),
            approval_gate=approval_gate,
            executor=trade_executor,
        )
        async with scanner_ctx as scanner:
            summary = await scanner.run(open_positions=open_count)
    except Exception:  # noqa: BLE001 - a failed scan must not break the schedule
        log.exception("scheduled scan failed")
        return

    # Success heartbeat, emitted for EVERY completed scan including one that
    # found nothing. A quiet market must never read as a dead process, which is
    # exactly why this keys on the scan COMPLETING and not on it having found
    # anything. Both failure paths above have already returned.
    await record_success_heartbeat(
        HEARTBEAT_SCANNER,
        {
            "markets_fetched": summary.markets_fetched,
            "simulations_run": summary.simulations_run,
            "high_edge": len(summary.high_edge),
            "open_positions": open_count,
        },
    )

    # Heartbeat so a quiet market is distinguishable from a dead engine on
    # Telegram. Reuses the executor's notifier: same dedicated-token-first
    # send path and best-effort semantics as trade notifications.
    try:
        await trade_executor._notify(_scan_summary_message(summary))
    except Exception:  # noqa: BLE001 - a heartbeat must never fail the scan job
        log.exception("scan heartbeat notification failed")


async def scheduled_monitor() -> None:
    """Cron entry point: one Position Monitor sweep every 15 minutes."""
    try:
        async with PositionMonitor() as monitor:
            result = await monitor.check_positions()
    except Exception:  # noqa: BLE001 - check_positions should never raise; belt+braces
        log.exception("scheduled monitor sweep failed")
        return

    # check_positions() NEVER raises: a DB failure inside it returns a result
    # carrying errors=1 rather than propagating. Emitting success on return
    # alone would therefore report a failed sweep as healthy, which is the
    # started-only false-green wearing a different hat. Stay silent on an
    # errored sweep and let the Alerter notice the gap.
    if result.errors:
        log.warning(
            "monitor sweep completed with %s error(s); heartbeat withheld",
            result.errors,
        )
        return
    await record_success_heartbeat(
        HEARTBEAT_MONITOR, {"positions_checked": result.positions_checked}
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _poller_task

    log.info("trade-engine %s starting on %s:%s", config.version,
             config.trade_engine_host, config.trade_engine_port)
    register_jobs(scheduled_scan, scheduled_monitor)
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
    monitor_state = last_monitor_state()
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
                scheduler_jobs=job_count(),
                last_scan_at=scan_state["at"],
                last_scan_high_edge_count=scan_state["high_edge_count"],
                last_monitor_at=monitor_state["at"],
                monitor_positions_resolved=monitor_state["resolved_total"],
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
            scheduler_jobs=job_count(),
            last_scan_at=scan_state["at"],
            last_scan_high_edge_count=scan_state["high_edge_count"],
            last_monitor_at=monitor_state["at"],
            monitor_positions_resolved=monitor_state["resolved_total"],
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


@app.get("/positions")
async def positions() -> JSONResponse:
    """Open positions, newest first. No auth — loopback-bound, internal only.

    Engine-native replacement for the old dashboard's GET
    /api/trading/positions, so the Charlie trading-api skill reads from the
    same service that writes.
    """
    try:
        rows = await get_open_positions()
        alerts = await get_unresolved_alerts()
    except SupabaseError as exc:
        log.error("/positions failed: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"error": "could not read positions", "detail": str(exc)},
        )

    # Embed live alerts on their position rather than making every caller do a
    # second round-trip and a join. The dashboard renders straight off this.
    by_position: dict[str, list] = {}
    for a in alerts:
        by_position.setdefault(str(a.get("position_id")), []).append(a)

    enriched = []
    for row in rows:
        item = row.model_dump() if hasattr(row, "model_dump") else dict(row)
        live = by_position.get(str(item.get("id")), [])
        item["alerts"] = live
        item["has_alert"] = bool(live)
        # Most severe live alert, for a single badge in a table cell.
        # stop_loss outranks take_profit outranks weakening.
        rank = {"stop_loss": 3, "take_profit": 2, "weakening": 1}
        item["top_alert"] = (
            max(live, key=lambda a: rank.get(a.get("alert_type"), 0)).get("alert_type")
            if live else None
        )
        enriched.append(item)

    return JSONResponse(
        content=jsonable_encoder({
            "count": len(enriched),
            "positions": enriched,
            "unresolved_alert_count": len(alerts),
        })
    )


@app.get("/simulations")
async def simulations() -> JSONResponse:
    """Last 10 simulations, newest first. No auth — loopback-bound, internal
    only.

    raw_output is included on purpose: its `question` and
    `polymarket_condition_id` are how a market named in chat gets mapped to
    the condition_id that POST /positions/manual needs.
    """
    try:
        rows = await get_recent_simulations()
    except SupabaseError as exc:
        log.error("/simulations failed: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"error": "could not read simulations", "detail": str(exc)},
        )
    return JSONResponse(
        content=jsonable_encoder({"count": len(rows), "simulations": rows})
    )


@app.post("/positions/manual")
async def positions_manual(request: Request) -> JSONResponse:
    """Log a trade that was already executed by hand in the Polymarket UI.

    Records only — nothing here places, sizes or closes an order, so there
    are no financial gates to run. tx_hash is written as NULL, the durable
    marker distinguishing manual entries from executor ones.

    Validation failures are 400 with an operator-readable message (not
    FastAPI's default 422 — the caller is Charlie relaying a chat message,
    and the error text is what gets said back to Tyson). No auth —
    loopback-bound, internal only.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - malformed body is a caller error
        return JSONResponse(
            status_code=400, content={"error": "body must be valid JSON"}
        )
    try:
        req = ManualPositionRequest.model_validate(body)
    except ValidationError as exc:
        detail = "; ".join(
            f"{'.'.join(str(loc) for loc in err['loc'])}: {err['msg']}"
            for err in exc.errors()
        )
        return JSONResponse(status_code=400, content={"error": detail})

    try:
        result = await log_manual_position(req)
    except ManualPositionError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    except SupabaseError as exc:
        log.error("/positions/manual write failed: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"error": "could not write position", "detail": str(exc)},
        )
    return JSONResponse(content=jsonable_encoder(result))


@app.get("/positions/alerts")
async def positions_alerts() -> JSONResponse:
    """Live (unresolved) threshold alerts, newest first.

    An alert means the monitor saw a take-profit / stop-loss / weakening
    threshold cross. It does NOT mean anything was closed: Polymarket exits are
    manual while the signer/maker-address issue is open. This is the endpoint
    Charlie reads to answer "does anything need my attention", which he
    previously could not do at all because alerts only existed as Telegram
    messages on a bot he cannot see.
    """
    try:
        rows = await get_unresolved_alerts()
    except SupabaseError as exc:
        log.error("/positions/alerts failed: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"error": "could not read alerts", "detail": str(exc)},
        )
    return JSONResponse(content=jsonable_encoder({
        "count": len(rows),
        "alerts": rows,
        "note": (
            "An alert is a threshold crossing, not a close. Positions stay open "
            "until a real close is logged via POST /positions/manual-close."
        ),
    }))


@app.get("/positions/{position_id}/alerts")
async def position_alert_history(position_id: str) -> JSONResponse:
    """Full alert history for one position, resolved ones included."""
    try:
        rows = await get_alerts_for_position(position_id)
    except SupabaseError as exc:
        log.error("/positions/%s/alerts failed: %s", position_id, exc)
        return JSONResponse(
            status_code=503,
            content={"error": "could not read alerts", "detail": str(exc)},
        )
    return JSONResponse(content=jsonable_encoder({
        "position_id": position_id,
        "count": len(rows),
        "alerts": rows,
        "unresolved": [r for r in rows if r.get("resolved_at") is None],
    }))


@app.post("/positions/{position_id}/hold")
async def position_hold(position_id: str, request: Request) -> JSONResponse:
    """Mark a position as manually managed (or clear the mark).

    While held, the monitor still prices the position every sweep — the
    dashboard and Analyst stay accurate — but emits no alerts for it. This is
    the "I am already dealing with it, stop telling me" control that did not
    exist on 2026-08-19 and would have prevented repeat alerting then.

    Holding does NOT close anything and does not touch any money column.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    try:
        req = HoldRequest.model_validate(body or {})
    except ValidationError as exc:
        detail = "; ".join(
            f"{'.'.join(str(loc) for loc in err['loc'])}: {err['msg']}"
            for err in exc.errors()
        )
        return JSONResponse(status_code=400, content={"error": detail})

    try:
        row = await set_manual_hold(position_id, req.hold)
    except SupabaseError as exc:
        log.error("/positions/%s/hold failed: %s", position_id, exc)
        return JSONResponse(
            status_code=503,
            content={"error": "could not set manual_hold", "detail": str(exc)},
        )
    log.info("position %s manual_hold set to %s", position_id, req.hold)
    return JSONResponse(content=jsonable_encoder({
        "position_id": position_id,
        "manual_hold": req.hold,
        "position": row,
        "note": (
            "Alerts suppressed; price tracking continues."
            if req.hold else "Alerting resumed."
        ),
    }))


@app.post("/positions/manual-close")
async def positions_manual_close(request: Request) -> JSONResponse:
    """Log a position that was closed BY HAND in the Polymarket UI.

    This is the only path permitted to write exit_price / exit_usdc / pnl /
    status onto trading_positions. The monitor cannot, because it never sells;
    writing a close it had not performed is exactly the 2026-08-19 defect.

    Any live alerts on the position are resolved here and returned, so the
    caller can cross-reference ("this close answers the stop-loss alert from
    15:39") instead of accepting an unverified assertion.

    exit_usdc: supply the real proceeds. If omitted it is derived as
    shares * exit_price and flagged `exit_usdc_estimated: true` — an
    approximation labelled as one, never presented as the settled figure.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(
            status_code=400, content={"error": "body must be valid JSON"}
        )
    try:
        req = ManualCloseRequest.model_validate(body)
    except ValidationError as exc:
        detail = "; ".join(
            f"{'.'.join(str(loc) for loc in err['loc'])}: {err['msg']}"
            for err in exc.errors()
        )
        return JSONResponse(status_code=400, content={"error": detail})

    if not (0.0 <= req.exit_price <= 1.0):
        return JSONResponse(
            status_code=400,
            content={"error": f"exit_price must be between 0 and 1, got {req.exit_price}"},
        )

    # Read the position first: refuse to close what is not open, and derive
    # exit_usdc from its shares when the caller did not supply proceeds.
    try:
        open_rows = await get_open_positions()
    except SupabaseError as exc:
        return JSONResponse(
            status_code=503,
            content={"error": "could not read positions", "detail": str(exc)},
        )
    match = next((p for p in open_rows if str(p.id) == req.position_id), None)
    if match is None:
        # Fail closed: an id that is not currently open is either already
        # closed or wrong, and guessing which would risk a double-write.
        return JSONResponse(status_code=404, content={
            "error": f"no OPEN position with id {req.position_id}",
            "hint": "check GET /positions; an already-closed position cannot be re-closed here",
        })

    exit_usdc = req.exit_usdc
    estimated = False
    if exit_usdc is None:
        if match.shares is None:
            return JSONResponse(status_code=400, content={
                "error": "exit_usdc omitted and position has no shares to derive it from",
                "hint": "supply exit_usdc (the USDC actually received)",
            })
        exit_usdc = round(float(match.shares) * req.exit_price, 6)
        estimated = True

    pnl = (
        round(exit_usdc - float(match.usdc_amount), 6)
        if match.usdc_amount is not None else None
    )

    updates = {
        "status": "closed",
        "exit_price": req.exit_price,
        "exit_usdc": exit_usdc,
        "pnl": pnl,
        "exit_reason": req.exit_reason or "manual_close",
        "closed_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        row = await update_position(req.position_id, updates)
    except SupabaseError as exc:
        log.error("/positions/manual-close write failed: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"error": "could not write close", "detail": str(exc)},
        )

    # Resolve alerts AFTER the close is durable: an alert cleared against a
    # close that failed to write would hide a still-live threshold crossing.
    note = req.note or f"closed manually at {req.exit_price}"
    try:
        resolved = await resolve_alerts_for_position(req.position_id, note)
    except SupabaseError as exc:
        log.warning(
            "close recorded for %s but alert resolution failed: %s",
            req.position_id, exc,
        )
        resolved = []

    log.info(
        "manual close recorded for %s: exit %.4f pnl %s (resolved %d alert(s))",
        req.position_id, req.exit_price, pnl, len(resolved),
    )
    return JSONResponse(content=jsonable_encoder({
        "success": True,
        "position": row,
        "exit_usdc_estimated": estimated,
        "resolved_alerts": resolved,
        "preceded_by_alert": [
            {
                "alert_type": a.get("alert_type"),
                "triggered_at": a.get("triggered_at"),
                "trigger_price": a.get("trigger_price"),
            }
            for a in resolved
        ],
    }))


@app.post("/simulate")
async def simulate(request: Request) -> JSONResponse:
    """Proxy one Monte Carlo run to the worker on MONTE_CARLO_HOST.

    Compute-only — the worker prices a hypothetical, nothing is written or
    traded. Exists so the Charlie skill keeps its single 4003 base URL after
    moving off the old dashboard, which used to proxy this same call. Body is
    forwarded as-is ({asset, target, horizon_days, question}); the worker's
    response and status come back as-is.
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - malformed body is a caller error
        return JSONResponse(
            status_code=400, content={"error": "body must be valid JSON"}
        )
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=10.0)
        ) as client:
            response = await client.post(
                f"{config.monte_carlo_host}/simulate", json=body
            )
    except httpx.HTTPError as exc:
        log.error("/simulate proxy failed: %s", type(exc).__name__)
        return JSONResponse(
            status_code=502,
            content={
                "error": "monte carlo worker unreachable",
                "detail": type(exc).__name__,
            },
        )
    try:
        payload = response.json()
    except ValueError:
        return JSONResponse(
            status_code=502,
            content={"error": "monte carlo worker returned non-JSON"},
        )
    return JSONResponse(status_code=response.status_code, content=payload)


@app.post("/scan", response_model=ScannerRunSummary)
async def scan() -> JSONResponse:
    """Run the scanner once, on demand.

    Drives the SAME scanner.run() pipeline the cron jobs call — Session 6
    collapsed the stage-by-stage duplication this route used to carry, so
    simulation persistence and simulation_id attachment cannot diverge between
    the manual and scheduled paths again. No auth — loopback-bound, internal
    only.

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
            summary = await scanner.run(open_positions=open_count)
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


@app.api_route("/monitor/run", methods=["GET", "POST"], response_model=MonitorRunResult)
async def monitor_run() -> JSONResponse:
    """Run the Position Monitor once, on demand.

    Same sweep the 15-minute cron performs. No auth — loopback-bound, internal
    only. GET and POST both accepted: the sweep is idempotent-ish (closing an
    already-closed position is a no-op because the fetch only returns
    status=open rows), so a curl without -X POST should not 405.
    """
    async with PositionMonitor() as monitor:
        result = await monitor.check_positions()
    return JSONResponse(content=jsonable_encoder(result))


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
