/**
 * Slice 3g Unit 1 — spend aggregator.
 *
 * Reads Charlie's per-turn cache-usage.log (Charlie main-loop only, by
 * construction — nothing else writes it) and produces cost-attribution
 * rollups into Supabase `anthropic_spend_rollup`:
 *   - rolling windows 1h / 24h / 7d / 30d, per dimension total|model|channel|user
 *   - a separate calendar-day reconciliation of the Charlie estimate against
 *     the authoritative org total in anthropic_spend_daily (the gap = non-Charlie
 *     spend: Claude Code, n8n, clipper, plus any batch/priority-tier skew).
 *
 * Cost is computed here (not in the append-only log) via pricing.js, with
 * dated→family model-id normalization and an explicit UNKNOWN-model surface.
 *
 * Runs as a standalone cron entrypoint (NOT in PM2), daily at 00:05 UTC
 * (after the 23:59 poller). Window membership is half-open [start, end).
 *
 * Design ref: /tmp/slice3g_design.md §1, §3, §9, §10.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { readEnvFile } from '../core/env.js';
import { estimateCostUsd, normalizeModelId, priceFor, PRICING_AS_OF } from './pricing.js';
import { scrubSecrets } from './anthropic-spend-poller.js';

const DEFAULT_LOG = join(homedir(), '.quantumclaw', 'cache-usage.log');
const WINDOWS = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };

function logPath() {
  return process.env.QCLAW_CACHE_USAGE_LOG_PATH || DEFAULT_LOG;
}

/** Parse cache-usage.log JSONL; skip unparseable lines (never throw). */
export function readCacheUsage(path = logPath()) {
  let text;
  try { text = readFileSync(path, 'utf-8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip garbage line */ }
  }
  return out;
}

/** Floor a timestamp to a window's right boundary (1h→top of hour; else UTC midnight). */
export function floorWindowEnd(ts, windowKind) {
  const d = new Date(ts);
  if (windowKind === '1h') {
    d.setUTCMinutes(0, 0, 0);
  } else {
    d.setUTCHours(0, 0, 0, 0);
  }
  return d;
}

/** Estimate USD for one cache-usage record, mapping its fields to pricing.js. */
export function recordCost(rec) {
  return estimateCostUsd(rec.model, {
    uncached_input_tokens: rec.input_tokens,
    output_tokens: rec.output_tokens,
    cache_read_input_tokens: rec.cache_read_input_tokens,
    cache_creation_input_tokens: rec.cache_creation_input_tokens,
    ephemeral_1h_input_tokens: rec.ephemeral_1h_input_tokens,
  });
}

function emptyAgg() {
  return { est_cost_usd: 0, turn_count: 0, uncached_input: 0, output: 0, cache_read: 0, cache_creation: 0, unknown_model_turns: 0 };
}
function addInto(agg, rec, cost) {
  agg.est_cost_usd += cost.usd;
  agg.turn_count += 1;
  agg.uncached_input += num(rec.input_tokens);
  agg.output += num(rec.output_tokens);
  agg.cache_read += num(rec.cache_read_input_tokens);
  agg.cache_creation += num(rec.cache_creation_input_tokens);
  if (!cost.known) agg.unknown_model_turns += 1;
}
function aggToRow(windowKind, windowEnd, dimension, dimensionKey, agg) {
  return {
    window_kind: windowKind,
    window_end: windowEnd.toISOString(),
    dimension,
    dimension_key: dimensionKey,
    est_cost_usd: round6(agg.est_cost_usd),
    turn_count: agg.turn_count,
    token_totals: {
      uncached_input: agg.uncached_input,
      output: agg.output,
      cache_read: agg.cache_read,
      cache_creation: agg.cache_creation,
      unknown_model_turns: agg.unknown_model_turns,
    },
  };
}

/**
 * Build rolling-window rollups. `now` is the run instant. For each window,
 * window_end is boundary-floored; membership is half-open [end-span, end).
 * Returns an array of anthropic_spend_rollup rows. Unknown models surface as
 * dimension='model', dimension_key='UNKNOWN:<id>'.
 */
export function buildRollups(records, now = new Date()) {
  const rows = [];
  for (const [wk, span] of Object.entries(WINDOWS)) {
    const end = floorWindowEnd(now, wk);
    const endMs = end.getTime();
    const startMs = endMs - span;
    const dims = { total: { all: emptyAgg() }, model: {}, channel: {}, user: {} };
    for (const rec of records) {
      const tMs = Date.parse(rec.ts);
      if (!Number.isFinite(tMs) || tMs < startMs || tMs >= endMs) continue; // half-open
      const cost = recordCost(rec);
      addInto(dims.total.all, rec, cost);
      const modelKey = cost.known ? (cost.normalized || rec.model || 'unknown') : `UNKNOWN:${normalizeModelId(rec.model) || rec.model || 'null'}`;
      const channelKey = rec.channel || 'unknown';
      const userKey = rec.user_id == null ? 'null' : String(rec.user_id);
      (dims.model[modelKey] ||= emptyAgg()); addInto(dims.model[modelKey], rec, cost);
      (dims.channel[channelKey] ||= emptyAgg()); addInto(dims.channel[channelKey], rec, cost);
      (dims.user[userKey] ||= emptyAgg()); addInto(dims.user[userKey], rec, cost);
    }
    rows.push(aggToRow(wk, end, 'total', 'all', dims.total.all));
    for (const dim of ['model', 'channel', 'user']) {
      for (const [k, agg] of Object.entries(dims[dim])) rows.push(aggToRow(wk, end, dim, k, agg));
    }
  }
  return rows;
}

/**
 * Calendar-day reconciliation: sum Charlie estimate for UTC date D-1 and
 * compare to the authoritative org total. Returns rollup rows under
 * window_kind='calendar_day', window_end = D midnight. dailyTotalUsd is the
 * anthropic_spend_daily[D-1].total_cost_usd (whole-org); pass null if absent
 * (then only the charlie_est row is emitted — §10: tolerate missing daily).
 */
export function reconcileCalendarDay(records, dailyTotalUsd, dateD1) {
  const start = Date.parse(`${dateD1}T00:00:00Z`);
  const end = start + 86400e3;
  const windowEnd = new Date(end);
  const agg = emptyAgg();
  for (const rec of records) {
    const tMs = Date.parse(rec.ts);
    if (!Number.isFinite(tMs) || tMs < start || tMs >= end) continue; // half-open
    addInto(agg, rec, recordCost(rec));
  }
  const rows = [aggToRow('calendar_day', windowEnd, 'total', 'charlie_est', agg)];
  if (dailyTotalUsd != null && Number.isFinite(Number(dailyTotalUsd))) {
    const org = Number(dailyTotalUsd);
    const orgAgg = { ...emptyAgg(), est_cost_usd: org };
    rows.push(aggToRow('calendar_day', windowEnd, 'total', 'org_authoritative', orgAgg));
    const gapAgg = { ...emptyAgg(), est_cost_usd: round6(org - agg.est_cost_usd) };
    rows.push(aggToRow('calendar_day', windowEnd, 'total', 'reconciliation_gap', gapAgg));
  }
  return rows;
}

/** GET anthropic_spend_daily[date].total_cost_usd, or null if absent. */
export async function fetchDailyTotal({ date, supabaseUrl, serviceKey, fetchImpl = fetch }) {
  const url = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/anthropic_spend_daily?date=eq.${date}&select=total_cost_usd`;
  const res = await fetchImpl(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
  if (!res.ok) return null;
  const arr = await res.json().catch(() => []);
  return Array.isArray(arr) && arr.length ? Number(arr[0].total_cost_usd) : null;
}

/** Upsert rollup rows (merge on the unique key). */
export async function upsertRollups({ rows, supabaseUrl, serviceKey, fetchImpl = fetch }) {
  if (!rows.length) return { upserted: 0 };
  const url = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/anthropic_spend_rollup` +
    `?on_conflict=window_kind,window_end,dimension,dimension_key`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows.map(r => ({ ...r, computed_at: new Date().toISOString() }))),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`rollup upsert HTTP ${res.status}: ${scrubSecrets(t).slice(0, 300)}`);
  }
  return { upserted: rows.length };
}

/** Orchestrator: read log → build rollups + reconcile D-1 → upsert. */
export async function aggregate({ env, now = new Date(), fetchImpl = fetch, records = null }) {
  const recs = records || readCacheUsage();
  const rollups = buildRollups(recs, now);
  const dateD1 = utcDate(now, -1);
  const dailyTotal = await fetchDailyTotal({
    date: dateD1, supabaseUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl,
  }).catch(() => null);
  const recon = reconcileCalendarDay(recs, dailyTotal, dateD1);
  const all = [...rollups, ...recon];
  const { upserted } = await upsertRollups({
    rows: all, supabaseUrl: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl,
  });
  return { rollups: rollups.length, reconciliation: recon.length, upserted, turns: recs.length, pricingAsOf: PRICING_AS_OF };
}

export function utcDate(ref, deltaDays = 0) {
  const d = new Date(ref);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }
function round6(n) { return Math.round(n * 1e6) / 1e6; }

// ── Live CLI entrypoint (cron) ────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (process.env.pm_id !== undefined) {
    console.error('[spend-aggregator] refusing to run inside PM2 (pm_id set) — cron-only');
    process.exit(2);
  }
  const env = { ...readEnvFile(), ...process.env };
  aggregate({ env })
    .then(r => { console.log(`[spend-aggregator] ${r.turns} turns → ${r.upserted} rollup rows (recon ${r.reconciliation}); pricing as_of ${r.pricingAsOf}`); process.exit(0); })
    .catch(err => { console.error(`[spend-aggregator] FAILED: ${scrubSecrets(err?.message || String(err))}`); process.exit(1); });
}
