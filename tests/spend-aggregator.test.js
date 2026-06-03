/**
 * Slice 3g Unit 1 — spend aggregator tests.
 * Run: node tests/spend-aggregator.test.js
 *
 * Covers: JSONL read with garbage-line skip, boundary-floored window_end,
 * half-open [start,end) membership (boundary-instant excluded), per-dimension
 * rollups (total/model/channel/user), UNKNOWN-model surfacing, dated-model
 * cost correctness, calendar-day reconciliation (charlie_est / org_authoritative
 * / reconciliation_gap incl. missing-daily case), re-run idempotency, and the
 * upsert request shape. Design ref: /tmp/slice3g_design.md §3, §9, §10.
 */

import {
  readCacheUsage, floorWindowEnd, recordCost, buildRollups, reconcileCalendarDay,
  fetchDailyTotal, upsertRollups, aggregate, utcDate,
} from '../src/observability/spend-aggregator.js';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label} ${detail}`); failed++; }
}
const find = (rows, wk, dim, key) => rows.find(r => r.window_kind === wk && r.dimension === dim && r.dimension_key === key);
async function throws(fn) { try { await fn(); return false; } catch { return true; } }

const NOW = new Date('2026-06-03T00:05:00Z');
const recs = [
  { ts: '2026-06-02T23:30:00Z', model: 'claude-haiku-4-5-20251001', input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, channel: 'telegram', user_id: 111 }, // $1.00
  { ts: '2026-06-02T12:00:00Z', model: 'claude-sonnet-4-6', input_tokens: 1_000_000, output_tokens: 0, channel: 'dashboard', user_id: null }, // $3.00
  { ts: '2026-05-20T00:00:00Z', model: 'claude-imaginary-9', input_tokens: 1_000_000, channel: 'telegram', user_id: 111 }, // unknown → $0
  { ts: '2026-06-03T00:00:00Z', model: 'claude-haiku-4-5', input_tokens: 1_000_000, channel: 'telegram', user_id: 111 }, // exactly 24h window_end → excluded
];

console.log('readCacheUsage:');
const dir = mkdtempSync(join(tmpdir(), 'agg-'));
const p = join(dir, 'cache-usage.log');
writeFileSync(p, JSON.stringify(recs[0]) + '\n' + 'GARBAGE NOT JSON\n' + JSON.stringify(recs[1]) + '\n');
const read = readCacheUsage(p);
check('parses valid JSONL lines', read.length === 2);
check('skips garbage line (no throw)', read[0].model === 'claude-haiku-4-5-20251001' && read[1].channel === 'dashboard');
check('missing file → []', readCacheUsage(join(dir, 'nope.log')).length === 0);
rmSync(dir, { recursive: true, force: true });

console.log('floorWindowEnd:');
check('1h → top of hour', floorWindowEnd('2026-06-03T00:05:30Z', '1h').toISOString() === '2026-06-03T00:00:00.000Z');
check('24h → UTC midnight', floorWindowEnd('2026-06-03T13:45:00Z', '24h').toISOString() === '2026-06-03T00:00:00.000Z');
check('30d → UTC midnight', floorWindowEnd('2026-06-03T13:45:00Z', '30d').toISOString() === '2026-06-03T00:00:00.000Z');

console.log('recordCost:');
check('haiku 1M input → $1.00', recordCost(recs[0]).usd === 1.0);
check('sonnet-4-6 1M input → $3.00', recordCost(recs[1]).usd === 3.0);
check('unknown model → known:false, $0', recordCost(recs[2]).known === false && recordCost(recs[2]).usd === 0);

console.log('buildRollups (now=2026-06-03T00:05Z):');
const rollups = buildRollups(recs, NOW);
check('1h total = recA only ($1, 1 turn)', find(rollups, '1h', 'total', 'all').est_cost_usd === 1.0 && find(rollups, '1h', 'total', 'all').turn_count === 1);
check('24h total = recA+recB ($4, 2 turns)', find(rollups, '24h', 'total', 'all').est_cost_usd === 4.0 && find(rollups, '24h', 'total', 'all').turn_count === 2);
check('boundary-instant rec (00:00:00Z) excluded from 24h', find(rollups, '24h', 'total', 'all').turn_count === 2);
check('30d total = recA+recB+recC ($4, 3 turns)', find(rollups, '30d', 'total', 'all').est_cost_usd === 4.0 && find(rollups, '30d', 'total', 'all').turn_count === 3);
check('30d total unknown_model_turns = 1', find(rollups, '30d', 'total', 'all').token_totals.unknown_model_turns === 1);
check('24h model haiku $1', find(rollups, '24h', 'model', 'claude-haiku-4-5').est_cost_usd === 1.0);
check('24h model sonnet-4-6 $3', find(rollups, '24h', 'model', 'claude-sonnet-4-6').est_cost_usd === 3.0);
check('30d surfaces UNKNOWN:claude-imaginary-9', !!find(rollups, '30d', 'model', 'UNKNOWN:claude-imaginary-9'));
check('24h channel telegram (recA)', find(rollups, '24h', 'channel', 'telegram').turn_count === 1);
check('24h channel dashboard (recB)', find(rollups, '24h', 'channel', 'dashboard').turn_count === 1);
check('24h user 111', find(rollups, '24h', 'user', '111').turn_count === 1);
check('24h user null → "null" key', !!find(rollups, '24h', 'user', 'null'));
check('window_end is boundary-floored ISO', find(rollups, '24h', 'total', 'all').window_end === '2026-06-03T00:00:00.000Z');
check('1h window_end top-of-hour', find(rollups, '1h', 'total', 'all').window_end === '2026-06-03T00:00:00.000Z');
check('token_totals has uncached_input', find(rollups, '24h', 'total', 'all').token_totals.uncached_input === 2_000_000);
check('all four windows produce a total row', ['1h', '24h', '7d', '30d'].every(w => !!find(rollups, w, 'total', 'all')));

console.log('idempotency:');
check('buildRollups twice identical for fixed now', JSON.stringify(buildRollups(recs, NOW)) === JSON.stringify(buildRollups(recs, NOW)));

console.log('reconcileCalendarDay (D-1 = 2026-06-02):');
const reconWith = reconcileCalendarDay(recs, 10.0, '2026-06-02');
check('charlie_est row = $4 (recA+recB), 2 turns', find(reconWith, 'calendar_day', 'total', 'charlie_est').est_cost_usd === 4.0 && find(reconWith, 'calendar_day', 'total', 'charlie_est').turn_count === 2);
check('boundary-instant (06-03T00:00) excluded from D-1', find(reconWith, 'calendar_day', 'total', 'charlie_est').turn_count === 2);
check('org_authoritative row = $10', find(reconWith, 'calendar_day', 'total', 'org_authoritative').est_cost_usd === 10.0);
check('reconciliation_gap = org - charlie = $6', find(reconWith, 'calendar_day', 'total', 'reconciliation_gap').est_cost_usd === 6.0);
check('window_end = D midnight', find(reconWith, 'calendar_day', 'total', 'charlie_est').window_end === '2026-06-03T00:00:00.000Z');
const reconNull = reconcileCalendarDay(recs, null, '2026-06-02');
check('missing daily → only charlie_est row', reconNull.length === 1 && reconNull[0].dimension_key === 'charlie_est');

console.log('fetchDailyTotal:');
check('returns number from row', (await fetchDailyTotal({ date: '2026-06-02', supabaseUrl: 'http://x', serviceKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => [{ total_cost_usd: '7.5' }] }) })) === 7.5);
check('empty rows → null', (await fetchDailyTotal({ date: '2026-06-02', supabaseUrl: 'http://x', serviceKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => [] }) })) === null);
check('non-ok → null', (await fetchDailyTotal({ date: '2026-06-02', supabaseUrl: 'http://x', serviceKey: 'k', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) })) === null);

console.log('upsertRollups:');
check('empty rows → upserted 0, no fetch', (await upsertRollups({ rows: [], supabaseUrl: 'http://x', serviceKey: 'k', fetchImpl: async () => { throw new Error('no'); } })).upserted === 0);
let ru = '', rh = {};
await upsertRollups({ rows: [{ window_kind: '1h' }], supabaseUrl: 'http://x/', serviceKey: 'srv', fetchImpl: async (u, o) => { ru = u; rh = o.headers; return { ok: true, status: 201, text: async () => '' }; } });
check('upsert on_conflict full unique key', ru.includes('on_conflict=window_kind,window_end,dimension,dimension_key'));
check('upsert merge-duplicates header', rh.Prefer.includes('merge-duplicates'));
// error path scrubs secrets (design §7 — every caught exception .message)
let scrubbed = false;
try {
  await upsertRollups({ rows: [{ window_kind: '1h' }], supabaseUrl: 'http://x', serviceKey: 'srv', fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'pg error near sk-ant-admin01-LEAKED999 token' }) });
} catch (e) { scrubbed = !e.message.includes('LEAKED999') && e.message.includes('<scrubbed>'); }
check('upsertRollups error message scrubs sk-ant key', scrubbed);

console.log('aggregate orchestrator:');
let postRows = 0;
const aggFetch = async (u, o) => {
  if (u.includes('select=total_cost_usd')) return { ok: true, json: async () => [{ total_cost_usd: '10.0' }] };
  if (o && o.method === 'POST') { postRows = JSON.parse(o.body).length; return { ok: true, status: 201, text: async () => '' }; }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};
const aggRes = await aggregate({ env: { SUPABASE_URL: 'http://sb', SUPABASE_SERVICE_ROLE_KEY: 'srv' }, now: NOW, fetchImpl: aggFetch, records: recs });
check('aggregate returns turn count', aggRes.turns === 4);
check('aggregate upserts rollups+reconciliation', aggRes.upserted === aggRes.rollups + aggRes.reconciliation && postRows === aggRes.upserted);
check('aggregate reconciliation has 3 rows (daily present)', aggRes.reconciliation === 3);
check('aggregate reports pricing as_of', typeof aggRes.pricingAsOf === 'string' && aggRes.pricingAsOf.length === 10);

console.log('utcDate:');
check('utcDate -1 = 2026-06-02', utcDate(NOW, -1) === '2026-06-02');

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
