# polymarket-relay

Source of truth for the Polymarket execution relay that runs on the AMS3
droplet (`root@68.183.13.219:/root/polymarket-relay/`, systemd unit
`polymarket-relay.service`). Committed here since 2026-08-25 so the deployed
service can no longer drift from anything version-controlled (the same
failure mode as the emma-credits out-of-band edge-function incident).

## Deploy

The droplet is the runtime; this directory is the source. To deploy a change:

```
scp relay/polymarket-relay/relay.py root@68.183.13.219:/root/polymarket-relay/relay.py
ssh root@68.183.13.219 'systemctl restart polymarket-relay && sleep 2 && systemctl is-active polymarket-relay'
```

Back up the deployed file first (`cp -p relay.py relay.py.deployed-backup-YYYY-MM-DD`)
and diff it against this directory before overwriting: if the droplet copy
differs from git, someone edited out of band and that edit must be
reconciled here first, not clobbered.

Dependencies are pinned in `requirements.txt` (venv2 on the droplet; venv is
the retired v1-client environment). `.env` on the droplet carries
POLYMARKET_PRIVATE_KEY, POLYMARKET_FUNDER_ADDRESS, RELAY_SHARED_SECRET and
optionally POLYGON_RPC_URLS; it is never committed.

## What it does

One thing: place one already-gate-approved market order on the Polymarket
CLOB (the six financial gates run on qclaw before anything reaches this
host), then decode the settlement transaction(s) to report `cash_out`, the
true USDC debited from the funder wallet including the fee that the CLOB API
does not report anywhere. See the module docstring in `relay.py` for the
design constraints (single-origin CLOB traffic, signature_type=3 deposit
wallet flow).

Settlement-decode tests live in `tests/test_relay_settlement.py` and load
this file by path; run them with
`python3 -m pytest tests/test_relay_settlement.py`.
