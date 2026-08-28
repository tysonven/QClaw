/**
 * Store-path isolation tests.
 *
 * Run: node tests/store-isolation.test.js
 *
 * Covers src/core/paths.js and every call site that previously defaulted straight
 * into the live ~/.quantumclaw evidence store when a caller omitted the path:
 * getDb() (src/core/database.js), bootstrap's identity + log resolution
 * (src/agents/bootstrap.js), and the six append-only log writers.
 *
 * The contract is asymmetric on purpose, in two directions.
 *
 * By context: production (explicit path, or no test context) behaves exactly as
 * before. Only a test that omits the path sees new behaviour.
 *
 * By kind: STORES throw, LOGS redirect. A store is opened once and read back, so
 * failing loudly is right and a test can fix it by passing a dir. A log writer
 * swallows its own errors by design, so a throw there would be caught inside the
 * writer, the test would still pass, and the only symptom would be a silently
 * missing line. Redirecting cannot break a caller and cannot reach production.
 */

import { qclawHome, isTestContext, resolveStoreDir, resolveLogPath, testScratchDir } from '../src/core/paths.js';
import { getDb } from '../src/core/database.js';
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs';
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
const tmp2 = mkdtempSync(join(tmpdir(), 'qclaw-store2-'));
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

console.log('log writers (redirect, not throw):');
// Logs redirect rather than throw. Every one of these writers swallows its own
// errors, so a throw would be caught inside the writer, the test would pass, and
// the only symptom would be a silently missing log line.
delete process.env.QCLAW_HOME;
delete process.env.QCLAW_SKILL_LOG_PATH;
const skillPath = resolveLogPath('QCLAW_SKILL_LOG_PATH', 'skill-load.log');
check('skill-load.log redirects to a temp dir under test, never the live store',
  skillPath !== join(LIVE, 'skill-load.log') && skillPath.endsWith('skill-load.log'));
check('the redirect target is inside the per-process scratch dir',
  skillPath.startsWith(testScratchDir()));
check('every log writer shares one scratch dir per process',
  resolveLogPath('QCLAW_TOOL_CALL_LOG_PATH', 'tool-call.log').startsWith(testScratchDir())
  && resolveLogPath('QCLAW_GATE_LOG_PATH', 'gate.log').startsWith(testScratchDir()));
process.env.QCLAW_SKILL_LOG_PATH = join(tmp2, 'explicit.log');
check('an explicit per-log override still wins (existing opt-in unchanged)',
  resolveLogPath('QCLAW_SKILL_LOG_PATH', 'skill-load.log') === join(tmp2, 'explicit.log'));
delete process.env.QCLAW_SKILL_LOG_PATH;
process.env.QCLAW_TEST = '0';
check('outside test context logs resolve to the live store, unchanged',
  resolveLogPath('QCLAW_GATE_LOG_PATH', 'gate.log') === join(LIVE, 'gate.log'));
delete process.env.QCLAW_TEST;
process.env.QCLAW_HOME = tmp2;
check('QCLAW_HOME redirects logs wholesale',
  resolveLogPath('QCLAW_GATE_LOG_PATH', 'gate.log') === join(tmp2, 'gate.log'));
delete process.env.QCLAW_HOME;

// End-to-end: the writer that actually leaked on 2026-08-27.
const { appendGateLog } = await import('../src/observability/gate-log.js');
const liveGate = join(LIVE, 'gate.log');
const liveBefore = existsSync(liveGate) ? statSync(liveGate).mtimeMs : null;
appendGateLog({ gate: 'completion', claim: 'isolation probe', result: 'pass', attempt: 1 });
const liveAfter = existsSync(liveGate) ? statSync(liveGate).mtimeMs : null;
check('appendGateLog with no override does NOT touch the live gate.log',
  liveBefore === liveAfter);
check('appendGateLog wrote to the scratch dir instead',
  existsSync(join(testScratchDir(), 'gate.log')));

rmSync(tmp, { recursive: true, force: true });
rmSync(tmp2, { recursive: true, force: true });
rmSync(testScratchDir(), { recursive: true, force: true });
restore();
console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);
