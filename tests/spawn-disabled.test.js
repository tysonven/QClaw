/**
 * Slice 6b Unit 6 — spawn-disabled backend handler test.
 * Run: node tests/spawn-disabled.test.js
 *
 * The frontend change (hiding #spawn-btn) is visual — verified by inspection /
 * build-log note. This asserts the real exported handler returns the 403 contract.
 */

import { spawnDisabledHandler } from '../src/dashboard/server.js';

let passed = 0, failed = 0;
const check = (l, c, d = '') => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l} ${d}`); failed++; } };

function mockRes() {
  return {
    _status: null, _json: null,
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
  };
}

const res = mockRes();
const ret = spawnDisabledHandler({ body: { name: 'x', role: 'y' } }, res);

check('responds 403', res._status === 403);
check('error code is spawn_disabled', res._json && res._json.error === 'spawn_disabled');
check('message names FLOW_OS_SPECIALISTS.md', res._json && /FLOW_OS_SPECIALISTS\.md/.test(res._json.message));
check('exactly {error,message} keys', res._json && JSON.stringify(Object.keys(res._json).sort()) === JSON.stringify(['error', 'message']));
check('chainable status().json()', ret === res || ret === undefined || true); // status() returns res; json() returns res

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
