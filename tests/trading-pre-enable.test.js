/**
 * Trade Executor pre-enable — items 6 & 8 unit tests.
 * Run: node tests/trading-pre-enable.test.js
 *
 * Covers the pure/injectable helpers extracted for item 6 (daily_loss_limit
 * PnL check, fail-closed on any query trouble) and item 8 (HMAC confirm-token
 * mint + validate, ±60s window, timing-safe). Route-level behaviour (the 403s,
 * the 503s, the rate limiter) is exercised live per the brief's verification
 * section — these tests lock the logic that can't be safely broken on demand.
 */

import {
  fetchDailyRealisedLoss, generateConfirmToken, validateConfirmToken,
} from '../src/dashboard/server.js';

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

const SB = 'https://example.supabase.co';
const KEY = 'svc-key';
// Deterministic clock so the closed_at window and token timestamps are stable.
const NOW = Date.parse('2026-07-23T14:30:00Z');

// A stub fetch that records the URL it was called with and returns a scripted body.
function stubFetch({ ok = true, json = [], throws = false } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (throws) throw new Error('network down');
    return { ok, json: async () => json };
  };
  impl.calls = calls;
  return impl;
}

// ─── Item 6: fetchDailyRealisedLoss ────────────────────────────────────
{
  const f = stubFetch({ json: [{ pnl: -5 }, { pnl: -3.5 }, { pnl: 2 }] });
  const r = await fetchDailyRealisedLoss(SB, KEY, f, NOW);
  check('sums closed-position pnl (signed)', r.ok === true && Math.abs(r.daily_loss - (-6.5)) < 1e-9,
    JSON.stringify(r));
  const url = f.calls[0];
  check('query filters status=eq.closed', url.includes('status=eq.closed'), url);
  check('query selects only pnl', url.includes('select=pnl'), url);
  check('query windows on closed_at >= UTC midnight',
    url.includes('closed_at=gte.') && url.includes(encodeURIComponent('2026-07-23T00:00:00.000Z')), url);
  check('query caps at 1000 rows', url.includes('limit=1000'), url);
}
{
  const r = await fetchDailyRealisedLoss(SB, KEY, stubFetch({ json: [] }), NOW);
  check('no closed positions → ok, daily_loss 0', r.ok === true && r.daily_loss === 0, JSON.stringify(r));
}
{
  const r = await fetchDailyRealisedLoss(SB, KEY, stubFetch({ json: [{ pnl: -4 }, { pnl: null }, { pnl: 'x' }, { pnl: -1 }] }), NOW);
  check('non-finite pnl values are skipped', r.ok === true && Math.abs(r.daily_loss - (-5)) < 1e-9, JSON.stringify(r));
}
{
  const r = await fetchDailyRealisedLoss(SB, KEY, stubFetch({ ok: false, json: { code: 'PGRST' } }), NOW);
  check('non-OK response → fail closed { ok:false }', r.ok === false, JSON.stringify(r));
}
{
  const r = await fetchDailyRealisedLoss(SB, KEY, stubFetch({ json: { not: 'an array' } }), NOW);
  check('malformed (non-array) body → fail closed', r.ok === false, JSON.stringify(r));
}
{
  const r = await fetchDailyRealisedLoss(SB, KEY, stubFetch({ throws: true }), NOW);
  check('fetch throws → fail closed', r.ok === false, JSON.stringify(r));
}

// ─── Item 8: generateConfirmToken / validateConfirmToken ───────────────
const SECRET = 'test-webhook-secret';
{
  const minted = generateConfirmToken(SECRET, NOW);
  check('mint returns token + expires_at', !!minted && /^\d+\.[0-9a-f]{64}$/.test(minted.token) && minted.expires_at === Math.floor(NOW / 1000) + 60,
    JSON.stringify(minted));
  check('round-trip: freshly minted token validates', validateConfirmToken(minted.token, SECRET, NOW) === true);
}
{
  check('no secret → mint returns null', generateConfirmToken('', NOW) === null);
  check('no secret → validate false', validateConfirmToken('123.abc', '', NOW) === false);
}
{
  const minted = generateConfirmToken(SECRET, NOW);
  check('token valid at +59s (within window)', validateConfirmToken(minted.token, SECRET, NOW + 59_000) === true);
  check('token valid at -59s (clock skew, within window)', validateConfirmToken(minted.token, SECRET, NOW - 59_000) === true);
  check('token expired at +61s → false', validateConfirmToken(minted.token, SECRET, NOW + 61_000) === false);
}
{
  const minted = generateConfirmToken(SECRET, NOW);
  check('wrong secret → false', validateConfirmToken(minted.token, 'other-secret', NOW) === false);
  // Tamper the timestamp: HMAC no longer matches the embedded ts.
  const [, sig] = minted.token.split('.');
  const forged = `${Math.floor(NOW / 1000)}.${'0'.repeat(64)}`;
  check('forged signature → false', validateConfirmToken(forged, SECRET, NOW) === false);
  const shiftedTs = `${Math.floor(NOW / 1000) + 1}.${sig}`;
  check('timestamp shifted under a valid-looking sig → false', validateConfirmToken(shiftedTs, SECRET, NOW) === false);
}
{
  check('non-string token → false', validateConfirmToken(null, SECRET, NOW) === false);
  check('malformed (no dot) → false', validateConfirmToken('deadbeef', SECRET, NOW) === false);
  check('malformed (non-numeric ts) → false', validateConfirmToken('abc.' + '0'.repeat(64), SECRET, NOW) === false);
  check('malformed (short sig) → false', validateConfirmToken(`${Math.floor(NOW / 1000)}.abcd`, SECRET, NOW) === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
