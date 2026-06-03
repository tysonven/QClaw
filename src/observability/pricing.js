/**
 * Slice 3g — Anthropic model pricing (USD per 1,000,000 tokens).
 *
 * Single source of truth for the spend aggregator's cost estimates. Source:
 * platform.claude.com/docs/en/about-claude/pricing (read 2026-06-03).
 *
 * NOTE: `src/models/router.js` carries its own older `COST_TABLE` (lines
 * 17-25) with STALE rates (Opus 4.5 listed $15/$75, actual $5/$25; Haiku 4.5
 * listed $0.8/$4, actual $1/$5). Migrating router.js to consume this module is
 * a flagged follow-up — deliberately out of Slice 3g code scope to avoid
 * touching Charlie's hot path. Do not let the two tables silently diverge.
 *
 * Cost is computed at aggregation time from the token counts in
 * cache-usage.log (and from the Admin Usage API), never baked into the
 * append-only log — so a price change only requires editing this module +
 * re-running the aggregator, and historical rows reprice correctly.
 */

export const PRICING_AS_OF = '2026-06-03';

// Anthropic prompt-caching multipliers, relative to base input price.
export const CACHE_WRITE_5M_MULT = 1.25; // 5-minute cache write
export const CACHE_WRITE_1H_MULT = 2.0;  // 1-hour cache write
export const CACHE_READ_MULT = 0.10;     // cache hit / read

// Base rates per 1,000,000 tokens, keyed by NORMALIZED family id (date
// snapshot stripped). input + output only; cache rates are derived via the
// multipliers above so there is one place to change a base price.
const PRICING = {
  'claude-haiku-4-5':  { input: 1.0,  output: 5.0 },
  'claude-haiku-3-5':  { input: 0.8,  output: 4.0 },
  'claude-sonnet-4':   { input: 3.0,  output: 15.0 }, // deprecated snapshot claude-sonnet-4-20250514
  'claude-sonnet-4-5': { input: 3.0,  output: 15.0 },
  'claude-sonnet-4-6': { input: 3.0,  output: 15.0 },
  'claude-opus-4-5':   { input: 5.0,  output: 25.0 },
  'claude-opus-4-6':   { input: 5.0,  output: 25.0 },
  'claude-opus-4-1':   { input: 15.0, output: 75.0 },
  'claude-opus-4':     { input: 15.0, output: 75.0 },
};

/**
 * Normalize a model id to its family key: strip a trailing `-YYYYMMDD` date
 * snapshot. `claude-haiku-4-5-20251001` → `claude-haiku-4-5`;
 * `claude-sonnet-4-20250514` → `claude-sonnet-4`; `claude-sonnet-4-6` → itself.
 * Returns null for non-string / empty input.
 */
export function normalizeModelId(model) {
  if (!model || typeof model !== 'string') return null;
  return model.trim().replace(/-\d{8}$/, '');
}

/**
 * Look up base rates for a model. Unknown (post-normalization) → known:false
 * with zero rates, so callers can surface an UNKNOWN row rather than silently
 * pricing at $0.
 */
export function priceFor(model) {
  const id = normalizeModelId(model);
  if (id && Object.prototype.hasOwnProperty.call(PRICING, id)) {
    return { id, known: true, ...PRICING[id] };
  }
  return { id, known: false, input: 0, output: 0 };
}

/**
 * Estimate USD for one usage record.
 * usage: { uncached_input_tokens, output_tokens, cache_read_input_tokens,
 *          cache_creation_input_tokens, ephemeral_1h_input_tokens? }
 *
 * cache_creation is priced at the 5-minute write rate (1.25×) by default —
 * Charlie's Slice 3f cache uses 5m TTL and reports ephemeral_1h = 0. If an
 * ephemeral_1h portion is present it is priced at 2× and the remainder at
 * 1.25×, so the estimate stays correct if 1h TTL is ever enabled.
 *
 * Returns { usd, known, normalized }. Unknown model → usd:0, known:false.
 */
export function estimateCostUsd(model, usage = {}) {
  const p = priceFor(model);
  const M = 1_000_000;
  const ui = num(usage.uncached_input_tokens);
  const out = num(usage.output_tokens);
  const cr = num(usage.cache_read_input_tokens);
  const ccTotal = num(usage.cache_creation_input_tokens);
  const cc1h = Math.min(num(usage.ephemeral_1h_input_tokens), ccTotal);
  const cc5m = Math.max(0, ccTotal - cc1h);

  const usd = (
    ui * p.input
    + out * p.output
    + cr * p.input * CACHE_READ_MULT
    + cc5m * p.input * CACHE_WRITE_5M_MULT
    + cc1h * p.input * CACHE_WRITE_1H_MULT
  ) / M;

  return { usd, known: p.known, normalized: p.id };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
