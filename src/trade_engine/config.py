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

        self.version: str = VERSION

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


def configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    )


# Module-level singleton. Import failure here is intentional and fatal.
config = Config()
