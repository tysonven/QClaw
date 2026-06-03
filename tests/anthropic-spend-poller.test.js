/**
 * Slice 3g Unit 1 — spend poller + pricing tests.
 * Run: node tests/anthropic-spend-poller.test.js
 *
 * Covers: unanchored secret scrub (incl. nested raw_api_response + mid-string
 * keys), cost_report parsing/aggregation, daily-row build, pagination, auth +
 * HTTP error paths, admin-key-type guard, idempotent upsert request shape,
 * and pricing model-id normalization (dated→family) + unknown-model surfacing.
 * Design ref: /tmp/slice3g_design.md §1, §7, §9.
 */

import {
  scrubSecrets, parseCostReport, buildDailyRows, fetchCostReport, upsertDaily,
  pollAndStore, utcDate, AuthError,
} from '../src/observability/anthropic-spend-poller.js';
import { normalizeModelId, priceFor, estimateCostUsd } from '../src/observability/pricing.js';

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label} ${detail}`); failed++; }
}
async function throws(fn, Type) {
  try { await fn(); return false; } catch (e) { return Type ? e instanceof Type : true; }
}
// URL-routing mock fetch factory
function mockFetch(routes) {
  return async (url, opts = {}) => {
    for (const [pat, handler] of routes) {
      if (url.includes(pat)) return handler(url, opts);
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'no route' };
  };
}
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

console.log('scrubSecrets:');
check('mid-string sk-ant- scrubbed', scrubSecrets('err: sk-ant-admin01-SECRETxyz happened') === 'err: <scrubbed> happened');
check('sk-ant-api03 scrubbed', !scrubSecrets('sk-ant-api03-abc_DEF-123').includes('abc_DEF'));
check('telegram token scrubbed', scrubSecrets('123456789:AAEabcdefghijklmnopqrstuvwxyz0123456') === '<scrubbed>');
check('multiple keys in one string', scrubSecrets('a sk-ant-x1234567 b sk-ant-y8901234 c').split('<scrubbed>').length === 3);
check('nested object planted key scrubbed', scrubSecrets({ a: { b: 'sk-ant-admin01-PLANTED999' } }).a.b === '<scrubbed>');
check('array scrubbed', scrubSecrets(['ok', 'sk-ant-zzz123456']).join(',') === 'ok,<scrubbed>');
check('number passthrough', scrubSecrets(42) === 42);
check('null passthrough', scrubSecrets(null) === null);
check('non-key string untouched', scrubSecrets('hello world') === 'hello world');

console.log('parseCostReport:');
// NOTE: cost_report `amount` is in CENTS — values below are ×100 of the
// dollar figure being asserted (150 cents = $1.50).
const payload = {
  data: [
    { starting_at: '2026-05-18T00:00:00Z', results: [
      { amount: '150', model: 'claude-haiku-4-5-20251001', token_type: 'uncached_input_tokens' },
      { amount: '50', model: 'claude-haiku-4-5-20251001', token_type: 'output_tokens' },
      { amount: '200', model: 'claude-sonnet-4-6', token_type: 'uncached_input_tokens' },
    ] },
    { starting_at: '2026-05-19T00:00:00Z', results: [
      { amount: '300', model: 'claude-opus-4-5-20251101', token_type: 'output_tokens' },
    ] },
  ],
};
const parsed = parseCostReport(payload);
check('two days parsed', Object.keys(parsed).length === 2);
check('day total sums all amounts (cents→$)', parsed['2026-05-18'].total_cost_usd === 4.0);
check('model_breakdown accumulates same model', parsed['2026-05-18'].model_breakdown['claude-haiku-4-5-20251001'] === 2.0);
check('model_breakdown distinct model', parsed['2026-05-18'].model_breakdown['claude-sonnet-4-6'] === 2.0);
check('breakdown reconciles to total', Object.values(parsed['2026-05-18'].model_breakdown).reduce((a, b) => a + b, 0) === parsed['2026-05-18'].total_cost_usd);
check('second day total', parsed['2026-05-19'].total_cost_usd === 3.0);
check('CENTS→USD conversion: amount 1564.68 → $15.6468', parseCostReport({ data: [{ starting_at: '2026-05-07T00:00:00Z', results: [{ amount: '1564.68', model: 'claude-sonnet-4-6' }] }] })['2026-05-07'].total_cost_usd === 15.6468);
check('empty payload → {}', Object.keys(parseCostReport({})).length === 0);
check('non-finite amount ignored', parseCostReport({ data: [{ starting_at: '2026-05-20T00:00:00Z', results: [{ amount: 'NaN', model: 'x' }, { amount: '100', model: 'x' }] }] })['2026-05-20'].total_cost_usd === 1);
const plantedRaw = parseCostReport({ data: [{ starting_at: '2026-05-21T00:00:00Z', results: [{ amount: '100', model: 'x', note: 'leaked sk-ant-admin01-PLANTED' }] }] });
check('raw_api_response scrubbed', !JSON.stringify(plantedRaw['2026-05-21'].raw).includes('PLANTED'));

console.log('buildDailyRows:');
const rows = buildDailyRows(parsed);
check('row count matches days', rows.length === 2);
check('row has date + total + breakdown + raw + source', rows[0].date && 'total_cost_usd' in rows[0] && 'model_breakdown' in rows[0] && 'raw_api_response' in rows[0]);
check('source is cost_report', rows[0].source === 'cost_report');

console.log('fetchCostReport:');
let capturedUrl = '';
const okFetch = mockFetch([['cost_report', (u) => { capturedUrl = u; return jsonRes(200, { data: [{ starting_at: '2026-05-18T00:00:00Z', results: [] }], has_more: false }); }]]);
await fetchCostReport({ adminKey: 'sk-ant-admin01-x', startDate: '2026-05-04', endDate: '2026-06-04', fetchImpl: okFetch });
check('URL has starting_at', capturedUrl.includes('starting_at=2026-05-04'));
check('URL has ending_at', capturedUrl.includes('ending_at=2026-06-04'));
check('URL has group_by description', decodeURIComponent(capturedUrl).includes('group_by[]=description'));
check('URL has limit=31', capturedUrl.includes('limit=31'));
check('401 → AuthError', await throws(() => fetchCostReport({ adminKey: 'k', startDate: 'a', endDate: 'b', fetchImpl: mockFetch([['cost_report', () => jsonRes(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } })]]) }), AuthError));
check('authentication_error body → AuthError', await throws(() => fetchCostReport({ adminKey: 'k', startDate: 'a', endDate: 'b', fetchImpl: mockFetch([['cost_report', () => ({ ok: true, status: 200, json: async () => ({ error: { type: 'authentication_error' } }), text: async () => '' })]]) }), AuthError));
check('500 → generic throw (not AuthError)', await throws(async () => { try { await fetchCostReport({ adminKey: 'k', startDate: 'a', endDate: 'b', fetchImpl: mockFetch([['cost_report', () => jsonRes(500, { error: 'boom' })]]) }); } catch (e) { if (e instanceof AuthError) throw new Error('wrong'); throw e; } }));
// pagination: two pages
let calls = 0;
const paged = mockFetch([['cost_report', () => { calls++; return calls === 1
  ? jsonRes(200, { data: [{ starting_at: '2026-05-18T00:00:00Z', results: [{ amount: '1', model: 'x' }] }], has_more: true, next_page: 'p2' })
  : jsonRes(200, { data: [{ starting_at: '2026-05-19T00:00:00Z', results: [{ amount: '2', model: 'x' }] }], has_more: false }); }]]);
const pagedRes = await fetchCostReport({ adminKey: 'sk-ant-admin01-x', startDate: 'a', endDate: 'b', fetchImpl: paged });
check('pagination merges pages', pagedRes.data.length === 2 && calls === 2);

console.log('upsertDaily:');
check('empty rows → no fetch, upserted 0', (await upsertDaily({ rows: [], supabaseUrl: 'http://x', serviceKey: 'k', fetchImpl: async () => { throw new Error('should not fetch'); } })).upserted === 0);
let upUrl = '', upHeaders = {};
await upsertDaily({ rows: [{ date: '2026-05-18' }], supabaseUrl: 'http://x/', serviceKey: 'srv', fetchImpl: async (u, o) => { upUrl = u; upHeaders = o.headers; return { ok: true, status: 201, text: async () => '' }; } });
check('upsert URL on_conflict=date', upUrl.includes('on_conflict=date'));
check('upsert merge-duplicates header', upHeaders.Prefer.includes('merge-duplicates'));
check('upsert uses service key auth', upHeaders.Authorization === 'Bearer srv');

console.log('pollAndStore guards + happy path:');
check('missing admin key throws', await throws(() => pollAndStore({ env: {}, startDate: 'a', endDate: 'b' })));
check('non-admin key throws', await throws(() => pollAndStore({ env: { ANTHROPIC_ADMIN_API_KEY: 'sk-ant-api03-x' }, startDate: 'a', endDate: 'b' })));
const happyFetch = mockFetch([
  ['cost_report', () => jsonRes(200, { data: [{ starting_at: '2026-05-18T00:00:00Z', results: [{ amount: '5', model: 'claude-haiku-4-5-20251001' }] }], has_more: false })],
  ['/rest/v1/anthropic_spend_daily', () => ({ ok: true, status: 201, text: async () => '' })],
]);
const summary = await pollAndStore({ env: { ANTHROPIC_ADMIN_API_KEY: 'sk-ant-admin01-x', SUPABASE_URL: 'http://sb', SUPABASE_SERVICE_ROLE_KEY: 'srv' }, startDate: '2026-05-18', endDate: '2026-05-19', fetchImpl: happyFetch });
check('happy path upserts 1 day', summary.upserted === 1 && summary.days === 1);
check('happy path returns dates', summary.dates[0] === '2026-05-18');

console.log('utcDate:');
check('utcDate -30 offsets', utcDate('2026-06-03T12:00:00Z', -30) === '2026-05-04');
check('utcDate +1 offsets', utcDate('2026-06-03T12:00:00Z', 1) === '2026-06-04');

console.log('pricing:');
check('normalize dated haiku → family', normalizeModelId('claude-haiku-4-5-20251001') === 'claude-haiku-4-5');
check('normalize dated sonnet-4 → family', normalizeModelId('claude-sonnet-4-20250514') === 'claude-sonnet-4');
check('normalize undated passthrough', normalizeModelId('claude-sonnet-4-6') === 'claude-sonnet-4-6');
check('dated haiku resolves known', priceFor('claude-haiku-4-5-20251001').known === true);
check('dated sonnet-4 resolves nonzero', estimateCostUsd('claude-sonnet-4-20250514', { uncached_input_tokens: 1_000_000 }).usd === 3.0);
check('opus-4-5 input priced $5/M', estimateCostUsd('claude-opus-4-5-20251101', { uncached_input_tokens: 1_000_000 }).usd === 5.0);
check('cache_read priced 0.1x', estimateCostUsd('claude-haiku-4-5', { cache_read_input_tokens: 1_000_000 }).usd === 0.1);
check('cache_creation priced 1.25x', estimateCostUsd('claude-haiku-4-5', { cache_creation_input_tokens: 1_000_000 }).usd === 1.25);
check('unknown model → known:false, usd 0', (() => { const r = estimateCostUsd('claude-imaginary-9', { uncached_input_tokens: 1e6 }); return r.known === false && r.usd === 0; })());

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
