BEGIN;

-- Slice 3g — Anthropic spend observability.
-- Two tables on the shared project (ref fdabygmromuqtysitodp):
--   anthropic_spend_daily  — authoritative org-level daily USD from the
--                            Admin Cost API (one row per UTC day).
--   anthropic_spend_rollup — derived Charlie-attribution rollups computed
--                            from cache-usage.log by the aggregator.
-- Spend data is sensitive (reveals usage volume + cost), so both tables are
-- RLS-enabled and reachable only by service_role. Per the house pattern
-- (see 2026_05_07_close_security_gate.sql): service_role bypasses RLS by
-- default; we ALSO add an explicit permissive service_role policy so the
-- intent is durable + reviewable, and we deliberately add NO anon/
-- authenticated policy so the publishable/anon key has zero access.

CREATE TABLE IF NOT EXISTS public.anthropic_spend_daily (
  date              date PRIMARY KEY,                       -- UTC day (canonical)
  total_cost_usd    numeric(12,4) NOT NULL DEFAULT 0,
  model_breakdown   jsonb         NOT NULL DEFAULT '{}'::jsonb,  -- {model: usd}
  raw_api_response  jsonb,                                  -- scrubbed cost_report body (forensics)
  source            text          NOT NULL DEFAULT 'cost_report',
  updated_at        timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.anthropic_spend_rollup (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  window_kind   text        NOT NULL,                       -- '1h' | '24h' | '7d' | '30d' | 'calendar_day'  (note: `window` is a reserved word)
  window_end    timestamptz NOT NULL,                       -- boundary-floored right edge
  dimension     text        NOT NULL,                       -- 'total' | 'model' | 'channel' | 'user'
  dimension_key text        NOT NULL DEFAULT 'all',
  est_cost_usd  numeric(12,6) NOT NULL DEFAULT 0,
  turn_count    integer     NOT NULL DEFAULT 0,
  token_totals  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (window_kind, window_end, dimension, dimension_key)
);

-- Index the rollup for the common "latest values for a window" read.
CREATE INDEX IF NOT EXISTS anthropic_spend_rollup_window_idx
  ON public.anthropic_spend_rollup (window_kind, dimension, window_end DESC);

ALTER TABLE public.anthropic_spend_daily  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anthropic_spend_rollup ENABLE ROW LEVEL SECURITY;

CREATE POLICY anthropic_spend_daily_service_role_all
  ON public.anthropic_spend_daily
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY anthropic_spend_rollup_service_role_all
  ON public.anthropic_spend_rollup
  AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- No anon / authenticated policy by design — spend data is service-role only.

COMMIT;
