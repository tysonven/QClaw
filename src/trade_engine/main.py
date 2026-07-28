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

import logging  # noqa: E402
from contextlib import asynccontextmanager  # noqa: E402

import uvicorn  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.encoders import jsonable_encoder  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

from src.trade_engine.config import config, configure_logging  # noqa: E402
from src.trade_engine.database import (  # noqa: E402
    SupabaseError,
    close_client,
    count_open_positions,
    get_trading_config,
    write_simulation,
)
from src.trade_engine.models import (  # noqa: E402
    HealthResponse,
    ScannerRunSummary,
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("trade-engine %s starting on %s:%s", config.version,
             config.trade_engine_host, config.trade_engine_port)
    start_scheduler()
    try:
        yield
    finally:
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
        ))
    )


@app.get("/config", response_model=TradingConfig)
async def read_config() -> TradingConfig:
    """Current trading_config. No auth — loopback-bound, internal only."""
    return await get_trading_config()


@app.post("/scan", response_model=ScannerRunSummary)
async def scan() -> JSONResponse:
    """Run the scanner once, on demand.

    No cron is registered yet (Session 4 wires the schedule), so this is the
    only trigger. No auth — loopback-bound, internal only. Nothing here places
    a trade: best_trade is a suggestion, and execution lands in Session 5.

    A full pass makes up to 30 sequential /simulate calls at ~0.5s apart plus
    yfinance latency, so this can take a couple of minutes.
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
        async with PolymarketScanner() as scanner:
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
            record_run(summary)
    except Exception as exc:  # noqa: BLE001 - surface a clean message, not a stack
        log.exception("scan failed")
        return JSONResponse(
            status_code=500,
            content={"error": "scan failed", "detail": f"{type(exc).__name__}: {exc}"},
        )

    # Persist every simulation, not just the high-edge ones — the neutral and
    # no-edge rows are what make calibration analysis possible later.
    written, write_errors = 0, 0
    for row in simulation_rows(simulated):
        try:
            await write_simulation(row)
            written += 1
        except (SupabaseError, ValueError) as exc:
            write_errors += 1
            log.error("failed to persist simulation for %s: %s", row.get("asset"), exc)
    log.info("persisted %d/%d simulations (%d failed)",
             written, len(simulated), write_errors)

    return JSONResponse(content=jsonable_encoder(summary))


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=config.trade_engine_host,
        port=config.trade_engine_port,
        log_level=config.log_level.lower(),
    )
