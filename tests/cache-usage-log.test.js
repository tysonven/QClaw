/**
 * Slice 3f — cache-usage.log writer tests.
 * Run: node tests/cache-usage-log.test.js
 *
 * Covers:
 *   - one entry per appendCacheUsage call (JSONL shape)
 *   - all §7.2 fields present with correct types
 *   - user_id scrub catches sk-(ant-)? prefix, Bearer prefix, Telegram
 *     bot-token shape
 *   - QCLAW_CACHE_USAGE_LOG_PATH env override
 *   - tools_hash deterministic for same order, changes on shuffle
 *   - seconds_since_last_call computes correctly across consecutive calls
 *   - first-write-after-reset emits seconds_since_last_call: null
 *   - mode 0o600 applied on file create
 *   - rotation: when file > 50 MB the existing file moves to .log.1 and a
 *     fresh file is created with mode 0o600
 *   - cache_control_rejection_message persists in subsequent entries when
 *     caller passes it
 *   - ephemeral_extraction_failed flag landings
 *
 * Design ref: /tmp/slice3f_design.md §7.2, §7.3.
 */

import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, openSync, closeSync, ftruncateSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendCacheUsage,
  toolsHash,
  __resetCacheUsageLogForTests,
} from '../src/observability/cache-usage-log.js';

let passed = 0;
let failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

const tmp = mkdtempSync(join(tmpdir(), 'qclaw-cul-'));
const logPath = join(tmp, 'cache-usage.log');
process.env.QCLAW_CACHE_USAGE_LOG_PATH = logPath;

// Helper: read JSONL lines from the test log path.
function readLines() {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

// Helper: reset between sections.
function resetLog() {
  __resetCacheUsageLogForTests();
  if (existsSync(logPath)) rmSync(logPath);
  if (existsSync(logPath + '.1')) rmSync(logPath + '.1');
}

// ─── Section 1: shape and required fields ─────────────────────────────
console.log('Section 1 — one entry per call, §7.2 field shape:');

resetLog();
appendCacheUsage({
  model: 'claude-haiku-4-5-20251001',
  channel: 'telegram',
  userId: '1375806243',
  input_tokens: 50,
  output_tokens: 200,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 8421,
  ephemeral_5m_input_tokens: 0,
  ephemeral_1h_input_tokens: 0,
  bootstrap_cache_hit: true,
  bootstrap_present: true,
  cache_control_emitted: true,
  tools: [{ name: 'a' }, { name: 'b' }],
  had_on_demand_skills: false,
  tool_loop_iteration: 1,
});

{
  const lines = readLines();
  check('exactly one entry written', lines.length === 1, `got ${lines.length}`);
  const e = lines[0];
  check('ts is ISO 8601', typeof e.ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(e.ts));
  check('model preserved', e.model === 'claude-haiku-4-5-20251001');
  check('channel preserved', e.channel === 'telegram');
  check('user_id is "1375806243" (no scrub for plain numeric)', e.user_id === '1375806243');
  check('input_tokens=50', e.input_tokens === 50);
  check('output_tokens=200', e.output_tokens === 200);
  check('cache_creation_input_tokens=0', e.cache_creation_input_tokens === 0);
  check('cache_read_input_tokens=8421', e.cache_read_input_tokens === 8421);
  check('ephemeral_5m_input_tokens=0', e.ephemeral_5m_input_tokens === 0);
  check('ephemeral_1h_input_tokens=0', e.ephemeral_1h_input_tokens === 0);
  check('bootstrap_cache_hit=true', e.bootstrap_cache_hit === true);
  check('bootstrap_present=true', e.bootstrap_present === true);
  check('cache_control_emitted=true', e.cache_control_emitted === true);
  check('tools_count=2', e.tools_count === 2);
  check('tools_hash is non-empty 8-char hex', typeof e.tools_hash === 'string' && /^[0-9a-f]{8}$/.test(e.tools_hash), `got: ${e.tools_hash}`);
  check('had_on_demand_skills=false', e.had_on_demand_skills === false);
  check('tool_loop_iteration=1', e.tool_loop_iteration === 1);
  check('seconds_since_last_call=null on first write', e.seconds_since_last_call === null);
  check('no cache_control_rejection_message field (absent path)', !('cache_control_rejection_message' in e));
  check('no runtime_invariant_failed field (absent path)', !('runtime_invariant_failed' in e));
  check('no fail_open_triggered field (absent path)', !('fail_open_triggered' in e));
}

// ─── Section 2: token-scrub ───────────────────────────────────────────
console.log('\nSection 2 — token-scrub on user_id:');

resetLog();
const scrubCases = [
  { in: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', expect: '<scrubbed>' },
  { in: 'sk-ant-admin-anothersecret',              expect: '<scrubbed>' },
  { in: 'Bearer some-token-here',                  expect: '<scrubbed>' },
  { in: 'bearer mixed-case',                       expect: '<scrubbed>' },
  { in: '8112345678:AAEhBP3jB9TgZNB5kqg6xPv4w9bzPq-zZ_g', expect: '<scrubbed>' },
  { in: '1375806243',                               expect: '1375806243' },
  { in: null,                                       expect: null },
  { in: 'normal-user-id',                           expect: 'normal-user-id' },
];

for (const c of scrubCases) {
  resetLog();
  appendCacheUsage({ model: 'm', userId: c.in });
  const lines = readLines();
  const got = lines[0]?.user_id ?? null;
  check(`scrub(${JSON.stringify(c.in)?.slice(0, 40)}) → ${JSON.stringify(c.expect)}`,
    got === c.expect,
    `got ${JSON.stringify(got)}`);
}

// ─── Section 3: tools_hash deterministic ──────────────────────────────
console.log('\nSection 3 — toolsHash determinism and order sensitivity:');

{
  const t1 = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const t2 = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const t3 = [{ name: 'b' }, { name: 'a' }, { name: 'c' }]; // shuffled
  const t4 = [{ name: 'a' }, { name: 'b' }];                // shorter
  check('identical name arrays → identical hash', toolsHash(t1) === toolsHash(t2));
  check('shuffled order → different hash', toolsHash(t1) !== toolsHash(t3));
  check('shorter array → different hash', toolsHash(t1) !== toolsHash(t4));
  check('empty array → empty string', toolsHash([]) === '');
  check('non-array → empty string', toolsHash(null) === '');
  check('hash is 8 hex chars', /^[0-9a-f]{8}$/.test(toolsHash(t1)));
}

// ─── Section 4: seconds_since_last_call accounting ────────────────────
console.log('\nSection 4 — seconds_since_last_call across consecutive calls:');

resetLog();
appendCacheUsage({ model: 'm' });
// Force a small delay then second write — sleep is sync via Date.now() loop.
const start = Date.now();
while (Date.now() - start < 1100) { /* spin ~1.1s */ }
appendCacheUsage({ model: 'm' });

{
  const lines = readLines();
  check('two entries written', lines.length === 2);
  check('first entry: seconds_since_last_call=null', lines[0].seconds_since_last_call === null);
  check('second entry: seconds_since_last_call ≥ 1', lines[1].seconds_since_last_call >= 1, `got: ${lines[1].seconds_since_last_call}`);
  check('second entry: seconds_since_last_call ≤ 5 (sanity)', lines[1].seconds_since_last_call <= 5);
}

// After reset, _lastWriteTs goes back to null — next write should report null again.
resetLog();
appendCacheUsage({ model: 'm' });
{
  const lines = readLines();
  check('after __reset…ForTests: next entry has seconds_since_last_call=null',
    lines[0].seconds_since_last_call === null);
}

// ─── Section 5: file mode 0o600 on create ─────────────────────────────
console.log('\nSection 5 — file mode 0o600 on create:');

resetLog();
appendCacheUsage({ model: 'm' });
{
  const mode = statSync(logPath).mode & 0o777;
  check('mode is 0o600', mode === 0o600, `got: ${mode.toString(8)}`);
}

// ─── Section 6: rotation when file > 50 MB ────────────────────────────
console.log('\nSection 6 — rotation at 50 MB threshold:');

resetLog();
// Pre-create a >50 MB file by writing zeros via ftruncate.
const fd = openSync(logPath, 'w');
ftruncateSync(fd, 50 * 1024 * 1024 + 100);
closeSync(fd);

const sizeBeforeAppend = statSync(logPath).size;
check('pre-condition: log file exceeds 50 MB',
  sizeBeforeAppend > 50 * 1024 * 1024,
  `got: ${sizeBeforeAppend}`);

appendCacheUsage({ model: 'm' });

{
  const rotated = existsSync(logPath + '.1');
  check('rotation moves old file to .log.1', rotated);
  const rotatedSize = rotated ? statSync(logPath + '.1').size : -1;
  check('rotated file is the pre-existing oversize one', rotatedSize === sizeBeforeAppend, `got: ${rotatedSize}`);
  const newSize = statSync(logPath).size;
  check('new log file contains just the post-rotation entry', newSize > 0 && newSize < 2000, `got: ${newSize}`);
  const newMode = statSync(logPath).mode & 0o777;
  check('new log file has mode 0o600 after rotation', newMode === 0o600, `got: ${newMode.toString(8)}`);
  const lines = readLines();
  check('new log file has exactly 1 JSONL line post-rotation', lines.length === 1);
}

// Trigger another rotation — the existing .log.1 must be overwritten (2-generation cap).
{
  const fd2 = openSync(logPath, 'w');
  ftruncateSync(fd2, 50 * 1024 * 1024 + 100);
  closeSync(fd2);
  const newOversizeMarker = statSync(logPath).size;
  appendCacheUsage({ model: 'm' });
  const rot1Size = statSync(logPath + '.1').size;
  check('second rotation: .log.1 now reflects the second pre-rotation size (only 2 generations kept)',
    rot1Size === newOversizeMarker,
    `got ${rot1Size}, expected ${newOversizeMarker}`);
}

// ─── Section 7: cache_control_rejection_message + flags ───────────────
console.log('\nSection 7 — fail-open observability flags:');

resetLog();
appendCacheUsage({
  model: 'm',
  cache_control_emitted: false,
  cache_control_rejection_message: 'cache_control unsupported on this model',
  fail_open_triggered: true,
  fail_open_reason: 'cache_control unsupported',
});
appendCacheUsage({
  model: 'm',
  cache_control_emitted: false,
  cache_control_rejection_message: 'cache_control unsupported on this model',
});

{
  const lines = readLines();
  check('two entries written', lines.length === 2);
  check('entry 1: fail_open_triggered=true', lines[0].fail_open_triggered === true);
  check('entry 1: fail_open_reason preserved', lines[0].fail_open_reason === 'cache_control unsupported');
  check('entry 1: cache_control_rejection_message preserved',
    lines[0].cache_control_rejection_message === 'cache_control unsupported on this model');
  check('entry 1: cache_control_emitted=false', lines[0].cache_control_emitted === false);
  check('entry 2: rejection message persists', lines[1].cache_control_rejection_message === 'cache_control unsupported on this model');
  check('entry 2: no fail_open_triggered (only on the actual fail-open turn)', !('fail_open_triggered' in lines[1]));
}

// ─── Section 8: runtime_invariant_failed + ephemeral_extraction_failed ─
console.log('\nSection 8 — runtime_invariant_failed + ephemeral_extraction_failed:');

resetLog();
appendCacheUsage({
  model: 'm',
  runtime_invariant_failed: true,
  cache_control_emitted: false,
});
appendCacheUsage({
  model: 'm',
  cache_creation_input_tokens: 8000,
  ephemeral_5m_input_tokens: 0,
  ephemeral_1h_input_tokens: 0,
  ephemeral_extraction_failed: true,
});

{
  const lines = readLines();
  check('entry 1: runtime_invariant_failed=true', lines[0].runtime_invariant_failed === true);
  check('entry 2: ephemeral_extraction_failed=true', lines[1].ephemeral_extraction_failed === true);
  check('entry 2: cache_creation_input_tokens preserved (8000)',
    lines[1].cache_creation_input_tokens === 8000);
}

// ─── Section 9: env path override ─────────────────────────────────────
console.log('\nSection 9 — QCLAW_CACHE_USAGE_LOG_PATH override:');

const altPath = join(tmp, 'alt-cache-usage.log');
const originalLineCount = existsSync(logPath)
  ? readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).length
  : 0;
process.env.QCLAW_CACHE_USAGE_LOG_PATH = altPath;
__resetCacheUsageLogForTests();
appendCacheUsage({ model: 'm' });
check('append lands at overridden path', existsSync(altPath));
{
  const newLineCount = existsSync(logPath)
    ? readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).length
    : 0;
  check('original logPath line count unchanged after redirected write',
    newLineCount === originalLineCount,
    `before: ${originalLineCount}, after: ${newLineCount}`);
}

process.env.QCLAW_CACHE_USAGE_LOG_PATH = logPath; // restore for cleanup

// ─── Cleanup ──────────────────────────────────────────────────────────
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
delete process.env.QCLAW_CACHE_USAGE_LOG_PATH;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
