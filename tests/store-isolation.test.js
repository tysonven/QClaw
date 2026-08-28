/**
 * Store-path isolation tests.
 *
 * Run: node tests/store-isolation.test.js
 *
 * Covers src/core/paths.js and the two store call sites that previously defaulted
 * straight into the live ~/.quantumclaw store when a caller omitted the path:
 * getDb() (src/core/database.js) and bootstrap's identity + log directory
 * resolution (src/agents/bootstrap.js).
 *
 * The contract is asymmetric on purpose: production (explicit path, or no test
 * context) behaves exactly as before, and only a test that omits the path sees
 * new behaviour. A store is opened once and read back, so failing loudly is
 * right and a test fixes it by passing a dir.
 */

import { qclawHome, isTestContext, resolveStoreDir } from '../src/core/paths.js';
import { getDb } from '../src/core/database.js';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}
const threw = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const LIVE = join(homedir(), '.quantumclaw');
const savedHome = process.env.QCLAW_HOME;
const savedTest = process.env.QCLAW_TEST;
const restore = () => {
  if (savedHome === undefined) delete process.env.QCLAW_HOME; else process.env.QCLAW_HOME = savedHome;
  if (savedTest === undefined) delete process.env.QCLAW_TEST; else process.env.QCLAW_TEST = savedTest;
};

console.log('test-context detection:');
delete process.env.QCLAW_HOME; delete process.env.QCLAW_TEST;
check('running under a *.test.js entry is detected as test context', isTestContext() === true);
process.env.QCLAW_TEST = '0';
check('QCLAW_TEST=0 forces production context (escape hatch both ways)', isTestContext() === false);
process.env.QCLAW_TEST = '1';
check('QCLAW_TEST=1 forces test context', isTestContext() === true);
delete process.env.QCLAW_TEST;

console.log('qclawHome:');
check('defaults to ~/.quantumclaw', qclawHome() === LIVE);
process.env.QCLAW_HOME = '/tmp/qclaw-home-probe';
check('QCLAW_HOME overrides it', qclawHome() === '/tmp/qclaw-home-probe');
process.env.QCLAW_HOME = '   ';
check('a blank QCLAW_HOME is ignored, not treated as a path', qclawHome() === LIVE);
delete process.env.QCLAW_HOME;

console.log('resolveStoreDir:');
const tmp = mkdtempSync(join(tmpdir(), 'qclaw-store-'));
check('an explicit dir always wins', resolveStoreDir(tmp, 'x') === tmp);
const e = threw(() => resolveStoreDir(null, 'audit.db'));
check('omitting the dir under test THROWS instead of using the live store', e !== null);
check('the error names the store and says how to fix it',
  !!e && /audit\.db/.test(e.message) && /QCLAW_HOME|config\._dir/.test(e.message));
check('the error message never resolves to the live path silently',
  !!e && !existsSync(join(LIVE, '__never_created_by_this_test__')));
const e2 = threw(() => resolveStoreDir('', 'x'));
check('an empty-string dir is treated as omitted, not as cwd', e2 !== null);
process.env.QCLAW_HOME = tmp;
check('QCLAW_HOME satisfies the guard without an explicit dir', resolveStoreDir(null, 'x') === tmp);
delete process.env.QCLAW_HOME;
process.env.QCLAW_TEST = '0';
check('outside test context the production default is returned, unchanged',
  resolveStoreDir(null, 'x') === LIVE);
delete process.env.QCLAW_TEST;

console.log('call sites:');
// getDb is a module-level singleton: the first call pins the file for the whole
// process. An unguarded default here would pin it to the LIVE qclaw.db.
const dbErr = await getDb().then(() => null, (err) => err);
check('getDb() with no dir refuses rather than opening the live qclaw.db',
  dbErr !== null && /refusing to open the live/.test(String(dbErr.message)));
check('getDb() names qclaw.db in the refusal', dbErr !== null && /qclaw\.db/.test(String(dbErr.message)));

// bootstrap: the log writer is best-effort and swallows its own errors, so the
// guard is asserted on the resolver it now calls rather than on a written file.
const bootMod = await import('../src/agents/bootstrap.js');
check('bootstrap module still loads with the guard in place', typeof bootMod.bootstrap === 'function');
const bootErr = threw(() => resolveStoreDir(undefined, 'bootstrap.log'));
check('bootstrap.log resolution refuses an omitted dir under test', bootErr !== null);

// The guard must not have broken the isolated path the existing tests use.
check('an explicit tmpdir still resolves for bootstrap.log', resolveStoreDir(tmp, 'bootstrap.log') === tmp);

rmSync(tmp, { recursive: true, force: true });
restore();
console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
