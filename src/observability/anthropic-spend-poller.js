/**
 * Slice 3g Unit 1 — Anthropic spend poller.
 *
 * Polls the Admin Cost API (`/v1/organizations/cost_report`, daily granularity)
 * and upserts one row per UTC day into Supabase `anthropic_spend_daily`. Runs
 * as a standalone cron entrypoint (NOT inside the PM2 quantumclaw process), so
 * a failure here can never crash Charlie's runtime.
 *
 * Cron (host-side, documented in build log): daily at 23:59 UTC.
 * First run loads the full 30-day window (cost_report max 31 daily buckets),
 * so anthropic_spend_daily backfills in one pass.
 *
 * Security (design §7): the admin key (`sk-ant-admin…`) is read only from
 * process.env / the .env file, never passed as a CLI arg, never logged, and
 * the response body is run through an UNANCHORED scrubber before it is stored
 * in raw_api_response (defence-in-depth — the body should not contain the key,
 * but a future error path must never be able to leak it into Supabase).
 *
 * Design ref: /tmp/slice3g_design.md §1, §7, §10.
 */

import { readEnvFile } from '../core/env.js';

const COST_REPORT_URL = 'https://api.anthropic.com/v1/organizations/cost_report';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_DAILY_BUCKETS = 31; // Cost API hard cap for 1d granularity

/**
 * Unanchored secret scrubber (design §7 — distinct from cache-usage-log.js's
 * ANCHORED `_scrub`, which only matches whole values at string start). Strips
 * Anthropic keys AND Telegram bot-token shapes anywhere in a string. Operates
 * recursively on objects/arrays so a planted key in any nested field is caught.
 */
const SECRET_RE = /sk-ant-[A-Za-z0-9_-]+/g;
const TELEGRAM_RE = /\d{8,}:[A-Za-z0-9_-]{30,}/g;

export function scrubSecrets(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.replace(SECRET_RE, '<scrubbed>').replace(TELEGRAM_RE, '<scrubbed>');
  }
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubSecrets(v);
    return out;
  }
  return value;
}

/**
 * Parse a cost_report payload into per-UTC-date aggregates.
 * Returns { 'YYYY-MM-DD': { total_cost_usd, model_breakdown, raw } }.
 * total = Σ all result amounts that day; model_breakdown = { model: usd }.
 * `raw` is the SCRUBBED day bucket (forensics).
 */
export function parseCostReport(payload) {
  const out = {};
  const days = (payload && Array.isArray(payload.data)) ? payload.data : [];
  for (const bucket of days) {
    const date = String(bucket.starting_at || '').slice(0, 10);
    if (!date) continue;
    // Cost API `amount` is a decimal string in the LOWEST currency unit (cents)
    // — "1564.68" USD == $15.6468 (verified against usage tokens × price).
    // Convert to dollars on ingest.
    const modelsRaw = {};
    for (const r of (Array.isArray(bucket.results) ? bucket.results : [])) {
      const cents = Number(r.amount);
      if (!Number.isFinite(cents)) continue;
      const usd = cents / 100;
      const model = r.model || r.description || 'unknown';
      modelsRaw[model] = (modelsRaw[model] || 0) + usd;
    }
    // Round breakdown + total at the same precision so the breakdown always
    // reconciles to the stored total (numeric(12,4) column → 4 dp).
    const models = {};
    let total = 0;
    for (const [m, v] of Object.entries(modelsRaw)) { models[m] = round4(v); total += models[m]; }
    out[date] = {
      total_cost_usd: round4(total),
      model_breakdown: models,
      raw: scrubSecrets(bucket),
    };
  }
  return out;
}

/** Convert parsed aggregates into anthropic_spend_daily upsert rows. */
export function buildDailyRows(parsed) {
  return Object.entries(parsed).map(([date, agg]) => ({
    date,
    total_cost_usd: agg.total_cost_usd,
    model_breakdown: agg.model_breakdown,
    raw_api_response: agg.raw,
    source: 'cost_report',
  }));
}

/**
 * Fetch the cost_report across the window, following pagination until
 * has_more is false. `fetchImpl` is injectable for tests. Throws
 * AuthError on a 401/authentication_error so the caller can alert + exit
 * without writing partial data.
 */
export class AuthError extends Error {}

export async function fetchCostReport({ adminKey, startDate, endDate, fetchImpl = fetch }) {
  const buckets = [];
  let page = null;
  let guard = 0;
  do {
    const url = new URL(COST_REPORT_URL);
    url.searchParams.set('starting_at', `${startDate}T00:00:00Z`);
    url.searchParams.set('ending_at', `${endDate}T00:00:00Z`);
    url.searchParams.append('group_by[]', 'description');
    url.searchParams.set('limit', String(MAX_DAILY_BUCKETS));
    if (page) url.searchParams.set('page', page);

    const res = await fetchImpl(url.toString(), {
      headers: { 'anthropic-version': ANTHROPIC_VERSION, 'x-api-key': adminKey },
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || body?.error?.type === 'authentication_error') {
      throw new AuthError(`Admin API auth failed: ${scrubSecrets(body?.error?.message || 'invalid x-api-key')}`);
    }
    if (!res.ok) {
      throw new Error(`cost_report HTTP ${res.status}: ${scrubSecrets(JSON.stringify(body)).slice(0, 300)}`);
    }
    if (Array.isArray(body.data)) buckets.push(...body.data);
    page = body.has_more ? body.next_page : null;
  } while (page && ++guard < 50);
  return { data: buckets };
}

/** Upsert daily rows into Supabase via PostgREST (service-role, merge on date PK). */
export async function upsertDaily({ rows, supabaseUrl, serviceKey, fetchImpl = fetch }) {
  if (!rows.length) return { upserted: 0 };
  const url = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/anthropic_spend_daily?on_conflict=date`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows.map(r => ({ ...r, updated_at: new Date().toISOString() }))),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Supabase upsert HTTP ${res.status}: ${scrubSecrets(t).slice(0, 300)}`);
  }
  return { upserted: rows.length };
}

/** Orchestrator: fetch → parse → build → upsert. Returns a summary. */
export async function pollAndStore({ env, startDate, endDate, fetchImpl = fetch }) {
  const adminKey = env.ANTHROPIC_ADMIN_API_KEY;
  if (!adminKey) throw new Error('ANTHROPIC_ADMIN_API_KEY missing in env');
  if (!/^sk-ant-admin/.test(adminKey)) {
    throw new Error('ANTHROPIC_ADMIN_API_KEY is not an Admin key (must start sk-ant-admin)');
  }
  const payload = await fetchCostReport({ adminKey, startDate, endDate, fetchImpl });
  const parsed = parseCostReport(payload);
  const rows = buildDailyRows(parsed);
  const { upserted } = await upsertDaily({
    rows,
    supabaseUrl: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    fetchImpl,
  });
  return { days: rows.length, upserted, dates: rows.map(r => r.date) };
}

/** UTC-day helper: returns 'YYYY-MM-DD' offset by `deltaDays` from `ref`. */
export function utcDate(ref, deltaDays = 0) {
  const d = new Date(ref);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function round4(n) { return Math.round(n * 1e4) / 1e4; }

// ── Live CLI entrypoint (cron) ────────────────────────────────────────────
// Refuses to run inside the PM2 process (design §10 isolation guard).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  if (process.env.pm_id !== undefined) {
    console.error('[spend-poller] refusing to run inside PM2 (pm_id set) — cron-only');
    process.exit(2);
  }
  const env = { ...readEnvFile(), ...process.env };
  // Default window: trailing 30 days through tomorrow (exclusive end).
  const now = new Date();
  const endDate = process.argv[3] || utcDate(now, 1);
  const startDate = process.argv[2] || utcDate(now, -30);
  pollAndStore({ env, startDate, endDate })
    .then(r => { console.log(`[spend-poller] upserted ${r.upserted} day(s): ${r.dates[0]}..${r.dates[r.dates.length - 1]}`); process.exit(0); })
    .catch(err => {
      const msg = scrubSecrets(err?.message || String(err));
      console.error(`[spend-poller] FAILED: ${msg}`);
      process.exit(err instanceof AuthError ? 3 : 1);
    });
}
