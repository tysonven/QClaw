/**
 * Slice 3e — grammY error classifier unit tests.
 * Run: node tests/grammy-error-classifier.test.js
 */

import { classify, _internal } from '../src/channels/grammy-error-classifier.js';

let passed = 0;
let failed = 0;

function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// Deterministic random for jitter tests.
function fixedRandom(value) {
  return () => value;
}

// ── Section 1: transient HTTP statuses ────────────────────────────────
console.log('Transient HTTP statuses:');

for (const code of [429, 502, 503, 504]) {
  const r = classify({ error_code: code, description: 'x' }, { attempt: 1 });
  check(`error_code ${code} → transient`,
    r.kind === 'transient' && r.shouldRetry === true && r.httpStatus === code,
    JSON.stringify(r));
}

// ── Section 2: 429 retry_after handling ───────────────────────────────
console.log('\n429 retry_after handling:');

{
  const r = classify({ error_code: 429, parameters: { retry_after: 30 } }, { attempt: 1, random: fixedRandom(0.5) });
  // retry_after = 30s = 30000ms. Base attempt-1 = 1000ms. max = 30000.
  check('429 with retry_after=30 → backoffMs=30000',
    r.kind === 'transient' && r.backoffMs === 30000,
    `got backoffMs=${r.backoffMs}`);
}

{
  const r = classify({ error_code: 429, parameters: { retry_after: 200 } }, { attempt: 1 });
  // retry_after = 200s = 200000ms. Capped to 60000ms.
  check('429 with retry_after=200 → backoffMs capped to 60000',
    r.kind === 'transient' && r.backoffMs === 60000,
    `got backoffMs=${r.backoffMs}`);
}

{
  const r = classify({ error_code: 429, parameters: { retry_after: 1 } }, { attempt: 5 });
  // retry_after = 1000ms. Base attempt-5 = 16000ms. Max wins.
  check('429 attempt-5 with retry_after=1 → max(1000,16000) ignores retry_after',
    r.kind === 'transient' && r.backoffMs === 16000,
    `got backoffMs=${r.backoffMs}`);
}

{
  const r = classify({ error_code: 429 }, { attempt: 1, random: fixedRandom(0.5) });
  // No retry_after → jittered base. random=0.5 → jitter=0 → exactly 1000.
  check('429 with no retry_after → jittered base',
    r.kind === 'transient' && r.backoffMs === 1000,
    `got backoffMs=${r.backoffMs}`);
}

// ── Section 3: non-transient HTTP statuses ────────────────────────────
console.log('\nNon-transient HTTP statuses:');

for (const code of [401, 403, 409]) {
  const r = classify({ error_code: code }, { attempt: 1 });
  check(`error_code ${code} → non_transient, no retry`,
    r.kind === 'non_transient' && r.shouldRetry === false && r.httpStatus === code,
    JSON.stringify(r));
}

// Other 4xx and 5xx codes — fail-loud.
for (const code of [400, 404, 418, 500, 599]) {
  const r = classify({ error_code: code }, { attempt: 1 });
  check(`error_code ${code} (unclassified) → non_transient, no retry`,
    r.kind === 'non_transient' && r.shouldRetry === false && r.httpStatus === code,
    JSON.stringify(r));
}

// ── Section 4: network-level error codes ──────────────────────────────
console.log('\nNetwork-level error codes (node-fetch):');

for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ECONNREFUSED']) {
  const r = classify({ code, message: 'fetch failed' }, { attempt: 1 });
  check(`code ${code} → transient`,
    r.kind === 'transient' && r.shouldRetry === true && r.networkCode === code,
    JSON.stringify(r));
}

console.log('\nNetwork-level error codes (undici, forward-compat):');
for (const code of ['UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_DESTROYED']) {
  const r = classify({ code, message: 'fetch failed' }, { attempt: 1 });
  check(`code ${code} → transient`,
    r.kind === 'transient' && r.shouldRetry === true && r.networkCode === code,
    JSON.stringify(r));
}

// Unknown network code falls into 'unknown' bucket — still retried bounded.
{
  const r = classify({ code: 'EWEIRDNESS', message: 'who knows' }, { attempt: 1 });
  check('unknown network code → unknown, shouldRetry=true',
    r.kind === 'unknown' && r.shouldRetry === true && r.networkCode === 'EWEIRDNESS',
    JSON.stringify(r));
}

// ── Section 5: malformed / unstructured errors ────────────────────────
console.log('\nMalformed / unstructured errors:');

for (const [label, input] of [
  ['null', null],
  ['undefined', undefined],
  ['string "boom"', 'boom'],
  ['number 42', 42],
]) {
  const r = classify(input, { attempt: 1 });
  check(`${label} → unknown, shouldRetry=true`,
    r.kind === 'unknown' && r.shouldRetry === true,
    JSON.stringify(r));
}

{
  // Plain Error with no code and no error_code.
  const err = new TypeError('something exploded');
  const r = classify(err, { attempt: 1 });
  check('TypeError with no code → unknown, shouldRetry=true',
    r.kind === 'unknown' && r.shouldRetry === true,
    JSON.stringify(r));
}

// ── Section 6: attempt-bounded retry ──────────────────────────────────
console.log('\nAttempt-bounded retry:');

{
  const r = classify({ error_code: 429 }, { attempt: 6 });
  check('429 at attempt 6 (over max) → shouldRetry=false',
    r.shouldRetry === false && r.backoffMs === undefined,
    JSON.stringify(r));
}

{
  const r = classify({ error_code: 502 }, { attempt: 100 });
  check('502 at attempt 100 → shouldRetry=false',
    r.shouldRetry === false && r.backoffMs === undefined,
    JSON.stringify(r));
}

{
  const r = classify({ code: 'ECONNRESET' }, { attempt: 6 });
  check('ECONNRESET at attempt 6 → shouldRetry=false',
    r.shouldRetry === false,
    JSON.stringify(r));
}

// ── Section 7: backoff schedule + jitter ──────────────────────────────
console.log('\nBackoff schedule + jitter:');

// random=0.5 → jitter=0 → exactly base.
for (const [attempt, base] of [[1, 1000], [2, 2000], [3, 4000], [4, 8000], [5, 16000]]) {
  const r = classify({ error_code: 502 }, { attempt, random: fixedRandom(0.5) });
  check(`attempt ${attempt} base backoff (no jitter) = ${base}`,
    r.backoffMs === base,
    `got ${r.backoffMs}`);
}

// random=0 → jitter=-25% of base. attempt-1 → 1000 - 250 = 750.
{
  const r = classify({ error_code: 502 }, { attempt: 1, random: fixedRandom(0) });
  check('attempt 1 with random=0 → 750ms (lower bound)',
    r.backoffMs === 750,
    `got ${r.backoffMs}`);
}

// random=1 → jitter=+25% of base. attempt-1 → 1000 + 250 = 1250.
{
  const r = classify({ error_code: 502 }, { attempt: 1, random: fixedRandom(1) });
  check('attempt 1 with random=1 → 1250ms (upper bound)',
    r.backoffMs === 1250,
    `got ${r.backoffMs}`);
}

// 100 random samples must all be in [750, 1250].
{
  let allInRange = true;
  for (let i = 0; i < 100; i++) {
    const r = classify({ error_code: 502 }, { attempt: 1 });
    if (r.backoffMs < 750 || r.backoffMs > 1250) {
      allInRange = false;
      console.error(`    out-of-range sample: ${r.backoffMs}`);
      break;
    }
  }
  check('100 random samples at attempt-1 all in [750, 1250]', allInRange);
}

// ── Section 8: internal constants ─────────────────────────────────────
console.log('\nInternal constants:');
check('MAX_ATTEMPTS = 5', _internal.MAX_ATTEMPTS === 5);
check('RETRY_AFTER_CAP_MS = 60000', _internal.RETRY_AFTER_CAP_MS === 60000);
check('TRANSIENT_HTTP_STATUSES is a Set', _internal.TRANSIENT_HTTP_STATUSES instanceof Set);
check('Non-transient set includes 401/403/409',
  _internal.NON_TRANSIENT_HTTP_STATUSES.has(401)
  && _internal.NON_TRANSIENT_HTTP_STATUSES.has(403)
  && _internal.NON_TRANSIENT_HTTP_STATUSES.has(409));

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
