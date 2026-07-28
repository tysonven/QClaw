#!/usr/bin/env python3
"""Trade Analyst — reviews a proposed trade against historical performance.

Runs after the scanner's best_trade selector and before the approval gate
(Session 4). Advisory only: nothing here places, sizes, or blocks a live trade.
A 'reduce' recommendation adjusts the *proposed* size on the summary object;
it never touches an open position.

Model: claude-sonnet-4-6 with structured outputs. Two live findings drove that
choice, both verified against the API on 2026-07-28 rather than taken on faith:

1. Asked for "JSON only", Sonnet 4.6 wraps its answer in a markdown fence
   (```json ... ```). A naive json.loads() would fail on every call and the
   Analyst would silently return 'pass' 100% of the time while looking healthy.
   `output_config.format` makes schema-valid JSON a server-side guarantee.
2. `temperature` is accepted on Sonnet 4.6 but returns 400 on Sonnet 5
   ("`temperature` is deprecated for this model"). Staying on 4.6 keeps it.

The parse-error path below therefore should never fire in production. It is
kept as a genuine safety net, and is exercised by the tests via a mocked
malformed response.

This module never raises. Every failure path returns a 'pass' recommendation,
because the safe default for an advisory layer on a live financial path is to
decline rather than to wave a trade through.
"""

from __future__ import annotations

import json
import logging
import time
from statistics import mean
from typing import Any, Optional

import anthropic

from src.trade_engine.config import config
from src.trade_engine.database import (
    SupabaseError,
    get_resolved_positions,
    get_simulations_by_ids,
)
from src.trade_engine.models import AnalystRecommendation, ScannerCandidate, TradePosition

log = logging.getLogger("trade_engine.analyst")

ANALYST_MODEL = "claude-sonnet-4-6"
ANALYST_MAX_TOKENS = 300      # reasoning is 2-3 sentences; no thinking on 4.6
ANALYST_TEMPERATURE = 0.2     # consistent, not creative
ANALYST_TIMEOUT_SECONDS = 30.0

# Below this many resolved trades, historical stats are noise rather than signal.
MIN_HISTORY_TRADES = 10
HISTORY_LIMIT = 20
RECENT_TRADES_SHOWN = 5

VALID_FLAGS = [
    "thin_volume",
    "high_confidence_sim",
    "low_confidence_sim",
    "similar_past_loss",
    "similar_past_win",
    "short_horizon_risk",
    "insufficient_history",
    "strong_edge",
    "marginal_edge",
]

SYSTEM_PROMPT = (
    "You are a quantitative trading analyst for a Polymarket prediction market "
    "trading system. You review proposed trades and provide structured "
    "recommendations based on historical performance and market conditions. "
    "Be concise and direct. Always respond with valid JSON only."
)

# Numeric bounds (minimum/maximum) and string lengths are NOT supported by
# structured-output schemas, so `confidence` is clamped client-side instead.
ANALYST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "recommendation": {
            "type": "string",
            "enum": ["proceed", "pass", "reduce"],
        },
        "confidence": {"type": "number"},
        "reasoning": {"type": "string"},
        "flags": {"type": "array", "items": {"type": "string", "enum": VALID_FLAGS}},
    },
    "required": ["recommendation", "confidence", "reasoning", "flags"],
    "additionalProperties": False,
}


class TradeAnalyst:
    """Claude-backed review of a single proposed trade."""

    def __init__(self, client: Optional[anthropic.AsyncAnthropic] = None) -> None:
        # Injectable so tests can supply a stub without touching the network.
        self._client = client or anthropic.AsyncAnthropic(
            api_key=config.anthropic_api_key, timeout=ANALYST_TIMEOUT_SECONDS
        )

    # --- history ----------------------------------------------------------

    async def get_trade_history_context(self, limit: int = HISTORY_LIMIT) -> dict[str, Any]:
        """Resolved-trade stats for the prompt.

        `asset` and the market question live on trading_simulations, not on
        trading_positions — the position row carries only simulation_id. We
        resolve them in one batched lookup and degrade to None when a position
        has no linked simulation or the lookup fails. Nothing is invented: a
        trade with no resolvable asset is simply excluded from the per-asset
        tallies rather than being bucketed under a guess.
        """
        try:
            positions = await get_resolved_positions(limit=limit)
        except SupabaseError as exc:
            log.error("could not read trade history: %s", exc)
            positions = []

        total = len(positions)
        context: dict[str, Any] = {
            "total_trades": total,
            "insufficient_history": total < MIN_HISTORY_TRADES,
            "win_rate": 0.0,
            "avg_edge_winners": 0.0,
            "avg_edge_losers": 0.0,
            "avg_pnl": 0.0,
            "best_asset": None,
            "worst_asset": None,
            "trades": [],
        }
        if not positions:
            return context

        assets = await self._resolve_assets(positions)

        winners = [p for p in positions if (p.pnl or 0) > 0]
        losers = [p for p in positions if (p.pnl or 0) <= 0]
        winner_edges = [p.entry_edge for p in winners if p.entry_edge is not None]
        loser_edges = [p.entry_edge for p in losers if p.entry_edge is not None]
        pnls = [p.pnl for p in positions if p.pnl is not None]

        context["win_rate"] = len(winners) / total
        context["avg_edge_winners"] = mean(winner_edges) if winner_edges else 0.0
        context["avg_edge_losers"] = mean(loser_edges) if loser_edges else 0.0
        context["avg_pnl"] = mean(pnls) if pnls else 0.0

        wins_by_asset: dict[str, int] = {}
        losses_by_asset: dict[str, int] = {}
        for position in positions:
            asset = assets.get(position.id, {}).get("asset")
            if not asset:
                continue
            bucket = wins_by_asset if (position.pnl or 0) > 0 else losses_by_asset
            bucket[asset] = bucket.get(asset, 0) + 1
        context["best_asset"] = max(wins_by_asset, key=wins_by_asset.get) if wins_by_asset else None
        context["worst_asset"] = (
            max(losses_by_asset, key=losses_by_asset.get) if losses_by_asset else None
        )

        context["trades"] = [
            {
                "question": assets.get(p.id, {}).get("question"),
                "asset": assets.get(p.id, {}).get("asset"),
                "direction": p.direction,
                "edge": p.entry_edge,
                "pnl": p.pnl,
                "outcome": "win" if (p.pnl or 0) > 0 else "loss",
            }
            for p in positions[:RECENT_TRADES_SHOWN]
        ]
        return context

    @staticmethod
    async def _resolve_assets(
        positions: list[TradePosition],
    ) -> dict[str, dict[str, Any]]:
        """Map position id -> {asset, question} via the linked simulation row."""
        sim_ids = [p.simulation_id for p in positions if p.simulation_id]
        if not sim_ids:
            return {}
        try:
            sims = await get_simulations_by_ids(sim_ids)
        except SupabaseError as exc:
            log.warning("could not resolve assets for trade history: %s", exc)
            return {}

        by_sim = {
            s.get("id"): {
                "asset": s.get("asset"),
                # question lives in raw_output; absent on older rows.
                "question": (s.get("raw_output") or {}).get("question"),
            }
            for s in sims
        }
        return {p.id: by_sim.get(p.simulation_id, {}) for p in positions if p.simulation_id}

    # --- prompt -----------------------------------------------------------

    @staticmethod
    def build_prompt(candidate: ScannerCandidate, history: dict[str, Any]) -> str:
        lines = [
            "PROPOSED TRADE:",
            f"Market: {candidate.question}",
            f"Asset: {candidate.asset}",
            f"Direction: BUY {candidate.direction}",
            f"Edge: {candidate.edge:.1%} (Sim: {candidate.sim_probability:.1%} vs "
            f"Market: {candidate.market_probability:.1%})",
            f"Volume: ${candidate.volume:,.0f}",
            f"Horizon: {candidate.horizon_days} days",
            f"Proposed position: ${candidate.amount_usdc:.2f}",
            "",
            f"TRADE HISTORY ({history['total_trades']} resolved trades):",
        ]
        if history["insufficient_history"]:
            lines.append(
                f"WARNING: only {history['total_trades']} resolved trades — fewer than "
                f"{MIN_HISTORY_TRADES}. Historical statistics below are not yet a "
                "reliable signal; weight them accordingly and say so in your reasoning."
            )
        lines += [
            f"Win rate: {history['win_rate']:.1%}",
            f"Avg edge of winners: {history['avg_edge_winners']:.1%}",
            f"Avg edge of losers: {history['avg_edge_losers']:.1%}",
            f"Avg PnL per trade: ${history['avg_pnl']:.2f}",
            f"Best performing asset: {history['best_asset'] or 'unknown'}",
            f"Worst performing asset: {history['worst_asset'] or 'unknown'}",
            "",
            f"Recent trades (last {RECENT_TRADES_SHOWN}):",
        ]
        if history["trades"]:
            for trade in history["trades"]:
                # Market description is only shown when it actually exists on the
                # linked simulation row — never reconstructed.
                label = trade["question"] or trade["asset"] or "(market not recorded)"
                edge = f"{trade['edge']:.1%}" if trade["edge"] is not None else "unknown edge"
                pnl = f"${trade['pnl']:.2f}" if trade["pnl"] is not None else "unknown pnl"
                lines.append(f"- {label} | {trade['direction']} | {edge} | {pnl} | {trade['outcome']}")
        else:
            lines.append("- none")

        lines += [
            "",
            "INSTRUCTIONS:",
            "Respond with JSON only, no other text:",
            '{"recommendation": "proceed|pass|reduce", "confidence": 0.0-1.0, '
            '"reasoning": "2-3 sentences explaining your recommendation", '
            '"flags": ["flag1", "flag2"]}',
            "",
            "Valid flags: " + ", ".join(VALID_FLAGS),
        ]
        return "\n".join(lines)

    # --- analyse ----------------------------------------------------------

    async def analyse(self, candidate: ScannerCandidate) -> AnalystRecommendation:
        """Review one candidate. Never raises — every failure returns 'pass'."""
        history = await self.get_trade_history_context()
        prompt = self.build_prompt(candidate, history)
        insufficient = bool(history["insufficient_history"])

        started = time.monotonic()
        try:
            response = await self._client.messages.create(
                model=ANALYST_MODEL,
                max_tokens=ANALYST_MAX_TOKENS,
                temperature=ANALYST_TEMPERATURE,
                system=SYSTEM_PROMPT,
                output_config={"format": {"type": "json_schema", "schema": ANALYST_SCHEMA}},
                messages=[{"role": "user", "content": prompt}],
            )
        except Exception as exc:  # noqa: BLE001 - advisory layer must never break the scan
            elapsed = time.monotonic() - started
            log.error(
                "analyst API error after %.2fs (%s): %s",
                elapsed, type(exc).__name__, exc,
            )
            return self._fallback(
                "analyst_api_error",
                f"Analyst unavailable ({type(exc).__name__}); defaulting to pass.",
                raw="",
                insufficient_history=insufficient,
            )

        elapsed = time.monotonic() - started
        raw = "".join(b.text for b in response.content if getattr(b, "type", None) == "text")
        usage = response.usage
        log.info(
            "analyst call: %.2fs, model=%s, in=%d out=%d tokens",
            elapsed, ANALYST_MODEL, usage.input_tokens, usage.output_tokens,
        )
        log.debug("analyst raw response: %s", raw)

        try:
            parsed = json.loads(raw)
            recommendation = parsed["recommendation"]
            if recommendation not in ("proceed", "pass", "reduce"):
                raise ValueError(f"unexpected recommendation {recommendation!r}")
            confidence = max(0.0, min(1.0, float(parsed["confidence"])))
            reasoning = str(parsed["reasoning"])
            flags = [str(f) for f in parsed.get("flags") or []]
        except Exception as exc:  # noqa: BLE001
            log.error("analyst response did not parse (%s): %r", exc, raw[:500])
            return self._fallback(
                "analyst_parse_error",
                "Analyst response could not be parsed; defaulting to pass.",
                raw=raw,
                insufficient_history=insufficient,
            )

        if insufficient and "insufficient_history" not in flags:
            flags.append("insufficient_history")

        return AnalystRecommendation(
            recommendation=recommendation,
            confidence=confidence,
            reasoning=reasoning,
            flags=flags,
            insufficient_history=insufficient,
            raw_response=raw,
        )

    @staticmethod
    def _fallback(
        flag: str, reasoning: str, *, raw: str, insufficient_history: bool
    ) -> AnalystRecommendation:
        flags = [flag]
        if insufficient_history:
            flags.append("insufficient_history")
        return AnalystRecommendation(
            recommendation="pass",
            confidence=0.0,
            reasoning=reasoning,
            flags=flags,
            insufficient_history=insufficient_history,
            raw_response=raw,
        )
