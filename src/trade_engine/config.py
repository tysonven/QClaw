#!/usr/bin/env python3
"""Environment loading and validation for the trade engine.

Secrets live in /root/.quantumclaw/.env. PM2's `env_file` option does NOT
inject that file into child processes on this host (verified empirically
against PM2 6.0.14 — a probe process saw neither SUPABASE_URL nor
ANTHROPIC_API_KEY, and the live `trading-worker` process environment
contains no QClaw secrets either). So we load it here with python-dotenv,
matching the pattern src/trading/execute_trade.py already uses.

`override=False` means anything already exported into the real process
environment wins over the file — so PM2 `env:` blocks, systemd, or a shell
export can still take precedence for local overrides.

Validation is fail-fast: a missing required key raises at import time, which
surfaces as an immediate PM2 crash rather than a service that runs and then
400s on its first Supabase call.
"""

import logging
import os
import re
from pathlib import Path

from dotenv import load_dotenv

ENV_PATH = Path("/root/.quantumclaw/.env")

# Required — no defaults, no fallbacks. Absence is a startup failure.
REQUIRED_KEYS = (
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ANTHROPIC_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "OWNER_TELEGRAM_CHAT_ID",
    "POLYMARKET_PRIVATE_KEY",
    "POLYMARKET_FUNDER_ADDRESS",
)

# Optional — safe defaults. See DEFAULTS notes in the PR for why 4003.
DEFAULT_TRADE_ENGINE_HOST = "127.0.0.1"
DEFAULT_TRADE_ENGINE_PORT = 4003
DEFAULT_MONTE_CARLO_HOST = "http://localhost:4001"
DEFAULT_LOG_LEVEL = "INFO"

# Approval gate. 30 minutes matches the briefed window; overridable by env so
# the timeout path can be exercised in under a minute without a code change.
DEFAULT_APPROVAL_TIMEOUT_SECONDS = 1800
DEFAULT_APPROVAL_POLL_INTERVAL_SECONDS = 5.0

# Scanner thresholds. Defaults mirror the live n8n Build Run Summary node
# (3YahxqOguET3pifj) as calibrated in Brief B on 2026-07-23 — NO_EDGE was
# widened from -0.10 to -0.20 there. Overridable by env so the Python scanner
# can be retuned without a deploy while it runs alongside n8n.
DEFAULT_HIGH_EDGE_THRESHOLD = 0.07
DEFAULT_NO_EDGE_THRESHOLD = -0.20
DEFAULT_MIN_ALERT_VOLUME = 5000.0

# Hard refusal floor on how short a market may be to be proposed OR placed.
# THIS is the control that protects the money path from short-dated markets, 
# not monte_carlo.MIN_HORIZON_MODEL_DAYS, which is numerical safety only.
#
# The scanner's Monte Carlo estimates daily_sigma from 21 daily closes. Making
# the horizon arithmetic exact (2026-09-07) lets it price a 59-minute window
# correctly by its own lights, but a 21-day daily-close vol estimate is not
# calibrated for an intraday window at all, there is no intraday data behind
# it. Correct arithmetic on an uncalibrated model is still not a tradeable
# number, so anything under a day is refused outright rather than sized.
#
# Enforced in TWO independent places on purpose: PolymarketScanner.analyse_edge
# drops the market before it is ever simulated, and TradeExecutor GATE 7
# re-checks it against live state immediately before the order goes out. A
# control that exists in one layer only is not a control, the scanner
# proposes, the executor executes, and an approval can be up to 30 minutes
# stale by the time it is acted on.
DEFAULT_MIN_HORIZON_TRADEABLE_DAYS = 1.0

# --- position sizing (fractional Kelly, fee aware) --------------------------
#
# BANKROLL_USDC IS A MEASUREMENT, NOT A DIAL. 25 comes from $29.24 of real
# spendable collateral observed on the funder wallet, rounded down. Raising it
# sizes Kelly against money that does not exist, which is precisely what turns
# Kelly from conservative into dangerous.
#
# You will be tempted. At this bankroll the exchange's 5-share minimum is
# coarser than the entire Kelly budget, so almost nothing can be placed (see
# src/trade_engine/sizing.py for the arithmetic). The number that would make
# Kelly and the exchange compatible at mid prices is about $180. Getting there
# is a CAPITAL decision, a deposit of roughly $155, and it belongs to Tyson.
# It is not a config edit, and editing this constant to reach it would be the
# same act as deleting the guard.
DEFAULT_BANKROLL_USDC = 25.0

# Fraction of full Kelly. Full Kelly maximises long-run growth only if the
# probability estimate is right; ours was 7x wrong six weeks ago, so a tenth.
DEFAULT_KELLY_FRACTION = 0.10

# Sizing-only price floor, deliberately SEPARATE from scanner.YES_PRICE_MIN
# (0.01), which governs inclusion. Markets below this are still scanned,
# simulated, bucketed and reported; they are just never sized or proposed. That
# keeps "how much flow sits down there" answerable from data later.
DEFAULT_SIZING_PRICE_FLOOR = 0.10

VERSION = "0.1.0"


class ConfigError(RuntimeError):
    """Raised when required configuration is missing or malformed."""


class Config:
    """Validated runtime configuration. Instantiating validates."""

    def __init__(self) -> None:
        load_dotenv(ENV_PATH, override=False)

        missing = [k for k in REQUIRED_KEYS if not os.environ.get(k, "").strip()]
        if missing:
            raise ConfigError(
                "Missing required environment variable(s): "
                + ", ".join(missing)
                + f". Expected them in {ENV_PATH} or the process environment."
            )

        self.supabase_url: str = os.environ["SUPABASE_URL"].rstrip("/")
        self.supabase_service_role_key: str = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        self.anthropic_api_key: str = os.environ["ANTHROPIC_API_KEY"]
        self.telegram_bot_token: str = os.environ["TELEGRAM_BOT_TOKEN"]
        self.owner_telegram_chat_id: str = os.environ["OWNER_TELEGRAM_CHAT_ID"]

        # Optional and deliberately NOT in REQUIRED_KEYS: the engine must start
        # without it, just with no callback receiver. See telegram_poller_enabled
        # for why sharing TELEGRAM_BOT_TOKEN is not an option.
        self.trade_telegram_bot_token: str = os.environ.get(
            "TRADE_TELEGRAM_BOT_TOKEN", ""
        ).strip()
        self.polymarket_private_key: str = os.environ["POLYMARKET_PRIVATE_KEY"]
        self.polymarket_funder_address: str = os.environ["POLYMARKET_FUNDER_ADDRESS"]

        self.trade_engine_host: str = os.environ.get(
            "TRADE_ENGINE_HOST", DEFAULT_TRADE_ENGINE_HOST
        )
        self.trade_engine_port: int = self._int_env(
            "TRADE_ENGINE_PORT", DEFAULT_TRADE_ENGINE_PORT
        )
        self.monte_carlo_host: str = os.environ.get(
            "MONTE_CARLO_HOST", DEFAULT_MONTE_CARLO_HOST
        ).rstrip("/")
        self.log_level: str = os.environ.get("LOG_LEVEL", DEFAULT_LOG_LEVEL).upper()

        self.high_edge_threshold: float = self._float_env(
            "HIGH_EDGE_THRESHOLD", DEFAULT_HIGH_EDGE_THRESHOLD
        )
        self.no_edge_threshold: float = self._float_env(
            "NO_EDGE_THRESHOLD", DEFAULT_NO_EDGE_THRESHOLD
        )
        self.min_alert_volume: float = self._float_env(
            "MIN_ALERT_VOLUME", DEFAULT_MIN_ALERT_VOLUME
        )
        # CLAMPED, like min_horizon_tradeable_days below, and for the same
        # reason. The docstring on DEFAULT_BANKROLL_USDC says raising it is a
        # capital decision and "not a config edit", which was false while this
        # was a bare env read: BANKROLL_USDC=200 in /root/.quantumclaw/.env was
        # exactly a config edit, with no clamp, no ceiling and no log line. Two
        # paragraphs of prose were the only guard on the number this whole
        # sizing model rests on.
        #
        # Env may only make these MORE conservative. Bankroll may be lowered,
        # never raised; the Kelly fraction may be lowered, never raised. An
        # attempt to go the other way is clamped and logged rather than
        # silently accepted, because a silently ignored override is its own
        # failure mode.
        self.bankroll_usdc: float = self._clamped_env(
            "BANKROLL_USDC", DEFAULT_BANKROLL_USDC, direction="max"
        )
        self.kelly_fraction: float = self._clamped_env(
            "KELLY_FRACTION", DEFAULT_KELLY_FRACTION, direction="max"
        )
        # The price floor may only be RAISED: a higher floor proposes fewer,
        # more liquid markets, which is the conservative direction.
        self.sizing_price_floor: float = self._clamped_env(
            "SIZING_PRICE_FLOOR", DEFAULT_SIZING_PRICE_FLOOR, direction="min"
        )

        # Clamped at the floor, never below: an env typo (0, negative, or an
        # over-eager 0.5) must not be able to re-open the sub-day path that
        # cost position e09b82fe. Raising it is allowed, lowering it is not.
        self.min_horizon_tradeable_days: float = max(
            DEFAULT_MIN_HORIZON_TRADEABLE_DAYS,
            self._float_env(
                "MIN_HORIZON_TRADEABLE_DAYS", DEFAULT_MIN_HORIZON_TRADEABLE_DAYS
            ),
        )

        self.approval_timeout_seconds: int = self._int_env(
            "APPROVAL_TIMEOUT_SECONDS", DEFAULT_APPROVAL_TIMEOUT_SECONDS
        )
        self.approval_poll_interval_seconds: float = self._float_env(
            "APPROVAL_POLL_INTERVAL_SECONDS", DEFAULT_APPROVAL_POLL_INTERVAL_SECONDS
        )

        self.version: str = VERSION

    @staticmethod
    def _float_env(key: str, default: float) -> float:
        raw = os.environ.get(key)
        if raw is None or not raw.strip():
            return default
        try:
            return float(raw)
        except ValueError as exc:
            raise ConfigError(f"{key} must be a number, got {raw!r}") from exc

    def _clamped_env(self, key: str, default: float, *, direction: str) -> float:
        """Env override that may only move a value in the SAFE direction.

        direction="max": the default is a ceiling, env may only lower it.
        direction="min": the default is a floor, env may only raise it.

        A rejected override is LOGGED rather than silently ignored. Silently
        discarding an operator's setting is its own failure mode: the next
        person reads the .env, believes it, and reasons from a number that is
        not in force.
        """
        value = self._float_env(key, default)
        if direction == "max":
            clamped = min(default, value)
        else:
            clamped = max(default, value)
        if clamped != value:
            logging.getLogger("trade_engine.config").warning(
                "%s=%s ignored: clamped to %s. This value may only move in the "
                "conservative direction; changing it beyond that is a decision, "
                "not a config edit.", key, value, clamped,
            )
        return clamped

    @staticmethod
    def _int_env(key: str, default: int) -> int:
        raw = os.environ.get(key)
        if raw is None or not raw.strip():
            return default
        try:
            return int(raw)
        except ValueError as exc:
            raise ConfigError(f"{key} must be an integer, got {raw!r}") from exc

    @property
    def approval_bot_token(self) -> str:
        """Token used to SEND approval requests.

        Falls back to the quantumclaw bot so a missing dedicated token still
        delivers the message (sendMessage has no single-consumer constraint).
        The buttons will render but nothing can answer the tap — the approval
        then times out, which is the safe direction to fail.
        """
        return self.trade_telegram_bot_token or self.telegram_bot_token

    @property
    def telegram_poller_enabled(self) -> bool:
        """Whether it is safe to run a getUpdates loop.

        Telegram allows exactly ONE getUpdates consumer per bot. The
        quantumclaw process long-polls TELEGRAM_BOT_TOKEN continuously
        (grammy runner, allowed_updates message+callback_query), so a second
        poller on that same token does not merely miss callbacks — it steals
        Charlie's message updates and 409s his poll. Verified live on
        2026-08-04: a single getUpdates from a second consumer returned
        {"ok":true,"result":[]} and terminated Charlie's in-flight poll.

        So polling requires a DEDICATED token that is present and different.
        Absent or identical -> no poller, approvals time out, nothing crashes.
        """
        token = self.trade_telegram_bot_token
        return bool(token) and token != self.telegram_bot_token

    @property
    def supabase_rest_url(self) -> str:
        return f"{self.supabase_url}/rest/v1"

    def supabase_headers(self, *, write: bool = False) -> dict[str, str]:
        """PostgREST auth headers. service_role — these tables are RLS-locked
        to service_role (policy `service_role_all`), so anon will 401."""
        headers = {
            "apikey": self.supabase_service_role_key,
            "Authorization": f"Bearer {self.supabase_service_role_key}",
            "Accept": "application/json",
        }
        if write:
            headers["Content-Type"] = "application/json"
            headers["Prefer"] = "return=representation"
        return headers

    def __repr__(self) -> str:
        # Never render secrets.
        return (
            f"<Config version={self.version} host={self.trade_engine_host} "
            f"port={self.trade_engine_port} log_level={self.log_level} "
            f"supabase_url={self.supabase_url}>"
        )


# Telegram puts the bot token in the URL PATH, and httpx logs every request
# line at INFO ("HTTP Request: GET https://api.telegram.org/bot<TOKEN>/..."),
# so simply making a Telegram call writes the token to the PM2 log — the
# 2026-05-14 token-leak incident class. Supabase is unaffected (it authenticates
# by header), so the httpx logger is filtered rather than silenced: request
# logging stays useful and only the token is redacted.
_BOT_TOKEN_IN_URL = re.compile(r"/bot\d+:[A-Za-z0-9_-]+")


class _RedactBotToken(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001 - never break logging
            return True
        if "/bot" in message:
            record.msg = _BOT_TOKEN_IN_URL.sub("/bot***", message)
            record.args = ()
        return True


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    )
    install_bot_token_redaction()


def install_bot_token_redaction() -> None:
    """Attach the redaction filter to every logger that can carry a bot URL.

    Idempotent — re-attaching on a second call is skipped, so importing this
    from more than one entry point is safe.
    """
    for name in ("httpx", "httpcore", "urllib3"):
        target = logging.getLogger(name)
        if not any(isinstance(f, _RedactBotToken) for f in target.filters):
            target.addFilter(_RedactBotToken())


# Module-level singleton. Import failure here is intentional and fatal.
config = Config()
