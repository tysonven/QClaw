-- 2026-08-20 — Position Monitor exit-side fix: alert state + manual hold.
--
-- WHY THIS EXISTS
-- ---------------
-- monitor.py::_close() wrote status='closed' whenever a take-profit or
-- stop-loss threshold fired, but never placed a sell order. On 2026-08-19 a BTC
-- position's stop loss fired, the DB recorded a closed position with a phantom
-- -9.27 pnl, and the real Polymarket position stayed open for another 17 hours.
-- The database and reality diverged with no automatic detection.
--
-- Polymarket execution (BUY and SELL alike) is blocked by an unresolved
-- signer/maker-address issue, so exits are MANUAL for now. The monitor must
-- therefore FLAG a threshold crossing, not claim a close.
--
-- Two objects:
--   1. trading_position_alerts — one row per unresolved threshold crossing.
--   2. trading_positions.manual_hold — suppress alerts on a position Tyson is
--      already managing by hand.
--
-- NOT touched: trading_positions' money columns. A threshold crossing never
-- writes exit_price/exit_usdc/pnl/status. Only a real, manually-confirmed close
-- populates those. The unrealized estimate lives here, clearly named, so it can
-- never be mistaken for a realised figure by a reader or by get_daily_pnl().
--
-- The RESOLUTION path (resolved_win / resolved_loss) is deliberately unchanged:
-- a settled market really is closed and really does pay out, so the monitor
-- still writes status='closed' for those. Only TP/SL/weakening route here.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Alert table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trading_position_alerts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id             uuid NOT NULL
                            REFERENCES public.trading_positions(id)
                            ON DELETE CASCADE,
  alert_type              text NOT NULL
                            CHECK (alert_type IN ('weakening', 'stop_loss', 'take_profit')),
  triggered_at            timestamptz NOT NULL DEFAULT now(),
  trigger_price           numeric NOT NULL,
  entry_price             numeric,
  -- ESTIMATE ONLY. Marked-to-market from trigger_price at alert time. This is
  -- NOT a realised pnl and must never be copied into trading_positions.pnl,
  -- which get_daily_pnl() sums into the executor's daily-loss gate.
  unrealized_pnl_estimate numeric,
  -- NULL means the Telegram send has not succeeded yet. The row is written
  -- BEFORE the send so a notification failure can never lose the alert.
  notified_at             timestamptz,
  -- Set when a real close is logged for the position. NULL = still live.
  resolved_at             timestamptz,
  resolution_note         text
);

COMMENT ON TABLE public.trading_position_alerts IS
  'Threshold crossings detected by the Position Monitor. An alert is NOT a close: '
  'Polymarket exits are manual while the signer/maker-address issue is open.';
COMMENT ON COLUMN public.trading_position_alerts.unrealized_pnl_estimate IS
  'Mark-to-market ESTIMATE at trigger time. Never a realised pnl. Never copy to trading_positions.pnl.';

-- Dedup, enforced by the database rather than by monitor logic.
-- At most one UNRESOLVED alert of a given type per position, so a 15-minute
-- sweep that re-detects the same condition conflicts instead of re-alerting.
-- Enforced here (not in Python) so it survives process restarts, concurrent
-- sweeps, and any future caller.
CREATE UNIQUE INDEX IF NOT EXISTS trading_position_alerts_live_uniq
  ON public.trading_position_alerts (position_id, alert_type)
  WHERE resolved_at IS NULL;

-- Read paths: "what needs attention" and "this position's history".
CREATE INDEX IF NOT EXISTS trading_position_alerts_unresolved_idx
  ON public.trading_position_alerts (triggered_at DESC)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS trading_position_alerts_position_idx
  ON public.trading_position_alerts (position_id, triggered_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Manual hold flag
-- ---------------------------------------------------------------------------
-- A property of the position, not of any one alert: when Tyson is already
-- handling an exit by hand, the monitor keeps pricing the position (so the
-- Analyst and dashboard stay accurate) but stops alerting on it.
ALTER TABLE public.trading_positions
  ADD COLUMN IF NOT EXISTS manual_hold boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.trading_positions.manual_hold IS
  'true = Tyson is managing this exit manually; monitor still prices it but emits no alerts.';

-- ---------------------------------------------------------------------------
-- 3. RLS — service_role only, matching the rest of the trading cluster
-- ---------------------------------------------------------------------------
-- Same posture as the 2026-07-15 anon-exposure lockdown: no anon policy, and
-- FORCE so the table owner is subject to RLS too.
ALTER TABLE public.trading_position_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trading_position_alerts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.trading_position_alerts FROM anon, authenticated;
GRANT ALL ON public.trading_position_alerts TO service_role;

DROP POLICY IF EXISTS trading_position_alerts_service_role
  ON public.trading_position_alerts;
CREATE POLICY trading_position_alerts_service_role
  ON public.trading_position_alerts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;
