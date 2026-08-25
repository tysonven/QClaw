"""Tests for the relay's settlement decode (relay/polymarket-relay/relay.py).

The relay is deployed on the AMS3 droplet, not imported as part of this
package, so it is loaded by file path. Only the pure decode logic is tested
here: no RPC, no CLOB, no FastAPI app — _fetch_receipt is monkeypatched.

The reference numbers are the REAL settlement of order 0x1938e3c7 (position
f4be9ee8, 2026-08-20): $9.999999 notional to the maker plus a $0.501190 fee
transfer that no CLOB API field reports, total wallet debit $10.501189.

Run:
    python3 -m unittest tests/test_relay_settlement.py
"""

import importlib.util
import os
import sys
import unittest

RELAY_PATH = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "relay", "polymarket-relay", "relay.py"
))

_spec = importlib.util.spec_from_file_location("polymarket_relay", RELAY_PATH)
relay = importlib.util.module_from_spec(_spec)
sys.modules["polymarket_relay"] = relay
_spec.loader.exec_module(relay)

FUNDER = "0xE44f7511023d668A2467db5B74168611656eAA50"
MAKER = "0xeee92F1CC6D6e0AD0b4ffDa20b01CF3678e27ECb"
FEE_RECIPIENT = "0x115f48dc2a0000000000000000000000000000aa"
COLLATERAL = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb"

TRANSFER = relay.TRANSFER_TOPIC


def _word(address: str) -> str:
    return "0x" + "0" * 24 + address.lower().removeprefix("0x")


def transfer_log(token: str, frm: str, to: str, raw_amount: int) -> dict:
    return {
        "address": token,
        "topics": [TRANSFER, _word(frm), _word(to)],
        "data": hex(raw_amount),
    }


def entry_receipt() -> dict:
    """The real 2026-08-20 entry settlement, reduced to its transfer logs."""
    return {
        "status": "0x1",
        "logs": [
            # ERC-1155 share movement: different topic0, must never be counted.
            {"address": "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
             "topics": ["0xc3d5816800000000000000000000000000000000000000000000000000000000",
                        _word(FUNDER), _word(MAKER)],
             "data": hex(35211266)},
            transfer_log(COLLATERAL, FUNDER, MAKER, 9_999_999),
            transfer_log(COLLATERAL, FUNDER, FEE_RECIPIENT, 501_190),
        ],
    }


class SumFunderOutflowsTest(unittest.TestCase):
    def test_real_entry_receipt_sums_notional_plus_fee(self):
        total = relay._sum_funder_outflows(entry_receipt(), FUNDER)
        self.assertAlmostEqual(total, 10.501189)

    def test_inflows_are_not_counted(self):
        receipt = entry_receipt()
        receipt["logs"].append(transfer_log(COLLATERAL, MAKER, FUNDER, 5_000_000))
        total = relay._sum_funder_outflows(receipt, FUNDER)
        self.assertAlmostEqual(total, 10.501189)

    def test_unknown_token_contracts_are_ignored(self):
        receipt = entry_receipt()
        receipt["logs"].append(transfer_log(
            "0x000000000000000000000000000000000000dEaD", FUNDER, MAKER, 99_000_000
        ))
        total = relay._sum_funder_outflows(receipt, FUNDER)
        self.assertAlmostEqual(total, 10.501189)

    def test_funder_match_is_case_insensitive(self):
        total = relay._sum_funder_outflows(entry_receipt(), FUNDER.upper())
        self.assertAlmostEqual(total, 10.501189)

    def test_malformed_log_entries_are_skipped_not_fatal(self):
        receipt = entry_receipt()
        receipt["logs"].insert(0, {"address": COLLATERAL, "topics": [TRANSFER],
                                   "data": "not-hex"})
        total = relay._sum_funder_outflows(receipt, FUNDER)
        self.assertAlmostEqual(total, 10.501189)


class SettlementCashOutTest(unittest.TestCase):
    def setUp(self):
        self._real_fetch = relay._fetch_receipt
        self._real_sleep = relay.time.sleep
        relay.time.sleep = lambda _s: None

    def tearDown(self):
        relay._fetch_receipt = self._real_fetch
        relay.time.sleep = self._real_sleep

    def test_happy_path_returns_total_and_no_error(self):
        relay._fetch_receipt = lambda _h: entry_receipt()
        cash_out, error = relay._settlement_cash_out(["0x" + "ae" * 32], FUNDER)
        self.assertAlmostEqual(cash_out, 10.501189)
        self.assertIsNone(error)

    def test_no_hashes_degrades_with_reason(self):
        cash_out, error = relay._settlement_cash_out([], FUNDER)
        self.assertIsNone(cash_out)
        self.assertIn("no settlement hashes", error)

    def test_missing_funder_degrades_with_reason(self):
        cash_out, error = relay._settlement_cash_out(["0x" + "ae" * 32], "")
        self.assertIsNone(cash_out)
        self.assertIn("funder", error)

    def test_unavailable_receipt_degrades_within_time_budget(self):
        relay._fetch_receipt = lambda _h: None
        cash_out, error = relay._settlement_cash_out(["0x" + "ae" * 32], FUNDER)
        self.assertIsNone(cash_out)
        self.assertIn("receipt not available", error)

    def test_failed_settlement_tx_is_refused(self):
        receipt = entry_receipt()
        receipt["status"] = "0x0"
        relay._fetch_receipt = lambda _h: receipt
        cash_out, error = relay._settlement_cash_out(["0x" + "ae" * 32], FUNDER)
        self.assertIsNone(cash_out)
        self.assertIn("did not succeed", error)

    def test_zero_outflows_reported_as_decode_failure_not_free_trade(self):
        relay._fetch_receipt = lambda _h: {"status": "0x1", "logs": []}
        cash_out, error = relay._settlement_cash_out(["0x" + "ae" * 32], FUNDER)
        self.assertIsNone(cash_out)
        self.assertIn("no funder outflows", error)

    def test_multiple_fills_are_summed_and_deduped(self):
        calls = []

        def fetch(tx_hash):
            calls.append(tx_hash)
            return entry_receipt()

        relay._fetch_receipt = fetch
        hashes = ["0x" + "ae" * 32, "0x" + "bf" * 32, "0x" + "ae" * 32]
        cash_out, error = relay._settlement_cash_out(hashes, FUNDER)
        self.assertAlmostEqual(cash_out, 2 * 10.501189)
        self.assertIsNone(error)
        self.assertEqual(len(calls), 2, "duplicate hash must be fetched once")

    def test_non_string_hashes_are_filtered(self):
        cash_out, error = relay._settlement_cash_out([None, 7, "nothex"], FUNDER)
        self.assertIsNone(cash_out)
        self.assertIn("no settlement hashes", error)


if __name__ == "__main__":
    unittest.main()
