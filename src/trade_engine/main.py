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
from fastapi.responses import JSONResponse  # noqa: E402

from src.trade_engine.config import config, configure_logging  # noqa: E402
from src.trade_engine.database import (  # noqa: E402
    SupabaseError,
    close_client,
    count_open_positions,
    get_trading_config,
)
from src.trade_engine.models import HealthResponse, TradingConfig  # noqa: E402
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
    try:
        cfg = await get_trading_config()
        open_count = await count_open_positions()
    except SupabaseError as exc:
        log.error("health check failed: %s", exc)
        return JSONResponse(
            status_code=503,
            content=HealthResponse(
                status="degraded",
                version=config.version,
                scheduler_running=is_running(),
                error=str(exc),
            ).model_dump(),
        )

    return JSONResponse(
        content=HealthResponse(
            status="ok",
            version=config.version,
            trading_enabled=cfg.trading_enabled,
            open_positions=open_count,
            scheduler_running=is_running(),
        ).model_dump()
    )


@app.get("/config", response_model=TradingConfig)
async def read_config() -> TradingConfig:
    """Current trading_config. No auth — loopback-bound, internal only."""
    return await get_trading_config()


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=config.trade_engine_host,
        port=config.trade_engine_port,
        log_level=config.log_level.lower(),
    )
