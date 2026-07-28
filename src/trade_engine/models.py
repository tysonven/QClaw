#!/usr/bin/env python3
"""Pydantic models mirroring the live Supabase schema.

Column names, types and nullability were read from the PostgREST OpenAPI
document on 2026-07-28 (both trading_positions and trading_markets are
currently empty, so a sample row was not available). Fields are Optional
wherever the column is nullable — that is most of them, since these tables
were created without NOT NULL on the value columns.

`extra="allow"` is deliberate: if a column is added to Supabase before this
model is updated, we surface the new field rather than silently dropping it.
"""

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict


class TradingConfig(BaseModel):
    """public.trading_config — single row, id=1. NOT a key/value store."""

    model_config = ConfigDict(extra="allow")

    id: int
    trading_enabled: Optional[bool] = None
    max_position_usdc: Optional[float] = None
    min_edge_threshold: Optional[float] = None
    daily_loss_limit: Optional[float] = None


class TradePosition(BaseModel):
    """public.trading_positions.

    `status` has no CHECK constraint in Postgres; 'open' is the column default
    and 'closed' is what the n8n Position Monitor writes on exit. Treat those
    two as the convention, not as an enforced enum.
    """

    model_config = ConfigDict(extra="allow")

    id: str
    market_id: Optional[str] = None
    simulation_id: Optional[str] = None
    direction: str
    entry_price: Optional[float] = None
    shares: Optional[float] = None
    usdc_amount: Optional[float] = None
    entry_simulation_probability: Optional[float] = None
    entry_implied_odds: Optional[float] = None
    entry_edge: Optional[float] = None
    status: Optional[str] = None
    exit_price: Optional[float] = None
    exit_usdc: Optional[float] = None
    pnl: Optional[float] = None
    exit_reason: Optional[str] = None
    opened_at: Optional[datetime] = None
    closed_at: Optional[datetime] = None
    tx_hash: Optional[str] = None
    created_at: Optional[datetime] = None


class SimulationResult(BaseModel):
    """public.trading_simulations — persisted Monte Carlo output.

    Unused in Session 1; the Scanner (Session 2) writes these. Kept aligned
    with the table rather than with the Monte Carlo worker's HTTP response,
    which is a wider shape (see MonteCarloResponse).
    """

    model_config = ConfigDict(extra="allow")

    id: Optional[str] = None
    market_id: Optional[str] = None
    asset: Optional[str] = None
    simulation_count: Optional[int] = None
    probability: Optional[float] = None
    confidence_lower: Optional[float] = None
    confidence_upper: Optional[float] = None
    implied_odds: Optional[float] = None
    edge: Optional[float] = None
    macro_factors: Optional[dict[str, Any]] = None
    raw_output: Optional[dict[str, Any]] = None
    current_price: Optional[float] = None
    created_at: Optional[datetime] = None


class MonteCarloResponse(BaseModel):
    """POST /simulate response from src/trading/monte_carlo.py (port 4001).

    Not a table. Session 2 posts to the worker and maps this onto
    SimulationResult before persisting.
    """

    model_config = ConfigDict(extra="allow")

    probability: float
    confidence_lower: float
    confidence_upper: float
    current_price: float
    target: float
    asset: str
    horizon_days: int
    market_type: str
    question: Optional[str] = None
    simulations: Optional[int] = None
    daily_mu: Optional[float] = None
    daily_sigma: Optional[float] = None
    macro_adjustment: Optional[float] = None
    macro_factors: Optional[dict[str, Any]] = None


class ScannerCandidate(BaseModel):
    """One market that survived filtering and simulation.

    `edge` is a raw fraction (0.07 == 7 percentage points), NOT the *100 form
    the n8n Build Run Summary node writes into its summary rows. Position
    sizing depends on this unit.
    """

    model_config = ConfigDict(extra="allow")

    market_id: str
    question: str
    asset: str
    direction: str  # 'YES' or 'NO'
    edge: float
    sim_probability: float
    market_probability: float
    volume: float
    horizon_days: int
    market_url: str
    amount_usdc: float


class AnalystRecommendation(BaseModel):
    """Structured verdict on one proposed trade.

    `raw_response` is retained for debugging but is stripped before the object
    reaches an API response — see main.py, which serialises with
    exclude={"raw_response"}.
    """

    model_config = ConfigDict(extra="allow")

    recommendation: Literal["proceed", "pass", "reduce"]
    confidence: float  # 0.0-1.0, clamped on parse
    reasoning: str  # 2-3 sentences
    flags: list[str] = []
    insufficient_history: bool = False  # true when < 10 resolved trades
    raw_response: str = ""


class ScannerRunSummary(BaseModel):
    """Result of one scanner pass."""

    model_config = ConfigDict(extra="allow")

    run_at: datetime
    markets_fetched: int
    candidates_analysed: int
    simulations_run: int
    sim_errors: int
    high_edge: list[ScannerCandidate] = []
    no_edge: list[ScannerCandidate] = []
    neutral_count: int = 0
    best_trade: Optional[ScannerCandidate] = None
    open_positions: int = 0
    analyst_recommendation: Optional[AnalystRecommendation] = None
    analyst_skip: bool = False  # true when the Analyst returned 'pass'


class HealthResponse(BaseModel):
    status: str
    version: str
    trading_enabled: Optional[bool] = None
    open_positions: Optional[int] = None
    scheduler_running: bool
    last_scan_at: Optional[datetime] = None
    last_scan_high_edge_count: Optional[int] = None
    analyst_available: bool = False
    error: Optional[str] = None
