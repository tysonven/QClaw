# n8n Workflow Backups

These JSON files are exported backups of all QClaw n8n workflows.
Update after every workflow change with:
  curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
    "https://webhook.flowos.tech/api/v1/workflows/{ID}" \
    > {filename}.json

To restore after data loss, import via n8n UI or API.

## Retired trading workflows: do NOT restore blindly

All four n8n trading workflows are inactive by decision. Execution now belongs
entirely to the standalone trade engine (`src/trade_engine/`). These snapshots
are kept as history, not as restore candidates:

| File | ID | Deactivated |
|------|----|-------------|
| `3YahxqOguET3pifj-trading-market-scanner.json` | `3YahxqOguET3pifj` | 2026-08-05 |
| `trading-executor.json` | `fq7spfyiNcpt8Mf7` | 2026-08-05 |
| `UYA0JppH7eqyI7fQ-trading-position-monitor.json` | `UYA0JppH7eqyI7fQ` | 2026-08-05 |
| `trading-weekly-analyst.json` (+ id-prefixed copy) | `vjj2uBIPc07FpIxx` | 2026-08-14 |

**`trading-executor.json` contains a dangling reference.** Its "Execute Trade"
node POSTs to `https://agentboardroom.flowos.tech/api/trading/execute`, a route
REMOVED on 2026-08-14. Importing and activating this workflow would fail with
404 on every trade attempt. The reference is left in place so the snapshot
stays a faithful record of what was deactivated; it is documented here rather
than edited out.

Do not reactivate any of these without explicit confirmation from Tyson. If
trading ever needs an HTTP entry point again, route it through the trade
engine so its six pre-flight gates cannot be bypassed. That bypass is exactly
why the dashboard route was removed.
