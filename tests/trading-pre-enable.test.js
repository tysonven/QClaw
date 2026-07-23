/**
 * Trade Executor pre-enable — items 6 & 8 tests.
 * Run: node tests/trading-pre-enable.test.js
 *
 * Item 6: fetchDailyRealisedLoss (daily_loss_limit PnL check, fail-closed on
 * any query trouble, M2 throw on >1000 positions).
 * Item 8 (redesigned): Telegram OTP second factor — checkOtp/sendTelegram
 * helpers plus route-level tests of POST /api/trading/config and
 * POST /api/trading/confirm-enable via the fakeApp pattern
 * (see tests/agent-dashboard.test.js): inject a route-capturing fake express
 * app, run _setupAPI(), invoke the captured handlers with fake req/res.
 * Telegram, randomness and the clock are stubbed via server._otpDeps; the
 * Supabase writes are stubbed by swapping globalThis.fetch around each call.
 */

import {
  DashboardServer, fetchDailyRealisedLoss, checkOtp, sendTelegram,
} from '../src/dashboard/server.js';

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

const SB = 'https://example.supabase.co';
const KEY = 'svc-key';
// Deterministic clock so the closed_at window and OTP expiries are stable.
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
  check('query fetches limit=1001 (M2 overflow probe)', url.includes('limit=1001'), url);
  check('query orders deterministically (opened_at.asc)', url.includes('order=opened_at.asc'), url);
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
{
  // M2: exactly 1000 rows is still a trustworthy page; 1001 means overflow → throw.
  const rows1000 = Array.from({ length: 1000 }, () => ({ pnl: -0.01 }));
  const r = await fetchDailyRealisedLoss(SB, KEY, stubFetch({ json: rows1000 }), NOW);
  check('1000 rows → still ok (sums the page)', r.ok === true, JSON.stringify(r?.ok));
  const rows1001 = Array.from({ length: 1001 }, () => ({ pnl: -0.01 }));
  let threw = null;
  try { await fetchDailyRealisedLoss(SB, KEY, stubFetch({ json: rows1001 }), NOW); }
  catch (e) { threw = e.message; }
  check('1001 rows → throws daily_loss_position_count_exceeded',
    threw === 'daily_loss_position_count_exceeded', String(threw));
}

// ─── Item 8 (redesigned): checkOtp / sendTelegram helpers ──────────────
{
  const pending = { otp: '123456', expires_at: NOW + 300000 };
  check('correct OTP within TTL → true', checkOtp(pending, '123456', NOW) === true);
  check('numeric OTP input accepted', checkOtp(pending, 123456, NOW) === true);
  check('wrong OTP → false', checkOtp(pending, '654321', NOW) === false);
  check('expired OTP → false', checkOtp(pending, '123456', NOW + 300001) === false);
  check('no pending slot → false', checkOtp(null, '123456', NOW) === false);
  check('non-6-digit input → false', checkOtp(pending, '12345', NOW) === false);
  check('non-numeric input → false', checkOtp(pending, 'abcdef', NOW) === false);
  check('object input → false', checkOtp(pending, { otp: '123456' }, NOW) === false);
}
{
  const r = await sendTelegram({ token: '', chatId: '1', text: 'x' });
  check('sendTelegram without token → fail closed', r.ok === false);
  const f = stubFetch({ ok: true });
  const r2 = await sendTelegram({ token: 't', chatId: '1', text: 'x', fetchImpl: f });
  check('sendTelegram ok:true on 200', r2.ok === true && f.calls[0].includes('api.telegram.org'));
  const r3 = await sendTelegram({ token: 't', chatId: '1', text: 'x', fetchImpl: stubFetch({ throws: true }) });
  check('sendTelegram fetch throws → { ok:false }', r3.ok === false);
}

// ─── Item 8 (redesigned): route-level tests ────────────────────────────
// Route-capturing fake express app — records the last handler per "METHOD path".
function fakeApp() {
  const routes = {};
  const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'use', 'options', 'head', 'all'];
  return new Proxy({ routes }, {
    get(t, prop) {
      if (prop === 'routes') return t.routes;
      if (httpMethods.includes(prop)) {
        return (path, ...handlers) => {
          if (typeof path === 'string' && handlers.length) routes[`${prop} ${path}`] = handlers[handlers.length - 1];
        };
      }
      return () => {}; // tolerate any other app.* call during setup
    },
  });
}

function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

// Fresh server with stubbed Telegram / randomness / clock. `sent` records
// every Telegram send; clock is adjustable via clock.now for expiry tests.
function makeServer({ telegramOk = true } = {}) {
  const qclaw = { config: {}, agents: { list: () => [] }, memory: { getThreads: () => [] } };
  const server = new DashboardServer(qclaw);
  server.app = fakeApp();
  server._setupAPI();
  const sent = [];
  const clock = { now: NOW };
  server._otpDeps = {
    send: async (msg) => { sent.push(msg); return { ok: telegramOk }; },
    randomInt: () => 123456, // deterministic OTP for tests
    now: () => clock.now,
  };
  return { server, sent, clock };
}

// Runs the config/confirm handlers with globalThis.fetch stubbed so no real
// Supabase write can happen; records every (url, method, body) triple.
async function withSupabaseStub(fn) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, json: async () => [{ id: 1 }] };
  };
  try { return await fn(calls); } finally { globalThis.fetch = orig; }
}

{
  console.log('Route: POST /api/trading/config — C1 normalisation');
  const { server, sent } = makeServer();
  const handler = server.app.routes['post /api/trading/config'];
  const confirm = server.app.routes['post /api/trading/confirm-enable'];
  check('config handler registered', typeof handler === 'function');
  check('confirm-enable handler registered', typeof confirm === 'function');
  check('generate-confirm-token route is gone',
    !('post /api/trading/generate-confirm-token' in server.app.routes));

  // Postgres-truthy strings must normalise to false: 200, no OTP, boolean false written.
  for (const spelling of ['t', 'TRUE', 'yes', 'on', '1']) {
    await withSupabaseStub(async (calls) => {
      const res = fakeRes();
      await handler({ body: { trading_enabled: spelling, max_position_usdc: 10, min_edge_threshold: 7, daily_loss_limit: 20 } }, res);
      const patch = calls.find(c => c.method === 'PATCH');
      check(`'${spelling}' → 200, no OTP, writes boolean false`,
        res.statusCode === 200 && res.body?.ok === true && sent.length === 0
        && patch && patch.body.trading_enabled === false,
        `status=${res.statusCode} sent=${sent.length} wrote=${JSON.stringify(patch?.body?.trading_enabled)}`);
    });
  }

  // Field-only save (no trading_enabled key) must not touch the brake.
  await withSupabaseStub(async (calls) => {
    const res = fakeRes();
    await handler({ body: { max_position_usdc: 12, min_edge_threshold: 7, daily_loss_limit: 20 } }, res);
    const patch = calls.find(c => c.method === 'PATCH');
    check('field-only save → 200, trading_enabled absent from write',
      res.statusCode === 200 && patch && !('trading_enabled' in patch.body),
      JSON.stringify(patch?.body));
  });
}

{
  console.log('Route: enable → 202 otp_sent → confirm-enable');
  const { server, sent, clock } = makeServer();
  const handler = server.app.routes['post /api/trading/config'];
  const confirm = server.app.routes['post /api/trading/confirm-enable'];

  await withSupabaseStub(async (calls) => {
    const res = fakeRes();
    await handler({ body: { trading_enabled: true, max_position_usdc: 10, min_edge_threshold: 7, daily_loss_limit: 20 } }, res);
    check('true → 202 otp_sent', res.statusCode === 202 && res.body?.status === 'otp_sent', JSON.stringify(res.body));
    check('OTP sent via Telegram exactly once', sent.length === 1 && sent[0].text.includes('123456'));
    check('OTP not present anywhere in the HTTP response', !JSON.stringify(res.body).includes('123456'), JSON.stringify(res.body));
    check('trading_enabled NOT written during enable request',
      calls.every(c => !c.body || !('trading_enabled' in c.body)),
      JSON.stringify(calls.map(c => c.body)));
    check('limit fields ARE persisted with the enable request',
      calls.some(c => c.method === 'PATCH' && c.body?.max_position_usdc === 10));
  });

  // Wrong OTP → 403, nothing written.
  await withSupabaseStub(async (calls) => {
    const res = fakeRes();
    await confirm({ body: { otp: '999999' } }, res);
    check('wrong OTP → 403 invalid_or_expired_otp',
      res.statusCode === 403 && res.body?.error === 'invalid_or_expired_otp' && calls.length === 0,
      JSON.stringify(res.body));
  });

  // Correct OTP → 200, writes exactly { trading_enabled: true }.
  await withSupabaseStub(async (calls) => {
    const res = fakeRes();
    await confirm({ body: { otp: '123456' } }, res);
    const patch = calls.find(c => c.method === 'PATCH');
    check('correct OTP → 200 trading_enabled',
      res.statusCode === 200 && res.body?.status === 'trading_enabled', JSON.stringify(res.body));
    check('confirm writes only { trading_enabled: true }',
      patch && JSON.stringify(patch.body) === JSON.stringify({ trading_enabled: true }), JSON.stringify(patch?.body));
  });

  // OTP is single-use: replaying the same code must 403.
  await withSupabaseStub(async (calls) => {
    const res = fakeRes();
    await confirm({ body: { otp: '123456' } }, res);
    check('replayed OTP → 403 (single-use)', res.statusCode === 403 && calls.length === 0, `status=${res.statusCode}`);
  });

  // Expired OTP → 403.
  await withSupabaseStub(async () => {
    const res202 = fakeRes();
    await handler({ body: { trading_enabled: true } }, res202);
    clock.now = NOW + 300001; // 5 min + 1 ms later
    const res = fakeRes();
    await confirm({ body: { otp: '123456' } }, res);
    check('expired OTP → 403', res.statusCode === 403 && res.body?.error === 'invalid_or_expired_otp', JSON.stringify(res.body));
    clock.now = NOW;
  });
}

{
  console.log('Route: disable + Telegram failure paths');
  const { server, sent } = makeServer();
  const handler = server.app.routes['post /api/trading/config'];

  // Disable needs no OTP and clears any pending one.
  await withSupabaseStub(async () => {
    const res202 = fakeRes();
    await handler({ body: { trading_enabled: true } }, res202); // arm a pending OTP
    const res = fakeRes();
    await handler({ body: { trading_enabled: false, max_position_usdc: 10, min_edge_threshold: 7, daily_loss_limit: 20 } }, res);
    check('disable → 200 with no OTP required',
      res.statusCode === 200 && res.body?.ok === true, JSON.stringify(res.body));
    check('disable cancels the pending OTP', server.pendingTradeEnable === null);
  });

  // Telegram down → 503, fail closed, no pending OTP.
  const down = makeServer({ telegramOk: false });
  const downHandler = down.server.app.routes['post /api/trading/config'];
  await withSupabaseStub(async (calls) => {
    const res = fakeRes();
    await downHandler({ body: { trading_enabled: true } }, res);
    check('Telegram unavailable → 503 telegram_unavailable',
      res.statusCode === 503 && res.body?.error === 'telegram_unavailable', JSON.stringify(res.body));
    check('failed send leaves no pending OTP', down.server.pendingTradeEnable === null);
    check('failed send never writes trading_enabled',
      calls.every(c => !c.body || !('trading_enabled' in c.body)));
  });
}

{
  console.log('Route: /api/trading/execute — M2 position-count overflow → 503');
  const { server } = makeServer();
  const exec = server.app.routes['post /api/trading/execute'];
  const orig = globalThis.fetch;
  // Config read says enabled (stub only — nothing written) so the flow reaches
  // the PnL check; 1001 positions must 503 before any execution is attempted.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('trading_config')) return { ok: true, json: async () => [{ trading_enabled: true, max_position_usdc: 25, daily_loss_limit: 20 }] };
    if (u.includes('trading_positions')) return { ok: true, json: async () => Array.from({ length: 1001 }, () => ({ pnl: -0.01 })) };
    return { ok: true, json: async () => [] };
  };
  try {
    const res = fakeRes();
    await exec({ body: { market_id: '0x' + 'a'.repeat(64), direction: 'YES', amount: 5 } }, res);
    check('1001 positions → 503 pnl_check_unavailable on execute route',
      res.statusCode === 503 && res.body?.error === 'pnl_check_unavailable', JSON.stringify(res.body));
  } finally { globalThis.fetch = orig; }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
