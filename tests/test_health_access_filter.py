"""The /health access-log filter drops the flood, not the signal.

The dashboard polls /health on a short interval, so at INFO uvicorn's access
line for each poll buried the boot banner (633 of 662 out-log lines on
2026-09-11). The filter drops SUCCESSFUL /health access lines only. These
tests pin that it does not also swallow a degraded health check or ordinary
traffic, and that it works whether uvicorn hands the record structured args or
only a formatted line.

Run: python -m pytest tests/test_health_access_filter.py -q
"""

import logging
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# config.py fail-fasts on missing env, so seed placeholders before importing it.
for _key in (
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY",
    "TELEGRAM_BOT_TOKEN", "OWNER_TELEGRAM_CHAT_ID",
    "POLYMARKET_PRIVATE_KEY", "POLYMARKET_FUNDER_ADDRESS",
):
    os.environ.setdefault(_key, f"test-{_key.lower()}")

from src.trade_engine.config import (  # noqa: E402
    _SuppressHealthAccess,
    install_health_access_suppression,
)

UVICORN_ACCESS_FMT = '%s - "%s %s HTTP/%s" %d'


def _record_with_args(method, path, status):
    """A record shaped like uvicorn's access log: msg + 5-tuple args."""
    return logging.LogRecord(
        name="uvicorn.access", level=logging.INFO, pathname=__file__, lineno=0,
        msg=UVICORN_ACCESS_FMT,
        args=("127.0.0.1:5555", method, path, "1.1", status),
        exc_info=None,
    )


def _record_preformatted(method, path, status):
    """A record with no structured args, forcing the formatted-line fallback."""
    line = f'127.0.0.1:5555 - "{method} {path} HTTP/1.1" {status}'
    return logging.LogRecord(
        name="uvicorn.access", level=logging.INFO, pathname=__file__, lineno=0,
        msg=line, args=(), exc_info=None,
    )


class SuppressHealthAccessTest(unittest.TestCase):
    def setUp(self):
        self.f = _SuppressHealthAccess()

    # ── structured-args path (the normal uvicorn case) ──
    def test_drops_successful_health_from_args(self):
        self.assertFalse(self.f.filter(_record_with_args("GET", "/health", 200)))
        self.assertFalse(self.f.filter(_record_with_args("HEAD", "/health", 204)))
        self.assertFalse(self.f.filter(_record_with_args("GET", "/health?x=1", 200)))

    def test_keeps_degraded_health_from_args(self):
        # 503 is what the handler returns on a Supabase failure. It must survive,
        # or the filter would hide exactly the case a health check exists to show.
        self.assertTrue(self.f.filter(_record_with_args("GET", "/health", 503)))
        self.assertTrue(self.f.filter(_record_with_args("GET", "/health", 500)))

    def test_keeps_non_health_from_args(self):
        self.assertTrue(self.f.filter(_record_with_args("GET", "/scan", 200)))
        self.assertTrue(self.f.filter(_record_with_args("POST", "/health", 200)))
        # a path that merely starts with health must not be swallowed
        self.assertTrue(self.f.filter(_record_with_args("GET", "/healthz", 200)))

    # ── formatted-line fallback (unknown uvicorn shape) ──
    def test_drops_successful_health_from_message(self):
        self.assertFalse(self.f.filter(_record_preformatted("GET", "/health", 200)))

    def test_keeps_degraded_and_non_health_from_message(self):
        self.assertTrue(self.f.filter(_record_preformatted("GET", "/health", 503)))
        self.assertTrue(self.f.filter(_record_preformatted("GET", "/scan", 200)))
        self.assertTrue(self.f.filter(_record_preformatted("GET", "/healthz", 200)))

    # ── never raise ──
    def test_malformed_record_is_passed_through(self):
        rec = logging.LogRecord(
            name="uvicorn.access", level=logging.INFO, pathname=__file__, lineno=0,
            msg="not an access line at all", args=(), exc_info=None,
        )
        self.assertTrue(self.f.filter(rec))


class InstallTest(unittest.TestCase):
    def test_install_is_idempotent_on_uvicorn_access(self):
        access = logging.getLogger("uvicorn.access")
        before = [f for f in access.filters if isinstance(f, _SuppressHealthAccess)]
        for f in before:
            access.removeFilter(f)
        install_health_access_suppression()
        install_health_access_suppression()
        attached = [f for f in access.filters if isinstance(f, _SuppressHealthAccess)]
        self.assertEqual(len(attached), 1)
        # and it is live: a successful /health poll is now dropped
        self.assertFalse(attached[0].filter(_record_with_args("GET", "/health", 200)))


if __name__ == "__main__":
    unittest.main()
