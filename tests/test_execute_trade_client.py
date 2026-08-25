"""Tests for the relay client's timeout classification (src/trading/execute_trade.py).

H1 (PR #94 review): a READ timeout on the relay call means the request
reached the relay, and the relay decodes the settlement AFTER placing the
order, so the order may well be filled. That case must map to the
relay_timeout_order_status_unknown sentinel (which the executor turns into
ORDER STATUS UNKNOWN), while connect-level failures stay relay_unreachable.

The module is loaded by file path: src/trading is not a package. No network:
requests.post is replaced in every test.

Run:
    python3 -m unittest tests/test_execute_trade_client.py
"""

import importlib.util
import os
import sys
import unittest

ET_PATH = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "src", "trading", "execute_trade.py"
))

_spec = importlib.util.spec_from_file_location("execute_trade_client", ET_PATH)
et = importlib.util.module_from_spec(_spec)
sys.modules["execute_trade_client"] = et
_spec.loader.exec_module(et)


class TimeoutClassificationTest(unittest.TestCase):
    def setUp(self):
        self._saved_post = et.requests.post
        self._saved_secret = et.RELAY_SHARED_SECRET
        et.RELAY_SHARED_SECRET = "test-secret"

    def tearDown(self):
        et.requests.post = self._saved_post
        et.RELAY_SHARED_SECRET = self._saved_secret

    def _raise(self, exc):
        def post(*args, **kwargs):
            raise exc
        et.requests.post = post

    def test_read_timeout_maps_to_status_unknown_sentinel(self):
        self._raise(et.requests.exceptions.ReadTimeout("read timed out"))
        out = et.execute_trade("0xabc", "YES", 10.0)
        self.assertTrue(
            out["error"].startswith("relay_timeout_order_status_unknown"),
            out["error"],
        )

    def test_bare_timeout_also_maps_to_status_unknown(self):
        self._raise(et.requests.exceptions.Timeout("ambiguous timeout"))
        out = et.execute_trade("0xabc", "YES", 10.0)
        self.assertTrue(out["error"].startswith("relay_timeout_order_status_unknown"))

    def test_connect_timeout_stays_relay_unreachable(self):
        """ConnectTimeout subclasses Timeout, so the except ordering in
        execute_trade is load-bearing: the connection never opened, no order
        can exist, and 'unreachable' is the correct, calmer message."""
        self._raise(et.requests.exceptions.ConnectTimeout("no connect"))
        out = et.execute_trade("0xabc", "YES", 10.0)
        self.assertEqual(out["error"], "relay_unreachable: ConnectTimeout")

    def test_connection_error_stays_relay_unreachable(self):
        self._raise(et.requests.exceptions.ConnectionError("refused"))
        out = et.execute_trade("0xabc", "YES", 10.0)
        self.assertTrue(out["error"].startswith("relay_unreachable"))

    def test_missing_secret_is_a_config_error_not_a_timeout(self):
        et.RELAY_SHARED_SECRET = None
        out = et.execute_trade("0xabc", "YES", 10.0)
        self.assertIn("RELAY_SHARED_SECRET", out["error"])


if __name__ == "__main__":
    unittest.main()
